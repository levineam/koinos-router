"use strict";

/*
 * Koinos Router: the menu-bar shell. Like the full app's shell it is thin. It
 * boots the router profile of Core in-process (router/lib/router-core.js) and
 * shows the pages the Router gateway serves from router/ui. All product logic
 * lives in RouterService; this file owns only what needs Electron: the tray,
 * the two windows, Mac idle signals, the power blocker, the login item, the
 * update notice, and the wallet backup/restore dialogs that must never touch
 * the HTTP API.
 *
 * The pure helpers at the top are exported so router/test/shell.test.js can
 * run them in plain Node; the Electron part only runs in Electron's main
 * process.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { LAPTOP_PROBE_MAX_MS } = require("./lib/mac-signals");
const { isReleaseUrl } = require("./lib/update-check");

const PRODUCT_NAME = "Koinos Router";
const PRELOAD = path.join(__dirname, "preload.js");
const TRAY_ICON = path.join(__dirname, "assets", "trayTemplate.png");
const VIEWS = new Set(["main", "activity", "settings", "welcome", "connect", "restore"]);
const PAGES = { main: ["/", "/index.html"], popover: ["/popover.html"] };
const SHELL_METHODS = ["backupWallet", "closePopover", "dismissHint", "open", "popoverHeight", "quit", "restoreWallet"];
// One-time hints the main window can show; the value stored once one is done.
const HINTS = { menuBar: "router.hints.menuBar" };
const HINT_DONE = "done";
// A notched MacBook's menu bar is 37-38 pt tall (it matches the notch); a
// plain one is 24-25 pt. Anything from here up means "this screen has a notch".
const NOTCH_MENU_BAR_MIN = 32;

const MAIN_WIDTH = 600;
const MAIN_HEIGHT = 540;
const POPOVER_WIDTH = 300;
const POPOVER_MIN_HEIGHT = 120;
const POPOVER_MAX_HEIGHT = 520;
const POPOVER_DEFAULT_HEIGHT = 330;
const POPOVER_GAP = 4;
// A click on the tray while the popover is open first blurs (hides) it; the
// click that follows must not open it again straight away.
const REOPEN_GUARD_MS = 300;
const PAUSED_ICON_ALPHA = 0.42;
// Electron's tray title understands ANSI colours; "bold black" is its
// #7f7f7f grey, which reads as dimmed on a light or a dark menu bar.
const PAUSED_TITLE_ANSI = "\x1b[1;30m";
// The laptop probe decides the share model's memory budget and the
// idle/plugged-in defaults, so Share must not start before it answers. The
// probe always settles within LAPTOP_PROBE_MAX_MS; the extra second is slack.
const SIGNALS_WAIT_MS = LAPTOP_PROBE_MAX_MS + 1000;
const SHUTDOWN_WAIT_MS = 8000;
const SMOKE_TIMEOUT_MS = 45000;
const CLIPBOARD_CLEAR_MS = 90_000;
const MAX_WIF_CHARS = 200;
const RESTORE_FAILED = "That recovery key didn’t work. Check it and try again.";
const OWNER_AUTH_REASON = "show your recovery key";
const OWNER_AUTH_FAILED = "Router couldn’t confirm it’s you, so your recovery key stays hidden.";
const OWNER_AUTH_NO_PASSWORD = "Set a login password for this Mac, then try again. Router shows your recovery key only after you confirm it’s you.";
const OWNER_AUTH_UNAVAILABLE = "This Mac can’t confirm it’s you right now, so Router won’t show your recovery key.";
const COPY_FAILED = "Router couldn’t copy your recovery key. Open Back up again and write it down instead.";

// Copies stdin to a pasteboard (the general one, or the named one in argv[0])
// marked concealed and transient (nspasteboard.org), so clipboard managers
// that honour the markers never record it, and limited to this Mac, so
// Universal Clipboard doesn't hand it to the user's other devices. One write:
// Electron's clipboard API can't combine text with custom types.
const OSASCRIPT = "/usr/bin/osascript";
const CONCEALED_TYPES = ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType"];
const CONCEALED_COPY_JXA = `ObjC.import("AppKit");
function run(argv) {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  const pb = argv.length ? $.NSPasteboard.pasteboardWithName(argv[0]) : $.NSPasteboard.generalPasteboard;
  pb.prepareForNewContentsWithOptions($.NSPasteboardContentsCurrentHostOnly || 1);
  let ok = pb.setStringForType(text, $.NSPasteboardTypeString);
  for (const type of ${JSON.stringify(CONCEALED_TYPES)}) ok = ok && pb.setDataForType($.NSData.data, type);
  if (!ok) throw new Error("pasteboard write failed");
  return "ok";
}`;

// ------------------------------------------------------------ pure helpers

function isSmoke(argv = process.argv, env = process.env) {
  return argv.includes("--smoke") || env.KOINOS_ROUTER_SMOKE === "1";
}

function clampPopoverHeight(px) {
  const n = Number(px);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(POPOVER_MAX_HEIGHT, Math.max(POPOVER_MIN_HEIGHT, n)));
}

/** Popover frame centred under the tray icon, kept inside the display's work area. */
function popoverBounds(trayBounds, workArea, height = POPOVER_DEFAULT_HEIGHT) {
  const width = POPOVER_WIDTH;
  const t = trayBounds && trayBounds.width > 0 ? trayBounds : null;
  let x = t ? Math.round(t.x + t.width / 2 - width / 2) : workArea.x + workArea.width - width - 8;
  let y = t ? Math.round(t.y + t.height + POPOVER_GAP) : workArea.y + POPOVER_GAP;
  x = Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width);
  y = Math.min(Math.max(y, workArea.y), Math.max(workArea.y, workArea.y + workArea.height - height));
  return { x, y, width, height };
}

