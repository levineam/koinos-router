"use strict";

/*
 * When dist:router notarizes, and the exact commands it would run
 * (router/scripts/notarize-router.js). No network: the runner is a fake.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const n = require("../scripts/notarize-router");
const sign = require("../scripts/sign-router");

const DEV_ID = { hash: "A".repeat(40), name: "Developer ID Application: Koinos (ABCDE12345)", status: null, kind: "developer-id" };
const APPLE_DEV = { hash: "B".repeat(40), name: "Apple Development: Jane Doe (ABCDE12345)", status: null, kind: "apple-development" };
const LOCAL = { hash: "C".repeat(40), name: "Koinos Router Local", status: "CSSMERR_TP_NOT_TRUSTED", kind: "local" };
const API = { APPLE_API_KEY: "/keys/AuthKey_X.p8", APPLE_API_KEY_ID: "KEYID12345", APPLE_API_ISSUER: "1111-2222" };
const APPLE_ID = { APPLE_ID: "dev@example.com", APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop", APPLE_TEAM_ID: "ABCDE12345" };
const exists = (p) => p === API.APPLE_API_KEY;

test("only a Developer ID build with notary credentials is notarized", () => {
  // Ad-hoc (the 0.1.0 release), Apple Development and self-signed: never, whatever the environment.
  for (const identity of [null, { ...sign.ADHOC }, APPLE_DEV, LOCAL]) {
    const d = n.decide({ identity, env: { ...API, ...APPLE_ID }, exists });
    assert.strictEqual(d.notarize, false, identity ? identity.name : "none");
    assert.match(d.reason, /only a Developer ID Application identity can be notarized/);
  }
  assert.match(n.decide({ identity: { ...sign.ADHOC }, env: {} }).reason, /ad-hoc/);
  assert.match(n.decide({ identity: APPLE_DEV, env: {} }).reason, /"Apple Development: Jane Doe/);
  // An explicitly named Developer ID counts too.
  assert.strictEqual(n.decide({ identity: { ...DEV_ID, kind: "explicit" }, env: API, exists }).notarize, true);

  // Developer ID without credentials: the reason says what to set.
  const none = n.decide({ identity: DEV_ID, env: {} });
  assert.strictEqual(none.notarize, false);
  assert.match(none.reason, /no notary credentials/);
  for (const v of ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "KOINOS_NOTARY_PROFILE"]) {
    assert.ok(none.reason.includes(v), v);
  }
  // Half a set is named as such.
  const half = n.decide({ identity: DEV_ID, env: { APPLE_ID: "dev@example.com", APPLE_TEAM_ID: "T" } });
  assert.strictEqual(half.notarize, false);
  assert.match(half.reason, /APPLE_ID \+ APPLE_TEAM_ID set but APPLE_APP_SPECIFIC_PASSWORD missing/);
  // An API key path that isn't there.
  assert.match(n.decide({ identity: DEV_ID, env: API, exists: () => false }).reason, /APPLE_API_KEY must be the path to the \.p8 key file/);

  // The one line dist-router prints.
  const line = n.notNotarizedLine(none.reason);
  assert.strictEqual(line.split("\n").length, 1);
  assert.match(line, /^\[dist-router\] Not notarized: no notary credentials .*Open Anyway in System Settings › Privacy & Security\.$/);
});

test("credentials become notarytool arguments, first complete set wins, secrets stay out of logs", () => {
  const api = n.notaryCredentials({ ...API, ...APPLE_ID, KOINOS_NOTARY_PROFILE: "p" }, { exists });
  assert.strictEqual(api.kind, "api-key");
  assert.deepStrictEqual(api.args, ["--key", "/keys/AuthKey_X.p8", "--key-id", "KEYID12345", "--issuer", "1111-2222"]);

  const id = n.notaryCredentials({ ...APPLE_ID, KOINOS_NOTARY_PROFILE: "p" });
  assert.strictEqual(id.kind, "apple-id");
  assert.deepStrictEqual(id.args, ["--apple-id", "dev@example.com", "--password", "abcd-efgh-ijkl-mnop", "--team-id", "ABCDE12345"]);
  assert.ok(!id.display.includes("abcd-efgh-ijkl-mnop"));
  assert.deepStrictEqual(id.display, ["--apple-id", "dev@example.com", "--password", "<redacted>", "--team-id", "ABCDE12345"]);

  assert.deepStrictEqual(n.notaryCredentials({ KOINOS_NOTARY_PROFILE: "koinos" }).args, ["--keychain-profile", "koinos"]);
  assert.deepStrictEqual(n.notaryCredentials({ KOINOS_NOTARY_PROFILE: "koinos", KOINOS_NOTARY_KEYCHAIN: "/k.keychain-db" }).args, [
    "--keychain-profile",
    "koinos",
    "--keychain",
    "/k.keychain-db",
  ]);
  assert.strictEqual(n.notaryCredentials({}), null);
  assert.strictEqual(n.notaryCredentials({ APPLE_ID: "  " }), null, "blank is unset");
});

test("the commands: submit --wait, staple, validate, sign the dmg, assess with spctl", () => {
  const creds = n.notaryCredentials({ KOINOS_NOTARY_PROFILE: "koinos" });
  assert.deepStrictEqual(n.xcrun.submit("/o/a.zip", creds), [
    "notarytool", "submit", "/o/a.zip", "--keychain-profile", "koinos", "--wait", "--timeout", "2h", "--output-format", "json", "--no-progress",
  ]);
  assert.deepStrictEqual(n.xcrun.log("abc", creds), ["notarytool", "log", "abc", "--keychain-profile", "koinos"]);
  assert.deepStrictEqual(n.xcrun.staple("/o/x.dmg"), ["stapler", "staple", "/o/x.dmg"]);
  assert.deepStrictEqual(n.xcrun.validate("/o/x.dmg"), ["stapler", "validate", "/o/x.dmg"]);
  assert.deepStrictEqual(n.dittoZipArgs("/o/K.app", "/t/K.zip"), ["-c", "-k", "--sequesterRsrc", "--keepParent", "/o/K.app", "/t/K.zip"]);
  assert.deepStrictEqual(n.codesignDmgArgs("/o/x.dmg", DEV_ID), ["--sign", DEV_ID.hash, "--timestamp", "/o/x.dmg"]);
  assert.deepStrictEqual(n.codesignDmgArgs("/o/x.dmg", DEV_ID, { keychain: "/k" }), ["--sign", DEV_ID.hash, "--timestamp", "--keychain", "/k", "/o/x.dmg"]);
  assert.deepStrictEqual(n.spctlArgs("/o/K.app"), ["--assess", "--type", "execute", "-vv", "/o/K.app"]);
  assert.deepStrictEqual(n.spctlArgs("/o/x.dmg"), ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", "/o/x.dmg"]);

  assert.deepStrictEqual(n.parseSubmitResult('{"id":"abc","status":"Accepted","message":"ok"}\n'), { id: "abc", status: "Accepted", message: "ok" });
  assert.strictEqual(n.parseSubmitResult('Conducting pre-submission checks...\n{"id":"d","status":"Invalid"}').status, "Invalid");
  assert.throws(() => n.parseSubmitResult("Error: HTTP status code: 401"), /no result/);

  assert.ok(n.spctlAccepted("/o/K.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: K (T)"));
  assert.ok(!n.spctlAccepted("/o/K.app: accepted\nsource=Developer ID"), "signed but not notarized");
  assert.ok(!n.spctlAccepted("/o/K.app: rejected"), "what an ad-hoc build gets");
});

/** A fake runner: records calls, answers from a script. */
function fakeRun(answers = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "/usr/bin/ditto") fs.writeFileSync(args[args.length - 1], "zip");
    const key = `${path.basename(cmd)} ${args.slice(0, 2).join(" ")}`;
    return { status: 0, stdout: "", stderr: "", ...(answers[key] || {}) };
  };
  return { run, calls };
}

