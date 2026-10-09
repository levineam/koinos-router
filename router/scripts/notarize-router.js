"use strict";

/*
 * Notarization for Koinos Router builds, used by dist-router.js.
 *
 * Only a build signed with a "Developer ID Application" identity can be
 * notarized, and only with notary credentials, one of (first complete set
 * wins):
 *   1. APPLE_API_KEY (path to the AuthKey_….p8 file) + APPLE_API_KEY_ID +
 *      APPLE_API_ISSUER — an App Store Connect API key,
 *   2. APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID,
 *   3. KOINOS_NOTARY_PROFILE — a profile saved with
 *      `xcrun notarytool store-credentials` (KOINOS_NOTARY_KEYCHAIN names a
 *      keychain file other than the default).
 * (The same variable names electron-builder uses.) Anything else builds as
 * before and dist-router prints one line saying why it is not notarized.
 *
 * What a notarized build does, per architecture:
 *   app  → ditto zip → notarytool submit --wait → stapler staple the .app
 *   dmg and zip are then built from the stapled app (so the zip carries the
 *   ticket), the dmg is signed with the same Developer ID,
 *   dmg  → notarytool submit --wait → stapler staple the .dmg
 *   then spctl assesses the app (execute) and the dmg (open), and both must
 *   be "accepted … source=Notarized Developer ID".
 *
 * Everything that decides or builds arguments is pure and exported for
 * router/test/release-notarize.test.js; the runner takes an injectable `run`.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const DEVELOPER_ID = "Developer ID Application:";

function isDeveloperId(identity) {
  return !!(identity && identity.hash && identity.hash !== "-" && String(identity.name || "").startsWith(DEVELOPER_ID));
}

const SETS = [
  { kind: "api-key", vars: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"] },
  { kind: "apple-id", vars: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"] },
  { kind: "keychain-profile", vars: ["KOINOS_NOTARY_PROFILE"] },
];

const HOW = "set APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or KOINOS_NOTARY_PROFILE";

/**
 * Notary credentials from the environment.
 * → { kind, args, display } | { error } | null (none set at all)
 *   args: notarytool authentication arguments; display: the same with
 *   secrets replaced, for logs.
 */
function notaryCredentials(env = process.env, { exists = fs.existsSync } = {}) {
  const val = (k) => String(env[k] || "").trim();
  const partial = [];
  for (const set of SETS) {
    const have = set.vars.filter((k) => val(k));
    if (have.length === set.vars.length) {
      if (set.kind === "api-key") {
        const key = val("APPLE_API_KEY");
        if (!exists(key)) return { error: `APPLE_API_KEY must be the path to the .p8 key file, and "${key}" does not exist` };
        const args = ["--key", key, "--key-id", val("APPLE_API_KEY_ID"), "--issuer", val("APPLE_API_ISSUER")];
        return { kind: set.kind, args, display: args };
      }
      if (set.kind === "apple-id") {
        const args = ["--apple-id", val("APPLE_ID"), "--password", val("APPLE_APP_SPECIFIC_PASSWORD"), "--team-id", val("APPLE_TEAM_ID")];
        return { kind: set.kind, args, display: args.map((a, i) => (args[i - 1] === "--password" ? "<redacted>" : a)) };
      }
      const keychain = val("KOINOS_NOTARY_KEYCHAIN");
      const args = ["--keychain-profile", val("KOINOS_NOTARY_PROFILE"), ...(keychain ? ["--keychain", keychain] : [])];
      return { kind: set.kind, args, display: args };
    }
    if (have.length) partial.push(`${have.join(" + ")} set but ${set.vars.filter((k) => !val(k)).join(" + ")} missing`);
  }
  return partial.length ? { error: `incomplete notary credentials (${partial.join("; ")})` } : null;
}

/**
 * Whether this build gets notarized.
 * → { notarize: true, creds } | { notarize: false, reason }
 */
function decide({ identity, env = process.env, exists = fs.existsSync } = {}) {
  if (!identity || identity.hash === "-" || identity.kind === "adhoc") {
    return { notarize: false, reason: "it is signed ad-hoc, and only a Developer ID Application identity can be notarized" };
  }
  if (!isDeveloperId(identity)) {
    return { notarize: false, reason: `it is signed with "${identity.name}", and only a Developer ID Application identity can be notarized` };
  }
  const creds = notaryCredentials(env, { exists });
  if (!creds) return { notarize: false, reason: `no notary credentials (${HOW})` };
  if (creds.error) return { notarize: false, reason: creds.error };
  return { notarize: true, creds };
}

/** The one line dist-router prints for a build that is not notarized. */
function notNotarizedLine(reason) {
  return (
    `[dist-router] Not notarized: ${reason}. ` +
    "On other Macs the first open is blocked until the user clicks Open Anyway in System Settings › Privacy & Security."
  );
}

// ------------------------------------------------------------ arguments

