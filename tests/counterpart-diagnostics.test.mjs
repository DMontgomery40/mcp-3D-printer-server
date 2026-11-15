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
import * as diagnostics from "../dist/counterpart/diagnostics.js";
// The pattern rules alone, where a test reads what each named form becomes (redactText also withholds whole lines).
const redactPatterns = diagnostics.redactPatterns ?? redactText;
const WITHHELD = diagnostics.WITHHELD ?? "[line withheld: may contain a secret]";
const { captureServerLog, serverLogText } = diagnostics;

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
    const out = redactPatterns(line, options?.secrets);
    assert.ok(!out.includes(secret), `${kind}: ${out}`);
  });
}

test("this server's own home folder reads ~, also with escaped slashes; other people's names read [user]", t => {
  const previous = process.env.HOME;
  process.env.HOME = "/home/tester-home";
  t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
  assert.equal(redactPatterns("open /home/tester-home/models/a.stl"), "open ~/models/a.stl");
  assert.equal(redactPatterns(String.raw`{"p":"\/home\/tester-home\/x"}`), String.raw`{"p":"~\/x"}`);
  assert.equal(redactPatterns("/home/tester-homes/x"), "/home/[user]/x", "a longer name is someone else's");
  assert.equal(redactPatterns("/Users/Shared/x C:\\Users\\Public\\y"), "/Users/Shared/x C:\\Users\\Public\\y");
});

test("the lead's regressions: a scheme is never taken as the value, access-code is a secret name, a URL's https: swallows nothing", () => {
  // The key=value rule must not take "Bearer" as authorization's value and leave the token after it.
  for (const scheme of ["Bearer", "bearer", "BEARER", "Basic"]) {
    assert.equal(redactPatterns(`Authorization: ${scheme} sch3meSecretValue99`), `Authorization: ${scheme} [redacted]`);
  }
  assert.equal(redactPatterns('{"Authorization":"Bearer sch3meSecretValue99"}'), '{"Authorization":"[redacted]"}', "a quoted JSON value goes whole");
  // "access" ends in s: it is never read as a plural and cut to "acces".
  assert.equal(redactPatterns("access-code: 31415926"), "access-code: [redacted]");
  assert.equal(redactPatterns("ACCESS_CODE=31415926 accessCode=31415926"), "ACCESS_CODE=[redacted] accessCode=[redacted]");
  // "https:" is not a secret name, so it must not take the rest of the URL as its value and hide the token from the rule.
  assert.equal(redactPatterns("GET https://api.example.com/x?access_token=tokABC123456&y=1"), "GET https://api.example.com/x?access_token=[redacted]&y=1");
  assert.equal(redactPatterns("open https://ex.com/cb?code=1#id_token=tokXYZ987654"), "open https://ex.com/cb?code=1#id_token=[redacted]");
});

test("the app's re-review: structured values under a secret's name, name/value pairs, whole Authorization lines, Negotiate (N1, N3, N6)", () => {
  // N1: an object or array under a secret's name goes whole, and the JSON still parses.
  assert.equal(redactPatterns('{"password":{"value":"pwvalue1"},"port":990}'), '{"password":"[redacted]","port":990}');
  assert.equal(redactPatterns('{"tokens":["tokval22","tokval23"]}'), '{"tokens":"[redacted]"}');
  assert.equal(redactPatterns('{"apiKeys":[{"value":"akval333","note":"a [b] {c}"}]}'), '{"apiKeys":"[redacted]"}');
  assert.equal(redactPatterns('{"password": {"value": "cut-before-its-end'), '{"password": "[redacted]"', "a structure cut short goes to its line's end");
  assert.equal(redactPatterns('{"layers":[1,2],"filaments":{"slot":1}}'), '{"layers":[1,2],"filaments":{"slot":1}}', "other structures stay");
  // N1: a secret named in a name/key field and given in a value field, either order.
  assert.equal(redactPatterns('{"name":"BAMBU_ACCESS_CODE","value":"acval444"}'), '{"name":"BAMBU_ACCESS_CODE","value":"[redacted]"}');
  assert.equal(redactPatterns('{"value":"acval446", "name":"apiKey"}'), '{"value":"[redacted]", "name":"apiKey"}');
  assert.ok(!redactPatterns('{"key":"BAMBU_TOKEN","value":"acval445"}').includes("acval445"));
  assert.equal(redactPatterns('{"name":"BAMBU_MODEL","value":"p1s"}'), '{"name":"BAMBU_MODEL","value":"p1s"}', "a setting that is not a secret stays");
  assert.equal(redactPatterns('{"name":"BAMBU_TOKEN","value":"[set]"}'), '{"name":"BAMBU_TOKEN","value":"[set]"}');
  // N3: the whole Authorization header line goes, a Digest username with it.
  assert.equal(redactPatterns('Authorization: Digest username="alice", realm="r", response="abc123def"'), "Authorization: Digest [redacted]");
  assert.equal(redactPatterns('proxy-authorization: digest username="bob", nonce="n1"\nnext line'), "proxy-authorization: digest [redacted]\nnext line");
  assert.equal(redactPatterns("Authorization: someCustomScheme opaque-value-77"), "Authorization: [redacted]");
  // N6: Negotiate (and NTLM) are schemes.
  for (const scheme of ["Negotiate", "negotiate", "NTLM"]) {
    assert.equal(redactPatterns(`Authorization: ${scheme} YIIBhwYGKwYBBQUC`), `Authorization: ${scheme} [redacted]`);
    assert.equal(redactPatterns(`sent ${scheme} YIIBhwYGKwYBBQUC to the proxy`), `sent ${scheme} [redacted] to the proxy`);
  }
});

