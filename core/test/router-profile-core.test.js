"use strict";

/*
 * Core behaviour the Koinos Router profile depends on:
 *
 *  1. A network chat whose client hangs up must release the scheduler's
 *     consumer slot at once (the scheduler allows one in-flight /consume per
 *     wallet), not hold it for the 190 s upstream timeout.
 *  2. In the router profile, wallet / earn / network-config writes are not
 *     HTTP routes: any local process could otherwise swap or pre-seed the
 *     wallet, or repoint the scheduler, with no confirmation dialog.
 *  3. earn.invalidateEarnings() (and wallet swaps) win over a /balance read
 *     already in flight.
 *
 * Everything runs against a temp data dir and a 127.0.0.1 stub scheduler.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const { createCore } = require("../server");
const { WalletService } = require("../lib/wallet");

const PASSWORD = "correct horse battery";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 3000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A stub scheduler: /consume/* holds the request open; /balance is scripted. */
async function stubScheduler({ balance, pricing } = {}) {
  const s = {
    consumes: [], // { closed: boolean, stream: boolean }
    balanceHits: [], // addresses asked for
    server: null,
    url: null,
  };
  s.server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/consume/chat/completions") {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      const rec = { closed: false, stream: !!body.stream };
      s.consumes.push(rec);
      // The real scheduler frees the wallet's consumer slot on this event.
      res.once("close", () => (rec.closed = true));
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ delta: "partial", servedModel: "koinos-fast" })}\n\n`);
      }
      return; // never finishes: a slow provider
    }
    if (u.pathname === "/balance") {
      const address = u.searchParams.get("address");
      s.balanceHits.push(address);
      const reply = balance ? await balance(address, s.balanceHits.length) : { ok: true, kai: 0 };
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(reply));
    }
    if (u.pathname === "/pricing" && pricing) {
      const reply = await pricing();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(reply));
    }
    if (u.pathname === "/policy") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, revoked: [] }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  });
  await new Promise((r) => s.server.listen(0, "127.0.0.1", r));
  s.url = `http://127.0.0.1:${s.server.address().port}`;
  s.close = () => {
    s.server.closeAllConnections?.();
    return new Promise((r) => s.server.close(r));
  };
  return s;
}

async function bootRouterCore(t, { scheduler, profile = "router" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-router-core-"));
  const core = await createCore({
    dataDir: dir,
    port: 0,
    llamaBin: path.join(__dirname, "fixtures", "fake-llama-server"),
    profile,
    onEvent: () => {},
  });
  core.earn.configure({ schedulerUrl: scheduler.url });
  core.network.configure({ privacyMode: "network" });
  const base = `http://127.0.0.1:${await core.start()}`;
  t.after(async () => {
    await core.stop();
    await scheduler.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { core, base, dir };
}

// ------------------------------------------------- 1. client disconnects

for (const stream of [false, true]) {
  test(`network chat (stream:${stream}): a client hang-up aborts the upstream /consume`, async (t) => {
    const scheduler = await stubScheduler();
    const { core, base } = await bootRouterCore(t, { scheduler });
    core.earn.createWallet({ password: PASSWORD });

    const ac = new AbortController();
    const pending = fetch(`${base}/core/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "koinos-network", stream, messages: [{ role: "user", content: "hi" }] }),
      signal: ac.signal,
    }).then(async (r) => {
      // Streaming: read the first relayed frame so the gateway is mid-relay.
      if (stream) await r.body.getReader().read();
      return r;
    });
    await waitFor(() => scheduler.consumes.length === 1, 3000, "the /consume request");
    if (stream) await pending; // the relay has started
    assert.equal(scheduler.consumes[0].closed, false);

    // The delegate engine's job timeout aborts its loopback call like this.
    ac.abort();
    await pending.catch(() => {});
    await waitFor(() => scheduler.consumes[0].closed, 3000, "the upstream /consume to be aborted");

    // The gateway is still healthy afterwards.
    const health = await fetch(`${base}/core/health`);
    assert.equal(health.status, 200);
  });
}

test("network chat: a client gone before the upstream call buys nothing", async (t) => {
  // /pricing (read once per scheduler before the spend checks) is slow, so
  // the client hangs up while the gateway is still deciding.
  let pricingAsked = 0;
  const scheduler = await stubScheduler({
    pricing: async () => {
      pricingAsked += 1;
      await sleep(400);
      return { ok: true, models: { "koinos-fast": { usdPerMInputTokens: 0.1, usdPerMOutputTokens: 0.4, ctxTokens: 4096 } } };
    },
  });
  const { core, base } = await bootRouterCore(t, { scheduler });
  core.earn.createWallet({ password: PASSWORD });
  const ac = new AbortController();
  const pending = fetch(`${base}/core/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "koinos-network", messages: [{ role: "user", content: "hi" }] }),
    signal: ac.signal,
  }).catch(() => {});
  await waitFor(() => pricingAsked === 1, 3000, "the pricing read");
  ac.abort();
  await pending;
  await sleep(700); // pricing answers; the gateway would now sign and send
  assert.equal(scheduler.consumes.length, 0, "no /consume for a client that already left");
});

// ------------------------------------------ 2. wallet writes are not HTTP

const REFUSED = [
  ["/core/earn/config", { schedulerUrl: "http://127.0.0.1:1" }],
  ["/core/earn/wallet", { password: "attacker-pass-123" }],
  ["/core/earn/wallet/restore", null], // body filled in below (a real WIF)
  ["/core/earn/wallet/reveal", { password: PASSWORD }],
  ["/core/earn/unlock", { password: PASSWORD }],
  ["/core/earn/lock", {}],
  ["/core/earn/deposit", { amountKai: 1 }],
  ["/core/earn/start", {}],
  ["/core/earn/stop", {}],
  ["/core/earn/nudge", {}],
  ["/core/network/config", { privacyMode: "local-only" }],
];

async function attackerWif() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-attacker-"));
  try {
    const w = new WalletService(path.join(dir, "wallet"));
    const { wif, address } = w.create({ password: "attacker-pass-123" });
    return { wif, address };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("router profile: no wallet, earn or network-config write is reachable over HTTP", async (t) => {
  const scheduler = await stubScheduler();
  const { core, base } = await bootRouterCore(t, { scheduler });
  const attacker = await attackerWif();
  const post = (p, b) =>
    fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

  // Before onboarding: nobody may pre-seed a wallet Router would later adopt.
  const pre = await post("/core/earn/wallet", { password: "attacker-pass-123" });
  assert.equal(pre.status, 404);
  assert.equal((await pre.json()).wif, undefined);
  assert.equal(core.wallet.exists(), false);

  core.earn.createWallet({ password: PASSWORD });
  const mine = core.wallet.status().address;
  for (const [p, body] of REFUSED) {
    const r = await post(p, body || { wif: attacker.wif, password: "attacker-pass-123" });
    assert.equal(r.status, 404, `${p} must not be an HTTP route in the router profile`);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.equal(j.wif, undefined);
  }
  assert.equal(core.wallet.status().address, mine, "the wallet was not swapped");
  assert.equal(core.wallet.status().unlocked, true, "nor locked");
  assert.equal(core.network.status().schedulerUrl, scheduler.url, "the scheduler was not repointed");
  assert.equal(core.network.status().privacyMode, "network", "privacy was not changed");

  // Reads stay available (and carry no secret).
  const earn = await fetch(`${base}/core/earn`);
  assert.equal(earn.status, 200);
  assert.equal((await earn.json()).wallet.address, mine);
  assert.equal((await fetch(`${base}/core/network`)).status, 200);

  // In-process control (RouterService's path) still works.
  core.earn.restoreWallet({ wif: attacker.wif, password: PASSWORD });
  assert.equal(core.wallet.status().address, attacker.address);
});

test("full profile: the earn control plane is unchanged", async (t) => {
  const scheduler = await stubScheduler();
  const { core, base } = await bootRouterCore(t, { scheduler, profile: "full" });
  const r = await fetch(`${base}/core/earn/wallet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).wif);
  assert.equal(core.wallet.exists(), true);
  const c = await fetch(`${base}/core/network/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ privacyMode: "local-first" }),
  });
  assert.equal(c.status, 200);
  assert.equal(core.network.status().privacyMode, "local-first");
});

