"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { NETWORKS } = require("./constants");
const { parseSha256File, analyzeMembers, requiredSpace, fmtBytes } = require("./quicksync-utils");
const { httpHead, httpGetText, httpDownload } = require("./download");
const { assessHealth, describeRecovery, classifyCrash } = require("./node-health");
const dataMove = require("./data-move");

const { assertRestoreReady, inspectLogs, currentLogs, backupList, deleteBackup, installSnapshot, preflightFolders } = require("./node-maintenance");
const OP_LOG_LIMIT = 400;
const ARCHIVE_NAME = "koinos-backup.tar.gz";

// ----- self-healing watchdog tuning -----
const WATCH_INTERVAL_MS = 45 * 1000; // how often we check the node's pulse
const WATCH_GRACE_MS = 2 * 60 * 1000; // ignore the first 2 min after start / a recovery (startup + resync)
const STALL_MS = 8 * 60 * 1000; // head height flat this long => chain wedged
const RECOVERY_WINDOW_MS = 30 * 60 * 1000; // window for counting recent auto-recoveries
const SAVER_AFTER_OOM = 2; // OOM-driven recoveries before switching to memory-saver
const CHRONIC_AFTER = 5; // low-memory recoveries in the window before we suggest the cloud
const MAX_BACKOFF_MS = 15 * 60 * 1000;

// Manages a per-network Koinos node directory containing the official
// docker-compose.yml plus generated .env and config files, and drives it
// through `docker compose`.
class NodeManager {
  constructor({ templateRoot, dataRoot, onEvent, autoRecover = true, probeHead = null, platform = process.platform }) {
    this.templateRoot = templateRoot;
    this.dataRoot = dataRoot;
    this.platform = platform;
    this.onEvent = onEvent || (() => {});
    this._composeCmd = null;
    this._op = null; // { name, network, running, startedAt, lines, code, error }
    // Self-healing: keep the node alive without the user ever touching Docker.
    this.autoRecover = autoRecover !== false;
    this.probeHead = probeHead; // async () => number|null  (local chain head height)
    this._desiredRunning = null; // null permits adopting an already-running stack after app reopen
    this._observations = new Map();
    this._watch = null; // live watchdog state while the node runs
  }

  dirs(networkId) {
    const root = path.join(this.dataRoot, networkId);
    return {
      root,
      config: path.join(root, "config"),
      basedir: path.join(root, "basedir"),
      producerKeyDir: path.join(root, "basedir", "block_producer"),
    };
  }

  // ---------- file generation ----------

  ensureFiles(networkId, producerAddress, opts = {}) {
    const net = NETWORKS[networkId];
    if (!net) throw new Error(`Unknown network: ${networkId}`);
    const d = this.dirs(networkId);
    fs.mkdirSync(d.config, { recursive: true });
    fs.mkdirSync(d.basedir, { recursive: true });

    const tpl = (...p) => path.join(this.templateRoot, ...p);
    const composeSource = fs.readFileSync(tpl("docker-compose.yml"), "utf8");
    fs.writeFileSync(
      path.join(d.root, "docker-compose.yml"),
      this.platform === "darwin" ? composeForMacos(composeSource) : composeSource
    );
    fs.copyFileSync(tpl("common", "koinos_descriptors.pb"), path.join(d.config, "koinos_descriptors.pb"));
    fs.copyFileSync(tpl("common", "rabbitmq.conf"), path.join(d.config, "rabbitmq.conf"));
    fs.copyFileSync(tpl(net.templateDir, "genesis_data.json"), path.join(d.config, "genesis_data.json"));

    fs.writeFileSync(path.join(d.config, "config.yml"), buildConfigYml(net, producerAddress, opts));
    if (this.platform === "darwin") stageMacosConfig(d);
    fs.writeFileSync(path.join(d.root, ".env"), buildEnv(net, d.basedir, !!producerAddress, opts.memorySaver));
    return d;
  }

  filesReady(networkId) {
    const d = this.dirs(networkId);
    return (
      fs.existsSync(path.join(d.root, "docker-compose.yml")) &&
      fs.existsSync(path.join(d.config, "config.yml"))
    );
  }

  readProducerPublicKey(networkId) {
    try {
      const p = path.join(this.dirs(networkId).producerKeyDir, "public.key");
      const v = fs.readFileSync(p, "utf8").trim();
      return v || null;
    } catch {
      return null;
    }
  }

  // ---------- docker plumbing ----------

  _exec(bin, args, opts = {}) {
    return new Promise((resolve) => {
      execFile(
        bin,
        args,
        {
          timeout: opts.timeout ?? 30000,
          cwd: opts.cwd,
          maxBuffer: 8 * 1024 * 1024,
          env: process.env,
          windowsHide: true,
        },
        (error, stdout, stderr) =>
          resolve({
            ok: !error,
            stdout: String(stdout || ""),
            stderr: String(stderr || ""),
            error: error ? String(error.message).split("\n")[0] : null,
          })
      );
    });
  }

  async composeCmd() {
    if (this._composeCmd) return this._composeCmd;
    if ((await this._exec("docker", ["compose", "version"], { timeout: 15000 })).ok) {
      this._composeCmd = { bin: "docker", pre: ["compose"] };
    } else if ((await this._exec("docker-compose", ["version"], { timeout: 15000 })).ok) {
      this._composeCmd = { bin: "docker-compose", pre: [] };
    }
    return this._composeCmd;
  }

