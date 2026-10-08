"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Ledger } = require("../lib/ledger");

const DAY_MS = 24 * 60 * 60 * 1000;

function tmpFile(name = "router-ledger.jsonl") {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "router-ledger-")), name);
}

// Local wall-clock times, so the midnight tests hold in any timezone.
const local = (y, mo, d, h = 12, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const key = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function clock(start) {
  const c = { t: start, now: () => c.t };
  return c;
}

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

test("record adds a short hex id and at, keeps given ones, and writes one JSON line each", () => {
  const file = tmpFile();
  const c = clock(local(2026, 10, 7, 9));
  const ledger = new Ledger({ file, now: c.now });

  const a = ledger.record({ kind: "delegate", harness: "codex", task: "t", kai: -0.2, ok: true });
  assert.match(a.id, /^[0-9a-f]{12}$/);
  assert.equal(a.at, c.t);
  assert.deepEqual(Object.keys(a).slice(0, 2), ["id", "at"]);

  const b = ledger.record({ id: "fixed", at: 123, kind: "share", jobs: 1, kai: null });
  assert.equal(b.id, "fixed");
  assert.equal(b.at, 123);

  const lines = fs.readFileSync(file, "utf8").split("\n");
  assert.equal(lines.length, 3, "two lines plus the trailing newline");
  assert.equal(lines[2], "");
  assert.deepEqual(JSON.parse(lines[0]), a);
  assert.deepEqual(JSON.parse(lines[1]), b);
  assert.notEqual(ledger.record({ kind: "share" }).id, ledger.record({ kind: "share" }).id);
});

test("record creates the parent directory and keeps the file private", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "router-ledger-")), "nested", "deeper", "l.jsonl");
  const ledger = new Ledger({ file });
  ledger.record({ kind: "share", jobs: 2, kai: 1 });
  assert.equal(ledger.list().length, 1);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("record rejects non-object entries", () => {
  const ledger = new Ledger({ file: tmpFile() });
  assert.throws(() => ledger.record(null), TypeError);
  assert.throws(() => ledger.record([1]), TypeError);
});

test("list returns newest first by at, later writes first on ties, and honours limit", () => {
  const file = tmpFile();
  const c = clock(local(2026, 10, 7, 9));
  const ledger = new Ledger({ file, now: c.now });

  ledger.record({ id: "mid", kind: "delegate", kai: -1 });
  c.t += 60_000;
  ledger.record({ id: "new", kind: "delegate", kai: -1 });
  ledger.record({ id: "old", kind: "share", at: c.t - 3_600_000, kai: 1 }); // written late, happened early
  ledger.record({ id: "tie", kind: "share", at: c.t, kai: 1 });

  assert.deepEqual(ledger.list().map(e => e.id), ["tie", "new", "mid", "old"]);
  assert.deepEqual(ledger.list({ limit: 2 }).map(e => e.id), ["tie", "new"]);
  assert.deepEqual(ledger.list({ limit: 0 }), []);
});

test("a missing file is an empty ledger and reading never creates it", () => {
  const file = tmpFile();
  const ledger = new Ledger({ file });
  assert.deepEqual(ledger.list(), []);
  assert.deepEqual(ledger.today(), { earnedKai: 0, spentKai: 0, delegations: 0, jobs: 0 });
  assert.equal(ledger.spentToday(), 0);
  assert.equal(ledger.earnedToday(10), 0);
  assert.equal(ledger.prune(), 0);
  assert.equal(fs.existsSync(file), false);
});

test("corrupt and truncated lines are skipped, and the next record still lands cleanly", () => {
  const file = tmpFile();
  const at = local(2026, 10, 7, 10);
  fs.writeFileSync(file, [
    JSON.stringify({ id: "a", at, kind: "delegate", kai: -1 }),
    "not json at all",
    "[1,2,3]",
    JSON.stringify({ id: "no-at", kind: "delegate", kai: -5 }),
    "",
    JSON.stringify({ id: "b", at: at + 1, kind: "share", jobs: 1, kai: 2 }),
    '{"id":"cut","at":' + (at + 2) + ',"kind":"dele', // crash mid-append: no trailing newline
  ].join("\n"));

  const ledger = new Ledger({ file, now: () => at + 10 });
  assert.deepEqual(ledger.list().map(e => e.id), ["b", "a"]);
  assert.equal(ledger.spentToday(), 1);

  ledger.record({ id: "c", kind: "delegate", kai: -0.5 });
  assert.deepEqual(ledger.list().map(e => e.id), ["c", "b", "a"]);
  assert.equal(ledger.spentToday(), 1.5);
});

