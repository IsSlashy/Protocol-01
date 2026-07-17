/* Generates icons/icon-{16,32,48,128}.png — gradient rounded square + ¥ glyph.
 * Pure Node (zlib only), no dependencies. Run: node generate-icons.js */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- CRC32 + PNG chunk writer ----
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // rows with filter byte 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- drawing ----
const YEN = [
  '1000000001',
  '0100000010',
  '0010000100',
  '0001001000',
  '0000110000',
  '1111111111',
  '0000110000',
  '1111111111',
  '0000110000',
  '0000110000',
  '0000110000',
];
const GW = YEN[0].length;
const GH = YEN.length;

const A = [0x3e, 0xa6, 0xff]; // accent blue
const B = [0x2d, 0xd4, 0xbf]; // teal
const lerp = (a, b, t) => Math.round(a + (b - a) * t);

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const r = size * 0.22; // corner radius
  const glyphScale = Math.max(1, Math.floor((size * 0.52) / GH));
  const gw = GW * glyphScale;
  const gh = GH * glyphScale;
  const gx0 = Math.floor((size - gw) / 2);
  const gy0 = Math.floor((size - gh) / 2);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // rounded-corner alpha
      let alpha = 255;
      const cx = x < r ? r : x > size - r ? size - r : x;
      const cy = y < r ? r : y > size - r ? size - r : y;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > r) alpha = 0;
      else if (dist > r - 1.2) alpha = Math.round(255 * (r - dist) / 1.2);

      // gradient background
      const t = (x + y) / (2 * (size - 1));
      let rr = lerp(A[0], B[0], t);
      let gg = lerp(A[1], B[1], t);
      let bb = lerp(A[2], B[2], t);

      // ¥ glyph in white
      if (x >= gx0 && x < gx0 + gw && y >= gy0 && y < gy0 + gh) {
        const bxi = Math.floor((x - gx0) / glyphScale);
        const byi = Math.floor((y - gy0) / glyphScale);
        if (YEN[byi] && YEN[byi][bxi] === '1') {
          rr = 0xff;
          gg = 0xff;
          bb = 0xff;
        }
      }

      rgba[i] = rr;
      rgba[i + 1] = gg;
      rgba[i + 2] = bb;
      rgba[i + 3] = alpha;
    }
  }
  return encodePNG(size, size, rgba);
}

const outDir = path.join(__dirname, 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), render(size));
  console.log('wrote icons/icon-' + size + '.png');
}