/** xcrun arguments. Each returns the argv after "xcrun". */
const xcrun = {
  submit: (file, creds) => ["notarytool", "submit", file, ...creds.args, "--wait", "--timeout", "2h", "--output-format", "json", "--no-progress"],
  log: (id, creds) => ["notarytool", "log", id, ...creds.args],
  staple: (file) => ["stapler", "staple", file],
  validate: (file) => ["stapler", "validate", file],
};

/** ditto arguments that zip an app for notarytool (keeps the bundle intact). */
function dittoZipArgs(app, zip) {
  return ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip];
}

/** codesign arguments for signing the dmg itself. */
function codesignDmgArgs(dmg, identity, { keychain = "" } = {}) {
  return ["--sign", identity.hash, "--timestamp", ...(keychain ? ["--keychain", keychain] : []), dmg];
}

/** spctl arguments: an app is assessed for execute, a dmg for open. */
function spctlArgs(file) {
  if (file.endsWith(".dmg")) return ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", file];
  return ["--assess", "--type", "execute", "-vv", file];
}

/** notarytool's JSON answer → { id, status }; throws unless Accepted. */
function parseSubmitResult(stdout) {
  let body = null;
  try {
    body = JSON.parse(String(stdout || "").trim().split("\n").filter((l) => l.startsWith("{")).pop() || "");
  } catch {
    body = null;
  }
  if (!body || !body.status) throw new Error(`notarytool gave no result: ${String(stdout || "").slice(0, 400)}`);
  return { id: body.id || null, status: body.status, message: body.message || "" };
}

/** spctl prints its verdict on stderr: accepted and from a notarized Developer ID. */
function spctlAccepted(output) {
  const text = String(output || "");
  return /: accepted\b/.test(text) && /source=Notarized Developer ID/.test(text);
}

// --------------------------------------------------------------- runner

function defaultRun(cmd, args, { capture = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error };
}

function must(r, what) {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim().slice(0, 800)}`);
  return r;
}

/** Submit one file, wait, and throw (with the notary log) unless Accepted. */
function submit(file, creds, { run = defaultRun, log = console.log } = {}) {
  log(`[notarize] submitting ${path.basename(file)} (${creds.kind}); this can take a few minutes`);
  const r = run("xcrun", xcrun.submit(file, creds), { capture: true });
  if (r.error) throw new Error(`notarytool: ${r.error.message}`);
  const res = parseSubmitResult(r.stdout);
  if (res.status !== "Accepted") {
    let detail = "";
    if (res.id) {
      const l = run("xcrun", xcrun.log(res.id, creds), { capture: true });
      detail = `\n${(l.stdout || l.stderr || "").trim().slice(0, 4000)}`;
    }
    throw new Error(`notarization of ${path.basename(file)} was ${res.status}${res.message ? `: ${res.message}` : ""}${detail}`);
  }
  log(`[notarize] ${path.basename(file)} accepted (${res.id})`);
  return res;
}

function staple(file, { run = defaultRun, log = console.log } = {}) {
  must(run("xcrun", xcrun.staple(file), { capture: true }), `stapler staple ${path.basename(file)}`);
  must(run("xcrun", xcrun.validate(file), { capture: true }), `stapler validate ${path.basename(file)}`);
  log(`[notarize] stapled ${path.basename(file)}`);
}

function assess(file, { run = defaultRun, log = console.log } = {}) {
  const r = run("/usr/sbin/spctl", spctlArgs(file), { capture: true });
  const out = `${r.stdout}${r.stderr}`.trim();
  if (r.status !== 0 || !spctlAccepted(out)) throw new Error(`spctl did not accept ${path.basename(file)}:\n${out}`);
  log(`[notarize] spctl: ${out.split("\n").join(" | ")}`);
  return out;
}

/** Notarize and staple a signed .app (before the dmg and zip are built from it). */
function notarizeApp(app, creds, opts = {}) {
  const run = opts.run || defaultRun;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "koinos-router-notarize-"));
  try {
    const zip = path.join(tmp, `${path.basename(app, ".app")}.zip`);
    must(run("/usr/bin/ditto", dittoZipArgs(app, zip), { capture: true }), "ditto");
    submit(zip, creds, opts);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  staple(app, opts);
}

/** Sign, notarize and staple a dmg built from a notarized app. */
function notarizeDmg(dmg, identity, creds, opts = {}) {
  const run = opts.run || defaultRun;
  must(run("/usr/bin/codesign", codesignDmgArgs(dmg, identity, { keychain: opts.keychain || "" }), { capture: true }), "codesign dmg");
  submit(dmg, creds, opts);
  staple(dmg, opts);
}

module.exports = {
  isDeveloperId,
  notaryCredentials,
  decide,
  notNotarizedLine,
  xcrun,
  dittoZipArgs,
  codesignDmgArgs,
  spctlArgs,
  parseSubmitResult,
  spctlAccepted,
  submit,
  staple,
  assess,
  notarizeApp,
  notarizeDmg,
  HOW,
};
