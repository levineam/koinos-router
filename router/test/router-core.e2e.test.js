"use strict";

// End to end: createRouterCore on a temp data dir against the in-repo
// scheduler fixture and the fake llama-server. This one Mac is both the
// consumer (delegations) and the only provider (Share compute), the same
// single-worker topology core/test/network.test.js uses. Nothing here touches
// the real home directory, the user's harness configs or koinosai.com.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const { createRouterCore } = require("../lib/router-core");
const { Scheduler } = require("../../server/scheduler");

const FAKE_LLAMA = path.join(__dirname, "..", "..", "core", "test", "fixtures", "fake-llama-server");
const PASSWORD = "correct horse battery";

/** Forwarding proxy in front of the scheduler that counts requests per path. */
function startCountingProxy(targetPort) {
  const counts = {};
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    counts[p] = (counts[p] || 0) + 1;
    const up = http.request(
      { host: "127.0.0.1", port: targetPort, path: req.url, method: req.method, headers: req.headers },
      (ur) => {
        res.writeHead(ur.statusCode, ur.headers);
        ur.pipe(res);
      }
    );
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on("close", () => up.destroy());
    req.pipe(up);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        counts,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(r);
          }),
      })
    )
  );
}

async function waitFor(fn, { timeoutMs = 20000, intervalMs = 100, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

test("Router core end to end: onboarding, share, use, MCP delegate, guards", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koinos-router-e2e-"));
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(path.join(dataDir, "models"), { recursive: true });
  // dev-tiny's weights, placed by hand exactly as network.test.js bootCore does.
  fs.writeFileSync(path.join(dataDir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true }); // Codex "found"; Claude Code absent

  let balanceSat = "4280000000"; // 42.8 KAI on chain
  const sched = new Scheduler({
    dataDir: path.join(dir, "sched"),
    jobModel: "dev-tiny",
    priceSources: [],
    settlement: { kaiBalance: async () => balanceSat },
    onEvent: () => {},
  });
  const schedPort = await sched.listen();
  const proxy = await startCountingProxy(schedPort);

  const execCalls = [];
  const rc = await createRouterCore({
    dataDir,
    port: 0,
    walletPassword: PASSWORD,
    llamaBin: FAKE_LLAMA,
    schedulerUrl: `http://127.0.0.1:${proxy.port}`,
    home,
    connectorsWhich: async () => null,
    connectorsExec: async (file, args) => {
      execCalls.push([file, args]);
      throw new Error("no harness CLI in tests");
    },
    otherAppEarning: async () => false,
    laptop: () => true,
    onEvent: () => {},
  });
  rc.core.settings.set("router.shareModel", "dev-tiny");
  await rc.start();
  const base = `http://127.0.0.1:${rc.port}`;
  const token = rc.core.settings.get("router.mcpToken");
  const mcpPath = `/mcp/${token}`;

  const get = async (p, headers = {}) => {
    const r = await fetch(base + p, { headers });
    return { status: r.status, body: await r.json().catch(() => null), type: r.headers.get("content-type") };
  };
  const post = async (p, body, headers = {}) => {
    const r = await fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body ?? {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const status = async () => (await get("/core/router/status")).body;

  let rpcId = 0;
  let sessionId = null;
  const rpc = async (method, params, { headers = {}, notify = false } = {}) => {
    const msg = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++rpcId, method, params };
    const r = await fetch(base + mcpPath, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        ...headers,
      },
      body: JSON.stringify(msg),
    });
    const text = await r.text();
    return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null };
  };
  const delegateCall = async (args) => {
    const r = await rpc("tools/call", { name: "delegate", arguments: args });
    assert.equal(r.status, 200);
    return r.body.result;
  };

  try {
    await t.test("first boot is Paused with nothing set up", async () => {
      const st = await status();
      assert.equal(st.ok, true);
      assert.equal(st.onboarded, false);
      assert.deepEqual(st.headline, { label: "Paused", tone: "idle", pct: null });
      assert.equal(st.share.state, "off");
      assert.equal(st.share.detail, "Earn KAI when your Mac is idle");
      assert.equal(st.use.state, "off");
      assert.equal(st.use.detail, "Spend KAI on AI for Codex and Claude Code");
      assert.deepEqual(st.wallet, { exists: false, address: null });
      assert.equal((await get("/core/network")).body.privacyMode, "local-only");
    });

    await t.test("serves the Router UI and 404s every OAuth discovery probe", async () => {
      const page = await fetch(base + "/");
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type"), /text\/html/);
      assert.match(await page.text(), /<html/i);
      const probes = [
        `/.well-known/oauth-protected-resource${mcpPath}`,
        `${mcpPath}/.well-known/oauth-protected-resource`,
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-authorization-server",
        `/.well-known/oauth-authorization-server${mcpPath}`,
        "/.well-known/openid-configuration",
        `/.well-known/openid-configuration${mcpPath}`,
        `${mcpPath}/.well-known/openid-configuration`,
      ];
      for (const p of probes) {
        const r = await fetch(base + p);
        assert.equal(r.status, 404, p);
        assert.doesNotMatch(r.headers.get("content-type") || "", /html/, p);
        await r.text();
      }
    });

    await t.test("onboarding creates the wallet and turns both switches on", async () => {
      const r = await post("/core/router/onboarding/complete", {});
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.onboarded, true);
      assert.equal(r.body.wallet.exists, true);
      assert.match(r.body.wallet.address, /^1/);
      assert.equal(r.body.share.enabled, true);
      assert.equal(r.body.use.enabled, true);
      assert.equal(rc.core.wallet.status().unlocked, true);
    });

    await t.test("share on: the worker runs and the Mac is Earning", async () => {
      const r = await post("/core/router/share", { enabled: true });
      assert.equal(r.status, 200);
      assert.equal(r.body.share.enabled, true);
      const st = await waitFor(async () => {
        const s = await status();
        return s.share.state === "earning" && s;
      }, { what: "share state earning" });
      assert.deepEqual(st.headline, { label: "Earning", tone: "good", pct: null });
      assert.match(st.share.detail, /^\+\d+\.\d KAI today$/);
      const earn = (await get("/core/earn")).body;
      assert.equal(earn.worker.running, true);
      assert.equal(earn.worker.backoff, false);
      assert.equal(rc.core.settings.get("router.shareModel"), "dev-tiny");
    });

    await t.test("use on: privacy goes to network; no tool connected yet", async () => {
      const r = await post("/core/router/use", { enabled: true });
      assert.equal(r.status, 200);
      assert.equal((await get("/core/network")).body.privacyMode, "network");
      assert.equal(r.body.use.state, "no-tools");
      assert.equal(r.body.use.detail, "Connect Codex or Claude Code");
      assert.deepEqual(r.body.use.connected, { codex: false, claude: false });
      const bad = await post("/core/router/use", { enabled: "yes" });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.ok, false);
    });

    await t.test("balance shows kai + pendingKai", async () => {
      const st = await waitFor(async () => {
        const s = await status();
        return s.balance.kai !== null && s;
      }, { what: "a balance" });
      assert.ok(st.balance.kai >= 42.8, `balance ${st.balance.kai}`);
      assert.equal(st.balance.label, (Math.round(st.balance.kai * 10) / 10).toFixed(1));
    });

    await t.test("connect Codex (config file in the fake home)", async () => {
      const before = (await get("/core/router/connections")).body;
      assert.equal(before.codex.found, true);
      assert.equal(before.codex.connected, false);
      assert.equal(before.claude.found, false);
      const r = await post("/core/router/connect", { tool: "codex" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.codex, { found: true, connected: true, method: "file" });
      const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
      assert.ok(toml.includes(rc.mcpUrl()), toml);
      const missing = await post("/core/router/connect", { tool: "claude" });
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error, "Claude Code isn't installed on this Mac.");
      const st = await status();
      assert.equal(st.use.state, "on");
      assert.equal(st.use.detail, "Spend KAI on AI for Codex and Claude Code");
      assert.deepEqual(st.use.connected, { codex: true, claude: false });
    });

    await t.test("MCP: initialize, tools/list, delegate a log file", async () => {
      const init = await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "codex-mcp-client", version: "0.144.5" },
      });
      assert.equal(init.status, 200);
      assert.equal(init.body.result.protocolVersion, "2025-06-18");
      assert.equal(init.body.result.serverInfo.name, "koinos");
      sessionId = init.headers.get("mcp-session-id");
      assert.match(sessionId, /^[0-9a-f]{32}$/);
      const note = await rpc("notifications/initialized", {}, { notify: true });
      assert.equal(note.status, 202);

      const list = await rpc("tools/list", {});
      const tools = list.body.result.tools;
      assert.deepEqual(tools.map((x) => x.name), ["delegate"]);
      assert.deepEqual(tools[0].inputSchema.required, ["task"]);
      assert.deepEqual(tools[0].inputSchema.properties.format.enum, ["text", "markdown", "json"]);
      assert.match(tools[0].description, /^Send a small, self-contained text task/);

      const log = path.join(dir, "build.log");
      fs.writeFileSync(log, "step 1 ok\nstep 2 FAILED: assertion in parser.test.js:42\nstep 3 skipped\n");
      const result = await delegateCall({ task: "Summarize the failures in this log.", files: [log] });
      assert.equal(result.isError, false, result.content[0].text);
      const text = result.content[0].text;
      assert.ok(text.startsWith('<untrusted_output source="koinos-network">\nHello from fake llama'), text);
      assert.match(text, /\n<\/untrusted_output>\n\n\[koinos · [^·]+ · [^·]+ KAI · 1 chunk\]$/);
    });

    await t.test("the ledger and Activity show the delegation from Codex", async () => {
      const entry = rc.ledger.list().find((e) => e.kind === "delegate");
      assert.equal(entry.harness, "codex");
      assert.equal(entry.ok, true);
      assert.equal(entry.task, "Summarize the failures in this log.");
      const act = (await get("/core/router/activity")).body;
      assert.equal(act.ok, true);
      const item = act.items.find((i) => i.kind === "delegate");
      assert.equal(item.title, "Summarize the failures in this log.");
      assert.match(item.subtitle, /^Codex · \d{1,2}:\d{2} (AM|PM)$/);
      assert.equal(item.ok, true);
      assert.equal(typeof act.today.spentKai, "number");
      assert.equal(typeof act.today.earnedKai, "number");
    });

    await t.test("idle gate: Mac in use → Ready and backoff; idle again → Earning", async () => {
      rc.service.setShareGate({ run: false, reason: "Starts when you step away", unload: true });
      let st = await status();
      assert.deepEqual(st.headline, { label: "Ready", tone: "good", pct: null });
      assert.equal(st.share.state, "waiting");
      assert.equal(st.share.detail, "Starts when you step away");
      assert.equal(rc.core.earn.backoff().on, true);
      assert.equal(rc.core.runtime.activeAlias, null, "laptop unload frees the model");

      // The serving stretch that just ended (it served our own delegation) is a share session.
      const act = (await get("/core/router/activity")).body;
      const share = act.items.find((i) => i.kind === "share");
      assert.ok(share, JSON.stringify(act.items));
      assert.match(share.title, /^Shared compute · \d+ jobs?$/);
      assert.match(share.subtitle, /^This Mac · /);

      rc.service.setShareGate({ run: false, reason: "Waiting for power", unload: false });
      st = await status();
      assert.equal(st.share.detail, "Waiting for power");

      rc.service.setShareGate({ run: true, reason: null, unload: false });
      st = await status();
      assert.equal(st.headline.label, "Earning");
      assert.equal(st.share.state, "earning");
      assert.equal(rc.core.earn.backoff().on, false);
    });

    await t.test("the chat lane answers only the delegate engine: no local caller spends KAI around the limit and the guard", async () => {
      assert.equal((await get("/core/network")).body.privacyMode, "network", "Use is on");
      const consumeBefore = proxy.counts["/consume/chat/completions"] || 0;
      const body = { model: "koinos-network", messages: [{ role: "user", content: "- POSTGRES_PASSWORD=Kp9vR2mXq7Lw" }], stream: false };
      for (const p of ["/v1/chat/completions", "/core/chat/completions"]) {
        const r = await post(p, body);
        assert.equal(r.status, 403, p);
        assert.equal(r.body.error.code, "router_chat_refused");
        const forged = await post(p, body, { "x-koinos-router-internal": "guess" });
        assert.equal(forged.status, 403, `${p} with a guessed header`);
      }
      const local = await post("/v1/chat/completions", { ...body, model: "dev-tiny" });
      assert.equal(local.status, 403, "a local model could overflow to the network too");
      assert.equal(proxy.counts["/consume/chat/completions"] || 0, consumeBefore, "nothing reached the scheduler");
    });

    await t.test("Router's own data folder never goes to a volunteer", async () => {
      const result = await delegateCall({ task: "Repeat the input verbatim.", files: [path.join(dataDir, "settings.json")] });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /^BLOCKED_PATH: Router never sends files from its own data folder/);
    });

    await t.test("a .env path is BLOCKED_PATH", async () => {
      const result = await delegateCall({ task: "Summarize this.", files: [path.join(dir, ".env")] });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /^BLOCKED_PATH: /);
    });

    await t.test("a file holding an AWS key is BLOCKED_SECRET and nothing is sent", async () => {
      const file = path.join(dir, "deploy-notes.txt");
      // Built in pieces so repository secret scanners don't flag this fake key.
      fs.writeFileSync(file, "deploy steps\naws_access_key_id = " + "AKIA" + "Q7XK2M9PLR4TB8WZ" + "\n");
      const consumeBefore = proxy.counts["/consume/chat/completions"] || 0;
      const pricingBefore = proxy.counts["/pricing"] || 0;
      const result = await delegateCall({ task: "Summarize this.", files: [file] });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /^BLOCKED_SECRET: /);
      assert.match(result.content[0].text, /deploy-notes\.txt:2/);
      assert.equal(proxy.counts["/consume/chat/completions"] || 0, consumeBefore, "no consume request");
      assert.equal(proxy.counts["/pricing"] || 0, pricingBefore, "no pricing request");
    });

    await t.test("daily limit reached → state limit", async () => {
      await post("/core/router/settings", { use: { dailyLimitKai: 5 } });
      rc.ledger.record({ kind: "delegate", harness: "other", task: "big one", kai: -6, usd: 0.6, ok: true });
      let st = await status();
      assert.equal(st.use.state, "limit");
      assert.equal(st.use.detail, "Daily limit reached");
      const blocked = await delegateCall({ task: "One more." , text: "hello" });
      assert.equal(blocked.isError, true);
      assert.match(blocked.content[0].text, /^DAILY_LIMIT: .*Do this task yourself instead\.$/);
      await post("/core/router/settings", { use: { dailyLimitKai: null } });
      st = await status();
      assert.equal(st.use.state, "on");
    });

    await t.test("out of KAI: the network refuses, status says so, and it clears", async () => {
      const address = rc.core.wallet.status().address;
      sched.freeUsed[address] = 25000; // free allowance spent
      sched.spentSat[address] = "100000000000000"; // and every receipt this wallet earned
      const result = await delegateCall({ task: "Classify these lines.", text: "a\nb\nc" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /^OUT_OF_KAI: .*Do this task yourself instead\.$/);
      let st = await status();
      assert.deepEqual(st.headline, { label: "Out of KAI", tone: "warn", pct: null });
      assert.equal(st.use.state, "out-of-kai");
      assert.equal(st.use.detail, "Codex and Claude Code are using their usual models");
      st = await status(); // a second fresh-enough read must not clear it on its own
      assert.equal(st.use.state, "out-of-kai");

      // A new epoch's free allowance (seen on a fresh balance read) ends it.
      sched.freeUsed[address] = 0;
      delete sched.spentSat[address];
      rc.core.earn.invalidateEarnings();
      st = await status();
      assert.equal(st.use.state, "on");
      assert.equal(st.headline.label, "Earning");
    });

    await t.test("MCP endpoint guards: wrong token 404, foreign Origin 403, GET 405", async () => {
      const wrong = await fetch(`${base}/mcp/${"0".repeat(64)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      assert.equal(wrong.status, 404);
      await wrong.text();
      const bare = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
      assert.equal(bare.status, 404);
      await bare.text();
      const foreign = await rpc("ping", {}, { headers: { origin: "http://evil.example" } });
      assert.equal(foreign.status, 403);
      const own = await rpc("ping", {}, { headers: { origin: base } });
      assert.equal(own.status, 200);
      const sse = await fetch(base + mcpPath, { headers: { accept: "text/event-stream" } });
      assert.equal(sse.status, 405);
      await sse.text();
      const bad = await fetch(base + mcpPath, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
      assert.equal((await bad.json()).error.code, -32700);
      const huge = await fetch(base + mcpPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping", params: { pad: "x".repeat(2 * 1024 * 1024) } }),
      });
      assert.equal(huge.status, 413);
      await huge.text();
    });

    await t.test("/core/router/* refuses a foreign Origin", async () => {
      const r = await get("/core/router/status", { origin: "http://evil.example" });
      assert.equal(r.status, 403);
      const w = await post("/core/router/share", { enabled: false }, { origin: "http://evil.example" });
      assert.equal(w.status, 403);
      assert.equal((await status()).share.enabled, true, "the refused write changed nothing");
    });

    await t.test("settings: laptop defaults and validation", async () => {
      const s = (await get("/core/router/settings")).body;
      assert.deepEqual(s.share, { mode: "idle", pluggedInOnly: true });
      assert.deepEqual(s.use, { dailyLimitKai: null });
      assert.deepEqual(s.general, { openAtLogin: true });
      assert.equal(s.wallet.address, rc.core.wallet.status().address);
      assert.equal(s.connections.codex.connected, true);
      const bad = await post("/core/router/settings", { use: { dailyLimitKai: 7 } });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /daily limit/i);
      const ok = await post("/core/router/settings", { share: { mode: "always" }, general: { openAtLogin: false } });
      assert.equal(ok.body.share.mode, "always");
      assert.equal(ok.body.general.openAtLogin, false);
      assert.equal((await get("/core/router/nope")).status, 404);
      assert.equal((await get("/core/router/share")).status, 405);
    });

    await t.test("both switches off → Paused and local-only", async () => {
      let r = await post("/core/router/share", { enabled: false });
      assert.equal(r.body.share.state, "off");
      assert.equal((await get("/core/earn")).body.worker.running, false);
      assert.equal(r.body.headline.label, "Ready");
      r = await post("/core/router/use", { enabled: false });
      assert.deepEqual(r.body.headline, { label: "Paused", tone: "idle", pct: null });
      assert.equal((await get("/core/network")).body.privacyMode, "local-only");
      const paused = await delegateCall({ task: "Anything." , text: "x" });
      assert.match(paused.content[0].text, /^PAUSED: /);
      const del = await fetch(base + mcpPath, { method: "DELETE", headers: { "mcp-session-id": sessionId } });
      assert.equal(del.status, 200);
      await del.text();
    });

    assert.deepEqual(execCalls, [], "no harness CLI was ever run");
  } finally {
    await rc.stop();
    await proxy.close();
    await sched.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
