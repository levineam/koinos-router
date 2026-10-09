"use strict";

/*
 * The Electron shell (router/main.js) only runs inside Electron, so most of
 * this is static proof of what breaks silently in a packaged build while a
 * checkout works: a file the shell loads that never ships, a bridge method
 * the UI calls that preload never exposes, an IPC channel nobody handles, a
 * heavy dependency excluded from the package that the router profile does
 * load after all. The pure helpers and secrets.js run for real.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const yaml = require("js-yaml");

const ROOT = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");

const shellMain = require("../main.js");
const secrets = require("../lib/secrets");

const builder = yaml.load(read("router", "electron-builder.yml"));

// ------------------------------------------------- electron-builder globs

function expandBraces(pattern) {
  const m = /\{([^{}]*)\}/.exec(pattern);
  if (!m) return [pattern];
  return m[1].split(",").flatMap((alt) => expandBraces(pattern.slice(0, m.index) + alt + pattern.slice(m.index + m[0].length)));
}

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const rules = builder.files.map((p) => {
  const negated = p.startsWith("!");
  const body = negated ? p.slice(1) : p;
  return { negated, res: expandBraces(body).map(globToRegExp) };
});

/** electron-builder semantics: the last pattern that matches decides. */
function shipped(file) {
  // Production node_modules are added automatically; only exclusions apply.
  let included = file.startsWith("node_modules/");
  for (const r of rules) if (r.res.some((re) => re.test(file))) included = !r.negated;
  return included;
}

function packageName(file) {
  const parts = file.split("node_modules/").pop().split("/");
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

test("the glob helper agrees with electron-builder on the patterns used", () => {
  assert.equal(shipped("router/main.js"), true);
  assert.equal(shipped("router/test/shell.test.js"), false);
  assert.equal(shipped("router/ui/dev-mock.js"), false);
  assert.equal(shipped("core/lib/gateway.js"), true);
  assert.equal(shipped("core/test/gateway.test.js"), false);
  assert.equal(shipped("node_modules/onnxruntime-node/package.json"), false);
  assert.equal(shipped("node_modules/sherpa-onnx-darwin-arm64/x.node"), false);
  assert.equal(shipped("node_modules/koilib/lib/index.js"), true);
  assert.equal(shipped("electron/main.js"), false, "the full app's shell stays out");
  assert.equal(shipped("ui/index.html"), false, "the full app's UI stays out");
});

// ------------------------------------------------- files the shell loads

test("every file main.js loads exists and ships", () => {
  const main = read("router", "main.js");
  const loaded = [shellMain.PRELOAD, shellMain.TRAY_ICON, shellMain.TRAY_ICON.replace(/\.png$/, "@2x.png")];
  for (const m of main.matchAll(/require\("(\.[^"]+)"\)/g)) {
    loaded.push(require.resolve(path.join(ROOT, "router", m[1])));
  }
  assert.ok(loaded.length >= 7, "main.js should require its lib modules");
  for (const abs of loaded) {
    assert.ok(fs.existsSync(abs), `${rel(abs)} is loaded by main.js but missing`);
    assert.ok(shipped(rel(abs)), `${rel(abs)} is loaded by main.js but not packaged`);
  }
});

test("every page file ships, and the dev mock does not", () => {
  const ui = path.join(ROOT, "router", "ui");
  const files = fs.readdirSync(ui, { recursive: true }).map((f) => path.join(ui, f)).filter((f) => fs.statSync(f).isFile());
  assert.ok(files.some((f) => f.endsWith("popover.html")));
  for (const f of files) {
    const r = rel(f);
    assert.equal(shipped(r), r !== "router/ui/dev-mock.js", `${r} packaging`);
  }
  assert.ok(shipped("router/lib/skill/SKILL.md"), "connectors install the skill from the package");
});

test("the router profile loads nothing the package leaves out", () => {
  const script = `
    const fs = require("fs"), os = require("os"), path = require("path");
    (async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koinos-router-shell-"));
      const rc = await require("./router/lib/router-core").createRouterCore({
        dataDir: path.join(dir, "data"), port: 0, home: path.join(dir, "home"),
        llamaBin: path.join(${JSON.stringify(ROOT)}, "core", "test", "fixtures", "fake-llama-server"),
        walletPassword: "correct horse battery staple", connectorsWhich: async () => null,
        connectorsExec: async () => { throw new Error("no CLI"); }, otherAppEarning: async () => false,
        onEvent: () => {},
      });
      await rc.start();
      await rc.service.status();
      await rc.service.getSettings();
      await rc.service.activity();
      // The wallet paths load their crypto lazily; walk them too.
      await rc.service.ensureWallet();
      const { wif } = await rc.service.revealBackup({});
      await rc.service.restoreWallet({ wif });
      await rc.stop();
      fs.rmSync(dir, { recursive: true, force: true });
      process.stdout.write(JSON.stringify(Object.keys(require.cache)));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  const modules = JSON.parse(
    execFileSync(process.execPath, ["-e", script], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, KAI_SCHEDULER_URL: "http://127.0.0.1:9" },
    }),
  );
  const files = modules.filter((m) => path.isAbsolute(m)).map(rel);
  assert.ok(files.includes("router/lib/router-core.js"), "sanity: the child booted Router");
  const missing = files.filter((f) => !shipped(f));
  assert.deepEqual(missing, [], "loaded at runtime but excluded from the package");
  // And the exclusions are not dead weight: each names a real package.
  const loadedPackages = new Set(files.filter((f) => f.includes("node_modules/")).map(packageName));
  for (const p of ["koilib", "@noble/secp256k1"]) assert.ok(loadedPackages.has(p), `sanity: ${p} is loaded`);
});

// ---------------------------------------------------------- IPC bridge

function channels(source, re) {
  return [...source.matchAll(re)].map((m) => m[1]).sort();
}

test("preload exposes exactly the IPC channels main.js handles", () => {
  const main = read("router", "main.js");
  const preload = read("router", "preload.js");
  const handled = channels(main, /handle\(\s*"(router:[a-z-]+)"/g);
  const invoked = channels(preload, /ipcRenderer\.invoke\(\s*"(router:[a-z-]+)"/g);
  assert.deepEqual(invoked, handled);
  assert.deepEqual(handled, [
    "router:backup-wallet",
    "router:close-popover",
    "router:dismiss-hint",
    "router:open",
    "router:popover-height",
    "router:quit",
    "router:restore-wallet",
  ]);
  assert.doesNotMatch(main, /ipcMain\.on\(/, "every channel is a checked handle()");
  assert.doesNotMatch(preload, /ipcRenderer\.(send|on)\(/);
});

test("preload exposes every routerShell method the pages call, and only those", () => {
  const preload = read("router", "preload.js");
  const block = /exposeInMainWorld\("routerShell",\s*\{([\s\S]*?)\n\}\);/.exec(preload);
  assert.ok(block, "routerShell is exposed");
  const exposed = channels(block[1], /^\s*([A-Za-z]+):/gm);
  assert.deepEqual(exposed, shellMain.SHELL_METHODS);
  assert.equal((preload.match(/exposeInMainWorld\(/g) || []).length, 1);

  const called = new Set();
  for (const f of ["app.js", "popover.js", "common.js"]) {
    for (const m of read("router", "ui", f).matchAll(/\b(?:shell|hasShell)\(\s*"([A-Za-z]+)"/g)) called.add(m[1]);
  }
  assert.ok(called.size >= 5, "sanity: the pages call the shell");
  for (const name of called) assert.ok(exposed.includes(name), `the UI calls routerShell.${name}()`);
});

test("windows are sandboxed and IPC checks the sender", () => {
  const main = read("router", "main.js");
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.doesNotMatch(main, /nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false|webSecurity:\s*false/);
  assert.match(main, /senderPage\(event,/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /"will-navigate"/);
  // The recovery key leaves the wallet only into a native dialog or the clipboard.
  assert.doesNotMatch(main, /return\s*\{[^}]*\bwif\b/);
});

// ---------------------------------------------------------- packaging

test("electron-builder config names Router and hides the dock icon", () => {
  assert.equal(builder.appId, "io.koinosai.router");
  assert.equal(builder.productName, "Koinos Router");
  assert.equal(builder.directories.output, "dist-router");
  assert.deepEqual(builder.extraMetadata, { main: "router/main.js", name: "koinos-router", productName: "Koinos Router" });
  assert.equal(builder.mac.extendInfo.LSUIElement, true);
  assert.equal(builder.mac.hardenedRuntime, true);
  assert.equal(builder.mac.minimumSystemVersion, "12.0");
  assert.equal(builder.publish, null);
  for (const f of [builder.mac.icon, builder.mac.entitlements, builder.mac.entitlementsInherit, builder.extraMetadata.main]) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
  }
  const targets = builder.mac.target.map((t) => `${t.target}:${t.arch}`).sort();
  assert.deepEqual(targets, ["dmg:arm64", "zip:arm64"]);
});

test("package.json has the Router scripts", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts.router, "electron router/main.js");
  assert.equal(pkg.scripts["router:smoke"], "electron router/main.js --smoke");
  assert.equal(pkg.scripts["dist:router"], "node router/scripts/dist-router.js");
  assert.equal(pkg.scripts["router:demo"], "node router/scripts/local-demo.js");
  assert.equal(pkg.scripts["router:setup-signing"], "bash router/scripts/setup-dev-signing.sh");
  for (const script of ["dist:router", "router:demo", "router:setup-signing"]) {
    const file = pkg.scripts[script].split(" ").pop();
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${script}: ${file} exists`);
  }
  assert.equal(pkg.main, "electron/main.js", "the full app keeps its entry point");
});