test("release review D-1: a name/value pair leaks nothing with other fields between, in either order", () => {
  assert.equal(redactPatterns('{"name":"BAMBU_ACCESS_CODE","note":"x","value":"secretD1a"}'), '{"name":"BAMBU_ACCESS_CODE","note":"x","value":"[redacted]"}');
  assert.equal(redactPatterns('{"name":"BAMBU_ACCESS_CODE","scope":"lan","value":"secretD1a"}'), '{"name":"BAMBU_ACCESS_CODE","scope":"lan","value":"[redacted]"}');
  assert.equal(redactPatterns('{"value":"secretD1b","scope":"lan","note":"n","name":"cloud_token"}'), '{"value":"[redacted]","scope":"lan","note":"n","name":"cloud_token"}');
  const pretty = '{"settings": [\n  {\n    "name": "BAMBU_ACCESS_CODE",\n    "scope": "lan",\n    "value": "secretD1c"\n  }\n]}';
  assert.ok(!redactPatterns(pretty).includes("secretD1c"), "pretty-printed, inside an array");
  assert.doesNotThrow(() => JSON.parse(redactPatterns(pretty)));
  assert.equal(redactPatterns('{"name":"BAMBU_MODEL","note":"x","value":"p1s"}'), '{"name":"BAMBU_MODEL","note":"x","value":"p1s"}', "a setting that is not a secret stays");
  assert.equal(redactPatterns('{"name":"BAMBU_TOKEN","note":"x","value":"[set]"}'), '{"name":"BAMBU_TOKEN","note":"x","value":"[set]"}');
});

test("release review D-2 to D-5: bare hf_ keys, bare Digest credentials, %40 emails, spaced code labels", () => {
  // D-2
  assert.equal(redactPatterns("pulled with hf_abcdefghijklmnopqrstuvwxyz0123456789 ok"), "pulled with [redacted-token] ok");
  // D-3
  assert.equal(redactPatterns('sent Digest username="alice", realm="r", nonce="n1", response="6629fae49393a05397450978507c4ef1"\nnext'), "sent Digest [redacted]\nnext");
  // D-4
  assert.equal(redactPatterns("account is name%40example.com ok"), "account is [redacted-email] ok");
  assert.equal(redactPatterns("login=first.last%40mail.example.co.uk&x=1").includes("first.last"), false);
  // D-5
  assert.equal(redactPatterns("access code: 12345678"), "access code: [redacted]");
  assert.equal(redactPatterns('Pairing Code = "98765432"'), 'Pairing Code = "[redacted]"');
  assert.equal(redactPatterns("LAN code: 31415926, verification code 1234"), "LAN code: [redacted], verification code 1234");
  assert.equal(redactPatterns("access code: [set]"), "access code: [set]");
});

test("release review D-6: a random bare code, a bare AWS secret, XML and plist secrets, a quoted secret longer than 4096 characters", () => {
  assert.equal(redactPatterns('{"code": "Ab3dEf6hJk9mNpQrStUvWxYz0123"}'), '{"code": "[redacted]"}');
  assert.equal(redactPatterns("aws secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY end"), "aws secret [redacted-token] end");
  assert.equal(redactPatterns("<dict><key>apiToken</key>\n<string>plistsecret1</string></dict>"), "<dict><key>apiToken</key>\n<string>[redacted]</string></dict>");
  assert.equal(redactPatterns('<config><password type="x">xmlsecret22</password></config>'), '<config><password type="x">[redacted]</password></config>');
  const long = "w ".repeat(2500) + "tailsecret99";
  assert.equal(redactPatterns(`{"password":"${long}","port":990}`), '{"password":"[redacted]","port":990}');
  // Unchanged: plist keys and versions, element text that is not a secret, paths with slashes.
  for (const line of ["<key>CFBundleVersion</key><string>2.0.1</string>", "<name>P1S</name><key>token</key>", "/Users/Shared/Library/Application/Support/BambuStudio2",
    "Library/Application/Support/BambuStudio/x"]) {
    assert.equal(redactPatterns(line), line);
  }
});

test("printer error codes survive (N4)", () => {
  for (const line of ["HMS code 05004043 at ams", "code 1234 printer", "HMS_0500_4043 code: 0500-4043", '{"print_error":50348044,"code":1234}', "err_code=0300-0100-0001"]) {
    assert.equal(redactPatterns(line), line);
  }
});

