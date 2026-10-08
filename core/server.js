"use strict";

/*
 * Koinos AI Core (spec §4) — the persistent service everything else talks to.
 * The desktop UI is a client; the headless Koinos AI Server (§9) reuses this
 * entrypoint unchanged. M1 modules: hardware detection, model manager,
 * llama.cpp runtime manager, local OpenAI-compatible gateway.
 *
 * Environment:
 *   KAI_CORE_DATA   data directory   (default ~/.koinos-ai)
 *   KAI_CORE_PORT   gateway port     (default 41100, always 127.0.0.1)
 *   KAI_LLAMA_BIN   path to llama-server (default <data>/runtimes/llamacpp/llama-server)
 */

const os = require("os");
const path = require("path");

const { JsonStore } = require("./lib/store");
const hardware = require("./lib/hardware");
const { ApiKeys } = require("./lib/keys");
const { ModelManager } = require("./lib/model-manager");
const { RuntimeProvisioner } = require("./lib/runtime-provisioner");
const { LlamaCppRuntime } = require("./lib/runtimes/llamacpp");
const { RuntimeManager } = require("./lib/runtime-manager");
const { Gateway } = require("./lib/gateway");

const { channelConfig } = require("./lib/release-channel");

const VERSION = require("./package.json").version;
// The project-operated scheduler (§12): baked in so Start Earning and
// network mode work out of the box. KAI_SCHEDULER_URL overrides for
// self-hosters; the Earn tab field overrides per machine.
const DEFAULT_SCHEDULER_URL = process.env.KAI_SCHEDULER_URL || "https://koinosai.com/scheduler";

/*
 * Profiles: "full" is the KoinosAI desktop app. "router" is the slim Core
 * Koinos Router runs: earn + network + wallet only. Every subsystem the router
 * skips is required inside a full-profile branch, so its module (and any heavy
 * native dependency behind it) is never loaded — Router packaging leaves them
 * out entirely.
 */
const PROFILES = ["full", "router"];