// ---------------------------------------------------------- pure helpers

test("isSmoke reads the flag or the environment", () => {
  assert.equal(shellMain.isSmoke(["electron", "main.js", "--smoke"], {}), true);
  assert.equal(shellMain.isSmoke(["electron", "main.js"], { KOINOS_ROUTER_SMOKE: "1" }), true);
  assert.equal(shellMain.isSmoke(["electron", "main.js"], { KOINOS_ROUTER_SMOKE: "0" }), false);
});

test("popover height is clamped to 120-520", () => {
  assert.equal(shellMain.clampPopoverHeight(10), 120);
  assert.equal(shellMain.clampPopoverHeight(300.4), 300);
  assert.equal(shellMain.clampPopoverHeight(9999), 520);
  assert.equal(shellMain.clampPopoverHeight("abc"), null);
  assert.equal(shellMain.clampPopoverHeight(Infinity), null);
});

test("the popover sits centred under the tray icon, inside the work area", () => {
  const work = { x: 0, y: 25, width: 1440, height: 875 };
  assert.deepEqual(shellMain.popoverBounds({ x: 1000, y: 0, width: 40, height: 24 }, work, 300), { x: 870, y: 28, width: 300, height: 300 });
  // An icon at the right edge would push the popover off screen.
  assert.equal(shellMain.popoverBounds({ x: 1420, y: 0, width: 30, height: 24 }, work, 300).x, 1140);
  // No tray (or zero bounds): top-right of the work area.
  const fallback = shellMain.popoverBounds({ x: 0, y: 0, width: 0, height: 0 }, work, 200);
  assert.deepEqual(fallback, { x: 1132, y: 29, width: 300, height: 200 });
  // A second display to the left has negative x.
  const left = { x: -1920, y: 25, width: 1920, height: 1055 };
  assert.equal(shellMain.popoverBounds({ x: -1925, y: 0, width: 30, height: 24 }, left, 300).x, -1920);
});

test("pageOf only recognises our two pages on our origin", () => {
  const origin = "http://127.0.0.1:41110";
  assert.equal(shellMain.pageOf(`${origin}/`, origin), "main");
  assert.equal(shellMain.pageOf(`${origin}/index.html#settings`, origin), "main");
  assert.equal(shellMain.pageOf(`${origin}/popover.html`, origin), "popover");
  assert.equal(shellMain.pageOf(`${origin}/app.js`, origin), null);
  assert.equal(shellMain.pageOf("http://127.0.0.1:41111/", origin), null);
  assert.equal(shellMain.pageOf("http://localhost:41110/", origin), null);
  assert.equal(shellMain.pageOf("not a url", origin), null);
});