test("redaction keeps names that only look like secret words, and Bambu's error codes", () => {
  for (const line of ["exit code: 0 err_code=1200 code=0", '{"step":"send","command":"pause","code":0}', "spinner=3 keyboard=us monkey=1",
    "token=[set] password=\"\" BAMBU_TOKEN=[set]", "authenticate: failed", "https://example.com/path?page=2"]) {
    assert.equal(redactPatterns(line), line);
  }
  assert.equal(redactPatterns("authorization: bearer abcDEF123456"), "authorization: bearer [redacted]", "the scheme stays");
  assert.equal(redactPatterns('{"accessCodeSet":true,"pin":null,"token":false}'), '{"accessCodeSet":true,"pin":null,"token":false}', "whether a secret is set stays");
  assert.deepEqual(JSON.parse(redactPatterns('{"pin": 7351, "otp":731204}')), { pin: "[redacted]", otp: "[redacted]" }, "a bare JSON number becomes a string");
});

test("redaction keeps empty and already-replaced values, so a setting still shows whether it is set", () => {
  const line = '{"API_KEY": "", "BAMBU_TOKEN": "[set]", "password": "[redacted]"} token=';
  assert.equal(redactPatterns(line), line);
});

test("redaction keeps serial numbers, hosts, hashes and ordinary words", () => {
  const line = 'serial 01P00A391200001 host 192.168.1.20 sha256 3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b "passed": true state=RUNNING author=David';
  assert.equal(redactPatterns(line), line);
});

test("redaction removes environment secrets and values seen in tool arguments, wherever they appear", t => {
  const previous = process.env.SOME_PRINTER_TOKEN;
  process.env.SOME_PRINTER_TOKEN = "envtoken-6655";
  t.after(() => { if (previous === undefined) delete process.env.SOME_PRINTER_TOKEN; else process.env.SOME_PRINTER_TOKEN = previous; resetDiagnosticsMemory(); });
  rememberSecretArguments({ host: "10.0.0.9", bambu_token: "argcode-1234", nested: { api_key: "nested-key-99" }, model: "p1s" });
  const out = redactPatterns("got envtoken-6655 then argcode-1234 and nested-key-99 from 10.0.0.9 p1s");
  for (const secret of ["envtoken-6655", "argcode-1234", "nested-key-99"]) assert.ok(!out.includes(secret), out);
  assert.match(out, /10\.0\.0\.9 p1s/);
});

test("every kind of secret written to a log file never comes out of the bundle", t => {
  const dir = scratch(t);
  const file = path.join(dir, "control-trace.log");
  // The serial line goes first: the unterminated PEM block at the end takes the rest of the file with it.
  fs.writeFileSync(file, "printer 01P00A391200001 ready\n" + SECRETS.map(([, line]) => line).join("\n") + "\n");
  const result = buildDiagnostics({ package: "pkg", version: "1.0.0", sources: [{ name: "fulu/control-trace.log", file }], secrets: ["7f3e9a21"] });
  validate(result);
  const text = JSON.stringify(result);
  for (const [kind, , secret] of SECRETS) assert.ok(!text.includes(secret), kind);
  assert.match(result.files[0].content, /printer 01P00A391200001 ready/, "a line that names no secret stays, its serial with it");
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
    redactPatterns(text);
    assert.ok(Date.now() - started < 10_000, `${name} took ${Date.now() - started} ms`);
  }
  assert.ok(!redactPatterns('password: "unclosed-secret').includes("unclosed-secret"));
});

// ---------------------------------------------------------------------------------------------------------------------
// The redesign after the release re-check (R-1 to R-7): fail closed. Every probe below leaked before it.

/** The whole bundle for one log of free text, and one JSON file, as the tool returns them. */
const bundleOf = (text, secrets = []) => JSON.stringify(buildDiagnostics({ package: "p", version: "1", sources: [{ name: "server-stderr.log", text }, { name: "logged.json", text }], secrets }));

