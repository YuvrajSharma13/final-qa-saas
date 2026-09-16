import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import type { Box } from '../types.js';

/**
 * Compares a reference (mockup or approved baseline) with the rendered page.
 * Returns the changed-pixel ratio and clustered regions of change.
 */
export async function compareImages(reference: Buffer, actual: Buffer) {
  const refMeta = await sharp(reference).metadata();
  const actMeta = await sharp(actual).metadata();
  const width = refMeta.width!;
  // Resize the actual capture to the reference width so mockups exported at a different scale still compare.
  const scaledActual = actMeta.width === width ? actual : await sharp(actual).resize({ width }).png().toBuffer();
  const scaledMeta = await sharp(scaledActual).metadata();
  const h = Math.min(refMeta.height!, scaledMeta.height!, 4000);
  const a = await sharp(reference).extract({ left: 0, top: 0, width, height: h }).ensureAlpha().raw().toBuffer();
  const b = await sharp(scaledActual).extract({ left: 0, top: 0, width, height: h }).ensureAlpha().raw().toBuffer();
  const diff = Buffer.alloc(width * h * 4);
  const changed = pixelmatch(a, b, diff, width, h, { threshold: 0.12, includeAA: false });
  const regions = clusterDiff(diff, width, h);
  const heightDelta = Math.abs((refMeta.height || 0) - (scaledMeta.height || 0));
  const diffPng = await sharp(diff, { raw: { width, height: h, channels: 4 } }).png().toBuffer();
  return { ratio: changed / (width * h), changedPixels: changed, regions, heightDelta, width, height: h, diffPng };
}

/** Groups changed pixels into rectangles using a coarse grid + flood fill. */
export function clusterDiff(diff: Buffer, width: number, height: number, cell = 16): Box[] {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const grid = new Uint16Array(cols * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // pixelmatch paints differing pixels red (255, 0, 0)
      if (diff[i] === 255 && diff[i + 1] === 0 && diff[i + 2] === 0) grid[Math.floor(y / cell) * cols + Math.floor(x / cell)]++;
    }
  }
  const active = (c: number) => grid[c] > cell; // at least ~6% of the cell changed
  const seen = new Uint8Array(cols * rows);
  const boxes: Box[] = [];
  for (let c = 0; c < grid.length; c++) {
    if (!active(c) || seen[c]) continue;
    let minX = cols, minY = rows, maxX = 0, maxY = 0, count = 0;
    const stack = [c];
    seen[c] = 1;
    while (stack.length) {
      const cur = stack.pop()!;
      const cx = cur % cols;
      const cy = Math.floor(cur / cols);
      count++;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = ny * cols + nx;
        if (!seen[n] && active(n)) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (count >= 2) boxes.push({ x: minX * cell, y: minY * cell, width: (maxX - minX + 1) * cell, height: (maxY - minY + 1) * cell });
  }
  return boxes.sort((p, q) => q.width * q.height - p.width * p.height).slice(0, 6);
}
