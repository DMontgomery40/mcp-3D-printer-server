import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "basic-ftp";
import { uploadFile } from "../dist/printers/ftp-upload.js";

const RATE = 4 * 1024 * 1024; // bytes/s the fake printer drains, like an SD card behind Wi-Fi
const SIZE = 12 * 1024 * 1024; // larger than loopback socket buffers, so writes must wait for the drain
const TIMEOUT_MS = 1500; // basic-ftp stall timeout; the whole upload takes ~3 s

/** A passive-mode FTP server whose data connection drains at RATE, or stops after its first read. */
async function slowPrinter(t, { stall = false, pauseAt = Infinity, pauseMs = 0 } = {}) {
  const received = [];
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); };
  const data = net.createServer(socket => {
    track(socket);
    const parts = [];
    let taken = 0, paused = false;
    socket.on("data", chunk => {
      parts.push(chunk);
      taken += chunk.length;
      socket.pause();
      // Like a P1S's SD card: one long pause partway through a large file.
      const pause = !paused && taken >= pauseAt ? (paused = true, pauseMs) : 0;
      if (!stall) setTimeout(() => socket.resume(), Math.ceil(chunk.length / RATE * 1000) + pause);
    });
    socket.on("end", () => { received.push(Buffer.concat(parts)); data.emit("stored"); });
  });
  const control = net.createServer(socket => {
    track(socket);
    socket.write("220 fake printer\r\n");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const verb = line.split(" ")[0].toUpperCase();
        if (verb === "USER") socket.write("331 \r\n");
        else if (verb === "PASS") socket.write("230 \r\n");
        else if (verb === "PASV") {
          const port = data.address().port;
          socket.write(`227 (127,0,0,1,${port >> 8},${port & 255})\r\n`);
        } else if (verb === "STOR") {
          socket.write("150 \r\n");
          data.once("stored", () => socket.write("226 \r\n"));
        } else if (verb === "EPSV" || verb === "FEAT") socket.write("502 \r\n");
        else socket.write("200 \r\n");
      }
    });
  });
  await Promise.all([control, data].map(server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve))));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([control, data].map(server => new Promise(resolve => server.close(resolve))));
  });
  const client = new Client(TIMEOUT_MS);
  t.after(() => client.close());
  await client.access({ host: "127.0.0.1", port: control.address().port, user: "bblp", password: "DUMMY", secure: false });
  return { client, received };
}

async function jobFile(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ftp-upload-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from(Array.from({ length: SIZE }, (_, i) => (i * 31 + 7) & 255));
  const file = path.join(dir, "job.3mf");
  await fs.writeFile(file, bytes);
  return { file, bytes };
}

test("uploadFile waits out a printer pausing mid-file longer than the command timeout, then restores it", async t => {
  // 2026-11-06: an 18.4 MB plate stopped at 13.3 MB for over the 15 s command timeout.
  const { client, received } = await slowPrinter(t, { pauseAt: SIZE * 0.7, pauseMs: TIMEOUT_MS * 2 });
  const { file, bytes } = await jobFile(t);
  await uploadFile(client, file, "/cache/job.3mf", { stallMs: TIMEOUT_MS * 4 });
  assert.ok(received[0].equals(bytes), "the printer receives the exact bytes");
  assert.equal(client.ftp.timeout, TIMEOUT_MS, "other commands keep the command timeout");
});

test("with only the command timeout, the same mid-file pause is reported as a stall", async t => {
  const { client } = await slowPrinter(t, { pauseAt: SIZE * 0.7, pauseMs: TIMEOUT_MS * 2 });
  const { file } = await jobFile(t);
  await assert.rejects(uploadFile(client, file, "/cache/job.3mf", { stallMs: 0 }), /Timeout \(data socket\)/);
  assert.equal(client.ftp.timeout, TIMEOUT_MS);
});

test("uploadFile still times out when the printer stops taking data", async t => {
  const { client } = await slowPrinter(t, { stall: true });
  const { file } = await jobFile(t);
  await assert.rejects(uploadFile(client, file, "/cache/job.3mf", { stallMs: TIMEOUT_MS * 2 }), /Timeout \(data socket\)/);
});

test("uploadFile reports the bytes the data connection has sent, ending at the file's size", async t => {
  const { client } = await slowPrinter(t);
  const { file, bytes } = await jobFile(t);
  const seen = [];
  await uploadFile(client, file, "/cache/job.3mf", { onProgress: (sent, total) => seen.push([sent, total]) });
  assert.deepEqual(seen[0], [0, bytes.length]);
  assert.deepEqual(seen.at(-1), [bytes.length, bytes.length]);
  assert.ok(seen.length >= 4, "progress arrives during the transfer (basic-ftp reports every 500 ms), not only at its ends");
  assert.ok(seen.every(([sent], i) => i === 0 || sent >= seen[i - 1][0]), "never goes backwards");
});