const LEAKS = [
  // R-1: anything between a name and its value, and a value that is itself a structure.
  ["R-1 object between name and value", '{"name":"BAMBU_ACCESS_CODE","meta":{"a":1},"value":"r1secretA"}', "r1secretA"],
  ["R-1 braces in a string between", '{"name":"BAMBU_ACCESS_CODE","note":"a {b} c","value":"r1secretB"}', "r1secretB"],
  ["R-1 array of objects between", '{"name":"BAMBU_ACCESS_CODE","tags":[{"k":"v"}],"value":"r1secretC"}', "r1secretC"],
  ["R-1 an object over 16384 characters", `{"name":"BAMBU_ACCESS_CODE","pad":"${"x".repeat(17000)}","value":"r1secretD"}`, "r1secretD"],
  ["R-1 a value that is an object", '{"name":"password","value":{"nested":"r1secretE"}}', "r1secretE"],
  ["R-1 every element of an array value", '{"name":"tokens","value":["first1","r1SECOND"]}', "r1SECOND"],
  // R-2: other quoting, other field names, XML attributes, unquoted lists.
  ["R-2 Python dict", "{'name': 'BAMBU_TOKEN', 'value': 'r2secretA'}", "r2secretA"],
  ["R-2 Node inspect", "{ name: 'BAMBU_ACCESS_CODE', value: 'r2secretB' }", "r2secretB"],
  ["R-2 value under text", '{"name":"BAMBU_TOKEN","text":"r2secretC"}', "r2secretC"],
  ["R-2 value under v", '{"name":"BAMBU_TOKEN","v":"r2secretD"}', "r2secretD"],
  ["R-2 value under env_value", '{"name":"BAMBU_TOKEN","env_value":"r2secretE"}', "r2secretE"],
  ["R-2 value under setting", '{"name":"BAMBU_TOKEN","setting":"r2secretF"}', "r2secretF"],
  ["R-2 name under label", '{"label":"BAMBU_ACCESS_CODE","value":"r2secretG"}', "r2secretG"],
  ["R-2 name under property", '{"property":"apiToken","value":"r2secretH"}', "r2secretH"],
  ["R-2 name under envName", '{"envName":"BAMBU_TOKEN","value":"r2secretI"}', "r2secretI"],
  ["R-2 XML setting attributes", '<setting name="password" value="r2secretJ"/>', "r2secretJ"],
  ["R-2 XML add key", '<add key="BambuAccessCode" value="r2secretK"/>', "r2secretK"],
  ["R-2 Android string resource", '<string name="apiToken">r2secretL</string>', "r2secretL"],
  ["R-2 unquoted list", "tokens=[first2, r2SECOND]", "r2SECOND"],
  ["R-2 single-quoted list", "tokens=['first3', 'r2THIRD']", "r2THIRD"],
  // R-3: a pair inside JSON escaped in a string.
  ["R-3 escaped pair", String.raw`{"msg":"{\"name\":\"BAMBU_ACCESS_CODE\",\"value\":\"r3secretA\"}"}`, "r3secretA"],
  // R-4: an escaped quoted secret longer than any lookahead.
  ["R-4 long escaped value", String.raw`{"msg":"{\"password\":\"` + "Qq9 ".repeat(1300) + "r4tail99" + String.raw`\"}"}`, "r4tail99"],
  // R-5: spellings.
  ["R-5 pass as a JSON key", '{"pass":"r5secretA"}', "r5secretA"],
  ["R-5 mqtt pass=", "mqtt pass=r5secretB", "r5secretB"],
  ["R-5 device_code", "device_code=48291037", "48291037"],
  ["R-5 unlock_code", "unlock_code: 73920184", "73920184"],
  ["R-5 alternating case", "PaSsWoRd=r5secretC", "r5secretC"],
  ["R-5 alternating case, access code", "AcCeSsCoDe=r5secretD", "r5secretD"],
  ["R-5 \\x escape", String.raw`\x70assword=r5secretE`, "r5secretE"],
  ["R-5 % escape", "pass%77ord=r5secretF", "r5secretF"],
  // R-6: a secret split across lines.
  ["R-6 quoted value across lines", '{"password":"r6AAA\nr6BBB"}', "r6BBB"],
  ["R-6 Digest on the next line", 'Digest\n username="r6user", response="r6response"', "r6response"],
  ["R-6 folded header", "Authorization: Bearer\n  r6folded", "r6folded"],
  ["R-6 YAML folded value", "password: >\n  r6yaml\nnext: 1", "r6yaml"],
];

for (const [kind, text, secret] of LEAKS) {
  test(`fail closed: ${kind}`, () => {
    resetDiagnosticsMemory();
    const out = bundleOf(text);
    assert.ok(!out.includes(secret), `${kind}: ${out.length > 600 ? out.slice(0, 600) + "…" : out}`);
  });
}

test("R-7: long file names and measures under secret-sounding names stay", () => {
  const text = "wrote MyPrint2026Version3FinalAssembly.stl\ntokenCount: 5\nsessionTimeoutSec=30\npasswordMinLength = 8";
  assert.equal(redactText(text), text);
  const json = JSON.parse(buildDiagnostics({ package: "p", version: "1", sources: [{ name: "a.json", text: JSON.stringify({ tokenCount: 5, sessionTimeoutSec: 30, passwordMinLength: 8, file: "MyPrint2026Version3FinalAssembly.stl" }) }] }).files[0].content);
  assert.deepEqual(json, { tokenCount: 5, sessionTimeoutSec: 30, passwordMinLength: 8, file: "MyPrint2026Version3FinalAssembly.stl" });
});

test("a withheld line keeps its time and level, and lines that only say whether a secret is set stay", () => {
  assert.equal(redactText("2026-11-14T10:00:00.000Z error mqtt pass=hunter2x"), `2026-11-14T10:00:00.000Z error ${WITHHELD}`);
  for (const line of ["accessCodeSet: true", '  "BAMBU_TOKEN": "[set]",', "BAMBU_TOKEN=[set]", "HMS code 05004043", "firmware 01.08.02.00", "print_error: 0500-4043", "plain line"]) {
    assert.equal(redactText(line), line);
  }
});

