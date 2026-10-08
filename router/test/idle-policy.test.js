"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { decideShare, IdleController, REASONS, IDLE_THRESHOLD_SEC } = require("../lib/idle-policy");
const {
  createMacSignals,
  parseLowPowerMode,
  isLaptopModel,
  hasInternalBattery,
  LOW_POWER_TTL_MS,
  PMSET,
  SYSCTL,
} = require("../lib/mac-signals");

const ACTIVE = "Starts when you step away";
const BATTERY = "Waiting for power";
const THERMAL = "Cooling down";
const LOW_POWER = "Low Power Mode is on";
const OTHER_APP = "Koinos AI is sharing this Mac";
const STOPPED = { run: false, reason: null, unload: false };
const RUN = { run: true, reason: null, unload: false };

// A Mac nobody is touching, on power, cool, Low Power Mode off.
const AWAY = Object.freeze({ idleSec: 600, onBattery: false, thermal: "nominal", lowPower: false });

function share(overrides = {}, signals = {}) {
  return decideShare({
    enabled: true,
    mode: "idle",
    pluggedInOnly: true,
    laptop: true,
    ...overrides,
    signals: { ...AWAY, ...signals },
  });
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// decideShare

test("reasons are the exact Share-row copy from the architecture copy table", () => {
  assert.deepEqual(
    { ...REASONS },
    { otherApp: OTHER_APP, lowPower: LOW_POWER, battery: BATTERY, thermal: THERMAL, active: ACTIVE },
  );
  assert.equal(IDLE_THRESHOLD_SEC, 300);
});

test("disabled never runs and gives no reason, whatever the signals say", () => {
  assert.deepEqual(share({ enabled: false }), STOPPED);
  assert.deepEqual(share({ enabled: false }, { idleSec: 0, onBattery: true, thermal: "critical", lowPower: true }), STOPPED);
  assert.deepEqual(share({ enabled: false, otherAppEarning: true }), STOPPED);
  assert.deepEqual(decideShare({ signals: AWAY }), STOPPED);
  assert.deepEqual(decideShare(), STOPPED);
});

test("idle mode runs once the Mac has been idle for the threshold, not before", () => {
  assert.deepEqual(share({}, { idleSec: 600 }), RUN);
  assert.deepEqual(share({}, { idleSec: 300 }), RUN);
  assert.deepEqual(share({}, { idleSec: 299 }), { run: false, reason: ACTIVE, unload: true });
  assert.deepEqual(share({}, { idleSec: 0 }), { run: false, reason: ACTIVE, unload: true });
});

test("idle mode defaults to the idle mode when mode is missing", () => {
  assert.deepEqual(share({ mode: undefined }, { idleSec: 10 }), { run: false, reason: ACTIVE, unload: true });
});

test("idleThresholdSec overrides the 5 minute default", () => {
  assert.deepEqual(share({ idleThresholdSec: 60 }, { idleSec: 60 }), RUN);
  assert.deepEqual(share({ idleThresholdSec: 60 }, { idleSec: 59 }).reason, ACTIVE);
  assert.deepEqual(share({ idleThresholdSec: 900 }, { idleSec: 600 }).reason, ACTIVE);
});

test("an unreadable idle time counts as the person being at the Mac", () => {
  for (const idleSec of [undefined, null, NaN, "soon", Infinity]) {
    assert.equal(share({}, { idleSec }).reason, ACTIVE, `idleSec ${String(idleSec)}`);
  }
});

test("a laptop unloads whenever sharing is paused; a desktop only when the full app takes over", () => {
  assert.equal(share({ laptop: true }, { idleSec: 5 }).unload, true);
  assert.equal(share({ laptop: false }, { idleSec: 5 }).unload, false);
  assert.equal(share({ laptop: undefined }, { idleSec: 5 }).unload, false);
  // Battery, heat, Low Power Mode and the other app keep the model warm even on a laptop.
  assert.deepEqual(share({ laptop: true }, { onBattery: true }), { run: false, reason: BATTERY, unload: true });
  assert.deepEqual(share({ laptop: true }, { thermal: "critical" }), { run: false, reason: THERMAL, unload: true });
  assert.deepEqual(share({ laptop: true }, { lowPower: true }), { run: false, reason: LOW_POWER, unload: true });
  // The full app earning here loads its own model: ours goes, laptop or not.
  assert.deepEqual(share({ laptop: true, otherAppEarning: true }), { run: false, reason: OTHER_APP, unload: true });
  assert.deepEqual(share({ laptop: false, mode: "always", otherAppEarning: true }), { run: false, reason: OTHER_APP, unload: true });
  // In use AND on battery: the battery is the reason shown, and a laptop still unloads.
  assert.deepEqual(share({ laptop: true }, { idleSec: 0, onBattery: true }), { run: false, reason: BATTERY, unload: true });
  assert.deepEqual(share({ laptop: false }, { onBattery: true }), { run: false, reason: BATTERY, unload: false });
  assert.equal(share({ laptop: true }).unload, false, "running never unloads");
});

test("always mode ignores idle time and never unloads for activity", () => {
  for (const idleSec of [0, 1, 299, undefined, NaN]) {
    assert.deepEqual(share({ mode: "always", laptop: true }, { idleSec }), RUN, `idleSec ${String(idleSec)}`);
  }
});

test("pluggedInOnly blocks on battery in both modes; off, battery is fine", () => {
  assert.deepEqual(share({ pluggedInOnly: true }, { onBattery: true }), { run: false, reason: BATTERY, unload: true });
  assert.deepEqual(share({ pluggedInOnly: true, mode: "always" }, { onBattery: true }), { run: false, reason: BATTERY, unload: true });
  assert.deepEqual(share({ pluggedInOnly: false }, { onBattery: true }), RUN);
  assert.deepEqual(share({ pluggedInOnly: false, mode: "always" }, { onBattery: true }), RUN);
  assert.deepEqual(share({ pluggedInOnly: true }, { onBattery: false }), RUN);
  assert.deepEqual(share({ pluggedInOnly: true }, { onBattery: undefined }), RUN, "unknown power is not battery");
});

test("thermal: idle mode backs off at serious, always mode only at critical", () => {
  const cases = [
    ["idle", "nominal", true],
    ["idle", "fair", true],
    ["idle", "serious", false],
    ["idle", "critical", false],
    ["idle", "unknown", true],
    ["idle", undefined, true],
    ["always", "nominal", true],
    ["always", "fair", true],
    ["always", "serious", true],
    ["always", "critical", false],
    ["always", "unknown", true],
  ];
  for (const [mode, thermal, run] of cases) {
    const d = share({ mode }, { thermal });
    assert.equal(d.run, run, `${mode}/${thermal}`);
    assert.equal(d.reason, run ? null : THERMAL, `${mode}/${thermal}`);
    assert.equal(d.unload, !run, `${mode}/${thermal}` + " (laptop: paused means unloaded)");
  }
});

test("Low Power Mode blocks in both modes", () => {
  assert.deepEqual(share({ mode: "idle" }, { lowPower: true }), { run: false, reason: LOW_POWER, unload: true });
  assert.deepEqual(share({ mode: "always" }, { lowPower: true }), { run: false, reason: LOW_POWER, unload: true });
  assert.deepEqual(share({}, { lowPower: false }), RUN);
});

test("the full KoinosAI app earning here blocks in both modes", () => {
  assert.deepEqual(share({ otherAppEarning: true }), { run: false, reason: OTHER_APP, unload: true });
  assert.deepEqual(share({ mode: "always", otherAppEarning: true }), { run: false, reason: OTHER_APP, unload: true });
  assert.deepEqual(share({ otherAppEarning: false }), RUN);
});

test("precedence: other app > Low Power Mode > battery > thermal > not idle", () => {
  const everything = { idleSec: 0, onBattery: true, thermal: "critical", lowPower: true };
  assert.equal(share({ otherAppEarning: true }, everything).reason, OTHER_APP);
  assert.equal(share({}, everything).reason, LOW_POWER);
  assert.equal(share({}, { ...everything, lowPower: false }).reason, BATTERY);
  assert.equal(share({}, { ...everything, lowPower: false, onBattery: false }).reason, THERMAL);
  assert.equal(share({}, { idleSec: 0, thermal: "serious" }).reason, THERMAL);
  assert.equal(share({}, { idleSec: 0 }).reason, ACTIVE);

  // Every pair, both ways round: the higher-ranked reason always wins.
  const ranked = [
    [OTHER_APP, { otherAppEarning: true }, {}],
    [LOW_POWER, {}, { lowPower: true }],
    [BATTERY, {}, { onBattery: true }],
    [THERMAL, {}, { thermal: "critical" }],
    [ACTIVE, {}, { idleSec: 0 }],
  ];
  for (let i = 0; i < ranked.length; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      const [winner, wInputs, wSignals] = ranked[i];
      const [, lInputs, lSignals] = ranked[j];
      const d = share({ ...wInputs, ...lInputs }, { ...wSignals, ...lSignals });
      assert.equal(d.reason, winner, `${winner} over ${ranked[j][0]}`);
      assert.equal(d.run, false);
    }
  }
});

