const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPng(width, height, getPixelFn) {
  const bytesPerPixel = 4;
  const rawData = Buffer.alloc(height * (1 + width * bytesPerPixel));
  
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * bytesPerPixel);
    rawData[rowOffset] = 0; // Filter 0 (None)
    
    for (let x = 0; x < width; x++) {
      const pixelOffset = rowOffset + 1 + x * bytesPerPixel;
      const [r, g, b, a] = getPixelFn(x, y, width, height);
      rawData[pixelOffset] = r;
      rawData[pixelOffset + 1] = g;
      rawData[pixelOffset + 2] = b;
      rawData[pixelOffset + 3] = a;
    }
  }

  const deflated = zlib.deflateSync(rawData, { level: 9 });

  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const toCrc = Buffer.concat([typeBuf, data]);
    const crcVal = Buffer.alloc(4);
    // Use native Node.js zlib.crc32 to strictly adhere to PNG / libpng specification
    crcVal.writeUInt32BE(zlib.crc32(toCrc) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcVal]);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', deflated),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

// Canonical bold thunderbolt polygon in normalized coordinates [-1, 1]
const boltPoly = [
  [  0.18, -0.92 ], // Top-right tip
  [ -0.74,  0.10 ], // Left wing peak
  [ -0.04,  0.10 ], // Inner left waist notch
  [ -0.22,  0.94 ], // Bottom spear tip
  [  0.74, -0.10 ], // Right wing peak
  [  0.06, -0.10 ], // Inner right waist notch
  [  0.26, -0.92 ]  // Top-left shoulder
];

function pointInPolygon(px, py, vertices) {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i][0], yi = vertices[i][1];
    const xj = vertices[j][0], yj = vertices[j][1];
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function minDistanceToPolygon(px, py, vertices) {
  let minD = Infinity;
  for (let i = 0; i < vertices.length; i++) {
    const j = (i + 1) % vertices.length;
    const ax = vertices[i][0], ay = vertices[i][1];
    const bx = vertices[j][0], by = vertices[j][1];
    const abx = bx - ax, aby = by - ay;
    const apx = px - ax, apy = py - ay;
    const lenSq = abx * abx + aby * aby;
    let t = lenSq === 0 ? 0 : (apx * abx + apy * aby) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = ax + t * abx;
    const projY = ay + t * aby;
    const d = Math.hypot(px - projX, py - projY);
    if (d < minD) minD = d;
  }
  return minD;
}

function getPixel(x, y, w, h) {
  // 4x4 Supersampling for anti-aliasing
  const SAMPLES = 4;
  let inCount = 0;
  const step = 1 / SAMPLES;

  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const subX = x + (sx + 0.5) * step;
      const subY = y + (sy + 0.5) * step;
      const nx = (subX / (w - 1)) * 2 - 1;
      const ny = (subY / (h - 1)) * 2 - 1;

      if (pointInPolygon(nx, ny, boltPoly)) {
        inCount++;
      }
    }
  }

  const cx = (x / (w - 1)) * 2 - 1;
  const cy = (y / (h - 1)) * 2 - 1;
  const coverage = inCount / (SAMPLES * SAMPLES);
  const dist = minDistanceToPolygon(cx, cy, boltPoly);

  if (coverage > 0) {
    const t = Math.min(1, Math.max(0, (cy + 0.92) / 1.86));
    
    // Electric Neon Yellow to Hyper Solar Amber/Red gradient
    let r, g, b;
    if (t < 0.5) {
      const segT = t / 0.5;
      r = 255;
      g = Math.round(250 - segT * 55); // 250 -> 195
      b = Math.round(30 - segT * 30);   // 30 -> 0
    } else {
      const segT = (t - 0.5) / 0.5;
      r = 255;
      g = Math.round(195 - segT * 140); // 195 -> 55
      b = 0;
    }

    // 3D specular highlight
    const isBevel = (cx < cy * 0.12);
    if (isBevel && dist > 0.03) {
      r = Math.min(255, r + 20);
      g = Math.min(255, g + 25);
      b = Math.min(255, b + 70);
    }

    const alpha = Math.round(255 * coverage);
    return [r, g, b, alpha];
  }

  // High-contrast dark contour border so thunderbolt pops on all light/dark themes
  const strokeWidth = (w <= 16) ? 0.09 : (w <= 32 ? 0.08 : 0.06);
  if (dist < strokeWidth) {
    const strokeAlpha = Math.round(220 * (1 - dist / strokeWidth));
    return [15, 18, 28, strokeAlpha];
  }

  return [0, 0, 0, 0];
}

const assetsDir = path.join(__dirname, 'assets');
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

[16, 32, 48, 128].forEach(size => {
  const buf = createPng(size, size, getPixel);
  const outPath = path.join(assetsDir, 'icon' + size + '.png');
  fs.writeFileSync(outPath, buf);
  console.log('Successfully written compliant PNG: ' + outPath + ' (' + buf.length + ' bytes)');
});