/** "main" | "popover" | null for a URL on our gateway origin. */
function pageOf(url, origin) {
  try {
    const u = new URL(url);
    if (u.origin !== origin) return null;
    for (const [page, paths] of Object.entries(PAGES)) if (paths.includes(u.pathname)) return page;
  } catch {
    /* not a URL */
  }
  return null;
}

/**
 * Which of our pages sent this IPC message, or null. Only the main frame of
 * one of our two windows, still showing its own page on our origin, counts.
 */
function senderPage(event, windows, origin) {
  for (const [page, win] of Object.entries(windows)) {
    if (!win || win.isDestroyed()) continue;
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) continue;
    return pageOf(event.senderFrame.url, origin) === page ? page : null;
  }
  return null;
}

function viewUrl(origin, view) {
  return VIEWS.has(view) ? `${origin}/#${view}` : `${origin}/`;
}

/** The menu-bar title; dimmed like the icon when Paused (ARCHITECTURE.md, MenuBar mockup). */
function trayTitle(status) {
  const title = " " + (status?.balance?.label || "—");
  return status?.headline?.label === "Paused" ? PAUSED_TITLE_ANSI + title : title;
}

/**
 * Where Router keeps its data. KOINOS_ROUTER_DATA wins; a smoke run without it
 * gets a fresh temp dir (removed when it exits), never the user's real data
 * dir: it runs against a mock keychain, and secrets written there would be
 * unreadable to every later real launch.
 */
function resolveDataRoot({ smoke = false, env = process.env, tmpdir = os.tmpdir() } = {}) {
  if (env.KOINOS_ROUTER_DATA) return { dataOverride: path.resolve(env.KOINOS_ROUTER_DATA), tempDir: null };
  if (!smoke) return { dataOverride: null, tempDir: null };
  const tempDir = fs.mkdtempSync(path.join(tmpdir, "koinos-router-smoke-"));
  return { dataOverride: tempDir, tempDir };
}

/** true when the promise settles (either way) within ms, false on timeout. */
function settleWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, false);
  });
  const settled = Promise.resolve(promise).then(
    () => true,
    () => true,
  );
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}

/** Hold the no-sleep blocker only while serving jobs on AC power (MVP_SPEC §6.1). */
function wantsBlocker(status, onBattery) {
  return status?.share?.state === "earning" && !onBattery;
}

/**
 * Status from the service's events and from one-off reads, applied in order:
 * a read that started before an event arrived never overwrites that event.
 */
function createStatusTracker(apply) {
  let seq = 0;
  let last = null;
  return {
    event(status) {
      seq++;
      last = status;
      apply(status);
    },
    async read(fetchStatus) {
      const at = seq;
      const status = await fetchStatus();
      if (at === seq) {
        last = status;
        apply(status);
      }
      return last;
    },
    get last() {
      return last;
    },
  };
}

/**
 * Login item at launch: the OS is the truth once the user has a stored
 * choice (System Settings › Login Items may have changed it), so the stored
 * value follows the OS. Only a first launch (nothing stored) registers.
 * → { setOs: boolean|null, store: boolean|null }
 */
function loginItemAtBoot({ stored, osOpen }) {
  const isOn = osOpen === true;
  if (typeof stored !== "boolean") return { setOs: isOn ? null : true, store: true };
  return { setOs: null, store: stored === isOn ? null : isOn };
}

/**
 * Is this app bundle running from somewhere it won't stay: the mounted DMG
 * (/Volumes/…) or a Gatekeeper App Translocation copy of a quarantined
 * download (…/AppTranslocation/…)? A login item registered from there points
 * at a path that disappears, and the copy in Applications would then read
 * "not registered" and switch Open at login off. So the login item is left
 * alone until Router runs from where it was installed.
 */
function transientAppLocation(execPath) {
  const p = String(execPath || "");
  return p.startsWith("/Volumes/") || p.includes("/AppTranslocation/");
}

/**
 * Device-owner authentication before the recovery key is shown: Touch ID,
 * or the macOS login password where there is no usable Touch ID.
 * promptTouchID evaluates kSecAccessControlUserPresence, which falls back to
 * the password on its own, so it is called even when canPromptTouchID() is
 * false. There is never an unauthenticated fallback.
 * → { ok: true } | { ok: false, error?: string }   (no error: the user cancelled)
 */
async function confirmOwner(systemPreferences, reason = OWNER_AUTH_REASON) {
  if (typeof systemPreferences?.promptTouchID !== "function") return { ok: false, error: OWNER_AUTH_UNAVAILABLE };
  try {
    await systemPreferences.promptTouchID(reason);
    return { ok: true };
  } catch (e) {
    const message = String(e?.message || e || "");
    if (/cancel/i.test(message)) return { ok: false };
    if (/passcode not set|password not set/i.test(message)) return { ok: false, error: OWNER_AUTH_NO_PASSWORD };
    return { ok: false, error: OWNER_AUTH_FAILED };
  }
}