test("missing or null signals block (as in use) rather than throw", () => {
  assert.deepEqual(decideShare({ enabled: true, laptop: true, signals: null }), { run: false, reason: ACTIVE, unload: true });
  assert.deepEqual(decideShare({ enabled: true, laptop: false }), { run: false, reason: ACTIVE, unload: false });
  assert.deepEqual(decideShare({ enabled: true, mode: "always", signals: {} }), RUN);
});

// ---------------------------------------------------------------------------
// IdleController

function fakeTimers() {
  const t = { scheduled: [], cleared: [] };
  t.setInterval = (fn, ms) => {
    const handle = { fn, ms, id: t.scheduled.length + 1 };
    t.scheduled.push(handle);
    return handle;
  };
  t.clearInterval = (handle) => t.cleared.push(handle);
  return t;
}

function harness({ inputs = {}, signals = AWAY, intervalMs, onEvent } = {}) {
  const h = {
    inputs: { enabled: true, mode: "idle", pluggedInOnly: true, laptop: true, ...inputs },
    signals: { ...signals },
    applied: [],
    events: [],
    reads: 0,
    readError: null,
    applyError: null,
    timers: fakeTimers(),
  };
  h.controller = new IdleController({
    inputs: () => h.inputs,
    readSignals: () => {
      h.reads++;
      if (h.readError) throw h.readError;
      return h.signals;
    },
    apply: (d) => {
      if (h.applyError) throw h.applyError;
      h.applied.push(d);
    },
    ...(intervalMs === undefined ? {} : { intervalMs }),
    setInterval: h.timers.setInterval,
    clearInterval: h.timers.clearInterval,
    onEvent: onEvent === undefined ? (e) => h.events.push(e) : onEvent,
  });
  return h;
}