// -------------------------------- 3. invalidation beats an in-flight read

test("invalidateEarnings during an in-flight /balance read: nothing stale survives it", async (t) => {
  const scheduler = await stubScheduler({
    balance: async (_address, n) => {
      await sleep(300);
      return n === 1
        ? { ok: true, kai: 5, freeTokensRemaining: 1000 }
        : { ok: true, kai: 0, freeTokensRemaining: 0 };
    },
  });
  const { core } = await bootRouterCore(t, { scheduler });
  core.earn.createWallet({ password: PASSWORD });

  const inFlight = core.earn.status();
  await sleep(100);
  core.earn.invalidateEarnings(); // e.g. a spend was just refused (402)
  const first = await inFlight;
  // A status() that resolves after the invalidation reflects a read that
  // started after it — otherwise Router's Out-of-KAI flag clears at once.
  assert.equal(first.earnings.kai, 0);
  assert.equal(first.earnings.freeTokensRemaining, 0);

  const second = await core.earn.status();
  assert.equal(second.earnings.kai, 0);
  assert.equal(second.earnings.freeTokensRemaining, 0);
  assert.equal(scheduler.balanceHits.length, 2, "the fresh read is cached; the stale one never was");
});

test("a wallet swapped during an in-flight /balance read never shows the old wallet's balance", async (t) => {
  const balances = new Map();
  const scheduler = await stubScheduler({
    balance: async (address) => {
      await sleep(300);
      return { ok: true, kai: balances.get(address) ?? 0 };
    },
  });
  const { core } = await bootRouterCore(t, { scheduler });
  const a = core.earn.createWallet({ password: PASSWORD });
  const b = await attackerWif();
  balances.set(a.address, 7);
  balances.set(b.address, 2);

  // Warm the cache with A, then swap to B without any explicit invalidation
  // (the full app's restore path): the cached A balance must not be served.
  assert.equal((await core.earn.status()).earnings.kai, 7);
  core.earn.restoreWallet({ wif: b.wif, password: PASSWORD });
  assert.equal((await core.earn.status()).earnings.kai, 2);

  // Swap back mid-read: the read for B finishes after A is current again.
  core.earn.invalidateEarnings();
  const reading = core.earn.status(); // reads B…
  await sleep(100);
  core.earn.restoreWallet({ wif: a.wif, password: PASSWORD });
  const r = await reading;
  assert.equal(r.wallet.address, a.address, "status describes the current wallet");
  assert.equal(r.earnings.kai, 7, "the in-flight B read is not reported for A");
  assert.equal((await core.earn.status()).earnings.kai, 7, "nor cached for A");
});
