"use strict";

// Pure, dependency-free logic for keeping a Koinos node alive without the user
// ever having to understand Docker, WSL, RocksDB, or "out of memory". The
// watchdog in node-manager.js polls the running stack and feeds the raw facts
// (which containers are up, how far the chain has advanced) into assessHealth();
// everything here is deterministic so it can be unit-tested in isolation.

const GiB = 1024 * 1024 * 1024;

// Messaging and the local RPC are required for the managed desktop node.
const CORE_SERVICES = ["amqp", "chain", "block_store", "mempool", "p2p", "jsonrpc"];

function coreServicesFor(producing) {
  return producing ? [...CORE_SERVICES, "block_producer"] : [...CORE_SERVICES];
}

// Classify one `docker compose ps` row. A container that keeps dying shows up as
// state "restarting" or a "Restarting (137)" / "Exited (137)" status — 137 is the
// SIGKILL exit code the kernel's OOM killer uses, which is our low-memory signal.
function serviceTrouble(row) {
  const state = String(row?.state ?? "").toLowerCase();
  const status = String(row?.status ?? "");
  const oom = /\(137\)/.test(status) || /oom/i.test(status) || row?.oomKilled === true;
  if (/restart/i.test(state) || /restarting/i.test(status)) return { down: true, oom };
  if (/exit|dead/i.test(state) || /\bexited\b/i.test(status)) return { down: true, oom };
  if (/created|paused|removing/i.test(state) || row?.health === "unhealthy") return { down: true, oom };
  return { down: false, oom };
}

// Decide whether the running node is healthy. Returns { ok, reason, oom, service }.
//   reason: "service-down" | "oom" | "stalled" | null | "no-data"
// Inputs are all plain data so this is fully deterministic:
//   services      - rows from `docker compose ps --format json` ({service,state,status})
//   producing     - whether the block_producer is expected to run
//   headHeight    - current local chain head height (or null if unknown)
//   lastHeight/At - the last height we saw increase, and when (ms epoch)
//   now           - current time (ms epoch)
//   stallMs       - how long the head may stay flat before we call it wedged
function assessHealth({
  services,
  producing = false,
  headHeight = null,
  probeFailed = false,
  lastHeight = null,
  lastHeightAt = null,
  now = 0,
  stallMs = 8 * 60 * 1000,
}) {
  const rows = Array.isArray(services) ? services : [];
  // Missing status is unknown health. The watchdog does not restart on no-data.
  if (rows.length === 0) return { ok: false, reason: "no-data", oom: false };

  const byName = new Map(
    rows.map((r) => [String(r?.service ?? r?.name ?? ""), r])
  );
  const expected = coreServicesFor(producing);

  let anyOom = false;
  for (const name of expected) {
    const row = byName.get(name);
    if (!row) {
      // A core container has vanished from a non-empty service list — it crashed
      // out of the set entirely.
      return { ok: false, reason: "service-down", oom: false, service: name };
    }
    const t = serviceTrouble(row);
    if (t.down) {
      return { ok: false, reason: t.oom ? "oom" : "service-down", oom: t.oom, service: name };
    }
    if (t.oom) anyOom = true;
  }

  if (rows.some(r => expected.includes(r.service) && r.health === "starting")) {
    return { ok: false, reason: "starting", oom: anyOom };
  }

  if (probeFailed && lastHeightAt != null && now - lastHeightAt > stallMs) {
    return { ok: false, reason: "chain-unresponsive", oom: anyOom, service: "chain" };
  }

  if (probeFailed) return { ok: false, reason: "rpc-unavailable", oom: anyOom, service: "jsonrpc" };

  // Every container claims "up" but the chain head hasn't moved for too long:
  // the node is wedged (the classic block_store-starves-chain deadlock).
  if (
    headHeight != null &&
    lastHeight != null &&
    lastHeightAt != null &&
    Number(headHeight) <= Number(lastHeight) &&
    now - lastHeightAt > stallMs
  ) {
    return { ok: false, reason: "stalled", oom: anyOom };
  }

  return { ok: true, reason: null, oom: anyOom };
}

// One plain-English sentence describing why we're restarting — no jargon.
function describeRecovery(reason, oom) {
  if (oom || reason === "oom") return "Your node ran low on memory and stopped.";
  if (reason === "stalled") return "Your node stopped keeping up with the network.";
  if (reason === "broker-unavailable") return "Your node’s internal message service is unavailable.";
  if (reason === "service-down") return "Part of your node stopped unexpectedly.";
  return "Your node stopped responding.";
}

