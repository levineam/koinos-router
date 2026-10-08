#!/usr/bin/env node
"use strict";

// Design-review server for the Router renderer. Serves router/ui and an
// in-memory /core/router/* API that follows router/ARCHITECTURE.md, so the
// pages can be clicked through in any browser without Electron or Core.
// It never touches the network, the real wallet, or any harness config.
//
//   node router/ui/dev-mock.js [port]
//   open http://127.0.0.1:<port>/?scenario=earning
//
// Query flags on any page load: scenario=<name> resets state, fail=toggles
// makes the Share/Use switches fail (to see the revert), shell=0 hides the
// fake window.routerShell, frame=0 drops the review frame around the page.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const UI_DIR = __dirname;
const DEFAULT_PORT = 41190;
const SCENARIOS = ["earning", "waiting", "paused", "outofkai", "preparing", "firstrun", "notools"];
const LIMIT_CHOICES = [5, 10, 25, null];
const EARN_EVERY_MS = 6000;
const MAX_BODY = 64 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

// ------------------------------------------------------------------ state

function fmt1(n) {
  const v = Math.round(Number(n) * 10) / 10;
  return (v === 0 ? 0 : v).toFixed(1);
}

function minutesAgo(now, m) {
  return now - m * 60 * 1000;
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function sampleItems(now) {
  const today = new Date(now);
  today.setHours(13, 32, 0, 0);
  // Keep the "today" rows inside today even when the mock runs after midnight.
  const base = Math.min(now, today.getTime());
  const at = (m) => minutesAgo(base, m);
  const yesterday = (h, m) => {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const rows = [
    { kind: "delegate", at: at(0), title: "Summarized test failures", harness: "Codex", kai: -0.2 },
    { kind: "share", at: at(22), title: "Shared compute · 4 jobs", harness: "This Mac", kai: 1.6 },
    { kind: "delegate", at: at(44), title: "Wrote fixtures for parser tests", harness: "Claude Code", kai: -1.8 },
    { kind: "delegate", at: at(147), title: "Grouped 212 log lines by cause", harness: "Codex", kai: -0.1 },
    { kind: "share", at: at(372), title: "Shared compute · 11 jobs", harness: "This Mac", kai: 4.8, window: "7:20 – 9:40 AM" },
    { kind: "delegate", at: yesterday(17, 12), title: "Drafted a commit message", harness: "Claude Code", kai: null, ok: false },
    { kind: "delegate", at: yesterday(16, 3), title: "Extracted error codes from crash log", harness: "Codex", kai: -0.4 },
    { kind: "share", at: yesterday(1, 15), title: "Shared compute · 23 jobs", harness: "This Mac", kai: 9.2, window: "1:15 – 6:50 AM" },
  ];
  return rows.map((r, i) => ({
    id: `mock-${i + 1}`,
    kind: r.kind,
    at: r.at,
    title: r.title,
    subtitle: `${r.harness} · ${r.window || clock(r.at)}`,
    kai: r.kai,
    ok: r.ok !== false,
  }));
}

function scenarioState(name, now = Date.now()) {
  const scenario = SCENARIOS.includes(name) ? name : "earning";
  const s = {
    scenario,
    onboarded: true,
    share: true,
    use: true,
    idle: true,
    preparingPct: null,
    outOfKai: false,
    balanceKai: 42.8,
    earnedKai: 6.4,
    spentKai: 2.1,
    address: "1Kq7Hn3pXwS8dVfT2rLbG9yMc4ZuE6f3cQ",
    settings: {
      share: { mode: "idle", pluggedInOnly: true },
      use: { dailyLimitKai: 10 },
      general: { openAtLogin: true },
    },
    connections: {
      codex: { found: true, connected: true, method: "cli" },
      claude: { found: true, connected: true, method: "cli" },
    },
    items: sampleItems(now),
    failToggles: false,
    lastTick: now,
  };
  switch (scenario) {
    case "waiting":
      s.idle = false;
      break;
    case "paused":
      s.share = false;
      s.use = false;
      break;
    case "outofkai":
      s.share = false;
      s.outOfKai = true;
      s.balanceKai = 0;
      s.earnedKai = 0;
      break;
    case "preparing":
      s.preparingPct = 38;
      s.earnedKai = 0;
      break;
    case "firstrun":
      s.onboarded = false;
      s.share = false;
      s.use = false;
      s.balanceKai = null;
      s.earnedKai = 0;
      s.spentKai = 0;
      s.address = null;
      s.items = [];
      s.connections = {
        codex: { found: true, connected: false, method: null },
        claude: { found: true, connected: false, method: null },
      };
      break;
    case "notools":
      s.connections = {
        codex: { found: true, connected: false, method: null },
        claude: { found: false, connected: false, method: null },
      };
      break;
    default:
      break;
  }
  return s;
}

// Sharing runs while the Mac is idle, or any time in "always" mode
// (ARCHITECTURE.md decideShare); the mock has no battery or thermal state.
function canRun(s) {
  return s.idle || s.settings.share.mode === "always";
}

// Lets time pass so switches visibly matter: downloads progress, an idle
// Mac that is sharing slowly earns.
function advance(s, now = Date.now()) {
  const elapsed = Math.max(0, now - s.lastTick);
  if (s.share && s.preparingPct !== null) {
    s.preparingPct = Math.min(100, s.preparingPct + Math.floor(elapsed / 1000) * 2);
    if (s.preparingPct >= 100) s.preparingPct = null;
    if (elapsed >= 1000) s.lastTick = now;
    return;
  }
  if (s.share && canRun(s) && s.balanceKai !== null && elapsed >= EARN_EVERY_MS) {
    const steps = Math.floor(elapsed / EARN_EVERY_MS);
    s.balanceKai = Math.round((s.balanceKai + steps * 0.1) * 10) / 10;
    s.earnedKai = Math.round((s.earnedKai + steps * 0.1) * 10) / 10;
    if (s.balanceKai > 0) s.outOfKai = false;
    s.lastTick += steps * EARN_EVERY_MS;
    return;
  }
  if (!(s.share && canRun(s))) s.lastTick = now;
}

function anyConnected(s) {
  return s.connections.codex.connected || s.connections.claude.connected;
}

// Status per the ARCHITECTURE.md copy table and headline precedence.
function computeStatus(s) {
  const preparing = s.share && s.preparingPct !== null;
  const earning = s.share && !preparing && canRun(s);
  const limit = s.settings.use.dailyLimitKai;
  const outOfKai = s.use && s.outOfKai;

  let share;
  if (!s.share) {
    share = { enabled: false, state: "off", detail: outOfKai ? "Turn on to earn KAI" : "Earn KAI when your Mac is idle", pct: null };
  } else if (preparing) {
    share = { enabled: true, state: "preparing", detail: `Getting ready · ${s.preparingPct}%`, pct: s.preparingPct };
  } else if (earning) {
    share = { enabled: true, state: "earning", detail: `+${fmt1(s.earnedKai)} KAI today`, pct: null };
  } else {
    share = { enabled: true, state: "waiting", detail: "Starts when you step away", pct: null };
  }

  const connected = { codex: s.connections.codex.connected, claude: s.connections.claude.connected };
  let use;
  if (!s.use) use = { enabled: false, state: "off", detail: "Spend KAI on AI for Codex and Claude Code" };
  else if (outOfKai) use = { enabled: true, state: "out-of-kai", detail: "Codex and Claude Code are using their usual models" };
  else if (limit !== null && s.spentKai >= limit) use = { enabled: true, state: "limit", detail: "Daily limit reached" };
  else if (!anyConnected(s)) use = { enabled: true, state: "no-tools", detail: "Connect Codex or Claude Code" };
  else use = { enabled: true, state: "on", detail: "Spend KAI on AI for Codex and Claude Code" };
  use.connected = connected;

  let headline;
  if (preparing) headline = { label: "Getting ready", tone: "busy", pct: s.preparingPct };
  else if (outOfKai) headline = { label: "Out of KAI", tone: "warn", pct: null };
  else if (earning) headline = { label: "Earning", tone: "good", pct: null };
  else if (s.share || s.use) headline = { label: "Ready", tone: "good", pct: null };
  else headline = { label: "Paused", tone: "idle", pct: null };

  return {
    onboarded: s.onboarded,
    balance: { kai: s.balanceKai, label: s.balanceKai === null ? "—" : fmt1(s.balanceKai) },
    today: { earnedKai: s.earnedKai, spentKai: s.spentKai },
    headline,
    share,
    use,
    wallet: { exists: !!s.address, address: s.address },
  };
}

function settingsOf(s) {
  return {
    share: { ...s.settings.share },
    use: { ...s.settings.use },
    general: { ...s.settings.general },
    wallet: { address: s.address },
    connections: connectionsOf(s),
  };
}

function connectionsOf(s) {
  return { codex: { ...s.connections.codex }, claude: { ...s.connections.claude } };
}

// ------------------------------------------------------------------- http

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "That request is too large."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        const v = JSON.parse(raw);
        resolve(v && typeof v === "object" ? v : {});
      } catch {
        reject(new HttpError(400, "Send a JSON body."));
      }
    });
    req.on("error", reject);
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function toolOf(body) {
  if (body.tool !== "codex" && body.tool !== "claude") throw new HttpError(400, "Choose Codex or Claude Code.");
  return body.tool;
}

