import type { Browser } from 'playwright-core';
import sharp from 'sharp';
import { askJson, llmEnabled } from '../../ai/llm.js';
import { VIEWPORTS } from '../../lib/plans.js';
import { sanitizeText } from '../../lib/sanitize.js';
import { storage } from '../../lib/storage.js';
import { Screenshot, type Severity } from '../../models/index.js';
import { instrumentedPage, settle } from '../browser.js';
import { annotate } from '../cv/annotate.js';
import { compareImages } from '../cv/diff.js';
import { clampBox, decode, regionStats, verifyClipEdge, type RawImage } from '../cv/imageOps.js';
import { saveScreenshot, saveTestCase } from '../evidence.js';
import { VISUAL_GEOMETRY, runInPage } from '../pageScripts.js';
import { executeSteps } from '../steps.js';
import type { Box, Finding, RunContext, TestPlan, VisualIssue } from '../types.js';

/**
 * Agent 4 — Vision QA (computer vision).
 * Input: screenshots + viewport data. Output: visual defects with regions, confidence and annotated evidence.
 *
 * Pipeline per page × viewport:
 *  1. Capture a full-page screenshot.
 *  2. Layout geometry pass to locate candidate elements (clipping, overflow, overlap, broken media).
 *  3. Pixel analysis on the screenshot to confirm each candidate (clip-edge paint continuity,
 *     luminance variance / Sobel edge density for empty image regions).
 *  4. Reference / baseline comparison (pixelmatch + diff clustering) when a reference exists.
 *  5. Optional vision-model review of the screenshot.
 *  6. Annotated evidence image with numbered regions.
 */

interface Geometry {
  viewportWidth: number;
  docWidth: number;
  docHeight: number;
  clipped: {
    selector: string;
    tag: string;
    classes: string[];
    type: string;
    text: string;
    interactive: boolean;
    box: Box;
    visibleFraction: number;
    side: 'left' | 'right' | 'top' | 'bottom';
    edge: number;
    byViewport: boolean;
    clipper: { selector: string; box: Box; overflow: string } | null;
    styles: Record<string, string>;
  }[];
  overflowOffenders: { selector: string; text: string; box: Box; styles: Record<string, string> }[];
  overlaps: { a: { selector: string; text: string; box: Box }; b: { selector: string; text: string; box: Box }; ratio: number }[];
  brokenImages: { selector: string; src: string; alt: string; box: Box }[];
}

const PRIMARY_TEXT = /order|checkout|pay|buy|submit|sign|log ?in|add|continue|save|book|send|next|confirm/i;

export function regionLabel(box: Box, width: number, height: number): string {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const h = cx < width / 3 ? 'left' : cx > (2 * width) / 3 ? 'right' : 'center';
  const v = cy < height / 3 ? 'top' : cy > (2 * height) / 3 ? 'bottom' : 'middle';
  return v === 'middle' && h === 'center' ? 'center' : `${v}-${h}`;
}

const px = (v: string | undefined) => (v && v.endsWith('px') ? parseFloat(v) : NaN);

export function explainClip(c: Geometry['clipped'][number]): string {
  const available = c.clipper ? c.clipper.box.width : undefined;
  const minW = px(c.styles.minWidth);
  const w = px(c.styles.width);
  if (!Number.isNaN(minW) && minW > 0 && available && minW > available * 0.9) {
    return `fixed min-width: ${minW}px on ${c.selector} inside ${c.clipper!.selector} (overflow: ${c.clipper!.overflow}, ${Math.round(available)}px wide)`;
  }
  if (c.clipper) return `element is ${Math.round(w || c.box.width)}px wide inside ${c.clipper.selector} (overflow: ${c.clipper.overflow}, ${Math.round(c.clipper.box.width)}px wide)`;
  return `element extends beyond the ${c.side} edge of the viewport`;
}