test("today() and spentToday() follow the local calendar day across midnight", () => {
  const file = tmpFile();
  const c = clock(local(2026, 10, 6, 23, 58));
  const ledger = new Ledger({ file, now: c.now });

  // Yesterday, just before midnight.
  ledger.record({ kind: "share", jobs: 3, kai: 2 });
  ledger.record({ kind: "delegate", harness: "codex", kai: -1, ok: true, at: local(2026, 10, 6, 23, 59) });

  c.t = local(2026, 10, 6, 23, 59, 30);
  assert.deepEqual(ledger.today(), { earnedKai: 2, spentKai: 1, delegations: 1, jobs: 3 });
  assert.equal(ledger.spentToday(), 1);

  // After midnight: yesterday no longer counts.
  c.t = local(2026, 10, 7, 0, 1);
  assert.deepEqual(ledger.today(), { earnedKai: 0, spentKai: 0, delegations: 0, jobs: 0 });

  ledger.record({ kind: "delegate", harness: "claude", kai: -0.25, ok: true });
  ledger.record({ kind: "delegate", harness: "codex", kai: null, ok: true }); // unpriced
  ledger.record({ kind: "delegate", harness: "codex", kai: -0.5, ok: false, error: "TIMEOUT" }); // partial spend
  ledger.record({ kind: "share", jobs: 4, kai: 1.5 });
  ledger.record({ kind: "share", jobs: 2, kai: null }); // unpriced session still counts its jobs
  ledger.record({ kind: "share", jobs: 1, kai: -3 }); // only positive share kai is earnings

  c.t = local(2026, 10, 7, 18);
  const t = ledger.today();
  close(t.spentKai, 0.75);
  close(ledger.spentToday(), 0.75);
  assert.equal(t.earnedKai, 1.5);
  assert.equal(t.delegations, 3);
  assert.equal(t.jobs, 7);
});

test("observeBalance sets the day's baseline only once and starts a new one the next day", () => {
  const file = tmpFile();
  const c = clock(local(2026, 10, 7, 0, 0));
  const ledger = new Ledger({ file, now: c.now });
  const dayFile = `${file}.day.json`;

  ledger.observeBalance(null);
  ledger.observeBalance(Number.NaN);
  assert.equal(fs.existsSync(dayFile), false, "unknown balances are ignored");

  ledger.observeBalance(10);
  c.t += 3_600_000;
  ledger.observeBalance(12);
  ledger.observeBalance(8);
  assert.deepEqual(JSON.parse(fs.readFileSync(dayFile, "utf8")), { [key(c.t)]: 10 });
  close(ledger.earnedToday(12), 2);

  c.t = local(2026, 10, 8, 0, 0, 5);
  assert.equal(ledger.earnedToday(12), 0, "no baseline yet for the new day");
  ledger.observeBalance(12);
  ledger.observeBalance(15);
  assert.deepEqual(JSON.parse(fs.readFileSync(dayFile, "utf8")), {
    [key(local(2026, 10, 7))]: 10,
    [key(local(2026, 10, 8))]: 12,
  });
  close(ledger.earnedToday(15), 3);

  // A fresh Ledger on the same file reads the persisted baseline.
  close(new Ledger({ file, now: c.now }).earnedToday(13), 1);
});

test("the day-baseline sidecar keeps only the last 7 local days", () => {
  const file = tmpFile();
  const c = clock(local(2026, 9, 25, 9));
  const ledger = new Ledger({ file, now: c.now });
  for (let i = 0; i < 10; i++) {
    c.t = local(2026, 9, 25 + i, 9);
    ledger.observeBalance(100 + i);
  }
  const stored = JSON.parse(fs.readFileSync(`${file}.day.json`, "utf8"));
  const expected = {};
  for (let i = 3; i < 10; i++) expected[key(local(2026, 9, 25 + i, 9))] = 100 + i;
  assert.deepEqual(stored, expected);
});