function applySettings(s, patch) {
  const next = JSON.parse(JSON.stringify(s.settings));
  if (patch.share) {
    if (patch.share.mode !== undefined) {
      if (!["idle", "always"].includes(patch.share.mode)) throw new HttpError(400, "Choose Only when idle or Always.");
      next.share.mode = patch.share.mode;
    }
    if (patch.share.pluggedInOnly !== undefined) next.share.pluggedInOnly = !!patch.share.pluggedInOnly;
  }
  if (patch.use && patch.use.dailyLimitKai !== undefined) {
    if (!LIMIT_CHOICES.includes(patch.use.dailyLimitKai)) throw new HttpError(400, "Choose 5, 10 or 25 KAI, or no limit.");
    next.use.dailyLimitKai = patch.use.dailyLimitKai;
  }
  if (patch.general && patch.general.openAtLogin !== undefined) next.general.openAtLogin = !!patch.general.openAtLogin;
  s.settings = next;
}

async function handleApi(req, res, url, store) {
  const s = store.state;
  advance(s);
  const route = `${req.method} ${url.pathname.slice("/core/router".length)}`;
  const body = req.method === "POST" ? await readJson(req) : {};

  switch (route) {
    case "GET /status": {
      const scenario = url.searchParams.get("scenario");
      if (scenario) store.reset(scenario);
      return sendJson(res, 200, { ok: true, ...computeStatus(store.state) });
    }
    case "POST /share":
    case "POST /use": {
      if (typeof body.enabled !== "boolean") throw new HttpError(400, "Send enabled: true or false.");
      await delay(250);
      if (s.failToggles) throw new HttpError(500, "Couldn’t change that right now. Try again.");
      const kind = route.endsWith("share") ? "share" : "use";
      s[kind] = body.enabled;
      if (kind === "share" && body.enabled && s.scenario === "preparing" && s.preparingPct === null && s.earnedKai === 0) {
        s.preparingPct = 0;
      }
      s.lastTick = Date.now();
      return sendJson(res, 200, { ok: true, ...computeStatus(s) });
    }
    case "GET /activity": {
      const items = s.items.slice().sort((a, b) => b.at - a.at);
      return sendJson(res, 200, { ok: true, today: { earnedKai: s.earnedKai, spentKai: s.spentKai }, items });
    }
    case "GET /settings":
      return sendJson(res, 200, { ok: true, ...settingsOf(s) });
    case "POST /settings":
      applySettings(s, body);
      return sendJson(res, 200, { ok: true, ...settingsOf(s) });
    case "GET /connections":
      return sendJson(res, 200, { ok: true, ...connectionsOf(s) });
    case "POST /connect": {
      const tool = toolOf(body);
      await delay(600);
      if (!s.connections[tool].found) throw new HttpError(400, `${tool === "codex" ? "Codex" : "Claude Code"} isn’t installed on this Mac.`);
      s.connections[tool] = { found: true, connected: true, method: "cli" };
      return sendJson(res, 200, { ok: true, ...connectionsOf(s) });
    }
    case "POST /disconnect": {
      const tool = toolOf(body);
      await delay(300);
      s.connections[tool] = { ...s.connections[tool], connected: false, method: null };
      return sendJson(res, 200, { ok: true, ...connectionsOf(s) });
    }
    case "POST /onboarding/complete":
      s.onboarded = true;
      if (!s.address) s.address = "1Rt5Wq8nKd2sYv6LcX9hBz3pMa7JeU4g8wN";
      if (s.balanceKai === null) s.balanceKai = 0;
      s.share = true;
      s.use = true;
      s.idle = false;
      return sendJson(res, 200, { ok: true, ...computeStatus(s) });
    default:
      throw new HttpError(404, "Not found");
  }
}