test("JSON files stay valid JSON: a secret's value goes, its name and whether it is set stay", () => {
  const value = { printers: [{ id: "01P", accessCodeSet: true, connection: { mode: "lan" } }], env: [{ name: "BAMBU_TOKEN", scope: "lan", value: "jsonsecret1" }, { name: "BAMBU_MODEL", value: "p1s" }],
    msg: JSON.stringify({ name: "X_TOKEN", value: "jsonsecret2" }), note: "the password is jsonsecret3" };
  const out = JSON.parse(buildDiagnostics({ package: "p", version: "1", sources: [{ name: "printers.json", text: JSON.stringify(value) }] }).files[0].content);
  assert.equal(out.printers[0].accessCodeSet, true);
  assert.deepEqual(out.env[1], { name: "BAMBU_MODEL", value: "p1s" });
  assert.equal(out.env[0].name, "BAMBU_TOKEN");
  for (const secret of ["jsonsecret1", "jsonsecret2", "jsonsecret3"]) assert.ok(!JSON.stringify(out).includes(secret), secret);
});

test("objects are redacted when logged, before they are written as text, and the bundle never holds them", t => {
  resetDiagnosticsMemory();
  t.after(() => resetDiagnosticsMemory());
  captureServerLog();
  console.error("settings", { name: "BAMBU_ACCESS_CODE", scope: "lan", value: "capsecret1" }, { reply: JSON.stringify({ password: "capsecret2" }) });
  const log = serverLogText();
  for (const secret of ["capsecret1", "capsecret2"]) assert.ok(!log.includes(secret), log);
});

test("a configured secret goes in every encoded form, and before a long line is cut", t => {
  resetDiagnosticsMemory();
  t.after(() => resetDiagnosticsMemory());
  const code = "83c1f0a2";
  const forms = [code, Buffer.from(`bblp:${code}`).toString("base64"), Buffer.from(code).toString("base64"), encodeURIComponent(`x${code}&`), JSON.stringify(`"${code}"`)];
  const out = JSON.stringify(buildDiagnostics({ package: "p", version: "1", sources: [{ name: "a.log", text: forms.map(f => `got ${f} ok`).join("\n") }], secrets: [code] }));
  assert.ok(!out.includes(code), out);
  for (const form of forms.slice(1, 3)) assert.ok(!out.includes(form), form);
  // A code straddling the 4000-character line cut leaves no part of itself.
  const previous = process.env.SOME_PRINTER_TOKEN;
  process.env.SOME_PRINTER_TOKEN = "straddle-77665544";
  t.after(() => { if (previous === undefined) delete process.env.SOME_PRINTER_TOKEN; else process.env.SOME_PRINTER_TOKEN = previous; });
  captureServerLog();
  console.error("x".repeat(3990) + "straddle-77665544");
  assert.ok(!serverLogText().includes("straddle-776"), "no partial value");
});

test("settings show values only for known non-secret settings; any other shows only whether it is set", () => {
  const env = { BAMBU_MODEL: "p1s", SLICER_API_URL: "https://user:pw@slicer.example/api", BLENDER_MCP_ARGS: "--token abc", BAMBU_TOKEN: "x", API_KEY: "", PRINTER_HOST: "10.0.0.4" };
  assert.deepEqual(settingsSnapshot(/^(?:BAMBU|SLICER|BLENDER|API_KEY|PRINTER)/, env),
    { API_KEY: "", BAMBU_MODEL: "p1s", BAMBU_TOKEN: "[set]", BLENDER_MCP_ARGS: "[set]", PRINTER_HOST: "10.0.0.4", SLICER_API_URL: "[set]" });
});

