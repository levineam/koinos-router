"use strict";

// Helpers shared by the main window (app.js) and the menu-bar popover
// (popover.js). Browser globals only: the renderer has no Node access.
(function () {
  const MINUS = "−";

  async function api(path, body) {
    const init = { method: "GET", cache: "no-store", credentials: "same-origin" };
    if (body !== undefined) {
      init.method = "POST";
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch {
      throw new Error("Router isn’t responding. Try again in a moment.");
    }
    let data = null;
    try { data = await res.json(); } catch { /* error pages may not be JSON */ }
    if (!res.ok || !data || data.ok === false) throw new Error(apiError(data, res.status));
    return data;
  }

  // Router routes answer { ok:false, error:"sentence" }; the gateway's own
  // guards answer { error:{ message } }. Show whichever sentence we got.
  function apiError(data, status) {
    if (data && typeof data.error === "string" && data.error) return data.error;
    if (data && data.error && typeof data.error.message === "string") return data.error.message;
    return `Something went wrong (${status}). Try again.`;
  }

  // Electron wraps IPC rejections as "Error invoking remote method '…': Error: msg".
  function errorText(err) {
    const msg = String((err && err.message) || err || "Something went wrong.");
    return msg.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^(\w*Error):\s*/, "");
  }

  function fmt1(n) {
    const v = Math.round(Number(n) * 10) / 10;
    if (!Number.isFinite(v)) return "0.0";
    return (v === 0 ? 0 : v).toFixed(1);
  }

  // Activity amounts: "+1.6", "−0.2" (real minus sign), "" when unpriced.
  function signedKai(kai) {
    if (kai === null || kai === undefined || !Number.isFinite(Number(kai))) return "";
    const n = Number(kai);
    if (n > 0) return `+${fmt1(n)}`;
    if (n < 0) return `${MINUS}${fmt1(-n)}`;
    return fmt1(0);
  }

  function earnedText(kai) {
    return Number(kai) > 0 ? `+${fmt1(kai)}` : fmt1(kai || 0);
  }

  function shortAddress(addr) {
    const s = String(addr || "");
    return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
  }

  // window.routerShell exists only inside the Electron shell (preload.js).
  // In a plain browser every shell action quietly becomes a no-op.
  function hasShell(method) {
    const s = window.routerShell;
    return !!s && typeof s[method] === "function";
  }

  function shell(method, ...args) {
    if (!hasShell(method)) return undefined;
    return window.routerShell[method](...args);
  }

  function setText(node, text) {
    const s = String(text ?? "");
    if (node.textContent !== s) node.textContent = s;
  }

  function setSwitch(btn, on) {
    btn.setAttribute("aria-checked", on ? "true" : "false");
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svgIcon(d, size, strokeWidth) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", String(strokeWidth || 2));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
  }

  // Runs task now and then every intervalMs, but only while the page is
  // visible: a hidden popover or minimised window should cost nothing.
  function createPoller(task, intervalMs) {
    let timer = null;
    let active = false;
    let running = false;

    // force: the first load runs even while hidden, so a window that is
    // created hidden (the popover, a main window shown later) is ready.
    async function tick(force) {
      timer = null;
      if (!active || running || (document.hidden && force !== true)) return;
      running = true;
      try { await task(); } catch { /* the task reports its own errors */ }
      running = false;
      if (active && !document.hidden && !timer) timer = setTimeout(tick, intervalMs);
    }

    function kick() {
      if (!active || running) return;
      clearTimeout(timer);
      tick();
    }

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { clearTimeout(timer); timer = null; } else kick();
    });

    return {
      start() {
        if (active) return kick();
        active = true;
        if (!running) tick(true);
      },
      stop() { active = false; clearTimeout(timer); timer = null; },
      kick,
    };
  }

  // Status reads and toggle writes share one client so a poll that started
  // before a toggle cannot land afterwards and flip the switch back.
  function createStatusClient({ onStatus }) {
    let epoch = 0;
    const pending = new Set();

    async function refresh() {
      const seen = epoch;
      const status = await api("/core/router/status");
      if (seen === epoch) onStatus(status);
      return status;
    }

    async function setToggle(kind, enabled) {
      pending.add(kind);
      epoch++;
      try {
        const status = await api(`/core/router/${kind}`, { enabled });
        pending.delete(kind);
        epoch++;
        onStatus(status);
        return status;
      } finally {
        if (pending.delete(kind)) epoch++;
      }
    }

    async function completeOnboarding() {
      epoch++;
      const status = await api("/core/router/onboarding/complete", {});
      epoch++;
      onStatus(status);
      return status;
    }

    return { refresh, setToggle, completeOnboarding, isPending: (kind) => pending.has(kind) };
  }

  // Optimistic switch: flip now, revert if the server says no.
  function bindStatusToggle(btn, kind, client, onError) {
    btn.addEventListener("click", async () => {
      if (client.isPending(kind)) return;
      const next = btn.getAttribute("aria-checked") !== "true";
      setSwitch(btn, next);
      try {
        await client.setToggle(kind, next);
      } catch (err) {
        setSwitch(btn, !next);
        onError(errorText(err));
        client.refresh().catch(() => {});
      }
    });
  }

  // One-click ways out of a Share wait the person can lift themselves:
  //   "Starts when you step away" → Start now (When becomes Always),
  //   "Waiting for power"         → Share on battery (Only when plugged in off).
  // Settings can switch either back. The shell re-runs the idle decision as
  // soon as a setting changes; until the status moves on, the row reads
  // "Starting…" rather than offering again. Offers chain: on battery while
  // in use, Share on battery leads to Start now.
  const STEP_AWAY = "Starts when you step away";
  const NEEDS_POWER = "Waiting for power";
  const OFFERS = {
    [STEP_AWAY]: { label: "Start now", patch: { share: { mode: "always" } } },
    [NEEDS_POWER]: { label: "Share on battery", patch: { share: { pluggedInOnly: false } } },
  };
  const START_GRACE_MS = 15000;

  function createStartNow({ client, onError, onChange }) {
    let sending = null; // the detail being acted on
    let sent = null; // { detail, at } after a successful save

    // { kind: "offer"|"starting", label, detail } or null for this share block.
    function stateFor(share) {
      const detail = share?.detail;
      const offer = share?.enabled && share.state === "waiting" ? OFFERS[detail] : null;
      if (!offer) {
        sent = null;
        return null;
      }
      if (sending === detail || (sent && sent.detail === detail && Date.now() - sent.at < START_GRACE_MS)) {
        return { kind: "starting", label: offer.label, detail };
      }
      if (sent && sent.detail !== detail) sent = null;
      return { kind: "offer", label: offer.label, detail };
    }

    async function start(detail) {
      const offer = OFFERS[detail];
      if (sending || !offer) return;
      sending = detail;
      onChange();
      try {
        await api("/core/router/settings", offer.patch);
        sent = { detail, at: Date.now() };
      } catch (err) {
        onError(errorText(err));
      } finally {
        sending = null;
      }
      onChange();
      client.refresh().catch(() => {});
    }

    // A setting was switched back by hand: offer again straight away.
    function reset() {
      sent = null;
    }

    return { stateFor, start, reset };
  }

  // The share line's children for an offer state; null when there is none.
  // A focused offer button that is replaced hands focus to fallback (the
  // Share switch), so keyboard and VoiceOver users stay in the row.
  function startNowNodes(state, startNow, { prefix, buttonClass, fallback }) {
    if (!state) return null;
    if (state.kind === "starting") return [document.createTextNode("Starting…")];
    const btn = el("button", buttonClass, state.label);
    btn.type = "button";
    btn.addEventListener("click", () => {
      if (document.activeElement === btn) fallback.focus();
      startNow.start(state.detail);
    });
    return prefix ? [document.createTextNode(prefix), btn] : [btn];
  }

  window.RouterUI = {
    api, errorText, fmt1, signedKai, earnedText, shortAddress, hasShell, shell,
    setText, setSwitch, el, svgIcon, createPoller, createStatusClient, bindStatusToggle,
    STEP_AWAY, NEEDS_POWER, createStartNow, startNowNodes,
  };
})();
