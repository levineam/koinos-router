"use strict";

/*
 * The disk image layout (router/electron-builder.yml "dmg") and its window
 * background (router/scripts/make-dmg-background.js). Pure: nothing is mounted.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const ROOT = path.join(__dirname, "..", "..");
const bg = require("../scripts/make-dmg-background");
const builder = yaml.load(fs.readFileSync(path.join(ROOT, "router", "electron-builder.yml"), "utf8"));

test("the dmg is a drag-to-Applications window named Koinos Router", () => {
  const { dmg } = builder;
  assert.strictEqual(dmg.title, "Koinos Router", "volume name");
  assert.strictEqual(dmg.iconSize, bg.DMG_LAYOUT.iconSize);
  const [app, link] = dmg.contents;
  assert.deepStrictEqual(app, { x: bg.DMG_LAYOUT.app.x, y: bg.DMG_LAYOUT.app.y, type: "file" });
  assert.deepStrictEqual(link, { x: bg.DMG_LAYOUT.applications.x, y: bg.DMG_LAYOUT.applications.y, type: "link", path: "/Applications" });
  assert.strictEqual(dmg.contents.length, 2);
  assert.ok(app.x < link.x, "app on the left, Applications on the right");
  // Both icons, with their labels, fit inside the window.
  const { width, height, iconSize } = bg.DMG_LAYOUT;
  for (const c of dmg.contents) {
    assert.ok(c.x - iconSize / 2 >= 0 && c.x + iconSize / 2 <= width, `x ${c.x}`);
    assert.ok(c.y - iconSize / 2 >= 0 && c.y + iconSize / 2 + 40 <= height, `y ${c.y}`);
  }
  assert.strictEqual(dmg.background, "router/assets/dmg-background.png");
  assert.strictEqual(dmg.writeUpdateInfo, false);
  assert.strictEqual(builder.mac.notarize, false, "dist-router.js notarizes itself");
});

test("the background is 540×380 at 1x and 1080×760 at 2x, in Router's palette", () => {
  const one = fs.readFileSync(bg.FILES[1]);
  const two = fs.readFileSync(bg.FILES[2]);
  assert.deepStrictEqual(bg.pngInfo(one), { width: 540, height: 380, dpi: 72 });
  assert.deepStrictEqual(bg.pngInfo(two), { width: 1080, height: 760, dpi: 144 });
  assert.strictEqual(path.basename(bg.FILES[2]), path.basename(bg.FILES[1]).replace(".png", "@2x.png"), "electron-builder finds the @2x file by name");
  assert.deepStrictEqual(bg.BACKGROUND, [0xf5, 0xf8, 0xff]);
  assert.deepStrictEqual(bg.INK, [0x14, 0x28, 0x4e]);
  // The checked-in files are exactly what the script draws (rerun it after a layout change).
  assert.ok(one.equals(bg.renderPng(1)), "dmg-background.png is up to date (node router/scripts/make-dmg-background.js)");
  assert.ok(two.equals(bg.renderPng(2)), "dmg-background@2x.png is up to date");
});

test("the arrow sits between the two icons, clear of both", () => {
  const { segments } = bg.arrowSegments();
  const xs = segments.flatMap((s) => [s[0], s[2]]);
  const ys = segments.flatMap((s) => [s[1], s[3]]);
  const { app, applications, iconSize } = bg.DMG_LAYOUT;
  assert.ok(Math.min(...xs) > app.x + iconSize / 2, "right of the app icon");
  assert.ok(Math.max(...xs) < applications.x - iconSize / 2, "left of the Applications icon");
  assert.ok(Math.min(...ys) > app.y - iconSize / 2 && Math.max(...ys) < app.y + iconSize / 2);
  // Points right: the head's tip is the shaft's end.
  const [shaft, upper, lower] = segments;
  assert.ok(shaft[2] > shaft[0]);
  assert.deepStrictEqual([upper[2], upper[3]], [shaft[2], shaft[3]]);
  assert.deepStrictEqual([lower[2], lower[3]], [shaft[2], shaft[3]]);
});

test("the background never ships inside the app", () => {
  assert.ok(builder.files.includes("!router/assets/dmg-*"));
  const last = (file) => {
    let shipped = false;
    for (const p of builder.files) {
      const neg = p.startsWith("!");
      const glob = (neg ? p.slice(1) : p).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
      if (new RegExp(`^${glob}$`).test(file)) shipped = !neg;
    }
    return shipped;
  };
  assert.strictEqual(last("router/assets/dmg-background.png"), false);
  assert.strictEqual(last("router/assets/dmg-background@2x.png"), false);
  assert.strictEqual(last("router/assets/trayTemplate.png"), true);
});
