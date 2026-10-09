"use strict";

/*
 * router/scripts/release-assets.js: checksums and the gh command for a built
 * dist-router/. It must never run gh. No network, no real artifacts.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "router", "scripts", "release-assets.js");
const ra = require("../scripts/release-assets");
const { ROUTER_VERSION } = require("../scripts/dist-router");

test("finds the dmg and zip of this version, per architecture, and refuses a half pair", () => {
  const names = [
    "Koinos-Router-0.1.0-arm64.dmg",
    "Koinos-Router-0.1.0-arm64.zip",
    "Koinos-Router-0.1.0-arm64.zip.blockmap",
    "Koinos-Router-0.54.12-arm64.dmg", // an older build left in dist-router/
    "Koinos-Router-0.54.12-arm64.zip",
    "builder-debug.yml",
    "mac-arm64",
  ];
  assert.deepStrictEqual(ra.findArtifacts(names, "0.1.0"), [{ arch: "arm64", dmg: "Koinos-Router-0.1.0-arm64.dmg", zip: "Koinos-Router-0.1.0-arm64.zip" }]);
  assert.deepStrictEqual(
    ra.findArtifacts([...names, "Koinos-Router-0.1.0-x64.zip", "Koinos-Router-0.1.0-x64.dmg"], "0.1.0").map((f) => f.arch),
    ["arm64", "x64"],
  );
  assert.throws(() => ra.findArtifacts(["Koinos-Router-0.1.0-arm64.dmg"], "0.1.0"), /Koinos-Router-0\.1\.0-arm64\.zip is missing/);
  assert.throws(() => ra.findArtifacts(["Koinos-Router-0.54.12-arm64.dmg", "Koinos-Router-0.54.12-arm64.zip"], "0.1.0"), /npm run dist:router/);
});

test("SHA256SUMS.txt is in shasum format, sorted", () => {
  const text = ra.sumsText([
    { name: "b.zip", sha256: "2".repeat(64) },
    { name: "a.dmg", sha256: "1".repeat(64) },
  ]);
  assert.strictEqual(text, `${"1".repeat(64)}  a.dmg\n${"2".repeat(64)}  b.zip\n`);
});

test("the gh command: tag router-v<version>, the assets, title, notes file", () => {
  const argv = ra.ghCommand({
    version: "0.1.0",
    files: ["dist-router/Koinos-Router-0.1.0-arm64.dmg", "dist-router/Koinos-Router-0.1.0-arm64.zip", "dist-router/SHA256SUMS.txt"],
    notesFile: "router/RELEASE_NOTES-0.1.0.md",
  });
  assert.deepStrictEqual(argv, [
    "gh", "release", "create", "router-v0.1.0",
    "dist-router/Koinos-Router-0.1.0-arm64.dmg", "dist-router/Koinos-Router-0.1.0-arm64.zip", "dist-router/SHA256SUMS.txt",
    "--repo", "levineam/koinos-router",
    "--title", "Koinos Router 0.1.0",
    "--notes-file", "router/RELEASE_NOTES-0.1.0.md",
  ]);
  const text = ra.formatCommand(argv);
  assert.match(text, /^gh release create router-v0\.1\.0 \\\n/);
  assert.match(text, /--title 'Koinos Router 0\.1\.0' \\\n/);
  assert.match(text, /--notes-file router\/RELEASE_NOTES-0\.1\.0\.md$/);
  assert.strictEqual(ra.shellQuote("/a b/it's"), `'/a b/it'\\''s'`);
});

test("signers: ad-hoc and Developer ID are told apart from Apple Development", () => {
  const adhoc = ra.signerOf("Identifier=io.koinosai.router\nCodeDirectory v=20500 size=627 flags=0x10002(adhoc,runtime) hashes=9+7\nSignature=adhoc\nTeamIdentifier=not set\n");
  assert.deepStrictEqual(adhoc, { adhoc: true, authorities: [], team: null, appleDevelopment: false, developerId: false });
  assert.match(ra.describeSigner(adhoc, false), /ad-hoc, not notarized: testers need Open Anyway/);
  const dev = ra.signerOf("Authority=Apple Development: someone@example.com (ABCDE12345)\nAuthority=Apple Worldwide Developer Relations Certification Authority\nTeamIdentifier=TEAM123456\n");
  assert.strictEqual(dev.appleDevelopment, true);
  assert.strictEqual(dev.team, "TEAM123456");
  const devId = ra.signerOf("Authority=Developer ID Application: Koinos (ABCDE12345)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=ABCDE12345\n");
  assert.strictEqual(devId.developerId, true);
  assert.strictEqual(ra.describeSigner(devId, true), "Developer ID, notarized (stapled)");
  assert.strictEqual(ra.describeSigner(devId, false), "Developer ID, NOT notarized");
});

test("end to end on a fake dist dir: writes SHA256SUMS.txt, prints the command, never runs gh", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koinos-router-release-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "koinos-router-fakegh-"));
  const marker = path.join(bin, "gh-was-run");
  try {
    // A gh that would leave a mark if anything ran it.
    fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    const files = { [`Koinos-Router-${ROUTER_VERSION}-arm64.dmg`]: "dmg bytes", [`Koinos-Router-${ROUTER_VERSION}-arm64.zip`]: "zip bytes" };
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    const r = spawnSync(process.execPath, [SCRIPT, dir, "--no-verify"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KOINOS_ROUTER_RELEASE_REPO: "someone/fork" },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const sums = fs.readFileSync(path.join(dir, "SHA256SUMS.txt"), "utf8");
    const expected = Object.entries(files)
      .map(([name, body]) => `${crypto.createHash("sha256").update(body).digest("hex")}  ${name}\n`)
      .join("");
    assert.strictEqual(sums, expected);
    // shasum agrees.
    assert.match(execFileSync("/usr/bin/shasum", ["-a", "256", "-c", "SHA256SUMS.txt"], { cwd: dir, encoding: "utf8" }), /arm64\.dmg: OK\n.*arm64\.zip: OK/s);
    assert.match(r.stdout, new RegExp(`gh release create router-v${ROUTER_VERSION.replace(/\./g, "\\.")} \\\\`));
    assert.match(r.stdout, /--repo someone\/fork/);
    assert.match(r.stdout, new RegExp(`--notes-file router/RELEASE_NOTES-${ROUTER_VERSION.replace(/\./g, "\\.")}\\.md`));
    assert.ok(r.stdout.includes(path.join(dir, "SHA256SUMS.txt")), "a dist dir outside the repo is printed as an absolute path");
    assert.ok(!fs.existsSync(marker), "release-assets must never run gh");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
  // Nor could it: gh appears only as text, not as a command it spawns.
  const src = fs.readFileSync(SCRIPT, "utf8");
  for (const m of src.matchAll(/(?:spawnSync|execFileSync|execSync|run|must)\(\s*"([^"]+)"/g)) assert.notStrictEqual(path.basename(m[1]), "gh", m[0]);
  assert.doesNotMatch(src, /\bexecSync\b|child_process"\)\.exec\b|\{[^}]*\bexec\b[^}]*\}\s*=\s*require\("child_process"\)/, "no shell");
});

test("arguments: dist dir, --no-verify, --version=", () => {
  assert.deepStrictEqual(ra.parseArgs([], {}), { verify: true, dir: path.join(ROOT, "dist-router"), version: ROUTER_VERSION });
  assert.deepStrictEqual(ra.parseArgs(["/x", "--no-verify", "--version=0.2.0"], {}), { verify: false, dir: "/x", version: "0.2.0" });
  assert.strictEqual(ra.parseArgs([], { KOINOS_ROUTER_DIST_OUT: "/y" }).dir, "/y");
  assert.throws(() => ra.parseArgs(["--publish"], {}), /unknown option --publish/);
});

test("a dmg mount is detached (forced on a retry) and never removed recursively", () => {
  const calls = [];
  const removed = [];
  const exec = (status) => (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    return { status: status.shift(), out: "busy" };
  };
  // Detaches at once: the empty mount directory goes.
  assert.strictEqual(ra.detach("/tmp/m1", { exec: exec([0]), rmdir: (p) => removed.push(p) }), true);
  assert.deepStrictEqual(calls.splice(0), ["/usr/bin/hdiutil detach /tmp/m1"]);
  assert.deepStrictEqual(removed.splice(0), ["/tmp/m1"]);
  // Busy: one forced retry.
  assert.strictEqual(ra.detach("/tmp/m2", { exec: exec([1, 0]), rmdir: (p) => removed.push(p) }), true);
  assert.deepStrictEqual(calls.splice(0), ["/usr/bin/hdiutil detach /tmp/m2", "/usr/bin/hdiutil detach -force /tmp/m2"]);
  assert.deepStrictEqual(removed.splice(0), ["/tmp/m2"]);
  // Still attached: the mount point (and the volume behind it) is left alone.
  const err = console.error;
  console.error = () => {};
  try {
    assert.strictEqual(ra.detach("/tmp/m3", { exec: exec([1, 1]), rmdir: (p) => removed.push(p) }), false);
  } finally {
    console.error = err;
  }
  assert.deepStrictEqual(removed, []);
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(src.slice(src.indexOf("function checkDmg")), /rmSync\(mnt/);
});
