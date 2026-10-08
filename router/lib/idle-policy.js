"use strict";

/*
 * Idle policy: should Share compute be serving right now, and if not, why.
 *
 * Pure on purpose. The Mac signals come from Electron (mac-signals.js), the
 * toggles from settings; this module only turns them into a decision, so the
 * rules can be tested without a Mac or an Electron process.
 *
 * The rule is the load guard's, applied to a Mac: donate the machine when the
 * person is away, get out of the way the moment they are not. When several
 * things block sharing at once, the reason shown is the one the person can do
 * least about, so the row doesn't say "Starts when you step away" while the
 * Mac is also on battery and stepping away would change nothing.
 */

// Exact Share-row copy (router/ARCHITECTURE.md copy table).
const REASONS = Object.freeze({
  otherApp: "Koinos AI is sharing this Mac",
  lowPower: "Low Power Mode is on",
  battery: "Waiting for power",
  thermal: "Cooling down",
  active: "Starts when you step away",
});

const IDLE_THRESHOLD_SEC = 300;

// "always" exists for a Mac mini on a shelf; it may run warm but must not
// cook. Idle mode is a laptop someone will pick up, so it backs off earlier.
const BLOCKING_THERMAL = Object.freeze({
  idle: new Set(["serious", "critical"]),
  always: new Set(["critical"]),
});

const STOPPED = Object.freeze({ run: false, reason: null, unload: false });

function blockingReason({ mode, pluggedInOnly, signals, otherAppEarning, idleThresholdSec }) {
  const always = mode === "always";
  if (otherAppEarning) return REASONS.otherApp;
  if (signals.lowPower === true) return REASONS.lowPower;
  if (pluggedInOnly && signals.onBattery === true) return REASONS.battery;
  const thermal = always ? BLOCKING_THERMAL.always : BLOCKING_THERMAL.idle;
  if (thermal.has(signals.thermal)) return REASONS.thermal;
  // An unreadable idle time counts as "in use": guessing wrong that way only
  // costs earnings, guessing wrong the other way costs the person their Mac.
  const idleSec = Number(signals.idleSec);
  if (!always && !(Number.isFinite(idleSec) && idleSec >= idleThresholdSec)) return REASONS.active;
  return null;
}

function decideShare({
  enabled,
  mode = "idle",
  pluggedInOnly = false,
  laptop = false,
  signals = {},
  otherAppEarning = false,
  idleThresholdSec = IDLE_THRESHOLD_SEC,
} = {}) {
  if (!enabled) return { ...STOPPED };
  const reason = blockingReason({
    mode,
    pluggedInOnly,
    signals: signals || {},
    otherAppEarning,
    idleThresholdSec,
  });
  if (!reason) return { run: true, reason: null, unload: false };
  // The person coming back frees the model on a laptop: unified memory is what
  // they feel while working. The full KoinosAI app taking over frees it on any
  // Mac, so two models never sit in unified memory at once (MVP_SPEC §8.3).
  // Battery, heat or Low Power Mode on an otherwise idle Mac are better served
  // by keeping the model warm for when they clear.
  // A laptop gets its unified memory back whenever sharing is paused, not just
  // while the user is active: on battery, hot or in Low Power Mode it can be
  // hours before sharing resumes (field report: 2.9 GB held "Waiting for power").
  const unload = Boolean(laptop) || reason === REASONS.otherApp;
  return { run: false, reason, unload };
}

function sameDecision(a, b) {
  return a.run === b.run && a.reason === b.reason && a.unload === b.unload;
}

class IdleController {
  /**
   * @param {object} opts
   * @param {() => object} opts.inputs decideShare args minus `signals`
   * @param {() => object} opts.readSignals { idleSec, onBattery, thermal, lowPower }
   * @param {(decision: object) => void} opts.apply called only when the decision changes
   */
  constructor({
    inputs,
    readSignals,
    apply,
    intervalMs = 5000,
    setInterval: setIntervalFn = setInterval,
    clearInterval: clearIntervalFn = clearInterval,
    onEvent = () => {},
  } = {}) {
    this.inputs = inputs;
    this.readSignals = readSignals;
    this.apply = apply;
    this.intervalMs = intervalMs;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.onEvent = onEvent;
    this.timer = null;
    this.applied = null;
    this.failing = false;
  }

  start() {
    if (this.timer) return;
    // Whatever was applied before a stop may be stale; re-assert on start.
    this.applied = null;
    this.timer = this.setIntervalFn(() => this.tick(), this.intervalMs);
    if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
    this.tick();
  }

  stop() {
    if (!this.timer) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  tick() {
    const decision = this.decide();
    if (this.applied && sameDecision(this.applied, decision)) return decision;
    try {
      this.apply(decision);
      this.applied = decision;
    } catch (err) {
      // Left unapplied, so the next tick tries again.
      this.onEvent({ type: "idle:apply-error", message: errorMessage(err) });
    }
    return decision;
  }

  decide() {
    try {
      const inputs = this.inputs() || {};
      // Share off needs no signals; skip the read so pmset isn't spawned for nothing.
      const decision = inputs.enabled
        ? decideShare({ ...inputs, signals: this.readSignals() })
        : decideShare(inputs);
      if (this.failing) {
        this.failing = false;
        this.onEvent({ type: "idle:signals-recovered" });
      }
      return decision;
    } catch (err) {
      // Log the first failure of a streak only: this runs every 5 s.
      if (!this.failing) {
        this.failing = true;
        this.onEvent({ type: "idle:signals-error", message: errorMessage(err) });
      }
      return { ...STOPPED };
    }
  }
}

function errorMessage(err) {
  return (err && err.message) || String(err);
}

module.exports = { decideShare, IdleController, REASONS, IDLE_THRESHOLD_SEC };
