"use strict";

// The update notice (router/lib/update-check.js) with an injected fetch,
// clock and timers. Nothing here touches the network.

const test = require("node:test");
const assert = require("node:assert");

const {
  createUpdateCheck,
  parseVersion,
  compareVersions,
  versionFromTag,
  isReleaseUrl,
  updateFrom,
  RELEASES_API,
  CHECK_INTERVAL_MS,
  FIRST_CHECK_MS,
  TIMEOUT_MS,
} = require("../lib/update-check");

const DAY = 24 * 60 * 60 * 1000;
const release = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/levineam/koinos-router/releases/tag/${tag}`, ...extra });
const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

/** A fetch that answers from a queue and records every call. */
function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (typeof next === "function") return next(url, init);
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

/** Timers the test fires by hand. */
function fakeTimers() {
  let id = 0;
  const pending = new Map();
  return {
    setTimer: (fn, ms) => {
      const t = ++id;
      pending.set(t, { fn, ms });
      return t;
    },
    clearTimer: (t) => pending.delete(t),
    pending,
    fire(ms) {
      for (const [t, entry] of [...pending]) {
        if (entry.ms !== ms) continue;
        pending.delete(t);
        entry.fn();
      }
    },
  };
}

// ---------------------------------------------------------------- versions

test("versions compare by semver precedence", () => {
  assert.deepStrictEqual(parseVersion("0.1.0"), { major: 0, minor: 1, patch: 0, pre: [] });
  assert.deepStrictEqual(parseVersion("v1.2.3-beta.1+build.5"), { major: 1, minor: 2, patch: 3, pre: ["beta", "1"] });
  for (const bad of ["", "1.2", "1.2.3.4", "router-v1.2.3", "01.x.0", null, undefined, "1.2.3-"]) {
    assert.strictEqual(parseVersion(bad), null, String(bad));
  }

  const ordered = ["0.0.9", "0.1.0-alpha", "0.1.0-alpha.1", "0.1.0-alpha.beta", "0.1.0-beta", "0.1.0-beta.2", "0.1.0-beta.11", "0.1.0-rc.1", "0.1.0", "0.1.1", "0.2.0", "0.10.0", "1.0.0"];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      assert.strictEqual(compareVersions(ordered[i], ordered[j]), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
    }
  }
  // Numbers, not strings: 0.10.0 is newer than 0.9.0.
  assert.strictEqual(compareVersions("0.10.0", "0.9.0"), 1);
  assert.strictEqual(compareVersions("1.0.0+a", "1.0.0+b"), 0, "build metadata doesn't count");
  assert.strictEqual(compareVersions("1.0.0", "dev"), null);
});

test("only router-vX.Y.Z tags are Router releases", () => {
  assert.strictEqual(versionFromTag("router-v0.1.1"), "0.1.1");
  assert.strictEqual(versionFromTag("router-v1.20.300"), "1.20.300");
  for (const tag of ["v0.1.1", "router-0.1.1", "router-v0.1", "router-v0.1.1-beta.1", "router-v0.1.1 ", "Router-v0.1.1", "x-router-v0.1.1", null, 7]) {
    assert.strictEqual(versionFromTag(tag), null, String(tag));
  }
});

test("a release becomes an update only when it is newer, published and Router's", () => {
  const url = "https://github.com/levineam/koinos-router/releases/tag/router-v0.1.1";
  assert.deepStrictEqual(updateFrom(release("router-v0.1.1"), "0.1.0"), { available: true, version: "0.1.1", url });
  assert.deepStrictEqual(updateFrom(release("router-v0.1.0"), "0.1.0-rc.2"), {
    available: true,
    version: "0.1.0",
    url: "https://github.com/levineam/koinos-router/releases/tag/router-v0.1.0",
  });
  const none = { available: false, version: null, url: null };
  assert.deepStrictEqual(updateFrom(release("router-v0.1.0"), "0.1.0"), none, "same version");
  assert.deepStrictEqual(updateFrom(release("router-v0.0.9"), "0.1.0"), none, "older");
  assert.deepStrictEqual(updateFrom(release("router-v0.2.0", { draft: true }), "0.1.0"), none, "draft");
  assert.deepStrictEqual(updateFrom(release("router-v0.2.0", { prerelease: true }), "0.1.0"), none, "prerelease");
  assert.deepStrictEqual(updateFrom(release("v0.55.0"), "0.1.0"), none, "the full app's tag");
  assert.deepStrictEqual(updateFrom(release("router-v0.2.0"), "dev"), none, "no version to compare");
  assert.deepStrictEqual(updateFrom(null, "0.1.0"), none);
  assert.deepStrictEqual(updateFrom("router-v0.2.0", "0.1.0"), none);
  // The link is built from the tag, never taken from the response.
  const evil = updateFrom(release("router-v0.2.0", { html_url: "https://evil.example/download" }), "0.1.0");
  assert.strictEqual(evil.url, "https://github.com/levineam/koinos-router/releases/tag/router-v0.2.0");
});

// ---------------------------------------------------------------- allow-list

test("only Router's GitHub release pages are allowed out", () => {
  for (const ok of [
    "https://github.com/levineam/koinos-router/releases",
    "https://github.com/levineam/koinos-router/releases/",
    "https://github.com/levineam/koinos-router/releases/tag/router-v0.1.1",
    "https://github.com/levineam/koinos-router/releases/latest",
    "https://github.com/levineam/koinos-router/releases/download/router-v0.1.1/Koinos-Router-0.1.1-arm64.dmg",
    "https://GITHUB.com/levineam/koinos-router/releases/tag/router-v0.1.1",
  ]) {
    assert.strictEqual(isReleaseUrl(ok), true, ok);
  }
  for (const bad of [
    "http://github.com/levineam/koinos-router/releases/tag/router-v0.1.1",
    "https://github.com/levineam/koinos-router",
    "https://github.com/levineam/koinos-router/releasesX",
    "https://github.com/levineam/koinos-router/issues",
    "https://github.com/levineam/other/releases",
    "https://github.com/levineam/koinos-router/releases/../../evil/releases",
    "https://github.com/levineam/koinos-router/releases/%2e%2e/%2e%2e/evil",
    "https://github.com.evil.example/levineam/koinos-router/releases",
    "https://evil.example/https://github.com/levineam/koinos-router/releases",
    "https://user:pw@github.com/levineam/koinos-router/releases",
    "https://github.com:8443/levineam/koinos-router/releases",
    "https://api.github.com/repos/levineam/koinos-router/releases/latest",
    "javascript:alert(1)//https://github.com/levineam/koinos-router/releases",
    "file:///etc/passwd",
    "http://127.0.0.1:41110/",
    "",
    null,
    undefined,
  ]) {
    assert.strictEqual(isReleaseUrl(bad), false, String(bad));
  }
});

// ---------------------------------------------------------------- checking

test("a check is one anonymous GET of the latest release, and finds the update", async () => {
  const fetchImpl = fakeFetch([okResponse(release("router-v0.1.1"))]);
  const changes = [];
  const updates = createUpdateCheck({ currentVersion: "0.1.0", fetchImpl, onChange: (u) => changes.push(u) });
  assert.deepStrictEqual(updates.current(), { available: false, version: null, url: null });
  const out = await updates.check();
  assert.deepStrictEqual(out, { available: true, version: "0.1.1", url: "https://github.com/levineam/koinos-router/releases/tag/router-v0.1.1" });
  assert.deepStrictEqual(updates.current(), out);
  assert.deepStrictEqual(changes, [out]);

  assert.strictEqual(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.strictEqual(url, RELEASES_API);
  assert.strictEqual(RELEASES_API, "https://api.github.com/repos/levineam/koinos-router/releases/latest");
  assert.strictEqual(init.method, "GET");
  assert.ok(!init.body);
  const headerNames = Object.keys(init.headers).map((h) => h.toLowerCase());
  assert.ok(!headerNames.includes("authorization") && !headerNames.includes("cookie"), "no auth");
  assert.strictEqual(init.headers["user-agent"], "KoinosRouter/0.1.0");
  assert.ok(init.signal, "the request can be aborted");
});

test("checks are throttled to one per 24 h, failures included", async () => {
  let t = 1_000_000;
  const fetchImpl = fakeFetch([new Error("offline"), okResponse(release("router-v0.1.1"))]);
  const updates = createUpdateCheck({ currentVersion: "0.1.0", fetchImpl, now: () => t });
  assert.strictEqual(CHECK_INTERVAL_MS, DAY);

  await updates.check(); // fails
  assert.strictEqual(fetchImpl.calls.length, 1);
  t += DAY - 1;
  await updates.check();
  assert.strictEqual(fetchImpl.calls.length, 1, "a failed check also waits a day");
  t += 1;
  assert.strictEqual((await updates.check()).available, true);
  assert.strictEqual(fetchImpl.calls.length, 2);

  t += 60_000;
  await updates.check();
  await updates.check();
  assert.strictEqual(fetchImpl.calls.length, 2, "within the day: the cached answer");

  await updates.check({ force: true });
  assert.strictEqual(fetchImpl.calls.length, 3, "force ignores the throttle");

  // A clock set back doesn't silence the check until it catches up.
  t -= 10 * DAY;
  await updates.check();
  assert.strictEqual(fetchImpl.calls.length, 4);
});

test("concurrent checks share one request", async () => {
  let release_;
  const fetchImpl = fakeFetch([() => new Promise((r) => (release_ = r))]);
  const updates = createUpdateCheck({ currentVersion: "0.1.0", fetchImpl });
  const a = updates.check();
  const b = updates.check({ force: true });
  release_(okResponse(release("router-v0.1.1")));
  const [x, y] = await Promise.all([a, b]);
  assert.deepStrictEqual(x, y);
  assert.strictEqual(fetchImpl.calls.length, 1);
});

test("a failed or odd answer never throws and keeps the last good one", async () => {
  let t = 0;
  const found = okResponse(release("router-v0.1.1"));
  const fetchImpl = fakeFetch([found]);
  const events = [];
  const updates = createUpdateCheck({ currentVersion: "0.1.0", fetchImpl, now: () => t, onEvent: (e) => events.push(e) });
  await updates.check();
  const good = updates.current();
  assert.strictEqual(good.available, true);

  const failures = [
    new Error("ENOTFOUND api.github.com"),
    { ok: false, status: 403, json: async () => ({ message: "API rate limit exceeded" }) },
    { ok: false, status: 404, json: async () => ({ message: "Not Found" }) },
    { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } },
    null,
    () => { throw new TypeError("fetch failed"); },
  ];
  for (const answer of failures) {
    fetchImpl.calls.length = 0;
    const f = fakeFetch([answer]);
    const u = createUpdateCheck({ currentVersion: "0.1.0", fetchImpl: f, now: () => t });
    await assert.doesNotReject(u.check());
    assert.deepStrictEqual(u.current(), { available: false, version: null, url: null });
  }

  // The same instance: a failure after a success keeps the success.
  const flaky = fakeFetch([found, new Error("offline")]);
  const kept = createUpdateCheck({ currentVersion: "0.1.0", fetchImpl: flaky, now: () => t });
  await kept.check();
  t += DAY;
  await kept.check();
  assert.strictEqual(flaky.calls.length, 2);
  assert.deepStrictEqual(kept.current(), good);

  // An answer that says "nothing newer" clears it (e.g. the release was pulled).
  const pulled = fakeFetch([found, okResponse(release("router-v0.1.0"))]);
  const cleared = createUpdateCheck({ currentVersion: "0.1.0", fetchImpl: pulled, now: () => t });
  await cleared.check();
  t += DAY;
  await cleared.check();
  assert.strictEqual(cleared.current().available, false);

  // No fetch at all, and listeners that throw, are survived too.
  await assert.doesNotReject(createUpdateCheck({ currentVersion: "0.1.0", fetchImpl: null }).check());
  const loud = createUpdateCheck({
    currentVersion: "0.1.0",
    fetchImpl: fakeFetch([found]),
    onChange: () => { throw new Error("listener"); },
    onEvent: () => { throw new Error("logger"); },
  });
  await assert.doesNotReject(loud.check());
  assert.strictEqual(loud.current().available, true);
  assert.ok(events.some((e) => e.type === "router:update"));
});

test("a request that hangs gives up after 5 s, even if fetch ignores the abort", async () => {
  assert.strictEqual(TIMEOUT_MS, 5000);
  let aborted = false;
  const fetchImpl = fakeFetch([
    (_url, init) => {
      init.signal.addEventListener("abort", () => (aborted = true));
      return new Promise(() => {}); // never settles, never honours the signal
    },
  ]);
  const timers = fakeTimers();
  const events = [];
  const updates = createUpdateCheck({ currentVersion: "0.1.0", fetchImpl, ...timers, onEvent: (e) => events.push(e) });
  const done = updates.check();
  await new Promise((r) => setImmediate(r));
  assert.ok([...timers.pending.values()].some((e) => e.ms === 5000), "a 5 s timeout is armed");
  timers.fire(5000);
  assert.deepStrictEqual(await done, { available: false, version: null, url: null });
  assert.ok(aborted, "the request is aborted");
  assert.ok(events.some((e) => e.type === "router:update-check-failed" && /timed out/.test(e.message)));
  assert.strictEqual(timers.pending.size, 0, "nothing left armed");
});

test("start() checks 30 s after boot, then hourly ticks that check at most daily", async () => {
  let t = 0;
  const fetchImpl = fakeFetch([okResponse(release("router-v0.1.0"))]);
  const timers = fakeTimers();
  const updates = createUpdateCheck({ currentVersion: "0.1.0", fetchImpl, now: () => t, ...timers });
  assert.strictEqual(FIRST_CHECK_MS, 30_000);
  updates.start();
  updates.start(); // idempotent
  assert.deepStrictEqual([...timers.pending.values()].map((e) => e.ms), [30_000]);
  assert.strictEqual(fetchImpl.calls.length, 0, "nothing at boot itself");

  t += 30_000;
  timers.fire(30_000);
  await new Promise((r) => setImmediate(r));
  timers.fire(5000); // the request's timeout timer is cleared once it answers; nothing fires
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(fetchImpl.calls.length, 1);
  assert.deepStrictEqual([...timers.pending.values()].map((e) => e.ms), [60 * 60 * 1000], "next tick in an hour");

  for (let h = 1; h < 24; h++) {
    t += 60 * 60 * 1000;
    timers.fire(60 * 60 * 1000);
    await new Promise((r) => setImmediate(r));
  }
  assert.strictEqual(fetchImpl.calls.length, 1, "hourly ticks within the day don't ask");
  t += 60 * 60 * 1000;
  timers.fire(60 * 60 * 1000);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(fetchImpl.calls.length, 2, "a day later it asks again");

  updates.stop();
  assert.strictEqual(timers.pending.size, 0);
});