/** Puts text on a concealed, transient, this-Mac-only pasteboard via osascript. */
function copyConcealed(text, { execFile, pasteboard = null, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const args = ["-l", "JavaScript", "-e", CONCEALED_COPY_JXA, ...(pasteboard ? [pasteboard] : [])];
      child = execFile(OSASCRIPT, args, { timeout: timeoutMs, killSignal: "SIGKILL" }, (err, stdout) => {
        // Never echo the error: nothing about the secret belongs in a log.
        if (err || String(stdout).trim() !== "ok") return reject(new Error("concealed copy failed"));
        resolve();
      });
    } catch {
      reject(new Error("concealed copy failed"));
      return;
    }
    child.stdin.on("error", () => {});
    child.stdin.end(String(text));
  });
}

/**
 * Re-run the idle decision as soon as what it depends on changes (Share
 * switched on or off, "Start now" or Settings changing When or Only when
 * plugged in) instead of at the next 5 s poll. Call kick() on every service
 * "status" and "settings" event: kicks within one turn coalesce, and tick()
 * runs only when those inputs differ from the last ones seen, so a status
 * event caused by the tick itself ends there.
 */
function createGateKick({ inputs, tick, defer = setImmediate }) {
  const keyOf = () => {
    try {
      const i = inputs() || {};
      return JSON.stringify([i.enabled === true, i.mode ?? null, i.pluggedInOnly === true]);
    } catch {
      return null;
    }
  };
  let last = keyOf();
  let pending = false;
  return function kick() {
    if (pending) return;
    pending = true;
    defer(() => {
      pending = false;
      const key = keyOf();
      if (key === null || key === last) return;
      last = key;
      tick();
    });
  };
}

/**
 * Whether a launch should bring up the main window. Opening Router by hand
 * always shows it: on a notched MacBook a crowded menu bar can hide the icon,
 * and a launch that shows nothing looks like it failed. Only a launch macOS
 * made at login stays quiet, unless onboarding isn't done yet (Router can do
 * nothing until it is). An unknown answer (no login-item info) shows it.
 */
function showMainAtLaunch({ smoke = false, onboarded = true, loginItem = null, platform = process.platform } = {}) {
  if (smoke) return false;
  if (!onboarded) return true;
  if (platform !== "darwin") return true;
  return loginItem?.wasOpenedAtLogin !== true;
}

/**
 * Does this Mac's built-in screen have a notch? Electron exposes no safe-area
 * insets, but the menu bar on a notched screen is as tall as the notch, so
 * the gap between the built-in display's bounds and its work area tells.
 * true | false, or null when it can't be told (no built-in screen in use,
 * e.g. a desktop Mac or a closed lid, or a menu bar set to hide itself).
 */
function notchState(displays) {
  const builtIn = (Array.isArray(displays) ? displays : []).find((d) => d && d.internal === true && d.bounds && d.workArea);
  if (!builtIn) return null;
  const menuBar = builtIn.workArea.y - builtIn.bounds.y;
  if (!Number.isFinite(menuBar) || menuBar <= 0) return null;
  return menuBar >= NOTCH_MENU_BAR_MIN;
}

/**
 * The menu-bar hint for the main window: "notch" (the icon may be behind the
 * notch), "menu-bar" (can't tell, so a general pointer), or null. Shown only
 * after onboarding, until the person dismisses it or clicks the menu-bar icon,
 * and never on a Mac known to have no notch.
 */
function menuBarHint({ onboarded, stored, notch }) {
  if (onboarded !== true || stored === HINT_DONE || notch === false) return null;
  return notch === true ? "notch" : "menu-bar";
}

/** External links a page may open: only Router's GitHub release pages. */
function externalUrlAllowed(url) {
  return isReleaseUrl(url);
}

/** Scale every channel of a BGRA bitmap, which dims a template image evenly. */
function dimBitmap(buffer, alpha) {
  const out = Buffer.from(buffer);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(out[i] * alpha);
  return out;
}

module.exports = {
  isSmoke,
  clampPopoverHeight,
  popoverBounds,
  pageOf,
  senderPage,
  viewUrl,
  trayTitle,
  dimBitmap,
  resolveDataRoot,
  settleWithin,
  wantsBlocker,
  createStatusTracker,
  createGateKick,
  loginItemAtBoot,
  transientAppLocation,
  showMainAtLaunch,
  notchState,
  menuBarHint,
  externalUrlAllowed,
  confirmOwner,
  copyConcealed,
  CONCEALED_TYPES,
  SIGNALS_WAIT_MS,
  PRELOAD,
  TRAY_ICON,
  VIEWS,
  SHELL_METHODS,
  HINTS,
  HINT_DONE,
  POPOVER_MIN_HEIGHT,
  POPOVER_MAX_HEIGHT,
};

// ---------------------------------------------------------------- Electron

if (process.versions.electron && process.type === "browser") runShell();