  async dockerInfo() {
    const info = await this._exec("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 15000,
    });
    if (!info.ok) {
      const raw = `${info.stderr} ${info.error ?? ""}`.toLowerCase();
      const daemonDown = /connect|daemon|sock|pipe|permission|refused/.test(raw);
      const error = daemonDown
        ? "Docker is installed but the Docker engine isn't running (or isn't accessible). Start Docker and try again."
        : "Docker was not found. Install Docker Desktop (or Docker Engine + Compose).";
      return { ok: false, error };
    }
    if (!(await this.composeCmd())) {
      return { ok: false, error: "Docker Compose was not found (need `docker compose` v2 or `docker-compose`)." };
    }
    return { ok: true, serverVersion: info.stdout.trim() };
  }

  async _compose(networkId, args, opts = {}) {
    const cmd = await this.composeCmd();
    if (!cmd) throw new Error("Docker Compose not available");
    const net = NETWORKS[networkId];
    const d = this.dirs(networkId);
    return this._exec(cmd.bin, [...cmd.pre, "-p", net.composeProject, ...args], {
      cwd: d.root,
      ...opts,
    });
  }

  // Long-running compose command (up/down) with live output capture.
  async _composeOp(networkId, opName, args) {
    if (this._op?.running) {
      throw new Error(`Another node operation ("${this._op.name}") is still running`);
    }
    const cmd = await this.composeCmd();
    if (!cmd) throw new Error("Docker Compose not available");
    const net = NETWORKS[networkId];
    const d = this.dirs(networkId);
    const op = {
      name: opName,
      network: networkId,
      running: true,
      startedAt: Date.now(),
      finishedAt: null,
      lines: [],
      code: null,
      error: null,
    };
    this._op = op;
    const push = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        op.lines.push(t);
        if (op.lines.length > OP_LOG_LIMIT) op.lines.splice(0, op.lines.length - OP_LOG_LIMIT);
      }
    };
    this.onEvent({ type: "node", message: `${opName} started (${net.label})` });
    return new Promise((resolve) => {
      const child = spawn(cmd.bin, [...cmd.pre, "-p", net.composeProject, ...args], {
        cwd: d.root,
        env: process.env,
        windowsHide: true,
      });
      child.stdout.on("data", push);
      child.stderr.on("data", push);
      child.on("error", (e) => {
        op.running = false;
        op.finishedAt = Date.now();
        op.error = String(e.message);
        this.onEvent({ type: "node", level: "error", message: `${opName} failed: ${op.error}` });
        resolve(op);
      });
      child.on("close", (code) => {
        op.running = false;
        op.finishedAt = Date.now();
        op.code = code;
        if (code !== 0 && !op.error) {
          op.error = op.lines.slice(-3).join(" | ") || `exit code ${code}`;
        }
        this.onEvent({
          type: "node",
          level: code === 0 ? "info" : "error",
          message: code === 0 ? `${opName} finished` : `${opName} failed: ${op.error}`,
        });
        resolve(op);
      });
    });
  }

  // ---------- lifecycle ----------

  // producerAddress null -> sync-only node (no block_producer service).
  async start(networkId, producerAddress) {
    if (this._op?.running) throw new Error("Wait for the current node operation to finish.");
    assertRestoreReady(this.dirs(networkId).basedir);
    this._observations.delete(networkId);
    let memorySaver = this._watch?.memorySaver || false;
    try { memorySaver ||= /^  jobs: 2\s*$/m.test(fs.readFileSync(path.join(this.dirs(networkId).config, "config.yml"), "utf8")); } catch {}
    this.ensureFiles(networkId, producerAddress, { memorySaver });
    this._desiredRunning = true;
    // Fire and forget; callers poll status() / currentOp().
    this._composeOp(networkId, "start", ["up", "-d", "--remove-orphans"]);
    this._startWatchdog(networkId, !!producerAddress, producerAddress || null, memorySaver);
    return { started: true };
  }

  async stop(networkId) {
    if (this._op?.running && this._op.name !== "recover") throw new Error("Wait for the current node operation to finish.");
    this._desiredRunning = false;
    this._stopWatchdog();
    if (this._restartPending) await this._restartPending.catch(() => {});
    if (!this.filesReady(networkId)) return { stopped: true, note: "Node was never started" };
    this._composeOp(networkId, "stop", ["down", "--timeout", "60"]);
    return { stopping: true };
  }

  // ---------- self-healing watchdog ----------
  //
  // While the node is meant to be up, poll its pulse every WATCH_INTERVAL_MS. If
  // a core service is crash-looping (e.g. block_store OOM-killed) or the chain
  // wedges, restart the whole stack automatically and tell the user in one plain
  // sentence. Repeated low-memory crashes flip on memory-saver mode (a lighter
  // footprint) so it stops happening. The user never runs a command.

  setAutoRecover(on) {
    this.autoRecover = !!on;
    return this.autoRecover;
  }

  _startWatchdog(networkId, producing, producerAddress, memorySaver) {
    this._stopWatchdog();
    const now = Date.now();
    const w = {
      networkId,
      producing: !!producing,
      producerAddress: producerAddress || null,
      memorySaver: !!memorySaver,
      lastHeight: null,
      lastHeightAt: now,
      graceUntil: now + WATCH_GRACE_MS,
      recoveries: [], // timestamps of recent auto-recoveries
      attempts: [],
      checking: false,
      oomHits: 0,
      recovering: false,
      warnedChronic: false,
      needsRepair: false, // corrupted block data — a restart can't fix it
      repairReason: null,
      health: { ok: false, reason: "starting" },
      timer: null,
    };
    w.timer = setInterval(() => this._watchTick().catch(() => {}), WATCH_INTERVAL_MS);
    if (w.timer.unref) w.timer.unref();
    this._watch = w;
  }

  _stopWatchdog() {
    if (this._watch?.timer) clearInterval(this._watch.timer);
    this._watch = null;
  }

  async _watchTick() {
    const w = this._watch;
    if (!w || w.checking || w.recovering || !this._desiredRunning) return;
    if (this._op?.running) return; // a start/stop/quick-sync is already driving the stack

    w.checking = true;
    try {
      const services = await this.services(w.networkId).catch(() => []);
      let headHeight = null;
      if (this.probeHead) headHeight = await this.probeHead().catch(() => null);

      const now = Date.now();
      if (headHeight != null && (w.lastHeight == null || Number(headHeight) > Number(w.lastHeight))) {
        w.lastHeight = headHeight;
        w.lastHeightAt = now;
      }
      // Grace window: don't judge a node that's still starting up or resyncing.
      if (now < w.graceUntil) {
        w.health = { ok: false, reason: "starting" };
        return;
      }

      const observed = await this.observe(w.networkId, services);
      if (this._watch !== w || !this._desiredRunning || w.recovering || this._op?.running) return;
      const runtimeHealth = assessHealth({
        services,
        producing: w.producing,
        probeFailed: !!this.probeHead && headHeight == null,
        headHeight,
        lastHeight: w.lastHeight,
        lastHeightAt: w.lastHeightAt,
        now,
        stallMs: STALL_MS,
      });
      // Producer timeouts also occur during catch-up. Never restart an advancing
      // chain just because old timeout lines remain in the recent log window.
      const health = observed.health?.ok === false && observed.health.reason !== "chain-unresponsive"
        ? observed.health : runtimeHealth;
      w.health = health;
      const repairService = w.repairService || "chain";
      const lifetime = services.find(s => s.service === repairService)?.startedAt;
      if ((w.needsRepair && lifetime && w.repairStartedAt && lifetime !== w.repairStartedAt) ||
          (health.ok && (!this.probeHead || headHeight != null))) {
        w.needsRepair = false; w.repairReason = null;
      }
      if (health.needsRepair) {
        w.needsRepair = true;
        w.repairReason = health.reason;
        w.repairService = health.service;
        w.repairStartedAt = services.find(s => s.service === health.service)?.startedAt;
      }
      // Once we've concluded the block data is corrupted, stop restarting into the
      // same wall — wait for the user to repair (Quick Sync).
      if (!health.ok && !["no-data", "starting", "rpc-unavailable"].includes(health.reason) && this.autoRecover && !w.needsRepair) {
        await this._recover(w, health);
      }
    } finally { w.checking = false; }
  }

  async _recover(w, health) {
    if (!this._desiredRunning || this._watch !== w) return;
    w.recovering = true;

    // Use current-process logs to distinguish an actual database failure from
    // service, resource, or connectivity trouble before attempting recovery.
    let crash = null;
    let logText = "", services = [];
    try {
      services = await this.services(w.networkId).catch(() => []);
      logText = currentLogs(await this.logs(w.networkId, health.service || "chain", 80).catch(() => ""), services);
      crash = classifyCrash(logText);
    } catch {
      /* diagnosis is best-effort */
    }

    const now = Date.now();
    w.recoveries = w.recoveries.filter((t) => now - t < RECOVERY_WINDOW_MS);
    w.attempts = (w.attempts || []).filter(t => now - t < RECOVERY_WINDOW_MS);
    const recent = w.attempts.length;

    const memoryTrouble = crash === "oom" || health.oom || health.reason === "oom";
    const dataCrash = ["chain", "block_store"].includes(health.service) && ["corruption", "replay-mismatch"].includes(crash);

    // A broker outage, panic, or failed restart is not proof of damaged chain data.
    if (dataCrash) {
      w.needsRepair = true;
      w.repairReason = crash;
      w.repairService = health.service;
      w.repairStartedAt = services.find(s => s.service === health.service)?.startedAt;
      w.recovering = false;
      this.onEvent({
        type: "node",
        level: "warn",
        message:
          "Your node's block data looks corrupted — restarting can't fix it. Open the Node tab and click “Repair node data” to rebuild it from a verified snapshot (your wallet and keys are untouched).",
      });
      return;
    }

    if (this._watch !== w || !this._desiredRunning || this._op?.running) { w.recovering = false; return; }
    w.attempts.push(now);

    // Repeated low-memory crashes -> switch to a lighter footprint for good.
    let switchedSaver = false;
    if (memoryTrouble && !w.memorySaver) {
      w.oomHits += 1;
      if (w.oomHits >= SAVER_AFTER_OOM) {
        w.memorySaver = true;
        switchedSaver = true;
      }
    }

    this.onEvent({
      type: "node",
      message: switchedSaver
        ? "Your PC was running low on memory, so the app switched your node to a lighter mode and is restarting it. It'll keep running on its own."
        : `${describeRecovery(health.reason, health.oom)} Restarting it for you — you don't need to do anything.`,
    });

    try {
      const ok = await this._restartStack(w);
      if (ok) {
        w.lastRecoveryError = null;
        w.recoveries.push(Date.now());
        this.onEvent({ type: "node", message: "Node services restarted; checking the local RPC and chain progress." });
      }
    } catch (e) {
      w.lastRecoveryError = String(e.message || e).slice(0, 500);
      this.onEvent({
        type: "node", level: "error",
        message: `The app couldn't restart your node: ${w.lastRecoveryError}. It will retry with a delay.`,
      });
    }

    // Chronic low-memory trouble even after memory-saver: point at the cloud, once.
    w.recoveries = w.recoveries.filter((t) => Date.now() - t < RECOVERY_WINDOW_MS);
    if (memoryTrouble && w.recoveries.length >= CHRONIC_AFTER && !w.warnedChronic) {
      w.warnedChronic = true;
      this.onEvent({
        type: "node",
        level: "warn",
        message:
          "Your node keeps running low on memory on this PC. The app will keep restarting it for you, but for reliable 24/7 uptime you may want to run it in the cloud.",
      });
    }

    // Back off (grows with how often we've had to step in) so we never thrash,
    // and give the fresh stack time to resync before judging it again.
    const backoff = Math.min(MAX_BACKOFF_MS, WATCH_GRACE_MS * 2 ** Math.min(recent, 3));
    w.lastHeight = null;
    w.lastHeightAt = Date.now();
    w.graceUntil = Date.now() + backoff;
    w.recovering = false;
  }

  // Full-stack restart used by the watchdog. Regenerates .env (so memory-saver
  // profiles take effect) and cycles compose down/up. Guards against a user Stop
  // landing mid-recovery.
  async _restartStack(w) {
    if (this._watch !== w || !this._desiredRunning || this._op?.running) return false;
    const op = { name: "recover", network: w.networkId, running: true, startedAt: Date.now(), lines: [], code: null, error: null };
    this._op = op; // Exclude snapshot restore and concurrent starts during down/up.
    this._restartPending = (async () => {
      this._observations.delete(w.networkId);
      this.ensureFiles(w.networkId, w.producerAddress, { memorySaver: w.memorySaver });
      const down = await this._compose(w.networkId, ["down", "--remove-orphans", "--timeout", "60"], { timeout: 180000 });
      if (!down.ok) throw new Error(down.error || down.stderr?.slice(-500) || "Could not stop the node");
      if (this._watch !== w || !this._desiredRunning) return false;
      const up = await this._compose(w.networkId, ["up", "-d", "--remove-orphans"], { timeout: 300000 });
      if (!up.ok) throw new Error(up.error || up.stderr?.slice(-500) || "compose up failed");
      op.code = 0;
      return this._watch === w && this._desiredRunning;
    })();
    try { return await this._restartPending; }
    catch (e) { op.code = 1; op.error = e.message; throw e; }
    finally { op.running = false; op.finishedAt = Date.now(); this._restartPending = null; }
  }

  currentOp() {
    if (!this._op) return null;
    const { lines, ...rest } = this._op;
    return { ...rest, tail: lines.slice(-15) };
  }

  // ---------- moving the data to another disk ----------
  //
  // People move this because a drive filled up or was replaced, so the code
  // has to survive exactly the conditions that prompted it. The ordering
  // rules live in ./data-move.js; what lives here is the part that needs the
  // node itself: stopping it first, and pointing it at the new place after.
  //
  // Note that .env carries BASEDIR as an ABSOLUTE path, and ensureFiles()
  // rewrites .env from this.dataRoot on every start — so moving the files and
  // updating dataRoot is genuinely all it takes for Docker to follow. That is
  // load-bearing, and there is a test pinning it.

  moveStatus() {
    if (!this._move) return null;
    const { cancel, ...rest } = this._move;
    return rest;
  }

  cancelMove() {
    if (this._move?.running) this._move.cancel = true;
    return { cancelling: !!this._move?.running };
  }

  /** What a move would involve, so the UI can ask before it commits. */
  async inspectMove(targetRoot) {
    const source = path.resolve(this.dataRoot);
    const target = path.resolve(targetRoot);
    // Measured once and handed to checkTarget, which would otherwise walk the
    // same tree again for its headroom sum.
    const size = await dataMove.measure(source);
    const check = await dataMove.checkTarget(source, target, { size });
    return {
      source,
      target,
      sizeBytes: size.bytes,
      fileCount: size.files,
      targetFreeBytes: await dataMove.freeBytes(fs.existsSync(target) ? target : path.dirname(target)),
      ...check,
    };
  }

  /**
   * Move the chain data to `targetRoot` and repoint the node at it.
   *
   * Resolves once the move has finished (or failed). Progress is on
   * moveStatus(); the caller polls or listens for node:move events.
   *
   * @param onSwitched called after the setting must be updated — this is the
   *   moment the new location becomes the real one, and it happens BEFORE the
   *   old copy is deleted so a crash in between costs disk space, never data.
   */
  async moveData(networkId, targetRoot, { onSwitched } = {}) {
    if (this._move?.running) throw new Error("A data move is already running");

    const source = path.resolve(this.dataRoot);
    const target = path.resolve(targetRoot);
    const size = await dataMove.measure(source);
    const pre = await dataMove.checkTarget(source, target, { size });
    if (!pre.ok) throw new Error(pre.reason);

    const temp = target + dataMove.TEMP_SUFFIX;

    const m = {
      running: true,
      phase: "stopping",
      source,
      target,
      totalBytes: size.bytes,
      fileCount: size.files,
      copiedBytes: 0,
      checkedBytes: 0,
      checkedFiles: 0,
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      cancelled: false,
      cancel: false,
    };
    this._move = m;
    const emit = () => this.onEvent({ type: "node:move", move: this.moveStatus() });
    emit();

    try {
      // 1. The node must not be writing to the files we are about to copy.
      //    Docker holds the basedir open; copying underneath a running chain
      //    would produce a torn database that looks fine until it doesn't.
      if (this.filesReady(networkId)) {
        await this.stop(networkId);
        await this._settle();
      }
      if (m.cancel) throw Object.assign(new Error("cancelled"), { cancelled: true });

      // 2. Copy into a temp directory beside the destination. Never into the
      //    destination itself: a half-finished copy must never be mistakable
      //    for a finished one.
      m.phase = "copying";
      emit();
      await fsp.rm(temp, { recursive: true, force: true });
      const copied = await dataMove.copyTree(source, temp, {
        total: size.bytes,
        shouldCancel: () => m.cancel,
        onProgress: ({ copiedBytes }) => {
          m.copiedBytes = copiedBytes;
          emit();
        },
      });

      // 3. Prove it landed before anything becomes irreversible. Cheap check
      //    first: everything present, at the right length.
      m.phase = "verifying";
      emit();
      const v = await dataMove.verifyTree(source, temp);
      if (!v.ok) {
        const detail = v.missing.length
          ? `${v.missing.length} file(s) missing`
          : `${v.wrongSize.length} file(s) the wrong size`;
        throw new Error(`The copy did not match the original — ${detail}. Nothing was deleted.`);
      }

      /*
       * 4. Then the expensive one: re-read every copied byte and compare its
       *    sha256 to what was read out of the source. A file can be exactly
       *    the right size and still be wrong, and the reward for passing here
       *    is that the original gets deleted — so this is the last chance to
       *    notice.
       */
      m.phase = "checksumming";
      m.checkedBytes = 0;
      emit();
      const c = await dataMove.checksumTree(temp, copied.sums, {
        total: size.bytes,
        shouldCancel: () => m.cancel,
        onProgress: ({ checkedBytes }) => {
          m.checkedBytes = checkedBytes;
          emit();
        },
      });
      if (!c.ok) {
        const detail = c.mismatched.length
          ? `${c.mismatched.length} file(s) came out different (first: ${c.mismatched[0].path})`
          : `${c.unreadable.length} file(s) could not be read back`;
        throw new Error(
          `The copy is not identical to the original — ${detail}. Nothing was deleted; your data is untouched.`,
        );
      }
      m.checkedFiles = c.checked;

      // 5. Swap it into place, then repoint the node. Only now does the new
      //    location become the real one.
      m.phase = "switching";
      emit();
      await fsp.rename(temp, target);
      this.dataRoot = target;
      if (typeof onSwitched === "function") await onSwitched(target);

      // 6. The original is now redundant. Deleting it last is the whole
      //    safety property: every earlier failure leaves it untouched.
      m.phase = "cleaning";
      emit();
      await fsp.rm(source, { recursive: true, force: true }).catch(() => {
        // A locked file on Windows can keep the old folder alive. The move
        // itself is done and correct; leftover bytes are not a failure.
      });

      m.phase = "done";
      m.running = false;
      m.finishedAt = Date.now();
      emit();
      return { moved: true, source, target };
    } catch (e) {
      // Cancelled or failed: bin the partial copy, leave the original alone.
      await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
      m.running = false;
      m.finishedAt = Date.now();
      m.cancelled = !!e.cancelled || m.cancel;
      m.phase = m.cancelled ? "cancelled" : "error";
      m.error = m.cancelled ? null : e.message;
      emit();
      if (m.cancelled) return { moved: false, cancelled: true };
      throw e;
    }
  }

  /** Wait for any in-flight compose operation to finish. */
  async _settle(timeoutMs = 180000) {
    const until = Date.now() + timeoutMs;
    while (this._op?.running && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // ---------- quick sync (restore from the official chain backup) ----------

  restoreDir(networkId) {
    return path.join(this.dirs(networkId).root, "restore");
  }

  async quickSyncInfo(networkId) {
    const net = NETWORKS[networkId];
    if (!net?.backup) throw new Error("Quick sync is only available on mainnet");
    const head = await httpHead(net.backup.url);
    let freeBytes = null;
    try {
      fs.mkdirSync(this.dataRoot, { recursive: true });
      const s = fs.statfsSync(this.dataRoot);
      freeBytes = Number(s.bavail) * Number(s.bsize);
    } catch {
      /* stat not available on this platform */
    }
    let metadata = null;
    try {
      metadata = (await httpGetText(net.backup.metadataUrl)).slice(0, 1500);
    } catch {
      /* metadata is informative only */
    }
    let resumeFrom = 0;
    try {
      resumeFrom = fs.statSync(path.join(this.restoreDir(networkId), ARCHIVE_NAME)).size;
    } catch {
      /* no partial download */
    }
    const services = await this.services(networkId).catch(() => []);
    return {
      archiveBytes: head.size,
      lastModified: head.lastModified,
      resumeFrom,
      freeBytes,
      requiredBytes: requiredSpace(head.size),
      metadata,
      nodeRunning: services.some((s) => /running|up/i.test(s.state)),
    };
  }

  // Fire-and-forget; progress is exposed through currentOp() like start/stop.
  async quickSync(networkId) {
    const net = NETWORKS[networkId];
    if (!net?.backup) throw new Error("Quick sync is only available on mainnet");
    if (this._op?.running) {
      throw new Error(`Another node operation ("${this._op.name}") is still running`);
    }
    // Quick sync stops the node and leaves it stopped; stand the watchdog down so
    // it doesn't fight the restore.
    this._desiredRunning = false;
    this._stopWatchdog();
    const op = {
      name: "quick-sync",
      network: networkId,
      running: true,
      startedAt: Date.now(),
      finishedAt: null,
      lines: [],
      code: null,
      error: null,
      progress: { stage: "starting", pct: null },
    };
    this._op = op;
    this._qsAbort = new AbortController();
    this._runQuickSync(networkId, net, op)
      .then(() => {
        op.running = false;
        op.finishedAt = Date.now();
        op.code = 0;
        this.onEvent({
          type: "node",
          message: "Quick sync complete — chain data restored from backup. Start the node to catch up to head.",
        });
      })
      .catch((e) => {
        op.running = false;
        op.finishedAt = Date.now();
        op.code = 1;
        op.error = String(e?.message ?? e);
        this.onEvent({ type: "node", level: "error", message: `Quick sync failed: ${op.error}` });
      });
    return { started: true };
  }

  cancelQuickSync() {
    if (this._op?.name === "quick-sync" && this._op.running) {
      this._qsAbort?.abort();
      return { cancelling: true };
    }
    return { cancelling: false };
  }

  async _runQuickSync(networkId, net, op) {
    const signal = this._qsAbort.signal;
    const say = (stage, line, pct = null, extra = {}) => {
      op.progress = { stage, pct, ...extra };
      if (line) {
        op.lines.push(line);
        if (op.lines.length > OP_LOG_LIMIT) op.lines.splice(0, op.lines.length - OP_LOG_LIMIT);
      }
      if (signal.aborted) throw new Error("Cancelled");
    };
    const d = this.dirs(networkId);
    const restoreDir = this.restoreDir(networkId);
    const archivePath = path.join(restoreDir, ARCHIVE_NAME);
    const stagingDir = path.join(restoreDir, "extracted");
    fs.mkdirSync(restoreDir, { recursive: true });
    fs.mkdirSync(d.basedir, { recursive: true }); // never touches config/.env — a producer setup stays intact

    // 1. Stop the node if it's running.
    say("stopping", "Stopping the node (if running)…");
    if (this.filesReady(networkId)) {
      const r = await this._compose(networkId, ["down", "--timeout", "60"], { timeout: 180000 });
      if (!r.ok) throw new Error(`Could not stop and release the node's data folders: ${r.error || r.stderr}`);
    }
    say("stopping", "Checking that Windows/Docker released the data folders…");
    preflightFolders(d.basedir);

    // 2. Download checksum + archive (with resume).
    say("download", "Fetching published checksum…");
    const publishedSha = parseSha256File(await httpGetText(net.backup.sha256Url));
    const head = await httpHead(net.backup.url);
    let from = 0;
    try {
      const st = fs.statSync(archivePath);
      // Resume only when the remote file is unchanged and we have less than all of it.
      const marker = readJson(path.join(restoreDir, "download.json"));
      if (marker?.etag === head.etag && st.size <= head.size) {
        from = st.size;
      } else {
        fs.rmSync(archivePath, { force: true });
      }
    } catch {
      /* no partial file */
    }
    writeJson(path.join(restoreDir, "download.json"), { etag: head.etag, size: head.size });
    if (from < head.size) {
      say("download", from > 0
        ? `Resuming download at ${fmtBytes(from)} of ${fmtBytes(head.size)}…`
        : `Downloading chain backup (${fmtBytes(head.size)}) — this is a large file…`);
      await httpDownload(net.backup.url, archivePath, {
        resumeFrom: from,
        signal,
        onProgress: (done, total) => {
          op.progress = {
            stage: "download",
            pct: (done / total) * 100,
            doneBytes: done,
            totalBytes: total,
          };
        },
      });
    }
    say("download", "Download complete.");

    // 3. Verify the checksum.
    say("verify", "Verifying SHA-256 checksum (reads the whole archive)…");
    const actualSha = await sha256File(archivePath, (done, total) => {
      op.progress = { stage: "verify", pct: (done / total) * 100 };
      if (signal.aborted) throw new Error("Cancelled");
    });
    if (actualSha !== publishedSha) {
      fs.rmSync(archivePath, { force: true });
      throw new Error("Checksum mismatch — the downloaded backup was corrupt and has been deleted. Run quick sync again.");
    }
    say("verify", "Checksum OK.");

    // 4. List members and validate the layout (never extract blindly).
    say("inspect", "Inspecting archive contents (decompresses once, takes a while)…");
    const list = await this._exec("tar", ["-tzf", archivePath], {
      timeout: 3 * 3600 * 1000,
      maxBuffer: 128 * 1024 * 1024,
    });
    if (!list.ok) throw new Error(`Could not list the archive: ${list.error}`);
    const layout = analyzeMembers(list.stdout);
    if (!layout.ok) {
      throw new Error(`${layout.error}. The published backup layout changed — restore manually per docs.koinos.io.`);
    }
    say("inspect", `Archive layout OK (prefix "${layout.prefix || "(none)"}").`);

    // 5. Extract only chain/ and block_store/ into staging.
    say("extract", "Extracting chain and block_store (can take a long time)…");
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    const ex = await this._exec(
      "tar",
      ["-xzf", archivePath, "-C", stagingDir, `${layout.prefix}chain`, `${layout.prefix}block_store`],
      { timeout: 6 * 3600 * 1000, maxBuffer: 16 * 1024 * 1024 }
    );
    if (!ex.ok) throw new Error(`Extraction failed: ${ex.error} ${ex.stderr.slice(-300)}`);
    const stagedChain = path.join(stagingDir, ...`${layout.prefix}chain`.split("/").filter(Boolean));
    const stagedBlockStore = path.join(stagingDir, ...`${layout.prefix}block_store`.split("/").filter(Boolean));
    if (!fs.existsSync(stagedChain) || !fs.existsSync(stagedBlockStore)) {
      throw new Error("Extraction finished but chain/ or block_store/ is missing from staging");
    }

    // 6. Move current state aside (rollback dir), then install the staged data.
    // p2p identity, config, .env and wallets are never touched.
    say("install", "Installing restored chain data…");
    const rollback = path.join(restoreDir, `previous-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    installSnapshot(d.basedir, rollback, stagedChain, stagedBlockStore);
    this._observations.delete(networkId);

    // 7. Clean up what's no longer needed (keep the rollback copy).
    say("cleanup", "Cleaning up download and staging files…");
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(path.join(restoreDir, "download.json"), { force: true });
    say("done", `Done. Previous state kept in ${rollback} — delete it once the node runs fine.`, 100);
  }

  async services(networkId) {
    if (!this.filesReady(networkId)) return [];
    const r = await this._compose(networkId, ["ps", "--all", "--format", "json"], { timeout: 20000 });
    if (!r.ok) return [];
    const rows = parseComposePs(r.stdout);
    const ids = rows.map(s => s.id).filter(id => /^[a-f0-9]{12,64}$/i.test(id));
    if (ids.length) {
      // Only runtime state, never container environment or wallet/config mounts.
      const details = await this._exec("docker", ["inspect", "--format",
        '{"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"oomKilled":{{json .State.OOMKilled}},"exitCode":{{json .State.ExitCode}},"restartCount":{{json .RestartCount}}}', ...ids], { timeout: 10000 });
      if (details.ok) for (const line of details.stdout.trim().split("\n")) {
        try {
          const info = JSON.parse(line), row = rows.find(s => s.id && info.id.startsWith(s.id));
          if (row) Object.assign(row, info);
        } catch { /* keep Compose state when an inspect row cannot be read */ }
      }
    }
    return rows;
  }

  async logs(networkId, service, tail = 120) {
    const args = ["logs", "--no-color", "--timestamps", "--tail", String(Math.min(Number(tail) || 120, 1000))];
    if (service) args.push(String(service));
    const r = await this._compose(networkId, args, { timeout: 25000 });
    if (!r.ok) throw new Error(r.error || "Failed to read logs");
    return (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim();
  }

  async backups(networkId) { return backupList(this.restoreDir(networkId)); }

  async removeBackup(networkId, id) {
    if (this._op?.running) throw new Error("Wait for the current node operation to finish.");
    assertRestoreReady(this.dirs(networkId).basedir);
    const op = { name: "delete-backup", network: networkId, running: true, startedAt: Date.now(), lines: [] };
    this._op = op;
    try { const result = await deleteBackup(this.restoreDir(networkId), id); op.code = 0; return result; }
    catch (e) { op.code = 1; op.error = e.message; throw e; }
    finally { op.running = false; op.finishedAt = Date.now(); }
  }

  async observe(networkId, services) {
    const lifetimes = Object.fromEntries(services.map(s => [s.service, `${s.id || ""}:${s.startedAt || ""}`]));
    const generation = Object.entries(lifetimes).sort().map(([name, value]) => `${name}:${value}`).join("|");
    const cached = this._observations.get(networkId);
    const old = cached?.generation === generation ? cached : null;
    if (old?.pending) return old.pending;
    if (old && Date.now() - old.at < WATCH_INTERVAL_MS) return old.value;
    const entry = { at: Date.now(), value: old?.value, generation, lifetimes };
    entry.pending = (async () => {
      let value = { health: null, peers: null };
      if (services.length && !this._op?.running) {
        const r = await this._compose(networkId, ["logs", "--no-color", "--timestamps", "--since", old?.value ? "2m" : "24h", "--tail", "200", "amqp", "chain", "block_producer", "p2p", "jsonrpc"], { timeout: 15000 });
        value = r.ok ? inspectLogs(currentLogs(r.stdout + "\n" + r.stderr, services)) : value;
        // Keep the last failed attempt visible through quiet periods. Merely
        // logging "Producing with VHP" is not a successful block submission.
        if (!value.production && services.some(s => s.service === "block_producer" && /running|up/i.test(s.state))) value.production = old?.value?.production || null;
        const previousFailure = cached?.value?.health;
        if (previousFailure?.needsRepair && lifetimes[previousFailure.service] != null &&
            cached.lifetimes?.[previousFailure.service] === lifetimes[previousFailure.service]) value.health = previousFailure;
        const health = assessHealth({ services, producing: services.some(s => s.service === "block_producer") });
        if (!value.health || (!value.health.needsRepair && health.ok === false)) value.health = health;
        if (value.health.service === "amqp") value.health.reason = "broker-unavailable";
      }
      entry.value = value;
      return value;
    })().finally(() => { entry.pending = null; });
    this._observations.set(networkId, entry);
    return entry.pending;
  }

  _adoptRunning(networkId, services) {
    if (this._watch || this._desiredRunning === false || this._op?.running || this._move?.running) return;
    if (!services.some(s => /^(running|restarting)$/.test(s.state))) return;
    try {
      assertRestoreReady(this.dirs(networkId).basedir);
      const config = fs.readFileSync(path.join(this.dirs(networkId).config, "config.yml"), "utf8");
      const producing = services.some(s => s.service === "block_producer");
      const address = config.match(/^  producer: ([1-9A-HJ-NP-Za-km-z]{25,35})(?:\s|$)/m)?.[1] || null;
      if (producing && !address) return; // Never guess a reward address.
      this._desiredRunning = true;
      this._startWatchdog(networkId, producing, address, /^  jobs: 2\s*$/m.test(config));
    } catch { /* Never recreate a stack without its original configuration. */ }
  }

  async status(networkId) {
    const docker = await this.dockerInfo();
    const services = docker.ok ? await this.services(networkId) : [];
    const running = services.filter((s) => /running|up/i.test(s.state)).length;
    this._adoptRunning(networkId, services);
    const w = this._watch?.networkId === networkId ? this._watch : null;
    const observed = await this.observe(networkId, services);
    return {
      peers: observed.peers,
      production: observed.production || null,
      docker,
      filesReady: this.filesReady(networkId),
      services,
      runningCount: running,
      isRunning: running > 0,
      producerPublicKey: this.readProducerPublicKey(networkId),
      op: this.currentOp(),
      dataDir: this.dirs(networkId).root,
      autoRecover: this.autoRecover,
      memorySaver: w?.memorySaver || false,
      health: observed.health?.ok === false && !(w && observed.health.reason === "chain-unresponsive") ? { ...observed.health, recovering: !!w?.recovering, lastRecoveryError: w?.lastRecoveryError || null } : w
        ? {
            ok: w.health?.ok !== false && !w.needsRepair,
            reason: w.needsRepair ? "needs-repair" : w.health?.reason || null,
            recovering: !!w.recovering,
            memorySaver: !!w.memorySaver,
            needsRepair: !!w.needsRepair,
            repairReason: w.repairReason || null,
            recoveries: w.recoveries?.length || 0,
            lastRecoveryAt: w.recoveries?.length ? w.recoveries[w.recoveries.length - 1] : null,
          }
        : observed.health,
    };
  }
}

// ---------- local helpers ----------

function sha256File(filePath, onProgress) {
  return new Promise((resolve, reject) => {
    const total = fs.statSync(filePath).size;
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    let done = 0;
    let lastTick = 0;
    stream.on("data", (chunk) => {
      hash.update(chunk);
      done += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastTick > 500) {
        lastTick = now;
        try {
          onProgress(done, total);
        } catch (e) {
          stream.destroy(e);
        }
      }
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(p, v) {
  fs.writeFileSync(p, JSON.stringify(v));
}

function parseComposePs(stdout) {
  const rows = [];
  const text = stdout.trim();
  if (!text) return rows;
  // docker compose v2 emits one JSON object per line; older versions emit an array.
  let objects = [];
  try {
    const parsed = JSON.parse(text);
    objects = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    for (const line of text.split("\n")) {
      try {
        objects.push(JSON.parse(line));
      } catch {
        /* skip non-JSON lines */
      }
    }
  }
  for (const o of objects) {
    rows.push({
      id: o.ID ?? o.Id ?? o.id ?? "",
      name: o.Name ?? o.name ?? "",
      service: o.Service ?? o.service ?? "",
      state: o.State ?? o.state ?? "",
      status: o.Status ?? o.status ?? "",
      health: o.Health ?? o.health ?? "",
    });
  }
  return rows;
}

/*
 * Docker Desktop for macOS rejects Compose's file-backed `configs` when their
 * targets sit inside the separately bind-mounted BASEDIR (for example,
 * /koinos/config.yml inside /koinos). Linux Docker accepts that nested mount,
 * so the failure only surfaced in a packaged Mac smoke test.
 *
 * Keep the upstream-shaped template for Linux and Windows. On macOS, remove
 * only the Compose config mounts and stage the same inputs at the paths the
 * Koinos services already read through BASEDIR.
 */
function composeForMacos(text) {
  const lines = String(text).split(/\r?\n/);
  const out = ["# macOS: config files are staged inside BASEDIR; avoid Docker Desktop nested mounts."];
  let skipping = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (skipping === "service") {
      if (!trimmed || indent > 6) continue;
      skipping = null;
    } else if (skipping === "top") {
      if (!trimmed || indent > 0) continue;
      skipping = null;
    }

    if (indent === 6 && trimmed === "configs:") {
      skipping = "service";
      continue;
    }
    if (indent === 0 && trimmed === "configs:") {
      skipping = "top";
      continue;
    }
    out.push(line);
  }

  return out.join("\n");
}

function stageMacosConfig(d) {
  const chainDir = path.join(d.basedir, "chain");
  const descriptorDir = path.join(d.basedir, "jsonrpc", "descriptors");
  fs.mkdirSync(chainDir, { recursive: true });
  fs.mkdirSync(descriptorDir, { recursive: true });
  fs.copyFileSync(path.join(d.config, "config.yml"), path.join(d.basedir, "config.yml"));
  fs.copyFileSync(path.join(d.config, "genesis_data.json"), path.join(chainDir, "genesis_data.json"));
  fs.copyFileSync(
    path.join(d.config, "koinos_descriptors.pb"),
    path.join(descriptorDir, "koinos_descriptors.pb")
  );
}

function buildEnv(net, basedirAbs, producing, memorySaver) {
  // Keep RPC available for health checks and the desktop in every mode.
  // Memory-saver reduces service jobs in config.yml instead of removing RPC.
  const profiles = producing ? "jsonrpc,block_producer" : "jsonrpc";
  const lines = [
    "# Generated by Koinos Node Desktop — regenerated on every node start.",
    `BASEDIR=${basedirAbs}`,
    "",
    `AMQP_PORT=${net.ports.amqp}`,
    `AMQP_ADMIN_PORT=${net.ports.amqpAdmin}`,
    `P2P_PORT=${net.ports.p2p}`,
    `JSONRPC_PORT=${net.ports.jsonrpc}`,
    `GRPC_PORT=${net.ports.grpc}`,
    `REST_PORT=${net.ports.rest}`,
    "",
    `COMPOSE_PROFILES=${profiles}`,
    "",
    ...Object.entries(net.imageTags).map(([k, v]) => `${k}=${v}`),
    "",
  ];
  return lines.join("\n");
}

function buildConfigYml(net, producerAddress, { memorySaver = false } = {}) {
  const producerLines = producerAddress
    ? `  producer: ${producerAddress}                # Address that receives block rewards (this app's wallet)`
    : `  # producer:                                 # Set automatically when block production is enabled`;
  const seeds = net.p2pSeeds.map((s) => `    - ${s}`).join("\n");
  return `# Generated by Koinos Node Desktop — based on koinos/koinos config-example.
# Regenerated on every node start; manual edits will be overwritten.

global:
  amqp: amqp://guest:guest@amqp:5672/
${memorySaver ? "  jobs: 2\n" : ""}  log-level: info
  log-color: false
  log-datetime: true
  log-dir: logs
  instance-id: KoinosDesktop
  fork-algorithm: pob
  blacklist:
    - block_store.add_block
    - chain.propose_block

block_producer:
  algorithm: pob
${producerLines}

grpc:
  endpoint: 0.0.0.0:50051

jsonrpc:
  listen: /tcp/8080

p2p:
  listen: /ip4/0.0.0.0/tcp/8888
  peer:
${seeds}
`;
}

module.exports = { NodeManager, buildEnv, buildConfigYml, parseComposePs, composeForMacos, stageMacosConfig };
