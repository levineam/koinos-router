"use strict";

/*
 * router/lib/keychain-access.js: when Router explains the macOS Keychain
 * prompt before its first decrypt, and what it records afterwards. Plain
 * Node; codesign is faked except for one read-only run against the Electron
 * app in node_modules.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const ka = require("../lib/keychain-access");
const secrets = require("../lib/secrets");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "koinos-keychain-test-"));

const ADHOC_OUT = '# designated => cdhash H"60dc1e5675adab4454b28d2ab4c2cf623810a747"\n';
const ADHOC_ERR = [
  "Executable=/Applications/Koinos Router.app/Contents/MacOS/Koinos Router",
  "Identifier=io.koinosai.router",
  "CodeDirectory v=20400 size=491 flags=0x2(adhoc) hashes=9+3 location=embedded",
  "CDHash=60dc1e5675adab4454b28d2ab4c2cf623810a747",
  "Signature=adhoc",
  "TeamIdentifier=not set",
].join("\n");
const LOCAL_DR = 'identifier "io.koinosai.router" and certificate root = H"2b8ab81c5743b9faea7c09be6812471bde65e5af"';
const TEAM_DR = 'identifier "io.koinosai.router" and anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"';

const adhoc = (cdhash) => ({ designated: `cdhash H"${cdhash}"`, cdhash, teamId: null });
const local = (cdhash) => ({ designated: LOCAL_DR, cdhash, teamId: null });
const team = (cdhash) => ({ designated: TEAM_DR, cdhash, teamId: "ABCDE12345" });

const base = { packaged: true, smoke: false, hasSecrets: true };

// ------------------------------------------------------------- decision

test("never explains for an unpackaged or smoke run, or with no secret stored yet", () => {
  const args = { current: adhoc("aa"), recorded: null };
  assert.strictEqual(ka.shouldExplainKeychain({ ...base, ...args, packaged: false }), false);
  assert.strictEqual(ka.shouldExplainKeychain({ ...base, ...args, smoke: true }), false);
  assert.strictEqual(ka.shouldExplainKeychain({ ...base, ...args, hasSecrets: false }), false);
});

test("explains when this build was never recorded or its designated requirement changed", () => {
  assert.strictEqual(ka.shouldExplainKeychain({ ...base, current: adhoc("aa"), recorded: null }), true);
  assert.strictEqual(ka.shouldExplainKeychain({ ...base, current: adhoc("bb"), recorded: adhoc("aa") }), true);
  assert.strictEqual(ka.shouldExplainKeychain({ ...base, current: local("aa"), recorded: adhoc("aa") }), true);
  assert.strictEqual(ka.shouldExplainKeychain({ ...base, current: team("aa"), recorded: local("aa") }), true);
});

test("the same build never explains", () => {
  assert.strictEqual(ka.shouldExplainKeychain({ ...base, current: adhoc("aa"), recorded: adhoc("aa") }), false);
  assert.strictEqual(ka.shouldExplainKeychain({ ...base, current: local("aa"), recorded: local("aa") }), false);
});

test("same DR: a team-signed rebuild never explains, a team-less one does (cdhash partition)", () => {
  // Apple-issued certificate: keychain partition "teamid:…" survives rebuilds.
  assert.strictEqual(ka.shouldExplainKeychain({ ...base, current: team("bb"), recorded: team("aa") }), false);
  // Self-signed: same DR, but the partition is "cdhash:…", so macOS asks again.
  assert.strictEqual(ka.shouldExplainKeychain({ ...base, current: local("bb"), recorded: local("aa") }), true);
});

test("a codesign failure explains only when there is a record to go by", () => {
  assert.strictEqual(ka.shouldExplainKeychain({ ...base, current: null, recorded: adhoc("aa") }), true);
  assert.strictEqual(ka.shouldExplainKeychain({ ...base, current: null, recorded: null }), false);
  assert.strictEqual(ka.shouldExplainKeychain({ ...base, current: { designated: null }, recorded: null }), false);
  // ...and still never for unpackaged, smoke or no-secret runs.
  assert.strictEqual(ka.shouldExplainKeychain({ ...base, packaged: false, current: null, recorded: adhoc("aa") }), false);
  assert.strictEqual(ka.shouldExplainKeychain({ ...base, smoke: true, current: null, recorded: adhoc("aa") }), false);
  assert.strictEqual(ka.shouldExplainKeychain({ ...base, hasSecrets: false, current: null, recorded: adhoc("aa") }), false);
});

test("identityKey and sameIdentity", () => {
  assert.strictEqual(ka.identityKey(null), null);
  assert.strictEqual(ka.identityKey({ designated: "" }), null);
  assert.strictEqual(ka.identityKey(team("aa")), `designated:${TEAM_DR}`);
  assert.strictEqual(ka.identityKey(local("aa")), `designated:${LOCAL_DR}\ncdhash:aa`);
  assert.ok(ka.sameIdentity(team("aa"), team("bb")));
  assert.ok(!ka.sameIdentity(local("aa"), local("bb")));
  assert.ok(!ka.sameIdentity(null, null));
});

// ---------------------------------------------------------- codesign I/O

test("bundlePathFromExecPath finds the .app around the main binary", () => {
  assert.strictEqual(
    ka.bundlePathFromExecPath("/Applications/Koinos Router.app/Contents/MacOS/Koinos Router"),
    "/Applications/Koinos Router.app",
  );
  assert.strictEqual(ka.bundlePathFromExecPath("/usr/local/bin/node"), null);
  assert.strictEqual(ka.bundlePathFromExecPath("/x/Contents/MacOS/x"), null);
  assert.strictEqual(ka.bundlePathFromExecPath(""), null);
  assert.strictEqual(ka.bundlePathFromExecPath(undefined), null);
});

test("parseCodesignDisplay reads the DR (ad-hoc '#' form too), cdhash and team", () => {
  assert.deepStrictEqual(ka.parseCodesignDisplay(ADHOC_OUT, ADHOC_ERR), {
    designated: 'cdhash H"60dc1e5675adab4454b28d2ab4c2cf623810a747"',
    cdhash: "60dc1e5675adab4454b28d2ab4c2cf623810a747",
    teamId: null,
  });
  const signed = ka.parseCodesignDisplay(`designated => ${LOCAL_DR}\n`, "CDHash=ABCDEF\nTeamIdentifier=ABCDE12345\n");
  assert.deepStrictEqual(signed, { designated: LOCAL_DR, cdhash: "abcdef", teamId: "ABCDE12345" });
  assert.deepStrictEqual(ka.parseCodesignDisplay("", "code object is not signed at all"), { designated: null, cdhash: null, teamId: null });
});

test("readSigningIdentity runs codesign with a 3 s timeout and never rejects", async () => {
  let call;
  const ok = (file, args, opts, cb) => {
    call = { file, args, opts };
    cb(null, ADHOC_OUT, ADHOC_ERR);
  };
  const id = await ka.readSigningIdentity({ bundlePath: "/A.app", execFile: ok });
  assert.strictEqual(call.file, "/usr/bin/codesign");
  assert.deepStrictEqual(call.args, ["-d", "-vvv", "-r-", "/A.app"]);
  assert.strictEqual(call.opts.timeout, 3000);
  assert.strictEqual(id.cdhash, "60dc1e5675adab4454b28d2ab4c2cf623810a747");

  const failing = (_f, _a, _o, cb) => cb(Object.assign(new Error("killed"), { killed: true }), "", "");
  assert.strictEqual(await ka.readSigningIdentity({ bundlePath: "/A.app", execFile: failing }), null);
  const throwing = () => {
    throw new Error("spawn EACCES");
  };
  assert.strictEqual(await ka.readSigningIdentity({ bundlePath: "/A.app", execFile: throwing }), null);
  const noDr = (_f, _a, _o, cb) => cb(null, "", "Executable=/A.app/Contents/MacOS/A\n");
  assert.strictEqual(await ka.readSigningIdentity({ bundlePath: "/A.app", execFile: noDr }), null);
  assert.strictEqual(await ka.readSigningIdentity({ bundlePath: null, execFile: ok }), null);
});

test("readSigningIdentity reads a real bundle with the real codesign", { skip: process.platform !== "darwin" }, async () => {
  const app = path.join(__dirname, "..", "..", "node_modules", "electron", "dist", "Electron.app");
  if (!fs.existsSync(app)) return;
  const id = await ka.readSigningIdentity({ bundlePath: app, execFile });
  assert.ok(id, "codesign printed a designated requirement");
  assert.match(id.designated, /\S/);
  assert.ok(ka.identityKey(id));
});

// --------------------------------------------------------------- record

test("the record round-trips as a 0600 file and ignores garbage", () => {
  const dir = tmpDir();
  try {
    assert.strictEqual(ka.readRecord(dir), null);
    assert.strictEqual(ka.writeRecord(dir, local("aa"), () => 1234), true);
    const file = path.join(dir, ka.RECORD_FILE);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), { designated: LOCAL_DR, cdhash: "aa", teamId: null, at: 1234 });
    assert.deepStrictEqual(ka.readRecord(dir), local("aa"));
    assert.ok(ka.sameIdentity(ka.readRecord(dir), local("aa")));
    // Nothing usable to record: nothing written.
    assert.strictEqual(ka.writeRecord(dir, null), false);
    assert.deepStrictEqual(ka.readRecord(dir), local("aa"));
    fs.writeFileSync(file, "{not json");
    assert.strictEqual(ka.readRecord(dir), null);
    fs.writeFileSync(file, JSON.stringify({ designated: 7 }));
    assert.strictEqual(ka.readRecord(dir), null);
    assert.deepStrictEqual(fs.readdirSync(dir), [ka.RECORD_FILE], "no temp files left behind");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hasEncryptedSecrets sees only non-empty .bin secrets", () => {
  const dir = tmpDir();
  try {
    assert.strictEqual(secrets.hasEncryptedSecrets(dir), false);
    fs.writeFileSync(path.join(dir, "machine-secret.plain"), "x\n");
    assert.strictEqual(secrets.hasEncryptedSecrets(dir), false, "a plaintext fallback needs no Keychain");
    fs.writeFileSync(path.join(dir, "wallet-password.bin"), "");
    assert.strictEqual(secrets.hasEncryptedSecrets(dir), false);
    fs.writeFileSync(path.join(dir, "wallet-password.bin"), "ciphertext");
    assert.strictEqual(secrets.hasEncryptedSecrets(dir), true);
    assert.strictEqual(secrets.hasEncryptedSecrets(null), false);
    assert.strictEqual(secrets.hasEncryptedSecrets(path.join(dir, "missing")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the explanation copy says what to press, in plain words", () => {
  assert.strictEqual(ka.EXPLAIN.title, "One quick permission");
  assert.strictEqual(ka.EXPLAIN.message, "macOS will ask if Koinos Router can use its saved key");
  assert.match(ka.EXPLAIN.detail, /login password/);
  assert.match(ka.EXPLAIN.detail, /“Always Allow” \(or “Allow” if that’s all you see\)/);
  assert.match(ka.EXPLAIN.detail, /unlock your wallet and keep earning/);
  assert.strictEqual(ka.EXPLAIN.button, "Continue");
  assert.deepStrictEqual(ka.DENIED.buttons, ["Try Again", "Not Now"]);
  assert.match(ka.DENIED.detail, /wallet stays locked/);
  assert.match(ka.DENIED.detail, /Always Allow/);
});
