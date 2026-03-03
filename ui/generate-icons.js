#!/usr/bin/env node
// Generate minimal PNG icons for PWA manifest.
// No dependencies — uses raw PNG encoding with zlib from Node.js stdlib.

import { createDeflate } from "node:zlib";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

const BG = [0x0b, 0x0f, 0x14]; // #0b0f14
const FG = [0x32, 0xd2, 0x96]; // #32d296

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const combined = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(combined));
  return Buffer.concat([len, combined, crc]);
}

function createPngHeader(width, height) {
  const buf = Buffer.alloc(13);
  buf.writeUInt32BE(width, 0);
  buf.writeUInt32BE(height, 4);
  buf[8] = 8; // bit depth
  buf[9] = 2; // color type: RGB
  buf[10] = 0; // compression
  buf[11] = 0; // filter
  buf[12] = 0; // interlace
  return pngChunk("IHDR", buf);
}

function drawIcon(size) {
  // Create raw scanlines: each row = filter byte (0) + RGB pixels
  const rowBytes = 1 + size * 3;
  const raw = Buffer.alloc(rowBytes * size);

  const cornerRadius = Math.floor(size * 96 / 512);
  const letterStart = Math.floor(size * 0.2);
  const letterEnd = Math.floor(size * 0.8);
  const letterTop = Math.floor(size * 0.25);
  const letterBottom = Math.floor(size * 0.75);
  const strokeW = Math.max(2, Math.floor(size * 0.08));

  // Simple "CP" rendering via rectangles
  // C: left vertical + top horizontal + bottom horizontal
  // P: middle vertical + top horizontal + middle horizontal + right arc top half
  const cLeft = letterStart;
  const cRight = Math.floor(size * 0.45);
  const pLeft = Math.floor(size * 0.5);
  const pRight = letterEnd;
  const midY = Math.floor((letterTop + letterBottom) / 2);

  function inCorner(x, y) {
    // Check if pixel is in a rounded corner cutout
    const r = cornerRadius;
    const checks = [
      [r, r],                     // top-left
      [size - 1 - r, r],         // top-right
      [r, size - 1 - r],         // bottom-left
      [size - 1 - r, size - 1 - r] // bottom-right
    ];
    for (const [cx, cy] of checks) {
      const inCornerRegion =
        (x < r && y < r) ||
        (x > size - 1 - r && y < r) ||
        (x < r && y > size - 1 - r) ||
        (x > size - 1 - r && y > size - 1 - r);
      if (inCornerRegion) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > r * r) return true;
      }
    }
    return false;
  }

  function isLetterC(x, y) {
    if (y < letterTop || y > letterBottom || x < cLeft || x > cRight) return false;
    // Left vertical stroke
    if (x >= cLeft && x < cLeft + strokeW) return true;
    // Top horizontal stroke
    if (y >= letterTop && y < letterTop + strokeW) return true;
    // Bottom horizontal stroke
    if (y > letterBottom - strokeW && y <= letterBottom) return true;
    return false;
  }

  function isLetterP(x, y) {
    if (y < letterTop || y > letterBottom || x < pLeft || x > pRight) return false;
    // Left vertical stroke (full height)
    if (x >= pLeft && x < pLeft + strokeW) return true;
    // Top horizontal stroke
    if (y >= letterTop && y < letterTop + strokeW) return true;
    // Middle horizontal stroke
    if (y >= midY - Math.floor(strokeW / 2) && y < midY + Math.ceil(strokeW / 2)) return true;
    // Right vertical (top half only — the bump of the P)
    if (x > pRight - strokeW && x <= pRight && y >= letterTop && y <= midY) return true;
    return false;
  }

  for (let y = 0; y < size; y++) {
    const offset = y * rowBytes;
    raw[offset] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const px = offset + 1 + x * 3;
      if (inCorner(x, y)) {
        // Transparent — but PNG RGB has no alpha, use bg as "transparent"
        raw[px] = 0;
        raw[px + 1] = 0;
        raw[px + 2] = 0;
      } else if (isLetterC(x, y) || isLetterP(x, y)) {
        raw[px] = FG[0];
        raw[px + 1] = FG[1];
        raw[px + 2] = FG[2];
      } else {
        raw[px] = BG[0];
        raw[px + 1] = BG[1];
        raw[px + 2] = BG[2];
      }
    }
  }

  return raw;
}

async function compressData(raw) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const deflate = createDeflate({ level: 9 });
    deflate.on("data", (chunk) => chunks.push(chunk));
    deflate.on("end", () => resolve(Buffer.concat(chunks)));
    deflate.on("error", reject);
    deflate.end(raw);
  });
}

async function writePng(filename, size) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = createPngHeader(size, size);
  const raw = drawIcon(size);
  const compressed = await compressData(raw);
  const idat = pngChunk("IDAT", compressed);
  const iend = pngChunk("IEND", Buffer.alloc(0));

  const png = Buffer.concat([signature, ihdr, idat, iend]);

  const dir = new URL(".", import.meta.url).pathname;
  const filePath = dir + filename;
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(filePath);
    ws.on("finish", resolve);
    ws.on("error", reject);
    ws.end(png);
  });
  console.log(`wrote ${filePath} (${png.length} bytes)`);
}

await writePng("icon-192.png", 192);
await writePng("icon-512.png", 512);
