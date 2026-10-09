"use strict";

/*
 * Update notice. Router has no update feed and never downloads or installs
 * anything: it asks GitHub for the repo's latest release, and when that is a
 * newer Router ("router-vX.Y.Z") the UI says "Update available" with a link
 * to the release page, which opens in the browser.
 *
 *   - One unauthenticated GET of RELEASES_API, 5 s timeout. Nothing about the
 *     Mac or the wallet is sent.
 *   - The first check runs 30 s after boot; after that at most once per 24 h
 *     (a failed check counts too), measured on the wall clock so a Mac that
 *     slept through the day checks soon after it wakes.
 *   - Drafts, prereleases, other tags and anything malformed mean "no update".
 *     A failed check keeps the last answer. Nothing here ever throws.
 *   - The only URL it hands out is the release page of that tag, built from the
 *     tag, and isReleaseUrl() is what the shell's navigation guard allows.
 *
 * fetch, the clock and the timers are injected so router/test can drive it.
 */

const OWNER_REPO = "levineam/koinos-router";
const RELEASES_API = `https://api.github.com/repos/${OWNER_REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${OWNER_REPO}/releases`;
const TAG_RE = /^router-v(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const VERSION_RE = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 30_000;
const TICK_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 5000;
const NO_UPDATE = Object.freeze({ available: false, version: null, url: null });

/** { major, minor, patch, pre: string[] } for "1.2.3", "v1.2.3-beta.1", "1.2.3+build"; else null. */
function parseVersion(v) {
  const m = VERSION_RE.exec(String(v ?? "").trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
}

/** Semver precedence: <0, 0 or >0; null when either side isn't a version. */
function compareVersions(a, b) {
  const x = typeof a === "object" && a ? a : parseVersion(a);
  const y = typeof b === "object" && b ? b : parseVersion(b);
  if (!x || !y) return null;
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  // A release ranks above its own prereleases.
  if (!x.pre.length || !y.pre.length) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** "0.1.1" for "router-v0.1.1"; null for any other tag. */
function versionFromTag(tag) {
  const m = TAG_RE.exec(String(tag ?? ""));
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

function releasePageUrl(version) {
  return `${RELEASES_PAGE}/tag/router-v${version}`;
}

/**
 * true only for https://github.com/levineam/koinos-router/releases (or a page
 * under it), with no port, credentials or other host. Checked after URL
 * parsing, so "..", encoded dots and look-alike hosts can't get through.
 */
function isReleaseUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com" || u.port || u.username || u.password) return false;
  const base = `/${OWNER_REPO}/releases`;
  return u.pathname === base || u.pathname.startsWith(`${base}/`);
}

/** The update a GitHub "latest release" body describes, or NO_UPDATE. */
function updateFrom(release, currentVersion) {
  if (!release || typeof release !== "object" || release.draft === true || release.prerelease === true) return NO_UPDATE;
  const version = versionFromTag(release.tag_name);
  if (!version) return NO_UPDATE;
  const cmp = compareVersions(version, currentVersion);
  if (cmp === null || cmp <= 0) return NO_UPDATE;
  const url = releasePageUrl(version);
  return isReleaseUrl(url) ? { available: true, version, url } : NO_UPDATE;
}

function createUpdateCheck({
  currentVersion,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  intervalMs = CHECK_INTERVAL_MS,
  firstCheckMs = FIRST_CHECK_MS,
  tickMs = TICK_MS,
  timeoutMs = TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onChange = () => {},
  onEvent = () => {},
} = {}) {
  let result = NO_UPDATE;
  let lastAttemptAt = null;
  let inFlight = null;
  let timer = null;
  let running = false;

  const log = (type, message) => {
    try {
      onEvent({ type, message });
    } catch {
      /* logging never breaks the check */
    }
  };

  function due() {
    if (lastAttemptAt === null) return true;
    const elapsed = now() - lastAttemptAt;
    // A clock set backwards shouldn't silence the check until it catches up.
    return elapsed < 0 || elapsed >= intervalMs;
  }

  // Resolves to the parsed body, or throws. The race also covers a fetch
  // that ignores its abort signal.
  async function fetchLatest() {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let t;
    const timeout = new Promise((_, reject) => {
      t = setTimer(() => {
        controller?.abort();
        reject(new Error(`timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      t?.unref?.();
    });
    try {
      const request = (async () => {
        const res = await fetchImpl(RELEASES_API, {
          method: "GET",
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": `KoinosRouter/${currentVersion || "unknown"}`,
          },
          redirect: "follow",
          signal: controller?.signal,
        });
        if (!res || !res.ok) throw new Error(`GitHub answered ${res?.status ?? "nothing"}`);
        return res.json();
      })();
      request.catch(() => {}); // the timeout may win; never leave this unhandled
      return await Promise.race([request, timeout]);
    } finally {
      clearTimer(t);
    }
  }

  async function run() {
    lastAttemptAt = now();
    try {
      if (typeof fetchImpl !== "function") throw new Error("no fetch");
      const next = updateFrom(await fetchLatest(), currentVersion);
      const changed = JSON.stringify(next) !== JSON.stringify(result);
      result = next;
      if (changed) {
        log("router:update", next.available ? `update available: ${next.version}` : "up to date");
        try {
          onChange(current());
        } catch {
          /* a listener's error is not the check's */
        }
      }
    } catch (e) {
      log("router:update-check-failed", String(e?.message || e));
    }
    return current();
  }

  /** Throttled to once per interval unless force; never rejects. */
  function check({ force = false } = {}) {
    if (inFlight) return inFlight;
    if (!force && !due()) return Promise.resolve(current());
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function current() {
    return { ...result };
  }

  function schedule(ms) {
    if (!running) return;
    timer = setTimer(() => {
      timer = null;
      check().finally(() => schedule(tickMs));
    }, ms);
    timer?.unref?.();
  }

  return {
    current,
    check,
    start() {
      if (running) return;
      running = true;
      schedule(firstCheckMs);
    },
    stop() {
      running = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    get lastAttemptAt() {
      return lastAttemptAt;
    },
  };
}

module.exports = {
  createUpdateCheck,
  parseVersion,
  compareVersions,
  versionFromTag,
  releasePageUrl,
  isReleaseUrl,
  updateFrom,
  RELEASES_API,
  RELEASES_PAGE,
  CHECK_INTERVAL_MS,
  FIRST_CHECK_MS,
  TIMEOUT_MS,
  NO_UPDATE,
};
