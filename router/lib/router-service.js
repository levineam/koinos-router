"use strict";

const { EventEmitter } = require("events");
const { REASONS } = require("./idle-policy");

/*
 * RouterService: the two switches, mapped onto Core.
 *
 *   Share compute → wallet + share model on disk + earn.start(); the idle gate
 *                   (Electron's IdleController) then toggles earn backoff.
 *   Use KoinosAI  → privacy mode "network", so delegations can be signed and
 *                   sent; off means "local-only" again.
 *
 * Everything the UI shows is computed here from Core, the ledger and the
 * harness configs, so the copy table in ARCHITECTURE.md lives in one place.
 */

const COPY = Object.freeze({
  shareOff: "Earn KAI when your Mac is idle",
  shareInvite: "Turn on to earn KAI",
  shareError: "Couldn't get ready. Try again.",
  // The shell couldn't read the wallet password (Keychain access denied), so
  // retrying can't help until Router restarts and macOS asks again.
  shareLocked: "Wallet locked · Restart Router",
  gettingReady: "Getting ready",
  useOn: "Spend KAI on AI for Codex and Claude Code",
  useNoTools: "Connect Codex or Claude Code",
  useOut: "Codex and Claude Code are using their usual models",
  useLimit: "Daily limit reached",
});

const DAILY_LIMITS = [5, 10, 25, null];
const DEFAULT_DAILY_LIMIT_KAI = 10;
const HARNESS_NAMES = { codex: "Codex", claude: "Claude Code", other: "Agent" };
const OTHER_APP_URL = "http://127.0.0.1:41100/core/earn"; // the full KoinosAI app's Core
// /core/earn waits on the full app's own /balance call (4 s timeout) when its
// cache is stale, which is exactly when that app is earning: wait it out.
const OTHER_APP_TIMEOUT_MS = 6000;
const OTHER_APP_TTL_MS = 60000;
// The person came back while a job was streaming: retry the unload every
// second, and abort the job once it has run on for 15 s (MVP_SPEC §6.1).
const UNLOAD_RETRY_MS = 1000;
const UNLOAD_GRACE_MS = 15000;
const TOOLS = ["codex", "claude"];
// A koinos entry Router wrote: our loopback MCP endpoint on any port/token.
const ROUTER_MCP_URL_RE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/mcp\/[^/\s?#]+$/;
const SHARE_RETRY_MS = 5 * 60 * 1000;
const LEDGER_RETENTION_DAYS = 30;
const TITLE_CHARS = 60;
const GIB = 2 ** 30;

class ServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
  }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const finite = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function fmt1(n) {
  const v = Math.round(Number(n) * 10) / 10;
  return (Number.isFinite(v) && v !== 0 ? v : 0).toFixed(1);
}

// "1:32 PM" built by hand: ICU's en-US output uses a narrow no-break space
// before AM/PM on newer Node builds, which the UI would render oddly.
function clock(ms) {
  const d = new Date(ms);
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function clockRange(startMs, endMs) {
  const a = clock(startMs);
  const b = clock(endMs);
  if (a === b) return a;
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)} – ${b}` : `${a} – ${b}`;
}

function taskTitle(task) {
  const flat = String(task || "").replace(/\s+/g, " ").trim();
  if (!flat) return "Delegated task";
  return flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS - 1).trimEnd()}…` : flat;
}

const memoryBudgetGb = ({ ramBytes = 0, laptop = false, mode = "idle" } = {}) =>
  (Number(ramBytes) / GIB || 0) * (laptop && mode !== "always" ? 0.5 : 0.75);
const shareable = (a) => a && !a.dev && !a.custom && a.status !== "quarantined" && Number(a.minRamGb) > 0;
const largestFirst = (a, b) => b.minRamGb - a.minRamGb || (b.sizeBytes || 0) - (a.sizeBytes || 0);

/**
 * The model this Mac shares: the largest network-priced catalog class that
 * fits half the memory on a laptop (three quarters in "always" mode or on a
 * desktop). Dev, custom and quarantined models never qualify. Without a
 * usable pricing list, the largest catalog class within the same budget —
 * a guess that `fromPriced: false` tells the caller not to keep.
 * @returns {{ alias: string, fromPriced: boolean }}
 */
function chooseShareModel({ aliases = [], priced = null, ramBytes = 0, laptop = false, mode = "idle" } = {}) {
  const budget = memoryBudgetGb({ ramBytes, laptop, mode });
  const fits = aliases.filter((a) => shareable(a) && a.minRamGb <= budget).sort(largestFirst);
  if (Array.isArray(priced) && priced.length) {
    const listed = new Set(priced);
    const pick = fits.find((a) => listed.has(a.alias));
    if (pick) return { alias: pick.alias, fromPriced: true };
  }
  if (fits.length) return { alias: fits[0].alias, fromPriced: false };
  // Nothing fits the budget: the smallest class there is.
  const smallest = aliases.filter(shareable).sort((a, b) => a.minRamGb - b.minRamGb)[0];
  return { alias: smallest ? smallest.alias : "koinos-fast", fromPriced: false };
}

