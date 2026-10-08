#!/usr/bin/env node
"use strict";

/*
 * `npm run dist:router`: package Koinos Router, signed with a stable identity
 * when there is one (router/scripts/sign-router.js picks it).
 *
 * electron-builder only signs with identities macOS calls valid, and a
 * self-signed one never is. So with an identity:
 *   1. electron-builder --dir with signing off: packs the app and flips the
 *      Electron fuses (leaving its ad-hoc signature),
 *   2. sign-router.js re-signs it inside-out with that identity,
 *   3. electron-builder --prepackaged builds the dmg and zip from the signed
 *      app (skipped when --dir was asked for).
 * With none, it is today's ad-hoc build, plus a note on how to get one.
 *
 * Extra arguments go to electron-builder (e.g. --dir). KOINOS_ROUTER_DIST_OUT
 * builds into another directory instead of dist-router/.
 */

const path = require("path");
const { spawnSync } = require("child_process");
const sign = require("./sign-router");

const ROOT = path.join(__dirname, "..", "..");
const CONFIG = "router/electron-builder.yml";
const PRODUCT = "Koinos Router";

function builder(args) {
  const cli = require.resolve("electron-builder/cli.js", { paths: [ROOT] });
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: ROOT, stdio: "inherit", env: process.env });
  if (r.status !== 0) throw new Error(`electron-builder exited with ${r.status ?? r.signal}`);
}

/**
 * electron-builder arguments for each step. Pure, for the tests.
 * adhoc: ad-hoc was asked for (KOINOS_ROUTER_SIGN_IDENTITY=-), so
 * electron-builder must not go looking for a Developer ID of its own.
 */
function plan({ args = [], out = "", signed, adhoc = false }) {
  const extra = args.filter((a) => a !== "--dir");
  const dirOnly = args.includes("--dir");
  const base = ["--config", CONFIG, "--mac", "--arm64", ...(out ? [`-c.directories.output=${out}`] : [])];
  const outDir = out || path.join(ROOT, "dist-router");
  const app = path.join(outDir, "mac-arm64", `${PRODUCT}.app`);
  if (!signed) return { steps: [[...base, ...(adhoc ? ["-c.mac.identity=null"] : []), ...args]], app, dirOnly };
  const steps = [[...base, "--dir", "-c.mac.identity=null", ...extra]];
  if (!dirOnly) steps.push([...base, "--prepackaged", app, "-c.mac.identity=null", ...extra]);
  return { steps, app, dirOnly };
}

async function main(argv = process.argv.slice(2)) {
  const out = process.env.KOINOS_ROUTER_DIST_OUT ? path.resolve(process.env.KOINOS_ROUTER_DIST_OUT) : "";
  const { identity, reason } = sign.pickIdentity(sign.findIdentities(), { explicit: process.env.KOINOS_ROUTER_SIGN_IDENTITY });
  const adhoc = String(process.env.KOINOS_ROUTER_SIGN_IDENTITY || "").trim() === "-";
  const { steps, app } = plan({ args: argv, out, signed: !!identity, adhoc });

  if (!identity) {
    builder(steps[0]);
    console.log(
      `\n[dist-router] Signed ad-hoc: ${reason}.\n` +
        "  macOS treats every ad-hoc build as a new app, so the Keychain asks about\n" +
        '  "Koinos Router Safe Storage" again after each rebuild. To keep one identity:\n' +
        "    bash router/scripts/setup-dev-signing.sh   (once)\n" +
        "    npm run dist:router\n",
    );
    return 0;
  }

  console.log(`[dist-router] Will sign with "${identity.name}" (${identity.hash}): ${reason}.`);
  builder(steps[0]);
  const dr = await sign.signRouterApp({ app, identity });
  console.log(`[dist-router] Signed ${app}\n[dist-router] designated => ${dr}`);
  if (identity.kind === "local") {
    console.log(
      "[dist-router] Self-signed: the identity stays the same across builds, but it has no Apple team ID,\n" +
        "  so macOS may still ask once after a rebuild. An Apple Development certificate (free, Xcode ›\n" +
        "  Settings › Accounts › Manage Certificates) has a team ID and is picked automatically when present.",
    );
  }
  for (const step of steps.slice(1)) builder(step);
  return 0;
}

module.exports = { plan, CONFIG };

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`[dist-router] ${e.message}`);
      process.exit(1);
    },
  );
}