export function analyzeGeometry(geo: Geometry, img: RawImage, vpName: string): VisualIssue[] {
  const issues: VisualIssue[] = [];
  const vp = VIEWPORTS[vpName];
  for (const c of geo.clipped) {
    const pixel = verifyClipEdge(img, c.box, c.side, c.edge);
    const isPrimary = c.interactive && (c.tag === 'button' || c.type === 'submit' || PRIMARY_TEXT.test(c.text));
    const severity: Severity = isPrimary ? (c.visibleFraction < 0.5 ? 'high' : 'medium') : c.interactive ? 'medium' : 'low';
    const pct = Math.round(c.visibleFraction * 100);
    const label = c.text ? `“${c.text.slice(0, 40)}” ${c.tag === 'a' ? 'link' : c.tag}` : c.tag;
    issues.push({
      type: 'clipped_element',
      description: `${label} is clipped on ${vpName} (${vp.width}×${vp.height}): only ${pct}% visible, cut off at the ${c.side} edge of ${c.clipper ? c.clipper.selector : 'the viewport'}`,
      severity,
      confidence: pixel.confirmed ? 'high' : 'medium',
      region: c.box,
      regionLabel: regionLabel(c.box, img.width, Math.min(img.height, Math.max(vp.height, c.box.y + c.box.height))),
      element: { selector: c.selector, text: c.text, box: c.box, styles: c.styles, classes: c.classes },
      metrics: {
        visibleFraction: c.visibleFraction,
        clipSide: c.side,
        clipper: c.clipper?.selector || 'viewport',
        clipperWidth: c.clipper ? Math.round(c.clipper.box.width) : geo.viewportWidth,
        pixelEdgeConfirmed: pixel.confirmed,
        innerPaintMatch: pixel.innerMatch,
        outerPaintMatch: pixel.outerMatch,
        likelyCause: explainClip(c),
        tag: c.tag,
      },
      method: ['layout-geometry', 'pixel-edge-analysis'],
    });
  }
  if (geo.docWidth > geo.viewportWidth + 1) {
    const o = geo.overflowOffenders[0];
    issues.push({
      type: 'horizontal_overflow',
      description: `Page is ${geo.docWidth}px wide on a ${geo.viewportWidth}px viewport — content overflows horizontally${o ? ` (${o.selector})` : ''}`,
      severity: 'medium',
      confidence: 'high',
      region: o?.box || { x: geo.viewportWidth - 20, y: 0, width: 20, height: Math.min(geo.docHeight, 600) },
      regionLabel: o ? regionLabel(o.box, img.width, img.height) : 'right',
      element: o ? { selector: o.selector, text: o.text, box: o.box, styles: o.styles } : undefined,
      metrics: { docWidth: geo.docWidth, viewportWidth: geo.viewportWidth, overflowPx: geo.docWidth - geo.viewportWidth },
      method: ['layout-geometry'],
    });
  }
  for (const ov of geo.overlaps.slice(0, 3)) {
    const x = Math.min(ov.a.box.x, ov.b.box.x);
    const y = Math.min(ov.a.box.y, ov.b.box.y);
    const region = { x, y, width: Math.max(ov.a.box.x + ov.a.box.width, ov.b.box.x + ov.b.box.width) - x, height: Math.max(ov.a.box.y + ov.a.box.height, ov.b.box.y + ov.b.box.height) - y };
    const stats = regionStats(img, region);
    issues.push({
      type: 'overlapping_elements',
      description: `“${ov.a.text || ov.a.selector}” overlaps “${ov.b.text || ov.b.selector}” (${Math.round(ov.ratio * 100)}% of the smaller control)`,
      severity: 'medium',
      confidence: stats.edgeDensity > 0.05 ? 'high' : 'medium',
      region,
      regionLabel: regionLabel(region, img.width, img.height),
      element: { selector: ov.a.selector, text: ov.a.text, box: ov.a.box },
      metrics: { overlapRatio: ov.ratio, edgeDensity: Math.round(stats.edgeDensity * 1000) / 1000, other: ov.b.selector },
      method: ['layout-geometry', 'edge-density'],
    });
  }
  for (const b of geo.brokenImages.slice(0, 5)) {
    const stats = regionStats(img, clampBox(img, b.box));
    const path = safePath(b.src);
    issues.push({
      type: 'broken_image',
      description: `Image ${path}${b.alt ? ` (“${b.alt}”)` : ''} failed to render — the region shows no image content`,
      severity: 'low',
      confidence: stats.stdLum < 30 ? 'high' : 'medium',
      region: b.box,
      regionLabel: regionLabel(b.box, img.width, img.height),
      element: { selector: b.selector, text: b.alt, box: b.box },
      metrics: { src: path, luminanceStdDev: Math.round(stats.stdLum * 10) / 10, edgeDensity: Math.round(stats.edgeDensity * 1000) / 1000 },
      method: ['dom-media-state', 'luminance-variance'],
    });
  }
  return issues;
}

function safePath(src: string) {
  try {
    return new URL(src).pathname;
  } catch {
    return src;
  }
}