// Stand-in for router/preload.js so shell-only actions can be reviewed.
const DEV_SHELL = `"use strict";
(function () {
  function post(p, b) {
    return fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) })
      .then(function (r) { return r.json(); });
  }
  window.routerShell = {
    open: function (view) {
      var hash = "#" + (view || "main");
      if (/popover\\.html$/.test(location.pathname)) window.open("/index.html" + hash, "koinos-router-main");
      else location.hash = hash;
    },
    closePopover: function () { console.info("[dev shell] closePopover"); },
    quit: function () { console.info("[dev shell] quit"); },
    popoverHeight: function (px) { console.info("[dev shell] popoverHeight", px); },
    backupWallet: function () { return post("/__dev/backup"); },
    restoreWallet: function (wif) { return post("/__dev/restore", { wif: wif }); }
  };
})();
`;

// Shows the 600x540 window and the 300px popover the way they sit on a Mac,
// instead of stretched across a browser tab.
const DEV_FRAME = `html { background: #e9eff8; min-height: 100%; }
body.window {
  width: 600px; height: 540px; margin: 40px auto; border-radius: 14px; overflow: hidden;
  transform: translateZ(0);
  box-shadow: 0 0 0 0.5px rgba(20,40,78,0.14), 0 1px 2px rgba(20,40,78,0.06), 0 24px 60px -18px rgba(20,40,78,0.28);
}
html.popover-page { background: linear-gradient(180deg, #d7e2f2 0%, #e6edf7 100%); min-height: 100%; }
html.popover-page body.popover { width: 300px; margin: 36px auto; overflow: visible; }
html.popover-page .panel { box-shadow: 0 0 0 0.5px rgba(20,40,78,0.16), 0 18px 48px -8px rgba(20,40,78,0.30); }
`;

