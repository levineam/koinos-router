"use strict";

// createCore({ profile: "router" }) must not even load the subsystems Router
// skips: Router packaging leaves their modules and native dependencies out,
// so a stray require would crash the packaged app. Each check runs in a child
// process so this test runner's own module cache can't hide or fake a load.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");

const SKIPPED_CORE = [
  "email.js",
  "caldav.js",
  "koinos-node.js",
  "speech.js",
  "whisper.js",
  "smart-turn.js",
  "code-agent.js",
  "teams.js",
  "mcp-manager.js",
  "live-senses-assets.js",
].map((f) => path.join(ROOT, "core", "lib", f));
const SKIPPED_PACKAGES = [/[\\/]node_modules[\\/]onnxruntime[^\\/]*[\\/]/, /[\\/]node_modules[\\/]sherpa-onnx[^\\/]*[\\/]/, /[\\/]node_modules[\\/]kokoro-js[\\/]/, /[\\/]node_modules[\\/]@huggingface[\\/]/];

function loadedModules(boot) {
  const script = `
    const fs = require("fs"), os = require("os"), path = require("path");
    (async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koinos-router-profile-"));
      const fake = path.join(${JSON.stringify(ROOT)}, "core", "test", "fixtures", "fake-llama-server");
      const app = await (${boot})(dir, fake);
      await app.start();
      await app.stop();
      fs.rmSync(dir, { recursive: true, force: true });
      process.stdout.write(JSON.stringify(Object.keys(require.cache)));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  const out = execFileSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60000,
    // KAI_SCHEDULER_URL points the (never contacted) default scheduler at a dead local port.
    env: { ...process.env, KAI_SCHEDULER_URL: "http://127.0.0.1:9" },
  });
  return JSON.parse(out);
}

function skippedLoaded(modules) {
  return modules.filter((m) => SKIPPED_CORE.includes(m) || SKIPPED_PACKAGES.some((re) => re.test(m)));
}

test("createCore profile router loads none of the skipped subsystems", () => {
  const modules = loadedModules(`async (dir, fake) => require("./core/server").createCore({ dataDir: dir, port: 0, llamaBin: fake, profile: "router", onEvent: () => {} })`);
  assert.ok(modules.includes(path.join(ROOT, "core", "lib", "worker.js")), "sanity: the router profile loads the worker");
  assert.ok(modules.includes(path.join(ROOT, "core", "lib", "wallet.js")), "sanity: and the wallet");
  assert.deepEqual(skippedLoaded(modules), []);
});

test("createRouterCore loads none of them either", () => {
  const modules = loadedModules(`async (dir, fake) => require("./router/lib/router-core").createRouterCore({
    dataDir: path.join(dir, "data"), port: 0, llamaBin: fake, home: path.join(dir, "home"),
    walletPassword: "correct horse battery", connectorsWhich: async () => null,
    connectorsExec: async () => { throw new Error("no CLI"); }, otherAppEarning: async () => false, onEvent: () => {},
  })`);
  assert.ok(modules.includes(path.join(ROOT, "router", "lib", "mcp-server.js")));
  assert.deepEqual(skippedLoaded(modules), []);
});

test("the full profile still loads them (the check above is not vacuous)", () => {
  const modules = loadedModules(`async (dir, fake) => require("./core/server").createCore({ dataDir: dir, port: 0, llamaBin: fake, onEvent: () => {} })`);
  const missing = SKIPPED_CORE.filter((m) => !modules.includes(m));
  assert.deepEqual(missing, []);
});

test("an unknown profile is refused", async () => {
  const { createCore } = require("../../core/server");
  await assert.rejects(createCore({ profile: "slim" }), /Unknown Core profile: slim/);
});
