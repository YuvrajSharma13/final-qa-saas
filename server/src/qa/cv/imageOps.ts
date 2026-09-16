import sharp from 'sharp';
import type { Box } from '../types.js';

/** Raw RGB image with helpers for pixel-level computer-vision checks. */
export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

export async function decode(png: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

export type RGB = [number, number, number];

export function px(img: RawImage, x: number, y: number): RGB {
  const xi = Math.max(0, Math.min(img.width - 1, Math.round(x)));
  const yi = Math.max(0, Math.min(img.height - 1, Math.round(y)));
  const i = (yi * img.width + xi) * img.channels;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

const lum = ([r, g, b]: RGB) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export const colorDist = (a: RGB, b: RGB) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

export function clampBox(img: RawImage, b: Box): Box {
  const x = Math.max(0, Math.floor(b.x));
  const y = Math.max(0, Math.floor(b.y));
  const r = Math.min(img.width, Math.ceil(b.x + b.width));
  const btm = Math.min(img.height, Math.ceil(b.y + b.height));
  return { x, y, width: Math.max(0, r - x), height: Math.max(0, btm - y) };
}

/** Most common colour inside a region (4-bit quantised histogram). */
export function dominantColor(img: RawImage, box: Box): RGB | null {
  const b = clampBox(img, box);
  if (!b.width || !b.height) return null;
  const hist = new Map<number, { n: number; r: number; g: number; b: number }>();
  const step = Math.max(1, Math.floor(Math.sqrt((b.width * b.height) / 4000)));
  for (let y = b.y; y < b.y + b.height; y += step) {
    for (let x = b.x; x < b.x + b.width; x += step) {
      const c = px(img, x, y);
      const key = ((c[0] >> 4) << 8) | ((c[1] >> 4) << 4) | (c[2] >> 4);
      const e = hist.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++;
      e.r += c[0];
      e.g += c[1];
      e.b += c[2];
      hist.set(key, e);
    }
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const e of hist.values()) if (!best || e.n > best.n) best = e;
  return best ? [best.r / best.n, best.g / best.n, best.b / best.n] : null;
}

/** Luminance mean / std-dev and Sobel edge density for a region. */
export function regionStats(img: RawImage, box: Box) {
  const b = clampBox(img, box);
  if (b.width < 3 || b.height < 3) return { meanLum: 0, stdLum: 0, edgeDensity: 0, pixels: 0 };
  let sum = 0;
  let sq = 0;
  let n = 0;
  let edges = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((b.width * b.height) / 20000)));
  for (let y = b.y + 1; y < b.y + b.height - 1; y += step) {
    for (let x = b.x + 1; x < b.x + b.width - 1; x += step) {
      const l = lum(px(img, x, y));
      sum += l;
      sq += l * l;
      n++;
      const gx = lum(px(img, x + 1, y - 1)) + 2 * lum(px(img, x + 1, y)) + lum(px(img, x + 1, y + 1)) - lum(px(img, x - 1, y - 1)) - 2 * lum(px(img, x - 1, y)) - lum(px(img, x - 1, y + 1));
      const gy = lum(px(img, x - 1, y + 1)) + 2 * lum(px(img, x, y + 1)) + lum(px(img, x + 1, y + 1)) - lum(px(img, x - 1, y - 1)) - 2 * lum(px(img, x, y - 1)) - lum(px(img, x + 1, y - 1));
      if (Math.sqrt(gx * gx + gy * gy) > 60) edges++;
    }
  }
  const mean = sum / n;
  return { meanLum: mean, stdLum: Math.sqrt(Math.max(0, sq / n - mean * mean)), edgeDensity: edges / n, pixels: n };
}

/**
 * Confirms from pixels that an element is visually cut at a clipping edge:
 * the element's own paint must run right up to the edge on the inside, and
 * must not continue on the outside.
 */
export function verifyClipEdge(img: RawImage, element: Box, side: 'left' | 'right' | 'top' | 'bottom', edge: number) {
  const inner: Box =
    side === 'right'
      ? { x: edge - 3, y: element.y + element.height * 0.2, width: 2, height: element.height * 0.6 }
      : side === 'left'
        ? { x: edge + 1, y: element.y + element.height * 0.2, width: 2, height: element.height * 0.6 }
        : side === 'bottom'
          ? { x: element.x + element.width * 0.2, y: edge - 3, width: element.width * 0.6, height: 2 }
          : { x: element.x + element.width * 0.2, y: edge + 1, width: element.width * 0.6, height: 2 };
  const outer: Box =
    side === 'right'
      ? { x: edge + 2, y: inner.y, width: 2, height: inner.height }
      : side === 'left'
        ? { x: edge - 4, y: inner.y, width: 2, height: inner.height }
        : side === 'bottom'
          ? { x: inner.x, y: edge + 2, width: inner.width, height: 2 }
          : { x: inner.x, y: edge - 4, width: inner.width, height: 2 };
  // Paint colour of the visible part of the element (e.g. the button fill).
  const visible: Box =
    side === 'right'
      ? { x: element.x, y: element.y, width: Math.max(1, edge - element.x), height: element.height }
      : side === 'left'
        ? { x: edge, y: element.y, width: Math.max(1, element.x + element.width - edge), height: element.height }
        : side === 'bottom'
          ? { x: element.x, y: element.y, width: element.width, height: Math.max(1, edge - element.y) }
          : { x: element.x, y: edge, width: element.width, height: Math.max(1, element.y + element.height - edge) };
  const paint = dominantColor(img, visible);
  if (!paint) return { confirmed: false, innerMatch: 0, outerMatch: 0, paint: null as RGB | null };
  const matchFraction = (b: Box) => {
    const c = clampBox(img, b);
    if (!c.width || !c.height) return -1;
    let m = 0;
    let n = 0;
    for (let y = c.y; y < c.y + c.height; y++) {
      for (let x = c.x; x < c.x + c.width; x++) {
        n++;
        if (colorDist(px(img, x, y), paint) < 48) m++;
      }
    }
    return m / n;
  };
  const innerMatch = matchFraction(inner);
  const outerMatch = matchFraction(outer);
  const confirmed = innerMatch > 0.6 && (outerMatch < 0 || outerMatch < 0.4);
  return { confirmed, innerMatch: round(innerMatch), outerMatch: round(outerMatch), paint: paint.map(Math.round) as RGB };
}

const round = (n: number) => Math.round(n * 100) / 100;

export async function crop(png: Buffer, box: Box): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const b = {
    left: Math.max(0, Math.floor(box.x)),
    top: Math.max(0, Math.floor(box.y)),
    width: Math.max(1, Math.min(Math.ceil(box.width), (meta.width || 1) - Math.max(0, Math.floor(box.x)))),
    height: Math.max(1, Math.min(Math.ceil(box.height), (meta.height || 1) - Math.max(0, Math.floor(box.y)))),
  };
  return sharp(png).extract(b).png().toBuffer();
}