function pickShareModel(opts) {
  return chooseShareModel(opts).alias;
}

/**
 * Default otherAppEarning: is the full KoinosAI app's worker running here?
 * true/false, or null when it didn't answer in time (unknown: the caller
 * keeps what it knew, rather than flipping to "not earning" on a slow read).
 */
function probeFullApp(fetchImpl = fetch, timeoutMs = OTHER_APP_TIMEOUT_MS) {
  return async () => {
    try {
      const r = await fetchImpl(OTHER_APP_URL, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return false;
      const j = await r.json();
      return j?.worker?.running === true;
    } catch (e) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") return null;
      return false; // not installed or not running: nothing to defer to
    }
  };
}

class RouterService extends EventEmitter {
  constructor({
    core,
    ledger,
    delegate = null,
    connectors,
    settings = core?.settings,
    fetchImpl = fetch,
    now = () => Date.now(),
    otherAppEarning,
    laptop = () => false,
    walletPassword = null,
    pricedModels = async () => null,
    tickMs = 5000,
    statusDebounceMs = 150,
    appInfo = null,
  } = {}) {
    super();
    if (!core || !ledger || !connectors || !settings) throw new TypeError("RouterService needs core, ledger, connectors and settings");
    this.core = core;
    this.ledger = ledger;
    this.delegate = delegate;
    this.connectors = connectors;
    this.settings = settings;
    this.now = now;
    this.laptop = typeof laptop === "function" ? laptop : () => Boolean(laptop);
    this.walletPassword = walletPassword;
    this.pricedModels = pricedModels;
    this.tickMs = tickMs;
    this.statusDebounceMs = statusDebounceMs;
    this.log = typeof core.events === "function" ? core.events : () => {};
    this._probeOtherApp = typeof otherAppEarning === "function" ? otherAppEarning : probeFullApp(fetchImpl);
    this._otherApp = { at: 0, value: false, pending: null };
    this._gate = null; // last idle decision; null = no idle controller yet, so sharing runs
    this._gateWhileOff = false; // _gate was decided with Share off, so it says nothing about now
    this._unload = null; // { since } while a model unload waits for a streaming job
    this._unloadTimer = null;
    this._stopped = false; // stop() ran: nothing may start sharing again
    this._repair = null; // in-flight harness config repair (start())
    this._prep = { state: "idle" };
    this._sharing = null; // in-flight _startShare()
    this._shareEpoch = 0; // bumped by every Share off, so a stale start knows it lost
    this._session = null; // { startedAt, jobs0 } while the worker is serving
    this._timer = null;
    this._emitTimer = null;
    this._lastStatusJson = null;
    this._appInfo = typeof appInfo === "function" ? appInfo : null;
  }

  // -------------------------------------------------------------- app info

  /**
   * What the shell knows about the app itself (its version, whether a newer
   * Router is out, one-time hints), reported as Status.app. The shell sets
   * the provider after createRouterCore; without one Status.app is empty.
   */
  setAppInfo(provider) {
    this._appInfo = typeof provider === "function" ? provider : null;
  }

  /** The provider's answer changed (an update was found, a hint dismissed). */
  appInfoChanged() {
    this._changed();
  }

  _app() {
    let info = null;
    try {
      info = this._appInfo ? this._appInfo() : null;
    } catch (e) {
      this.log({ type: "router:app-info-failed", message: String(e?.message || e) });
    }
    const u = info?.update;
    const update =
      u?.available === true && typeof u.version === "string" && typeof u.url === "string"
        ? { available: true, version: u.version, url: u.url }
        : { available: false, version: null, url: null };
    const hint = info?.hints?.menuBar;
    return {
      version: typeof info?.version === "string" && info.version ? info.version : null,
      update,
      hints: { menuBar: hint === "notch" || hint === "menu-bar" ? hint : null },
    };
  }

  // ------------------------------------------------------------- lifecycle

