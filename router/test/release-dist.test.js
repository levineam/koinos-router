"use strict";

/*
 * Router's own version and the architectures dist:router builds
 * (router/scripts/dist-router.js). Pure: nothing here runs electron-builder.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const ROOT = path.join(__dirname, "..", "..");
const dist = require("../scripts/dist-router");
const base = yaml.load(fs.readFileSync(path.join(ROOT, dist.CONFIG), "utf8"));
const cfg = (arch) => `/tmp/cfg/${arch}.json`;

test("Router has its own version; Core keeps package.json's", () => {
  assert.match(dist.ROUTER_VERSION, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(dist.ROUTER_VERSION, "0.1.0");
  const core = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  assert.notStrictEqual(dist.ROUTER_VERSION, core, "the packaged app is not stamped with Core's version");
  // It reaches the app as extraMetadata.version (Info.plist, app.getVersion(),
  // the package.json in app.asar) and the artifact names.
  const config = dist.effectiveConfig(base, { arch: "arm64" });
  assert.deepStrictEqual(config.extraMetadata, { ...base.extraMetadata, version: dist.ROUTER_VERSION });
  assert.strictEqual(base.mac.artifactName, "Koinos-Router-${version}-${arch}.${ext}");
  assert.deepStrictEqual(dist.artifactNames("arm64"), { dmg: "Koinos-Router-0.1.0-arm64.dmg", zip: "Koinos-Router-0.1.0-arm64.zip" });
  // The checked-in config is left as it is; the copy is a deep one.
  config.extraMetadata.name = "changed";
  config.files.push("x");
  assert.strictEqual(base.extraMetadata.name, "koinos-router");
  assert.ok(!base.files.includes("x"));
  assert.strictEqual(base.extraMetadata.version, undefined);
});

test("KOINOS_ROUTER_ARCHS picks the architectures: arm64 by default, x64 on request", () => {
  assert.deepStrictEqual(dist.parseArchs(undefined), ["arm64"]);
  assert.deepStrictEqual(dist.parseArchs(""), ["arm64"]);
  assert.deepStrictEqual(dist.parseArchs("x64"), ["x64"]);
  assert.deepStrictEqual(dist.parseArchs(" x64 , ARM64,arm64"), ["arm64", "x64"], "deduplicated, arm64 first");
  assert.throws(() => dist.parseArchs("arm64,universal"), /unsupported universal/);
  assert.throws(() => dist.parseArchs("ia32"), /unsupported ia32/);
});

test("each architecture gets its own config, targets, app directory and artifacts", () => {
  const p = dist.plan({ args: [], out: "/tmp/out", signed: true, archs: ["arm64", "x64"], configPath: cfg });
  assert.deepStrictEqual(p.builds.map((b) => b.arch), ["arm64", "x64"]);
  const [arm, x64] = p.builds;
  assert.strictEqual(arm.app, "/tmp/out/mac-arm64/Koinos Router.app");
  assert.strictEqual(x64.app, "/tmp/out/mac/Koinos Router.app", "electron-builder's x64 directory has no suffix");
  assert.strictEqual(x64.dmg, "/tmp/out/Koinos-Router-0.1.0-x64.dmg");
  assert.strictEqual(x64.zip, "/tmp/out/Koinos-Router-0.1.0-x64.zip");
  assert.deepStrictEqual(x64.steps, [
    ["--config", "/tmp/cfg/x64.json", "--mac", "--x64", "--dir"],
    ["--config", "/tmp/cfg/x64.json", "--mac", "--x64", "--prepackaged", x64.app],
  ]);
  for (const b of p.builds) {
    assert.deepStrictEqual(
      b.config.mac.target.map((t) => `${t.target}:${t.arch.join("+")}`),
      [`dmg:${b.arch}`, `zip:${b.arch}`],
    );
  }
  // Everything else in the config is the checked-in one.
  for (const key of ["appId", "productName", "files", "electronFuses", "dmg", "publish", "npmRebuild"]) {
    assert.deepStrictEqual(x64.config[key], base[key], key);
  }
  assert.strictEqual(x64.config.mac.hardenedRuntime, true);
  assert.deepStrictEqual(x64.config.mac.extendInfo, base.mac.extendInfo);
});