test("notarizing an app zips it, waits for Accepted, then staples and validates the app", () => {
  const creds = n.notaryCredentials({ KOINOS_NOTARY_PROFILE: "koinos" });
  const { run, calls } = fakeRun({ "xcrun notarytool submit": { stdout: '{"id":"sub-1","status":"Accepted"}' } });
  n.notarizeApp("/o/Koinos Router.app", creds, { run, log: () => {} });
  assert.deepStrictEqual(calls.map((c) => c.slice(0, 3).join(" ")), [
    "/usr/bin/ditto -c -k",
    "xcrun notarytool submit",
    "xcrun stapler staple",
    "xcrun stapler validate",
  ]);
  const zip = calls[0].at(-1);
  assert.strictEqual(calls[1][3], zip, "the zip ditto made is what gets submitted");
  assert.ok(zip.startsWith(os.tmpdir()) && zip.endsWith("Koinos Router.zip"));
  assert.ok(!fs.existsSync(zip), "the temp zip is removed");
  assert.deepStrictEqual(calls[2].slice(1), ["stapler", "staple", "/o/Koinos Router.app"]);
});

test("a rejected submission fails the build with Apple's log and staples nothing", () => {
  const creds = n.notaryCredentials({ KOINOS_NOTARY_PROFILE: "koinos" });
  const { run, calls } = fakeRun({
    "xcrun notarytool submit": { stdout: '{"id":"sub-2","status":"Invalid","message":"Processing complete"}' },
    "xcrun notarytool log": { stdout: '{"issues":[{"message":"The binary is not signed with a valid Developer ID certificate."}]}' },
  });
  assert.throws(() => n.notarizeDmg("/o/x.dmg", DEV_ID, creds, { run, log: () => {} }), /notarization of x\.dmg was Invalid: Processing complete\n.*valid Developer ID/s);
  assert.deepStrictEqual(calls.map((c) => c.slice(0, 3).join(" ")), ["/usr/bin/codesign --sign " + DEV_ID.hash, "xcrun notarytool submit", "xcrun notarytool log"]);
  assert.ok(!calls.some((c) => c.includes("staple")));
});

test("spctl must say accepted from a notarized Developer ID", () => {
  const ok = fakeRun({ "spctl --assess --type": { stderr: "/o/x.dmg: accepted\nsource=Notarized Developer ID\n" } });
  assert.match(n.assess("/o/x.dmg", { run: ok.run, log: () => {} }), /Notarized Developer ID/);
  const rejected = fakeRun({ "spctl --assess --type": { status: 3, stderr: "/o/K.app: rejected\n" } });
  assert.throws(() => n.assess("/o/K.app", { run: rejected.run, log: () => {} }), /spctl did not accept K\.app/);
});
