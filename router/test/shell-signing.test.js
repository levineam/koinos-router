"use strict";

/*
 * Local signing for Koinos Router builds (router/scripts/sign-router.js,
 * dist-router.js, setup-dev-signing.sh). Pure parts only: nothing here
 * touches a keychain or runs codesign or electron-builder.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const yaml = require("js-yaml");

const ROOT = path.join(__dirname, "..", "..");
const sign = require("../scripts/sign-router");
const dist = require("../scripts/dist-router");
const SETUP = path.join(ROOT, "router", "scripts", "setup-dev-signing.sh");

const FIND_IDENTITY = `
Policy: Code Signing
  Matching identities
  1) 1111111111111111111111111111111111111111 "Some Other Cert" (CSSMERR_TP_NOT_TRUSTED)
  2) 2B8AB81C5743B9FAEA7C09BE6812471BDE65E5AF "Koinos Router Local" (CSSMERR_TP_NOT_TRUSTED)
  3) 3333333333333333333333333333333333333333 "Apple Development: Jane Doe (ABCDE12345)"
  4) 4444444444444444444444444444444444444444 "Developer ID Application: Old Co (ZZZZZ99999)" (CSSMERR_TP_CERT_EXPIRED)
     4 identities found

  Valid identities only
  1) 3333333333333333333333333333333333333333 "Apple Development: Jane Doe (ABCDE12345)"
     1 valid identities found
`;

test("find-identity output parses into one entry per identity, with its status", () => {
  const ids = sign.parseIdentities(FIND_IDENTITY);
  assert.deepStrictEqual(
    ids.map((i) => [i.hash.slice(0, 4), i.name, i.status]),
    [
      ["1111", "Some Other Cert", "CSSMERR_TP_NOT_TRUSTED"],
      ["2B8A", "Koinos Router Local", "CSSMERR_TP_NOT_TRUSTED"],
      ["3333", "Apple Development: Jane Doe (ABCDE12345)", null],
      ["4444", "Developer ID Application: Old Co (ZZZZZ99999)", "CSSMERR_TP_CERT_EXPIRED"],
    ],
  );
  assert.deepStrictEqual(sign.parseIdentities(""), []);
  assert.deepStrictEqual(sign.parseIdentities("     0 identities found\n"), []);
});

test("identity preference: explicit, Developer ID, Apple Development, Koinos Router Local, ad-hoc", () => {
  const ids = sign.parseIdentities(FIND_IDENTITY);
  // An expired Developer ID is skipped; a valid Apple Development wins (it has a team ID).
  assert.strictEqual(sign.pickIdentity(ids).identity.kind, "apple-development");
  const devId = { hash: "5".repeat(40), name: "Developer ID Application: Koinos (ABCDE12345)", status: null };
  assert.strictEqual(sign.pickIdentity([...ids, devId]).identity.hash, devId.hash);
  // Only the self-signed one: picked although macOS calls it untrusted.
  const local = sign.pickIdentity(ids.filter((i) => !i.name.startsWith("Apple Development")));
  assert.strictEqual(local.identity.name, "Koinos Router Local");
  assert.strictEqual(local.identity.kind, "local");
  // An expired self-signed one is not.
  const expired = [{ hash: "6".repeat(40), name: "Koinos Router Local", status: "CSSMERR_TP_CERT_EXPIRED" }];
  assert.strictEqual(sign.pickIdentity(expired).identity, null);
  // Nothing usable: ad-hoc, and the reason says how to fix it.
  const none = sign.pickIdentity([]);
  assert.strictEqual(none.identity, null);
  assert.match(none.reason, /setup-dev-signing\.sh/);
  // Explicit choices.
  assert.strictEqual(sign.pickIdentity(ids, { explicit: "-" }).identity, null);
  assert.strictEqual(sign.pickIdentity(ids, { explicit: "2b8ab81c5743b9faea7c09be6812471bde65e5af" }).identity.name, "Koinos Router Local");
  assert.strictEqual(sign.pickIdentity(ids, { explicit: "Some Other Cert" }).identity.kind, "explicit");
  assert.throws(() => sign.pickIdentity(ids, { explicit: "Nope" }), /No code-signing identity matches/);
});

test("a team-less identity signs with library validation off, everything else hardened as configured", () => {
  const base = fs.readFileSync(sign.ENTITLEMENTS, "utf8");
  const out = sign.withoutLibraryValidation(base);
  assert.match(out, /<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\/>\s*<\/dict>\s*<\/plist>\s*$/);
  for (const key of base.match(/<key>[^<]+<\/key>/g)) assert.ok(out.includes(key), `${key} kept`);
  assert.strictEqual(sign.withoutLibraryValidation(out), out, "idempotent");
  assert.throws(() => sign.withoutLibraryValidation("<plist/>"), /<dict>/);
  // The checked-in entitlements stay as they were: only the self-signed path adds it.
  assert.doesNotMatch(base, /disable-library-validation/);
  assert.doesNotMatch(fs.readFileSync(sign.ENTITLEMENTS_INHERIT, "utf8"), /disable-library-validation/);

  const app = "/x/Koinos Router.app";
  const opts = sign.optionsForFile(app, { timestamp: "none" });
  assert.deepStrictEqual(opts(app), { entitlements: sign.ENTITLEMENTS, hardenedRuntime: true, timestamp: "none" });
  assert.deepStrictEqual(opts(`${app}/Contents/Frameworks/Koinos Router Helper.app`), {
    entitlements: sign.ENTITLEMENTS_INHERIT,
    hardenedRuntime: true,
    timestamp: "none",
  });
  assert.deepStrictEqual(sign.optionsForFile(app)(app), { entitlements: sign.ENTITLEMENTS, hardenedRuntime: true });
});

test("dist:router packs unsigned, signs, then builds dmg and zip from the signed app", () => {
  const signed = dist.plan({ args: [], out: "/tmp/out", signed: true });
  assert.strictEqual(signed.app, "/tmp/out/mac-arm64/Koinos Router.app");
  assert.deepStrictEqual(signed.steps, [
    ["--config", dist.CONFIG, "--mac", "--arm64", "-c.directories.output=/tmp/out", "--dir", "-c.mac.identity=null"],
    ["--config", dist.CONFIG, "--mac", "--arm64", "-c.directories.output=/tmp/out", "--prepackaged", signed.app, "-c.mac.identity=null"],
  ]);
  // --dir: no dmg/zip step.
  assert.strictEqual(dist.plan({ args: ["--dir"], signed: true }).steps.length, 1);
  assert.strictEqual(dist.plan({ args: [], signed: true }).app, path.join(ROOT, "dist-router", "mac-arm64", "Koinos Router.app"));
  // No identity: exactly the old command.
  assert.deepStrictEqual(dist.plan({ args: [], signed: false }).steps, [["--config", dist.CONFIG, "--mac", "--arm64"]]);
  // KOINOS_ROUTER_SIGN_IDENTITY=-: electron-builder must not pick a Developer ID by itself.
  assert.deepStrictEqual(dist.plan({ args: ["--dir"], signed: false, adhoc: true }).steps, [["--config", dist.CONFIG, "--mac", "--arm64", "-c.mac.identity=null", "--dir"]]);
  // The config dist:router builds is the one shell.test.js checks.
  const builder = yaml.load(fs.readFileSync(path.join(ROOT, dist.CONFIG), "utf8"));
  assert.strictEqual(builder.appId, sign.APP_ID);
  assert.strictEqual(builder.mac.entitlements, path.relative(ROOT, sign.ENTITLEMENTS));
  assert.strictEqual(builder.mac.entitlementsInherit, path.relative(ROOT, sign.ENTITLEMENTS_INHERIT));
  assert.ok(builder.files.includes("!router/scripts/**"), "build helpers never ship inside the app");
});

test("setup-dev-signing.sh is valid bash, idempotent, and touches only its own key", () => {
  execFileSync("bash", ["-n", SETUP]);
  const src = fs.readFileSync(SETUP, "utf8");
  assert.ok(fs.statSync(SETUP).mode & 0o100, "executable");
  assert.match(src, /^set -euo pipefail$/m);
  assert.match(src, /NAME="\$\{KOINOS_SIGN_IDENTITY:-Koinos Router Local\}"/);
  // Idempotent: an existing identity ends the script before anything is made.
  assert.ok(src.indexOf('Already set up') < src.indexOf('"$OPENSSL" req'));
  // Only codesign may use the key; never "any application".
  assert.match(src, /security import .* -T \/usr\/bin\/codesign/);
  assert.doesNotMatch(src, /security import[^\n]* -A\b/);
  // The partition list is only ever set on the key labelled with our name.
  const commands = src.split("\n").filter((l) => /^\s*security set-key-partition-list/.test(l));
  assert.strictEqual(commands.length, 2);
  for (const line of commands) {
    assert.match(line, /-t private -l "\$NAME"/, line);
  }
  // No trust settings, no search-list or default-keychain changes.
  assert.doesNotMatch(src, /add-trusted-cert|list-keychains|default-keychain|delete-keychain/);
  assert.match(src, /trap cleanup EXIT/, "the temporary key material is removed");
});