async function createCore({ dataDir, port, llamaBin, sessionSecret, onEvent, profile = "full", uiDir: uiDirOption, extensions } = {}) {
  if (!PROFILES.includes(profile)) throw new Error(`Unknown Core profile: ${profile}`);
  const full = profile === "full";
  const release = channelConfig();
  dataDir = dataDir || process.env.KAI_CORE_DATA || path.join(os.homedir(), release.homeDirName);
  // Every event also lands in <dataDir>/core.log so packaged-app failures
  // in the field are diagnosable ("Model load failed" has a paper trail).
  const fsl = require("fs");
  fsl.mkdirSync(dataDir, { recursive: true });
  const logFile = path.join(dataDir, "core.log");
  const sink = onEvent || ((e) => console.log(`[core] ${e.type}`, e.message ?? ""));
  const events = (e) => {
    try {
      const detail = e.message ?? e.reason ?? e.error ?? e.endpoint ?? e.code ?? e.pct ?? "";
      fsl.appendFileSync(logFile, `${new Date().toISOString()} ${e.type} ${detail}\n`);
    } catch {
      /* logging must never break the app */
    }
    sink(e);
  };

  const settings = new JsonStore(path.join(dataDir, "settings.json"), {});
  const state = new JsonStore(path.join(dataDir, "state.json"), {});
  const hw = await hardware.detect({ dataDir });

  const keys = new ApiKeys(settings);
  const models = new ModelManager({
    catalogPath: path.join(__dirname, "models", "catalog.json"),
    modelsDir: path.join(dataDir, "models"),
    state,
    onEvent: events,
  });

  // KAI_LLAMA_BIN (or the llamaBin option) forces a specific binary and skips
  // provisioning; otherwise the right build is fetched on first need.
  const forcedBin = llamaBin || process.env.KAI_LLAMA_BIN || null;
  const provisioner = forcedBin
    ? null
    : new RuntimeProvisioner({
        catalogPath: path.join(__dirname, "runtimes", "catalog.json"),
        runtimesDir: path.join(dataDir, "runtimes"),
        hardware: hw,
        onEvent: events,
      });

  const { OllamaRuntime } = require("./lib/runtimes/ollama");
  const ollamaAddr = {
    host: process.env.KAI_OLLAMA_HOST || "127.0.0.1",
    port: Number(process.env.KAI_OLLAMA_PORT || release.ollamaPort),
  };
  const runtime = new RuntimeManager({
    models,
    hardware: hw,
    provisioner,
    state,
    appVersion: VERSION,
    onEvent: events,
    makeRuntime: (binPath) => new LlamaCppRuntime({ binPath: binPath || forcedBin, onEvent: events }),
    // Ollama is the deep-fallback engine (§6): a system install if present,
    // otherwise Core provisions its own portable build (hash-pinned like
    // every engine) — used when the managed llama.cpp build can't run here,
    // or forced via KAI_RUNTIME. Nobody is ever sent to a website.
    makeFallback: async () =>
      (await OllamaRuntime.ensureRunning({
        ...ollamaAddr,
        onEvent: events,
        provision: () => provisioner.ensure("ollama", { cap: "cpu" }),
        modelsDir: path.join(dataDir, "ollama-models"),
      }))
        ? new OllamaRuntime({ ...ollamaAddr, onEvent: events })
        : null,
    preferFallback: process.env.KAI_RUNTIME === "ollama",
  });

  // Earn controller (M2 §5.7): wallet + worker behind the control plane.
  // Wallet keys stay in Core (§8); the worker only starts on explicit opt-in
  // and stops immediately on request (§10).
  const { WalletService } = require("./lib/wallet");
  const { Worker } = require("./lib/worker");
  const { LoadGuard } = require("./lib/load-guard");
  const wallet = new WalletService(path.join(dataDir, "wallet"));
  let worker = null;
  let loadGuard = null; // lives exactly as long as the worker does
  // Full profile only (assigned below); the router profile reports no node.
  let producerSnapshot = null;
  let producerReporter = null;
  // Machine session (§8-compatible): the Electron shell passes a secret held
  // by the OS (safeStorage/DPAPI); with it, an unlocked wallet survives app
  // restarts — no password re-typing — until the user presses Lock.
  sessionSecret = sessionSecret || process.env.KAI_SESSION_SECRET || null;
  if (sessionSecret && wallet.exists() && wallet.tryResumeSession(sessionSecret)) {
    events({ type: "wallet:session-resumed", message: wallet.address });
  }
  // On-chain KAI balance + open-epoch receipts, via the scheduler's /balance.
  // Cached 30s; only fetched while something asks (the Earn tab polls status).
  /*
   * The cache is keyed by wallet address and stamped with a generation.
   * Anything that makes the cached answer wrong — a new scheduler URL, a
   * deposit, earn.invalidateEarnings() after a refused spend — bumps the
   * generation, and a read that was already in flight when that happened is
   * neither cached nor handed back: it is redone. So every status() that
   * resolves after an invalidation reflects a /balance read started after
   * it, and a wallet swap never shows (or caches) the old wallet's balance.
   */
  let earningsCache = { at: 0, data: null, address: null };
  let earningsGen = 0;
  const resetEarnings = () => {
    earningsGen += 1;
    earningsCache = { at: 0, data: null, address: null };
  };
  const EARNINGS_UNAVAILABLE = "Balance temporarily unavailable — retrying";
  const readBalance = async (url, address) => {
    let data = null;
    try {
      const r = await fetch(`${url.replace(/\/$/, "")}/balance?address=${encodeURIComponent(address)}`, {
        signal: AbortSignal.timeout(4000),
      });
      const j = await r.json();
      if (j.ok) {
        data = {
          kai: j.kai,
          pendingReceipts: j.pendingReceipts ?? 0,
          tokensProcessed: j.tokensProcessed ?? null,
          pendingKai: j.pendingKai ?? null,
          usage: j.usage ?? null, // { inputTokens, outputTokens, costUsd }
          freeTokensRemaining: j.freeTokensRemaining ?? null,
          balanceUsd: j.balanceUsd ?? null,
          spentThisEpochKai: j.spentThisEpochKai ?? null,
        };
      }
    } catch {
      // Scheduler unreachable or chain read down: say so instead of
      // degrading to unexplained dashes — silence reads as "earnings gone".
    }
    return data || { error: EARNINGS_UNAVAILABLE };
  };
  const fetchEarnings = async () => {
    // Bounded: a read is redone only when something invalidated it mid-flight.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!worker?.running && settings.get("network.privacyMode", "local-only") === "local-only") return null;
      const url = settings.get("earn.schedulerUrl", DEFAULT_SCHEDULER_URL);
      const address = wallet.address;
      if (!url || !address) return null;
      if (earningsCache.address === address && Date.now() - earningsCache.at < 30000) return earningsCache.data;
      const gen = earningsGen;
      const data = await readBalance(url, address);
      if (gen !== earningsGen || address !== wallet.address) continue; // stale: read again
      // Successes cache for the full 30s; a failed read retries in ~3s so one
      // slow moment doesn't blank the balance row for half a minute.
      earningsCache = { at: !data.error ? Date.now() : Date.now() - 27000, data, address };
      return data;
    }
    return { error: EARNINGS_UNAVAILABLE };
  };
  const earn = {
    status: async () => {
      // Earnings first: the wallet snapshot below must describe the wallet
      // the balance was read for, even if it changed while the read ran.
      const earnings = await fetchEarnings();
      return {
        wallet: wallet.status(),
        worker: worker ? worker.status() : { running: false, jobsDone: 0, receiptsAccepted: 0 },
        guard: loadGuard ? loadGuard.status() : null,
        schedulerUrl: settings.get("earn.schedulerUrl", DEFAULT_SCHEDULER_URL),
        earnings,
        /*
         * Why this machine's Koinos node is — or is not — on the dashboard,
         * independently of whether it is earning (#84). "My node disappeared"
         * is the question this answers, and every quiet state it reports
         * (locked wallet, local-only privacy, no node running) is a legitimate
         * one that an absent card cannot be told apart from a broken report.
         */
        producerReport: producerReporter ? producerReporter.status() : null,
      };
    },
    configure: ({ schedulerUrl }) => {
      let u = String(schedulerUrl || "").trim();
      if (u) {
        // A pasted bare host is the common case — repair it rather than
        // letting the worker's fetch throw a cryptic parse error later.
        if (!/^https?:\/\//i.test(u)) u = "https://" + u;
        try {
          new URL(u);
        } catch {
          throw new Error(`That doesn't look like a scheduler URL: "${schedulerUrl}"`);
        }
      } else {
        // Clearing the field means "back to the network default", not
        // "no scheduler" — a stored empty string would shadow the default.
        u = DEFAULT_SCHEDULER_URL;
      }
      settings.set("earn.schedulerUrl", u);
      resetEarnings();
      syncKillSwitch().catch(() => {}); // §32: check the new scheduler's list promptly
      return earn.status();
    },
    createWallet: ({ password }) => {
      const r = wallet.create({ password });
      if (sessionSecret) wallet.saveSession(sessionSecret);
      events({ type: "wallet:created", message: r.address });
      return r;
    },
    restoreWallet: ({ wif, password }) => {
      const r = wallet.restore({ wif, password });
      if (sessionSecret) wallet.saveSession(sessionSecret);
      events({ type: "wallet:restored", message: r.address });
      return r;
    },
    revealWallet: ({ password }) => {
      const r = wallet.revealWif(password);
      events({ type: "wallet:backup-revealed", message: r.address });
      return r;
    },
    unlock: ({ password }) => {
      // Every attempt lands in core.log — locked-out users need a paper trail.
      try {
        const r = wallet.unlock(password);
        if (sessionSecret) wallet.saveSession(sessionSecret);
        events({ type: "wallet:unlocked", message: r.address });
        return r;
      } catch (e) {
        events({ type: "wallet:unlock-failed", message: String(e.message) });
        throw e;
      }
    },
    lock: async () => {
      loadGuard?.stop();
      loadGuard = null;
      if (worker) await worker.stop();
      wallet.lock(); // also ends the machine session
      settings.set("earn.autoStart", false);
      events({ type: "wallet:locked" });
      return earn.status();
    },
    // §21/§23: deposit KAI for network credits. The scheduler prepares the tx
    // (operator pays MANA), the wallet signs it HERE — the key never leaves —
    // and the signed tx goes back for the operator's co-signature.
    deposit: async ({ amountKai }) => {
      const url = settings.get("earn.schedulerUrl", DEFAULT_SCHEDULER_URL);
      if (!url) throw new Error("Set the scheduler URL first");
      const s = wallet.status();
      if (!s.unlocked) throw new Error("Unlock your earning account first");
      const amt = Number(amountKai);
      if (!(amt > 0)) throw new Error("Enter a positive KAI amount");
      const base = url.replace(/\/$/, "");
      const post = async (p, body) =>
        (await fetch(`${base}${p}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        })).json();
      const prep = await post("/deposit/prepare", { address: s.address, amountKai: amt });
      if (!prep.ok) throw new Error(prep.error || "Deposits are not available on this scheduler yet");
      const signed = await wallet.signer.signTransaction(prep.transaction);
      const sub = await post("/deposit/submit", { address: s.address, transaction: signed });
      if (!sub.ok) throw new Error(sub.error || "Deposit failed");
      resetEarnings(); // pick up new credits promptly
      events({ type: "wallet:deposited", message: `${amt} KAI tx ${sub.txId}` });
      return { txId: sub.txId, amountKai: amt };
    },
    start: async () => {
      const s = wallet.status();
      if (!s.exists) throw new Error("Create a wallet first");
      if (!s.unlocked) throw new Error("Unlock the wallet first");
      const url = settings.get("earn.schedulerUrl", DEFAULT_SCHEDULER_URL);
      if (!url) throw new Error("Set the scheduler URL first");
      if (worker?.running) return worker.status();
      worker = new Worker({
        schedulerUrl: url, wallet, runtime, hardware: hw, models, onEvent: events,
        // The account page's Koinos node card. Built by the shared snapshot
        // module so an earning machine and a node-only machine describe
        // themselves to the dashboard in exactly the same words.
        producer: producerSnapshot || null,
      });
      const st = await worker.start();
      /*
       * Load guard (field report 2026-08-26: Earn + heavy GPU design work
       * froze a tester's PC; closing the app un-froze it instantly — VRAM
       * oversubscription). While the owner's other applications are working
       * the GPU, earning backs off: stop polling for jobs, and unload the
       * idle engine so its VRAM comes back RIGHT NOW — the exact relief
       * closing the app gave, without closing the app. `earn.courtesy` set
       * to "off" disables it for dedicated rigs that want every job.
       */
      if (settings.get("earn.courtesy", "auto") !== "off") {
        loadGuard = new LoadGuard({
          isOurLoad: () => runtime.busy(),
          onContention: () => {
            worker?.setBackoff(true, "your GPU is busy");
            // Free the VRAM unless something is actually streaming from the
            // engine (a local chat mid-answer must never be cut off — the
            // guard re-calls this each contended sample, so the unload
            // happens as soon as the stream ends).
            if (!runtime.busy()) runtime.stop();
          },
          onQuiet: () => worker?.setBackoff(false),
          onEvent: events,
        });
        loadGuard.start();
      }
      settings.set("earn.autoStart", true);
      return st;
    },
    nudge: async () => (worker ? worker.nudge() : { running: false }),
    // userIntent distinguishes the Stop button from process shutdown: only
    // the user's own Stop turns auto-resume off — a quit or update keeps
    // their "earning on" choice for the next launch.
    stop: async ({ userIntent = true } = {}) => {
      loadGuard?.stop();
      loadGuard = null;
      if (worker) await worker.stop();
      if (userIntent) settings.set("earn.autoStart", false);
      return earn.status();
    },
    // Router's idle gate drives the same courtesy backoff the load guard uses.
    setBackoff: (on, reason) => worker?.setBackoff(on, reason),
    backoff: () => ({ on: !!worker?.status().backoff, reason: worker?.status().backoffReason ?? null }),
    // Drop the 30s balance cache so the next status() reads the scheduler
    // fresh (Router calls this right after a spend is refused). A read
    // already in flight is redone rather than cached or returned.
    invalidateEarnings: resetEarnings,
  };

  // §7 routing policy (M3): privacy mode gates all network consumption.
  // local-only is the default — nothing leaves the machine unless chosen.
  // §32 kill switch: poll the scheduler's revocation list. Earning or not,
  // compromised weights must stop serving — chat included. When the ACTIVE
  // model is hit, the engine stops immediately and §7 routing turns the
  // next request into a capability miss, so Local-First machines fail over
  // to the network instead of going dark. Quarantine persists locally;
  // recovery ships as a catalog update with a clean package, never by
  // un-forgetting.
  const syncKillSwitch = async () => {
    // §29 strict: a Local-Only machine emits NOTHING — not even safety
    // polls. Its kill-switch coverage rides app/catalog updates instead;
    // the moment the mode allows network participation, the live list is
    // fetched (network.configure triggers a sync on that transition).
    // EXCEPTION: an actively earning worker is already talking to the
    // scheduler — it must not escape the kill switch on a privacy label.
    const earning = worker && worker.status().running;
    if (!earning && settings.get("network.privacyMode", "local-only") === "local-only") return;
    const base = settings.get("earn.schedulerUrl", DEFAULT_SCHEDULER_URL);
    if (!base) return;
    let revoked;
    try {
      const r = await fetch(`${base.replace(/\/$/, "")}/policy`, { headers: { connection: "close" }, signal: AbortSignal.timeout(8000) });
      revoked = (await r.json())?.revoked;
    } catch {
      return; // unreachable — next tick retries
    }
    if (!Array.isArray(revoked)) return;
    for (const entry of revoked) {
      const hit = models.quarantineBySha(entry.sha256, entry.reason);
      if (!hit.length) continue;
      events({ type: "core:kill-switch", packages: hit, reason: entry.reason });
      const activePkg = runtime.activeAlias ? models.catalog.aliases[runtime.activeAlias]?.package : null;
      if (activePkg && hit.includes(activePkg)) {
        if (worker && worker.status().running) {
          await earn.stop({ userIntent: false }).catch(() => {});
        }
        runtime.stop();
        events({ type: "core:kill-switch-stopped-engine", package: activePkg });
      }
    }
  };

  const network = {
    status: () => ({
      privacyMode: settings.get("network.privacyMode", "local-only"),
      schedulerUrl: settings.get("earn.schedulerUrl", DEFAULT_SCHEDULER_URL),
      walletUnlocked: wallet.status().unlocked,
    }),
    // §23: network requests are signed by the earning account — identity and
    // metering in one. Null when there's no unlocked wallet to sign with.
    signConsume: async (messages) => {
      const s = wallet.status();
      if (!s.unlocked || !s.address) return null;
      const ts = Date.now();
      const cryptoNode = require("crypto");
      const hash = cryptoNode
        .createHash("sha256")
        .update(`consume|${s.address}|${ts}|${JSON.stringify(messages)}`)
        .digest();
      return { address: s.address, ts, signature: await wallet.signHash(hash) };
    },
    configure: ({ privacyMode }) => {
      const m = String(privacyMode || "");
      if (!["local-only", "local-first", "network"].includes(m)) {
        throw new Error("privacyMode must be local-only, local-first, or network");
      }
      settings.set("network.privacyMode", m);
      // §32: the moment network participation is allowed, fetch the
      // safety list — don't wait out the poll interval.
      if (m !== "local-only") syncKillSwitch().catch(() => {});
      return network.status();
    },
  };

  // The desktop UI is plain web content served by the gateway itself — the
  // Electron shell just opens a window onto it, and a browser works too.
  const uiDir = uiDirOption || path.join(__dirname, "..", "ui");

  // Full-profile subsystems: declared out here so the gateway, start() and
  // stop() see null in the router profile, constructed (and required) only
  // inside the branch below.
  let staticAssets = null;
  let registry = null;
  let memory = null;
  let nodeRuntime = null;
  let emailSvc = null;
  let calendarSvc = null;
  let koinosSvc = null;
  let koinosNodeSvc = null;
  let mcp = null;
  let account = null;
  let teams = null;
  let dev = null;
  let bench = null;
  let agents = null;
  let code = null;
  let voice = null;
  let speech = null;
  let turn = null;
  let chats = null;
  let docs = null;
  let loopbackChat = null;
  if (full) {
    const { liveSensesAssets, smartTurnModelPath } = require("./lib/live-senses-assets");
    const { ChatStore } = require("./lib/chats");

    // ---- unified tool layer: ONE policy point for everything a model can do
    // beyond generating text (§7 egress gating + confirm-before-use) ----
    const { ToolRegistry } = require("./lib/tools");
    const { MemoryStore } = require("./lib/memory");
    const { registerBuiltinTools } = require("./lib/builtin-tools");
    const { McpManager } = require("./lib/mcp-manager");
    const { EmailService, registerEmailTools } = require("./lib/email");
    const { CalendarService, registerCalendarTools } = require("./lib/caldav");
    registry = new ToolRegistry({ privacyMode: () => settings.get("network.privacyMode") || "local-only" });
    memory = new MemoryStore(dataDir);
    // Legacy facts are read only for migration into the private desktop Brain.
    // Brain is never exposed through the Core/network tool registry.
    // Node runtime for npx-based MCP servers AND the run_code sandbox —
    // constructed before the builtin tools so run_code can probe which node
    // binary (and which permission flag) this machine actually has.
    const { NodeRuntime } = require("./lib/node-runtime");
    nodeRuntime = new NodeRuntime({ provisioner, runtimesDir: path.join(dataDir, "runtimes") });
    registerBuiltinTools(registry, { dataDir, nodeRuntime });
    // Electron's safeStorage encrypts account credentials with the OS keychain;
    // absent (tests, headless) the services fall back to a 0600 file and say so.
    let safeStorage = null;
    try { safeStorage = require("electron").safeStorage; } catch { /* not in electron */ }
    emailSvc = new EmailService({ dataDir, safeStorage, onEvent: events });
    registerEmailTools(registry, emailSvc);
    calendarSvc = new CalendarService({ dataDir, safeStorage, onEvent: events });
    // Koinos node tools. Constructed always, INERT until the Earn toggle flips
    // it on: nothing here opens a Provider or touches the network while off.
    const { KoinosService } = require("./lib/koinos");
    koinosSvc = new KoinosService({ settings, hardware: hw, dataDir, wallet, onEvent: events });
    // The FULL node stack — Docker lifecycle, guided WSL/Docker setup, onramp,
    // bridge, swaps, rewards. It uses THIS wallet; there is no second one.
    const { createKoinosNode } = require("./lib/koinos-node");
    koinosNodeSvc = createKoinosNode({
      dataDir,
      wallet,
      appVersion: VERSION,
      // Logged like everything else, and pushed live to the node UI over
      // /core/koinos/events — the stream Electron IPC carried in the
      // standalone app. `gateway` is created below; by the first event it exists.
      onEvent: (e) => {
        events(e);
        // A boot-time event can fire before the const below initialises (TDZ).
        try { gateway?.pushKoinosEvent(e); } catch { /* not up yet; the log has it */ }
      },
    });
    registerCalendarTools(registry, calendarSvc);

    /*
     * One builder for the block-producer snapshot, shared by the earning Worker
     * and by the standalone reporter below. `earn.start()` is declared above
     * this line but only reads the const when the Worker is actually
     * constructed, by which time it exists — the same arrangement the inline
     * version had with `koinosNodeSvc`.
     */
    const { createProducerSnapshot } = require("./lib/koinos/producer-snapshot");
    producerSnapshot = createProducerSnapshot({
      call: (method, args) => koinosNodeSvc.call(method, args),
      appVersion: VERSION,
    });

    /*
     * Task #84: the node reports itself even with Earning off. Constructed
     * here, started in start() — it gates itself on privacy mode, the wallet,
     * and whether the earning Worker is already doing the reporting, so it is
     * safe to leave running for the life of the process.
     */
    const { ProducerReporter } = require("./lib/producer-reporter");
    producerReporter = new ProducerReporter({
      schedulerUrl: () => settings.get("earn.schedulerUrl", DEFAULT_SCHEDULER_URL),
      privacyMode: () => settings.get("network.privacyMode", "local-only"),
      wallet,
      snapshot: producerSnapshot,
      earning: () => !!(worker && worker.status().running),
      onEvent: events,
    });
    mcp = new McpManager({ settings, registry, nodeRuntime, onEvent: events });
    // Koinos AI account (task #49): device-link sign-in + wallet attach. The
    // bearer token is stored like email credentials (OS keychain when
    // available); the wallet's unlocked signer produces the link proof — it
    // moves no value, same trust class as receipt signing.
    const { AccountService } = require("./lib/account");
    account = new AccountService({ dataDir, settings, wallet, safeStorage, onEvent: events });
    // AI Teams (task #58): the runner lives in Core so headless API users and
    // the Pi get teams without a window. Completions loop back through the
    // gateway's own chat lane, so teams inherit EVERY routing rule — local
    // engine acquisition, network consume, privacy modes — instead of
    // re-implementing any of it. (`gateway` is created below; teams only run
    // after listen, when its port exists.)
    const { TeamRunner } = require("./lib/teams");
    // One loopback completion through the gateway's own chat lane — teams AND
    // bench inherit every routing rule (privacy modes, budgets, kill switch)
    // instead of re-implementing any of it.
    loopbackChat = async ({ model, messages, maxTokens }) => {
      const r = await fetch(`http://127.0.0.1:${gateway.port}/core/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Headless deployments gate /core/* behind KAI_CORE_TOKEN — the
          // engine's own internal calls carry it so teams/bench keep working.
          ...(process.env.KAI_CORE_TOKEN ? { authorization: `Bearer ${process.env.KAI_CORE_TOKEN}` } : {}),
        },
        body: JSON.stringify({ model, messages, stream: false, max_tokens: maxTokens }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message || `chat failed (${r.status})`);
      return j?.choices?.[0]?.message?.content ?? "";
    };
    teams = new TeamRunner({ registry, onEvent: events, chatFn: loopbackChat });
    // Developer tools (task #61): ONE explicit switch in Local API. Off by
    // default; while off, custom team specs and the bench routes refuse. The
    // switch reveals capability, never permissions — sensitive tools still
    // need their own upfront yes with it on.
    dev = {
      status: () => ({ enabled: settings.get("dev.tools", false) === true }),
      configure: ({ enabled }) => {
        settings.set("dev.tools", enabled === true);
        events({ type: "dev:tools", message: enabled === true ? "on" : "off" });
        return dev.status();
      },
    };
    const { BenchRunner } = require("./lib/bench");
    bench = new BenchRunner({ chatFn: loopbackChat, teams, dataDir });
    // Multi-agent group chats (task #64) — the full-AutoGen developer track:
    // named agents, one shared transcript, round-robin/selector/handoff turn
    // order, humans as pausing agents. Same loopback, same registry, same
    // permission policy; saved definitions live beside the other app state.
    const { GroupChatRunner, GroupDefs } = require("./lib/groupchat");
    agents = {
      runner: new GroupChatRunner({ chatFn: loopbackChat, registry, onEvent: events }),
      defs: new GroupDefs(path.join(dataDir, "agent-teams.json")),
      registry,
    };
    // Koinos Code in the app (task #60 v3): the CLI's coding agent hosted by
    // Core, permission gates routed to approval cards over SSE. Same loopback
    // lane, so runs inherit every routing/privacy rule.
    const { CodeAgent } = require("./lib/code-agent");
    const { CodeProjects } = require("./lib/code-projects");
    /*
     * Koinos Code has its OWN switch and its own sidebar item (task #72). It
     * used to ride on the Developer-tools switch, but the two are different
     * questions: developer tools reveal multi-agent systems and a benchmark,
     * while Koinos Code writes files anywhere you point it and runs commands as
     * you. Someone should be able to want one without the other.
     *
     * MIGRATION: the switch is seeded from dev.tools the first time it is read,
     * so anyone who turned developer tools on to get Koinos Code keeps it and
     * nothing disappears out from under them.
     */
    const codeSwitch = {
      status: () => {
        let v = settings.get("code.enabled", null);
        if (v === null || v === undefined) {
          v = settings.get("dev.tools", false) === true;
          settings.set("code.enabled", v);
        }
        return { enabled: v === true };
      },
      configure: ({ enabled }) => {
        settings.set("code.enabled", enabled === true);
        events({ type: "code:switch", message: enabled === true ? "on" : "off" });
        return codeSwitch.status();
      },
    };
    code = new CodeAgent({ chatFn: loopbackChat, registry, onEvent: events });
    code.projects = new CodeProjects(dataDir);
    code.switch = codeSwitch;
    // GitHub for Koinos Code (task #73): clone a repo into a project, and push
    // work back. The token lives on this machine at 0600 and never enters a
    // command line, a remote URL, or any response body.
    const { GitHub } = require("./lib/github");
    code.github = new GitHub(dataDir);
    mcp.autoConnect().catch(() => {}); // reconnect servers the user used before

    // Local speech-to-text (§7: audio never leaves the machine). Engine+model
    // are catalog-pinned; nothing downloads until the user opts into setup.
    const { VoiceManager } = require("./lib/whisper");
    voice = new VoiceManager({
      provisioner,
      catalogPath: path.join(__dirname, "runtimes", "catalog.json"),
      voiceDir: path.join(dataDir, "voice"),
      onEvent: events,
    });
    speech = new (require("./lib/speech").SpeechManager)({ speechDir: path.join(dataDir, "voice", "kokoro") });
    turn = new (require("./lib/smart-turn").SmartTurnManager)({ modelPath: smartTurnModelPath() });
    staticAssets = liveSensesAssets();
    chats = new ChatStore(path.join(dataDir, "chats"));
    docs = new (require("./lib/docs").DocStore)(path.join(dataDir, "docs"));
  }
  const gateway = new Gateway({
    port: port ?? Number(process.env.KAI_CORE_PORT || release.port),
    runtime,
    models,
    keys,
    onEvent: events,
    uiDir: require("fs").existsSync(uiDir) ? uiDir : null,
    staticAssets,
    earn,
    network,
    voice,
    speech,
    turn,
    tools: registry,
    memory,
    mcp,
    nodeRuntime,
    email: emailSvc,
    calendar: calendarSvc,
    koinos: koinosSvc,
    koinosNode: koinosNodeSvc,
    teams,
    account,
    dev,
    bench,
    agents,
    code,
    chats,
    docs,
    coreInfo: () => ({ version: VERSION, channel: release.channel, productName: release.productName, dataDir, hardware: hw }),
    // Feedback relay: one honest box in the app, straight to the project's
    // inbox. The diagnostic tail is core.log — events only, no chat
    // content and no keys ever land there.
    feedback: async ({ message, email, includeLog }) => {
      const text = String(message || "").trim().slice(0, 4000);
      if (!text) throw new Error("Feedback needs a message");
      let logTail = null;
      if (includeLog) {
        try {
          const raw = fsl.readFileSync(logFile, "utf8");
          logTail = raw.split("\n").slice(-120).join("\n").slice(-16000);
        } catch { /* no log yet */ }
      }
      const target = process.env.KAI_FEEDBACK_URL || "https://koinosai.com/api/feedback";
      const r = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: text,
          email: email ? String(email).slice(0, 200) : null,
          appVersion: VERSION,
          platform: `${process.platform}-${process.arch}`,
          logTail,
        }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => {
        throw new Error("Could not reach the feedback server — check your connection and try again");
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error || `Feedback server answered ${r.status}`);
      events({ type: "feedback:sent" });
      return {};
    },
    extensions,
    // The router profile has no wallet UI on HTTP: RouterService calls earn,
    // wallet and network in-process, so their writes are refused over HTTP.
    earnHttpWrites: full,
  });

  if (full) {
    const { registerAppTools, appRequest } = require("./lib/app-tools");
    registerAppTools(registry, { request: appRequest(gateway), privacyMode: () => network.status().privacyMode });
  }

  return {
    settings,
    account,
    speech,
    turn,
    state,
    hardware: hw,
    keys,
    models,
    runtime,
    gateway,
    earn,
    network,
    wallet,
    events,
    dataDir,
    release,
    profile,
    async start() {
      const p = await gateway.listen();
      events({ type: "core:ready", message: `gateway on http://127.0.0.1:${p}` });
      // The router profile has no remote access, scheduled tasks or warm
      // start, and RouterService (not earn.autoStart) decides when to earn.
      if (full) {
        // Remote access (task #94): outbound long-poll to the relay so the
        // local API works from anywhere with zero router setup. Off by
        // default; resumes the user's last explicit choice, and start()
        // itself refuses while no API key exists.
        const { RemoteAccess } = require("./lib/remote-access");
        this.remote = new RemoteAccess({
          relayUrl: process.env.KAI_RELAY_URL || "https://koinosai.com",
          settings,
          keys,
          localBase: () => `http://127.0.0.1:${p}`,
          onEvent: events,
        });
        gateway.remote = this.remote;
        if (settings.get("remote.enabled", false) === true) {
          this.remote.start().catch((e) => events({ type: "remote:error", message: String(e.message) }));
        }
        // Scheduled tasks call chat through our own front door, so §7
        // privacy routing, budgets, and the kill switch govern them exactly
        // like a typed message.
        const { TaskRunner } = require("./lib/tasks");
        this.tasks = new TaskRunner({
          file: path.join(dataDir, "tasks.json"),
          chats: gateway.chats,
          onEvent: events,
          /*
           * Through the SAME loopback lane teams and bench use — the control
           * plane's /core/chat/completions, not the public /v1 API.
           *
           * This used to POST to /v1/chat/completions with no credentials, which
           * worked right up until the user created an API key: from that moment
           * `keys.required()` is true, every /v1 call needs a bearer token, and
           * every scheduled task failed with "Missing or invalid API key" — a
           * message about the external API, for a task the user set up in the
           * app and never gave a key to. The control-plane lane exists precisely
           * so that creating an external key cannot lock the app's own features
           * out of their own engine, and it carries KAI_CORE_TOKEN for headless
           * deployments as a bonus. A scheduled task is the app asking a
           * question on the user's behalf, so it goes where the app goes.
           */
          runChat: ({ model, prompt }) =>
            loopbackChat({ model, messages: [{ role: "user", content: prompt }] }),
        });
        gateway.tasks = this.tasks;
        this.tasks.start();
        // Warm start (fire-and-forget): if the model is already on disk, bring
        // the whole engine ladder up now so the first message answers instantly
        // instead of paying engine startup at send time.
        const ready = models.aliases().filter((a) => a.status === "ready");
        if (ready.length === 1) {
          runtime.ensure(ready[0].alias).catch((e) => events({ type: "runtime:warmstart-failed", message: String(e.message) }));
        }
        // Earning resumes by itself after a restart when the machine session
        // unlocked the wallet and the user had left earning on (§10: their
        // last explicit choice keeps ruling; Stop or Lock clears it).
        if (wallet.status().unlocked && settings.get("earn.autoStart", false)) {
          earn.start().then(
            () => events({ type: "earn:auto-resumed" }),
            (e) => events({ type: "earn:auto-resume-failed", message: String(e.message) })
          );
        }
      }
      // The Koinos node's own report to the dashboard — independent of the
      // Earn toggle. No-ops on a machine with no node, no wallet, or
      // local-only privacy.
      producerReporter?.start();
      syncKillSwitch().catch(() => {});
      this._policyTimer = setInterval(() => syncKillSwitch().catch(() => {}), 5 * 60 * 1000);
      this._policyTimer.unref?.();
      return p;
    },
    async stop() {
      this.remote?.stop();
      speech?.close();
      turn?.close();
      if (this._policyTimer) clearInterval(this._policyTimer);
      producerReporter?.stop();
      this.tasks?.stop();
      mcp?.closeAll(); // stdio tool servers are child processes — never orphan them
      await earn.stop({ userIntent: false }).catch(() => {});
      runtime.stop();
      await gateway.close();
    },
  };
}

module.exports = { createCore, VERSION };

if (require.main === module) {
  createCore()
    .then(async (core) => {
      const stop = async () => {
        await core.stop();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await core.start();
    })
    .catch((e) => {
      console.error("core failed to start:", e);
      process.exit(1);
    });
}
