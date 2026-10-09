#!/usr/bin/env node
"use strict";

/*
 * `npm run release:router:assets [-- <dist dir>] [--no-verify]`: get a built
 * dist-router/ ready for a GitHub Release, and print the command that would
 * publish it. It never runs gh, never tags and never pushes: the person
 * publishing runs the printed command.
 *
 * 1. Finds Koinos-Router-<version>-<arch>.dmg and .zip (version: ROUTER_VERSION
 *    in dist-router.js) for each architecture built; a dmg without its zip, or
 *    the other way round, is an error.
 * 2. Checks each one (skip with --no-verify): the app inside (the dmg mounted
 *    read-only, the zip unpacked with ditto into a temp dir) has a valid
 *    signature (codesign --verify --deep --strict), CFBundleShortVersionString
 *    is the version, the binary is for that architecture, and it is NOT signed
 *    with an Apple Development certificate (that one is for the owner's own
 *    Macs and carries the owner's Apple ID email); the dmg has the
 *    Applications link and its window background. It reports whether the
 *    build is notarized (a stapled ticket) or ad-hoc.
 * 3. Writes SHA256SUMS.txt next to them (`shasum -a 256 -c SHA256SUMS.txt`
 *    checks a download).
 * 4. Prints `gh release create router-v<version> … --notes-file
 *    router/RELEASE_NOTES-<version>.md`.
 *
 * KOINOS_ROUTER_DIST_OUT is the default dist dir (as for dist-router.js);
 * KOINOS_ROUTER_RELEASE_REPO overrides the repository (levineam/koinos-router).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { ROUTER_VERSION, SUPPORTED_ARCHS, PRODUCT } = require("./dist-router");

const ROOT = path.join(__dirname, "..", "..");
const DEFAULT_REPO = "levineam/koinos-router";
const SUMS = "SHA256SUMS.txt";
const LIPO_ARCH = { arm64: "arm64", x64: "x86_64" };

/** Release artifacts for a version among file names. → [{ arch, dmg, zip }] (names). Throws on a half pair. */
function findArtifacts(names, version = ROUTER_VERSION) {
  const set = new Set(names);
  const found = [];
  for (const arch of SUPPORTED_ARCHS) {
    const dmg = `Koinos-Router-${version}-${arch}.dmg`;
    const zip = `Koinos-Router-${version}-${arch}.zip`;
    if (set.has(dmg) !== set.has(zip)) throw new Error(`${set.has(dmg) ? zip : dmg} is missing (the ${arch} dmg and zip ship together)`);
    if (set.has(dmg)) found.push({ arch, dmg, zip });
  }
  if (!found.length) throw new Error(`no Koinos-Router-${version}-<arch>.dmg/.zip found; build them with npm run dist:router`);
  return found;
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** shasum -a 256 format: "<hex>  <name>\n", sorted by name. */
function sumsText(entries) {
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => `${e.sha256}  ${e.name}\n`)
    .join("");
}

function shellQuote(s) {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** The gh command (argv) that would publish the release. */
function ghCommand({ version = ROUTER_VERSION, files, notesFile, repo = DEFAULT_REPO }) {
  return ["gh", "release", "create", `router-v${version}`, ...files, "--repo", repo, "--title", `Koinos Router ${version}`, "--notes-file", notesFile];
}

function formatCommand(argv) {
  const [gh, release, create, tag, ...rest] = argv.map(shellQuote);
  const lines = [`${gh} ${release} ${create} ${tag}`];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--") && i + 1 < rest.length) {
      lines.push(`${rest[i]} ${rest[i + 1]}`);
      i++;
    } else lines.push(rest[i]);
  }
  return lines.join(" \\\n  ");
}

/**
 * Who signed an app, from `codesign -dv --verbose=2` output (stderr).
 * → { adhoc, authorities, team, appleDevelopment, developerId }
 */
function signerOf(output) {
  const text = String(output || "");
  const authorities = [...text.matchAll(/^Authority=(.+)$/gm)].map((m) => m[1].trim());
  const team = (/^TeamIdentifier=(.+)$/m.exec(text) || [])[1] || null;
  return {
    adhoc: /^Signature=adhoc$/m.test(text) || /flags=0x[0-9a-f]*\([^)]*\badhoc\b/.test(text),
    authorities,
    team: team && team !== "not set" ? team : null,
    appleDevelopment: authorities.some((a) => /^(Apple Development|Mac Developer):/.test(a)),
    developerId: authorities.some((a) => a.startsWith("Developer ID Application:")),
  };
}

/** Plain-language description of a signer, for the summary. */
function describeSigner(s, stapled) {
  if (s.developerId) return stapled ? "Developer ID, notarized (stapled)" : "Developer ID, NOT notarized";
  if (s.appleDevelopment) return "Apple Development (must not be distributed)";
  if (s.adhoc) return "ad-hoc, not notarized: testers need Open Anyway once per version";
  return `signed by ${s.authorities[0] || "an unknown identity"}, not notarized`;
}

// -------------------------------------------------------------- checks

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

function must(cmd, args, what) {
  const r = run(cmd, args);
  if (r.status !== 0) throw new Error(`${what}: ${r.out.trim().slice(0, 600)}`);
  return r.out;
}

