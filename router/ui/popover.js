"use strict";

// Menu-bar popover: balance, today's numbers, both switches, Open and Quit.
(function () {
  const {
    fmt1, earnedText, shell, hasShell, setText, setSwitch, createPoller, createStatusClient, bindStatusToggle,
    createStartNow, startNowNodes,
  } = window.RouterUI;

  const $ = (id) => document.getElementById(id);

  let lastHeight = 0;
  let errorTimer = null;
  let lastStatus = null;
  let shareLineKey = "";

  const client = createStatusClient({ onStatus: render });
  const poller = createPoller(() => client.refresh().catch(() => {}), 2000);
  const startNow = createStartNow({
    client,
    onError: showError,
    onChange: () => { if (lastStatus) render(lastStatus); },
  });

  function showError(message) {
    setText($("pop-error"), message);
    clearTimeout(errorTimer);
    if (message) errorTimer = setTimeout(() => showError(""), 5000);
    reportHeight();
  }

  function connectedLine(connected) {
    const codex = !!connected?.codex;
    const claude = !!connected?.claude;
    if (codex && claude) return "Codex and Claude Code connected";
    if (codex) return "Codex connected";
    if (claude) return "Claude Code connected";
    return "Connected";
  }

  // The popover has room for a word, not a sentence, when things are normal;
  // anything that needs attention falls back to the row's full detail copy.
  function shareLine(share) {
    if (!share?.enabled) return "Off";
    return share.state === "earning" ? "Earning" : share.detail || "";
  }

  function useLine(use) {
    if (!use?.enabled) return "Off";
    return use.state === "on" ? connectedLine(use.connected) : use.detail || "";
  }

  // "Starts when you step away · Start now" fits the 300 px panel on one
  // line. Rebuilt only on change so a focused Start now keeps focus.
  function renderShareLine(share) {
    const node = $("pop-share-status");
    const now = startNow.stateFor(share);
    const text = shareLine(share);
    const key = `${text}|${now ? `${now.kind}:${now.label}` : ""}`;
    if (key === shareLineKey) return;
    shareLineKey = key;
    const nodes = startNowNodes(now, startNow, {
      prefix: `${text} · `,
      buttonClass: "row-link row-link--button",
      fallback: $("pop-share"),
    });
    node.replaceChildren(...(nodes || [document.createTextNode(text)]));
  }

  function render(st) {
    lastStatus = st;
    setText($("pop-balance"), st.balance?.label ?? "—");
    setText($("pop-earned"), `${earnedText(st.today?.earnedKai)} earned`);
    setText($("pop-spent"), `${fmt1(st.today?.spentKai || 0)} spent today`);

    if (!client.isPending("share")) setSwitch($("pop-share"), !!st.share?.enabled);
    if (!client.isPending("use")) setSwitch($("pop-use"), !!st.use?.enabled);

    renderShareLine(st.share);
    setText($("pop-use-status"), useLine(st.use));
    $("pop-share-status").classList.toggle("pop-sub--warn", st.share?.state === "error");
    $("pop-use-status").classList.toggle("pop-sub--warn", ["out-of-kai", "limit"].includes(st.use?.state));
    reportHeight();
  }

  // The shell sizes the frameless popover window to fit its content. Measure
  // the panel: the document is never shorter than the window, so its height
  // could only ever grow, leaving an invisible strip that swallows clicks.
  function reportHeight() {
    const height = Math.ceil($("panel").getBoundingClientRect().bottom);
    if (height === lastHeight) return;
    lastHeight = height;
    shell("popoverHeight", height);
  }

  function init() {
    bindStatusToggle($("pop-share"), "share", client, showError);
    bindStatusToggle($("pop-use"), "use", client, showError);

    $("pop-open").addEventListener("click", (e) => {
      if (!hasShell("open")) return; // plain browser: follow the link
      e.preventDefault();
      shell("open", "main");
    });
    $("pop-quit").addEventListener("click", () => shell("quit"));

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") shell("closePopover");
    });

    reportHeight();
    if (document.fonts?.ready) document.fonts.ready.then(reportHeight, () => {});
    poller.start();
  }

  init();
})();