async function referenceIssue(ctx: RunContext, path: string, vpName: string, png: Buffer): Promise<VisualIssue | null> {
  const ref = await Screenshot.findOne({
    projectId: ctx.projectId,
    pagePath: path,
    'viewport.name': vpName,
    $or: [{ kind: 'reference' }, { isBaseline: true }],
  })
    .sort({ kind: -1, updatedAt: -1 })
    .lean();
  if (!ref) return null;
  const refPng = await storage.get(ref.imageRef);
  const cmp = await compareImages(refPng, png);
  ctx.log('vision_qa', `Compared ${path} @ ${vpName} with ${ref.kind === 'reference' ? 'reference mockup' : 'approved baseline'}: ${(cmp.ratio * 100).toFixed(2)}% pixels differ`);
  if (cmp.ratio < 0.01 && cmp.heightDelta < 40) return null;
  const main = cmp.regions[0] || { x: 0, y: 0, width: cmp.width, height: Math.min(cmp.height, 300) };
  const scale = (await sharp(png).metadata()).width! / cmp.width;
  const region = { x: main.x * scale, y: main.y * scale, width: main.width * scale, height: main.height * scale };
  return {
    type: 'reference_mismatch',
    description: `Rendered page differs from the ${ref.kind === 'reference' ? 'reference mockup' : 'approved baseline'} by ${(cmp.ratio * 100).toFixed(1)}% of pixels (${cmp.regions.length} changed region(s)${cmp.heightDelta ? `, height differs by ${cmp.heightDelta}px` : ''})`,
    severity: cmp.ratio > 0.08 || cmp.heightDelta > 150 ? 'medium' : 'low',
    confidence: 'medium',
    region,
    regionLabel: regionLabel(region, cmp.width * scale, cmp.height * scale),
    metrics: { diffRatio: Math.round(cmp.ratio * 10000) / 10000, changedRegions: cmp.regions.length, heightDelta: cmp.heightDelta, referenceId: String(ref._id) },
    method: ['pixelmatch-diff', 'diff-clustering'],
  };
}

async function llmIssues(ctx: RunContext, png: Buffer, vpName: string, path: string): Promise<VisualIssue[]> {
  if (!llmEnabled()) return [];
  const meta = await sharp(png).metadata();
  const maxH = Math.min(meta.height!, 2400);
  const img = await sharp(png).extract({ left: 0, top: 0, width: meta.width!, height: maxH }).resize({ width: Math.min(meta.width!, 800) }).png().toBuffer();
  const scale = meta.width! / Math.min(meta.width!, 800);
  ctx.aiCalls++;
  const out = await askJson<{ issues?: { issue: string; severity: Severity; confidence: 'high' | 'medium' | 'low'; box?: Box }[] }>({
    system: 'You are a meticulous visual QA engineer reviewing web page screenshots for UI defects (clipped or overlapping elements, unreadable text, broken images, misalignment). Only report real, visible defects.',
    prompt: `Screenshot of ${path} at the ${vpName} viewport (${VIEWPORTS[vpName].width}px wide, image scaled by 1/${scale.toFixed(2)}). Return {"issues":[{"issue":"...","severity":"low|medium|high","confidence":"low|medium|high","box":{"x":0,"y":0,"width":0,"height":0}}]} with coordinates in the image you see. Return {"issues":[]} if the page looks correct.`,
    images: [img],
    maxTokens: 800,
  });
  return (out?.issues || []).slice(0, 5).map((i) => {
    const box = i.box ? { x: i.box.x * scale, y: i.box.y * scale, width: i.box.width * scale, height: i.box.height * scale } : { x: 0, y: 0, width: meta.width!, height: 40 };
    return {
      type: 'ai_visual_defect' as const,
      description: sanitizeText(i.issue, 200),
      severity: (['low', 'medium', 'high'].includes(i.severity) ? i.severity : 'low') as Severity,
      confidence: i.confidence || 'low',
      region: box,
      regionLabel: regionLabel(box, meta.width!, maxH),
      method: ['vision-model'],
    };
  });
}

