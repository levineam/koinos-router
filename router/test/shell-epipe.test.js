"use strict";

/*
 * Field report: a packaged Router started from a script whose output pipe had
 * closed crashed on the first log line after onboarding ("Uncaught Exception:
 * Error: write EPIPE" from Core's console sink). Boot the real shell in smoke
 * mode with both output pipes already closed and require a clean exit.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

let electronBin = null;
try {
  electronBin = require("electron"); // the binary's path when required from Node
} catch {
  /* not installed */
}

test("a closed stdout/stderr pipe cannot crash the shell", { skip: !electronBin && "electron is not installed", timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-epipe-"));
  const child = spawn(electronBin, [path.join(__dirname, "..", "main.js"), "--smoke"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, KOINOS_ROUTER_DATA: dir, KAI_SCHEDULER_URL: "http://127.0.0.1:9", ELECTRON_ENABLE_LOGGING: "" },
  });
  // Nobody will ever read these again: every write the shell makes now fails.
  child.stdout.destroy();
  child.stderr.destroy();
  try {
    const code = await new Promise((resolve) => child.on("exit", (c, signal) => resolve(signal ? signal : c)));
    assert.strictEqual(code, 0, "smoke boot must exit 0 even with no one reading its output");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