test("start() schedules every 5 s by default and applies the first decision at once", () => {
  const h = harness();
  h.controller.start();
  assert.equal(h.timers.scheduled.length, 1);
  assert.equal(h.timers.scheduled[0].ms, 5000);
  assert.deepEqual(h.applied, [RUN]);

  h.controller.start();
  assert.equal(h.timers.scheduled.length, 1, "a second start is a no-op");
  assert.equal(h.applied.length, 1);
});

test("intervalMs is honoured and the scheduled callback ticks", () => {
  const h = harness({ intervalMs: 250 });
  h.controller.start();
  assert.equal(h.timers.scheduled[0].ms, 250);
  h.signals.idleSec = 1;
  h.timers.scheduled[0].fn();
  assert.deepEqual(h.applied, [RUN, { run: false, reason: ACTIVE, unload: true }]);
});

test("the first tick always applies, even when it says stopped", () => {
  const h = harness({ inputs: { enabled: false } });
  assert.deepEqual(h.controller.tick(), STOPPED);
  assert.deepEqual(h.applied, [STOPPED]);
});

test("tick() applies only when run, reason or unload changes", () => {
  const h = harness();
  assert.deepEqual(h.controller.tick(), RUN);
  h.controller.tick();
  h.signals.idleSec = 900; // still idle: same decision
  h.controller.tick();
  assert.equal(h.applied.length, 1);

  h.signals.idleSec = 3; // person comes back
  assert.deepEqual(h.controller.tick(), { run: false, reason: ACTIVE, unload: true });
  h.controller.tick();
  assert.equal(h.applied.length, 2);

  h.inputs.laptop = false; // only unload changes
  h.controller.tick();
  assert.deepEqual(h.applied[2], { run: false, reason: ACTIVE, unload: false });

  h.signals.onBattery = true; // only reason changes
  h.controller.tick();
  assert.deepEqual(h.applied[3], { run: false, reason: BATTERY, unload: false });

  h.signals = { ...AWAY }; // back to running
  h.controller.tick();
  assert.deepEqual(h.applied[4], RUN);
  assert.equal(h.applied.length, 5);
});