export async function runVisionAgent(ctx: RunContext, browser: Browser, plan: TestPlan) {
  const findings: Finding[] = [];
  const results: Record<string, unknown>[] = [];
  let passed = 0;
  let failed = 0;
  const captures: { target: string; viewport: string; clippedSelectors: string[] }[] = [];
  for (const target of plan.visualTargets) {
    for (const vpName of ctx.viewports) {
      if (ctx.isCanceled()) break;
      const vp = VIEWPORTS[vpName];
      const ip = await instrumentedPage(browser, ctx.appUrl, vpName);
      try {
        if (target.setup.length) await executeSteps(ip, target.setup, { baseUrl: ctx.appUrl, stopOnFailure: false });
        await ip.page.goto(new URL(target.path, ctx.appUrl).toString(), { waitUntil: 'load' });
        await settle(ip.page);
        await ip.page.evaluate('document.fonts && document.fonts.ready').catch(() => undefined);
        await ip.page.waitForTimeout(250);
        const geo = await runInPage<Geometry>(ip.page, VISUAL_GEOMETRY);
        const fullHeight = Math.min(geo.docHeight, 4000);
        const png = await ip.page.screenshot({ fullPage: fullHeight === geo.docHeight, clip: fullHeight === geo.docHeight ? undefined : { x: 0, y: 0, width: vp.width, height: fullHeight } });
        const img = await decode(png);
        const issues = analyzeGeometry(geo, img, vpName);
        const ref = await referenceIssue(ctx, target.path, vpName, png).catch((err) => {
          ctx.log('vision_qa', `Reference comparison failed: ${(err as Error).message}`, 'warn');
          return null;
        });
        if (ref) issues.push(ref);
        issues.push(...(await llmIssues(ctx, png, vpName, target.path)));

        const annotated = issues.length ? await annotate(png, issues.map((i) => ({ box: i.region, label: i.type.replace(/_/g, ' '), severity: i.severity }))) : undefined;
        const shot = await saveScreenshot(ctx, png, {
          agentType: 'vision_qa',
          viewport: { name: vp.name, width: vp.width, height: vp.height },
          url: ip.page.url(),
          pagePath: target.path,
          annotations: issues.map((i, n) => ({ n: n + 1, type: i.type, label: i.description, severity: i.severity, confidence: i.confidence, box: i.region, region: i.regionLabel, method: i.method })),
          annotated,
        });
        const status = issues.length ? 'failed' : 'passed';
        const testCaseId = await saveTestCase(ctx, {
          agentType: 'vision_qa',
          category: 'visual',
          kind: 'visual_inspection',
          name: `Visual QA: ${target.path} @ ${vp.name} (${vp.width}×${vp.height})`,
          target: target.path,
          expected: 'No clipped, overflowing or overlapping elements; all media renders; matches reference if provided',
          actual: issues.length ? issues.map((i) => i.description).join(' · ') : 'No visual defects detected',
          status,
          evidence: { screenshotIds: [String(shot._id)], issues, geometry: { docWidth: geo.docWidth, docHeight: geo.docHeight, viewportWidth: geo.viewportWidth } },
        });
        if (issues.length) failed++;
        else passed++;
        captures.push({ target: target.path, viewport: vpName, clippedSelectors: geo.clipped.map((c) => c.selector) });
        ctx.log('vision_qa', `${issues.length ? '✗' : '✓'} ${target.path} @ ${vp.width}×${vp.height}: ${issues.length ? issues.map((i) => i.type).join(', ') : 'no visual defects'}`, issues.length ? 'warn' : 'info');
        for (const issue of issues) {
          results.push({
            viewport: `${vp.width}x${vp.height}`,
            page: target.path,
            issue: issue.description,
            type: issue.type,
            severity: issue.severity,
            region: issue.regionLabel,
            confidence: issue.confidence,
          });
          findings.push({
            source: 'vision',
            testCaseId: String(testCaseId),
            title: issue.description,
            symptom: issue.type,
            page: target.path,
            viewport: vpName,
            element: issue.element,
            expected: 'Element fully visible and correctly laid out',
            actual: issue.description,
            severityHint: issue.severity,
            confidence: issue.confidence,
            screenshotIds: [String(shot._id)],
            network: [],
            console: [],
            details: { ...issue.metrics, region: issue.regionLabel, box: issue.region, method: issue.method, imageSrc: issue.type === 'broken_image' ? issue.metrics?.src : undefined, setup: target.setup },
          });
        }
      } catch (err) {
        ctx.log('vision_qa', `Could not capture ${target.path} @ ${vpName}: ${(err as Error).message.split('\n')[0]}`, 'warn');
        await saveTestCase(ctx, {
          agentType: 'vision_qa',
          category: 'visual',
          kind: 'visual_inspection',
          name: `Visual QA: ${target.path} @ ${vp.name} (${vp.width}×${vp.height})`,
          target: target.path,
          expected: 'Page can be captured',
          actual: (err as Error).message.split('\n')[0],
          status: 'error',
        });
      } finally {
        await ip.close();
      }
    }
  }
  // Cross-viewport comparison: record where each clipped element renders correctly.
  for (const f of findings) {
    if (f.symptom !== 'clipped_element' || !f.element) continue;
    const okOn = captures.filter((c) => c.target === f.page && !c.clippedSelectors.includes(f.element!.selector)).map((c) => c.viewport);
    f.details = { ...f.details, fullyVisibleOn: okOn };
  }
  return {
    findings,
    stats: { executed: passed + failed, passed, failed },
    output: { summary: { captures: captures.length, passed, failed, engine: llmEnabled() ? 'cv+vision-model' : 'cv' }, results },
  };
}
