// In-page scripts, kept as plain JS strings so the TS toolchain cannot inject
// helpers into them before Playwright serialises them into the browser.
import type { Page } from 'playwright-core';

export async function runInPage<T>(page: Page, script: string, arg: unknown = null): Promise<T> {
  return page.evaluate(`(${script})(${JSON.stringify(arg)})`) as Promise<T>;
}

const HELPERS = `
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.02;
  };
  const cssPath = (el) => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    const tid = el.getAttribute('data-testid');
    if (tid) return '[data-testid="' + tid + '"]';
    const tag = el.tagName.toLowerCase();
    if (el.getAttribute('name') && ['input', 'textarea', 'select'].includes(tag)) return tag + '[name="' + el.getAttribute('name') + '"]';
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 5) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift('#' + CSS.escape(cur.id) + (parts.length ? '' : '')); break; }
      const cls = [...cur.classList].filter((c) => /^[a-zA-Z][\\w-]{1,40}$/.test(c)).slice(0, 2);
      if (cls.length) part += '.' + cls.join('.');
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName && (cls.length === 0 || cls.every((k) => c.classList.contains(k))));
        if (same.length > 1) part += ':nth-of-type(' + ([...parent.children].filter((c) => c.tagName === cur.tagName).indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      if (document.querySelectorAll(parts.join(' > ')).length === 1) break;
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  const text = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  const MONEY = /(?:[$€£₹]|USD|EUR|INR|GBP)\\s?(-?\\d{1,3}(?:[,\\s]\\d{3})*(?:\\.\\d{1,2})?|-?\\d+(?:\\.\\d{1,2})?)/g;
  const moneyValues = (s) => { const out = []; let m; MONEY.lastIndex = 0; while ((m = MONEY.exec(s || ''))) out.push(parseFloat(m[1].replace(/[,\\s]/g, ''))); return out; };
`;

/** Structural discovery used by the Test Planner. */
export const DISCOVER_PAGE = `(arg) => {
  ${HELPERS}
  const labelFor = (el) => {
    const l = (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '';
    return l.replace(/\\s+/g, ' ').trim();
  };
  const semantic = (el) => {
    const hay = [el.type, el.name, el.id, el.getAttribute('autocomplete'), labelFor(el)].join(' ').toLowerCase();
    if (el.type === 'password') return 'password';
    if (el.type === 'email' || /e-?mail/.test(hay)) return 'email';
    if (/user(name)?|login/.test(hay)) return 'username';
    if (el.type === 'tel' || /phone|mobile|tel/.test(hay)) return 'phone';
    if (/address|street|city|zip|postal/.test(hay)) return 'address';
    if (/name/.test(hay)) return 'name';
    if (el.type === 'number') return 'number';
    if (el.tagName === 'TEXTAREA' || el.type === 'text' || el.type === 'search' || !el.type) return 'text';
    return 'other';
  };
  const locatorFor = (el) => {
    const l = labelFor(el);
    const css = cssPath(el);
    return { css };
  };
  const formRoots = [...document.querySelectorAll('form')];
  const loosePw = [...document.querySelectorAll('input[type=password]')].filter((i) => !i.closest('form'));
  if (loosePw.length) formRoots.push(loosePw[0].parentElement.parentElement || document.body);
  const forms = formRoots.map((f) => {
    const fields = [...f.querySelectorAll('input, textarea, select')]
      .filter((el) => !['hidden', 'submit', 'button', 'reset', 'image'].includes(el.type) && isVisible(el))
      .map((el) => ({ locator: locatorFor(el), type: el.type || el.tagName.toLowerCase(), name: el.name || el.id || '', label: labelFor(el), required: !!el.required, semantic: semantic(el) }));
    const submitEl = f.querySelector('button[type=submit], input[type=submit]') || [...f.querySelectorAll('button')].find((b) => !b.type || b.type === 'submit');
    return { fields, submit: submitEl ? { css: cssPath(submitEl) } : null, submitText: submitEl ? text(submitEl) : '' };
  }).filter((f) => f.fields.length > 0);

  const buttons = [...document.querySelectorAll('button, [role=button], input[type=button]')].filter(isVisible);
  const addBtns = buttons.filter((b) => /^(\\+\\s*)?add( to (cart|basket|bag|order))?$|add to (cart|basket|bag)/i.test(text(b)));
  const origin = location.origin;
  const links = [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, text: text(a) })).filter((l) => l.href.startsWith(origin));
  const scripts = [...document.querySelectorAll('script[src]')].map((s) => s.src).filter((s) => s.startsWith(origin));
  return {
    title: document.title,
    headings: [...document.querySelectorAll('h1, h2')].filter(isVisible).map(text).slice(0, 8),
    forms,
    addToCart: addBtns.length ? { locator: { role: 'button', name: text(addBtns[0]) }, count: addBtns.length } : null,
    links,
    scripts,
    images: document.images.length,
    hasQuantityInputs: !!document.querySelector('input[type=number]'),
    bodyText: (document.body.innerText || '').slice(0, 1500),
  };
}`;

