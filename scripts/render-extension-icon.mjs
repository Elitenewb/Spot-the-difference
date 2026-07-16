import fs from 'node:fs';
import zlib from 'node:zlib';

const output = process.argv[2];
const size = 512;
const pixels = Buffer.alloc(size * size * 4);
const colors = { navy: [24, 40, 78], gold: [246, 198, 77], cream: [255, 246, 213], blue: [40, 93, 221], pink: [236, 91, 120] };

function paint(x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const index = (Math.floor(y) * size + Math.floor(x)) * 4;
  pixels[index] = color[0]; pixels[index + 1] = color[1]; pixels[index + 2] = color[2]; pixels[index + 3] = 255;
}
function circle(cx, cy, radius, color) {
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) paint(x, y, color);
  }
}
function line(x1, y1, x2, y2, width, color) {
  const length = Math.hypot(x2 - x1, y2 - y1); const radius = width / 2;
  for (let y = Math.floor(Math.min(y1, y2) - radius); y <= Math.ceil(Math.max(y1, y2) + radius); y++) for (let x = Math.floor(Math.min(x1, x2) - radius); x <= Math.ceil(Math.max(x1, x2) + radius); x++) {
    const t = Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / (length * length)));
    if (Math.hypot(x - (x1 + t * (x2 - x1)), y - (y1 + t * (y2 - y1))) <= radius) paint(x, y, color);
  }
}
const s = 4, point = value => value * s;
circle(point(58), point(56), point(35), colors.navy);
circle(point(58), point(56), point(28), colors.gold);
circle(point(58), point(56), point(20), colors.cream);
line(point(82), point(80), point(107), point(105), point(19), colors.navy);
line(point(82), point(80), point(107), point(105), point(11), colors.gold);
circle(point(48), point(50), point(6), colors.blue);
circle(point(66), point(64), point(6), colors.pink);
line(point(62), point(42), point(62), point(52), point(3.5), colors.blue);
line(point(57), point(47), point(67), point(47), point(3.5), colors.blue);

function crc32(buffer) { let crc = ~0; for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (~crc) >>> 0; }
function chunk(type, data) { const label = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([label, data]))); return Buffer.concat([length, label, data, checksum]); }
const rows = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
const png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'binary'), chunk('IHDR', Buffer.from([0, 0, 2, 0, 0, 0, 2, 0, 8, 6, 0, 0, 0])), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(output, png);
console.log('top-left alpha:', pixels[3]);