test("senderPage requires the main frame of our window on its own page", () => {
  const origin = "http://127.0.0.1:41110";
  const makeWin = (url) => {
    const mainFrame = { url };
    return { isDestroyed: () => false, webContents: { mainFrame } };
  };
  const main = makeWin(`${origin}/#main`);
  const popover = makeWin(`${origin}/popover.html`);
  const windows = { main, popover };
  const ev = (win, frame = win.webContents.mainFrame) => ({ sender: win.webContents, senderFrame: frame });
  assert.equal(shellMain.senderPage(ev(main), windows, origin), "main");
  assert.equal(shellMain.senderPage(ev(popover), windows, origin), "popover");
  assert.equal(shellMain.senderPage(ev(main, { url: `${origin}/` }), windows, origin), null, "a subframe");
  const stranger = makeWin(`${origin}/`);
  assert.equal(shellMain.senderPage(ev(stranger), windows, origin), null, "another window");
  // The popover window navigated to the main page is not the popover any more.
  const moved = makeWin(`${origin}/`);
  assert.equal(shellMain.senderPage(ev(moved), { main, popover: moved }, origin), null);
  const gone = makeWin(`${origin}/`);
  gone.isDestroyed = () => true;
  assert.equal(shellMain.senderPage(ev(gone), { main: gone }, origin), null);
});

test("viewUrl, trayTitle and dimBitmap", () => {
  const origin = "http://127.0.0.1:41110";
  assert.equal(shellMain.viewUrl(origin), `${origin}/`);
  assert.equal(shellMain.viewUrl(origin, "welcome"), `${origin}/#welcome`);
  assert.equal(shellMain.viewUrl(origin, "javascript:alert(1)"), `${origin}/`);
  assert.equal(shellMain.trayTitle({ balance: { label: "42.8" } }), " 42.8");
  assert.equal(shellMain.trayTitle(null), " —");
  assert.deepEqual([...shellMain.dimBitmap(Buffer.from([0, 0, 0, 255, 0, 0, 0, 100]), 0.42)], [0, 0, 0, 107, 0, 0, 0, 42]);
});

// -------------------------------------------------------------- secrets

function fakeSafeStorage({ available = true } = {}) {
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    calls,
    isEncryptionAvailable: () => available,
    encryptString(s) {
      calls.encrypt++;
      return Buffer.concat([Buffer.from("v10"), Buffer.from(s, "utf8").reverse()]);
    },
    decryptString(buf) {
      calls.decrypt++;
      if (buf.subarray(0, 3).toString() !== "v10") throw new Error("bad ciphertext");
      return Buffer.from(buf.subarray(3)).reverse().toString("utf8");
    },
  };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "koinos-router-secrets-"));
const mode = (f) => fs.statSync(f).mode & 0o777;

test("secrets round-trip through safeStorage into 0600 files", () => {
  const dir = tmpDir();
  const safeStorage = fakeSafeStorage();
  const warnings = [];
  const log = (m) => warnings.push(m);
  const pw = secrets.walletPassword(dir, { safeStorage, log });
  const ms = secrets.machineSecret(dir, { safeStorage, log });
  assert.match(pw, /^[0-9a-f]{64}$/);
  assert.match(ms, /^[0-9a-f]{64}$/);
  assert.notEqual(pw, ms);
  const pwFile = path.join(dir, "wallet-password.bin");
  assert.equal(mode(pwFile), 0o600);
  assert.equal(mode(path.join(dir, "machine-secret.bin")), 0o600);
  assert.ok(!fs.readFileSync(pwFile).includes(Buffer.from(pw)), "stored encrypted, not in the clear");
  assert.equal(secrets.walletPassword(dir, { safeStorage, log }), pw, "stable across runs");
  assert.equal(secrets.machineSecret(dir, { safeStorage, log }), ms);
  assert.deepEqual(warnings, []);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["machine-secret.bin", "wallet-password.bin"], "no temp files left");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("without safeStorage a 0600 plaintext file is used, with a warning", () => {
  const dir = tmpDir();
  const warnings = [];
  const log = (m) => warnings.push(m);
  const pw = secrets.walletPassword(dir, { safeStorage: fakeSafeStorage({ available: false }), log });
  const plain = path.join(dir, "wallet-password.plain");
  assert.equal(mode(plain), 0o600);
  assert.equal(fs.readFileSync(plain, "utf8").trim(), pw);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /safeStorage unavailable/);
  assert.equal(secrets.walletPassword(dir, { safeStorage: null, log }), pw, "null safeStorage behaves the same");

  // Once safeStorage works, the secret moves into it unchanged.
  const safeStorage = fakeSafeStorage();
  assert.equal(secrets.walletPassword(dir, { safeStorage, log }), pw);
  assert.equal(fs.existsSync(plain), false);
  assert.equal(mode(path.join(dir, "wallet-password.bin")), 0o600);
  assert.equal(secrets.walletPassword(dir, { safeStorage, log }), pw);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an encrypted secret that can't be read is never replaced", () => {
  const dir = tmpDir();
  const pw = secrets.walletPassword(dir, { safeStorage: fakeSafeStorage(), log: () => {} });
  const file = path.join(dir, "wallet-password.bin");
  const before = fs.readFileSync(file);
  const warnings = [];
  const log = (m) => warnings.push(m);

  assert.equal(secrets.walletPassword(dir, { safeStorage: fakeSafeStorage({ available: false }), log }), null);
  const broken = fakeSafeStorage();
  broken.decryptString = () => {
    throw new Error("keychain denied");
  };
  assert.equal(secrets.walletPassword(dir, { safeStorage: broken, log }), null);
  assert.equal(warnings.length, 2);
  assert.deepEqual(fs.readFileSync(file), before, "still the original ciphertext");
  assert.equal(fs.existsSync(path.join(dir, "wallet-password.plain")), false);
  assert.equal(secrets.walletPassword(dir, { safeStorage: fakeSafeStorage(), log }), pw, "readable again later");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadSecret refuses to run without a data dir", () => {
  assert.throws(() => secrets.loadSecret({ name: "x", safeStorage: null }), /dataDir/);
});