test("a corrupt day sidecar is treated as empty and replaced", () => {
  const file = tmpFile();
  const now = local(2026, 10, 7, 9);
  fs.writeFileSync(`${file}.day.json`, "{ truncated");
  const ledger = new Ledger({ file, now: () => now });
  assert.equal(ledger.earnedToday(5), 0);
  ledger.observeBalance(5);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.day.json`, "utf8")), { [key(now)]: 5 });
});

test("earnedToday adds today's spending back onto the balance change and never goes negative", () => {
  const file = tmpFile();
  const c = clock(local(2026, 10, 7, 8));
  const ledger = new Ledger({ file, now: c.now });

  // Yesterday's spending must not leak into today's figure.
  ledger.record({ kind: "delegate", kai: -4, ok: true, at: local(2026, 10, 6, 22) });
  assert.equal(ledger.earnedToday(10), 0, "no baseline → 0");

  ledger.observeBalance(10);
  close(ledger.earnedToday(10), 0);
  close(ledger.earnedToday(11.5), 1.5);

  ledger.record({ kind: "delegate", kai: -2, ok: true });
  ledger.record({ kind: "delegate", kai: null, ok: true });
  close(ledger.spentToday(), 2);
  // Earned 1, spent 2: balance went 10 → 9.
  close(ledger.earnedToday(9), 1);
  // Balance fell by more than the recorded spend (e.g. a stale reading) → clamp to 0.
  assert.equal(ledger.earnedToday(7), 0);
  assert.equal(ledger.earnedToday(null), 0);
  assert.equal(ledger.earnedToday(Number.POSITIVE_INFINITY), 0);
});

test("prune keeps entries newer than now - days and rewrites the file atomically", () => {
  const file = tmpFile();
  const now = local(2026, 10, 7, 12);
  const ledger = new Ledger({ file, now: () => now });

  ledger.record({ id: "ancient", kind: "share", at: now - 90 * DAY_MS, kai: 1 });
  ledger.record({ id: "edge", kind: "share", at: now - 30 * DAY_MS, kai: 1 });
  ledger.record({ id: "recent", kind: "delegate", at: now - 29 * DAY_MS, kai: -1 });
  ledger.record({ id: "today", kind: "delegate", kai: -1 });
  fs.appendFileSync(file, "garbage line\n");
  const keptBefore = fs.readFileSync(file, "utf8").split("\n").filter(l => l.includes('"recent"') || l.includes('"today"'));

  assert.equal(ledger.prune(), 2);
  assert.deepEqual(ledger.list().map(e => e.id), ["today", "recent"]);
  assert.equal(fs.readFileSync(file, "utf8"), keptBefore.map(l => `${l}\n`).join(""), "kept lines verbatim, garbage dropped");
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(n => n.endsWith(".tmp")), [], "no temp files left");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  assert.equal(ledger.prune({ days: 1 }), 1);
  assert.deepEqual(ledger.list().map(e => e.id), ["today"]);
  assert.equal(ledger.prune({ days: 0 }), 1);
  assert.deepEqual(ledger.list(), []);
  assert.equal(fs.readFileSync(file, "utf8"), "");
});

test("prune leaves the file untouched when nothing needs removing", () => {
  const file = tmpFile();
  const now = local(2026, 10, 7, 12);
  const ledger = new Ledger({ file, now: () => now });
  ledger.record({ kind: "share", jobs: 1, kai: 1 });
  const inode = fs.statSync(file).ino;
  assert.equal(ledger.prune({ days: 30 }), 0);
  assert.equal(fs.statSync(file).ino, inode, "no rewrite");
  assert.throws(() => ledger.prune({ days: -1 }), RangeError);
});

test("resetBaseline starts today over for a new wallet without counting the old wallet's spend as earnings", () => {
  const file = tmpFile();
  const c = clock(local(2026, 10, 7, 9));
  const ledger = new Ledger({ file, now: c.now });
  ledger.observeBalance(0); // the fresh wallet made from the popover
  ledger.record({ kind: "delegate", harness: "codex", task: "t", kai: -2, ok: true });
  assert.equal(ledger.earnedToday(42.8), 44.8, "without a reset the restored balance reads as earned");

  ledger.resetBaseline(); // the user restores a wallet holding 42.8 KAI
  assert.equal(ledger.earnedToday(42.8), 0, "no baseline yet: nothing earned");
  c.t += 1000;
  ledger.observeBalance(42.8);
  close(ledger.earnedToday(42.8), 0);
  close(ledger.earnedToday(43.3), 0.5);
  ledger.record({ kind: "delegate", harness: "claude", task: "t", kai: -1, ok: true });
  close(ledger.earnedToday(42.3), 0.5, "spending on the new wallet still adds back");

  // The reset marker is day-scoped and pruned with the baselines.
  const sidecar = JSON.parse(fs.readFileSync(`${file}.day.json`, "utf8"));
  assert.deepEqual(Object.keys(sidecar), [key(c.t)]);
  c.t = local(2026, 10, 8, 9);
  ledger.observeBalance(42.3);
  close(ledger.earnedToday(42.3), 0);
});
