#!/usr/bin/env node
"use strict";

/*
 * `npm run dist:router`: package Koinos Router as Koinos-Router-<version>-<arch>.dmg
 * and .zip in dist-router/, signed with the identity router/scripts/sign-router.js
 * picks, and notarized when that is possible (router/scripts/notarize-router.js).
 *
 * Router has its own version, ROUTER_VERSION below. It reaches the app as
 * extraMetadata.version (Info.plist CFBundleShortVersionString, app.getVersion(),
 * the package.json inside app.asar) and the artifact names; the repo's
 * package.json version stays Core's.
 *
 * Per architecture (KOINOS_ROUTER_ARCHS, comma-separated: arm64 (default), x64)
 * it writes a copy of router/electron-builder.yml with that version and only
 * that architecture's targets, then, with a signing identity:
 *   1. electron-builder --dir with signing off: packs the app and flips the
 *      Electron fuses (leaving their ad-hoc signature),
 *   2. sign-router.js re-signs it inside-out with that identity (also for
 *      KOINOS_ROUTER_SIGN_IDENTITY=-: ad-hoc, but with the hardened runtime and
 *      Router's entitlements),
 *   3. a Developer ID build with notary credentials is notarized and stapled,
 *   4. electron-builder --prepackaged builds the dmg and zip from that app
 *      (skipped when --dir was asked for),
 *   5. a notarized build's dmg is signed, notarized and stapled too, and
 *      spctl must accept the app and the dmg.
 * With no identity at all it is a plain ad-hoc electron-builder build, plus a
 * note on how to get one. Either way the built app's Info.plist must carry
 * ROUTER_VERSION, and a build that is not notarized says so, and why, in one line.
 *
 * Extra arguments go to electron-builder (e.g. --dir); pick architectures
 * with KOINOS_ROUTER_ARCHS, not --x64/--arm64. KOINOS_ROUTER_DIST_OUT builds
 * into another directory instead of dist-router/.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");
const sign = require("./sign-router");
const notarize = require("./notarize-router");

const ROOT = path.join(__dirname, "..", "..");
const CONFIG = "router/electron-builder.yml";
const PRODUCT = "Koinos Router";
/** Koinos Router's own version (not Core's: package.json keeps that). */
const ROUTER_VERSION = "0.1.0";
const SUPPORTED_ARCHS = ["arm64", "x64"];
const DEFAULT_ARCHS = ["arm64"];
const ARCH_FLAGS = ["--arm64", "--x64", "--universal", "--ia32", "--armv7l"];

function builder(args) {
  const cli = require.resolve("electron-builder/cli.js", { paths: [ROOT] });
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: ROOT, stdio: "inherit", env: process.env });
  if (r.status !== 0) throw new Error(`electron-builder exited with ${r.status ?? r.signal}`);
}

/** KOINOS_ROUTER_ARCHS → ["arm64", …] in build order. Throws on anything unsupported. */
function parseArchs(value) {
  const list = String(value || "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return [...DEFAULT_ARCHS];
  const bad = list.filter((a) => !SUPPORTED_ARCHS.includes(a));
  if (bad.length) throw new Error(`KOINOS_ROUTER_ARCHS: unsupported ${bad.join(", ")} (use ${SUPPORTED_ARCHS.join(", ")})`);
  return SUPPORTED_ARCHS.filter((a) => list.includes(a));
}

/** electron-builder's app directory for an architecture (x64 is its default arch). */
function appDirName(arch) {
  return arch === "x64" ? "mac" : `mac-${arch}`;
}

function artifactNames(arch, version = ROUTER_VERSION) {
  return { dmg: `Koinos-Router-${version}-${arch}.dmg`, zip: `Koinos-Router-${version}-${arch}.zip` };
}

function loadBaseConfig() {
  const yaml = require("js-yaml");
  return yaml.load(fs.readFileSync(path.join(ROOT, CONFIG), "utf8"));
}

/**
 * The electron-builder config for one architecture: the checked-in config
 * plus Router's version, that architecture's targets only, and (when
 * dist-router signs itself) electron-builder's own signing off.
 */
function effectiveConfig(base, { arch, out = "", signOff = false, version = ROUTER_VERSION }) {
  const config = JSON.parse(JSON.stringify(base));
  config.extraMetadata = { ...config.extraMetadata, version };
  config.mac = {
    ...config.mac,
    target: (config.mac.target || []).map((t) => ({ ...(typeof t === "string" ? { target: t } : t), arch: [arch] })),
    notarize: false,
  };
  if (signOff) config.mac.identity = null;
  if (out) config.directories = { ...config.directories, output: out };
  return config;
}

/**
 * The build for each architecture. Pure, for the tests.
 *   signed: dist-router signs (an identity was picked, ad-hoc included);
 *   configPath(arch): where that architecture's config file goes.
 * → { version, dirOnly, outDir, builds: [{ arch, app, dmg, zip, config, configPath, steps }] }
 *   steps: electron-builder argument lists; with signed, steps[0] packs and
 *   steps[1] (absent with --dir) builds the dmg and zip from the signed app.
 */
function plan({ args = [], out = "", signed, archs = DEFAULT_ARCHS, base = loadBaseConfig(), configPath, version = ROUTER_VERSION }) {
  const archFlag = args.find((a) => ARCH_FLAGS.includes(a));
  if (archFlag) throw new Error(`${archFlag}: choose architectures with KOINOS_ROUTER_ARCHS (e.g. KOINOS_ROUTER_ARCHS=arm64,x64)`);
  const dirOnly = args.includes("--dir");
  const extra = args.filter((a) => a !== "--dir");
  const outDir = out || path.join(ROOT, base.directories?.output || "dist-router");
  const pathFor = configPath || ((arch) => path.join(os.tmpdir(), `koinos-router-builder-${arch}.json`));
  const builds = archs.map((arch) => {
    const cfg = pathFor(arch);
    const app = path.join(outDir, appDirName(arch), `${PRODUCT}.app`);
    const names = artifactNames(arch, version);
    const head = ["--config", cfg, "--mac", `--${arch}`];
    const steps = signed ? [[...head, "--dir", ...extra], ...(dirOnly ? [] : [[...head, "--prepackaged", app, ...extra]])] : [[...head, ...args]];
    return {
      arch,
      app,
      dmg: path.join(outDir, names.dmg),
      zip: path.join(outDir, names.zip),
      config: effectiveConfig(base, { arch, out, signOff: signed, version }),
      configPath: cfg,
      steps,
    };
  });
  return { version, dirOnly, outDir, builds };
}

/** CFBundleShortVersionString of a built app. */
function bundleVersion(app) {
  return execFileSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(app, "Contents", "Info.plist")], {
    encoding: "utf8",
  }).trim();
}