  async start() {
    this._stopped = false;
    try {
      this.ledger.prune({ days: LEDGER_RETENTION_DAYS });
    } catch (e) {
      this.log({ type: "router:ledger-prune-failed", message: String(e.message) });
    }
    const useOn = this._useOn();
    if (useOn || this._shareOn()) {
      await this.ensureWallet().catch((e) => this.log({ type: "router:wallet-unavailable", message: String(e.message) }));
    }
    // Re-assert the privacy mode every launch: Use is the only thing that may
    // send prompts off this Mac, whatever an earlier run left in settings.
    this._syncPrivacy();
    if (this._shareOn()) this._startShare();
    this._refreshOtherApp();
    this._timer = setInterval(() => this._tick(), this.tickMs);
    this._timer.unref?.();
    // The gateway is listening now, so the MCP URL is final for this run.
    this._repair = this._repairConnections().catch((e) => this.log({ type: "router:repair-failed", message: String(e.message) }));
  }

  async stop() {
    // From here on nothing restarts sharing: a late status() poll, a timer or
    // a start still winding down would otherwise bring a worker back up while
    // Router quits.
    this._stopped = true;
    this._shareEpoch += 1;
    if (this._prep.state === "preparing") this.core.models.cancelDownload?.();
    clearInterval(this._timer);
    clearTimeout(this._emitTimer);
    this._timer = this._emitTimer = null;
    this._cancelUnload();
    try {
      const es = await this.core.earn.status();
      this._closeSession(es?.worker);
    } catch {
      /* Core may already be down; the session just goes unrecorded */
    }
  }

  // --------------------------------------------------------------- reading

  async status() {
    const es = await this.core.earn.status().catch(() => null);
    const worker = es?.worker || { running: false, jobsDone: 0 };
    this._trackSession(worker);
    this._retryUnload();
    // Sharing was up and the worker went away under us (kill switch, a
    // crash): start over, which either recovers or lands in the error state.
    if (!this._stopped && this._shareOn() && this._prep.state === "ready" && !worker.running && !this._sharing) this._startShare();
    const total = this._observeBalance(es?.earnings);
    const lastKai = finite(this.settings.get("router.lastBalanceKai", null));
    const balanceKai = total ?? lastKai;
    const today = this._today(balanceKai);
    const connected = await this._connected();
    const shareOn = this._shareOn();
    const useOn = this._useOn();
    const outOfKai = useOn && !!this.settings.get("router.outOfKai", null);

    const share = this._shareRow({ shareOn, worker, earnedKai: today.earnedKai, outOfKai });
    const use = this._useRow({ useOn, outOfKai, spentKai: today.spentKai, connected });
    const wallet = this.core.wallet.status();
    return {
      onboarded: this.settings.get("router.onboarded", false) === true,
      balance: { kai: balanceKai, label: balanceKai === null ? "—" : fmt1(balanceKai) },
      today,
      headline: this._headline({ share, shareOn, useOn, outOfKai }),
      share,
      use,
      wallet: { exists: !!wallet.exists, address: wallet.address || null },
      app: this._app(),
    };
  }

  async activity() {
    const lastKai = finite(this.settings.get("router.lastBalanceKai", null));
    const items = [];
    for (const e of this.ledger.list({ limit: 100 })) {
      if (e.kind === "delegate") {
        // A refused attempt while Use KoinosAI was off did nothing worth listing.
        if (e.error === "PAUSED") continue;
        items.push({
          id: e.id,
          kind: "delegate",
          at: e.at,
          title: taskTitle(e.task),
          subtitle: `${HARNESS_NAMES[e.harness] || HARNESS_NAMES.other} · ${clock(e.at)}`,
          kai: finite(e.kai),
          ok: e.ok !== false,
        });
      } else if (e.kind === "share") {
        const jobs = Number(e.jobs) || 0;
        const start = finite(e.startedAt) ?? e.at;
        const end = finite(e.endedAt) ?? e.at;
        items.push({
          id: e.id,
          kind: "share",
          at: end,
          title: `Shared compute · ${jobs} ${jobs === 1 ? "job" : "jobs"}`,
          subtitle: `This Mac · ${clockRange(start, end)}`,
          kai: finite(e.kai),
          ok: true,
        });
      }
    }
    return { today: this._today(lastKai), items };
  }

  async getSettings() {
    const laptop = this._isLaptop();
    const wallet = this.core.wallet.status();
    return {
      share: {
        mode: this._shareMode(),
        pluggedInOnly: this.settings.get("router.share.pluggedInOnly", laptop) === true,
      },
      use: { dailyLimitKai: this._dailyLimit() },
      general: { openAtLogin: this.settings.get("router.general.openAtLogin", true) !== false },
      wallet: { address: wallet.address || null },
      connections: await this.connections(),
    };
  }

  async connections() {
    return this.connectors.status();
  }

  /** decideShare() inputs minus the Mac signals, for Electron's IdleController. */
  idleInputs() {
    return {
      enabled: this._shareOn(),
      mode: this._shareMode(),
      pluggedInOnly: this.settings.get("router.share.pluggedInOnly", this._isLaptop()) === true,
      laptop: this._isLaptop(),
      otherAppEarning: this.otherAppEarning(),
    };
  }