// Recommend how much memory/swap to give the WSL 2 VM based on the host's total
// RAM. Conservative: leaves clear headroom for Windows and the app, caps the top
// end, and never suggests starving the host. Values are whole GB.
function recommendWslMemory(totalBytes) {
  const hostGB = Math.max(1, Math.round(Number(totalBytes) / GiB));
  const reserve = Math.max(3, Math.round(hostGB * 0.25)); // headroom for Windows
  let memoryGB = Math.min(hostGB - reserve, Math.floor(hostGB * 0.7));
  memoryGB = Math.max(4, Math.min(24, memoryGB));
  // Hard floor: never leave the host with less than 2 GB.
  memoryGB = Math.min(memoryGB, Math.max(2, hostGB - 2));
  const swapGB = 8; // swap is cheap insurance against OOM spikes
  return { hostGB, memoryGB, swapGB };
}

// Parse a WSL memory value ("8GB", "4096MB", "8") into GB, or null if unparseable.
function parseSizeGB(v) {
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(gb|g|mb|m|kb|k|b)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || "GB").toLowerCase();
  if (unit.startsWith("g")) return n;
  if (unit.startsWith("m")) return n / 1024;
  if (unit.startsWith("k")) return n / (1024 * 1024);
  if (unit === "b") return n / GiB;
  return n;
}

// Merge desired memory/swap into an existing .wslconfig, preserving every other
// key, section, and comment. Only ever RAISES a value (never lowers a limit the
// user set on purpose), and adds a [wsl2] section if missing. Returns
// { text, changed, memoryGB, swapGB }.
function mergeWslConfig(existing, { memoryGB, swapGB }) {
  const want = { memory: memoryGB, swap: swapGB };
  const lines = String(existing || "").split(/\r?\n/);
  let inWsl2 = false;
  let sawWsl2 = false;
  const idx = {}; // key -> line index within [wsl2]
  const have = {}; // key -> current value in GB

  for (let i = 0; i < lines.length; i++) {
    const sec = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
    if (sec) {
      inWsl2 = sec[1].trim().toLowerCase() === "wsl2";
      if (inWsl2) sawWsl2 = true;
      continue;
    }
    if (!inWsl2) continue;
    const kv = lines[i].match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (kv) {
      const k = kv[1].toLowerCase();
      if (k === "memory" || k === "swap") {
        idx[k] = i;
        have[k] = parseSizeGB(kv[2]);
      }
    }
  }

  let changed = false;
  const fmt = (k) => `${k}=${want[k]}GB`;

  // Raise existing keys only.
  for (const k of ["memory", "swap"]) {
    if (idx[k] != null) {
      const cur = have[k];
      if (cur == null || cur < want[k]) {
        lines[idx[k]] = fmt(k);
        changed = true;
      }
    }
  }

  // Add whichever keys are missing.
  const missing = ["memory", "swap"].filter((k) => idx[k] == null);
  if (missing.length) {
    changed = true;
    const additions = missing.map(fmt);
    if (sawWsl2) {
      const header = lines.findIndex((l) => /^\s*\[wsl2\]\s*$/i.test(l));
      lines.splice(header + 1, 0, ...additions);
    } else {
      if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
      lines.push("[wsl2]", ...additions);
    }
  }

  let text = lines.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  return { text, changed, memoryGB: want.memory, swapGB: want.swap };
}

// Classify a crash from a service's recent log text so the app can pick the
// RIGHT remedy instead of blindly restarting. Some failures a restart fixes;
// a code panic alone is not evidence that rebuilding data will help.
//   "oom"        -> killed for memory (restart + lighten footprint / more RAM)
//   "panic"      -> segfault / nil-pointer / Go panic (needs diagnosis)
//   "corruption" -> the database won't open cleanly (rebuild data)
//   null         -> nothing recognizable (treat as transient)
function classifyCrash(logText) {
  const t = String(logText || "");
  if (/\(137\)|signal:\s*killed|out of memory|cannot allocate memory|oom[-\s]?kill/i.test(t)) return "oom";
  if (/panic:|sigsegv|segmentation violation|nil pointer|invalid memory address|runtime error/i.test(t)) return "panic";
  if (/replayed state delta merkle root does not match block receipt/i.test(t)) return "replay-mismatch";
  if (/corruption|checksum mismatch|bad table|truncated|malformed|failed to open (the )?database/i.test(t))
    return "corruption";
  return null;
}

// The remedy a crash class calls for: "memory" (restart/lighten), "repair"
// (rebuild block data via Quick Sync), or null (just restart).
function crashRemedy(kind) {
  if (kind === "oom") return "memory";
  if (kind === "corruption" || kind === "replay-mismatch") return "repair";
  return null;
}

// How many times a panic must appear in the recent log tail before we treat the
// crash as a deterministic loop (vs. a one-off) and escalate to repair.
function isCrashLooping(logText, threshold = 2) {
  return (String(logText || "").match(/panic:/gi) || []).length >= threshold;
}

module.exports = {
  CORE_SERVICES,
  coreServicesFor,
  serviceTrouble,
  assessHealth,
  describeRecovery,
  recommendWslMemory,
  parseSizeGB,
  mergeWslConfig,
  classifyCrash,
  crashRemedy,
  isCrashLooping,
};
