// counterpart_diagnostics' shared core (src/counterpart/diagnostics.ts): redaction, tails, the byte budget and notes.
// This file is the same in bambu-printer-mcp and mcp-3D-printer-server; each server's own call is tested beside its
// other counterpart tools.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
  DIAGNOSTICS_DEFAULT_BYTES, DIAGNOSTICS_MAX_BYTES, DIAGNOSTICS_OUTPUT_SCHEMA, appVersion, buildDiagnostics, diagnosticsBudget,
  newestLogs, recordToolError, settingsSnapshot, redactText, rememberSecretArguments, resetDiagnosticsMemory, tailText, toolErrorsText,
} from "../dist/counterpart/diagnostics.js";

const bytes = text => Buffer.byteLength(text, "utf8");
const bundleBytes = result => result.files.reduce((sum, file) => sum + bytes(file.name) + bytes(file.content), 0) + result.notes.reduce((sum, note) => sum + bytes(note), 0);
const validate = value => {
  const result = new AjvJsonSchemaValidator().getValidator(DIAGNOSTICS_OUTPUT_SCHEMA)(value);
  assert.ok(result.valid, result.errorMessage);
};
const scratch = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostics-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Each kind of secret, in the forms logs write it, with the value that must never come out. */
const SECRETS = [
  ["access code, labelled", '{"access_code":"39af81c2","serial":"01P00A391200001"}', "39af81c2"],
  ["access code, unlabelled (configured)", "MQTT connect bblp@192.168.1.20 with 7f3e9a21 ok", "7f3e9a21", { secrets: ["7f3e9a21"] }],
  ["access code, dev_access_code", "dev_access_code=55aa66bb printer ready", "55aa66bb"],
  ["access code in an MQTT URL", "connecting mqtts://bblp:91c0ffee@192.168.1.20:8883", "91c0ffee"],
  ["LAN password, key=value", "PRUSALINK password=hunter2lan host=10.0.0.4", "hunter2lan"],
  ["LAN password, JSON", '{"lan_password": "s3cr3t-lan", "port": 990}', "s3cr3t-lan"],
  ["LAN password, escaped JSON", String.raw`payload "{\"password\":\"esc-pass-1\",\"user\":\"bblp\"}"`, "esc-pass-1"],
  ["LAN password, command-line flag", "spawn helper --password flagpass99 --host 10.0.0.4", "flagpass99"],
  ["token, Bearer header", "Authorization: Bearer abcDEF123ghi456", "abcDEF123ghi456"],
  ["token, query string", "GET /v1/user?access_token=qs-token-777&page=2", "qs-token-777"],
  ["token, camelCase key", '{"accessToken": "camelTokenValue"}', "camelTokenValue"],
  ["token, refresh_token", "refresh_token: rt_value_8812", "rt_value_8812"],
  ["token, JWT", "session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJl", "eyJhbGciOiJIUzI1NiJ9"],
  ["cookie header", "Cookie: sid=cookieval1; csrftoken=cookieval2", "cookieval2"],
  ["set-cookie header", "Set-Cookie: session=setcookie123; Path=/; HttpOnly", "setcookie123"],
  ["API key header", "X-Api-Key: 0123456789ABCDEF0123456789ABCDEF", "0123456789ABCDEF0123456789ABCDEF"],
  ["API key, unlabelled OctoPrint form", "using key 0123456789ABCDEF0123456789ABCDEF now", "0123456789ABCDEF0123456789ABCDEF"],
  ["API key, unlabelled random", "key aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF3h end", "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF3h"],
  ["API key, api_key=", "slicer api_key=apikey-4455 ok", "apikey-4455"],
  ["account email", "logged in as tester.name+bambu@example.co.uk", "tester.name+bambu@example.co.uk"],
  ["account email, labelled", '{"email":"someone@example.com"}', "someone@example.com"],
  ["named like a secret", "MY_CUSTOM_SECRET=customsecret42", "customsecret42"],
  ["named like a secret, credential", '"cloud_credential": "credval-31"', "credval-31"],
  ["cloud login ticket", "login ticket=tk-0099aa redirect", "tk-0099aa"],
  ["cloud user info", '{"user_info":"uid-778899"}', "uid-778899"],
  ["PEM private key", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----", "MIIEvQIBADANBg"],
  ["basic auth", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="],
  // Authorization schemes in any case.
  ["bearer, lower case", "authorization: bearer abcDEF123456ghiJKL789", "abcDEF123456ghiJKL789"],
  ["basic, lower case, proxy header", "Proxy-Authorization: basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="],
  ["bearer, upper case", "AUTHORIZATION: BEARER UPPERtoken9876", "UPPERtoken9876"],
  ["digest, lower case", "authorization: digest abcdef0123456789", "abcdef0123456789"],
  // Names with key, passphrase, pin, session, token, secret, password, cookie or credential in them.
  ["name with key, env", "SCAN_TO_MAKE_MODEL_KEY=hf_9f8e7d6c5b4a3928", "hf_9f8e7d6c5b4a3928"],
  ["name with key, JSON", '{"SCAN_TO_MAKE_AI_KEY":"plainhex0123456789abcdef0123"}', "plainhex0123456789abcdef0123"],
  ["name with key, encryption_key", "encryption_key: deadbeefcafe0123456789", "deadbeefcafe0123456789"],
  ["name with key, camelCase", '{"encryptionKey":"camelkey-4410"}', "camelkey-4410"],
  ["name with passphrase", "passphrase=hunter2-horse-battery", "hunter2-horse-battery"],
  ["name with pin", "PAIRING_PIN=482910", "482910"],
  ["name with pin, JSON", '{"pin":"7351"}', "7351"],
  ["name with session, camelCase", '{"sessionId":"7f3a9c1e88b24d6fa015"}', "7f3a9c1e88b24d6fa015"],
  ["name with session, session_key", '{"session_key":"s3ss10nV4lue98765"}', "s3ss10nV4lue98765"],
  ["name with token, URL fragment", "https://ex.com/cb#id_token=tokXYZ987654", "tokXYZ987654"],
  ["name with token, URL query", "GET https://api.example.com/x?access_token=tokABC123456&y=1", "tokABC123456"],
  ["name with secret, client_secret", "client_secret=cs_9876543210abcdef", "cs_9876543210abcdef"],
  ["name with password, quoted with spaces", "password = 'correct horse battery'", "correct horse"],
  ["name with cookie, JSON", '{"cookie":"sid=zzz999yyy888"}', "zzz999yyy888"],
  ["name with credential, plural", "CLOUD_CREDENTIALS=credvalue-5521", "credvalue-5521"],
  ["name with otp", '{"otp":"731204"}', "731204"],
  ["name with lan code", "lan_code=87654321", "87654321"],
  // A safe word counts only as the whole value.
  ["safe-looking prefix, [set]", "token=[set]hunter2value", "hunter2value"],
  ["safe-looking prefix, [redacted]", "secret=[redacted]tail-secret-7", "tail-secret-7"],
  ["safe-looking prefix, true-", "password=true-secret", "true-secret"],
  ["safe-looking prefix, null-", "api_key=null-123456789", "null-123456789"],
  ["safe-looking prefix, false_", "secret=false_value99", "false_value99"],
  ["safe-looking prefix, JSON", '{"password":"true-secret"}', "true-secret"],
  // Bare tokens with a known prefix.
  ["bare GitHub token", "cloned with ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6", "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"],
  ["bare GitHub fine-grained token", "use github_pat_11ABCDEFG0abcdefghij_klmnop now", "github_pat_11ABCDEFG0abcdefghij_klmnop"],
  ["bare AWS access key id", "aws id AKIAIOSFODNN7EXAMPLE ok", "AKIAIOSFODNN7EXAMPLE"],
  ["bare Google API key", "key AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r done", "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r"],
  ["bare sk- key", "k sk-ant-api03-abcdefghijklmnopqrstuvwx", "sk-ant-api03"],
  // PEM blocks of any type.
  ["PEM certificate", "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUZZZ\n-----END CERTIFICATE-----", "MIIBszCCAVmgAwIBAgIUZZZ"],
  ["PEM EC private key", "-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIAbc123\n-----END EC PRIVATE KEY-----", "MHQCAQEEIAbc123"],
  ["PEM OpenSSH private key", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXk="],
  ["PEM block cut before its end", "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAcut", "MIIEowIBAAKCAQEAcut"],
  // Unicode-escaped JSON keys.
  ["unicode-escaped key", String.raw`{"\u0070assword":"unicodesecret1"}`, "unicodesecret1"],
  ["unicode-escaped key, escaped JSON", String.raw`"{\"\\u0074oken\":\"esc-unicode-22\"}"`, "esc-unicode-22"],
  // Home folders: other people's names.
  ["a /Users/<name> path", "/Users/someoneelse/Library/x", "someoneelse"],
  ["a /home/<name> path", "read /home/otheruser/.config/y", "otheruser"],
  ["a C:\\Users\\<name> path", "C:\\Users\\DavidM\\z", "DavidM"],
  ["an escaped-slash home path", String.raw`{\"path\":\"\/Users\/davidm\/Library\"}`, "davidm"],
  ["a ~name path", "log at ~davidm/Library/Logs", "davidm"],
];

for (const [kind, line, secret, options] of SECRETS) {
  test(`redaction removes ${kind}`, () => {
    const out = redactText(line, options?.secrets);
    assert.ok(!out.includes(secret), `${kind}: ${out}`);
  });
}

test("this server's own home folder reads ~, also with escaped slashes; other people's names read [user]", t => {
  const previous = process.env.HOME;
  process.env.HOME = "/home/tester-home";
  t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
  assert.equal(redactText("open /home/tester-home/models/a.stl"), "open ~/models/a.stl");
  assert.equal(redactText(String.raw`{"p":"\/home\/tester-home\/x"}`), String.raw`{"p":"~\/x"}`);
  assert.equal(redactText("/home/tester-homes/x"), "/home/[user]/x", "a longer name is someone else's");
  assert.equal(redactText("/Users/Shared/x C:\\Users\\Public\\y"), "/Users/Shared/x C:\\Users\\Public\\y");
});

test("the lead's regressions: a scheme is never taken as the value, access-code is a secret name, a URL's https: swallows nothing", () => {
  // The key=value rule must not take "Bearer" as authorization's value and leave the token after it.
  for (const scheme of ["Bearer", "bearer", "BEARER", "Basic"]) {
    assert.equal(redactText(`Authorization: ${scheme} sch3meSecretValue99`), `Authorization: ${scheme} [redacted]`);
  }
  assert.equal(redactText('{"Authorization":"Bearer sch3meSecretValue99"}'), '{"Authorization":"[redacted]"}', "a quoted JSON value goes whole");
  // "access" ends in s: it is never read as a plural and cut to "acces".
  assert.equal(redactText("access-code: 31415926"), "access-code: [redacted]");
  assert.equal(redactText("ACCESS_CODE=31415926 accessCode=31415926"), "ACCESS_CODE=[redacted] accessCode=[redacted]");
  // "https:" is not a secret name, so it must not take the rest of the URL as its value and hide the token from the rule.
  assert.equal(redactText("GET https://api.example.com/x?access_token=tokABC123456&y=1"), "GET https://api.example.com/x?access_token=[redacted]&y=1");
  assert.equal(redactText("open https://ex.com/cb?code=1#id_token=tokXYZ987654"), "open https://ex.com/cb?code=1#id_token=[redacted]");
});

test("the app's re-review: structured values under a secret's name, name/value pairs, whole Authorization lines, Negotiate (N1, N3, N6)", () => {
  // N1: an object or array under a secret's name goes whole, and the JSON still parses.
  assert.equal(redactText('{"password":{"value":"pwvalue1"},"port":990}'), '{"password":"[redacted]","port":990}');
  assert.equal(redactText('{"tokens":["tokval22","tokval23"]}'), '{"tokens":"[redacted]"}');
  assert.equal(redactText('{"apiKeys":[{"value":"akval333","note":"a [b] {c}"}]}'), '{"apiKeys":"[redacted]"}');
  assert.equal(redactText('{"password": {"value": "cut-before-its-end'), '{"password": "[redacted]"', "a structure cut short goes to its line's end");
  assert.equal(redactText('{"layers":[1,2],"filaments":{"slot":1}}'), '{"layers":[1,2],"filaments":{"slot":1}}', "other structures stay");
  // N1: a secret named in a name/key field and given in a value field, either order.
  assert.equal(redactText('{"name":"BAMBU_ACCESS_CODE","value":"acval444"}'), '{"name":"BAMBU_ACCESS_CODE","value":"[redacted]"}');
  assert.equal(redactText('{"value":"acval446", "name":"apiKey"}'), '{"value":"[redacted]", "name":"apiKey"}');
  assert.ok(!redactText('{"key":"BAMBU_TOKEN","value":"acval445"}').includes("acval445"));
  assert.equal(redactText('{"name":"BAMBU_MODEL","value":"p1s"}'), '{"name":"BAMBU_MODEL","value":"p1s"}', "a setting that is not a secret stays");
  assert.equal(redactText('{"name":"BAMBU_TOKEN","value":"[set]"}'), '{"name":"BAMBU_TOKEN","value":"[set]"}');
  // N3: the whole Authorization header line goes, a Digest username with it.
  assert.equal(redactText('Authorization: Digest username="alice", realm="r", response="abc123def"'), "Authorization: Digest [redacted]");
  assert.equal(redactText('proxy-authorization: digest username="bob", nonce="n1"\nnext line'), "proxy-authorization: digest [redacted]\nnext line");
  assert.equal(redactText("Authorization: someCustomScheme opaque-value-77"), "Authorization: [redacted]");
  // N6: Negotiate (and NTLM) are schemes.
  for (const scheme of ["Negotiate", "negotiate", "NTLM"]) {
    assert.equal(redactText(`Authorization: ${scheme} YIIBhwYGKwYBBQUC`), `Authorization: ${scheme} [redacted]`);
    assert.equal(redactText(`sent ${scheme} YIIBhwYGKwYBBQUC to the proxy`), `sent ${scheme} [redacted] to the proxy`);
  }
});

test("release review D-1: a name/value pair leaks nothing with other fields between, in either order", () => {
  assert.equal(redactText('{"name":"BAMBU_ACCESS_CODE","note":"x","value":"secretD1a"}'), '{"name":"BAMBU_ACCESS_CODE","note":"x","value":"[redacted]"}');
  assert.equal(redactText('{"name":"BAMBU_ACCESS_CODE","scope":"lan","value":"secretD1a"}'), '{"name":"BAMBU_ACCESS_CODE","scope":"lan","value":"[redacted]"}');
  assert.equal(redactText('{"value":"secretD1b","scope":"lan","note":"n","name":"cloud_token"}'), '{"value":"[redacted]","scope":"lan","note":"n","name":"cloud_token"}');
  const pretty = '{"settings": [\n  {\n    "name": "BAMBU_ACCESS_CODE",\n    "scope": "lan",\n    "value": "secretD1c"\n  }\n]}';
  assert.ok(!redactText(pretty).includes("secretD1c"), "pretty-printed, inside an array");
  assert.doesNotThrow(() => JSON.parse(redactText(pretty)));
  assert.equal(redactText('{"name":"BAMBU_MODEL","note":"x","value":"p1s"}'), '{"name":"BAMBU_MODEL","note":"x","value":"p1s"}', "a setting that is not a secret stays");
  assert.equal(redactText('{"name":"BAMBU_TOKEN","note":"x","value":"[set]"}'), '{"name":"BAMBU_TOKEN","note":"x","value":"[set]"}');
});

test("release review D-2 to D-5: bare hf_ keys, bare Digest credentials, %40 emails, spaced code labels", () => {
  // D-2
  assert.equal(redactText("pulled with hf_abcdefghijklmnopqrstuvwxyz0123456789 ok"), "pulled with [redacted-token] ok");
  // D-3
  assert.equal(redactText('sent Digest username="alice", realm="r", nonce="n1", response="6629fae49393a05397450978507c4ef1"\nnext'), "sent Digest [redacted]\nnext");
  // D-4
  assert.equal(redactText("account is name%40example.com ok"), "account is [redacted-email] ok");
  assert.equal(redactText("login=first.last%40mail.example.co.uk&x=1").includes("first.last"), false);
  // D-5
  assert.equal(redactText("access code: 12345678"), "access code: [redacted]");
  assert.equal(redactText('Pairing Code = "98765432"'), 'Pairing Code = "[redacted]"');
  assert.equal(redactText("LAN code: 31415926, verification code 1234"), "LAN code: [redacted], verification code 1234");
  assert.equal(redactText("access code: [set]"), "access code: [set]");
});

test("release review D-6: a random bare code, a bare AWS secret, XML and plist secrets, a quoted secret longer than 4096 characters", () => {
  assert.equal(redactText('{"code": "Ab3dEf6hJk9mNpQrStUvWxYz0123"}'), '{"code": "[redacted]"}');
  assert.equal(redactText("aws secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY end"), "aws secret [redacted-token] end");
  assert.equal(redactText("<dict><key>apiToken</key>\n<string>plistsecret1</string></dict>"), "<dict><key>apiToken</key>\n<string>[redacted]</string></dict>");
  assert.equal(redactText('<config><password type="x">xmlsecret22</password></config>'), '<config><password type="x">[redacted]</password></config>');
  const long = "w ".repeat(2500) + "tailsecret99";
  assert.equal(redactText(`{"password":"${long}","port":990}`), '{"password":"[redacted]","port":990}');
  // Unchanged: plist keys and versions, element text that is not a secret, paths with slashes.
  for (const line of ["<key>CFBundleVersion</key><string>2.0.1</string>", "<name>P1S</name><key>token</key>", "/Users/Shared/Library/Application/Support/BambuStudio2",
    "Library/Application/Support/BambuStudio/x"]) {
    assert.equal(redactText(line), line);
  }
});

test("printer error codes survive (N4)", () => {
  for (const line of ["HMS code 05004043 at ams", "code 1234 printer", "HMS_0500_4043 code: 0500-4043", '{"print_error":50348044,"code":1234}', "err_code=0300-0100-0001"]) {
    assert.equal(redactText(line), line);
  }
});

test("redaction keeps names that only look like secret words, and Bambu's error codes", () => {
  for (const line of ["exit code: 0 err_code=1200 code=0", '{"step":"send","command":"pause","code":0}', "spinner=3 keyboard=us monkey=1",
    "token=[set] password=\"\" BAMBU_TOKEN=[set]", "authenticate: failed", "https://example.com/path?page=2"]) {
    assert.equal(redactText(line), line);
  }
  assert.equal(redactText("authorization: bearer abcDEF123456"), "authorization: bearer [redacted]", "the scheme stays");
  assert.equal(redactText('{"accessCodeSet":true,"pin":null,"token":false}'), '{"accessCodeSet":true,"pin":null,"token":false}', "whether a secret is set stays");
  assert.deepEqual(JSON.parse(redactText('{"pin": 7351, "otp":731204}')), { pin: "[redacted]", otp: "[redacted]" }, "a bare JSON number becomes a string");
});

test("redaction keeps empty and already-replaced values, so a setting still shows whether it is set", () => {
  const line = '{"API_KEY": "", "BAMBU_TOKEN": "[set]", "password": "[redacted]"} token=';
  assert.equal(redactText(line), line);
});

test("redaction keeps serial numbers, hosts, hashes and ordinary words", () => {
  const line = 'serial 01P00A391200001 host 192.168.1.20 sha256 3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b "passed": true state=RUNNING author=David';
  assert.equal(redactText(line), line);
});

test("redaction removes environment secrets and values seen in tool arguments, wherever they appear", t => {
  const previous = process.env.SOME_PRINTER_TOKEN;
  process.env.SOME_PRINTER_TOKEN = "envtoken-6655";
  t.after(() => { if (previous === undefined) delete process.env.SOME_PRINTER_TOKEN; else process.env.SOME_PRINTER_TOKEN = previous; resetDiagnosticsMemory(); });
  rememberSecretArguments({ host: "10.0.0.9", bambu_token: "argcode-1234", nested: { api_key: "nested-key-99" }, model: "p1s" });
  const out = redactText("got envtoken-6655 then argcode-1234 and nested-key-99 from 10.0.0.9 p1s");
  for (const secret of ["envtoken-6655", "argcode-1234", "nested-key-99"]) assert.ok(!out.includes(secret), out);
  assert.match(out, /10\.0\.0\.9 p1s/);
});

test("every kind of secret written to a log file never comes out of the bundle", t => {
  const dir = scratch(t);
  const file = path.join(dir, "control-trace.log");
  fs.writeFileSync(file, SECRETS.map(([, line]) => line).join("\n") + "\n");
  const result = buildDiagnostics({ package: "pkg", version: "1.0.0", sources: [{ name: "fulu/control-trace.log", file }], secrets: ["7f3e9a21"] });
  validate(result);
  const text = JSON.stringify(result);
  for (const [kind, , secret] of SECRETS) assert.ok(!text.includes(secret), kind);
  assert.match(result.files[0].content, /01P00A391200001/, "the serial stays");
});

test("a secret cut by the tail's start is dropped with its partial line", t => {
  const dir = scratch(t);
  const file = path.join(dir, "big.log");
  // The tail starts inside "access_code=…": without its key the value would look harmless.
  fs.writeFileSync(file, "x".repeat(1000) + " access_code=tailsecret9\nlast line\n");
  const result = buildDiagnostics({ package: "pkg", version: "1", sources: [{ name: "big.log", file }], maxBytes: 30 });
  assert.ok(!JSON.stringify(result).includes("tailsecret9"));
  assert.equal(result.files[0].content, "last line\n");
  assert.equal(result.files[0].truncated, true);
});

test("the bundle keeps each file's newest lines and never exceeds max_bytes", t => {
  const dir = scratch(t);
  const big = path.join(dir, "big.log"), other = path.join(dir, "other.log");
  fs.writeFileSync(big, Array.from({ length: 5000 }, (_, i) => `line ${i} ünïcødé`).join("\n") + "\n");
  fs.writeFileSync(other, Array.from({ length: 3000 }, (_, i) => `other ${i}`).join("\n") + "\n");
  for (const maxBytes of [1, 64, 1000, 20_000, 70_000]) {
    const result = buildDiagnostics({
      package: "pkg", version: "1", maxBytes, notes: ["a note"],
      sources: [{ name: "small.json", text: "{}\n" }, { name: "logs/big.log", file: big }, { name: "logs/other.log", file: other }],
    });
    validate(result);
    assert.ok(bundleBytes(result) <= maxBytes, `${bundleBytes(result)} > ${maxBytes}`);
    for (const file of result.files.filter(file => file.name.startsWith("logs/"))) {
      // Always the source's newest bytes; from a whole line once one fits.
      assert.ok(fs.readFileSync(file.name === "logs/big.log" ? big : other, "utf8").endsWith(file.content), file.name);
      if (maxBytes >= 1000 && file.name === "logs/big.log") assert.match(file.content, /^line \d+ ünïcødé\n[\s\S]*line 4999 ünïcødé\n$/);
    }
  }
  const whole = buildDiagnostics({ package: "pkg", version: "1", sources: [{ name: "logs/other.log", file: other }] });
  assert.equal(whole.files[0].truncated, false);
  assert.equal(whole.files[0].content, fs.readFileSync(other, "utf8"));
  // A small budget is shared: the small file stays whole, the larger ones split the rest.
  const shared = buildDiagnostics({ package: "pkg", version: "1", maxBytes: 20_000,
    sources: [{ name: "small.json", text: "{}\n" }, { name: "logs/big.log", file: big }, { name: "logs/other.log", file: other }] });
  assert.equal(shared.files.find(f => f.name === "small.json").truncated, false);
  assert.ok(shared.files.filter(f => f.name.startsWith("logs/")).every(f => f.truncated && bytes(f.content) > 8_000));
});

test("missing files are notes, never failures", t => {
  const dir = scratch(t);
  const result = buildDiagnostics({ package: "pkg", version: "1", sources: [
    { name: "a.log", file: path.join(dir, "absent.log") },
    { name: "b.log", file: path.join(dir, "also-absent.log"), missing: "b.log: nothing yet." },
    { name: "c.log", file: dir },
  ] });
  validate(result);
  assert.deepEqual(result.files, []);
  assert.equal(result.notes.length, 3);
  assert.match(result.notes[0], /a\.log.*no such file/);
  assert.equal(result.notes[1], "b.log: nothing yet.");
});

test("file names are plain relative paths", () => {
  for (const name of ["../escape.log", "/etc/passwd", "a/../../b", "C:\\x.log", "", "a//b"]) {
    assert.throws(() => buildDiagnostics({ package: "p", version: "1", sources: [{ name, text: "x" }] }), /not a plain relative path/, name);
  }
  assert.doesNotThrow(() => buildDiagnostics({ package: "p", version: "1", sources: [{ name: "fulu/control-trace.log", text: "x" }] }));
});

test("max_bytes defaults to 4 MiB and is at most 8 MiB", () => {
  assert.equal(diagnosticsBudget(undefined), DIAGNOSTICS_DEFAULT_BYTES);
  assert.equal(DIAGNOSTICS_DEFAULT_BYTES, 4_194_304);
  assert.equal(diagnosticsBudget(DIAGNOSTICS_MAX_BYTES), 8_388_608);
  for (const bad of [0, -1, 1.5, DIAGNOSTICS_MAX_BYTES + 1, "100", null]) assert.throws(() => diagnosticsBudget(bad), /max_bytes/, String(bad));
});

test("tool errors are recorded by tool and message, and redacted on the way out", t => {
  t.after(resetDiagnosticsMemory);
  recordToolError("print_3mf", new Error("MQTT refused password=toolerrpass1"));
  assert.match(toolErrorsText(), /print_3mf: Error: MQTT refused/);
  const result = buildDiagnostics({ package: "p", version: "1", sources: [{ name: "tool-errors.log", text: toolErrorsText() }] });
  assert.ok(!JSON.stringify(result).includes("toolerrpass1"));
});

test("tailText cuts at a whole line and within its bytes", () => {
  assert.deepEqual(tailText("a\nb\nc\n", 100), { text: "a\nb\nc\n", cut: false });
  assert.deepEqual(tailText("aaa\nbbb\nccc\n", 6), { text: "ccc\n", cut: true });
  const cut = tailText("ééé\néé\n", 5);
  assert.ok(bytes(cut.text) <= 5 && cut.cut);
});

test("newestLogs lists the newest log files and skips absent folders", t => {
  const dir = scratch(t);
  for (const [name, age] of [["old.log", 3], ["new.log", 1], ["mid.log", 2], ["notes.txt", 0], ["skip.log", 0]]) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, name);
    const when = new Date(Date.now() - age * 60_000);
    fs.utimesSync(file, when, when);
  }
  assert.deepEqual(newestLogs([dir, path.join(dir, "absent")], 2, ["skip.log"]).map(file => path.basename(file)), ["new.log", "mid.log"]);
});

test("appVersion reads a macOS bundle's Info.plist or a versioned file name, and never runs the app", t => {
  const dir = scratch(t);
  const app = path.join(dir, "BambuStudio.app");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), "<plist><dict><key>CFBundleShortVersionString</key>\n<string>02.03.01.51</string></dict></plist>");
  assert.equal(appVersion(path.join(app, "Contents", "MacOS", "BambuStudio")), "02.03.01.51");
  assert.equal(appVersion("/opt/OrcaSlicer_Linux_V2.3.1.AppImage"), "2.3.1");
  assert.equal(appVersion("/usr/bin/prusa-slicer"), undefined);
  assert.equal(appVersion(undefined), undefined);
});

