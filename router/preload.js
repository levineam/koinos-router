"use strict";

/*
 * window.routerShell: the only capabilities the Router pages get from the
 * shell. Everything else they do goes through the local HTTP API, exactly as
 * in a plain browser. Each method is one IPC round trip, and main.js checks
 * the sender of every one. The recovery key never comes back through here.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("routerShell", {
  open: (view) => ipcRenderer.invoke("router:open", view),
  closePopover: () => ipcRenderer.invoke("router:close-popover"),
  quit: () => ipcRenderer.invoke("router:quit"),
  popoverHeight: (px) => ipcRenderer.invoke("router:popover-height", px),
  backupWallet: () => ipcRenderer.invoke("router:backup-wallet"),
  restoreWallet: (wif) => ipcRenderer.invoke("router:restore-wallet", wif),
});
