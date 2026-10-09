"use strict";

// Static checks over the Router renderer (router/ui) plus a smoke test of
// the design-review mock server. Nothing here starts Electron or Core.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const UI_DIR = path.join(__dirname, "..", "ui");
const PAGES = ["index.html", "popover.html"];
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'";

const read = (rel) => fs.readFileSync(path.join(UI_DIR, rel), "utf8");

// Text content of the first element with this id, tags stripped.
function textById(html, id) {
  const m = html.match(new RegExp(`<([a-z0-9]+)[^>]*\\sid="${id}"[^>]*>([\\s\\S]*?)</\\1>`, "i"));
  return m ? m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : null;
}

function localRef(ref) {
  if (/^(?:[a-z]+:|#|\/\/)/i.test(ref)) return null; // data:, http:, in-page anchors
  return ref.split("#")[0].split("?")[0] || null;
}

function htmlRefs(html) {
  const refs = [];
  for (const m of html.matchAll(/\s(?:src|href)="([^"]*)"/g)) refs.push(m[1]);
  return refs.map(localRef).filter(Boolean);
}

function cssRefs(css) {
  return [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => localRef(m[1])).filter(Boolean);
}

function openingTags(html) {
  return [...html.matchAll(/<([a-z][a-z0-9-]*)(\s[^>]*)?>/gi)].map((m) => ({ tag: m[1].toLowerCase(), attrs: m[2] || "" }));
}

test("every file referenced by the pages and the stylesheet exists", () => {
  const missing = [];
  for (const page of PAGES) {
    for (const ref of htmlRefs(read(page))) {
      if (!fs.existsSync(path.join(UI_DIR, ref))) missing.push(`${page} → ${ref}`);
    }
  }
  const css = read("styles.css");
  const cssFiles = cssRefs(css);
  assert.ok(cssFiles.some((f) => f.endsWith(".woff2")), "styles.css declares the bundled Manrope fonts");
  for (const ref of cssFiles) {
    if (!fs.existsSync(path.join(UI_DIR, ref))) missing.push(`styles.css → ${ref}`);
  }
  assert.deepStrictEqual(missing, []);
});

test("fonts are bundled locally with their licence and no network font is loaded", () => {
  assert.ok(fs.existsSync(path.join(UI_DIR, "fonts", "OFL.txt")));
  assert.match(read("fonts/OFL.txt"), /SIL OPEN FONT LICENSE/i);
  assert.match(read("fonts/OFL.txt"), /Manrope Project Authors/);
  const css = read("styles.css");
  const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);
  assert.deepStrictEqual(
    faces.map((f) => [f.match(/font-family:\s*"([^"]+)"/)?.[1], f.match(/font-weight:\s*(\d+)/)?.[1], f.match(/url\("([^"]+)"\)/)?.[1]]),
    [400, 500, 600, 700].map((w) => ["Manrope", String(w), `fonts/Manrope-${w}.woff2`]),
  );
  assert.match(css, /--font:\s*"Manrope",/);
  const fonts = fs.readdirSync(path.join(UI_DIR, "fonts")).filter((f) => !f.startsWith(".")).sort();
  assert.deepStrictEqual(fonts, ["Manrope-400.woff2", "Manrope-500.woff2", "Manrope-600.woff2", "Manrope-700.woff2", "OFL.txt"], "no unused font files ship");
  for (const page of PAGES) assert.doesNotMatch(read(page), /fonts\.googleapis|fonts\.gstatic|https?:\/\//);
  assert.doesNotMatch(css, /https?:\/\//);
});

test("each page carries the Content-Security-Policy meta tag", () => {
  for (const page of PAGES) {
    const m = read(page).match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
    assert.ok(m, `${page} has a CSP meta tag`);
    assert.strictEqual(m[1], CSP, `${page} CSP`);
  }
});

test("no inline scripts, inline handlers or inline styles", () => {
  for (const page of PAGES) {
    const html = read(page);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(m[1], /\ssrc="/, `${page}: every <script> has a src`);
      assert.strictEqual(m[2].trim(), "", `${page}: <script> has no inline body`);
    }
    for (const { tag, attrs } of openingTags(html)) {
      assert.doesNotMatch(attrs, /\son[a-z]+\s*=/i, `${page}: <${tag}> has no inline event handler`);
      assert.doesNotMatch(attrs, /\sstyle\s*=/i, `${page}: <${tag}> has no inline style`);
    }
    assert.doesNotMatch(html, /<style\b/i, `${page}: no <style> blocks`);
    assert.doesNotMatch(html, /javascript:/i, `${page}: no javascript: URLs`);
  }
});

test("scripts never set inline style attributes or reach window.routerShell unguarded", () => {
  for (const file of ["app.js", "popover.js", "common.js"]) {
    const src = read(file);
    assert.doesNotMatch(src, /\.style\s*[.=[]|setAttribute\(\s*["']style["']|innerHTML/, `${file}: DOM built without inline styles or innerHTML`);
  }
  // Only common.js touches the shell, and only through hasShell()/shell().
  for (const file of ["app.js", "popover.js"]) {
    assert.doesNotMatch(read(file), /routerShell/, `${file} goes through RouterUI.shell()`);
  }
  assert.match(read("common.js"), /const s = window\.routerShell;\s*return !!s && typeof s\[method\] === "function";/);
});

test("welcome and restore copy is exact", () => {
  const html = read("index.html");
  assert.strictEqual(textById(html, "welcome-title"), "Earn AI compute credits while your computer is idle.");
  const sub = html.match(/<p class="welcome-sub">([^<]*)<\/p>/);
  assert.ok(sub);
  assert.strictEqual(sub[1], "Use AI compute credits in your favorite harness.");
  assert.match(html, /<a class="cta" href="#connect">Get started<\/a>/);
  assert.match(html, /<a class="quiet-link" href="#restore">I already use Koinos Router on another Mac<\/a>/);

  assert.strictEqual(textById(html, "restore-title"), "Use your existing balance");
  assert.match(html, /<label class="field-label" for="restore-key">Recovery key<\/label>/);
  assert.match(html, /<textarea[^>]*\sid="restore-key"/);
  assert.strictEqual(textById(html, "restore-continue"), "Continue");
  assert.strictEqual(textById(html, "restore-back"), "Back");
});

test("main window has every view and a draggable title bar without fake traffic lights", () => {
  const html = read("index.html");
  for (const view of ["main", "activity", "settings", "welcome", "connect", "restore"]) {
    assert.match(html, new RegExp(`<section[^>]*\\sid="view-${view}"`), `#${view} view exists`);
  }
  assert.doesNotMatch(html, /#ff5f57|#febc2e|#28c840/i);
  const css = read("styles.css");
  const bar = css.match(/\.titlebar\s*{([^}]*)}/);
  assert.ok(bar);
  assert.match(bar[1], /height:\s*52px/);
  assert.match(bar[1], /-webkit-app-region:\s*drag/);
  const padLeft = bar[1].match(/padding:\s*0\s+\d+px\s+0\s+(\d+)px/);
  assert.ok(padLeft && Number(padLeft[1]) >= 80, "title bar leaves room for the traffic lights");
  assert.match(css, /\.titlebar a, \.titlebar button\s*{\s*-webkit-app-region:\s*no-drag/);
  assert.match(css, /:focus-visible\s*{[^}]*outline:/);
  assert.match(css, /filter:\s*grayscale\(1\) opacity\(\.45\)/);
});

test("every role=switch is a <button> with aria-checked", () => {
  let count = 0;
  for (const page of PAGES) {
    for (const { tag, attrs } of openingTags(read(page))) {
      if (!/\srole="switch"/.test(attrs)) continue;
      count++;
      assert.strictEqual(tag, "button", `${page}: role=switch on <${tag}>`);
      assert.match(attrs, /\stype="button"/);
      assert.match(attrs, /\saria-checked="(?:true|false)"/);
    }
  }
  assert.ok(count >= 6, `found ${count} switches`);
});

test("status lines are announced politely", () => {
  assert.match(read("index.html"), /id="headline"[^>]*aria-live="polite"/);
  const pop = read("popover.html");
  assert.match(pop, /id="pop-share-status"[^>]*aria-live="polite"/);
  assert.match(pop, /id="pop-use-status"[^>]*aria-live="polite"/);
});

test("activity amounts use a real minus sign and one decimal", () => {
  const vm = require("node:vm");
  const sandbox = { window: {}, document: {}, fetch: () => {} };
  vm.runInNewContext(read("common.js"), sandbox);
  const { signedKai, fmt1 } = sandbox.window.RouterUI;
  assert.strictEqual(signedKai(-0.2), "−0.2");
  assert.strictEqual(signedKai(1.64), "+1.6");
  assert.strictEqual(signedKai(null), "");
  assert.strictEqual(signedKai(undefined), "");
  assert.strictEqual(fmt1(-0.04), "0.0");
});

// ------------------------------------------------------------ dev mock

const mock = require("../ui/dev-mock.js");

async function withMock(fn, opts) {
  const srv = await mock.start(0, opts);
  try {
    return await fn(srv.url.replace(/\/$/, ""));
  } finally {
    await srv.close();
  }
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function assertStatusShape(st) {
  assert.strictEqual(st.ok, true);
  assert.strictEqual(typeof st.onboarded, "boolean");
  assert.ok(st.balance && (st.balance.kai === null || typeof st.balance.kai === "number"));
  assert.strictEqual(typeof st.balance.label, "string");
  assert.strictEqual(typeof st.today.earnedKai, "number");
  assert.strictEqual(typeof st.today.spentKai, "number");
  assert.ok(["Earning", "Ready", "Paused", "Out of KAI", "Getting ready"].includes(st.headline.label));
  assert.ok(["good", "idle", "warn", "busy"].includes(st.headline.tone));
  assert.ok(st.headline.pct === null || typeof st.headline.pct === "number");
  assert.strictEqual(typeof st.share.enabled, "boolean");
  assert.ok(["earning", "waiting", "preparing", "off", "error"].includes(st.share.state));
  assert.strictEqual(typeof st.share.detail, "string");
  assert.ok(st.share.pct === null || typeof st.share.pct === "number");
  assert.strictEqual(typeof st.use.enabled, "boolean");
  assert.ok(["on", "off", "out-of-kai", "limit", "no-tools"].includes(st.use.state));
  assert.strictEqual(typeof st.use.detail, "string");
  assert.strictEqual(typeof st.use.connected.codex, "boolean");
  assert.strictEqual(typeof st.use.connected.claude, "boolean");
  assert.strictEqual(typeof st.wallet.exists, "boolean");
  assert.ok(st.wallet.address === null || typeof st.wallet.address === "string");
  assert.ok(st.app.version === null || typeof st.app.version === "string");
  assert.strictEqual(typeof st.app.update.available, "boolean");
  if (st.app.update.available) {
    assert.match(st.app.update.version, /^\d+\.\d+\.\d+$/);
    assert.match(st.app.update.url, /^https:\/\/github\.com\/levineam\/koinos-router\/releases\//);
  } else {
    assert.deepStrictEqual(st.app.update, { available: false, version: null, url: null });
  }
  assert.ok([null, "notch", "menu-bar"].includes(st.app.hints.menuBar));
}

test("dev mock serves /core/router/status in the Status contract shape", async () => {
  await withMock(async (base) => {
    const { status, body } = await getJson(`${base}/core/router/status`);
    assert.strictEqual(status, 200);
    assertStatusShape(body);
    assert.strictEqual(body.headline.label, "Earning");
    assert.strictEqual(body.share.detail, "+6.4 KAI today");
    assert.strictEqual(body.balance.label, "42.8");
  });
});

test("dev mock scenarios produce the contract copy", async () => {
  const expect = {
    earning: ["Earning", "+6.4 KAI today", "Spend KAI on AI for Codex and Claude Code"],
    waiting: ["Ready", "Starts when you step away", "Spend KAI on AI for Codex and Claude Code"],
    paused: ["Paused", "Earn KAI when your Mac is idle", "Spend KAI on AI for Codex and Claude Code"],
    outofkai: ["Out of KAI", "Turn on to earn KAI", "Codex and Claude Code are using their usual models"],
    preparing: ["Getting ready", "Getting ready · 38%", "Spend KAI on AI for Codex and Claude Code"],
    notools: ["Earning", "+6.4 KAI today", "Connect Codex or Claude Code"],
  };
  await withMock(async (base) => {
    for (const [scenario, [headline, shareDetail, useDetail]] of Object.entries(expect)) {
      const { body } = await getJson(`${base}/core/router/status?scenario=${scenario}`);
      assertStatusShape(body);
      assert.strictEqual(body.headline.label, headline, scenario);
      assert.strictEqual(body.share.detail, shareDetail, scenario);
      assert.strictEqual(body.use.detail, useDetail, scenario);
    }
    const { body: first } = await getJson(`${base}/core/router/status?scenario=firstrun`);
    assert.strictEqual(first.onboarded, false);
    assert.strictEqual(first.balance.label, "—");
  });
});

test("dev mock toggles, settings, connections and onboarding really change state", async () => {
  await withMock(async (base) => {
    let r = await getJson(`${base}/core/router/share`, post({ enabled: false }));
    assertStatusShape(r.body);
    assert.strictEqual(r.body.share.enabled, false);
    r = await getJson(`${base}/core/router/use`, post({ enabled: false }));
    assert.strictEqual(r.body.headline.label, "Paused");
    r = await getJson(`${base}/core/router/status`);
    assert.strictEqual(r.body.use.enabled, false);

    r = await getJson(`${base}/core/router/share`, post({ enabled: "yes" }));
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.ok, false);
    assert.strictEqual(typeof r.body.error, "string");

    r = await getJson(`${base}/core/router/settings`, post({ use: { dailyLimitKai: 25 }, general: { openAtLogin: false } }));
    assert.strictEqual(r.body.use.dailyLimitKai, 25);
    assert.strictEqual(r.body.general.openAtLogin, false);
    assert.strictEqual(r.body.share.mode, "idle");
    r = await getJson(`${base}/core/router/settings`, post({ use: { dailyLimitKai: 7 } }));
    assert.strictEqual(r.status, 400);

    r = await getJson(`${base}/core/router/disconnect`, post({ tool: "codex" }));
    assert.strictEqual(r.body.codex.connected, false);
    r = await getJson(`${base}/core/router/connections`);
    assert.deepStrictEqual(r.body.codex, { found: true, connected: false, method: null });

    r = await getJson(`${base}/core/router/activity`);
    assert.ok(Array.isArray(r.body.items) && r.body.items.length > 0);
    for (const item of r.body.items) {
      assert.ok(["delegate", "share"].includes(item.kind));
      assert.strictEqual(typeof item.at, "number");
      assert.ok(item.kai === null || typeof item.kai === "number");
    }
  });

  await withMock(async (base) => {
    let r = await getJson(`${base}/core/router/status`);
    assert.strictEqual(r.body.onboarded, false);
    r = await getJson(`${base}/core/router/connect`, post({ tool: "claude" }));
    assert.strictEqual(r.body.claude.connected, true);
    r = await getJson(`${base}/core/router/onboarding/complete`, post({}));
    assertStatusShape(r.body);
    assert.strictEqual(r.body.onboarded, true);
  }, { scenario: "firstrun" });
});

test("dev mock honours share.mode: Always shares while the Mac is in use", async () => {
  await withMock(async (base) => {
    let r = await getJson(`${base}/core/router/status`);
    assert.strictEqual(r.body.share.state, "waiting");
    assert.strictEqual(r.body.share.detail, "Starts when you step away");

    r = await getJson(`${base}/core/router/settings`, post({ share: { mode: "always" } }));
    assert.strictEqual(r.body.share.mode, "always");
    assert.strictEqual(r.body.share.pluggedInOnly, true, "only the field sent changes");
    r = await getJson(`${base}/core/router/status`);
    assertStatusShape(r.body);
    assert.strictEqual(r.body.share.state, "earning");
    assert.strictEqual(r.body.headline.label, "Earning");
    r = await getJson(`${base}/core/router/settings`);
    assert.strictEqual(r.body.share.mode, "always");

    await getJson(`${base}/core/router/settings`, post({ share: { mode: "idle" } }));
    r = await getJson(`${base}/core/router/status`);
    assert.strictEqual(r.body.share.state, "waiting");

    r = await getJson(`${base}/core/router/settings`, post({ share: { mode: "sometimes" } }));
    assert.strictEqual(r.status, 400);
  }, { scenario: "waiting" });
});

test("dev mock serves the UI statically and refuses to serve itself", async () => {
  await withMock(async (base) => {
    let res = await fetch(`${base}/`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.match(await res.text(), /Earn AI compute credits while your computer is idle\./);
    res = await fetch(`${base}/fonts/Manrope-400.woff2`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "font/woff2");
    await res.arrayBuffer();
    res = await fetch(`${base}/dev-mock.js`);
    assert.strictEqual(res.status, 404);
    await res.arrayBuffer();
    res = await fetch(`${base}/..%2F..%2Fpackage.json`);
    assert.strictEqual(res.status, 404);
    await res.arrayBuffer();
  });
});

// ------------------------------------------------- renderer behaviour (vm)
//
// app.js and popover.js run against a minimal fake DOM, with fetch and the
// timers under the test's control.

function fakeElement(id) {
  const listeners = {};
  const attrs = {};
  const node = {
    id,
    dataset: {},
    hidden: false,
    disabled: false,
    textContent: "",
    value: "",
    title: "",
    options: [],
    children: [],
    rect: { top: 0, bottom: 0, height: 0 },
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    dispatch(type, extra = {}) {
      for (const fn of listeners[type] || []) fn({ target: node, preventDefault() {}, ...extra });
    },
    setAttribute(k, v) {
      attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in attrs ? attrs[k] : null;
    },
    removeAttribute(k) {
      delete attrs[k];
    },
    replaceChildren(...c) {
      node.children = c;
    },
    append(...c) {
      node.children.push(...c);
    },
    add(opt) {
      node.options.push(opt);
    },
    getBoundingClientRect: () => node.rect,
    querySelector: () => null,
    focus() {},
    requestSubmit() {},
  };
  return node;
}

function fakePage({ hash = "", routes, shellCalls = null }) {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id));
    return elements.get(id);
  };
  const timers = new Map();
  let nextTimer = 1;
  const requests = [];
  const winListeners = {};
  const sandbox = {
    console,
    JSON,
    Math,
    Number,
    String,
    Promise,
    Set,
    Map,
    Date,
    Error,
    Option: function Option(label, value) {
      this.label = label;
      this.value = value;
    },
    setTimeout(fn, ms) {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    location: {
      hash,
      replace(h) {
        sandbox.location.hash = h;
      },
    },
    addEventListener(type, fn) {
      (winListeners[type] ||= []).push(fn);
    },
    document: {
      hidden: false,
      documentElement: { scrollHeight: 330 },
      body: { dataset: {}, classList: { toggle() {} } },
      getElementById: byId,
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: (tag) => fakeElement(tag),
      createElementNS: (_ns, tag) => fakeElement(tag),
      createTextNode: (text) => ({ textContent: text }),
    },
    async fetch(url, init = {}) {
      const body = init.body ? JSON.parse(init.body) : undefined;
      const req = { url, method: init.method || "GET", body };
      requests.push(req);
      const answer = await routes(req);
      return { ok: true, status: 200, json: async () => ({ ok: true, ...answer }) };
    },
  };
  sandbox.window = sandbox;
  if (shellCalls) {
    sandbox.routerShell = new Proxy(
      {},
      { get: (_t, name) => (...args) => shellCalls.push([name, ...args]) },
    );
  }
  vm.createContext(sandbox);
  const load = (file) => vm.runInContext(read(file), sandbox, { filename: file });
  return {
    sandbox,
    byId,
    requests,
    load,
    // Run every timer that is due now (the 2 s poll among them).
    runTimers() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, t] of due) t.fn();
    },
    hashTo(h) {
      sandbox.location.hash = h;
      for (const fn of winListeners.hashchange || []) fn();
    },
  };
}

const vm = require("node:vm");
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

const STATUS = {
  onboarded: true,
  balance: { kai: 42.8, label: "42.8" },
  today: { earnedKai: 1, spentKai: 0.2 },
  headline: { label: "Ready", tone: "good", pct: null },
  share: { enabled: true, state: "waiting", detail: "Starts when you step away", pct: null },
  use: { enabled: true, state: "on", detail: "Spend KAI on AI for Codex and Claude Code", connected: { codex: true, claude: false } },
  wallet: { exists: true, address: "1Abcdefghijklmnop" },
};

test("the open Activity view picks up rows that leave today's totals unchanged", async () => {
  let items = [];
  const page = fakePage({
    hash: "#activity",
    routes: ({ url }) => (url === "/core/router/activity" ? { today: STATUS.today, items } : STATUS),
  });
  page.load("common.js");
  page.load("app.js");
  await settle();
  const activityLoads = () => page.requests.filter((r) => r.url === "/core/router/activity").length;
  const loadsBefore = activityLoads();
  assert.ok(loadsBefore >= 1);
  assert.strictEqual(page.byId("activity-list").children[0].textContent, "No activity yet.");

  // A failed delegation (kai 0) and a share session (kai null): totals stay put.
  const now = Date.now();
  items = [
    { id: "a", kind: "delegate", at: now, title: "Summarise logs", subtitle: "Codex · 1:32 PM", kai: 0, ok: false },
    { id: "b", kind: "share", at: now - 1000, title: "Shared compute · 3 jobs", subtitle: "This Mac · 1:00–1:30 PM", kai: null, ok: true },
  ];
  page.runTimers(); // the next status poll
  await settle();
  assert.ok(activityLoads() > loadsBefore, "a status poll reloads the open Activity list");
  const groups = page.byId("activity-list").children;
  const rows = groups.find((n) => n.children.length)?.children || [];
  assert.strictEqual(rows.length, 2, "both new rows are shown");
});

test("settings controls send only the field they change, so overlapping edits don't undo each other", async () => {
  const settings = {
    share: { mode: "idle", pluggedInOnly: true },
    use: { dailyLimitKai: 10 },
    general: { openAtLogin: true },
    wallet: { address: null },
    connections: null,
  };
  const pending = [];
  const page = fakePage({
    hash: "#settings",
    routes: (req) => {
      if (req.url !== "/core/router/settings") return STATUS;
      if (req.method === "GET") return settings;
      return new Promise((resolve) => pending.push({ req, resolve }));
    },
  });
  page.load("common.js");
  page.load("app.js");
  await settle();
  assert.strictEqual(page.byId("set-when").value, "idle");

  const when = page.byId("set-when");
  when.value = "always";
  when.dispatch("change");
  page.byId("set-plugged").dispatch("click"); // before the first save answers
  await settle();
  const bodies = pending.map((p) => p.req.body);
  assert.deepStrictEqual(bodies, [{ share: { mode: "always" } }, { share: { pluggedInOnly: false } }]);

  // The server applied both in order; the answers arrive newest first.
  const both = { ...settings, share: { mode: "always", pluggedInOnly: false } };
  const onlyFirst = { ...settings, share: { mode: "always", pluggedInOnly: true } };
  pending[1].resolve(both);
  await settle();
  pending[0].resolve(onlyFirst);
  await settle();
  assert.strictEqual(page.byId("set-when").value, "always");
  assert.strictEqual(page.byId("set-plugged").getAttribute("aria-checked"), "false", "a stale answer is not rendered over a newer one");
});

test("the popover reports its panel's height, so the window can shrink", async () => {
  const shellCalls = [];
  const page = fakePage({ routes: () => STATUS, shellCalls });
  page.byId("panel").rect = { top: 0, bottom: 277.6, height: 277.6 };
  page.sandbox.document.documentElement.scrollHeight = 330; // never below the window height
  page.load("common.js");
  page.load("popover.js");
  await settle();
  const heights = shellCalls.filter(([name]) => name === "popoverHeight").map(([, px]) => px);
  assert.ok(heights.length >= 1);
  assert.strictEqual(heights.at(-1), 278);
});

test("logo sizes and the Welcome link match the approved mockups", () => {
  const html = read("index.html");
  const css = read("styles.css");
  assert.match(html, /<img class="brand-logo"[^>]*width="20" height="20">/);
  assert.match(css, /\.brand-logo\s*{\s*width:\s*20px;\s*height:\s*20px;/);
  assert.match(css, /\n\.orb-logo\s*{\s*width:\s*72px;\s*height:\s*72px;/);
  assert.match(css, /\.orb-wrap--welcome \.orb-logo\s*{\s*width:\s*68px;\s*height:\s*68px;/);
  const orbs = [...html.matchAll(/<img class="orb-logo"[^>]*width="(\d+)" height="(\d+)">/g)].map((m) => `${m[1]}x${m[2]}`);
  assert.deepStrictEqual(orbs, ["72x72", "68x68"]);
  const link = css.match(/\.quiet-link\s*{([^}]*)}/);
  assert.ok(link);
  assert.match(link[1], /font-weight:\s*500/);
  assert.match(link[1], /color:\s*var\(--secondary\)/);
});

// ------------------------------------------------------------- Start now

const childTexts = (node) => node.children.map((c) => c.textContent);
const findButton = (node) => node.children.find((c) => c.textContent === "Start now");
const EARNING = {
  ...STATUS,
  headline: { label: "Earning", tone: "good", pct: null },
  share: { enabled: true, state: "earning", detail: "+1.0 KAI today", pct: null },
};

test("Start now switches When to Always and gives way once sharing runs", async () => {
  let status = STATUS; // waiting only because the Mac is in use
  const saves = [];
  const page = fakePage({
    routes: (req) => {
      if (req.url === "/core/router/settings" && req.method === "POST") return new Promise((resolve) => saves.push({ req, resolve }));
      return status;
    },
  });
  page.load("common.js");
  page.load("app.js");
  await settle();

  const detail = page.byId("share-detail");
  assert.deepStrictEqual(childTexts(detail), ["Starts when you step away · ", "Start now"]);
  const btn = findButton(detail);
  assert.strictEqual(btn.id, "button", "a real <button>");
  assert.strictEqual(btn.type, "button");

  // A poll with nothing new keeps the same button, so it keeps focus.
  page.runTimers();
  await settle();
  assert.strictEqual(findButton(detail), btn);

  let focused = null;
  page.byId("share-switch").focus = () => { focused = "share-switch"; };
  page.sandbox.document.activeElement = btn;
  btn.dispatch("click");
  await settle();
  assert.deepStrictEqual(saves.map((s) => s.req.body), [{ share: { mode: "always" } }]);
  assert.strictEqual(focused, "share-switch", "focus stays in the Share row when the button goes");
  assert.deepStrictEqual(childTexts(detail), ["Starting…"]);

  // The service acts on the new mode at the idle controller's next tick:
  // until the status moves on, the row says Starting… rather than re-offering.
  saves[0].resolve({ share: { mode: "always", pluggedInOnly: true }, use: { dailyLimitKai: 10 }, general: { openAtLogin: true } });
  await settle();
  page.runTimers();
  await settle();
  assert.deepStrictEqual(childTexts(detail), ["Starting…"]);

  status = EARNING;
  page.runTimers();
  await settle();
  assert.deepStrictEqual(childTexts(detail), ["+1.0 KAI today"]);
  assert.strictEqual(findButton(detail), undefined);
});

test("offers appear only for waits the person can lift", async () => {
  const cases = [
    [EARNING.share, ["+1.0 KAI today"]],
    [{ enabled: false, state: "off", detail: "Earn KAI when your Mac is idle", pct: null }, ["Earn KAI when your Mac is idle"]],
    [{ enabled: true, state: "waiting", detail: "Waiting for power", pct: null }, ["Waiting for power · ", "Share on battery"]],
    [{ enabled: true, state: "waiting", detail: "Cooling down", pct: null }, ["Cooling down"]],
    [{ enabled: true, state: "waiting", detail: "Low Power Mode is on", pct: null }, ["Low Power Mode is on"]],
    [{ enabled: true, state: "preparing", detail: "Getting ready · 38%", pct: 38 }, ["Getting ready · 38%"]],
  ];
  for (const [share, expected] of cases) {
    const page = fakePage({ routes: () => ({ ...STATUS, share }) });
    page.load("common.js");
    page.load("app.js");
    await settle();
    assert.deepStrictEqual(childTexts(page.byId("share-detail")), expected, share.detail);
  }
});

test("the popover offers Start now too, and puts it back if the save fails", async () => {
  let fail = true;
  const saves = [];
  const page = fakePage({
    routes: (req) => {
      if (req.url === "/core/router/settings") {
        saves.push(req.body);
        if (fail) throw new Error("offline");
        return { share: { mode: "always", pluggedInOnly: true } };
      }
      return STATUS;
    },
    shellCalls: [],
  });
  page.load("common.js");
  page.load("popover.js");
  await settle();

  const line = page.byId("pop-share-status");
  assert.deepStrictEqual(childTexts(line), ["Starts when you step away · ", "Start now"]);
  findButton(line).dispatch("click");
  await settle();
  assert.deepStrictEqual(saves, [{ share: { mode: "always" } }]);
  assert.deepStrictEqual(childTexts(line), ["Starts when you step away · ", "Start now"], "offered again after a failed save");
  assert.match(page.byId("pop-error").textContent, /isn’t responding/);

  fail = false;
  findButton(line).dispatch("click");
  await settle();
  assert.deepStrictEqual(childTexts(line), ["Starting…"]);
});

test("Share on battery turns off plugged-in-only, then Start now takes over while in use", async () => {
  let status = { ...STATUS, share: { enabled: true, state: "waiting", detail: "Waiting for power", pct: null } };
  const saves = [];
  const page = fakePage({
    routes: (req) => {
      if (req.url === "/core/router/settings" && req.method === "POST") {
        saves.push(req.body);
        return { share: { mode: "idle", pluggedInOnly: false }, use: { dailyLimitKai: 10 }, general: { openAtLogin: true } };
      }
      return status;
    },
  });
  page.load("common.js");
  page.load("app.js");
  await settle();

  const detail = page.byId("share-detail");
  const battery = detail.children.find((c) => c.textContent === "Share on battery");
  assert.ok(battery, "Share on battery offered while waiting for power");
  battery.dispatch("click");
  await settle();
  assert.deepStrictEqual(saves, [{ share: { pluggedInOnly: false } }]);
  assert.deepStrictEqual(childTexts(detail), ["Starting…"]);

  // On battery but in use: the wait is now the person, so Start now is offered.
  status = STATUS;
  page.runTimers();
  await settle();
  assert.deepStrictEqual(childTexts(detail), ["Starts when you step away · ", "Start now"]);
});

// ------------------------------------------- version, update notice, hint

const UPDATE_URL = "https://github.com/levineam/koinos-router/releases/tag/router-v0.1.1";
const withApp = (app) => ({
  ...STATUS,
  app: {
    version: "0.1.0",
    update: { available: false, version: null, url: null },
    hints: { menuBar: null },
    ...app,
  },
});

test("dev mock: the update scenario has a release link and the menu-bar hint, which can be dismissed", async () => {
  await withMock(async (base) => {
    let { body } = await getJson(`${base}/core/router/status?scenario=update`);
    assertStatusShape(body);
    assert.deepStrictEqual(body.app, {
      version: "0.1.0",
      update: { available: true, version: "0.1.1", url: UPDATE_URL },
      hints: { menuBar: "notch" },
    });
    await getJson(`${base}/__dev/hint`, post({ name: "menuBar" }));
    ({ body } = await getJson(`${base}/core/router/status`));
    assert.strictEqual(body.app.hints.menuBar, null);
    ({ body } = await getJson(`${base}/core/router/status?scenario=earning`));
    assert.deepStrictEqual(body.app.update, { available: false, version: null, url: null });
  });
});

test("Settings shows the version, and an update with a Download link to its release page", async () => {
  let status = withApp({});
  const page = fakePage({ hash: "#settings", routes: ({ url }) => (url === "/core/router/settings" ? {} : status) });
  page.load("common.js");
  page.load("app.js");
  await settle();
  assert.strictEqual(page.byId("app-version").textContent, "0.1.0");
  assert.strictEqual(page.byId("app-update").hidden, true);
  assert.strictEqual(page.byId("update-download").hidden, true);

  status = withApp({ update: { available: true, version: "0.1.1", url: UPDATE_URL } });
  page.runTimers();
  await settle();
  assert.strictEqual(page.byId("app-update").hidden, false);
  assert.strictEqual(page.byId("app-update").textContent, "· Update available: 0.1.1");
  assert.strictEqual(page.byId("update-download").hidden, false);
  assert.strictEqual(page.byId("update-download").href, UPDATE_URL);

  // A link anywhere else is never offered (the shell would refuse it anyway).
  status = withApp({ update: { available: true, version: "0.1.2", url: "https://evil.example/router.dmg" } });
  page.runTimers();
  await settle();
  assert.strictEqual(page.byId("update-download").hidden, true);
  assert.strictEqual(page.byId("app-update").hidden, true);

  // Run from the checkout there is no Router version.
  status = withApp({ version: null });
  page.runTimers();
  await settle();
  assert.strictEqual(page.byId("app-version").textContent, "Development build");

  const html = read("index.html");
  assert.match(html, /<span class="set-name">Version<\/span>/);
  assert.match(html, /<a class="btn-quiet btn-quiet--accent" id="update-download" href="#settings" target="_blank" rel="noopener noreferrer" hidden>Download<\/a>/);
});

test("the menu-bar hint shows under the footer until dismissed, and dismissing tells the shell", async () => {
  const shellCalls = [];
  const status = withApp({ hints: { menuBar: "notch" } });
  const page = fakePage({ routes: () => status, shellCalls });
  page.load("common.js");
  page.load("app.js");
  await settle();
  assert.strictEqual(page.byId("menubar-hint").hidden, false);
  assert.strictEqual(page.byId("menubar-hint-text").textContent, "Router lives in your menu bar. Can’t see it? It may be hidden behind the notch.");

  page.byId("menubar-hint-close").dispatch("click");
  await settle();
  assert.strictEqual(page.byId("menubar-hint").hidden, true);
  assert.deepStrictEqual(shellCalls.filter(([name]) => name === "dismissHint"), [["dismissHint", "menuBar"]]);
  // A poll that still carries the hint (it raced the dismissal) doesn't bring it back.
  page.runTimers();
  await settle();
  assert.strictEqual(page.byId("menubar-hint").hidden, true);

  // Can't tell whether there's a notch: the general wording.
  const other = fakePage({ routes: () => withApp({ hints: { menuBar: "menu-bar" } }), shellCalls: [] });
  other.load("common.js");
  other.load("app.js");
  await settle();
  assert.strictEqual(other.byId("menubar-hint-text").textContent, "Router lives in your menu bar, at the top of your screen.");
  // And none at all: hidden.
  const none = fakePage({ routes: () => withApp({}), shellCalls: [] });
  none.load("common.js");
  none.load("app.js");
  await settle();
  assert.strictEqual(none.byId("menubar-hint").hidden, true);

  // It sits under the footer, inside the main view, in the house style.
  const html = read("index.html");
  const main = /<section class="view view-main"[\s\S]*?<\/section>/.exec(html)[0];
  assert.ok(main.indexOf('class="footer"') < main.indexOf('id="menubar-hint"'));
  assert.match(main, /<button type="button" class="hint-close" id="menubar-hint-close" aria-label="Dismiss">/);
  const css = read("styles.css");
  assert.match(css, /\.hint-text {[^}]*font-size: 12\.5px;[^}]*color: var\(--ink-2\);/);
});

test("the popover shows Update available above Open Router, which opens Settings", async () => {
  const shellCalls = [];
  let status = withApp({});
  const page = fakePage({ routes: () => status, shellCalls });
  page.load("common.js");
  page.load("popover.js");
  await settle();
  assert.strictEqual(page.byId("pop-update").hidden, true);

  status = withApp({ update: { available: true, version: "0.1.1", url: UPDATE_URL } });
  page.runTimers();
  await settle();
  assert.strictEqual(page.byId("pop-update").hidden, false);
  page.byId("pop-update").dispatch("click");
  assert.deepStrictEqual(shellCalls.filter(([name]) => name === "open"), [["open", "settings"]]);

  const html = read("popover.html");
  const update = html.indexOf('id="pop-update"');
  assert.ok(update > 0 && update < html.indexOf('id="pop-open"'), "above Open Router");
  assert.match(html, /<a class="mi mi--update" id="pop-update" href="index\.html#settings" hidden>[\s\S]*?Update available<\/a>/);
});