async function handleDev(req, res, url, store) {
  const s = store.state;
  if (req.method === "GET" && url.pathname === "/__dev/shell.js") {
    res.writeHead(200, { "content-type": MIME[".js"], "cache-control": "no-store" });
    return res.end(DEV_SHELL);
  }
  if (req.method === "GET" && url.pathname === "/__dev/frame.css") {
    res.writeHead(200, { "content-type": MIME[".css"], "cache-control": "no-store" });
    return res.end(DEV_FRAME);
  }
  if (url.pathname === "/__dev/scenario") {
    store.reset(url.searchParams.get("name") || "earning");
    return sendJson(res, 200, { ok: true, scenario: store.state.scenario });
  }
  if (req.method === "POST" && url.pathname === "/__dev/backup") {
    await delay(200);
    if (!s.address) return sendJson(res, 200, { ok: false, error: "There’s no wallet to back up yet." });
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/__dev/restore") {
    const body = await readJson(req);
    await delay(500);
    const wif = String(body.wif || "").trim();
    if (!/^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(wif)) {
      return sendJson(res, 200, { ok: false, error: "That doesn’t look like a recovery key. Check it and try again." });
    }
    s.address = "1Kq7Hn3pXwS8dVfT2rLbG9yMc4ZuE6f3cQ";
    s.balanceKai = 42.8;
    s.outOfKai = false;
    return sendJson(res, 200, { ok: true, address: s.address });
  }
  throw new HttpError(404, "Not found");
}

function injectDev(html, url) {
  const tags = [];
  if (url.searchParams.get("frame") !== "0") tags.push('<link rel="stylesheet" href="/__dev/frame.css">');
  if (url.searchParams.get("shell") !== "0") tags.push('<script src="/__dev/shell.js"></script>');
  return tags.length ? html.replace("</head>", `${tags.join("\n")}\n</head>`) : html;
}

function serveStatic(req, res, url, store) {
  if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.normalize(path.join(UI_DIR, rel));
  if (!file.startsWith(UI_DIR + path.sep) || path.basename(file) === "dev-mock.js") throw new HttpError(404, "Not found");

  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    throw new HttpError(404, "Not found");
  }
  const ext = path.extname(file);
  if (ext === ".html") {
    const scenario = url.searchParams.get("scenario");
    if (scenario) store.reset(scenario);
    if (url.searchParams.has("fail")) store.state.failToggles = url.searchParams.get("fail") === "toggles";
    data = Buffer.from(injectDev(data.toString("utf8"), url));
  }
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "content-length": data.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : data);
}

function createStore(scenario) {
  const store = {
    state: scenarioState(scenario),
    reset(name) { store.state = scenarioState(name); },
  };
  return store;
}

function start(port = 0, { scenario = process.env.KOINOS_MOCK_SCENARIO || "earning", host = "127.0.0.1" } = {}) {
  const store = createStore(scenario);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}`);
    try {
      if (url.pathname.startsWith("/core/router/")) return await handleApi(req, res, url, store);
      if (url.pathname.startsWith("/__dev/")) return await handleDev(req, res, url, store);
      return serveStatic(req, res, url, store);
    } catch (err) {
      const known = err instanceof HttpError;
      if (!res.headersSent) sendJson(res, known ? err.status : 500, { ok: false, error: known ? err.message : "Something went wrong." });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        server,
        store,
        port: actual,
        url: `http://${host}:${actual}/`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

module.exports = { start, computeStatus, scenarioState, SCENARIOS };

if (require.main === module) {
  const port = Number(process.argv[2] || process.env.PORT || DEFAULT_PORT);
  start(port).then(({ url, store }) => {
    console.log(`Koinos Router UI mock (scenario: ${store.state.scenario})`);
    console.log(`  main window  ${url}`);
    console.log(`  popover      ${url}popover.html`);
    console.log(`  scenarios    ${url}?scenario=${SCENARIOS.join("|")}`);
    console.log(`  extras       &fail=toggles  &shell=0  &frame=0`);
  }, (err) => {
    console.error(`Could not start the mock: ${err.message}`);
    process.exit(1);
  });
}
