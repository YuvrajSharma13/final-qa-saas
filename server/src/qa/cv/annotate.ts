import sharp from 'sharp';
import type { Box } from '../types.js';

const COLORS: Record<string, string> = { critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#2563eb' };
const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/** Draws labelled bounding boxes for detected visual defects on top of a screenshot. */
export async function annotate(png: Buffer, marks: { box: Box; label: string; severity: string }[]): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const w = meta.width!;
  const h = meta.height!;
  const parts = marks.map((m, i) => {
    const color = COLORS[m.severity] || COLORS.medium;
    const x = Math.max(1, Math.min(w - 3, m.box.x));
    const y = Math.max(1, Math.min(h - 3, m.box.y));
    const bw = Math.max(4, Math.min(w - x - 1, m.box.width));
    const bh = Math.max(4, Math.min(h - y - 1, m.box.height));
    const label = `${i + 1}. ${m.label}`.slice(0, 60);
    const tw = Math.min(w - 4, label.length * 7 + 12);
    const ty = y > 24 ? y - 22 : Math.min(h - 22, y + bh + 2);
    const tx = Math.max(2, Math.min(w - tw - 2, x));
    return `
      <rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-width="3" stroke-dasharray="8 4"/>
      <rect x="${tx}" y="${ty}" width="${tw}" height="20" rx="4" fill="${color}"/>
      <text x="${tx + 6}" y="${ty + 14}" font-family="DejaVu Sans, Arial, sans-serif" font-size="12" font-weight="700" fill="#fff">${esc(label)}</text>`;
  });
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${parts.join('')}</svg>`);
  return sharp(png).composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer();
}
