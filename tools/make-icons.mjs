#!/usr/bin/env node
/**
 * Generates Pip's artwork files from the single source of truth (js/puppet-art.js):
 *   assets/puppet/pip.svg          full puppet (same markup the app mounts)
 *   assets/icons/icon.svg          compact head icon
 *   assets/icons/icon-maskable.svg padded, full-bleed maskable icon
 *   assets/icons/icon-192.png      real PNGs (no dependencies — tiny rasteriser + PNG encoder)
 *   assets/icons/icon-512.png
 *
 * Run: npm run icons
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUPPET_SVG, ICON_SVG } from '../js/puppet-art.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/* ───────── tiny rasteriser (RGBA) ───────── */
class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Uint8ClampedArray(w * h * 4);
  }
  blend(x, y, [r, g, b], a) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const src = a;
    const dst = this.px[i + 3] / 255;
    const outA = src + dst * (1 - src);
    for (let k = 0; k < 3; k++) {
      const c = [r, g, b][k];
      this.px[i + k] = (c * src + this.px[i + k] * dst * (1 - src)) / (outA || 1);
    }
    this.px[i + 3] = outA * 255;
  }
  ellipse(cx, cy, rx, ry, color, { alpha = 1, rotation = 0, coord = 'px' } = {}) {
    const [X, Y] = coord === 'norm' ? [cx * this.w, cy * this.h] : [cx, cy];
    const [RX, RY] = coord === 'norm' ? [rx * this.w, ry * this.h] : [rx, ry];
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const bound = Math.max(RX, RY) + 2;
    for (let y = Math.floor(Y - bound); y <= Math.ceil(Y + bound); y++) {
      for (let x = Math.floor(X - bound); x <= Math.ceil(X + bound); x++) {
        const dx = x + 0.5 - X;
        const dy = y + 0.5 - Y;
        const ux = dx * cos + dy * sin;
        const uy = -dx * sin + dy * cos;
        const d = (ux / RX) ** 2 + (uy / RY) ** 2;
        if (d <= 1) this.blend(x, y, color, alpha * Math.min(1, (1 - d) * 8 + 0.35));
      }
    }
  }
  roundRect(x, y, w, h, r, color, alpha = 1) {
    for (let py = y; py < y + h; py++) {
      for (let px = x; px < x + w; px++) {
        const dx = Math.max(x + r - px, 0, px - (x + w - r));
        const dy = Math.max(y + r - py, 0, py - (y + h - r));
        if (dx * dx + dy * dy <= r * r) this.blend(px, py, color, alpha);
      }
    }
  }
  gradientRoundRect(x, y, w, h, r, top, bottom) {
    for (let py = y; py < y + h; py++) {
      const t = (py - y) / h;
      const color = [0, 1, 2].map((k) => top[k] + (bottom[k] - top[k]) * t);
      for (let px = x; px < x + w; px++) {
        const dx = Math.max(x + r - px, 0, px - (x + w - r));
        const dy = Math.max(y + r - py, 0, py - (y + h - r));
        if (dx * dx + dy * dy <= r * r) this.blend(px, py, color, 1);
      }
    }
  }
  triangle(p1, p2, p3, color, alpha = 1) {
    const minX = Math.floor(Math.min(p1[0], p2[0], p3[0]));
    const maxX = Math.ceil(Math.max(p1[0], p2[0], p3[0]));
    const minY = Math.floor(Math.min(p1[1], p2[1], p3[1]));
    const maxY = Math.ceil(Math.max(p1[1], p2[1], p3[1]));
    const area = (p2[0] - p1[0]) * (p3[1] - p1[1]) - (p3[0] - p1[0]) * (p2[1] - p1[1]);
    if (!area) return;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const cx = x + 0.5;
        const cy = y + 0.5;
        const w1 = ((p2[0] - p1[0]) * (cy - p1[1]) - (cx - p1[0]) * (p2[1] - p1[1])) / area;
        const w2 = ((cx - p1[0]) * (p3[1] - p1[1]) - (p3[0] - p1[0]) * (cy - p1[1])) / area;
        if (w1 >= 0 && w2 >= 0 && w1 + w2 <= 1) this.blend(x, y, color, alpha);
      }
    }
  }
  /** thick curved line from a parametric function */
  curve(fn, steps, thickness, color, alpha = 1) {
    for (let s = 0; s <= steps; s++) {
      const [x, y] = fn(s / steps);
      this.ellipse(x, y, thickness / 2, thickness / 2, color, { alpha });
    }
  }
  downsample(factor) {
    const w = this.w / factor;
    const h = this.h / factor;
    const out = new Canvas(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let sy = 0; sy < factor; sy++) {
          for (let sx = 0; sx < factor; sx++) {
            const i = ((y * factor + sy) * this.w + (x * factor + sx)) * 4;
            r += this.px[i];
            g += this.px[i + 1];
            b += this.px[i + 2];
            a += this.px[i + 3];
          }
        }
        const n = factor * factor;
        const j = (y * w + x) * 4;
        out.px[j] = r / n;
        out.px[j + 1] = g / n;
        out.px[j + 2] = b / n;
        out.px[j + 3] = a / n;
      }
    }
    return out;
  }
}

