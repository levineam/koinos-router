#!/usr/bin/env node
"use strict";

/*
 * Run the real Koinos Router app against a private, local stand-in for the
 * Koinos Network — so the whole loop (onboarding, sharing, delegation, the
 * tray and popover) can be tried without creating a live wallet, registering
 * with koinosai.com, or downloading a multi-gigabyte model.
 *
 *   npm run router:demo            reuse the demo profile from last time
 *   npm run router:demo -- --fresh start over (new wallet, first-run screens)
 *
 * What is fake: the scheduler (the in-repo fixture, server/scheduler.js) and
 * the model engine (core/test/fixtures/fake-llama-server, which answers every
 * prompt with "Hello from fake llama"). What is real: the Electron shell, Core,
 * the Router service, the MCP endpoint, the ledger, and the idle policy.
 *
 * Harness configs: "Connect" writes to a sandbox home inside the demo profile
 * (KOINOS_ROUTER_HARNESS_HOME), never to your real ~/.codex or ~/.claude.json.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const repo = path.join(__dirname, "..", "..");
const { Scheduler } = require(path.join(repo, "server", "scheduler"));

const profile = path.join(os.tmpdir(), "koinos-router-demo");
const fresh = process.argv.includes("--fresh");

async function main() {
  if (fresh) fs.rmSync(profile, { recursive: true, force: true });
  const coreDir = path.join(profile, "core");
  const harnessHome = path.join(profile, "harness-home");
  fs.mkdirSync(path.join(coreDir, "models"), { recursive: true });
  fs.mkdirSync(harnessHome, { recursive: true });
  // Detected as "Found on this Mac" without touching the real tools.
  fs.mkdirSync(path.join(harnessHome, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(harnessHome, ".claude"), { recursive: true });

  // The fixture network serves dev-tiny; pin sharing to it so nothing downloads.
  fs.writeFileSync(path.join(coreDir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const settingsFile = path.join(coreDir, "settings.json");
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")); } catch { /* first run */ }
  settings.router = { ...(settings.router || {}), shareModel: "dev-tiny" };
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

  const sched = new Scheduler({ dataDir: path.join(profile, "scheduler"), jobModel: "dev-tiny", onEvent: () => {} });
  const schedPort = await sched.listen(0, "127.0.0.1");
  console.log(`[demo] local scheduler on http://127.0.0.1:${schedPort}`);
  console.log(`[demo] profile ${profile}${fresh ? " (fresh)" : ""}`);

  const electron = require(path.join(repo, "node_modules", "electron"));
  const child = spawn(electron, [path.join(repo, "router", "main.js"), ...process.argv.slice(2).filter((a) => a !== "--fresh")], {
    stdio: "inherit",
    env: {
      ...process.env,
      KOINOS_ROUTER_DATA: coreDir,
      KOINOS_ROUTER_HARNESS_HOME: harnessHome,
      KAI_SCHEDULER_URL: `http://127.0.0.1:${schedPort}`,
      KAI_LLAMA_BIN: path.join(repo, "core", "test", "fixtures", "fake-llama-server"),
    },
  });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", async (code) => {
    await sched.close?.();
    process.exit(code ?? 0);
  });
}

main().catch((e) => {
  console.error("[demo] failed:", e);
  process.exit(1);
});
