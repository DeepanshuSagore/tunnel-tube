// Generates the four extension icons with zero dependencies (Node built-ins only).
// Run: node tools/make-icons.mjs
//
// Glyph: a tunnel mouth — a white arch ring on a dark ground, with a warm
// "light at the end" arch inside it. Deliberately chunky so it survives 16px.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const GROUND = [0x17, 0x1a, 0x2e];
const RING = [0xff, 0xff, 0xff];
const GLOW = [0xff, 0xc8, 0x57];

const SS = 4; // supersampling factor, for antialiasing

/** Rounded rect coverage test in unit space (0..1). */
const inRoundedRect = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
};

/** Arch = rectangle with a semicircular cap on top, in unit space. */
const inArch = (x, y, cx, top, halfWidth, bottom) => {
  if (y > bottom) return false;
  const shoulder = top + halfWidth;
  if (y >= shoulder) return Math.abs(x - cx) <= halfWidth;
  const dx = x - cx;
  const dy = y - shoulder;
  return dx * dx + dy * dy <= halfWidth * halfWidth;
};

/** Colour of the artwork at a unit-space point, or null for transparent. */
function sample(x, y) {
  if (!inRoundedRect(x, y, 0.22)) return null;
  if (inArch(x, y, 0.5, 0.44, 0.13, 0.86)) return GLOW;
  if (inArch(x, y, 0.5, 0.25, 0.21, 1.1)) return GROUND;
  if (inArch(x, y, 0.5, 0.14, 0.32, 0.86)) return RING;
  return GROUND;
}

function renderRGBA(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((pxi + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const i = (py * size + pxi) * 4;
      const hits = a / 255;
      if (hits > 0) {
        px[i] = Math.round(r / hits);
        px[i + 1] = Math.round(g / hits);
        px[i + 2] = Math.round(b / hits);
      }
      px[i + 3] = Math.round(a / n);
    }
  }
  return px;
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
for (const size of [16, 32, 48, 128]) {
  const file = join(outDir, `icon${size}.png`);
  writeFileSync(file, encodePNG(size, renderRGBA(size)));
  console.log(`wrote ${file}`);
}