/* ───────── minimal PNG encoder ───────── */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(canvas) {
  const { w, h, px } = canvas;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    Buffer.from(px.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ───────── draw Pip's head icon ───────── */
function drawIcon(size, { pad = 0 } = {}) {
  const SS = 2; // supersample
  const c = new Canvas(size * SS, size * SS);
  const S = size * SS;
  const i = (v) => v * S; // normalised → px
  c.gradientRoundRect(0, 0, S, S, pad ? 0 : i(0.22), [18, 58, 44], [11, 27, 51]);
  c.ellipse(i(0.5), i(0.62), i(0.34), i(0.34), [126, 247, 192], { alpha: 0.12 });
  const k = 1 - pad;
  const faceR = i(0.27) * k;
  const cy = i(0.55);
  const cx = i(0.5);
  // hair
  c.ellipse(cx, cy - faceR * 0.35, faceR * 1.16, faceR * 1.02, [47, 143, 77]);
  c.triangle([cx - faceR * 1.05, cy - faceR * 0.2], [cx - faceR * 1.45, cy - faceR * 0.95], [cx - faceR * 0.72, cy - faceR * 0.72], [104, 207, 124]);
  c.triangle([cx - faceR * 0.3, cy - faceR * 1.1], [cx - faceR * 0.42, cy - faceR * 1.75], [cx + faceR * 0.05, cy - faceR * 1.12], [104, 207, 124]);
  c.triangle([cx + faceR * 1.0, cy - faceR * 0.25], [cx + faceR * 1.42, cy - faceR * 0.95], [cx + faceR * 0.68, cy - faceR * 0.75], [104, 207, 124]);
  // face
  c.ellipse(cx, cy, faceR, faceR * 0.96, [255, 225, 194]);
  // eyes
  for (const sx of [-1, 1]) {
    const ex = cx + sx * faceR * 0.38;
    c.ellipse(ex, cy - faceR * 0.05, faceR * 0.29, faceR * 0.33, [255, 255, 255]);
    c.ellipse(ex, cy - faceR * 0.02, faceR * 0.18, faceR * 0.19, [28, 107, 63]);
    c.ellipse(ex + sx * faceR * 0.06, cy - faceR * 0.12, faceR * 0.06, faceR * 0.06, [255, 255, 255], { alpha: 0.95 });
  }
  // blush
  c.ellipse(cx - faceR * 0.66, cy + faceR * 0.34, faceR * 0.18, faceR * 0.11, [255, 155, 166], { alpha: 0.75 });
  c.ellipse(cx + faceR * 0.66, cy + faceR * 0.34, faceR * 0.18, faceR * 0.11, [255, 155, 166], { alpha: 0.75 });
  // mouth (little smile)
  c.curve((t) => [cx + (t - 0.5) * faceR * 0.46, cy + faceR * 0.3 + Math.sin(Math.PI * t) * faceR * 0.14], 40, faceR * 0.09, [168, 72, 47]);
  // antenna
  c.curve((t) => [cx + faceR * 0.34 * t, cy - faceR * 0.95 - t * faceR * 0.55], 30, faceR * 0.1, [47, 143, 77]);
  c.ellipse(cx + faceR * 0.34, cy - faceR * 1.52, faceR * 0.15, faceR * 0.15, [255, 215, 107]);
  c.ellipse(cx + faceR * 0.34, cy - faceR * 1.52, faceR * 0.26, faceR * 0.26, [255, 215, 107], { alpha: 0.25 });
  return c.downsample(SS);
}

/* ───────── main ───────── */
async function main() {
  await mkdir(resolve(ROOT, 'assets/puppet'), { recursive: true });
  await mkdir(resolve(ROOT, 'assets/icons'), { recursive: true });

  // Give the exported art explicit pixel dimensions (the app sets them at runtime).
  // Match the root tag generically so the class list can change freely.
  const puppet = PUPPET_SVG.replace(/<svg\b([^>]*)>/, (m, attrs) => (/(\swidth=)/.test(attrs) ? m : `<svg${attrs} width="200" height="280">`));
  if (!/width="200"/.test(puppet)) throw new Error('could not add dimensions to the exported puppet SVG');
  await writeFile(resolve(ROOT, 'assets/puppet/pip.svg'), `${puppet.trim()}\n`);
  await writeFile(resolve(ROOT, 'assets/icons/icon.svg'), `${ICON_SVG.trim()}\n`);

  const maskable = ICON_SVG.replace(/<g transform="translate\(56,60\) scale\(2\)">/, '<g transform="translate(88,100) scale(1.5)">');
  await writeFile(resolve(ROOT, 'assets/icons/icon-maskable.svg'), `${maskable.trim()}\n`);

  for (const size of [192, 512]) {
    const canvas = drawIcon(size, { pad: false });
    await writeFile(resolve(ROOT, `assets/icons/icon-${size}.png`), encodePng(canvas));
    console.log(`  ✓ assets/icons/icon-${size}.png (${size}×${size})`);
  }
  console.log('  ✓ assets/puppet/pip.svg');
  console.log('  ✓ assets/icons/icon.svg + icon-maskable.svg');
  console.log('\n🥦 Pip has a face everywhere now.\n');
}

main().catch((err) => {
  console.error('icon build failed:', err);
  process.exit(1);
});
