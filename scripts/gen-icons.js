// Rasterize the app icon to PNG (192/512) without native deps. Run: node scripts/gen-icons.js
// Mirrors apps/web/icons/icon.svg: blue rounded square, white "sensor" ring, two wave lines.

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BLUE = [0x0b, 0x5c, 0xab];
const WHITE = [255, 255, 255];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// Shape in 512-unit space. Returns [r,g,b,a].
function shade(x, y) {
  const r = 112;
  const cx = Math.min(Math.max(x, r), 512 - r);
  const cy = Math.min(Math.max(y, r), 512 - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return [0, 0, 0, 0];

  const d = Math.hypot(x - 256, y - 170);
  if (d <= 62 && d > 26) return [...WHITE, 255];

  for (const base of [300, 380]) {
    if (x >= 96 && x <= 416) {
      const wy = base - 34 * Math.sin(((x - 96) / 120) * Math.PI) * (x < 336 ? 1 : 0.5);
      if (Math.abs(y - wy) <= 15) return [...WHITE, 255];
    }
  }
  return [...BLUE, 255];
}

function png(size) {
  const ss = 3; // supersampling for smooth edges
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = shade(((px + (sx + 0.5) / ss) / size) * 512, ((py + (sy + 0.5) / ss) / size) * 512);
          for (let i = 0; i < 3; i++) acc[i] += c[i] * c[3];
          acc[3] += c[3];
        }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      const a = acc[3] / (ss * ss);
      for (let i = 0; i < 3; i++) raw[o + i] = acc[3] ? Math.round(acc[i] / acc[3]) : 0;
      raw[o + 3] = Math.round(a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  writeFileSync(new URL(`../apps/web/icons/icon-${size}.png`, import.meta.url), png(size));
  console.log(`icon-${size}.png`);
}