test("property: a secret under any secret word, in any syntax, never comes out of the bundle", () => {
  let seed = 0x5eed;
  const rand = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pick = list => list[rand(list.length)];
  const WORDS = ["password", "pass", "passwd", "secret", "token", "apiKey", "access_code", "lanCode", "pairing-code", "deviceCode", "unlock_code",
    "auth", "cookie", "session", "credential", "privateKey", "passphrase", "client_secret", "refreshToken", "x-api-key"];
  const spell = word => {
    const cased = [...word].map(c => (rand(2) ? c.toUpperCase() : c.toLowerCase())).join("");
    return pick([word, cased, word.toUpperCase(), cased.replace(/^./, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)]);
  };
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const SYNTAX = [
    (w, s) => JSON.stringify({ outer: { inner: { [w]: s } } }),
    (w, s) => JSON.stringify({ name: w.toUpperCase(), note: "n", meta: { a: [1, { b: 2 }] }, value: s }),
    (w, s) => `{'${w}': '${s}'}`,
    (w, s) => `<${w.replace(/[^A-Za-z]/g, "")}>${s}</${w.replace(/[^A-Za-z]/g, "")}>`,
    (w, s) => `<add key="${w}" value="${s}"/>`,
    (w, s) => `${w}: ${s}`,
    (w, s) => JSON.stringify({ msg: JSON.stringify({ [w]: s }) }),
    (w, s) => JSON.stringify({ msg: JSON.stringify({ name: w, value: s }) }),
    (w, s) => `${w} = "${s.slice(0, 6)}\n${s.slice(6)}"`,
    (w, s) => `${w}:\n  ${s}`,
    (w, s) => `2026-11-14T10:00:00.000Z warn ${w}=${s} more`,
    (w, s) => `--${w} ${s}`,
  ];
  for (let i = 0; i < 400; i++) {
    const secret = Array.from({ length: 12 }, () => alphabet[rand(alphabet.length)]).join("");
    const syntax = rand(SYNTAX.length);
    const text = `before ${i}\n${SYNTAX[syntax](spell(pick(WORDS)), secret)}\nafter ${i}`;
    const out = bundleOf(text);
    for (const piece of [secret, secret.slice(0, 6), secret.slice(6)]) {
      assert.ok(!out.includes(piece), `case ${i} (syntax ${syntax}) leaked ${piece}: ${JSON.stringify(text)} -> ${out.slice(0, 400)}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The adversarial review of the redesign (S-1 to S-8): narrow breaks around R-1 to R-7. Each failed before its fix.

const textBundle = (text, options = {}) => JSON.stringify(buildDiagnostics({ package: "p", version: "1", sources: [{ name: "server-stderr.log", text }], ...options }));
const jsonBundle = text => JSON.stringify(buildDiagnostics({ package: "p", version: "1", sources: [{ name: "dump.json", text }] }));

const S_LEAKS = [
  // S-1: a rescued line that leaves a quote open, or is followed by an indented line, keeps its continuation withheld.
  ["S-1 rescued line with an open quote", 'password: "true\nzq482910x"', "zq482910x"],
  ["S-1 rescued line with an indented continuation", "token: true\n  zq482910y", "zq482910y"],
  // S-5: continuations that are not indented, and open structures past the 200-line cap.
  ["S-5 multipart part named like a secret", '--b1\nContent-Disposition: form-data; name="password"\n\nzq5multi\n--b1--', "zq5multi"],
  ["S-5 Authorization wrapped unindented", "Authorization: Bearer\nzq5wrapped", "zq5wrapped"],
  ["S-5 Bearer token wrapped mid-token", "sent Bearer abcdefghijkl\nzq5midtail", "zq5midtail"],
  ["S-5 YAML block with a blank line", "password: >\n  zq5first\n\n  zq5second\nnext: 1", "zq5second"],
  ["S-5 an open bracket past 200 lines", 'dump {"tokens":[\n' + '  "x",\n'.repeat(250) + '  "zq5deep"\n]}', "zq5deep"],
  // S-6: a single-quoted value split across lines.
  ["S-6 single quotes across lines", "password='zq48\n2910x'", "2910x"],
  // S-7: HTML entities and \u{…} in a secret's name.
  ["S-7 HTML entity", "passw&#111;rd=zq7html", "zq7html"],
  ["S-7 hex HTML entity", "passw&#x6f;rd=zq7hexent", "zq7hexent"],
  ["S-7 Rust \\u{…}", String.raw`\u{70}assword=zq7rust`, "zq7rust"],
];
for (const [kind, text, secret] of S_LEAKS) {
  test(`review: ${kind}`, () => {
    resetDiagnosticsMemory();
    assert.ok(!textBundle(text).includes(secret), `${kind}: ${textBundle(text)}`);
  });
}

test("review S-2: a held secret goes in other encoders' spellings, by decoding each line and searching it", () => {
  for (const [secret, carrier] of [["hun ter+9", "q=hun+ter%2B9&x=1"], ["ab/cd9z", "path=ab%2fcd9z"], ["ab<cd9z", String.raw`{"v":"ab<cd9z"}`],
    ["zq482910x", String.raw`got zq482910x ok`], ["ab/cd9z", String.raw`{"p":"ab\/cd9z"}`], ["ab<cd9z", "v=ab&#60;cd9z;"], ["ab<cd9z", "v=ab&#x3c;cd9z"],
    ["ab<cd9z", String.raw`v=ab\u{3c}cd9z`], ["ab<cd9z", String.raw`v=ab\x3ccd9z`]]) {
    const out = textBundle(`innocent line\n${carrier}\nnext`, { secrets: [secret] });
    assert.ok(!out.includes(carrier), `${secret} in ${carrier}: ${out}`);
    assert.match(out, /innocent line/);
  }
});

test("review S-3: a short held secret in base64 at each offset leaves no decodable part", () => {
  const secret = "Kx9!pq2";
  for (const before of ["", "x", "xx", "xxx:"]) {
    const carrier = Buffer.from(`${before}${secret}`).toString("base64");
    const out = textBundle(`blob ${carrier} end`, { secrets: [secret] });
    const runs = out.match(/[A-Za-z0-9+/]{4,}={0,2}/g) ?? [];
    for (const run of runs) {
      const decoded = Buffer.from(run, "base64").toString("latin1");
      for (const piece of ["Kx9", "x9!", "9!p", "!pq", "pq2"]) assert.ok(!decoded.includes(piece), `offset ${before.length}: ${run} decodes to ${JSON.stringify(decoded)}`);
    }
  }
});

test("review S-4: name/value shapes in a JSON file: a spaced name, a setting field, Object.entries pairs", () => {
  for (const [text, secret] of [['{"name":"Access Code","value":"zq4spaced"}', "zq4spaced"], ['{"setting":"BAMBU_TOKEN","value":"zq4setting"}', "zq4setting"],
    ['{"env":[["BAMBU_TOKEN","zq4tuple"],["BAMBU_MODEL","p1s"]]}', "zq4tuple"], ['[["PRINTER_PASSWORD","zq4top"]]', "zq4top"]]) {
    const out = jsonBundle(text);
    assert.ok(!out.includes(secret), `${text}: ${out}`);
  }
  const kept = JSON.parse(JSON.parse(jsonBundle('{"env":[["BAMBU_TOKEN","zq4tuple"],["BAMBU_MODEL","p1s"]]}')).files[0].content);
  assert.deepEqual(kept.env[1], ["BAMBU_MODEL", "p1s"], "a pair whose name is no secret stays");
  assert.equal(kept.env[0][0], "BAMBU_TOKEN");
});

test("review S-8: secrets in tool arguments are held from arrays, numbers and deep nesting", () => {
  resetDiagnosticsMemory();
  rememberSecretArguments({ tokens: ["zq8arrayvalue"], accessCode: 48291037, a: { b: { c: { d: { e: { f: { password: "zq8deepvalue" } } } } } } });
  const out = textBundle("using zq8arrayvalue now\ncode accepted 48291037\nthen zq8deepvalue");
  resetDiagnosticsMemory();
  for (const secret of ["zq8arrayvalue", "48291037", "zq8deepvalue"]) assert.ok(!out.includes(secret), `${secret}: ${out}`);
});

test("review P3: notes go through the same withholding as files", () => {
  const out = JSON.stringify(buildDiagnostics({ package: "p", version: "1", sources: [], notes: ["the password is zq9note"] }));
  assert.ok(!out.includes("zq9note"), out);
});

test("property: the review's syntaxes (multipart, single-quote splits, form-url, Go escapes, pairs, spaced names) never leak", () => {
  let seed = 0x5e2;
  const rand = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pick = list => list[rand(list.length)];
  const WORDS = ["password", "Access Code", "api key", "token", "Pairing Code", "secret", "passphrase", "session"];
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const SYNTAX = [
    (w, s) => ["--xyz", `Content-Disposition: form-data; name="${w}"`, "", s, "--xyz--"].join("\n"),
    (w, s) => `${w.replace(/ /g, "_")}='${s.slice(0, 5)}\n${s.slice(5)}'`,
    (w, s) => `${encodeURIComponent(w).replace(/%20/g, "+")}=${s}&next=1`,
    (w, s) => String.raw`{"<${w}>":"${s}"}`,
    (w, s) => JSON.stringify({ env: [[w, s], ["model", "p1s"]] }),
    (w, s) => JSON.stringify({ name: w, note: "n", value: s }),
    (w, s) => JSON.stringify([w, s]),
    (w, s) => `${w}: |\n  ${s.slice(0, 6)}\n\n  ${s.slice(6)}\nafter: 1`,
  ];
  for (let i = 0; i < 240; i++) {
    const secret = Array.from({ length: 12 }, () => alphabet[rand(alphabet.length)]).join("");
    const syntax = rand(SYNTAX.length);
    const text = `before ${i}\n${SYNTAX[syntax](pick(WORDS), secret)}\nafter ${i}`;
    for (const out of [textBundle(text), jsonBundle(SYNTAX[syntax](pick(WORDS), secret))]) {
      for (const piece of [secret, secret.slice(0, 5), secret.slice(6)]) {
        assert.ok(!out.includes(piece), `case ${i} (syntax ${syntax}) leaked ${piece}: ${JSON.stringify(text)} -> ${out.slice(0, 400)}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Reason tags on a withheld line. A withheld line names the auth states it mentions from a fixed list, never with any
// of its own text: "[line withheld: may contain a secret · mentions: token expired]". It cannot leak by construction.

const TAGS = diagnostics.WITHHELD_REASONS ?? [];
const MARKER = new RegExp(String.raw`^\[line withheld: may contain a secret(?: · mentions: ((?:[^,\]]+)(?:, [^,\]]+)*))?\]$`);
/** The output of one withheld line, minus its time and level, is the fixed marker and phrases from the list only. */
const onlyMarker = line => {
  const m = MARKER.exec(line.replace(/^\S+ (?:error|warn) /, ""));
  return !!m && (m[1] ?? "").split(", ").filter(Boolean).every(tag => TAGS.includes(tag));
};

test("the real login-expired sentence is withheld with its reasons named", () => {
  const out = redactText("2026-11-14T16:55:13.912Z error Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` to sign in again, or use `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for unattended jobs");
  assert.ok(onlyMarker(out), out);
  for (const tag of ["failed to authenticate", "login time limit", "claude auth login", "sign in again", "setup-token"]) assert.ok(out.includes(tag), `${tag}: ${out}`);
  assert.ok(out.startsWith("2026-11-14T16:55:13.912Z error [line withheld"), out);
});

test("common auth failures are withheld with their reasons", () => {
  for (const [line, tag] of [["cloud token refresh failed", "token refresh failed"], ["Access code is wrong", "access code wrong"], ["401 Unauthorized", "unauthorized"],
    ["Model access token expired", "token expired"], ["access code rejected by printer", "access code rejected"], ["Permission denied (publickey,password)", "permission denied"]]) {
    const out = redactText(line);
    assert.ok(onlyMarker(out) && out.includes(tag), `${line}: ${out}`);
  }
});

// The focused check's probes (bambu-printer-mcp #166 comment 6892743713): every one withheld, its value never out.
const X_PROBES = [
  ["the password sunflower was rejected", "sunflower"], ["password zxqvbn rejected", "zxqvbn"], ["wrong password zxqvbn", "zxqvbn"],
  ["password zxqvbn is wrong", "zxqvbn"], ["password is wrong zxqvbn", "zxqvbn"], ["access code is wrong 48291037", "48291037"],
  ["the access code was rejected 48291037", "48291037"], ["access code wrong 4829", "4829"], ["token expired zxqvbnmk", "zxqvbnmk"],
  ["zxqvbnmk token expired", "zxqvbnmk"], ["expired zxqvbnmk token", "zxqvbnmk"], ["TOKEN EXPIRED ZXQVBNMK", "ZXQVBNMK"],
  ["authentication failed: password zxqvbnmk rejected by the printer", "zxqvbnmk"], ["invalid credentials, password zxqvbnmk", "zxqvbnmk"],
  ["LAN login failed, access code rejected (48291037)", "48291037"], ["cloud token refresh failed for zxqvbnmk", "zxqvbnmk"],
  ["token expired; password zxqvbn", "zxqvbn"], ["password for this printer is zxqvbn and was rejected", "zxqvbn"],
  ["CLAUDE_CODE_OAUTH_TOKEN zxqvbnmk expired", "zxqvbnmk"], ["CLAUDE_CODE_OAUTH_TOKEN zxqvbnmk is expired", "zxqvbnmk"],
  ["password：zxqvbn rejected", "zxqvbn"], ["token “zxqvbnmk” expired", "zxqvbnmk"], ["password `zxqvbn` rejected", "zxqvbn"],
  ["run claude auth login zxqvbnmk", "zxqvbnmk"], ["invalid token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2ln", "eyJzdWIiOiIxMjM0In0"],
  ["token invalid eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2ln", "eyJzdWIiOiIxMjM0In0"], ["Bearer zq4829 expired", "zq4829"],
  ["Bearer zqalpha expired", "zqalpha"], ["token expired, new token zqnewtoken", "zqnewtoken"], ["new token zqnewtoken, token expired", "zqnewtoken"],
  ["token=zqvalue9 expired", "zqvalue9"], ["password is hunter2x", "hunter2x"], ["access code 48291037 rejected", "48291037"],
  ['token "zq7quoted" expired', "zq7quoted"], ["auth failed for user:pqzz77@host.example", "pqzz77"], ["token expired\n  zq7continued", "zq7continued"],
];
for (const [text, secret] of X_PROBES) {
  test(`focused check probe stays withheld: ${text.slice(0, 50)}`, () => {
    const out = textBundle(text) + JSON.stringify(buildDiagnostics({ package: "p", version: "1", sources: [], notes: [text] }));
    assert.ok(!out.includes(secret), `${text}: ${out}`);
  });
}

test("property: a withheld line's output is only the fixed marker and phrases from the list", () => {
  let seed = 0x7a6;
  const rand = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pick = list => list[rand(list.length)];
  const WORDS = ["password", "token", "access code", "api key", "session", "secret", "auth"];
  const STATES = ["expired", "rejected", "is wrong", "refresh failed", "invalid", "denied", "time limit", "Unauthorized 401", "sign in again"];
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let i = 0; i < 300; i++) {
    const value = Array.from({ length: 4 + rand(10) }, () => alphabet[rand(alphabet.length)]).join("");
    const parts = [pick(WORDS), pick(STATES), value, pick(["login", "for the printer", "(", "“", "`", "：", "="]), pick(WORDS)];
    for (let j = parts.length - 1; j > 0; j--) { const k = rand(j + 1); [parts[j], parts[k]] = [parts[k], parts[j]]; }
    const line = `2026-11-15T10:00:00.000Z error ${parts.join(" ")}`;
    const out = redactText(line);
    assert.ok(onlyMarker(out), `case ${i}: ${JSON.stringify(line)} -> ${out}`);
    assert.ok(!out.includes(value), `case ${i} leaked ${value}`);
  }
});