function runShell() {
  const electron = require("electron");
  const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, shell, clipboard, screen, session } = electron;
  const { execFile } = require("child_process");
  const secrets = require("./lib/secrets");
  const keychainAccess = require("./lib/keychain-access");
  const { createMacSignals } = require("./lib/mac-signals");
  const { IdleController } = require("./lib/idle-policy");
  const { createUpdateCheck } = require("./lib/update-check");

  // stdout/stderr can be a pipe whose reader is gone (Router started by a
  // script that has since exited). Writing then fails with EPIPE as an
  // 'error' event, and an unhandled one is an uncaught exception in the main
  // process: the first log line after onboarding crashed a packaged Router
  // exactly this way. Everything worth keeping also goes to core.log.
  for (const stream of [process.stdout, process.stderr]) stream?.on?.("error", () => {});

  const smoke = isSmoke();
  const { dataOverride, tempDir } = resolveDataRoot({ smoke });
  // The local demo (router/scripts/local-demo.js) points Connect at a sandbox
  // home so it never edits the real ~/.codex or ~/.claude.json.
  const harnessHome = process.env.KOINOS_ROUTER_HARNESS_HOME ? path.resolve(process.env.KOINOS_ROUTER_HARNESS_HOME) : undefined;

  app.setName(PRODUCT_NAME);
  // Our own userData (and so our own single-instance lock and data dir) even
  // when run from the repo, where package.json would name it "Koinos AI". An
  // overridden data dir gets its own Chromium profile beside it, so a test or
  // smoke run never collides with the Router the user is running.
  app.setPath("userData", dataOverride ? path.join(dataOverride, "electron") : path.join(app.getPath("appData"), PRODUCT_NAME));
  // A smoke run must never stop at a Keychain access prompt, so Chromium
  // gets its mock keychain. Router's own secrets don't use it at all (see
  // boot): mock-keychain ciphertext is unreadable to a real launch.
  if (smoke) app.commandLine.appendSwitch("use-mock-keychain");

  let rc = null;
  let origin = null;
  let walletPassword = null;
  let mainWin = null;
  let popover = null;
  let tray = null;
  let trayImages = null;
  let idle = null;
  let kickGate = null; // set once the idle controller runs
  let blockerId = null;
  let booted = false;
  let loginItemApplied = null; // what Router last asked the OS for; null until boot syncs it
  let updates = null; // the update notice; packaged, non-smoke runs only
  let smokeTimer = null;
  let popoverHiddenAt = 0;
  let quitting = false;
  let shutdownDone = false;
  let shutdownPromise = null;

  const log = (...args) => console.log("[router]", ...args);
  const statusTracker = createStatusTracker(onStatus);

  // Chromium still writes its profile while the process exits, so a sweep
  // that waits for this process to be gone finishes the job.
  function removeTempDir() {
    if (!tempDir) return;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      const sweep = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; rm -rf "$2"';
      require("child_process")
        .spawn("/bin/sh", ["-c", sweep, "sh", String(process.pid), tempDir], { detached: true, stdio: "ignore" })
        .unref();
    } catch {
      /* best effort: it lives in the temp dir anyway */
    }
  }

  function fail(err) {
    const message = (err && (err.stack || err.message)) || String(err);
    if (smoke) {
      clearTimeout(smokeTimer);
      console.error(`SMOKE FAIL ${message}`);
      try {
        rc?.core.runtime.stop();
      } catch {
        /* not started */
      }
      removeTempDir();
      app.exit(1);
      return;
    }
    console.error("[router] boot failed:", message);
    if (app.isReady()) dialog.showErrorBox("Koinos Router couldn’t start", String(err?.message || err));
    app.exit(1);
  }

  if (smoke) {
    smokeTimer = setTimeout(() => fail(new Error(`no status after ${SMOKE_TIMEOUT_MS / 1000}s`)), SMOKE_TIMEOUT_MS);
  }

  if (!app.requestSingleInstanceLock()) {
    if (smoke) fail(new Error("another Koinos Router is using this data dir"));
    else app.quit();
    return;
  }

  // Opening Router again: `open -n` or the binary starts a second process
  // (second-instance); Finder, Spotlight and Launchpad only send the running
  // app a reopen event (activate).
  const reopen = () => {
    if (booted && !smoke) showMain();
  };
  app.on("second-instance", reopen);
  app.on("activate", reopen);
  // The app lives in the menu bar; its windows only ever hide, so they all
  // close only during a quit. A SIGTERM quit (logout, `kill`) relies on this
  // event to finish, after before-quit has run our shutdown.
  app.on("window-all-closed", () => {
    if (quitting) app.quit();
  });
  app.on("before-quit", (event) => {
    quitting = true;
    if (shutdownDone || !rc) return;
    // Let RouterService record an open share session and Core stop its
    // model server before the process goes.
    event.preventDefault();
    shutdownPromise ||= shutdown().finally(() => {
      shutdownDone = true;
      app.quit();
    });
  });

  app.whenReady().then(boot).catch(fail);

  async function boot() {
    app.dock?.hide();

    const dataDir = dataOverride || path.join(app.getPath("userData"), "core");
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // Smoke: 0600 files in its throwaway dir instead of the mock keychain,
    // whose fixed key would make them unreadable to any real launch.
    const secretOpts = smoke ? { safeStorage: null, log: () => {} } : {};
    // The first decrypt may stop at a macOS Keychain dialog; say so first.
    // This runs before anything touches the default session, whose
    // (encrypted) cookie store would also need the Keychain key.
    const keychain = smoke ? null : await explainKeychainPrompt(dataDir);
    const sessionSecret = readSecret(() => secrets.machineSecret(dataDir, secretOpts));
    walletPassword = readSecret(() => secrets.walletPassword(dataDir, secretOpts));
    if (keychain && (await afterKeychain(keychain, sessionSecret, walletPassword)) === "relaunch") return;

    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]),
    );
    // The pages need no camera, notifications or anything else.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    // Probe the Mac while Core boots.
    const signals = createMacSignals({ powerMonitor: electron.powerMonitor, execFile });

    const { createRouterCore } = require("./lib/router-core");
    rc = await createRouterCore({
      dataDir,
      sessionSecret,
      walletPassword,
      laptop: () => signals.isLaptop(),
      // Core's default sink echoes every event to stdout. A packaged app has
      // no one reading it, and core.log already records each event.
      onEvent: app.isPackaged && !smoke ? () => {} : undefined,
      home: harnessHome,
      // `home` also anchors the ~/Library guard, so a sandboxed harness home
      // must not move that protection off the real one.
      // Electron's own profile sits outside dataDir when KOINOS_ROUTER_DATA is set.
      protectedDirs: [app.getPath("userData"), ...(harnessHome ? [path.join(os.homedir(), "Library")] : [])],
    });
    // Listen before start(): Share resumes inside it, and the service only
    // emits a status when it changes, so a missed event is never repeated.
    rc.service.on("status", (st) => {
      statusTracker.event(st);
      kickGate?.();
    });
    rc.service.on("settings", (settings) => {
      onSettings(settings);
      kickGate?.();
    });
    rc.service.setAppInfo(appInfo);

    // The share-model budget (picked once and remembered) and the idle and
    // plugged-in defaults depend on laptop or not: no Share start, and no
    // HTTP API for onboarding, before the probe has answered.
    if (!(await settleWithin(signals.ready, SIGNALS_WAIT_MS)) || !signals.isLaptopKnown()) {
      log("laptop probe did not answer; treating this Mac as a desktop");
    }

    // Gate first, then start: Share resumes inside start() and must not run a
    // single job on a Mac that is in use.
    idle = new IdleController({
      inputs: () => rc.service.idleInputs(),
      readSignals: () => signals.read(),
      apply: (decision) => rc.service.setShareGate(decision),
      intervalMs: 5000,
      onEvent: rc.core.events,
    });
    idle.start();
    // "Start now" and the Share switch take effect within a second, not at
    // the next poll.
    kickGate = createGateKick({ inputs: () => rc.service.idleInputs(), tick: () => idle?.tick() });
    const port = await rc.start();
    origin = `http://127.0.0.1:${port}`;

    registerIpc();
    const first = await statusTracker.read(() => rc.service.status());
    mainWin = createMainWindow();
    popover = createPopover();
    await Promise.all([
      mainWin.loadURL(first.onboarded ? viewUrl(origin) : viewUrl(origin, "welcome")),
      popover.loadURL(`${origin}/popover.html`),
    ]);
    if (!smoke) await syncLoginItemAtBoot();

    const nudge = () => Promise.resolve(rc?.core.earn.nudge?.()).catch(() => {});
    electron.powerMonitor.on("resume", nudge);
    electron.powerMonitor.on("unlock-screen", nudge);
    // The blocker depends on the power source too.
    const resync = () => syncBlocker(statusTracker.last);
    electron.powerMonitor.on("on-ac", resync);
    electron.powerMonitor.on("on-battery", resync);

    if (smoke) return smokeCheck(port);
    createTray(statusTracker.last);
    booted = true;
    if (showMainAtLaunch({ onboarded: first.onboarded, loginItem: loginItemSettings() })) showMain();
    startUpdateCheck();
  }

  function loginItemSettings() {
    try {
      return app.getLoginItemSettings();
    } catch (e) {
      log("login item settings unavailable:", e.message);
      return null;
    }
  }

  // ------------------------------------------------- app info and hints

  // Status.app: this build's version, a newer release if there is one, and
  // which one-time hint the main window should show.
  function appInfo() {
    const settings = rc?.core.settings;
    let notch = null;
    try {
      notch = notchState(screen.getAllDisplays());
    } catch {
      /* no screen info: treat as unknown */
    }
    return {
      version: app.isPackaged ? app.getVersion() : null,
      update: updates ? updates.current() : null,
      hints: {
        menuBar: menuBarHint({
          onboarded: settings?.get("router.onboarded", false) === true,
          stored: settings?.get(HINTS.menuBar, null),
          notch,
        }),
      },
    };
  }

  function dismissHint(name) {
    const key = Object.hasOwn(HINTS, name) ? HINTS[name] : null;
    if (!key || !rc || rc.core.settings.get(key, null) === HINT_DONE) return;
    rc.core.settings.set(key, HINT_DONE);
    rc.service.appInfoChanged();
  }

  // Asks GitHub for a newer Router once 30 s after boot, then at most daily.
  // Never downloads anything; the UI links to the release page. A build run
  // from the checkout has no Router version to compare, so it doesn't ask.
  function startUpdateCheck() {
    if (smoke || !app.isPackaged || process.env.KOINOS_ROUTER_NO_UPDATE_CHECK === "1") return;
    updates = createUpdateCheck({
      currentVersion: app.getVersion(),
      onChange: () => rc?.service.appInfoChanged(),
      onEvent: (e) => rc?.core.events?.(e),
    });
    updates.start();
  }

  // ------------------------------------------------------- keychain

  // Before the first decrypt of a packaged launch: if macOS is about to ask
  // for "Koinos Router Safe Storage" (this build isn't the one it trusted
  // last; see lib/keychain-access.js), explain that in Router's own words,
  // then bring Router forward so the system dialog that follows is on top.
  // codesign is bounded by a 3 s timeout and never blocks boot on its own.
  async function explainKeychainPrompt(dataDir) {
    if (!app.isPackaged || process.platform !== "darwin") return null;
    const bundlePath = keychainAccess.bundlePathFromExecPath(process.execPath);
    const current = await keychainAccess.readSigningIdentity({ bundlePath, execFile });
    const recorded = keychainAccess.readRecord(dataDir);
    const hasSecrets = secrets.hasEncryptedSecrets(dataDir);
    if (!current) log("couldn't read this build's code signature");
    if (keychainAccess.shouldExplainKeychain({ packaged: true, smoke, hasSecrets, current, recorded })) {
      log("explaining the Keychain prompt before it appears");
      const { EXPLAIN } = keychainAccess;
      app.focus({ steal: true });
      await dialog.showMessageBox({
        type: "info",
        title: EXPLAIN.title,
        message: EXPLAIN.message,
        detail: EXPLAIN.detail,
        buttons: [EXPLAIN.button],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      app.focus({ steal: true });
    }
    return { dataDir, current, recorded, hadSecrets: hasSecrets };
  }

  // After the decrypts: remember the build macOS just trusted, so the next
  // launch of it doesn't explain again. If the key stayed shut (Deny), the
  // wallet stays locked, as before; say so, and offer to ask again.
  async function afterKeychain({ dataDir, current, recorded, hadSecrets }, ...values) {
    const unlocked = values.every((v) => typeof v === "string" && v.length > 0);
    if (unlocked) {
      if (current && secrets.hasEncryptedSecrets(dataDir) && !keychainAccess.sameIdentity(current, recorded)) {
        keychainAccess.writeRecord(dataDir, current);
      }
      return "ok";
    }
    if (!hadSecrets) return "locked";
    log("the Keychain didn't open Router's saved key; the wallet stays locked");
    const { DENIED } = keychainAccess;
    app.focus({ steal: true });
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: DENIED.title,
      message: DENIED.message,
      detail: DENIED.detail,
      buttons: DENIED.buttons,
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return "locked";
    // Nothing has started yet, so a plain exit loses nothing.
    app.relaunch();
    app.exit(0);
    return "relaunch";
  }

  function readSecret(read) {
    try {
      return read();
    } catch (e) {
      // Without it the wallet just stays locked; Router says so when asked.
      console.error("[router] secret unavailable:", e.message);
      return null;
    }
  }

  async function shutdown() {
    kickGate = null;
    updates?.stop();
    idle?.stop();
    releaseBlocker();
    try {
      await Promise.race([rc.stop(), delay(SHUTDOWN_WAIT_MS)]);
    } catch (e) {
      console.error("[router] stop failed:", e.message);
    }
    try {
      rc.core.runtime.stop();
    } catch {
      /* already down */
    }
  }

  // ----------------------------------------------------------- windows

  const webPreferences = () => ({
    preload: PRELOAD,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webviewTag: false,
    spellcheck: false,
  });

  function createMainWindow() {
    const win = new BrowserWindow({
      width: MAIN_WIDTH,
      height: MAIN_HEIGHT,
      useContentSize: true,
      show: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      // Hidden until shown: report document.hidden, so the page's status
      // poll stays off until someone opens the window.
      paintWhenInitiallyHidden: false,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 20, y: 18 },
      backgroundColor: "#fcfdff",
      title: "Router",
      webPreferences: webPreferences(),
    });
    guardContents(win.webContents, "main");
    win.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      win.hide();
    });
    return win;
  }

  function createPopover() {
    const win = new BrowserWindow({
      width: POPOVER_WIDTH,
      height: POPOVER_DEFAULT_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      paintWhenInitiallyHidden: false,
      webPreferences: webPreferences(),
    });
    win.setAlwaysOnTop(true, "pop-up-menu");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    guardContents(win.webContents, "popover");
    win.on("blur", () => hidePopover());
    win.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      hidePopover();
    });
    return win;
  }

  // Pages may only show themselves. Our other page opens in its own window;
  // Router's GitHub release pages (the update notice's Download link) open in
  // the browser; everything else is dropped.
  function guardContents(contents, page) {
    const guard = (event, url) => {
      const target = pageOf(url, origin);
      if (target === page) return;
      event.preventDefault();
      if (target === "main") return showMain(new URL(url).hash.slice(1));
      openExternal(url);
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (pageOf(url, origin) === "main") showMain(new URL(url).hash.slice(1));
      else openExternal(url);
      return { action: "deny" };
    });
  }

  function openExternal(url) {
    if (!externalUrlAllowed(url)) return;
    shell.openExternal(new URL(url).href).catch(() => {});
  }

  function showMain(view) {
    if (!mainWin || mainWin.isDestroyed()) return;
    hidePopover();
    if (VIEWS.has(view)) mainWin.loadURL(viewUrl(origin, view)).catch(() => {});
    unhideApp();
    // An accessory (LSUIElement) app has to take focus explicitly, or the
    // window opens behind whatever the user was in.
    app.focus({ steal: true });
    mainWin.show();
    mainWin.focus();
  }

  // yieldFocus: the user dismissed the popover (Esc, the tray icon) rather
  // than clicking into another app, so hand activation back to that app.
  function hidePopover({ yieldFocus = false } = {}) {
    if (!popover || popover.isDestroyed() || !popover.isVisible()) return;
    popover.hide();
    popoverHiddenAt = Date.now();
    if (yieldFocus) yieldFocusIfIdle();
  }

  // Showing the popover activated Router; with no window left up, hiding the
  // app is what makes macOS reactivate the app the user was in.
  function yieldFocusIfIdle() {
    if (process.platform !== "darwin") return;
    if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible()) return;
    app.hide();
  }

  function unhideApp() {
    if (process.platform === "darwin") app.show();
  }

  function togglePopover() {
    if (!popover || popover.isDestroyed()) return;
    if (popover.isVisible()) return hidePopover({ yieldFocus: true });
    // The tray click that closed it: the popover blurred (and hid) first.
    if (Date.now() - popoverHiddenAt < REOPEN_GUARD_MS) return yieldFocusIfIdle();
    placePopover(popover.getBounds().height);
    unhideApp();
    popover.show();
    popover.focus();
    // They found the menu-bar icon: the "can't see it?" hint has done its job.
    dismissHint("menuBar");
  }

  function placePopover(height) {
    const trayBounds = tray ? tray.getBounds() : null;
    const display = trayBounds ? screen.getDisplayMatching(trayBounds) : screen.getPrimaryDisplay();
    popover.setBounds(popoverBounds(trayBounds, display.workArea, height));
  }

  function setPopoverHeight(px) {
    const height = clampPopoverHeight(px);
    if (height === null || !popover || popover.isDestroyed()) return;
    if (popover.isVisible()) placePopover(height);
    else popover.setBounds({ ...popover.getBounds(), height });
  }

  // -------------------------------------------------------------- tray

  function createTray(status) {
    const icon = nativeImage.createFromPath(TRAY_ICON);
    if (icon.isEmpty()) throw new Error(`tray icon missing at ${TRAY_ICON}`);
    icon.setTemplateImage(true);
    trayImages = { normal: icon, paused: dimmedImage(icon) };
    tray = new Tray(icon);
    tray.setToolTip(PRODUCT_NAME);
    tray.on("click", togglePopover);
    tray.on("right-click", () => {
      hidePopover();
      tray.popUpContextMenu(
        Menu.buildFromTemplate([
          { label: "Open Router", click: () => showMain() },
          { type: "separator" },
          { label: "Quit Koinos Router", click: () => app.quit() },
        ]),
      );
    });
    updateTray(status);
  }

  // The same mark at 42% opacity, for Paused (MVP_SPEC §6.6).
  function dimmedImage(icon) {
    try {
      const out = nativeImage.createEmpty();
      for (const scaleFactor of icon.getScaleFactors()) {
        const size = icon.getSize(scaleFactor);
        const pixels = dimBitmap(icon.toBitmap({ scaleFactor }), PAUSED_ICON_ALPHA);
        const rep = nativeImage.createFromBitmap(pixels, {
          width: Math.round(size.width * scaleFactor),
          height: Math.round(size.height * scaleFactor),
          scaleFactor,
        });
        out.addRepresentation({ scaleFactor, buffer: rep.toPNG({ scaleFactor }) });
      }
      if (out.isEmpty()) return icon;
      out.setTemplateImage(true);
      return out;
    } catch (e) {
      log("dimmed tray icon unavailable:", e.message);
      return icon;
    }
  }

  function updateTray(status) {
    if (!tray || tray.isDestroyed()) return;
    tray.setTitle(trayTitle(status), { fontType: "monospacedDigit" });
    tray.setImage(status?.headline?.label === "Paused" ? trayImages.paused : trayImages.normal);
  }

  function onStatus(status) {
    updateTray(status);
    syncBlocker(status);
  }

  // ------------------------------------------------- power and login item

  // Keep the Mac from napping only while it is actually serving jobs on AC
  // power: on battery an idle laptop should still sleep on schedule.
  function syncBlocker(st) {
    const { powerSaveBlocker } = electron;
    if (wantsBlocker(st, electron.powerMonitor.isOnBatteryPower())) {
      if (blockerId === null) blockerId = powerSaveBlocker.start("prevent-app-suspension");
    } else {
      releaseBlocker();
    }
  }

  function releaseBlocker() {
    if (blockerId === null) return;
    try {
      electron.powerSaveBlocker.stop(blockerId);
    } catch {
      /* already released */
    }
    blockerId = null;
  }

  // Only a packaged app registers as a login item: from a checkout it would
  // register the bare Electron binary. At launch the OS state wins (the user
  // may have removed Router in System Settings); after that, the OS changes
  // only when the user changes "Open at login" in Router.
  async function syncLoginItemAtBoot() {
    if (!app.isPackaged || smoke) return;
    if (transientAppLocation(process.execPath)) {
      log("running from the disk image or a translocated copy; login item left alone until Router runs from Applications");
      return;
    }
    try {
      const osOpen = app.getLoginItemSettings().openAtLogin === true;
      const stored = rc.core.settings.get("router.general.openAtLogin", null);
      const { setOs, store } = loginItemAtBoot({ stored, osOpen });
      loginItemApplied = setOs ?? osOpen;
      if (setOs !== null) app.setLoginItemSettings({ openAtLogin: setOs });
      if (store !== null) await rc.service.updateSettings({ general: { openAtLogin: store } });
    } catch (e) {
      log("login item not synced:", e.message);
    }
  }

  function onSettings(settings) {
    if (loginItemApplied === null || !app.isPackaged || smoke) return;
    const openAtLogin = settings?.general?.openAtLogin !== false;
    if (openAtLogin === loginItemApplied) return;
    try {
      app.setLoginItemSettings({ openAtLogin });
      loginItemApplied = openAtLogin;
    } catch (e) {
      log("login item not updated:", e.message);
    }
  }

  // -------------------------------------------------------------- IPC

  function handle(channel, pages, fn) {
    ipcMain.handle(channel, async (event, ...args) => {
      const page = senderPage(event, { main: mainWin, popover }, origin);
      if (!page || !pages.includes(page)) throw new Error("Router window access denied");
      return fn(...args);
    });
  }

  function registerIpc() {
    handle("router:open", ["main", "popover"], (view) => {
      showMain(typeof view === "string" ? view : undefined);
    });
    handle("router:close-popover", ["popover"], () => {
      hidePopover({ yieldFocus: true });
    });
    handle("router:quit", ["main", "popover"], () => {
      app.quit();
    });
    handle("router:popover-height", ["popover"], (px) => {
      setPopoverHeight(px);
    });
    handle("router:dismiss-hint", ["main"], (name) => {
      dismissHint(typeof name === "string" ? name : "");
    });
    handle("router:backup-wallet", ["main"], () => backupWallet());
    handle("router:restore-wallet", ["main"], (wif) => restoreWallet(wif));
  }

  // ------------------------------------------------------------ wallet

  // The recovery key goes straight from the wallet to a native dialog. It is
  // never returned over IPC or HTTP, so no page can read it.
  async function backupWallet() {
    if (!rc.core.wallet.status().exists) {
      return { ok: false, error: "Router hasn’t made your wallet yet. Turn on Share compute or Use KoinosAI first." };
    }
    const owner = await confirmOwner(electron.systemPreferences);
    if (!owner.ok) return owner.error ? { ok: false, error: owner.error } : { ok: false };
    let backup;
    try {
      backup = await rc.service.revealBackup({ password: walletPassword });
    } catch (e) {
      log("backup failed:", e.message);
      return { ok: false, error: userMessage(e, "Router couldn’t open your wallet. Restart Router and try again.") };
    }
    const { response } = await dialog.showMessageBox(mainWin, {
      type: "warning",
      title: "Recovery key",
      message: "Your recovery key",
      detail:
        `${backup.wif}\n\n` +
        "Anyone with this key can spend your KAI. Keep it somewhere private, like a password manager. " +
        "Use it to set up Koinos Router on another Mac.",
      buttons: ["Copy", "Done"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) {
      try {
        await copySecret(backup.wif);
      } catch {
        log("recovery key copy failed");
        return { ok: false, error: COPY_FAILED };
      }
    }
    return { ok: true };
  }

  async function copySecret(text) {
    await copyConcealed(text, { execFile });
    const timer = setTimeout(() => {
      if (clipboard.readText() === text) clipboard.clear();
    }, CLIPBOARD_CLEAR_MS);
    timer.unref?.();
  }

  async function restoreWallet(wif) {
    const key = typeof wif === "string" ? wif.trim() : "";
    if (!key || key.length > MAX_WIF_CHARS) return { ok: false, error: RESTORE_FAILED };
    if (rc.core.wallet.status().exists) {
      const { response } = await dialog.showMessageBox(mainWin, {
        type: "warning",
        title: "Use recovery key",
        message: "Switch this Mac to that wallet?",
        detail: "This Mac already has a Router wallet. Its key is kept in a backup file in Router’s data folder.",
        buttons: ["Switch Wallet", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (response !== 0) return { ok: false, error: "Nothing changed. This Mac kept its wallet." };
    }
    try {
      await rc.service.restoreWallet({ wif: key, password: walletPassword });
      return { ok: true };
    } catch (e) {
      // The message may quote the input; log only its kind.
      log("restore failed:", e?.name || "Error");
      return { ok: false, error: userMessage(e, RESTORE_FAILED) };
    }
  }

  // RouterService errors carry user-facing copy; anything else is internal.
  function userMessage(e, fallback) {
    return e && e.name === "ServiceError" && typeof e.message === "string" ? e.message : fallback;
  }

  // ------------------------------------------------------------- smoke

  async function smokeCheck(port) {
    const headers = process.env.KAI_CORE_TOKEN ? { authorization: `Bearer ${process.env.KAI_CORE_TOKEN}` } : {};
    const res = await fetch(`${origin}/core/router/status`, { headers });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.ok !== true || typeof body.onboarded !== "boolean" || !body.balance) {
      throw new Error(`GET /core/router/status answered ${res.status}`);
    }
    const expected = SHELL_METHODS.join(",");
    for (const [name, win] of [["main", mainWin], ["popover", popover]]) {
      const methods = await win.webContents.executeJavaScript(
        "Object.keys(window.routerShell || {}).sort().join(',')",
      );
      if (methods !== expected) throw new Error(`${name} window bridge is [${methods}], expected [${expected}]`);
    }
    clearTimeout(smokeTimer);
    console.log(`SMOKE OK ${port}`);
    quitting = true;
    await shutdown();
    shutdownDone = true;
    removeTempDir();
    app.exit(0);
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
