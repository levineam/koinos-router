"use strict";
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const DATA_DIRS = ["chain", "block_store", "mempool", "transaction_store", "account_history", "contract_meta_store"];

// Docker keeps logs across container restarts. Diagnose only the current
// process lifetime when inspect provides its start time.
function currentLogs(text, services = []) {
  const starts = new Map(services.map(s => [s.service, Date.parse(s.startedAt)]));
  return String(text).split(/\r?\n/).filter(line => {
    const m = line.match(/^\s*([a-z_]+)(?:-\d+)?\s*\|\s*(\d{4}-\d\d-\d\dT[\d:.]+Z)/i);
    return !m || !Number.isFinite(starts.get(m[1])) || Date.parse(m[2]) >= starts.get(m[1]);
  }).join("\n");
}

function inspectLogs(text) {
  let health = null;
  if (/replayed state delta merkle root does not match block receipt/i.test(text)) {
    health = { ok: false, needsRepair: true, reason: "replay-mismatch", service: "chain" };
  } else if (/fatal.*chain|chain[^\n]*fatal/i.test(text)) {
    health = { ok: false, reason: "chain-failed", service: "chain" };
  } else if ((text.match(/No response to client request[^\n]*within 30000ms/gi) || []).length >= 2) {
    health = { ok: false, reason: "chain-unresponsive", service: "chain" };
  }
  // Official koinos-p2p emits this snapshot once a minute. Never turn a
  // missing/truncated snapshot into a zero or reuse it beyond the log window.
  const lines = String(text).split(/\r?\n/);
  let peers = null;
  for (let i = 0; i < lines.length; i++) {
    if (!/Connected peers:/.test(lines[i])) continue;
    let count = 0, lowerBound = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (/Connected peers:|My address:/.test(lines[j])) break;
      if (!/p2p[^|]*\|/.test(lines[j])) continue;
      if (/ - .*\/p2p\/\S+/.test(lines[j])) count++;
      else if (/and \d+ more/.test(lines[j])) { lowerBound = true; break; }
      else break;
    }
    peers = { count, lowerBound, observedAt: lines[i].match(/\d{4}-\d\d-\d\dT[\d:.]+Z/)?.[0] || null };
  }
  let production = null;
  for (const line of lines) {
    if (!/block_producer[^|]*\|/.test(line)) continue;
    if (/Error while submitting block:/i.test(line)) production = {
      reason: /could not burn vhp/i.test(line) ? "vhp-burn-rejected" : "block-submission-rejected",
      observedAt: line.match(/\d{4}-\d\d-\d\d[T ][\d:.]+Z?/)?.[0] || null,
    };
    else if (/Produced block - Height:/i.test(line)) production = { reason: null };
  }
  return { health, peers, production };
}

function lockError(e) {
  if (["EPERM", "EACCES", "EBUSY"].includes(e.code)) {
    return new Error(`The node data folder is locked or access was denied. Restart Windows fully, then open KAI and run Quick Sync before starting the node. Closing Docker or WSL alone may not release the lock. If it persists, check folder permissions and security software. (${e.code})`);
  }
  return e;
}
function assertRestoreReady(basedir) {
  if (fs.existsSync(path.join(basedir, ".kai-restore-incomplete.json")) || DATA_DIRS.some(name => fs.existsSync(path.join(basedir, `.kai-check-${name}`)))) {
    throw new Error("A previous restore or folder check was interrupted. Recover the original folders using the restore marker before starting the node or Quick Sync.");
  }
}
function preflightFolders(basedir) {
  assertRestoreReady(basedir);
  for (const name of DATA_DIRS) {
    const src = path.join(basedir, name), probe = path.join(basedir, `.kai-check-${name}`);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(probe)) throw new Error(`A previous folder check remains at ${probe}. Restore it before Quick Sync.`);
    try { fs.renameSync(src, probe); } catch (e) { throw lockError(e); }
    try { fs.renameSync(probe, src); } catch (e) {
      throw new Error(`Could not restore the folder check. Your data is at ${probe}; restore it to ${src} before starting the node. ${lockError(e).message}`);
    }
  }
}
function installSnapshot(basedir, rollback, chain, blockStore) {
  fs.mkdirSync(rollback, { recursive: true });
  const moved = [], installed = [];
  const marker = path.join(basedir, ".kai-restore-incomplete.json");
  fs.writeFileSync(marker, JSON.stringify({ rollback, chain, blockStore }), { flag: "wx" });
  try {
    for (const name of DATA_DIRS) {
      const src = path.join(basedir, name);
      if (fs.existsSync(src)) { fs.renameSync(src, path.join(rollback, name)); moved.push(name); }
    }
    for (const [src, name] of [[chain, "chain"], [blockStore, "block_store"]]) {
      fs.renameSync(src, path.join(basedir, name)); installed.push([src, name]);
    }
  } catch (e) {
    const failures = [];
    for (const [src, name] of installed.reverse()) {
      try { fs.renameSync(path.join(basedir, name), src); } catch (err) { failures.push(err.message); }
    }
    for (const name of moved.reverse()) {
      try { fs.renameSync(path.join(rollback, name), path.join(basedir, name)); } catch (err) { failures.push(err.message); }
    }
    if (failures.length) throw new Error(`Restore failed. Some original data remains in ${rollback}. Do not start the node until recovered. ${failures.join("; ")}`);
    fs.rmdirSync(rollback);
    fs.unlinkSync(marker);
    throw lockError(e);
  }
  fs.unlinkSync(marker);
}
function validBackup(root, id) {
  if (typeof id !== "string" || !/^previous-\d{4}-\d\d-\d\dT[\d-]+Z$/.test(id)) throw new Error("Invalid backup name");
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("Restore folder must not be a link");
  const target = path.join(root, id), st = fs.lstatSync(target);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Backup must be a real directory");
  return target;
}
async function sizeOf(dir) {
  let size = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name), st = await fsp.lstat(p);
    if (st.isSymbolicLink()) continue;
    size += st.isDirectory() ? await sizeOf(p) : st.size;
  }
  return size;
}
async function backupList(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const id of await fsp.readdir(root)) {
    if (!id.startsWith("previous-")) continue;
    try {
      const target = validBackup(root, id), st = await fsp.stat(target);
      out.push({ id, createdAt: st.mtime.toISOString(), bytes: await sizeOf(target) });
    } catch { out.push({ id, bytes: null, error: "Unable to inspect safely" }); }
  }
  return out.sort((a,b) => b.id.localeCompare(a.id));
}
async function deleteBackup(root, id) {
  const target = validBackup(root, id);
  await fsp.rm(target, { recursive: true });
  return { deleted: true };
}
module.exports = { currentLogs, assertRestoreReady, inspectLogs, preflightFolders, installSnapshot, backupList, deleteBackup };
