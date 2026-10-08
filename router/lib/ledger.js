"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");

const DAY_MS = 24 * 60 * 60 * 1000;
const BASELINE_DAYS = 7;
const SPENT_SUFFIX = "#spent"; // "<day>#spent": spend before a resetBaseline() that day
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}(?:#spent)?$/;

const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
const isKai = v => typeof v === "number" && Number.isFinite(v);

// Local calendar day, so "today" flips at the user's midnight rather than UTC's.
function dayKey(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

function parseLine(line) {
  try {
    const entry = JSON.parse(line);
    return isPlainObject(entry) && Number.isFinite(entry.at) ? entry : null;
  } catch {
    return null;
  }
}

// One pass over the file. Corrupt or truncated lines (a crash mid-append) are
// skipped; `raw` keeps each good line verbatim so prune() can rewrite without
// reformatting anything.
function readLines(file) {
  const rows = [];
  let corrupt = 0;
  for (const raw of readText(file).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const entry = parseLine(line);
    if (entry) rows.push({ entry, raw: line });
    else corrupt++;
  }
  return { rows, corrupt };
}

// A crash can leave the file without its trailing newline; appending straight
// onto that fragment would corrupt the new entry too.
function endsMidLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
  try {
    const { size } = fs.fstatSync(fd);
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

class Ledger {
  constructor({ file, now = () => Date.now() } = {}) {
    if (typeof file !== "string" || !file) throw new TypeError("Ledger needs a file path");
    this.file = file;
    this.dayFile = `${file}.day.json`;
    this.now = now;
  }

  record(entry) {
    if (!isPlainObject(entry)) throw new TypeError("Ledger entries must be objects");
    const id = typeof entry.id === "string" && entry.id ? entry.id : crypto.randomBytes(6).toString("hex");
    const at = Number.isFinite(entry.at) ? entry.at : this.now();
    // id and at are declared first so they lead each JSONL line.
    const stored = { id, at, ...entry };
    stored.id = id;
    stored.at = at;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const lead = endsMidLine(this.file) ? "\n" : "";
    fs.appendFileSync(this.file, `${lead}${JSON.stringify(stored)}\n`, { mode: 0o600 });
    return stored;
  }

  list({ limit = 100 } = {}) {
    // Reverse first so the stable sort puts the later-written of two equal `at`s first.
    const entries = readLines(this.file).rows.map(r => r.entry).reverse();
    entries.sort((a, b) => b.at - a.at);
    return entries.slice(0, Math.max(0, limit));
  }

  // Ledger-only figures for today. earnedKai counts just the share sessions that
  // carry a kai amount; the balance-based estimate is earnedToday(). The two
  // measure overlapping earnings, so RouterService combines them and must never
  // add one to the other.
  today() {
    const totals = { earnedKai: 0, spentKai: 0, delegations: 0, jobs: 0 };
    for (const e of this._todayEntries()) {
      if (e.kind === "delegate") {
        totals.delegations++;
        if (isKai(e.kai)) totals.spentKai += Math.abs(e.kai);
      } else if (e.kind === "share") {
        if (isKai(e.kai) && e.kai > 0) totals.earnedKai += e.kai;
        if (Number.isFinite(e.jobs) && e.jobs > 0) totals.jobs += e.jobs;
      }
    }
    return totals;
  }

  // Failed runs count too: they record the kai of the calls already made.
  spentToday() {
    let spent = 0;
    for (const e of this._todayEntries()) {
      if (e.kind === "delegate" && isKai(e.kai)) spent += Math.abs(e.kai);
    }
    return spent;
  }

  // The scheduler has no per-day breakdown, so the first balance seen each local
  // day stands in for the midnight balance.
  observeBalance(totalKai) {
    if (!isKai(totalKai)) return;
    const today = dayKey(this.now());
    const baselines = this._readBaselines();
    if (Object.hasOwn(baselines, today)) return;
    // After resetBaseline(), spending from before the reset belonged to the
    // other wallet: fold it into the baseline so earnedToday() doesn't add it.
    const offset = baselines[today + SPENT_SUFFIX];
    baselines[today] = totalKai + (isKai(offset) ? offset : 0);
    delete baselines[today + SPENT_SUFFIX];
    this._writeBaselines(baselines);
  }

  // The wallet changed (a restore): today's baseline was the old wallet's
  // balance. Drop it so the next balance read starts today over.
  resetBaseline() {
    const today = dayKey(this.now());
    const baselines = this._readBaselines();
    delete baselines[today];
    baselines[today + SPENT_SUFFIX] = this.spentToday();
    this._writeBaselines(baselines);
  }

  // Spending lowers the balance, so it is added back to recover what was earned.
  earnedToday(totalKaiNow) {
    if (!isKai(totalKaiNow)) return 0;
    const baseline = this._readBaselines()[dayKey(this.now())];
    if (!isKai(baseline)) return 0;
    return Math.max(0, totalKaiNow - baseline + this.spentToday());
  }

  // Corrupt lines are dropped by the rewrite but not counted as removed entries.
  prune({ days = 30 } = {}) {
    if (!Number.isFinite(days) || days < 0) throw new RangeError("prune days must be a non-negative number");
    const cutoff = this.now() - days * DAY_MS;
    const { rows, corrupt } = readLines(this.file);
    const kept = rows.filter(r => r.entry.at > cutoff);
    const removed = rows.length - kept.length;
    if (removed > 0 || corrupt > 0) {
      atomicWrite(this.file, kept.map(r => `${r.raw}\n`).join(""));
    }
    return removed;
  }

  _todayEntries() {
    const today = dayKey(this.now());
    return readLines(this.file).rows.map(r => r.entry).filter(e => dayKey(e.at) === today);
  }

  _readBaselines() {
    let parsed;
    try {
      parsed = JSON.parse(readText(this.dayFile) || "{}");
    } catch {
      return {};
    }
    if (!isPlainObject(parsed)) return {};
    const baselines = {};
    for (const [day, kai] of Object.entries(parsed)) {
      if (DAY_KEY_RE.test(day) && isKai(kai)) baselines[day] = kai;
    }
    return baselines;
  }

  _writeBaselines(baselines) {
    atomicWrite(this.dayFile, `${JSON.stringify(this._recentBaselines(baselines), null, 2)}\n`);
  }

  // Keep today and the six local days before it. Computed with local date math
  // (not now - 6*DAY_MS) so DST days don't shift the window.
  _recentBaselines(baselines) {
    const d = new Date(this.now());
    const today = dayKey(d.getTime());
    const oldest = dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (BASELINE_DAYS - 1)).getTime());
    const recent = {};
    for (const key of Object.keys(baselines).sort()) {
      const day = key.slice(0, 10);
      if (day >= oldest && day <= today) recent[key] = baselines[key];
    }
    return recent;
  }
}

module.exports = { Ledger };