  /** Cached answer (refreshed in the background at most once a minute). */
  otherAppEarning() {
    if (this.now() - this._otherApp.at > OTHER_APP_TTL_MS) this._refreshOtherApp();
    return this._otherApp.value;
  }

  /** What DelegateEngine checks before every network call. */
  delegateLimits() {
    return { enabled: this._useOn(), dailyLimitKai: this._dailyLimit() };
  }

  // --------------------------------------------------------------- writing

  async setShare(enabled) {
    enabled = enabled === true;
    if (enabled) {
      await this._ensureWalletOr503();
      this.settings.set("router.share.enabled", true);
      const es = await this.core.earn.status().catch(() => null);
      if (!(this._prep.state === "ready" && es?.worker?.running)) this._startShare();
    } else {
      this.settings.set("router.share.enabled", false);
      await this._stopShare();
    }
    this._changed();
    return this.status();
  }

  async setUse(enabled) {
    enabled = enabled === true;
    if (enabled) await this._ensureWalletOr503();
    this.settings.set("router.use.enabled", enabled);
    this._syncPrivacy();
    this._changed();
    return this.status();
  }

  async updateSettings(patch) {
    if (!isPlainObject(patch)) throw new ServiceError(400, "Send the settings to change as an object.");
    const writes = [];
    const { share, use, general } = patch;
    if (share !== undefined) {
      if (!isPlainObject(share)) throw new ServiceError(400, "Share settings must be an object.");
      if (share.mode !== undefined) {
        if (share.mode !== "idle" && share.mode !== "always") throw new ServiceError(400, "Share mode must be idle or always.");
        writes.push(["router.share.mode", share.mode]);
      }
      if (share.pluggedInOnly !== undefined) {
        if (typeof share.pluggedInOnly !== "boolean") throw new ServiceError(400, "Only when plugged in must be true or false.");
        writes.push(["router.share.pluggedInOnly", share.pluggedInOnly]);
      }
    }
    if (use !== undefined) {
      if (!isPlainObject(use)) throw new ServiceError(400, "Use settings must be an object.");
      if (use.dailyLimitKai !== undefined) {
        if (!DAILY_LIMITS.includes(use.dailyLimitKai)) throw new ServiceError(400, "The daily limit must be 5, 10, 25 KAI or no limit.");
        writes.push(["router.use.dailyLimitKai", use.dailyLimitKai]);
      }
    }
    if (general !== undefined) {
      if (!isPlainObject(general)) throw new ServiceError(400, "General settings must be an object.");
      if (general.openAtLogin !== undefined) {
        if (typeof general.openAtLogin !== "boolean") throw new ServiceError(400, "Open at login must be true or false.");
        writes.push(["router.general.openAtLogin", general.openAtLogin]);
      }
    }
    // Validate everything first so a bad field never leaves a half-applied patch.
    for (const [key, value] of writes) this.settings.set(key, value);
    const out = await this.getSettings();
    if (writes.length) {
      this.emit("settings", out);
      this._changed();
    }
    return out;
  }

  async connect(tool) {
    const out = await this.connectors.connect(tool);
    // Remembered so a later port or token change can repair this config —
    // and only configs Router itself connected.
    if (out?.[tool]?.connected) this.settings.set(`router.connected.${tool}`, true);
    this._changed();
    return out;
  }

  async disconnect(tool) {
    const out = await this.connectors.disconnect(tool);
    if (TOOLS.includes(tool)) this.settings.set(`router.connected.${tool}`, false);
    this._changed();
    return out;
  }

  /**
   * End of Welcome → Connect. The first completion turns on whichever switch
   * the user hasn't touched, so a new install earns and spends right away —
   * except Share on a restored wallet: that wallet may already be sharing
   * from another Mac, and two sharers on one wallet knock each other off.
   * (A wallet that merely exists — Use switched on from the popover first —
   * is a new one, and does get Share.)
   */
  async completeOnboarding() {
    await this._ensureWalletOr503();
    const restored = this.settings.get("router.walletRestored", false) === true;
    const first = this.settings.get("router.onboarded", false) !== true;
    this.settings.set("router.onboarded", true);
    if (first) {
      if (this.settings.get("router.use.enabled", null) === null) await this.setUse(true);
      if (this.settings.get("router.share.enabled", null) === null && !restored) await this.setShare(true);
    }
    this._changed();
    return this.status();
  }