test("tick() returns the decision even when nothing is applied", () => {
  const h = harness();
  h.controller.tick();
  assert.deepEqual(h.controller.tick(), RUN);
  assert.equal(h.applied.length, 1);
});

test("inputs are passed through to decideShare", () => {
  const h = harness({
    inputs: { mode: "always", pluggedInOnly: false, otherAppEarning: false, idleThresholdSec: 10 },
    signals: { ...AWAY, idleSec: 0, onBattery: true, thermal: "serious" },
  });
  assert.deepEqual(h.controller.tick(), RUN);
  h.inputs.otherAppEarning = true;
  assert.deepEqual(h.controller.tick(), { run: false, reason: OTHER_APP, unload: true });
  h.inputs = { enabled: true, mode: "idle", idleThresholdSec: 10, laptop: true };
  h.signals = { ...AWAY, idleSec: 10 };
  assert.deepEqual(h.controller.tick(), RUN);
});

test("share off skips reading signals", () => {
  const h = harness({ inputs: { enabled: false } });
  h.controller.tick();
  h.controller.tick();
  assert.equal(h.reads, 0);
  h.inputs.enabled = true;
  h.controller.tick();
  assert.equal(h.reads, 1);
});

test("stop() clears the interval it started; start() again re-applies", () => {
  const h = harness();
  h.controller.start();
  h.controller.stop();
  assert.deepEqual(h.timers.cleared, [h.timers.scheduled[0]]);
  h.controller.stop();
  assert.equal(h.timers.cleared.length, 1, "a second stop is a no-op");

  h.controller.start();
  assert.equal(h.timers.scheduled.length, 2);
  assert.deepEqual(h.applied, [RUN, RUN], "a restart re-asserts the decision");
});

