"use strict";

/*
 * Source-install update detection, against real git repositories.
 *
 * These build actual repos in a temp directory rather than stubbing git. The
 * bug being defended against was a git STATE — a detached HEAD from a checked
 * out tag — and a stub would only ever prove that the stub behaves the way
 * whoever wrote it imagined git behaves. That is precisely the assumption that
 * let a Pi sit eighteen versions behind while `git pull` reported success.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { inspect, apply } = require("../lib/source-update");

const run = (dir, ...args) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** An origin with one commit, and a clone of it. */
function mkPair() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-srcupd-"));
  const origin = path.join(root, "origin");
  fs.mkdirSync(origin);
  run(origin, "init", "--quiet", "--initial-branch=main");
  run(origin, "config", "user.email", "t@example.com");
  run(origin, "config", "user.name", "Test");
  fs.writeFileSync(path.join(origin, "package.json"), JSON.stringify({ name: "x", version: "0.1.0" }));
  run(origin, "add", "-A");
  run(origin, "commit", "--quiet", "-m", "first");

  const clone = path.join(root, "clone");
  execFileSync("git", ["clone", "--quiet", origin, clone], { stdio: ["ignore", "pipe", "pipe"] });
  run(clone, "config", "user.email", "t@example.com");
  run(clone, "config", "user.name", "Test");
  return { root, origin, clone };
}

/** Add `n` commits to origin; `bumpDeps` touches package.json on the last one. */
function advance(origin, n, { bumpDeps = false } = {}) {
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    if (last && bumpDeps) {
      fs.writeFileSync(path.join(origin, "package.json"), JSON.stringify({ name: "x", version: `0.2.${i}`, dependencies: { left: "1" } }));
    } else {
      fs.writeFileSync(path.join(origin, `f${i}.txt`), String(i));
    }
    run(origin, "add", "-A");
    run(origin, "commit", "--quiet", "-m", `c${i}`);
  }
}

test("a directory that is not a checkout says so instead of guessing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-nogit-"));
  const s = await inspect(dir, { fetch: false });
  assert.equal(s.kind, "not-git");
  assert.equal(s.canCheck, false);
});

test("an up-to-date checkout reports nothing to do", async () => {
  const { clone } = mkPair();
  const s = await inspect(clone);
  assert.equal(s.kind, "source");
  assert.equal(s.behind, 0);
  assert.equal(s.ahead, 0);
  assert.equal(s.canApply, false, "nothing to apply is not the same as cannot apply");
  assert.equal(s.detached, false);
});

test("a checkout behind its branch knows how far, and that it can catch up", async () => {
  const { origin, clone } = mkPair();
  advance(origin, 3);
  const s = await inspect(clone);
  assert.equal(s.behind, 3, "counts the commits it is missing");
  assert.equal(s.ahead, 0);
  assert.equal(s.canApply, true);
  assert.equal(s.reason, null);
});

/*
 * THE case. A checked-out tag detaches HEAD, `git pull` then has no branch to
 * pull into and silently does nothing, and the machine sits there looking fine.
 */
test("a detached HEAD is reported as such — not as up to date", async () => {
  const { origin, clone } = mkPair();
  run(clone, "tag", "v0.28.7");
  advance(origin, 5);
  run(clone, "fetch", "--quiet", "origin");
  run(clone, "checkout", "--quiet", "v0.28.7");   // exactly what happened

  const s = await inspect(clone);
  assert.equal(s.detached, true, "it notices there is no branch");
  assert.equal(s.branch, null);
  assert.equal(s.canApply, false, "and refuses to 'update' something it cannot fast-forward");
  assert.match(s.reason, /not on a branch/i, "and the reason names the real problem");
  // Still useful: the commit is on exactly one remote branch, so how far
  // behind it is remains answerable, and that number is the alarming part.
  assert.equal(s.behind, 5, "and still says how far behind the machine actually is");
});