  /** Called by the Electron idle controller (tests call it directly). */
  setShareGate(decision) {
    const d = isPlainObject(decision) ? decision : {};
    this._gate = { run: d.run !== false, reason: d.reason ?? null, unload: d.unload === true };
    this._gateWhileOff = !this._shareOn();
    this._applyGate();
    this._changed();
  }

  /** Called after every delegate run so Out of KAI follows the network. */
  noteDelegate({ ok, code } = {}) {
    if (code === "OUT_OF_KAI") {
      this.settings.set("router.outOfKai", { at: this.now(), baselineKai: null });
      // The next balance read must be fresh, or a cached free allowance from
      // before the refusal would clear the flag straight away.
      this.core.earn.invalidateEarnings?.();
    } else if (ok && this.settings.get("router.outOfKai", null)) {
      this.settings.set("router.outOfKai", null);
    }
    this._changed();
  }

  // ---------------------------------------------------------------- wallet

  /** Create the wallet on first use, or unlock it, with the shell's password. */
  async ensureWallet({ password } = {}) {
    const s = this.core.wallet.status();
    if (s.exists && s.unlocked) return { address: s.address };
    const pw = password || this.walletPassword;
    if (!pw) throw new ServiceError(503, "Router can't open its wallet yet. Restart Router and try again.");
    if (!s.exists) {
      const { address } = this.core.earn.createWallet({ password: pw });
      return { address };
    }
    return { address: this.core.earn.unlock({ password: pw }).address };
  }

  async restoreWallet({ wif, password } = {}) {
    const pw = password || this.walletPassword;
    if (!pw) throw new ServiceError(503, "Router can't open its wallet yet. Restart Router and try again.");
    const wasSharing = this._shareOn();
    if (wasSharing) await this._stopShare({ userIntent: false });
    let r;
    try {
      r = await this.core.earn.restoreWallet({ wif, password: pw });
    } catch (e) {
      // A mistyped key changes nothing: the old wallet is still the wallet,
      // so sharing goes back to how it was.
      if (wasSharing && this._shareOn() && !this._stopped) this._startShare();
      this._changed();
      throw e;
    }
    // A different wallet: the balance, refusals and today's starting balance
    // belonged to the old one.
    this.settings.set("router.lastBalanceKai", null);
    this.settings.set("router.outOfKai", null);
    this.settings.set("router.walletRestored", true);
    try {
      this.ledger.resetBaseline?.();
    } catch (e) {
      this.log({ type: "router:ledger-error", message: String(e.message) });
    }
    this.core.earn.invalidateEarnings?.();
    // One sharer per wallet (MVP_SPEC §6.5): the restored wallet may already
    // be sharing from another Mac, so Share stays off until the user turns it on.
    if (wasSharing) this.settings.set("router.share.enabled", false);
    this._changed();
    return { address: r.address };
  }

  async revealBackup({ password } = {}) {
    const pw = password || this.walletPassword;
    if (!pw) throw new ServiceError(503, "Router can't open its wallet yet. Restart Router and try again.");
    return this.core.earn.revealWallet({ password: pw });
  }

  // ------------------------------------------------------------- internals

  _shareOn() {
    return this.settings.get("router.share.enabled", false) === true;
  }

  _useOn() {
    return this.settings.get("router.use.enabled", false) === true;
  }

  _isLaptop() {
    try {
      return this.laptop() === true;
    } catch {
      return false;
    }
  }

  _shareMode() {
    const m = this.settings.get("router.share.mode", null);
    return m === "idle" || m === "always" ? m : this._isLaptop() ? "idle" : "always";
  }

  _dailyLimit() {
    const v = this.settings.get("router.use.dailyLimitKai", undefined);
    return DAILY_LIMITS.includes(v) ? v : DEFAULT_DAILY_LIMIT_KAI;
  }

  async _ensureWalletOr503() {
    try {
      await this.ensureWallet();
    } catch (e) {
      this.log({ type: "router:wallet-unavailable", message: String(e.message) });
      if (e instanceof ServiceError) throw e;
      throw new ServiceError(503, "Router couldn't open its wallet. Restart Router and try again.");
    }
  }

  _syncPrivacy() {
    const want = this._useOn() ? "network" : "local-only";
    if (this.core.network.status().privacyMode !== want) this.core.network.configure({ privacyMode: want });
  }