test("a readSignals error is treated as stopped, applied once and logged once per streak", () => {
  const h = harness();
  h.controller.tick();
  assert.deepEqual(h.applied, [RUN]);

  h.readError = new Error("powerMonitor went away");
  assert.deepEqual(h.controller.tick(), STOPPED);
  assert.deepEqual(h.controller.tick(), STOPPED);
  assert.deepEqual(h.controller.tick(), STOPPED);
  assert.deepEqual(h.applied, [RUN, STOPPED]);
  const errors = h.events.filter((e) => e.type === "idle:signals-error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "powerMonitor went away");

  h.readError = null;
  assert.deepEqual(h.controller.tick(), RUN);
  assert.deepEqual(h.applied, [RUN, STOPPED, RUN]);
  assert.equal(h.events.filter((e) => e.type === "idle:signals-recovered").length, 1);

  h.readError = "not even an Error";
  h.controller.tick();
  const again = h.events.filter((e) => e.type === "idle:signals-error");
  assert.equal(again.length, 2, "a new streak logs again");
  assert.equal(again[1].message, "not even an Error");
});

test("the first tick after a readSignals error applies stopped", () => {
  const h = harness();
  h.readError = new Error("boom");
  assert.deepEqual(h.controller.tick(), STOPPED);
  assert.deepEqual(h.applied, [STOPPED]);
});

test("onEvent is optional", () => {
  const timers = fakeTimers();
  const applied = [];
  const controller = new IdleController({
    inputs: () => ({ enabled: true }),
    readSignals: () => {
      throw new Error("no signals");
    },
    apply: (d) => applied.push(d),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  assert.doesNotThrow(() => controller.start());
  assert.deepEqual(applied, [STOPPED]);
  controller.stop();
});

test("an apply() that throws is logged and retried on the next tick", () => {
  const h = harness();
  h.applyError = new Error("runtime busy");
  assert.doesNotThrow(() => h.controller.tick());
  assert.equal(h.applied.length, 0);
  assert.equal(h.events.filter((e) => e.type === "idle:apply-error").length, 1);

  h.applyError = null;
  h.controller.tick();
  assert.deepEqual(h.applied, [RUN], "the unchanged decision is applied once apply works");
});

// ---------------------------------------------------------------------------
// mac-signals

const PMSET_SAMPLE = [
  "System-wide power settings:",
  "Currently in use:",
  " standby              1",
  " hibernatefile        /var/vm/sleepimage",
  " powernap             1",
  " sleep                1 (sleep prevented by powerd)",
  " lowpowermode         0",
  " womp                 0",
  "",
].join("\n");
const pmsetWith = (lowPower) => PMSET_SAMPLE.replace("lowpowermode         0", `lowpowermode         ${lowPower}`);
const BATT_LAPTOP = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=23593059)\t100%; charged; 0:00 remaining present: true\n";
const BATT_DESKTOP = "Now drawing from 'AC Power'\n";

function fakePowerMonitor(overrides = {}) {
  return {
    idle: 42,
    battery: false,
    thermal: "nominal",
    getSystemIdleTime() {
      return this.idle;
    },
    isOnBatteryPower() {
      return this.battery;
    },
    getCurrentThermalState() {
      return this.thermal;
    },
    ...overrides,
  };
}

// execFile stand-in. `responses` maps "file args" to stdout, an Error, or a
// function returning either. With `manual`, callbacks wait for release().
function fakeExecFile(responses, { manual = false } = {}) {
  const calls = [];
  const pending = [];
  function execFile(file, args, opts, cb) {
    const key = `${file} ${args.join(" ")}`;
    calls.push({ file, args, opts, key });
    let r = responses[key];
    if (typeof r === "function") r = r();
    const finish = () => {
      if (r === undefined) return cb(Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" }), "", "");
      if (r instanceof Error) return cb(r, "", "");
      cb(null, r, "");
    };
    if (manual) pending.push(finish);
    else setImmediate(finish);
    return { pid: calls.length };
  }
  execFile.calls = calls;
  execFile.count = (key) => calls.filter((c) => c.key === key).length;
  execFile.release = () => {
    while (pending.length) pending.shift()();
  };
  return execFile;
}

const K_PMSET = `${PMSET} -g`;
const K_BATT = `${PMSET} -g batt`;
const K_MODEL = `${SYSCTL} -n hw.model`;

function clock(t = 1_000_000) {
  const c = { t, now: () => c.t };
  return c;
}

test("mac-signals does not require electron", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "mac-signals.js"), "utf8");
  assert.doesNotMatch(src, /require\(\s*["']electron["']\s*\)/);
  assert.throws(() => createMacSignals({}), /powerMonitor/);
});

test("parseLowPowerMode reads the lowpowermode line of `pmset -g`", () => {
  assert.equal(parseLowPowerMode(PMSET_SAMPLE), false);
  assert.equal(parseLowPowerMode(pmsetWith(1)), true);
  assert.equal(parseLowPowerMode(" lowpowermode 1\n"), true);
  assert.equal(parseLowPowerMode("System-wide power settings:\n sleep 1\n"), null);
  assert.equal(parseLowPowerMode(""), null);
  assert.equal(parseLowPowerMode(undefined), null);
});

test("isLaptopModel and hasInternalBattery", () => {
  assert.equal(isLaptopModel("MacBookPro18,3\n"), true);
  assert.equal(isLaptopModel("MacBookAir10,1"), true);
  assert.equal(isLaptopModel("Macmini9,1"), false);
  assert.equal(isLaptopModel("Mac15,6"), false);
  assert.equal(isLaptopModel(""), false);
  assert.equal(hasInternalBattery(BATT_LAPTOP), true);
  assert.equal(hasInternalBattery(BATT_DESKTOP), false);
});

test("read() maps powerMonitor straight through", async () => {
  const pm = fakePowerMonitor({ idle: 321, battery: true, thermal: "serious" });
  const execFile = fakeExecFile({ [K_PMSET]: PMSET_SAMPLE, [K_MODEL]: "MacBookPro18,3" });
  const signals = createMacSignals({ powerMonitor: pm, execFile, now: clock().now });
  await signals.ready;
  assert.deepEqual(signals.read(), { idleSec: 321, onBattery: true, thermal: "serious", lowPower: false });
  pm.idle = 0;
  pm.battery = false;
  pm.thermal = "fair";
  assert.deepEqual(signals.read(), { idleSec: 0, onBattery: false, thermal: "fair", lowPower: false });
});

test("thermal is unknown when Electron lacks the API or reports something unexpected", async () => {
  const execFile = fakeExecFile({ [K_PMSET]: PMSET_SAMPLE, [K_MODEL]: "Macmini9,1", [K_BATT]: BATT_DESKTOP });
  const noApi = fakePowerMonitor({ getCurrentThermalState: undefined });
  assert.equal(createMacSignals({ powerMonitor: noApi, execFile, now: clock().now }).read().thermal, "unknown");
  const odd = fakePowerMonitor({ thermal: "toasty" });
  assert.equal(createMacSignals({ powerMonitor: odd, execFile, now: clock().now }).read().thermal, "unknown");
  const crit = fakePowerMonitor({ thermal: "critical" });
  assert.equal(createMacSignals({ powerMonitor: crit, execFile, now: clock().now }).read().thermal, "critical");
  await flush();
});

test("Low Power Mode comes from `pmset -g` in the background; read() never waits for it", async () => {
  const execFile = fakeExecFile({ [K_PMSET]: pmsetWith(1), [K_MODEL]: "MacBookPro18,3" }, { manual: true });
  const signals = createMacSignals({ powerMonitor: fakePowerMonitor(), execFile, now: clock().now });

  // pmset has been spawned but not answered: read() returns at once, with the default.
  assert.equal(execFile.count(K_PMSET), 1);
  assert.equal(signals.read().lowPower, false);
  assert.equal(execFile.count(K_PMSET), 1, "an in-flight probe is not spawned twice");

  execFile.release();
  await signals.ready;
  assert.equal(signals.read().lowPower, true);
  const call = execFile.calls.find((c) => c.key === K_PMSET);
  assert.equal(call.file, "/usr/bin/pmset");
  assert.ok(call.opts.timeout > 0, "probes carry a timeout");
});

test("pmset runs at most once a minute", async () => {
  const c = clock();
  let low = 0;
  const execFile = fakeExecFile({ [K_PMSET]: () => pmsetWith(low), [K_MODEL]: "MacBookPro18,3" });
  const signals = createMacSignals({ powerMonitor: fakePowerMonitor(), execFile, now: c.now });
  await signals.ready;
  assert.equal(execFile.count(K_PMSET), 1);
  assert.equal(signals.read().lowPower, false);

  low = 1;
  for (let i = 0; i < 11; i++) {
    c.t += 5000; // the controller's tick
    signals.read();
  }
  await flush();
  assert.equal(c.t - 1_000_000, 55_000);
  assert.equal(execFile.count(K_PMSET), 1, "no re-run inside 60 s");
  assert.equal(signals.read().lowPower, false, "still the cached value");

  c.t += 5000; // 60 s since the first run
  assert.equal(signals.read().lowPower, false, "the refresh is not awaited");
  assert.equal(execFile.count(K_PMSET), 2);
  await flush();
  assert.equal(signals.read().lowPower, true);
  assert.equal(execFile.count(K_PMSET), 2);

  c.t += LOW_POWER_TTL_MS - 1;
  signals.read();
  assert.equal(execFile.count(K_PMSET), 2);
  c.t += 1;
  signals.read();
  assert.equal(execFile.count(K_PMSET), 3);
  await flush();
});

test("a failed pmset keeps the last known Low Power Mode value", async () => {
  const c = clock();
  let reply = pmsetWith(1);
  const events = [];
  const execFile = fakeExecFile({ [K_PMSET]: () => reply, [K_MODEL]: "MacBookPro18,3" });
  const signals = createMacSignals({ powerMonitor: fakePowerMonitor(), execFile, now: c.now, onEvent: (e) => events.push(e) });
  await signals.ready;
  assert.equal(signals.read().lowPower, true);

  reply = new Error("pmset timed out");
  c.t += LOW_POWER_TTL_MS;
  signals.read();
  await flush();
  assert.equal(signals.read().lowPower, true);
  assert.ok(events.some((e) => e.type === "mac-signals:probe-failed" && /timed out/.test(e.message)));

  reply = PMSET_SAMPLE.replace(/ lowpowermode.*\n/, ""); // line missing (older macOS): off
  c.t += LOW_POWER_TTL_MS;
  signals.read();
  await flush();
  assert.equal(signals.read().lowPower, false);
});

test("an execFile that throws synchronously is survived", async () => {
  const events = [];
  const execFile = () => {
    throw new Error("spawn EAGAIN");
  };
  const signals = createMacSignals({ powerMonitor: fakePowerMonitor(), execFile, now: clock().now, onEvent: (e) => events.push(e) });
  await signals.ready;
  assert.equal(signals.read().lowPower, false);
  assert.equal(signals.isLaptop(), false);
  assert.ok(events.length >= 1);
});

test("isLaptop is false until probed, true for a MacBook model, and probed only once", async () => {
  const execFile = fakeExecFile({ [K_PMSET]: PMSET_SAMPLE, [K_MODEL]: "MacBookPro18,3\n" }, { manual: true });
  const signals = createMacSignals({ powerMonitor: fakePowerMonitor(), execFile, now: clock().now });
  assert.equal(signals.isLaptop(), false, "sync default before the probe answers");
  execFile.release();
  await signals.ready;
  assert.equal(signals.isLaptop(), true);
  for (let i = 0; i < 5; i++) signals.isLaptop();
  assert.equal(execFile.count(K_MODEL), 1);
  assert.equal(execFile.count(K_BATT), 0, "a MacBook model needs no battery check");
  assert.equal(execFile.calls.find((c) => c.key === K_MODEL).file, "/usr/sbin/sysctl");
});

test("isLaptop falls back to the internal battery for Mac14,x-style MacBook ids", async () => {
  const execFile = fakeExecFile({ [K_PMSET]: PMSET_SAMPLE, [K_MODEL]: "Mac15,6\n", [K_BATT]: BATT_LAPTOP });
  const signals = createMacSignals({ powerMonitor: fakePowerMonitor(), execFile, now: clock().now });
  await signals.ready;
  assert.equal(signals.isLaptop(), true);
  assert.equal(execFile.count(K_BATT), 1);
});

test("isLaptop is false for a desktop Mac, and when both probes fail", async () => {
  const desktop = fakeExecFile({ [K_PMSET]: PMSET_SAMPLE, [K_MODEL]: "Macmini9,1\n", [K_BATT]: BATT_DESKTOP });
  const a = createMacSignals({ powerMonitor: fakePowerMonitor(), execFile: desktop, now: clock().now });
  await a.ready;
  assert.equal(a.isLaptop(), false);

  const broken = fakeExecFile({ [K_PMSET]: PMSET_SAMPLE });
  const b = createMacSignals({ powerMonitor: fakePowerMonitor(), execFile: broken, now: clock().now });
  await b.ready;
  assert.equal(b.isLaptop(), false);
  assert.equal(broken.count(K_MODEL), 1);
  assert.equal(broken.count(K_BATT), 1, "a failed sysctl still checks for a battery");
});

test("mac-signals feeds the controller end to end", async () => {
  const pm = fakePowerMonitor({ idle: 400 });
  const execFile = fakeExecFile({ [K_PMSET]: PMSET_SAMPLE, [K_MODEL]: "MacBookAir10,1" });
  const signals = createMacSignals({ powerMonitor: pm, execFile, now: clock().now });
  await signals.ready;
  const timers = fakeTimers();
  const applied = [];
  const controller = new IdleController({
    inputs: () => ({ enabled: true, mode: "idle", pluggedInOnly: true, laptop: signals.isLaptop() }),
    readSignals: () => signals.read(),
    apply: (d) => applied.push(d),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  controller.start();
  pm.idle = 2;
  timers.scheduled[0].fn();
  pm.battery = true;
  timers.scheduled[0].fn();
  controller.stop();
  assert.deepEqual(applied, [
    RUN,
    { run: false, reason: ACTIVE, unload: true },
    { run: false, reason: BATTERY, unload: true },
  ]);
});
