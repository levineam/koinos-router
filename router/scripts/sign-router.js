#!/usr/bin/env node
"use strict";

/*
 * Sign a built "Koinos Router.app" with a stable identity, so that a rebuild
 * is the same app to macOS and the Keychain's "Always Allow" for "Koinos
 * Router Safe Storage" keeps working (see router/lib/keychain-access.js).
 *
 *   node router/scripts/sign-router.js "dist-router/mac-arm64/Koinos Router.app"
 *
 * Which identity (first match wins):
 *   1. KOINOS_ROUTER_SIGN_IDENTITY: a name or SHA-1 hash; "-" forces ad-hoc.
 *   2. a valid "Developer ID Application: …" identity,
 *   3. a valid "Apple Development: …" (or "Mac Developer: …") identity — free
 *      with an Apple ID in Xcode; like Developer ID it carries a team ID,
 *      which is what keeps the Keychain from asking again after a rebuild,
 *   4. "Koinos Router Local", the self-signed identity that
 *      router/scripts/setup-dev-signing.sh makes. macOS calls it "not
 *      trusted"; codesign uses it all the same. It keeps the designated
 *      requirement the same across builds, but it has no team ID.
 *   5. none: the app keeps electron-builder's ad-hoc signature.
 * KOINOS_ROUTER_SIGN_KEYCHAIN limits the search (and signing) to one keychain
 * file.
 *
 * Signing is @electron/osx-sign (what electron-builder uses), inside-out, with
 * the hardened runtime and build/entitlements.mac(.inherit).plist, and with
 * identity validation off so a self-signed identity is accepted. It changes
 * signatures only: the Electron fuses and the asar integrity hash that
 * electron-builder wrote stay as they are.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const LOCAL_IDENTITY = "Koinos Router Local";
const APP_ID = "io.koinosai.router";
const ENTITLEMENTS = path.join(ROOT, "build", "entitlements.mac.plist");
const ENTITLEMENTS_INHERIT = path.join(ROOT, "build", "entitlements.mac.inherit.plist");
// Apple-issued identities (these carry a team ID).
const APPLE_PREFIXES = ["Developer ID Application:", "Apple Development:", "Mac Developer:"];

/**
 * Parse `security find-identity -p codesigning` output into
 * [{ hash, name, status }] (status null = valid), one entry per hash.
 */
function parseIdentities(output) {
  const byHash = new Map();
  for (const line of String(output || "").split("\n")) {
    const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.*)"(?:\s+\(([^()]*)\))?\s*$/.exec(line);
    if (!m) continue;
    const [, hash, name, status = null] = m;
    const prev = byHash.get(hash);
    // The same identity can be listed twice (matching, then valid only).
    if (!prev || (prev.status && !status)) byHash.set(hash, { hash, name, status });
  }
  return [...byHash.values()];
}

/**
 * The identity to sign with, from parsed identities.
 * → { identity: { hash, name, status, kind } | null, reason: string }
 *   kind: "explicit" | "developer-id" | "apple-development" | "local"
 * Throws when an explicitly requested identity is missing.
 */
function pickIdentity(identities, { explicit = "" } = {}) {
  const list = Array.isArray(identities) ? identities : [];
  const want = String(explicit || "").trim();
  if (want === "-") return { identity: null, reason: "KOINOS_ROUTER_SIGN_IDENTITY=- asks for ad-hoc signing" };
  if (want) {
    const hit = list.find((i) => i.hash === want.toUpperCase()) || list.find((i) => i.name === want) || list.find((i) => i.name.includes(want));
    if (!hit) throw new Error(`No code-signing identity matches KOINOS_ROUTER_SIGN_IDENTITY="${want}".`);
    return { identity: { ...hit, kind: "explicit" }, reason: "named by KOINOS_ROUTER_SIGN_IDENTITY" };
  }
  const valid = list.filter((i) => !i.status);
  const devId = valid.find((i) => i.name.startsWith("Developer ID Application:"));
  if (devId) return { identity: { ...devId, kind: "developer-id" }, reason: "Developer ID identity found" };
  const dev = valid.find((i) => i.name.startsWith("Apple Development:") || i.name.startsWith("Mac Developer:"));
  if (dev) return { identity: { ...dev, kind: "apple-development" }, reason: "Apple Development identity found" };
  // Self-signed is never "valid"; untrusted is expected, expired or revoked is not.
  const local = list.find((i) => i.name === LOCAL_IDENTITY && (!i.status || i.status === "CSSMERR_TP_NOT_TRUSTED"));
  if (local) return { identity: { ...local, kind: "local" }, reason: `"${LOCAL_IDENTITY}" found` };
  return { identity: null, reason: `no "${LOCAL_IDENTITY}" identity (run router/scripts/setup-dev-signing.sh once)` };
}