  _startShare() {
    if (this._stopped) return Promise.resolve();
    if (this._sharing) return this._sharing;
    const epoch = this._shareEpoch;
    const stale = () => epoch !== this._shareEpoch || !this._shareOn();
    this._prep = { state: "preparing" };
    this._changed();
    const run = (async () => {
      try {
        await this.ensureWallet();
        const alias = await this._shareModel();
        const { packageId } = this.core.models.resolveAlias(alias);
        await this.core.runtime.preflight();
        const provisioner = this.core.runtime.provisioner;
        if (provisioner) {
          // Fetch the engine now so the first job doesn't pay for it; if it
          // fails, the runtime's own heal/fallback ladder still gets a turn.
          await provisioner.ensure("llamacpp").catch((e) => this.log({ type: "router:engine-prefetch-failed", message: String(e.message) }));
        }
        if (stale()) return;
        await this.core.models.ensurePackage(packageId);
        if (stale()) return;
        await this.core.earn.start();
        if (stale()) {
          await this.core.earn.stop({ userIntent: false });
          return;
        }
        this._prep = { state: "ready", alias };
        this._applyGate();
        this.log({ type: "router:share-started", message: alias });
      } catch (e) {
        this.log({ type: "router:share-failed", message: String(e.message) });
        if (!stale()) this._prep = { state: "error", at: this.now(), locked: !this.walletPassword && e instanceof ServiceError && e.status === 503 };
      } finally {
        if (this._prep.state === "preparing") this._prep = { state: "idle" };
        this._sharing = null;
        this._changed();
      }
    })();
    this._sharing = run;
    // A Share off → on while the old start was still winding down: start again.
    run.then(() => {
      if (!this._stopped && epoch !== this._shareEpoch && this._shareOn() && this._prep.state !== "ready") this._startShare();
    });
    return run;
  }

  async _stopShare({ userIntent = true } = {}) {
    this._shareEpoch += 1;
    if (this._prep.state === "preparing") this.core.models.cancelDownload?.();
    this._prep = { state: "idle" };
    try {
      await this.core.earn.stop({ userIntent });
    } catch (e) {
      this.log({ type: "router:share-stop-failed", message: String(e.message) });
    }
    const es = await this.core.earn.status().catch(() => null);
    this._closeSession(es?.worker);
  }

  /**
   * The alias to share. A saved pick is re-checked every time against the
   * memory budget and, when the network's price list is available, against
   * it: a pick made offline, or before the user switched mode, must not keep
   * an oversized or unscheduled model forever. Only a pick made from the real
   * price list is saved. A dev or custom alias in settings is a developer's
   * deliberate choice and is used as is.
   */
  async _shareModel() {
    let priced = null;
    try {
      priced = await this.pricedModels();
    } catch {
      priced = null;
    }
    const aliases = this.core.models.aliases();
    const ctx = { aliases, priced, ramBytes: this.core.hardware?.ramBytes, laptop: this._isLaptop(), mode: this._shareMode() };
    const saved = this.settings.get("router.shareModel", null);
    if (saved) {
      try {
        this.core.models.resolveAlias(saved);
        if (this._shareModelStillFits(saved, ctx)) return saved;
        this.log({ type: "router:share-model-replaced", message: saved });
      } catch (e) {
        this.log({ type: "router:share-model-invalid", message: `${saved}: ${e.message}` });
      }
    }
    const { alias, fromPriced } = chooseShareModel(ctx);
    // A guess without the price list is used for this start only.
    this.settings.set("router.shareModel", fromPriced ? alias : null);
    this.log({ type: "router:share-model", message: fromPriced ? alias : `${alias} (no price list; not saved)` });
    return alias;
  }

  _shareModelStillFits(alias, { aliases, priced, ...budget }) {
    const entry = aliases.find((a) => a.alias === alias);
    if (!entry || entry.dev || entry.custom) return true;
    if (!shareable(entry) || entry.minRamGb > memoryBudgetGb(budget)) return false;
    return !(Array.isArray(priced) && priced.length) || priced.includes(alias);
  }

  /**
   * The idle decision to act on. One recorded while Share was off is
   * {run:false, reason:null} and says nothing about now; until the idle
   * controller's next tick, "idle" mode backs off (whoever just switched
   * Share on is at the Mac) and "always" mode runs.
   */
  _effectiveGate() {
    if (!this._gateWhileOff) return this._gate;
    return this._shareMode() === "idle" ? { run: false, reason: REASONS.active, unload: false } : null;
  }

  _applyGate() {
    if (!this._shareOn()) return;
    const g = this._effectiveGate();
    const run = !g || g.run;
    this.core.earn.setBackoff(!run, run ? null : g.reason || REASONS.active);
    // Unified memory goes back to the person the moment they return — but
    // never out from under an answer that is still streaming; that waits.
    if (!run && g.unload) this._requestUnload();
    else this._cancelUnload();
  }

  _requestUnload() {
    if (!this._unload) this._unload = { since: this.now() };
    this._retryUnload();
    if (this._unload && !this._unloadTimer) {
      this._unloadTimer = setInterval(() => this._retryUnload(), UNLOAD_RETRY_MS);
      this._unloadTimer.unref?.();
    }
  }