test("settings show secret-named variables only as set", () => {
  const env = { BAMBU_TOKEN: "39af81c2", BAMBU_MODEL: "p1s", BAMBU_NETWORK_USER_INFO: '{"token":"x"}', API_KEY: "", OTHER: "kept-out", SLICER_PATH: "/opt/slicer" };
  assert.deepEqual(settingsSnapshot(/^(?:BAMBU|SLICER|API_KEY)/, env), { API_KEY: "", BAMBU_MODEL: "p1s", BAMBU_NETWORK_USER_INFO: "[set]", BAMBU_TOKEN: "[set]", SLICER_PATH: "/opt/slicer" });
});

test("redaction stays fast on long runs a log can hold (base64 blobs, unclosed quotes, many keys)", () => {
  const n = 4_194_304;
  for (const [name, text] of [["one run", "x".repeat(n)], ["base64", Buffer.alloc(n * 3 / 4, 0x9b).toString("base64")], ["dashes and dots", "a-b.c_".repeat(n / 6)],
    ["unclosed quotes", 'password: "abc '.repeat(n / 15)], ["at signs", "a@".repeat(n / 2)], ["many keys", "token=x ".repeat(n / 8)]]) {
    const started = Date.now();
    redactText(text);
    assert.ok(Date.now() - started < 10_000, `${name} took ${Date.now() - started} ms`);
  }
  assert.ok(!redactText('password: "unclosed-secret').includes("unclosed-secret"));
});