function checkVersion(app, version) {
  const got = bundleVersion(app);
  if (got !== version) throw new Error(`${app} has CFBundleShortVersionString ${got}, expected ${version}`);
  console.log(`[dist-router] ${path.basename(path.dirname(app))}/${PRODUCT}.app is version ${got}`);
}

function sizeOf(file) {
  try {
    return `${(fs.statSync(file).size / 1e6).toFixed(1)} MB`;
  } catch {
    return "missing";
  }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const out = env.KOINOS_ROUTER_DIST_OUT ? path.resolve(env.KOINOS_ROUTER_DIST_OUT) : "";
  const archs = parseArchs(env.KOINOS_ROUTER_ARCHS);
  const { identity, reason } = sign.pickIdentity(sign.findIdentities(), { explicit: env.KOINOS_ROUTER_SIGN_IDENTITY });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "koinos-router-dist-"));
  try {
    const p = plan({ args: argv, out, signed: !!identity, archs, configPath: (arch) => path.join(tmp, `electron-builder.${arch}.json`) });
    for (const b of p.builds) fs.writeFileSync(b.configPath, JSON.stringify(b.config, null, 2));
    const decision = identity ? notarize.decide({ identity, env }) : { notarize: false, reason: "it is signed ad-hoc (no signing identity found)" };
    console.log(`[dist-router] Koinos Router ${p.version} (Core ${require(path.join(ROOT, "package.json")).version}) for ${archs.join(", ")}`);

    if (!identity) {
      for (const b of p.builds) {
        builder(b.steps[0]);
        checkVersion(b.app, p.version);
      }
      console.log(
        `\n[dist-router] Signed ad-hoc: ${reason}.\n` +
          "  macOS treats every ad-hoc build as a new app, so the Keychain asks about\n" +
          '  "Koinos Router Safe Storage" again after each rebuild. To keep one identity:\n' +
          "    bash router/scripts/setup-dev-signing.sh   (once)\n" +
          "    npm run dist:router\n",
      );
    } else {
      console.log(`[dist-router] Will sign with "${identity.name}" (${identity.hash}): ${reason}.`);
      for (const b of p.builds) {
        builder(b.steps[0]);
        const dr = await sign.signRouterApp({ app: b.app, identity });
        console.log(`[dist-router] Signed ${b.app}\n[dist-router] designated => ${dr}`);
        checkVersion(b.app, p.version);
        if (decision.notarize) notarize.notarizeApp(b.app, decision.creds);
        for (const step of b.steps.slice(1)) builder(step);
        if (decision.notarize && !p.dirOnly) {
          notarize.notarizeDmg(b.dmg, identity, decision.creds, { keychain: env.KOINOS_ROUTER_SIGN_KEYCHAIN || "" });
          notarize.assess(b.app);
          notarize.assess(b.dmg);
        }
      }
      if (identity.kind === "local") {
        console.log(
          "[dist-router] Self-signed: the identity stays the same across builds, but it has no Apple team ID,\n" +
            "  so macOS may still ask once after a rebuild. An Apple Development certificate (free, Xcode ›\n" +
            "  Settings › Accounts › Manage Certificates) has a team ID and is picked automatically when present.",
        );
      }
      if (/^(Apple Development|Mac Developer):/.test(identity.name)) {
        console.log(
          "[dist-router] This build carries your Apple Development certificate (and its Apple ID email): it is for\n" +
            "  your own Macs only. Build anything you give to other people with KOINOS_ROUTER_SIGN_IDENTITY=-.",
        );
      }
    }

    if (decision.notarize) console.log("[dist-router] Notarized and stapled: Gatekeeper opens it without Open Anyway.");
    else console.log(notarize.notNotarizedLine(decision.reason));
    if (!p.dirOnly) {
      for (const b of p.builds) for (const f of [b.dmg, b.zip]) console.log(`[dist-router]   ${f} (${sizeOf(f)})`);
      console.log("[dist-router] Checksums and the release command: npm run release:router:assets");
    }
    return 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { plan, parseArchs, effectiveConfig, appDirName, artifactNames, bundleVersion, CONFIG, ROUTER_VERSION, SUPPORTED_ARCHS, PRODUCT };

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`[dist-router] ${e.message}`);
      process.exit(1);
    },
  );
}