  _cancelUnload() {
    this._unload = null;
    clearInterval(this._unloadTimer);
    this._unloadTimer = null;
  }

  /** The idle controller applies a decision once; the unload it asked for
   *  is retried here until the job in flight is done (or has had 15 s). */
  _retryUnload() {
    if (!this._unload) return;
    const g = this._effectiveGate();
    if (this._stopped || !this._shareOn() || !g || g.run || !g.unload) return this._cancelUnload();
    let busy = false;
    try {
      busy = this.core.runtime.busy() === true;
    } catch {
      busy = false;
    }
    if (busy && this.now() - this._unload.since < UNLOAD_GRACE_MS) return;
    if (busy) this.log({ type: "router:unload-forced", message: "a job was still running 15 s after the person came back" });
    this._cancelUnload();
    this.core.runtime.stop();
  }

  _trackSession(worker) {
    const serving = !!worker?.running && !worker.backoff;
    if (serving && !this._session) {
      this._session = { startedAt: this.now(), jobs0: Number(worker.jobsDone) || 0 };
    } else if (!serving && this._session) {
      // Backoff only stops new jobs: one already running still finishes and
      // counts, so the stretch stays open until it is done.
      if (worker?.running && worker.backoff && this._jobInFlight()) return;
      this._closeSession(worker);
    }
  }

  _jobInFlight() {
    try {
      return this.core.runtime.busy() === true;
    } catch {
      return false;
    }
  }

  _closeSession(worker) {
    const s = this._session;
    if (!s) return;
    this._session = null;
    const jobsNow = Number(worker?.jobsDone);
    // A new Worker (Share off → on) restarts its counter at zero.
    const jobs = Number.isFinite(jobsNow) && jobsNow >= s.jobs0 ? jobsNow - s.jobs0 : 0;
    if (jobs <= 0) return; // an idle stretch with no jobs isn't activity
    try {
      this.ledger.record({ kind: "share", jobs, startedAt: s.startedAt, endedAt: this.now(), kai: null });
    } catch (e) {
      this.log({ type: "router:ledger-error", message: String(e.message) });
    }
  }

  /** Displayed balance = kai + pendingKai; also feeds the ledger and Out of KAI. */
  _observeBalance(earnings) {
    if (!earnings || earnings.error) return null;
    const kai = finite(earnings.kai);
    if (kai === null) return null;
    const total = kai + (finite(earnings.pendingKai) ?? 0);
    if (this.settings.get("router.lastBalanceKai", null) !== total) this.settings.set("router.lastBalanceKai", total);
    try {
      this.ledger.observeBalance(total);
    } catch (e) {
      this.log({ type: "router:ledger-error", message: String(e.message) });
    }
    const out = this.settings.get("router.outOfKai", null);
    if (out) {
      const free = finite(earnings.freeTokensRemaining);
      const baseline = finite(out.baselineKai);
      if ((free !== null && free > 0) || (baseline !== null && total > baseline + 1e-9)) {
        this.settings.set("router.outOfKai", null);
        this.log({ type: "router:out-of-kai-cleared" });
      } else if (baseline === null) {
        this.settings.set("router.outOfKai", { ...out, baselineKai: total });
      }
    }
    return total;
  }

  _today(balanceKai) {
    const t = this.ledger.today();
    // The ledger's earnedKai counts priced share entries; earnedToday() is the
    // balance-based estimate. They measure different things, so they add.
    const fromBalance = balanceKai === null ? 0 : this.ledger.earnedToday(balanceKai);
    return { earnedKai: fromBalance + (t.earnedKai || 0), spentKai: t.spentKai || 0 };
  }

  async _connected() {
    try {
      const c = await this.connectors.status();
      return { codex: !!c?.codex?.connected, claude: !!c?.claude?.connected };
    } catch (e) {
      this.log({ type: "router:connections-failed", message: String(e.message) });
      return { codex: false, claude: false };
    }
  }

  _sharePct() {
    const d = this.core.models.downloadProgress?.();
    const p = d?.pct ?? this.core.runtime.provisioner?.downloadProgress?.()?.pct ?? null;
    return p === null || !Number.isFinite(Number(p)) ? null : Math.max(0, Math.min(100, Math.round(p)));
  }

