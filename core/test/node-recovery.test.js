"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const yaml = require("js-yaml");
const { NodeManager, buildEnv, buildConfigYml } = require("../lib/koinos/node-manager");
const { NETWORKS } = require("../lib/koinos/constants");
const { assessHealth, CORE_SERVICES, crashRemedy } = require("../lib/koinos/node-health");
const { currentLogs, inspectLogs } = require("../lib/koinos/node-maintenance");
const templateRoot = path.join(__dirname, "../koinos-node-template");
const mismatch = "replayed state delta merkle root does not match block receipt";
const healthy = () => CORE_SERVICES.map(service => ({ service, state: "running", health: service === "amqp" ? "healthy" : "" }));
function fixture(t, opts = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kai-recovery-"));
  const mgr = new NodeManager({ dataRoot, templateRoot, ...opts });
  t.after(() => { mgr._stopWatchdog(); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  return mgr;
}
function watch(mgr) {
  mgr._desiredRunning = true; mgr._startWatchdog("mainnet", false, null, false);
  mgr._watch.graceUntil = 0; return mgr._watch;
}

test("every AMQP client waits for broker readiness on Linux, Windows and macOS", t => {
  for (const platform of ["linux", "win32", "darwin"]) {
    const mgr = fixture(t, { platform });
    const dir = mgr.ensureFiles("mainnet", null);
    const { services } = yaml.load(fs.readFileSync(path.join(dir.root, "docker-compose.yml"), "utf8"));
    assert.match(services.amqp.healthcheck.test[1], /check_running.*check_port_listener 5672/);
    assert.equal(services.amqp.healthcheck.start_period, "120s");
    for (const [name, service] of Object.entries(services)) {
      if (["amqp", "rest"].includes(name)) continue;
      assert.equal(service.depends_on.amqp.condition, "service_healthy", name);
    }
    assert.deepEqual(services.jsonrpc.ports, ["${JSONRPC_INTERFACE:-127.0.0.1}:${JSONRPC_PORT:-8080}:8080"]);
  }
});

test("memory saver retains local RPC and uses fewer service jobs", () => {
  for (const producing of [false, true]) {
    const env = buildEnv(NETWORKS.mainnet, "/fixture", producing, true);
    assert.match(env, /^COMPOSE_PROFILES=jsonrpc(?:,block_producer)?$/m);
    assert.equal(env.includes(",block_producer"), producing);
  }
  assert.equal(yaml.load(buildConfigYml(NETWORKS.mainnet, null, { memorySaver: true })).global.jobs, 2);
  assert.equal(yaml.load(buildConfigYml(NETWORKS.mainnet, null)).global.jobs, undefined);
});

test("missing, restarting, and unhealthy broker are detected even with other containers up", () => {
  for (const state of ["missing", "restarting", "created", "paused", "unhealthy"]) {
    let services = healthy();
    if (state === "missing") services = services.filter(s => s.service !== "amqp");
    else Object.assign(services[0], state === "unhealthy" ? { health: state } : { state });
    const h = assessHealth({ services });
    assert.equal(h.ok, false); assert.equal(h.service, "amqp");
    assert.equal(h.needsRepair, undefined);
  }
  const services = healthy(); services[0].health = "starting";
  assert.equal(assessHealth({ services }).reason, "starting");
  assert.equal(assessHealth({ services: healthy().filter(s => s.service !== "jsonrpc") }).service, "jsonrpc");
});

test("Docker inspection captures process lifetime and OOM without reading container secrets", async t => {
  const mgr = fixture(t); mgr.ensureFiles("mainnet", null);
  const id = "a".repeat(64), startedAt = "2026-09-28T19:03:54.000000000Z";
  mgr._compose = async () => ({ ok: true, stdout: JSON.stringify({ ID: id, Service: "amqp", State: "restarting", Health: "unhealthy" }) });
  mgr._exec = async (bin, args) => {
    assert.equal(bin, "docker"); assert.equal(args[0], "inspect"); assert.equal(args.at(-1), id);
    assert.doesNotMatch(args[2], /\.Config|\.Mounts|\.Env/);
    return { ok: true, stdout: JSON.stringify({ id, startedAt, oomKilled: true, exitCode: 137, restartCount: 4 }) };
  };
  const services = await mgr.services("mainnet");
  assert.equal(services[0].startedAt, startedAt);
  assert.equal(assessHealth({ services }).reason, "oom");
});

test("old replay failures cannot poison the new process, but current failures stay visible", async t => {
  const mgr = fixture(t), services = healthy();
  const chain = services.find(s => s.service === "chain");
  chain.id = "a".repeat(64); chain.startedAt = "2026-09-28T18:00:00Z";
  let text = `chain-1 | 2026-09-28T18:01:00.000Z ${mismatch}`;
  mgr._compose = async () => ({ ok: true, stdout: text, stderr: "" });
  assert.equal((await mgr.observe("mainnet", services)).health.needsRepair, true);
  chain.startedAt = "2026-09-28T19:03:54Z";
  assert.equal((await mgr.observe("mainnet", services)).health.ok, true, "restart invalidates the cache immediately");
  mgr._observations.get("mainnet").at = 0;
  text += `\nchain-1 | 2026-09-28T19:04:01.000Z ${mismatch}`;
  assert.equal((await mgr.observe("mainnet", services)).health.needsRepair, true);
  assert.equal(inspectLogs(currentLogs(text, services)).health.reason, "replay-mismatch");
});

test("broker health takes precedence over dependent RPC timeout errors", async t => {
  const mgr = fixture(t), services = healthy(); services[0].health = "unhealthy";
  const timeout = "block_producer-1 | No response to client request abc within 30000ms";
  mgr._compose = async () => ({ ok: true, stdout: `${timeout}\n${timeout}`, stderr: "" });
  const h = (await mgr.observe("mainnet", services)).health;
  assert.equal(h.reason, "broker-unavailable"); assert.equal(h.needsRepair, undefined);
});

test("repeated broker restart failures back off and never request a blockchain rebuild", async t => {
  const events = [], mgr = fixture(t, { onEvent: e => events.push(e.message) }), w = watch(mgr);
  mgr.services = async () => healthy(); mgr.logs = async () => "connection refused";
  mgr._restartStack = async () => { throw Error("broker healthcheck failed"); };
  for (let i = 0; i < 5; i++) await mgr._recover(w, { ok: false, reason: "broker-unavailable", service: "amqp" });
  assert.equal(w.needsRepair, false); assert.equal(w.attempts.length, 5);
  assert.ok(w.graceUntil - Date.now() > 14 * 60000);
  assert.match(w.lastRecoveryError, /healthcheck failed/);
  assert.doesNotMatch(events.join("\n"), /corrupt|Quick Sync|back up and running/);
  assert.equal(crashRemedy("panic"), null);
});

test("fresh database corruption still stops automatic recovery", async t => {
  const mgr = fixture(t), w = watch(mgr);
  mgr.services = async () => healthy(); mgr.logs = async () => mismatch;
  mgr._restartStack = async () => assert.fail("must not restart invalid chain data");
  await mgr._recover(w, { ok: false, reason: "service-down", service: "chain" });
  assert.equal(w.needsRepair, true); assert.equal(w.repairReason, "replay-mismatch");
});

test("watchdog recovers unhealthy broker and respects automatic recovery off", async t => {
  for (const autoRecover of [true, false]) {
    const mgr = fixture(t, { autoRecover }), w = watch(mgr), services = healthy();
    services[0].health = "unhealthy";
    mgr.services = async () => services; mgr._compose = async () => ({ ok: true, stdout: "", stderr: "" });
    let restarts = 0; mgr._recover = async (_, h) => { assert.equal(h.service, "amqp"); restarts++; };
    await mgr._watchTick(); assert.equal(restarts, autoRecover ? 1 : 0);
    assert.equal(w.health.reason, "broker-unavailable"); assert.equal(w.checking, false);
  }
});

test("watchdog polls never overlap while a probe is pending", async t => {
  let finish, probes = 0;
  const mgr = fixture(t, { probeHead: () => { probes++; return new Promise(r => { finish = r; }); } }); watch(mgr);
  mgr.services = async () => healthy(); mgr.observe = async () => ({ health: { ok: true } });
  const first = mgr._watchTick(); await new Promise(r => setImmediate(r));
  await mgr._watchTick(); assert.equal(probes, 1); finish(100); await first;
});

test("reopening the app adopts running configuration but never starts a stopped node", t => {
  const mgr = fixture(t); mgr.ensureFiles("mainnet", "1MHGDygf9ZKmspo3gwKuMiBzBWLURPYAMD", { memorySaver: true });
  mgr._adoptRunning("mainnet", []); assert.equal(mgr._watch, null);
  mgr._adoptRunning("mainnet", [...healthy(), { service: "block_producer", state: "running" }]);
  assert.equal(mgr._watch.producerAddress, "1MHGDygf9ZKmspo3gwKuMiBzBWLURPYAMD");
  assert.equal(mgr._watch.memorySaver, true);
  mgr._stopWatchdog(); mgr._desiredRunning = false;
  mgr._adoptRunning("mainnet", healthy()); assert.equal(mgr._watch, null);
});

test("Stop during recovery down prevents up; Quick Sync cannot overlap recovery", async t => {
  const mgr = fixture(t), w = watch(mgr), calls = []; mgr.ensureFiles("mainnet", null);
  let release;
  mgr._compose = async (_, args) => { calls.push(args[0]); return new Promise(r => { release = r; }); };
  mgr._composeOp = async (_, name) => { calls.push(name); };
  const recovery = mgr._restartStack(w);
  await assert.rejects(mgr.quickSync("mainnet"), /still running/);
  const stopping = mgr.stop("mainnet");
  release({ ok: true }); await recovery; await stopping;
  assert.deepEqual(calls, ["down", "stop"]); assert.equal(mgr._desiredRunning, false);
});

test("Stop arriving during recovery up is serialized after it", async t => {
  const mgr = fixture(t), w = watch(mgr), calls = []; mgr.ensureFiles("mainnet", null);
  let release;
  mgr._compose = async (_, args) => {
    calls.push(args[0]);
    return args[0] === "down" ? { ok: true } : new Promise(r => { release = r; });
  };
  mgr._composeOp = async (_, name) => { calls.push(name); };
  const recovery = mgr._restartStack(w); await new Promise(r => setImmediate(r));
  const stopping = mgr.stop("mainnet"); assert.deepEqual(calls, ["down", "up"]);
  release({ ok: true }); assert.equal(await recovery, false); await stopping;
  assert.deepEqual(calls, ["down", "up", "stop"]);
});

test("a broker restart cannot clear an unresolved failure in the same chain process", async t => {
  const mgr = fixture(t), services = healthy();
  services.find(s => s.service === "chain").startedAt = "2026-09-28T18:00:00Z";
  services[0].startedAt = "2026-09-28T18:00:00Z";
  let text = `chain-1 | 2026-09-28T18:01:00Z ${mismatch}`;
  mgr._compose = async () => ({ ok: true, stdout: text, stderr: "" });
  await mgr.observe("mainnet", services);
  services[0].startedAt = "2026-09-28T19:00:00Z"; text = "";
  assert.equal((await mgr.observe("mainnet", services)).health.needsRepair, true);
});

test("old sticky repair state cannot disable recovery of a new process", async t => {
  const mgr = fixture(t), w = watch(mgr), services = healthy();
  w.needsRepair = true; w.repairService = "chain"; w.repairStartedAt = "2026-09-28T18:00:00Z";
  services.find(s => s.service === "chain").startedAt = "2026-09-28T19:00:00Z";
  services[0].health = "unhealthy";
  mgr.services = async () => services; mgr._compose = async () => ({ ok: true, stdout: "", stderr: "" });
  let recovered = false; mgr._recover = async () => { recovered = true; };
  await mgr._watchTick(); assert.equal(recovered, true); assert.equal(w.needsRepair, false);
});

test("producer timeouts cannot restart an advancing chain", async t => {
  const mgr = fixture(t, { probeHead: async () => 101 }), w = watch(mgr);
  w.lastHeight = 100; w.lastHeightAt = Date.now() - 10 * 60000;
  mgr.services = async () => healthy();
  mgr.observe = async () => ({ health: { ok: false, reason: "chain-unresponsive", service: "chain" } });
  mgr._recover = async () => assert.fail("progressing chain must not be restarted for producer timeouts");
  await mgr._watchTick(); assert.equal(w.health.ok, true);
  mgr.dockerInfo = async () => ({ ok: true }); mgr.filesReady = () => true;
  assert.equal((await mgr.status("mainnet")).health.ok, true);
});

test("a genuinely stalled chain is still recovered despite identical timeout logs", async t => {
  const mgr = fixture(t, { probeHead: async () => 100 }), w = watch(mgr);
  w.lastHeight = 100; w.lastHeightAt = Date.now() - 10 * 60000;
  mgr.services = async () => healthy();
  mgr.observe = async () => ({ health: { ok: false, reason: "chain-unresponsive", service: "chain" } });
  let recovered = false; mgr._recover = async (_, h) => { recovered = true; assert.equal(h.reason, "stalled"); };
  await mgr._watchTick(); assert.equal(recovered, true);
});
