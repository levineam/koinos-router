#!/usr/bin/env node
"use strict";

/*
 * Draws the Koinos Router DMG window background:
 *   router/assets/dmg-background.png     540×380 (72 dpi)
 *   router/assets/dmg-background@2x.png  1080×760 (144 dpi)
 * electron-builder finds the @2x file next to the 1x one and combines both
 * into one HiDPI TIFF (tiffutil -cathidpicheck); the window takes the 1x size.
 *
 * The picture is the app's page colour (#f5f8ff) with one small ink (#14284e)
 * arrow between the two icon slots that router/electron-builder.yml "dmg"
 * places (DMG_LAYOUT below; router/test/release-dmg.test.js keeps the two in
 * step). Drawn here in plain Node so the PNGs are reproducible from source:
 *
 *   node router/scripts/make-dmg-background.js          # rewrite both files
 *   node router/scripts/make-dmg-background.js --check  # exit 1 if they differ
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ASSETS = path.join(__dirname, "..", "assets");
const FILES = { 1: path.join(ASSETS, "dmg-background.png"), 2: path.join(ASSETS, "dmg-background@2x.png") };

/** Window and icon geometry in points (1x pixels). Icon x/y are centres. */
const DMG_LAYOUT = Object.freeze({
  width: 540,
  height: 380,
  iconSize: 96,
  app: Object.freeze({ x: 140, y: 180 }),
  applications: Object.freeze({ x: 400, y: 180 }),
});

const BACKGROUND = [0xf5, 0xf8, 0xff];
const INK = [0x14, 0x28, 0x4e];
const ARROW_OPACITY = 0.55;

/** The arrow as line segments (points), with its stroke width. */
function arrowSegments(layout = DMG_LAYOUT) {
  const y = layout.app.y;
  const gap = 26; // clear space between an icon's edge and the arrow
  const x0 = layout.app.x + layout.iconSize / 2 + gap;
  const x1 = layout.applications.x - layout.iconSize / 2 - gap;
  const head = 11; // chevron arm length along each axis
  return {
    width: 3,
    segments: [
      [x0, y, x1, y],
      [x1 - head, y - head, x1, y],
      [x1 - head, y + head, x1, y],
    ],
  };
}

function distanceToSegment(px, py, [ax, ay, bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** RGB rows (Buffer) for one scale: round-capped strokes, analytically antialiased. */
function renderPixels(scale, layout = DMG_LAYOUT) {
  const w = layout.width * scale;
  const h = layout.height * scale;
  const { width, segments } = arrowSegments(layout);
  const scaled = segments.map((s) => s.map((v) => v * scale));
  const half = (width * scale) / 2;
  const pad = half + 2;
  const minX = Math.floor(Math.min(...scaled.flatMap((s) => [s[0], s[2]])) - pad);
  const maxX = Math.ceil(Math.max(...scaled.flatMap((s) => [s[0], s[2]])) + pad);
  const minY = Math.floor(Math.min(...scaled.flatMap((s) => [s[1], s[3]])) - pad);
  const maxY = Math.ceil(Math.max(...scaled.flatMap((s) => [s[1], s[3]])) + pad);
  const rowBytes = 1 + w * 3;
  const raw = Buffer.alloc(rowBytes * h);
  for (let y = 0; y < h; y++) {
    raw[y * rowBytes] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      let cover = 0;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
        const d = Math.min(...scaled.map((s) => distanceToSegment(x + 0.5, y + 0.5, s)));
        cover = Math.max(0, Math.min(1, half - d + 0.5));
      }
      const a = cover * ARROW_OPACITY;
      const o = y * rowBytes + 1 + x * 3;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(BACKGROUND[c] * (1 - a) + INK[c] * a);
    }
  }
  return { width: w, height: h, raw };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** The PNG file for one scale (1 or 2), byte-for-byte reproducible. */
function renderPng(scale) {
  const { width, height, raw } = renderPixels(scale);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const phys = Buffer.alloc(9);
  const ppm = Math.round((72 * scale) / 0.0254); // 72 dpi per point
  phys.writeUInt32BE(ppm, 0);
  phys.writeUInt32BE(ppm, 4);
  phys[8] = 1; // metres
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("pHYs", phys),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** { width, height, dpi } from a PNG's IHDR and pHYs chunks. */
function pngInfo(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  const info = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), dpi: null };
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    if (type === "pHYs" && buf[at + 16] === 1) info.dpi = Math.round(buf.readUInt32BE(at + 8) * 0.0254);
    at += 12 + len;
  }
  return info;
}

function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  let stale = 0;
  for (const scale of [1, 2]) {
    const png = renderPng(scale);
    const file = FILES[scale];
    const same = fs.existsSync(file) && fs.readFileSync(file).equals(png);
    if (check) {
      if (!same) {
        console.error(`[dmg-background] ${path.relative(process.cwd(), file)} is out of date`);
        stale++;
      }
      continue;
    }
    if (!same) fs.writeFileSync(file, png);
    console.log(`[dmg-background] ${path.relative(process.cwd(), file)} ${pngInfo(png).width}×${pngInfo(png).height} ${same ? "(unchanged)" : "written"}`);
  }
  return stale ? 1 : 0;
}

module.exports = { DMG_LAYOUT, FILES, arrowSegments, renderPng, pngInfo, BACKGROUND, INK };

if (require.main === module) process.exit(main());
