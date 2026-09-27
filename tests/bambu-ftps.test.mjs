import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { test } from "node:test";
import { Client as FTPClient } from "basic-ftp";
import { BambuImplementation } from "../dist/printers/bambu.js";

// Self-signed fixtures are only for this loopback server, never printer credentials.
const credentials = {
  key: await fs.readFile(new URL("./fixtures/ftps/key.pem", import.meta.url)),
  cert: await fs.readFile(new URL("./fixtures/ftps/cert.pem", import.meta.url)),
  ticketKeys: randomBytes(48),
  sessionIdContext: "bambu-ftps-regression",
};

async function ftpsServer(t, rejectUpload) {
  const connections = new Set();
  const servers = [];
  const received = { commands: [], chunks: [], controlProtocol: null, dataProtocol: null, resumed: false };
  function track(server) {
    servers.push(server);
    server.on("connection", (socket) => {
      connections.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => connections.delete(socket));
    });
    server.on("tlsClientError", () => {});
    return server;
  }
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  });
  const controlServer = track(tls.createServer(credentials, (control) => {
    received.controlProtocol = control.getProtocol();
    control.write("220 Loopback FTPS ready\r\n");
    let buffer = "";
    let dataSocket;
    let queue = Promise.resolve();
    control.on("data", (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes("\r\n")) {
        const boundary = buffer.indexOf("\r\n");
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        queue = queue.then(async () => {
          const [command, ...parts] = line.split(" ");
          const arg = parts.join(" ");
          if (!["USER", "PASS"].includes(command)) received.commands.push(line);
          if (command === "USER") control.write("331 Password required\r\n");
          else if (command === "PASS") control.write("230 Logged in\r\n");
          else if (command === "FEAT") control.write("211 End\r\n");
          else if (command === "PWD") control.write('257 "/"\r\n');
          else if (command === "CWD") control.write("250 Directory changed\r\n");
          else if (command === "MKD") control.write(`257 "${arg}" created\r\n`);
          else if (command === "EPSV") {
            const dataServer = track(tls.createServer(credentials, (socket) => {
              dataSocket = socket;
              received.dataProtocol = socket.getProtocol();
              received.resumed = socket.isSessionReused();
              socket.on("data", (data) => received.chunks.push(data));
              socket.on("end", () => {
                socket.end();
                if (!rejectUpload) control.write("226 Transfer complete\r\n");
              });
              socket.on("error", () => {});
            }));
            dataServer.listen(0, "127.0.0.1");
            await once(dataServer, "listening");
            control.write(`229 Entering Extended Passive Mode (|||${dataServer.address().port}|)\r\n`);
          } else if (command === "STOR") {
            if (rejectUpload) {
              control.write("552 Simulated full storage\r\n");
              dataSocket?.destroy();
            } else control.write("150 Opening data connection\r\n");
          } else if (command === "QUIT") control.end("221 Goodbye\r\n");
          else control.write("200 OK\r\n");
        }).catch((error) => control.destroy(error));
      }
    });
    control.on("error", () => {});
  }));
  controlServer.listen(0, "127.0.0.1");
  await once(controlServer, "listening");
  return { received, port: controlServer.address().port };
}

test("Bambu FTPS uses a resumed TLS 1.2 data session and preserves upload paths", async (t) => {
  for (const rejectUpload of [false, true]) {
    await t.test(rejectUpload ? "failed transfer closes the client" : "successful transfer", async (t) => {
      const peer = await ftpsServer(t, rejectUpload);
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-ftps-"));
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      const local = path.join(directory, "local.gcode");
      const payload = Buffer.from("G28\n; exact upload bytes\n");
      await fs.writeFile(local, payload);
      let client;
      const access = FTPClient.prototype.access;
      t.mock.method(FTPClient.prototype, "access", function (options) {
        client = this;
        assert.equal(options.host, "127.0.0.1");
        assert.equal(options.port, 990);
        return access.call(this, { ...options, port: peer.port });
      });
      const operation = new BambuImplementation({}).ftpUpload("127.0.0.1", "test-only", local, "/cache/a file.gcode");
      if (rejectUpload) await assert.rejects(operation, /552|storage/i);
      else {
        await operation;
        assert.equal(peer.received.controlProtocol, "TLSv1.2");
        assert.equal(peer.received.dataProtocol, "TLSv1.2");
        assert.equal(peer.received.resumed, true, "data socket must resume the control TLS session");
        assert.deepEqual(Buffer.concat(peer.received.chunks), payload);
        assert.ok(peer.received.commands.includes("CWD cache"));
        assert.ok(peer.received.commands.includes("STOR a file.gcode"));
        assert.equal(peer.received.commands.some((command) => command.includes("cache/cache")), false);
      }
      assert.equal(client.closed, true);
      assert.deepEqual(await fs.readFile(local), payload);
    });
  }
});
