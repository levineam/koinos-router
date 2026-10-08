"use strict";

const childProcess = require("child_process");

/*
 * Mac signals for the idle policy, read from Electron's powerMonitor.
 *
 * powerMonitor is injected (never required here) so this file loads in plain
 * Node for tests, and so it is only touched after `app` is ready.
 *
 * Two facts are not in powerMonitor and need a subprocess:
 *   - Low Power Mode: `pmset -g` prints "lowpowermode 1". read() runs on the
 *     idle controller's 5 s tick, so pmset runs in the background at most
 *     once a minute and read() returns the cached value; it never waits.
 *   - Laptop or not: fixed for the life of the process, probed once at
 *     creation. hw.model alone is not enough: Apple Silicon MacBooks from M2
 *     on report "Mac14,2"-style ids, so an internal battery also counts.
 */

const LOW_POWER_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5000;
// The laptop probe runs sysctl and then, only when the model id doesn't say
// MacBook, pmset: two probes back to back at worst. `ready` always settles
// within this bound (each probe is killed at its timeout), so the shell can
// wait for it in full before Share starts.
const LAPTOP_PROBE_MAX_MS = 2 * PROBE_TIMEOUT_MS;
// Absolute paths: an app launched from Finder gets launchd's minimal PATH, and
// nothing earlier on PATH should be able to stand in for these.
const PMSET = "/usr/bin/pmset";
const SYSCTL = "/usr/sbin/sysctl";
const THERMAL_STATES = new Set(["nominal", "fair", "serious", "critical"]);

/** true/false from `pmset -g` output; null when the line is absent (older macOS). */
function parseLowPowerMode(stdout) {
  const m = /^\s*lowpowermode\s+(\d+)/m.exec(String(stdout || ""));
  return m ? m[1] !== "0" : null;
}

function isLaptopModel(stdout) {
  return /MacBook/i.test(String(stdout || ""));
}

function hasInternalBattery(stdout) {
  return /InternalBattery/i.test(String(stdout || ""));
}

function createMacSignals({
  powerMonitor,
  execFile = childProcess.execFile,
  now = () => Date.now(),
  lowPowerTtlMs = LOW_POWER_TTL_MS,
  onEvent = () => {},
} = {}) {
  if (!powerMonitor) throw new TypeError("createMacSignals needs Electron's powerMonitor");
  let lowPower = false;
  let lowPowerCheckedAt = null;
  let lowPowerInFlight = null;
  let laptop = false;
  let laptopKnown = false;

  // Resolves with stdout, or null on any failure; never rejects.
  function run(file, args) {
    return new Promise((resolve) => {
      try {
        // SIGKILL: a probe that ignored SIGTERM would hold `ready` open.
        execFile(file, args, { timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true }, (err, stdout) => {
          if (err) {
            onEvent({ type: "mac-signals:probe-failed", command: file, message: err.message });
            return resolve(null);
          }
          resolve(String(stdout ?? ""));
        });
      } catch (err) {
        onEvent({ type: "mac-signals:probe-failed", command: file, message: err.message });
        resolve(null);
      }
    });
  }

  function refreshLowPower() {
    if (lowPowerInFlight) return lowPowerInFlight;
    lowPowerCheckedAt = now();
    lowPowerInFlight = run(PMSET, ["-g"]).then((stdout) => {
      lowPowerInFlight = null;
      // A failed probe keeps the last known value rather than flapping to "off".
      if (stdout === null) return;
      const parsed = parseLowPowerMode(stdout);
      lowPower = parsed === true;
    });
    return lowPowerInFlight;
  }

  function lowPowerStale() {
    return lowPowerCheckedAt === null || now() - lowPowerCheckedAt >= lowPowerTtlMs;
  }

  async function probeLaptop() {
    try {
      const model = await run(SYSCTL, ["-n", "hw.model"]);
      if (model !== null && isLaptopModel(model)) {
        laptop = true;
        return;
      }
      const batt = await run(PMSET, ["-g", "batt"]);
      laptop = batt !== null && hasInternalBattery(batt);
    } finally {
      laptopKnown = true;
    }
  }

  function thermalState() {
    if (typeof powerMonitor.getCurrentThermalState !== "function") return "unknown";
    const state = powerMonitor.getCurrentThermalState();
    return THERMAL_STATES.has(state) ? state : "unknown";
  }

  function read() {
    if (lowPowerStale()) refreshLowPower();
    return {
      idleSec: powerMonitor.getSystemIdleTime(),
      onBattery: Boolean(powerMonitor.isOnBatteryPower()),
      thermal: thermalState(),
      lowPower,
    };
  }

  function isLaptop() {
    return laptop;
  }

  /** false until the laptop probe has answered (or given up). */
  function isLaptopKnown() {
    return laptopKnown;
  }

  // Warm both caches now so the first decisions aren't made on defaults.
  const ready = Promise.all([refreshLowPower(), probeLaptop()]).then(() => {});

  return { read, isLaptop, isLaptopKnown, ready };
}

module.exports = {
  createMacSignals,
  parseLowPowerMode,
  isLaptopModel,
  hasInternalBattery,
  LOW_POWER_TTL_MS,
  PROBE_TIMEOUT_MS,
  LAPTOP_PROBE_MAX_MS,
  PMSET,
  SYSCTL,
};