function findIdentities({ keychain = process.env.KOINOS_ROUTER_SIGN_KEYCHAIN || "" } = {}) {
  const args = ["find-identity", "-p", "codesigning", ...(keychain ? [keychain] : [])];
  try {
    return parseIdentities(execFileSync("/usr/bin/security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch {
    return [];
  }
}

/** Per-file options: the main app gets the app entitlements, everything inside it the inherited ones. */
function optionsForFile(appPath, { timestamp, entitlements = ENTITLEMENTS, entitlementsInherit = ENTITLEMENTS_INHERIT } = {}) {
  return (filePath) => ({
    entitlements: filePath === appPath ? entitlements : entitlementsInherit,
    hardenedRuntime: true,
    ...(timestamp ? { timestamp } : {}),
  });
}

const DISABLE_LIBRARY_VALIDATION = "com.apple.security.cs.disable-library-validation";

/**
 * The entitlements plist text with library validation turned off. The
 * hardened runtime only maps libraries signed by Apple or by the same team;
 * code signed with a self-signed certificate has no team, so without this
 * Router could not load its own Electron Framework ("different Team IDs").
 * The rest of the hardened runtime (no DYLD_* variables, no debugger
 * attach, …) stays on, which an ad-hoc build does not have at all.
 */
function withoutLibraryValidation(plistText) {
  const text = String(plistText);
  if (text.includes(DISABLE_LIBRARY_VALIDATION)) return text;
  const at = text.lastIndexOf("</dict>");
  if (at < 0) throw new Error("entitlements plist has no top-level <dict>");
  return `${text.slice(0, at)}  <key>${DISABLE_LIBRARY_VALIDATION}</key>\n  <true/>\n${text.slice(at)}`;
}

/** Entitlements for an identity without a team ID, written to a temp dir. */
function teamlessEntitlements(dir) {
  const out = { entitlements: path.join(dir, "entitlements.mac.plist"), entitlementsInherit: path.join(dir, "entitlements.mac.inherit.plist") };
  fs.writeFileSync(out.entitlements, withoutLibraryValidation(fs.readFileSync(ENTITLEMENTS, "utf8")));
  fs.writeFileSync(out.entitlementsInherit, withoutLibraryValidation(fs.readFileSync(ENTITLEMENTS_INHERIT, "utf8")));
  return out;
}

/** The DR line codesign prints for a bundle (null when it has none). */
function designatedRequirement(appPath) {
  try {
    const out = execFileSync("codesign", ["-d", "-r-", appPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const m = /^(?:#\s*)?designated\s*=>\s*(.+)$/m.exec(out);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

async function signRouterApp({ app, identity, keychain = process.env.KOINOS_ROUTER_SIGN_KEYCHAIN || "" }) {
  if (!app || !fs.existsSync(path.join(app, "Contents", "Info.plist"))) throw new Error(`Not an app bundle: ${app}`);
  if (!identity || !identity.hash) throw new Error("signRouterApp needs an identity");
  const { signApp } = require("@electron/osx-sign");
  // Apple-issued identities carry a team ID; anything else (self-signed)
  // needs library validation off, and gains nothing from Apple's timestamp
  // server (a local build should not need the network).
  const apple = APPLE_PREFIXES.some((p) => identity.name.startsWith(p));
  const tmp = apple ? null : fs.mkdtempSync(path.join(os.tmpdir(), "koinos-router-sign-"));
  try {
    const files = tmp ? teamlessEntitlements(tmp) : {};
    await signApp({
      app,
      identity: identity.hash,
      identityValidation: false,
      ...(keychain ? { keychain } : {}),
      platform: "darwin",
      type: "distribution",
      preAutoEntitlements: false,
      strictVerify: true,
      optionsForFile: optionsForFile(app, { ...files, timestamp: apple ? undefined : "none" }),
      // Never sign anything electron-builder would skip.
      ignore: (file) => file.endsWith(".kext") || file.startsWith(path.join(app, "Contents", "PlugIns")),
    });
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
  return designatedRequirement(app);
}

async function main(argv = process.argv.slice(2)) {
  const app = argv[0];
  if (!app) {
    console.error('usage: node router/scripts/sign-router.js "<path>/Koinos Router.app"');
    return 2;
  }
  const { identity, reason } = pickIdentity(findIdentities(), { explicit: process.env.KOINOS_ROUTER_SIGN_IDENTITY });
  if (!identity) {
    console.log(`[sign-router] not signing: ${reason}`);
    return 0;
  }
  console.log(`[sign-router] signing with "${identity.name}" (${identity.hash}): ${reason}`);
  const dr = await signRouterApp({ app: path.resolve(app), identity });
  console.log(`[sign-router] designated => ${dr}`);
  return 0;
}

module.exports = {
  parseIdentities,
  pickIdentity,
  findIdentities,
  optionsForFile,
  withoutLibraryValidation,
  designatedRequirement,
  signRouterApp,
  LOCAL_IDENTITY,
  APP_ID,
  ENTITLEMENTS,
  ENTITLEMENTS_INHERIT,
};

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`[sign-router] ${e.message}`);
      process.exit(1);
    },
  );
}