/** Checks that line subtotals and the grand total agree with unit price × quantity. */
export const CART_MATH = `() => {
  ${HELPERS}
  const inputs = [...document.querySelectorAll('input[type=number], input[name*=qty i], input[name*=quantity i], input[aria-label*=quantity i]')].filter(isVisible);
  const rows = [];
  for (const input of inputs) {
    const row = input.closest('tr, li, [class*=line], [class*=item], [class*=row]');
    if (!row) continue;
    const clone = row.cloneNode(true);
    clone.querySelectorAll('input').forEach((i) => i.remove());
    const values = moneyValues(clone.innerText || clone.textContent);
    if (values.length === 0) continue;
    const qty = parseFloat(input.value);
    rows.push({ name: text(row).split(' $')[0].slice(0, 60), unit: values[0], line: values[values.length - 1], qty, hasLine: values.length > 1 });
  }
  let total = null; let totalSelector = null;
  const candidates = [...document.querySelectorAll('[data-testid*=total i], [id*=total i], [class*=total i]')].filter(isVisible);
  for (const el of candidates) {
    const v = moneyValues(el.innerText);
    if (v.length && !/sub-?total/i.test((el.id || '') + (el.className || ''))) { total = v[v.length - 1]; totalSelector = cssPath(el); }
  }
  if (total === null) {
    const all = [...document.querySelectorAll('body *')].filter((el) => el.children.length <= 3 && isVisible(el));
    for (const el of all) {
      const t = (el.innerText || '').trim();
      if (/^(grand\\s+)?total\\b/i.test(t) && t.length < 60) { const v = moneyValues(t); if (v.length) { total = v[v.length - 1]; totalSelector = cssPath(el); } }
    }
  }
  const round = (n) => Math.round(n * 100) / 100;
  const expectedTotal = round(rows.reduce((s, r) => s + r.unit * r.qty, 0));
  const sumUnits = round(rows.reduce((s, r) => s + r.unit, 0));
  const sumLines = round(rows.reduce((s, r) => s + r.line, 0));
  const lineProblems = rows.filter((r) => r.hasLine && Math.abs(r.unit * r.qty - r.line) > 0.011).map((r) => r.name + ': ' + r.qty + ' × ' + r.unit + ' shown as ' + r.line);
  return { rows, total, totalSelector, expectedTotal, sumUnits, sumLines, lineProblems };
}`;

/** Returns images that failed to decode. */
export const BROKEN_IMAGES = `() => {
  ${HELPERS}
  return [...document.images]
    .filter((img) => img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src))
    .map((img) => { const r = img.getBoundingClientRect(); return { src: img.currentSrc || img.src, alt: img.alt, selector: cssPath(img), box: { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height } }; });
}`;

/** Visibility of one element after ancestor overflow clipping and viewport clipping. */
export const ELEMENT_VISIBILITY = `(css) => {
  const el = document.querySelector(css);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  let l = 0, t = -1e9, rr = innerWidth, b = 1e9;
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const s = getComputedStyle(p);
    const pr = p.getBoundingClientRect();
    const bl = parseFloat(s.borderLeftWidth) || 0, br = parseFloat(s.borderRightWidth) || 0, bt = parseFloat(s.borderTopWidth) || 0, bb = parseFloat(s.borderBottomWidth) || 0;
    if (['hidden', 'clip'].includes(s.overflowX)) { l = Math.max(l, pr.left + bl); rr = Math.min(rr, pr.right - br); }
    if (['hidden', 'clip'].includes(s.overflowY)) { t = Math.max(t, pr.top + bt); b = Math.min(b, pr.bottom - bb); }
  }
  const w = Math.max(0, Math.min(r.right, rr) - Math.max(r.left, l));
  const h = Math.max(0, Math.min(r.bottom, b) - Math.max(r.top, t));
  return { fraction: r.width * r.height > 0 ? (w * h) / (r.width * r.height) : 0, width: r.width, visibleWidth: w };
}`;