test("uncommitted work blocks an automatic update, and says why", async () => {
  const { origin, clone } = mkPair();
  advance(origin, 1);
  fs.writeFileSync(path.join(clone, "mine.txt"), "work in progress");
  run(clone, "add", "-A");
  const s = await inspect(clone);
  assert.equal(s.dirty, true);
  assert.equal(s.canApply, false, "never clobber someone's work to install an update");
  assert.match(s.reason, /uncommitted/i);
});

test("local commits block an automatic update rather than being rewritten", async () => {
  const { origin, clone } = mkPair();
  advance(origin, 2);
  fs.writeFileSync(path.join(clone, "local.txt"), "local");
  run(clone, "add", "-A");
  run(clone, "commit", "--quiet", "-m", "local work");
  const s = await inspect(clone);
  assert.ok(s.ahead > 0);
  assert.equal(s.canApply, false);
  assert.match(s.reason, /local commits/i);
});

test("applying fast-forwards, and only reinstalls when dependencies actually moved", async () => {
  const { origin, clone } = mkPair();
  advance(origin, 2);                       // no package.json change
  const plain = await apply(clone);
  assert.equal(plain.applied, 2);
  assert.equal(plain.depsChanged, false, "a Pi should not sit through npm install for nothing");
  assert.equal((await inspect(clone)).behind, 0, "and it really is up to date afterwards");

  advance(origin, 1, { bumpDeps: true });
  const withDeps = await apply(clone);
  assert.equal(withDeps.depsChanged, true, "but it must when the lockfile or manifest moved");
});

test("applying refuses when it would not be a clean fast-forward", async () => {
  const { origin, clone } = mkPair();
  advance(origin, 1);
  fs.writeFileSync(path.join(clone, "mine.txt"), "uncommitted");
  run(clone, "add", "-A");
  await assert.rejects(() => apply(clone), /uncommitted/i,
    "the refusal carries the reason, so the UI can explain it");
});

/*
 * The route Core exposes for this.
 *
 * It is deliberately READ-ONLY. Applying an update runs git and then npm, and
 * npm runs whatever lifecycle scripts the tree contains — so an endpoint that
 * could trigger it would be a remote code execution primitive sitting on
 * localhost, reachable by any page the browser is persuaded to open. The
 * answering lives here; the applying lives behind a dialog in the Electron
 * layer that a person has to agree to.
 */
test("Core reports update state, and exposes no way to trigger one", async (t) => {
  // Pull-request CI checks out a detached merge commit with no upstream.
  // Exercise the route against a real, known git history instead of assuming
  // the runner's checkout has a tracking branch.
  const pair = mkPair(); advance(pair.origin, 2);
  run(pair.clone, "fetch", "--quiet", "origin");
  t.after(() => fs.rmSync(pair.root, { recursive: true, force: true }));
  t.mock.method(require("../lib/source-update"), "inspect", (repoDir, options) => {
    assert.equal(path.resolve(repoDir), path.resolve(__dirname, "../.."));
    assert.equal(options.fetch, false);
    return inspect(pair.clone, options);
  });
  const { createCore } = require("../server");
  const core = await createCore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "kai-updroute-")), port: 0, onEvent: () => {},
  });
  const port = await core.start();
  t.after(async () => { await core.stop?.(); });

  const r = await fetch(`http://127.0.0.1:${port}/core/update`);
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.kind, "source");
  assert.equal(body.behind, 2);
  assert.equal(body.canCheck, true);
  assert.equal(body.canApply, true);

  for (const method of ["POST", "PUT", "DELETE"]) {
    const w = await fetch(`http://127.0.0.1:${port}/core/update`, { method });
    assert.notEqual(w.status, 200, `${method} /core/update must not be a way to run git`);
  }
  for (const p of ["/core/update/apply", "/core/update/pull"]) {
    const w = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST" });
    assert.notEqual(w.status, 200, `${p} must not exist`);
  }
});