  _shareRow({ shareOn, worker, earnedKai, outOfKai }) {
    if (!shareOn) return { enabled: false, state: "off", detail: outOfKai ? COPY.shareInvite : COPY.shareOff, pct: null };
    if (this._prep.state === "error") return { enabled: true, state: "error", detail: this._prep.locked ? COPY.shareLocked : COPY.shareError, pct: null };
    if (this._prep.state === "preparing" || !worker.running) {
      const pct = this._sharePct();
      return { enabled: true, state: "preparing", detail: pct === null ? COPY.gettingReady : `${COPY.gettingReady} · ${pct}%`, pct };
    }
    const g = this._effectiveGate();
    if ((g && !g.run) || worker.backoff) {
      return { enabled: true, state: "waiting", detail: (g && !g.run && g.reason) || REASONS.active, pct: null };
    }
    return { enabled: true, state: "earning", detail: `+${fmt1(earnedKai)} KAI today`, pct: null };
  }

  _useRow({ useOn, outOfKai, spentKai, connected }) {
    const base = { enabled: useOn, connected };
    if (!useOn) return { ...base, state: "off", detail: COPY.useOn };
    if (outOfKai) return { ...base, state: "out-of-kai", detail: COPY.useOut };
    const limit = this._dailyLimit();
    if (limit !== null && spentKai >= limit) return { ...base, state: "limit", detail: COPY.useLimit };
    if (!connected.codex && !connected.claude) return { ...base, state: "no-tools", detail: COPY.useNoTools };
    return { ...base, state: "on", detail: COPY.useOn };
  }

  // Precedence: preparing > out-of-kai > earning > ready > paused.
  _headline({ share, shareOn, useOn, outOfKai }) {
    if (share.state === "preparing") return { label: "Getting ready", tone: "busy", pct: share.pct };
    if (outOfKai) return { label: "Out of KAI", tone: "warn", pct: null };
    if (share.state === "earning") return { label: "Earning", tone: "good", pct: null };
    if (shareOn || useOn) return { label: "Ready", tone: "good", pct: null };
    return { label: "Paused", tone: "idle", pct: null };
  }

  _refreshOtherApp() {
    if (this._otherApp.pending) return this._otherApp.pending;
    // Router on the full app's port would be asking itself.
    const self = this.core.gateway?.port === 41100;
    const p = Promise.resolve()
      .then(() => (self ? false : this._probeOtherApp()))
      .then(
        (v) => (v === null ? null : v === true),
        () => false
      )
      .then((answer) => {
        // No answer in time: keep what we knew rather than guess "not earning".
        const value = answer === null ? this._otherApp.value : answer;
        const changed = value !== this._otherApp.value;
        this._otherApp = { at: this.now(), value, pending: null };
        if (changed) this.log({ type: "router:other-app-earning", message: value ? "yes" : "no" });
        return value;
      });
    this._otherApp.pending = p;
    return p;
  }

  _tick() {
    if (this._stopped) return;
    if (this._shareOn() && this._prep.state === "error" && !this._prep.locked && this.now() - (this._prep.at || 0) > SHARE_RETRY_MS) {
      this._startShare();
    }
    this._retryUnload();
    this._emitStatus();
  }

  /**
   * Harness configs carry Router's MCP URL, port and token included. When
   * either changes (port 41110 taken at launch, a reset token), a config
   * Router connected still points at the old URL and the harness silently
   * loses the tool. Reconnect those — and only those: a koinos entry Router
   * didn't connect, or one the user re-pointed elsewhere, is left alone.
   */
  async _repairConnections() {
    const status = await this.connectors.status();
    for (const tool of TOOLS) {
      const key = `router.connected.${tool}`;
      if (status?.[tool]?.connected) {
        // Our current URL, token and all: Router wrote it.
        if (this.settings.get(key, null) !== true) this.settings.set(key, true);
        continue;
      }
      if (this.settings.get(key, false) !== true || this._stopped) continue;
      const url = typeof this.connectors.configuredUrl === "function" ? await this.connectors.configuredUrl(tool) : null;
      if (!url || !ROUTER_MCP_URL_RE.test(url)) continue;
      try {
        await this.connectors.connect(tool);
        this.log({ type: "router:connection-repaired", message: tool });
      } catch (e) {
        this.log({ type: "router:connection-repair-failed", message: `${tool}: ${e.message}` });
      }
    }
    this._changed();
  }

  /** Debounced "status" event; main.js uses it for the tray title. */
  _changed() {
    if (this._stopped || this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      this._emitStatus();
    }, this.statusDebounceMs);
    this._emitTimer.unref?.();
  }

  _emitStatus() {
    this.status().then(
      (st) => {
        const json = JSON.stringify(st);
        if (json === this._lastStatusJson) return;
        this._lastStatusJson = json;
        this.emit("status", st);
      },
      (e) => this.log({ type: "router:status-failed", message: String(e.message) })
    );
  }
}

module.exports = {
  RouterService,
  ServiceError,
  pickShareModel,
  chooseShareModel,
  probeFullApp,
  COPY,
  DAILY_LIMITS,
  clock,
  clockRange,
  taskTitle,
};