/** Checks one app bundle; returns its signer. Throws on anything a release must not ship. */
function checkApp(app, { arch, version, label }) {
  if (!fs.existsSync(path.join(app, "Contents", "Info.plist"))) throw new Error(`${label}: no ${PRODUCT}.app inside`);
  must("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], `${label}: invalid signature (macOS would call it damaged)`);
  const signer = signerOf(run("/usr/bin/codesign", ["-dv", "--verbose=2", app]).out);
  if (signer.appleDevelopment) {
    throw new Error(`${label} is signed with "${signer.authorities[0]}". That certificate is for your own Macs and names your Apple ID; rebuild with KOINOS_ROUTER_SIGN_IDENTITY=- npm run dist:router`);
  }
  const plist = path.join(app, "Contents", "Info.plist");
  const got = must("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist], `${label}: Info.plist`).trim();
  if (got !== version) throw new Error(`${label}: app version is ${got}, expected ${version}`);
  const exe = must("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", plist], `${label}: Info.plist`).trim();
  const archs = must("/usr/bin/lipo", ["-archs", path.join(app, "Contents", "MacOS", exe)], `${label}: lipo`).trim().split(/\s+/);
  if (!archs.includes(LIPO_ARCH[arch])) throw new Error(`${label}: binary is ${archs.join(", ")}, expected ${LIPO_ARCH[arch]}`);
  const stapled = run("/usr/bin/xcrun", ["stapler", "validate", app]).status === 0;
  return { signer, stapled };
}

function checkZip(file, { arch, version }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "koinos-router-zip-"));
  try {
    must("/usr/bin/ditto", ["-x", "-k", file, tmp], `${path.basename(file)}: unzip`);
    return checkApp(path.join(tmp, `${PRODUCT}.app`), { arch, version, label: path.basename(file) });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function checkDmg(file, { arch, version }) {
  const label = path.basename(file);
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), "koinos-router-dmg-"));
  must("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mnt, file], `${label}: attach`);
  try {
    if (fs.readlinkSync(path.join(mnt, "Applications")) !== "/Applications") throw new Error(`${label}: no Applications link`);
    for (const f of [".DS_Store", ".background.tiff"]) if (!fs.existsSync(path.join(mnt, f))) throw new Error(`${label}: ${f} is missing (window layout)`);
    return checkApp(path.join(mnt, `${PRODUCT}.app`), { arch, version, label });
  } finally {
    detach(mnt);
  }
}

/**
 * Detach a mount point, forcing it on a second try, then remove the (now
 * empty) mount directory. Never removes anything recursively: if the image
 * is still attached, its contents must not be touched.
 */
function detach(mnt, { exec = run, rmdir = fs.rmdirSync } = {}) {
  if (exec("/usr/bin/hdiutil", ["detach", mnt]).status !== 0) {
    const r = exec("/usr/bin/hdiutil", ["detach", "-force", mnt]);
    if (r.status !== 0) {
      console.error(`[release-assets] warning: could not detach ${mnt}: ${String(r.out || "").trim()}`);
      return false;
    }
  }
  try {
    rmdir(mnt);
  } catch {
    /* already gone */
  }
  return true;
}

// ---------------------------------------------------------------- main

function parseArgs(argv, env = process.env) {
  const opts = { verify: true, dir: env.KOINOS_ROUTER_DIST_OUT ? path.resolve(env.KOINOS_ROUTER_DIST_OUT) : path.join(ROOT, "dist-router"), version: ROUTER_VERSION };
  for (const a of argv) {
    if (a === "--no-verify") opts.verify = false;
    else if (a.startsWith("--version=")) opts.version = a.slice("--version=".length);
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else opts.dir = path.resolve(a);
  }
  return opts;
}

/** A path for the printed command: relative to the repo when it is inside it. */
function display(p) {
  const rel = path.relative(ROOT, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
}

function main(argv = process.argv.slice(2), env = process.env, log = console.log) {
  const opts = parseArgs(argv, env);
  if (!fs.existsSync(opts.dir)) throw new Error(`${opts.dir} does not exist; build with npm run dist:router`);
  const found = findArtifacts(fs.readdirSync(opts.dir), opts.version);
  const kinds = new Set();
  for (const { arch, dmg, zip } of found) {
    for (const name of [dmg, zip]) {
      const file = path.join(opts.dir, name);
      if (!opts.verify) continue;
      const { signer, stapled } = name.endsWith(".dmg") ? checkDmg(file, { arch, version: opts.version }) : checkZip(file, { arch, version: opts.version });
      const kind = describeSigner(signer, stapled);
      kinds.add(kind);
      log(`[release-assets] ${name}: OK (${kind})`);
    }
  }
  const entries = found.flatMap(({ dmg, zip }) => [dmg, zip]).map((name) => ({ name, sha256: sha256File(path.join(opts.dir, name)), size: fs.statSync(path.join(opts.dir, name)).size }));
  const sumsPath = path.join(opts.dir, SUMS);
  fs.writeFileSync(sumsPath, sumsText(entries));
  for (const e of entries) log(`[release-assets] ${e.sha256}  ${e.name}  (${(e.size / 1e6).toFixed(1)} MB)`);
  log(`[release-assets] wrote ${display(sumsPath)}`);
  if (kinds.size > 1) log(`[release-assets] warning: the artifacts are signed differently (${[...kinds].join("; ")})`);

  const notes = path.join(ROOT, "router", `RELEASE_NOTES-${opts.version}.md`);
  if (!fs.existsSync(notes)) log(`[release-assets] warning: ${display(notes)} does not exist yet; write it before publishing`);
  const cmd = ghCommand({
    version: opts.version,
    files: [...entries.map((e) => display(path.join(opts.dir, e.name))), display(sumsPath)],
    notesFile: display(notes),
    repo: env.KOINOS_ROUTER_RELEASE_REPO || DEFAULT_REPO,
  });
  log("\n# To publish (from the repo root; this script does not run it):");
  log(formatCommand(cmd));
  return { entries, command: cmd, sums: sumsPath };
}

module.exports = { findArtifacts, sha256File, sumsText, shellQuote, ghCommand, formatCommand, signerOf, describeSigner, parseArgs, detach, main, SUMS, DEFAULT_REPO };

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`[release-assets] ${e.message}`);
    process.exit(1);
  }
}
