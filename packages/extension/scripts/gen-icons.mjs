/**
 * Draws the extension icon: a mint magnifying glass on deep teal, for "look, don't touch". An
 * original mark, deliberately not ServiceNow's logo or colours: this extension isn't made by
 * ServiceNow and must not look as if it were.
 *
 *   node packages/extension/scripts/gen-icons.mjs
 *
 * No dependencies: shapes are distance functions, antialiased by supersampling, written as PNG.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const out = join(dirname(fileURLToPath(import.meta.url)), '../icons');
const BG = [15, 61, 62];
const FG = [94, 234, 212];
const SAMPLES = 8;

/** Signed distance to a rounded square covering the unit canvas. */
function square(x, y, radius) {
  const qx = Math.abs(x - 0.5) - (0.5 - radius);
  const qy = Math.abs(y - 0.5) - (0.5 - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Signed distance to a capsule from a to b. */
function capsule(x, y, ax, ay, bx, by, r) {
  const [px, py, dx, dy] = [x - ax, y - ay, bx - ax, by - ay];
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - t * dx, py - t * dy) - r;
}

/** Heavier lines at small sizes, so the glass stays readable at 16 px. */
function sample(x, y, size) {
  const bold = size <= 32 ? 1.25 : 1;
  const [cx, cy, ring, thick] = [0.44, 0.44, 0.22, 0.075 * bold];
  const glass = Math.abs(Math.hypot(x - cx, y - cy) - ring) - thick;
  const d = 0.7071 * (ring + thick * 0.6);
  const handle = capsule(x, y, cx + d, cy + d, 0.76, 0.76, 0.075 * bold);
  if (square(x, y, 0.22) > 0) return [0, 0, 0, 0];
  return Math.min(glass, handle) <= 0 ? [...FG, 255] : [...BG, 255];
}

function crcTable() {
  return Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
}
const TABLE = crcTable();
function crc(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    const row = py * (size * 4 + 1);
    for (let px = 0; px < size; px++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let i = 0; i < SAMPLES; i++) {
        for (let j = 0; j < SAMPLES; j++) {
          const s = sample(
            (px + (i + 0.5) / SAMPLES) / size,
            (py + (j + 0.5) / SAMPLES) / size,
            size,
          );
          r += s[0] * s[3];
          g += s[1] * s[3];
          b += s[2] * s[3];
          a += s[3];
        }
      }
      const at = row + 1 + px * 4;
      raw[at] = a ? Math.round(r / a) : 0;
      raw[at + 1] = a ? Math.round(g / a) : 0;
      raw[at + 2] = a ? Math.round(b / a) : 0;
      raw[at + 3] = Math.round(a / (SAMPLES * SAMPLES));
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) writeFileSync(join(out, `icon${size}.png`), png(size));
console.log(`Wrote icons to ${out}`);