/** Geometry pass for the Vision agent: clipping, overflow, overlap and broken images. */
export const VISUAL_GEOMETRY = `() => {
  ${HELPERS}
  const vw = document.documentElement.clientWidth;
  const sx = scrollX, sy = scrollY;
  const box = (r) => ({ x: Math.round(r.left + sx), y: Math.round(r.top + sy), width: Math.round(r.width), height: Math.round(r.height) });
  const INTERACTIVE = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button]';
  const TEXTUAL = 'h1, h2, h3, h4, p, label, li, td, th, strong, span, img';
  const clipped = [];
  const seen = new Set();
  const candidates = [...document.querySelectorAll(INTERACTIVE + ', ' + TEXTUAL)].filter(isVisible);
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if ([...seen].some((s) => s.contains(el))) continue;
    let cl = -1e9, ct = -1e9, cr = 1e9, cb = 1e9, clipper = null, clipperRect = null;
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const s = getComputedStyle(p);
      const pr = p.getBoundingClientRect();
      const bl = parseFloat(s.borderLeftWidth) || 0, br = parseFloat(s.borderRightWidth) || 0, bt = parseFloat(s.borderTopWidth) || 0, bb = parseFloat(s.borderBottomWidth) || 0;
      let reduced = false;
      if (['hidden', 'clip'].includes(s.overflowX)) {
        if (pr.left + bl > r.left + 0.5 || pr.right - br < r.right - 0.5) reduced = true;
        cl = Math.max(cl, pr.left + bl); cr = Math.min(cr, pr.right - br);
      }
      if (['hidden', 'clip'].includes(s.overflowY)) {
        if (pr.top + bt > r.top + 0.5 || pr.bottom - bb < r.bottom - 0.5) reduced = true;
        ct = Math.max(ct, pr.top + bt); cb = Math.min(cb, pr.bottom - bb);
      }
      if (reduced && !clipper) { clipper = p; clipperRect = { left: pr.left + bl, right: pr.right - br, top: pr.top + bt, bottom: pr.bottom - bb }; }
    }
    let byViewport = false;
    if (r.right > vw + 0.5 || r.left < -0.5) { byViewport = true; cl = Math.max(cl, 0); cr = Math.min(cr, vw); }
    const w = Math.max(0, Math.min(r.right, cr) - Math.max(r.left, cl));
    const h = Math.max(0, Math.min(r.bottom, cb) - Math.max(r.top, ct));
    const fraction = (w * h) / (r.width * r.height);
    if (fraction >= 0.98 || fraction <= 0.02) continue; // fully visible, or intentionally hidden (sr-only, carousels)
    const s = getComputedStyle(el);
    const isInteractive = el.matches(INTERACTIVE);
    if (!isInteractive && !text(el)) continue;
    seen.add(el);
    let side = 'right';
    if (clipperRect || byViewport) {
      const right = clipperRect ? Math.min(clipperRect.right, byViewport ? vw : 1e9) : vw;
      const left = clipperRect ? clipperRect.left : 0;
      if (r.right > right + 0.5) side = 'right';
      else if (r.left < left - 0.5) side = 'left';
      else if (clipperRect && r.bottom > clipperRect.bottom + 0.5) side = 'bottom';
      else side = 'top';
    }
    const edge = side === 'right' ? Math.min(cr, vw) : side === 'left' ? Math.max(cl, 0) : side === 'bottom' ? cb : ct;
    clipped.push({
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      classes: [...el.classList].slice(0, 6),
      type: el.getAttribute('type') || '',
      text: text(el),
      interactive: isInteractive,
      box: box(r),
      visibleFraction: Math.round(fraction * 1000) / 1000,
      side,
      edge: Math.round(side === 'left' || side === 'right' ? edge + sx : edge + sy),
      byViewport: byViewport && !clipper,
      clipper: clipper ? { selector: cssPath(clipper), box: box(clipper.getBoundingClientRect()), overflow: getComputedStyle(clipper).overflow } : null,
      styles: { width: s.width, minWidth: s.minWidth, maxWidth: s.maxWidth, flexShrink: s.flexShrink, whiteSpace: s.whiteSpace, textAlign: s.textAlign, backgroundColor: s.backgroundColor },
    });
  }

  const docWidth = document.documentElement.scrollWidth;
  const overflowOffenders = docWidth > vw + 1
    ? [...document.querySelectorAll('body *')].filter((el) => { const r = el.getBoundingClientRect(); return isVisible(el) && r.right > vw + 1 && !(el.parentElement && el.parentElement.getBoundingClientRect().right > vw + 1); })
        .slice(0, 5).map((el) => ({ selector: cssPath(el), text: text(el), box: box(el.getBoundingClientRect()), styles: { width: getComputedStyle(el).width, minWidth: getComputedStyle(el).minWidth } }))
    : [];

  const inter = [...document.querySelectorAll(INTERACTIVE)].filter(isVisible).slice(0, 300);
  const overlaps = [];
  for (let i = 0; i < inter.length; i++) {
    for (let j = i + 1; j < inter.length; j++) {
      const a = inter[i], b = inter[j];
      if (a.contains(b) || b.contains(a)) continue;
      const pa = getComputedStyle(a).position, pb = getComputedStyle(b).position;
      if (pa === 'fixed' || pb === 'fixed' || pa === 'sticky' || pb === 'sticky') continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const ix = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
      const iy = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
      const minArea = Math.min(ra.width * ra.height, rb.width * rb.height);
      if (minArea > 0 && (ix * iy) / minArea > 0.3) {
        overlaps.push({ a: { selector: cssPath(a), text: text(a), box: box(ra) }, b: { selector: cssPath(b), text: text(b), box: box(rb) }, ratio: Math.round(((ix * iy) / minArea) * 100) / 100 });
      }
      if (overlaps.length >= 10) break;
    }
  }
  const brokenImages = [...document.images]
    .filter((img) => img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src) && isVisible(img))
    .map((img) => ({ selector: cssPath(img), src: img.currentSrc || img.src, alt: img.alt, box: box(img.getBoundingClientRect()) }));
  return { viewportWidth: vw, docWidth, docHeight: document.documentElement.scrollHeight, clipped, overflowOffenders, overlaps, brokenImages, bodyBg: getComputedStyle(document.body).backgroundColor };
}`;
