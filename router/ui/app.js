"use strict";

// Main window: hash-routed views (#main, #activity, #settings, #welcome,
// #connect, #restore) over the /core/router/* API.
(function () {
  const {
    api, errorText, fmt1, signedKai, earnedText, shortAddress, hasShell, shell,
    setText, setSwitch, el, svgIcon, createPoller, createStatusClient, bindStatusToggle,
    createStartNow, startNowNodes,
  } = window.RouterUI;

  const VIEWS = ["main", "activity", "settings", "welcome", "connect", "restore"];
  const ONBOARDING = new Set(["welcome", "connect", "restore"]);
  const RING_LENGTH = 2 * Math.PI * 88;
  const ICON_TERMINAL = "M5 7l5 5-5 5M13 17h6";
  const ICON_CODE = "M8 7l-5 5 5 5M16 7l5 5-5 5";
  const TOOL_NAMES = { codex: "Codex", claude: "Claude Code" };
  // The shell opens only these in the browser (main.js externalUrlAllowed).
  const RELEASES_URL = "https://github.com/levineam/koinos-router/releases";
  const HINT_COPY = {
    notch: "Router lives in your menu bar. Can’t see it? It may be hidden behind the notch.",
    "menu-bar": "Router lives in your menu bar, at the top of your screen.",
  };

  const $ = (id) => document.getElementById(id);

  let view = null;
  let checkedOnboarding = false;
  let lastStatus = null;
  let useDetailKey = "";
  let shareDetailKey = "";
  let activityJson = "";
  let activityLoading = false;
  let settings = null;
  let settingsSaves = 0;
  let hintDismissed = false;
  let appKey = "";
  const busyTools = new Set();

  const statusClient = createStatusClient({ onStatus: renderStatus });
  const poller = createPoller(() => statusClient.refresh().catch(onStatusError), 2000);
  const startNow = createStartNow({
    client: statusClient,
    onError: (message) => notify(message),
    onChange: () => { if (lastStatus) renderShare(lastStatus); },
  });

  // ---------------------------------------------------------------- notice

  let noticeTimer = null;
  function notify(message) {
    const node = $("notice");
    setText(node, message);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => setText(node, ""), 5000);
  }

  // ---------------------------------------------------------------- status

  function onStatusError() {
    if (lastStatus) return; // keep showing the last good state between blips
    renderHeadline({ label: "Starting up", tone: "idle", pct: null });
  }

  function renderStatus(st) {
    lastStatus = st;
    setText($("balance-value"), st.balance?.label ?? "—");

    // First run lands on #welcome (main.js also opens it there directly).
    if (!checkedOnboarding) {
      checkedOnboarding = true;
      if (st.onboarded === false && view === "main" && !location.hash) {
        location.replace("#welcome");
        return;
      }
    }

    renderHeadline(st.headline);
    renderShare(st);
    renderUse(st);
    renderApp(st.app);
    if (view === "activity") loadActivity();
  }

  // ------------------------------------------------- version, update, hint

  function isReleaseUrl(url) {
    return typeof url === "string" && (url === RELEASES_URL || url.startsWith(`${RELEASES_URL}/`));
  }

  function renderApp(app) {
    const update = app?.update?.available && isReleaseUrl(app.update.url) ? app.update : null;
    const hint = hintDismissed ? null : HINT_COPY[app?.hints?.menuBar] || null;
    // Rebuild only on change so a focused Download link keeps focus across polls.
    const key = JSON.stringify([app?.version || null, update?.version || null, update?.url || null, hint]);
    if (key === appKey) return;
    appKey = key;

    setText($("app-version"), app?.version || "Development build");
    const note = $("app-update");
    setText(note, update ? `· Update available: ${update.version}` : "");
    note.hidden = !update;
    const link = $("update-download");
    if (update) link.href = update.url;
    link.hidden = !update;

    setText($("menubar-hint-text"), hint || "");
    $("menubar-hint").hidden = !hint;
  }

  function bindHint() {
    $("menubar-hint-close").addEventListener("click", () => {
      hintDismissed = true;
      $("menubar-hint").hidden = true;
      appKey = "";
      Promise.resolve(shell("dismissHint", "menuBar")).catch(() => {});
    });
  }

  // Getting ready keeps the full-colour orb (under its progress ring) so a
  // first download reads as progress, not as waiting.
  function orbFor(label) {
    if (label === "Earning") return "earning";
    if (label === "Getting ready") return "preparing";
    if (label === "Paused" || label === "Out of KAI") return "paused";
    return "ready";
  }

  function renderHeadline(headline) {
    const orb = $("orb");
    const label = headline?.label || "";
    const pct = headline?.pct;
    const preparing = label === "Getting ready" && Number.isFinite(pct);
    orb.dataset.orb = orbFor(label);
    orb.dataset.preparing = preparing ? "true" : "false";
    if (preparing) {
      const clamped = Math.max(0, Math.min(100, pct));
      $("orb-ring-bar").setAttribute("stroke-dashoffset", String(RING_LENGTH * (1 - clamped / 100)));
    }
    $("headline").dataset.tone = headline?.tone || "idle";
    setText($("headline-text"), preparing ? `${label} · ${Math.round(pct)}%` : label);
  }

  function renderShare(st) {
    const share = st.share || {};
    if (!statusClient.isPending("share")) setSwitch($("share-switch"), !!share.enabled);
    const detail = $("share-detail");
    // Rebuild only on change so a focused "Start now" keeps focus across polls.
    const now = startNow.stateFor(share);
    const key = `${share.detail}|${now ? `${now.kind}:${now.label}` : ""}`;
    if (key !== shareDetailKey) {
      shareDetailKey = key;
      const nodes = startNowNodes(now, startNow, {
        prefix: `${share.detail} · `,
        buttonClass: "row-link row-link--button",
        fallback: $("share-switch"),
      });
      detail.replaceChildren(...(nodes || [document.createTextNode(share.detail || "")]));
    }
    const invite = !share.enabled && st.headline?.label === "Out of KAI";
    detail.classList.toggle("row-sub--accent", share.state === "earning" || invite);
    detail.classList.toggle("row-sub--warn", share.state === "error");
  }

  function renderUse(st) {
    const use = st.use || {};
    if (!statusClient.isPending("use")) setSwitch($("use-switch"), !!use.enabled);
    const detail = $("use-detail");
    // Rebuild only on change so a focused "Connect…" link keeps focus across polls.
    const key = `${use.state}|${use.detail}`;
    if (key !== useDetailKey) {
      useDetailKey = key;
      if (use.state === "no-tools") {
        const link = el("a", "row-link", use.detail || "");
        link.href = "#settings";
        detail.replaceChildren(link);
      } else {
        detail.replaceChildren(document.createTextNode(use.detail || ""));
      }
    }
    detail.classList.toggle("row-sub--warn", use.state === "limit");
    $("use-connected").hidden = use.state !== "on";
  }

  // -------------------------------------------------------------- activity

  function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  // Reloaded with every status poll while the view is open: failed, unpriced
  // and share rows change no total, so the totals can't tell us when to. The
  // list is a small local read, and it is only re-rendered when it changed.
  async function loadActivity() {
    if (activityLoading) return;
    activityLoading = true;
    try {
      const data = await api("/core/router/activity");
      const json = JSON.stringify(data);
      if (json !== activityJson && view === "activity") {
        activityJson = json;
        renderActivity(data);
      }
    } catch (err) {
      notify(errorText(err));
    } finally {
      activityLoading = false;
    }
  }

  function renderActivity(data) {
    const today = data.today || {};
    setText($("earned-today"), earnedText(today.earnedKai));
    setText($("spent-today"), fmt1(today.spentKai || 0));

    const items = Array.isArray(data.items) ? data.items.slice().sort((a, b) => b.at - a.at) : [];
    const list = $("activity-list");
    if (!items.length) {
      list.replaceChildren(el("p", "empty", "No activity yet."));
      return;
    }
    const cutoff = startOfToday();
    const groups = [
      ["Today", items.filter((i) => i.at >= cutoff)],
      ["Earlier", items.filter((i) => i.at < cutoff)],
    ];
    const nodes = [];
    for (const [label, rows] of groups) {
      if (!rows.length) continue;
      nodes.push(el("h2", "group-label", label));
      const ul = el("ul", "act-list");
      for (const item of rows) ul.append(activityRow(item));
      nodes.push(ul);
    }
    list.replaceChildren(...nodes);
  }

  function activityRow(item) {
    const row = el("li", "act-row");
    if (item.ok === false) row.classList.add("act-row--failed");

    const icon = el("span", "act-icon");
    icon.setAttribute("aria-hidden", "true");
    if (item.kind === "share") {
      icon.classList.add("act-icon--share");
      const img = el("img", "act-logo");
      img.src = "assets/logo-128.png";
      img.alt = "";
      icon.append(img);
    } else {
      icon.append(svgIcon(/^claude/i.test(item.subtitle || "") ? ICON_CODE : ICON_TERMINAL, 16));
    }

    const text = el("div", "act-text");
    const sub = item.ok === false ? `${item.subtitle || ""} · Failed` : item.subtitle || "";
    text.append(el("div", "act-title", item.title || ""), el("div", "act-sub", sub));
    row.append(icon, text);

    const amount = signedKai(item.kai);
    if (amount) {
      const amt = el("div", "act-amount", amount);
      if (Number(item.kai) > 0) amt.classList.add("act-amount--earn");
      row.append(amt);
    }
    return row;
  }

  // -------------------------------------------------------------- settings

  async function loadSettings() {
    try {
      renderSettings(await api("/core/router/settings"));
    } catch (err) {
      notify(errorText(err));
    }
  }

  function ensureOption(select, value, label) {
    if (![...select.options].some((o) => o.value === value)) select.add(new Option(label, value));
    select.value = value;
  }

  function renderSettings(s) {
    settings = s;
    ensureOption($("set-when"), s.share?.mode || "idle", s.share?.mode || "idle");
    setSwitch($("set-plugged"), !!s.share?.pluggedInOnly);
    const limit = s.use?.dailyLimitKai;
    ensureOption($("set-limit"), limit == null ? "none" : String(limit), `${limit} KAI`);
    setSwitch($("set-login"), !!s.general?.openAtLogin);

    const address = s.wallet?.address || null;
    const addr = $("wallet-address");
    setText(addr, address ? shortAddress(address) : "Not set up yet");
    if (address) addr.title = address; else addr.removeAttribute("title");
    $("wallet-backup").disabled = !address;

    if (s.connections) {
      connections = s.connections;
      renderSettingsConnections(s.connections);
    }
  }

  // Each control sends only its own field: a whole sub-object rebuilt from
  // the last response would carry stale values for the other fields when
  // two edits overlap. Only the newest save's answer is rendered; the server
  // applies writes in order, so it reflects every earlier one.
  async function saveSettings(patch, revert) {
    const seq = ++settingsSaves;
    try {
      const next = await api("/core/router/settings", patch);
      if (seq === settingsSaves) renderSettings(next);
    } catch (err) {
      revert();
      notify(errorText(err));
    }
  }

  function bindSettings() {
    $("set-when").addEventListener("change", (e) => {
      if (!settings) return;
      const prev = settings.share.mode;
      settings.share.mode = e.target.value;
      if (e.target.value === "idle") startNow.reset();
      saveSettings({ share: { mode: e.target.value } }, () => {
        e.target.value = prev;
        settings.share.mode = prev;
      });
    });
    $("set-limit").addEventListener("change", (e) => {
      if (!settings) return;
      const prev = settings.use.dailyLimitKai;
      const v = e.target.value === "none" ? null : Number(e.target.value);
      settings.use.dailyLimitKai = v;
      saveSettings({ use: { dailyLimitKai: v } }, () => {
        e.target.value = prev == null ? "none" : String(prev);
        settings.use.dailyLimitKai = prev;
      });
    });
    bindSettingSwitch($("set-plugged"), (on) => {
      if (on) startNow.reset(); // plugged-in-only is back: offer Share on battery again
      return { share: { pluggedInOnly: on } };
    });
    bindSettingSwitch($("set-login"), (on) => ({ general: { openAtLogin: on } }));

    for (const row of document.querySelectorAll("[data-conn]")) {
      const tool = row.dataset.conn;
      row.querySelector(".conn-btn").addEventListener("click", () => {
        const connected = !!settings?.connections?.[tool]?.connected;
        runConnection(tool, connected ? "disconnect" : "connect");
      });
    }

    $("wallet-backup").addEventListener("click", backupWallet);
  }

  function bindSettingSwitch(btn, patchFor) {
    btn.addEventListener("click", () => {
      if (!settings) return;
      const next = btn.getAttribute("aria-checked") !== "true";
      setSwitch(btn, next);
      saveSettings(patchFor(next), () => setSwitch(btn, !next));
    });
  }

  function renderSettingsConnections(conns) {
    for (const row of document.querySelectorAll("[data-conn]")) {
      const tool = row.dataset.conn;
      const info = conns[tool] || {};
      const busy = busyTools.has(tool);
      row.querySelector(".set-dot").classList.toggle("set-dot--on", !!info.connected);
      setText(row.querySelector(".conn-label"), info.connected ? "Connected" : info.found ? "Not connected" : "Not found on this Mac");
      const btn = row.querySelector(".conn-btn");
      const verb = info.connected ? "Disconnect" : "Connect";
      setText(btn, busy ? (info.connected ? "Disconnecting…" : "Connecting…") : verb);
      btn.setAttribute("aria-label", `${verb} ${TOOL_NAMES[tool]}`);
      btn.disabled = busy || (!info.connected && !info.found);
    }
  }

  async function backupWallet() {
    if (!hasShell("backupWallet")) {
      notify("Back up your wallet from the Router app on your Mac.");
      return;
    }
    const btn = $("wallet-backup");
    btn.disabled = true;
    try {
      const result = await shell("backupWallet");
      if (result && result.ok === false && result.error) notify(result.error);
    } catch (err) {
      notify(errorText(err));
    } finally {
      btn.disabled = !settings?.wallet?.address;
    }
  }

  // ----------------------------------------------------------- connections

  let connections = null;

  function renderConnections(conns) {
    connections = conns;
    if (settings) settings.connections = conns;
    renderSettingsConnections(conns);
    renderConnectView(conns);
  }

  async function loadConnections() {
    try {
      renderConnections(await api("/core/router/connections"));
    } catch (err) {
      showConnectError(errorText(err));
    }
  }

  async function runConnection(tool, action) {
    if (busyTools.has(tool)) return;
    busyTools.add(tool);
    showConnectError("");
    if (connections) renderConnections(connections);
    try {
      const conns = await api(`/core/router/${action}`, { tool });
      busyTools.delete(tool);
      renderConnections(conns);
    } catch (err) {
      busyTools.delete(tool);
      if (connections) renderConnections(connections);
      if (view === "connect") showConnectError(errorText(err));
      else notify(errorText(err));
    }
    // "Connect Codex or Claude Code" on the main view depends on this.
    statusClient.refresh().catch(() => {});
  }

  function renderConnectView(conns) {
    for (const row of document.querySelectorAll("#view-connect [data-tool]")) {
      const tool = row.dataset.tool;
      const info = conns[tool] || {};
      const busy = busyTools.has(tool);
      setText(row.querySelector(".tool-sub"), info.found || info.connected ? "Found on this Mac" : "Not found on this Mac");
      const btn = row.querySelector(".tool-btn");
      btn.hidden = !!info.connected;
      btn.disabled = busy || !info.found;
      setText(btn, busy ? "Connecting…" : "Connect");
      row.querySelector(".tool-done").hidden = !info.connected;
    }
  }

  function showConnectError(message) {
    const node = $("connect-error");
    setText(node, message);
    node.hidden = !message;
  }

  function bindConnect() {
    for (const row of document.querySelectorAll("#view-connect [data-tool]")) {
      row.querySelector(".tool-btn").addEventListener("click", () => runConnection(row.dataset.tool, "connect"));
    }
    const done = $("connect-done");
    done.addEventListener("click", async () => {
      done.disabled = true;
      showConnectError("");
      try {
        await statusClient.completeOnboarding();
        location.hash = "#main";
      } catch (err) {
        showConnectError(errorText(err));
      } finally {
        done.disabled = false;
      }
    });
  }

  // --------------------------------------------------------------- restore

  function showRestoreError(message) {
    const node = $("restore-error");
    setText(node, message);
    node.hidden = !message;
  }

  function clearRestore() {
    $("restore-key").value = "";
    showRestoreError("");
  }

  function bindRestore() {
    const form = $("restore-form");
    const key = $("restore-key");
    const btn = $("restore-continue");

    key.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    key.addEventListener("input", () => showRestoreError(""));
    $("restore-back").addEventListener("click", () => { location.hash = "#welcome"; });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      const value = key.value.trim();
      if (!value) return showRestoreError("Paste your recovery key.");
      if (!hasShell("restoreWallet")) return showRestoreError("Open the Router app on your Mac to use a recovery key.");
      btn.disabled = true;
      setText(btn, "Checking…");
      showRestoreError("");
      try {
        const result = await shell("restoreWallet", value);
        if (result && result.ok === false) throw new Error(result.error || "That recovery key didn’t work.");
        key.value = "";
        location.hash = "#connect";
      } catch (err) {
        showRestoreError(errorText(err));
      } finally {
        btn.disabled = false;
        setText(btn, "Continue");
      }
    });
  }

  // ---------------------------------------------------------------- router

  function route() {
    const name = location.hash.replace(/^#/, "") || "main";
    const next = VIEWS.includes(name) ? name : "main";
    if (next === view) return;
    const prev = view;
    view = next;

    for (const v of VIEWS) $(`view-${v}`).hidden = v !== next;
    document.body.dataset.view = next;
    document.body.classList.toggle("is-bare", ONBOARDING.has(next));
    if (prev === "restore") clearRestore();

    if (ONBOARDING.has(next)) poller.stop(); else poller.start();
    if (next === "activity") {
      activityJson = "";
      loadActivity();
    }
    if (next === "settings") loadSettings();
    if (next === "connect") loadConnections();

    // Move focus to the new view's heading so keyboard and VoiceOver users
    // land somewhere sensible after a hash change.
    if (prev !== null) {
      const heading = $(`view-${next}`).querySelector("[tabindex='-1']");
      if (heading) heading.focus({ preventScroll: true });
    }
  }

  function init() {
    bindStatusToggle($("share-switch"), "share", statusClient, notify);
    bindStatusToggle($("use-switch"), "use", statusClient, notify);
    bindSettings();
    bindConnect();
    bindRestore();
    bindHint();

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && (view === "activity" || view === "settings")) location.hash = "#main";
    });
    window.addEventListener("hashchange", route);
    route();
  }

  init();
})();