// ------------------------------------------- laptop probe before Share

const macSignals = require("../lib/mac-signals");
const mainSource = () => read("router", "main.js");
const indexOf = (src, needle) => {
  const i = src.indexOf(needle);
  assert.ok(i >= 0, `main.js contains ${needle}`);
  return i;
};

test("Share can't start (or onboarding run) before the laptop probe has answered", () => {
  // The wait covers the probe's own worst case, so it never gives up first.
  assert.ok(shellMain.SIGNALS_WAIT_MS >= macSignals.LAPTOP_PROBE_MAX_MS);
  assert.strictEqual(macSignals.LAPTOP_PROBE_MAX_MS, 2 * macSignals.PROBE_TIMEOUT_MS);
  const src = mainSource();
  const wait = indexOf(src, "await settleWithin(signals.ready, SIGNALS_WAIT_MS)");
  assert.ok(wait < indexOf(src, "idle.start();"), "before the idle gate runs");
  assert.ok(wait < indexOf(src, "await rc.start();"), "before Share resumes and the HTTP API listens");
  assert.doesNotMatch(src, /Promise\.race\(\[signals\.ready/);
});

test("settleWithin reports whether a promise settled in time", async () => {
  assert.strictEqual(await shellMain.settleWithin(Promise.resolve(), 50), true);
  assert.strictEqual(await shellMain.settleWithin(Promise.reject(new Error("x")), 50), true);
  assert.strictEqual(await shellMain.settleWithin(new Promise(() => {}), 20), false);
});

test("mac-signals says when the laptop answer is known, and kills a stuck probe hard", async () => {
  const calls = [];
  let answer = null;
  const execFile = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    if (args.includes("hw.model")) answer = () => cb(null, "Macmini9,1\n");
    else cb(null, file.endsWith("pmset") && args.includes("batt") ? "Now drawing from 'AC Power'\n" : " lowpowermode 0\n");
  };
  const pm = { getSystemIdleTime: () => 0, isOnBatteryPower: () => false, getCurrentThermalState: () => "nominal" };
  const signals = macSignals.createMacSignals({ powerMonitor: pm, execFile });
  assert.strictEqual(signals.isLaptopKnown(), false);
  answer();
  await signals.ready;
  assert.strictEqual(signals.isLaptopKnown(), true);
  assert.strictEqual(signals.isLaptop(), false);
  for (const c of calls) {
    assert.strictEqual(c.opts.timeout, macSignals.PROBE_TIMEOUT_MS);
    assert.strictEqual(c.opts.killSignal, "SIGKILL");
  }
});

// ------------------------------------------------------ status at boot

test("status listeners are attached before Router starts", () => {
  const src = mainSource();
  const start = indexOf(src, "await rc.start();");
  assert.ok(indexOf(src, 'rc.service.on("status"') < start);
  assert.ok(indexOf(src, 'rc.service.on("settings"') < start);
  assert.match(src, /createTray\(statusTracker\.last\)/, "the tray starts from the newest status");
});

test("a status read never overwrites an event that arrived while it ran", async () => {
  const applied = [];
  const tracker = shellMain.createStatusTracker((s) => applied.push(s.v));
  let release;
  const read = tracker.read(() => new Promise((r) => (release = r)));
  tracker.event({ v: "earning" });
  release({ v: "preparing" });
  assert.deepStrictEqual(await read, { v: "earning" });
  assert.deepStrictEqual(applied, ["earning"]);
  assert.deepStrictEqual(tracker.last, { v: "earning" });
  // With no event in between, the read is applied.
  assert.deepStrictEqual(await tracker.read(async () => ({ v: "ready" })), { v: "ready" });
  assert.deepStrictEqual(applied, ["earning", "ready"]);
});

// ------------------------------------------------- Start now, right now

function deferQueue() {
  const queue = [];
  const defer = (fn) => queue.push(fn);
  const flush = () => {
    while (queue.length) queue.shift()();
  };
  return { defer, flush, get size() {
    return queue.length;
  } };
}

test("the gate kick ticks once per change of Share, When or plugged-in only", () => {
  let inputs = { enabled: true, mode: "idle", pluggedInOnly: false, laptop: true, otherAppEarning: false };
  let ticks = 0;
  const q = deferQueue();
  const kick = shellMain.createGateKick({ inputs: () => inputs, tick: () => ticks++, defer: q.defer });

  kick();
  q.flush();
  assert.strictEqual(ticks, 0, "nothing changed since the controller started");

  inputs = { ...inputs, mode: "always" }; // "Start now"
  kick();
  kick();
  kick();
  assert.strictEqual(q.size, 1, "kicks in one turn coalesce");
  q.flush();
  assert.strictEqual(ticks, 1);

  kick(); // the status event the tick itself caused
  q.flush();
  assert.strictEqual(ticks, 1, "no loop: unchanged inputs don't tick again");

  inputs = { ...inputs, otherAppEarning: true, laptop: false };
  kick();
  q.flush();
  assert.strictEqual(ticks, 1, "the 5 s poll covers everything else");

  for (const change of [{ pluggedInOnly: true }, { enabled: false }, { enabled: true }, { mode: "idle" }]) {
    inputs = { ...inputs, ...change };
    kick();
    q.flush();
  }
  assert.strictEqual(ticks, 5);

  // A throwing inputs() never throws out of an event listener, nor ticks.
  const broken = shellMain.createGateKick({ inputs: () => { throw new Error("stopped"); }, tick: () => ticks++, defer: q.defer });
  broken();
  q.flush();
  assert.strictEqual(ticks, 5);
});

test("Start now starts sharing within a turn, not at the next 5 s poll", () => {
  const { IdleController } = require("../lib/idle-policy");
  // The user is at the Mac (idle 3 s) on a desktop, Share on, When = idle.
  const settings = { enabled: true, mode: "idle", pluggedInOnly: false, laptop: false, otherAppEarning: false };
  const applied = [];
  let intervalFn = null;
  const idle = new IdleController({
    inputs: () => ({ ...settings }),
    readSignals: () => ({ idleSec: 3, onBattery: false, thermal: "nominal", lowPower: false }),
    apply: (d) => applied.push(d),
    intervalMs: 5000,
    setInterval: (fn) => (intervalFn = fn), // the poll never fires in this test
    clearInterval: () => {},
  });
  idle.start();
  assert.deepStrictEqual(applied.at(-1), { run: false, reason: "Starts when you step away", unload: false });

  const q = deferQueue();
  const kick = shellMain.createGateKick({ inputs: () => idle.inputs(), tick: () => idle.tick(), defer: q.defer });
  settings.mode = "always"; // POST /core/router/settings { share: { mode: "always" } }
  kick(); // RouterService emits "settings"
  q.flush();
  assert.deepStrictEqual(applied.at(-1), { run: true, reason: null, unload: false }, "sharing runs now");
  assert.strictEqual(applied.length, 2);
  assert.ok(intervalFn, "the 5 s poll is still there for everything else");

  // Share switched off and on again from the popover: applied at once too.
  settings.enabled = false;
  kick();
  q.flush();
  assert.deepStrictEqual(applied.at(-1), { run: false, reason: null, unload: false });
  settings.enabled = true;
  kick();
  q.flush();
  assert.deepStrictEqual(applied.at(-1), { run: true, reason: null, unload: false });
});

test("main.js kicks the idle gate on both service events, after the controller starts", () => {
  const src = mainSource();
  const kickAt = indexOf(src, "kickGate = createGateKick({");
  assert.ok(indexOf(src, "idle.start();") < kickAt, "the kick starts from the controller's first decision");
  assert.ok(kickAt < indexOf(src, "await rc.start();"), "ready before Share resumes and the API listens");
  assert.match(src, /rc\.service\.on\("status", \(st\) => \{\s*statusTracker\.event\(st\);\s*kickGate\?\.\(\);/);
  assert.match(src, /rc\.service\.on\("settings", \(settings\) => \{\s*onSettings\(settings\);\s*kickGate\?\.\(\);/);
  assert.match(src, /tick: \(\) => idle\?\.tick\(\)/);
});

// ------------------------------------------------- the Keychain prompt

test("Router explains the Keychain prompt before the first decrypt, never in a smoke run", () => {
  const src = mainSource();
  const explain = indexOf(src, "const keychain = smoke ? null : await explainKeychainPrompt(dataDir);");
  assert.ok(explain < indexOf(src, "secrets.machineSecret(dataDir"), "before the first decrypt");
  assert.ok(explain < indexOf(src, "secrets.walletPassword(dataDir"));
  const after = indexOf(src, "await afterKeychain(keychain, sessionSecret, walletPassword)");
  assert.ok(indexOf(src, "secrets.walletPassword(dataDir") < after, "records only after both decrypts");
  assert.ok(after < indexOf(src, "createRouterCore({"), "Core starts after the answer");
  // The default session's cookie store is encrypted with the same Keychain
  // key (the cookie-encryption fuse), so nothing touches it before the notice.
  assert.ok(explain < indexOf(src, "session.defaultSession"), "before the default session is used");
  const fn = src.slice(indexOf(src, "async function explainKeychainPrompt("), indexOf(src, "async function afterKeychain("));
  assert.match(fn, /if \(!app\.isPackaged \|\| process\.platform !== "darwin"\) return null;/);
  assert.match(fn, /bundlePathFromExecPath\(process\.execPath\)/);
  assert.match(fn, /shouldExplainKeychain\(\{ packaged: true, smoke, hasSecrets, current, recorded \}\)/);
  assert.ok(indexOf(fn, "app.focus({ steal: true });") < indexOf(fn, "dialog.showMessageBox("), "Router comes forward first");
  // The answer is remembered only after a decrypt that worked.
  const rest = src.slice(indexOf(src, "async function afterKeychain("), indexOf(src, "function readSecret("));
  assert.ok(indexOf(rest, "if (unlocked) {") < indexOf(rest, "keychainAccess.writeRecord("));
  assert.match(rest, /app\.relaunch\(\);\s*app\.exit\(0\);/);
});

// --------------------------------------------------------- power blocker

test("the no-sleep blocker is held only while earning on AC power", () => {
  const earning = { share: { state: "earning" } };
  assert.strictEqual(shellMain.wantsBlocker(earning, false), true);
  assert.strictEqual(shellMain.wantsBlocker(earning, true), false);
  assert.strictEqual(shellMain.wantsBlocker({ share: { state: "waiting" } }, false), false);
  assert.strictEqual(shellMain.wantsBlocker(null, false), false);
  const src = mainSource();
  assert.match(src, /wantsBlocker\(st, electron\.powerMonitor\.isOnBatteryPower\(\)\)/);
  assert.match(src, /powerMonitor\.on\("on-ac", resync\)/);
  assert.match(src, /powerMonitor\.on\("on-battery", resync\)/);
});

// ------------------------------------------------------- windows, focus

test("Router comes forward when reopened from Finder, Spotlight or Launchpad", () => {
  const src = mainSource();
  assert.match(src, /app\.on\("activate", reopen\)/);
  assert.match(src, /app\.on\("second-instance", reopen\)/);
});

test("hidden windows report themselves hidden, so their polls stay off", () => {
  const src = mainSource();
  assert.strictEqual((src.match(/paintWhenInitiallyHidden:\s*false/g) || []).length, 2);
  assert.strictEqual((src.match(/new BrowserWindow\(/g) || []).length, 2);
});

test("dismissing the popover hands focus back to the app the user was in", () => {
  const src = mainSource();
  assert.match(src, /handle\("router:close-popover", \["popover"\], \(\) => {\s*hidePopover\({ yieldFocus: true }\);/);
  assert.match(src, /if \(popover\.isVisible\(\)\) return hidePopover\({ yieldFocus: true }\);/);
  assert.match(src, /function yieldFocusIfIdle\(\) {[\s\S]*?app\.hide\(\);/);
  // And a later show undoes that hide.
  assert.match(src, /function unhideApp\(\) {\s*if \(process\.platform === "darwin"\) app\.show\(\);/);
});

test("the Paused tray title is dimmed like the icon", () => {
  const paused = { headline: { label: "Paused" }, balance: { label: "42.8" } };
  assert.strictEqual(shellMain.trayTitle(paused), "\x1b[1;30m 42.8");
  assert.strictEqual(shellMain.trayTitle({ headline: { label: "Ready" }, balance: { label: "42.8" } }), " 42.8");
});

// ------------------------------------------------------------ login item

test("at launch the login item follows the OS once the user has a stored choice", () => {
  // First launch: register (the default is on) and remember the choice.
  assert.deepStrictEqual(shellMain.loginItemAtBoot({ stored: null, osOpen: false }), { setOs: true, store: true });
  assert.deepStrictEqual(shellMain.loginItemAtBoot({ stored: undefined, osOpen: true }), { setOs: null, store: true });
  // Removed in System Settings › Login Items: Router doesn't re-add itself.
  assert.deepStrictEqual(shellMain.loginItemAtBoot({ stored: true, osOpen: false }), { setOs: null, store: false });
  assert.deepStrictEqual(shellMain.loginItemAtBoot({ stored: false, osOpen: true }), { setOs: null, store: true });
  assert.deepStrictEqual(shellMain.loginItemAtBoot({ stored: true, osOpen: true }), { setOs: null, store: null });
  const src = mainSource();
  assert.doesNotMatch(src, /getLoginItemSettings\(\)\.openAtLogin !== openAtLogin/);
});

// ----------------------------------------------------------------- smoke

test("a smoke run never uses the real data dir", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "koinos-router-root-"));
  const a = shellMain.resolveDataRoot({ smoke: true, env: {}, tmpdir: tmp });
  assert.ok(a.tempDir && a.dataOverride === a.tempDir);
  assert.ok(a.tempDir.startsWith(tmp + path.sep), "a fresh dir under the temp dir");
  assert.ok(fs.statSync(a.tempDir).isDirectory());
  const b = shellMain.resolveDataRoot({ smoke: true, env: {}, tmpdir: tmp });
  assert.notStrictEqual(a.tempDir, b.tempDir);
  assert.deepStrictEqual(shellMain.resolveDataRoot({ smoke: false, env: {}, tmpdir: tmp }), { dataOverride: null, tempDir: null });
  const own = path.join(tmp, "mine");
  assert.deepStrictEqual(shellMain.resolveDataRoot({ smoke: true, env: { KOINOS_ROUTER_DATA: own }, tmpdir: tmp }), { dataOverride: own, tempDir: null });
  fs.rmSync(tmp, { recursive: true, force: true });

  const src = mainSource();
  assert.match(src, /resolveDataRoot\({ smoke }\)/);
  // Router's own secrets never go through the mock keychain.
  assert.match(src, /const secretOpts = smoke \? { safeStorage: null/);
  assert.match(src, /secrets\.walletPassword\(dataDir, secretOpts\)/);
  assert.match(src, /secrets\.machineSecret\(dataDir, secretOpts\)/);
});

test("the smoke watchdog is cancelled once the smoke check has passed", () => {
  const src = mainSource();
  assert.match(src, /smokeTimer = setTimeout\(/);
  assert.ok(indexOf(src, "clearTimeout(smokeTimer);\n    console.log(`SMOKE OK") > 0);
});

// --------------------------------------------------------- wallet backup

test("the recovery key needs Touch ID or the login password, with no plain-dialog fallback", async () => {
  const prompts = [];
  const prefs = (outcome) => ({
    canPromptTouchID: () => false, // a Mac mini, clamshell mode, or no finger enrolled
    promptTouchID: async (reason) => {
      prompts.push(reason);
      if (outcome) throw new Error(outcome);
    },
  });
  assert.deepStrictEqual(await shellMain.confirmOwner(prefs(null)), { ok: true });
  assert.deepStrictEqual(prompts, ["show your recovery key"], "prompted even without Touch ID (password fallback)");
  assert.deepStrictEqual(await shellMain.confirmOwner(prefs("Canceled by user.")), { ok: false });
  const failed = await shellMain.confirmOwner(prefs("Application retry limit exceeded."));
  assert.strictEqual(failed.ok, false);
  assert.match(failed.error, /couldn’t confirm it’s you/);
  assert.match((await shellMain.confirmOwner(prefs("Passcode not set."))).error, /login password/);
  const none = await shellMain.confirmOwner({});
  assert.strictEqual(none.ok, false);
  assert.ok(none.error);

  const src = mainSource();
  assert.doesNotMatch(src, /"Show Key"/);
  assert.doesNotMatch(src, /\.canPromptTouchID\?*\.?\(/, "Touch ID availability never decides whether to authenticate");
  assert.match(src, /await confirmOwner\(electron\.systemPreferences\)/);
});

test("the recovery key is copied as concealed, never with a plain clipboard write", async () => {
  const src = mainSource();
  assert.doesNotMatch(src, /clipboard\.writeText\(/);
  assert.match(src, /await copyConcealed\(text, { execFile }\)/);

  // The secret goes through stdin, never argv (visible in `ps`).
  const secret = "5KTESTwifTESTwifTESTwif";
  let seen = null;
  const fakeExec = (file, args, opts, cb) => {
    seen = { file, args, opts, stdin: "" };
    setImmediate(() => cb(null, "ok\n"));
    return { stdin: { on() {}, end: (s) => (seen.stdin = s) } };
  };
  await shellMain.copyConcealed(secret, { execFile: fakeExec });
  assert.strictEqual(seen.file, "/usr/bin/osascript");
  assert.strictEqual(seen.stdin, secret);
  assert.ok(!seen.args.some((a) => a.includes(secret)));
  const failing = (file, args, opts, cb) => {
    setImmediate(() => cb(new Error(`boom ${secret}`), ""));
    return { stdin: { on() {}, end() {} } };
  };
  await assert.rejects(shellMain.copyConcealed(secret, { execFile: failing }), (e) => !e.message.includes(secret));
});

test("concealed copy marks the pasteboard for clipboard managers (real osascript, private pasteboard)", { skip: process.platform !== "darwin" }, async () => {
  const name = `io.koinosai.router.test.${process.pid}.${Date.now()}`;
  const secret = "L1-test-not-a-real-key-é";
  await shellMain.copyConcealed(secret, { execFile: require("node:child_process").execFile, pasteboard: name });
  const readBack = `ObjC.import("AppKit");
function run(argv) {
  const pb = $.NSPasteboard.pasteboardWithName(argv[0]);
  const out = JSON.stringify({ types: ObjC.deepUnwrap(pb.types), text: pb.stringForType($.NSPasteboardTypeString).js });
  pb.releaseGlobally;
  return out;
}`;
  const out = JSON.parse(execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", readBack, name], { encoding: "utf8" }));
  assert.strictEqual(out.text, secret);
  for (const type of shellMain.CONCEALED_TYPES) assert.ok(out.types.includes(type), `${type} is set`);
});

// --------------------------------------------------------------- fuses

test("packaging flips the Electron fuses that would let other code run inside Router", async () => {
  assert.deepStrictEqual(builder.electronFuses, {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    enableCookieEncryption: true,
    resetAdHocDarwinSignature: true,
  });
  // RunAsNode off is only safe while nothing Router loads spawns Electron as Node.
  for (const f of ["router/main.js", ...fs.readdirSync(path.join(ROOT, "router", "lib")).filter((f) => f.endsWith(".js")).map((f) => `router/lib/${f}`)]) {
    assert.doesNotMatch(read(...f.split("/")), /ELECTRON_RUN_AS_NODE/, f);
  }

  // Read the fuses back from a binary flipped by electron-builder's own code.
  const framework = path.join(
    ROOT,
    "node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
  );
  if (!fs.existsSync(framework)) return; // not a macOS Electron install
  const { PlatformPackager } = require("app-builder-lib");
  const fuses = require("@electron/fuses");
  const config = await PlatformPackager.prototype.generateFuseConfig.call({}, builder.electronFuses);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koinos-router-fuses-"));
  const copy = path.join(dir, "Electron Framework");
  try {
    fs.copyFileSync(framework, copy, fs.constants.COPYFILE_FICLONE);
    await fuses.flipFuses(copy, { ...config, resetAdHocDarwinSignature: false });
    const wire = await fuses.getCurrentFuseWire(copy);
    const { FuseV1Options: O } = fuses;
    const { FuseState: S } = require("@electron/fuses/dist/constants");
    assert.strictEqual(wire[O.RunAsNode], S.DISABLE);
    assert.strictEqual(wire[O.EnableNodeOptionsEnvironmentVariable], S.DISABLE);
    assert.strictEqual(wire[O.EnableNodeCliInspectArguments], S.DISABLE);
    assert.strictEqual(wire[O.EnableEmbeddedAsarIntegrityValidation], S.ENABLE);
    assert.strictEqual(wire[O.OnlyLoadAppFromAsar], S.ENABLE);
    assert.strictEqual(wire[O.EnableCookieEncryption], S.ENABLE);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dist-router/ is ignored by git", () => {
  assert.match(read(".gitignore"), /^dist-router\/$/m);
});

// ------------------------------------------------- launch window, hints

test("opening Router by hand shows the main window; a login launch stays quiet", () => {
  const show = shellMain.showMainAtLaunch;
  const mac = { platform: "darwin", onboarded: true };
  assert.strictEqual(show({ ...mac, loginItem: { openAtLogin: true, wasOpenedAtLogin: false } }), true, "Finder, Spotlight, Launchpad, open");
  assert.strictEqual(show({ ...mac, loginItem: { openAtLogin: true, wasOpenedAtLogin: true } }), false, "macOS opened it at login");
  // No answer from Electron (or a field it no longer sets): show it.
  assert.strictEqual(show({ ...mac, loginItem: null }), true);
  assert.strictEqual(show({ ...mac, loginItem: {} }), true);
  assert.strictEqual(show({ ...mac, loginItem: { wasOpenedAtLogin: "yes" } }), true);
  // Onboarding not finished: show it, even at login (Router does nothing until then).
  assert.strictEqual(show({ ...mac, onboarded: false, loginItem: { wasOpenedAtLogin: true } }), true);
  assert.strictEqual(show({ ...mac, onboarded: false, loginItem: null }), true);
  // Smoke runs never show a window.
  assert.strictEqual(show({ ...mac, smoke: true, loginItem: null }), false);
  assert.strictEqual(show({ ...mac, smoke: true, onboarded: false }), false);
  // wasOpenedAtLogin is macOS-only.
  assert.strictEqual(show({ platform: "linux", onboarded: true, loginItem: { wasOpenedAtLogin: true } }), true);

  const src = mainSource();
  assert.match(src, /if \(showMainAtLaunch\({ onboarded: first\.onboarded, loginItem: loginItemSettings\(\) }\)\) showMain\(\);/);
  assert.match(src, /function loginItemSettings\(\) {\s*try {\s*return app\.getLoginItemSettings\(\);/);
  // The smoke check returns before the launch decision, so smoke stays windowless.
  const boot = src.slice(src.indexOf("async function boot()"));
  assert.ok(boot.indexOf("if (smoke) return smokeCheck(port);") < boot.indexOf("showMainAtLaunch("));
  assert.doesNotMatch(src, /if \(!first\.onboarded\) showMain\(\);/);
});

test("Electron reports wasOpenedAtLogin on macOS", () => {
  const dts = fs.readFileSync(path.join(ROOT, "node_modules", "electron", "electron.d.ts"), "utf8");
  const block = /interface LoginItemSettings {([\s\S]*?)\n  }/.exec(dts);
  assert.ok(block, "LoginItemSettings is declared");
  assert.match(block[1], /\n    wasOpenedAtLogin: boolean;/);
});

test("notch detection reads the built-in screen's menu-bar height", () => {
  const screen = (internal, menuBar, extra = {}) => ({
    internal,
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: menuBar, width: 1512, height: 982 - menuBar },
    ...extra,
  });
  assert.strictEqual(shellMain.notchState([screen(true, 38)]), true, "14/16-inch MacBook Pro");
  assert.strictEqual(shellMain.notchState([screen(true, 37)]), true, "MacBook Air M2+");
  assert.strictEqual(shellMain.notchState([screen(true, 24)]), false, "no notch");
  assert.strictEqual(shellMain.notchState([screen(true, 25)]), false);
  assert.strictEqual(shellMain.notchState([screen(true, 0)]), null, "menu bar set to hide itself");
  assert.strictEqual(shellMain.notchState([screen(false, 25)]), null, "desktop Mac or closed lid");
  assert.strictEqual(shellMain.notchState([]), null);
  assert.strictEqual(shellMain.notchState(null), null);
  // A second display beside the built-in one: the built-in one decides.
  const external = { ...screen(false, 25), bounds: { x: 1512, y: -300, width: 2560, height: 1440 }, workArea: { x: 1512, y: -275, width: 2560, height: 1415 } };
  assert.strictEqual(shellMain.notchState([external, screen(true, 38)]), true);
  assert.strictEqual(shellMain.notchState([external, screen(true, 24)]), false);
});

test("the menu-bar hint shows after onboarding until dismissed, and never on a Mac without a notch", () => {
  const hint = shellMain.menuBarHint;
  assert.strictEqual(hint({ onboarded: true, stored: null, notch: true }), "notch");
  assert.strictEqual(hint({ onboarded: true, stored: null, notch: null }), "menu-bar", "can't tell: a general pointer, once");
  assert.strictEqual(hint({ onboarded: true, stored: null, notch: false }), null);
  assert.strictEqual(hint({ onboarded: false, stored: null, notch: true }), null, "not during onboarding");
  assert.strictEqual(hint({ onboarded: true, stored: shellMain.HINT_DONE, notch: true }), null, "dismissed");
  assert.deepStrictEqual(shellMain.HINTS, { menuBar: "router.hints.menuBar" });

  const src = mainSource();
  // Dismissed from the page (main window only), or done once the icon was clicked.
  assert.match(src, /handle\("router:dismiss-hint", \["main"\], \(name\) => {\s*dismissHint\(typeof name === "string" \? name : ""\);/);
  assert.match(src, /popover\.focus\(\);\s*\/\/[^\n]*\n\s*dismissHint\("menuBar"\);/);
  assert.match(src, /const key = Object\.hasOwn\(HINTS, name\) \? HINTS\[name\] : null;/);
  assert.match(src, /rc\.core\.settings\.set\(key, HINT_DONE\);\s*rc\.service\.appInfoChanged\(\);/);
});

test("the update notice is wired to Status.app and never runs in smoke or from source", () => {
  const src = mainSource();
  assert.match(src, /rc\.service\.setAppInfo\(appInfo\);/);
  // Before rc.start(): the first status already carries the app block.
  assert.ok(src.indexOf("rc.service.setAppInfo(appInfo);") < src.indexOf("const port = await rc.start();"));
  assert.match(src, /if \(smoke \|\| !app\.isPackaged \|\| process\.env\.KOINOS_ROUTER_NO_UPDATE_CHECK === "1"\) return;/);
  assert.match(src, /createUpdateCheck\({\s*currentVersion: app\.getVersion\(\),/);
  assert.match(src, /onChange: \(\) => rc\?\.service\.appInfoChanged\(\)/);
  assert.match(src, /updates\?\.stop\(\);/);
  assert.match(src, /version: app\.isPackaged \? app\.getVersion\(\) : null,/);
});

test("pages can open only Router's GitHub release pages in the browser", () => {
  const allowed = shellMain.externalUrlAllowed;
  assert.strictEqual(allowed("https://github.com/levineam/koinos-router/releases/tag/router-v0.1.1"), true);
  assert.strictEqual(allowed("https://github.com/levineam/koinos-router/releases"), true);
  for (const url of [
    "https://example.com/",
    "http://github.com/levineam/koinos-router/releases",
    "https://github.com/levineam/koinos-router",
    "https://github.com/someone/else/releases",
    "https://koinosai.com/",
    "file:///Applications",
    "x-apple.systempreferences:com.apple.preference.security",
    "not a url",
  ]) {
    assert.strictEqual(allowed(url), false, url);
  }
  const src = mainSource();
  const fn = /function openExternal\(url\) {([\s\S]*?)\n  }/.exec(src);
  assert.ok(fn, "openExternal exists");
  assert.match(fn[1], /if \(!externalUrlAllowed\(url\)\) return;/);
  assert.equal((src.match(/shell\.openExternal\(/g) || []).length, 1, "every external open goes through the allow-list");
  // Both ways a page can leave (navigate, window.open) end in openExternal.
  assert.match(src, /if \(target === "main"\) return showMain\(new URL\(url\)\.hash\.slice\(1\)\);\s*openExternal\(url\);/);
  assert.match(src, /else openExternal\(url\);\s*return { action: "deny" };/);
});

test("the login item is left alone while Router runs from the DMG or a translocated copy", () => {
  const transient = shellMain.transientAppLocation;
  assert.strictEqual(transient("/Applications/Koinos Router.app/Contents/MacOS/Koinos Router"), false);
  assert.strictEqual(transient("/Users/me/Applications/Koinos Router.app/Contents/MacOS/Koinos Router"), false);
  assert.strictEqual(transient("/Volumes/Koinos Router/Koinos Router.app/Contents/MacOS/Koinos Router"), true, "the mounted DMG");
  assert.strictEqual(
    transient("/private/var/folders/xy/abc/T/AppTranslocation/1234-ABCD/d/Koinos Router.app/Contents/MacOS/Koinos Router"),
    true,
    "a quarantined download Gatekeeper translocated",
  );
  assert.strictEqual(transient(""), false);
  assert.strictEqual(transient(undefined), false);
  const src = mainSource();
  const sync = src.slice(src.indexOf("async function syncLoginItemAtBoot()"));
  assert.ok(sync.indexOf("transientAppLocation(process.execPath)") < sync.indexOf("app.setLoginItemSettings"), "checked before anything is registered");
});
