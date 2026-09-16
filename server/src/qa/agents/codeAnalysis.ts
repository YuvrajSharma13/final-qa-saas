import fs from 'node:fs/promises';
import path from 'node:path';
import type { Types } from 'mongoose';
import { askJson, llmEnabled } from '../../ai/llm.js';
import { config } from '../../config.js';
import { sanitizeText } from '../../lib/sanitize.js';
import { Bug, type BugDoc } from '../../models/index.js';
import type { RunContext } from '../types.js';

/**
 * Agent 6 — Code Analysis.
 * Input: consolidated bugs + repository access. Output: likely cause + file/line references + suggested patch.
 * Never modifies the repository: fixes are proposed as patches for a developer to review.
 */

export interface RepoFile {
  path: string;
  content: string;
}

const EXT = /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte|css|scss|sass|less|html|htm|py|rb|go|php|java|kt|cs|json)$/i;
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|coverage|storage|\.next|vendor|__pycache__|\.venv|test-results)(\/|$)/;

export async function loadLocalRepo(root: string): Promise<RepoFile[]> {
  const files: RepoFile[] = [];
  async function walk(dir: string) {
    if (files.length >= 800) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (SKIP_DIR.test(rel) || e.name.startsWith('.')) continue;
      if (e.isDirectory()) await walk(full);
      else if (EXT.test(e.name) && !/package-lock|yarn\.lock|\.min\./.test(e.name)) {
        const stat = await fs.stat(full);
        if (stat.size <= 300_000) files.push({ path: rel, content: await fs.readFile(full, 'utf8') });
      }
    }
  }
  await walk(root);
  return files;
}

export async function loadGithubRepo(repoUrl: string, token: string, relevance: (p: string) => number, log: (m: string) => void): Promise<RepoFile[]> {
  const m = repoUrl.match(/github\.com\/([\w.-]+)\/([\w.-]+)/);
  if (!m) throw new Error('Unsupported repository URL');
  const [, owner, repo] = m;
  const headers: Record<string, string> = { 'User-Agent': 'ai-qa-saas', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const gh = async (url: string) => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url.replace(/\?.*/, '')}`);
    return res.json() as Promise<Record<string, unknown>>;
  };
  const meta = await gh(`https://api.github.com/repos/${owner}/${repo}`);
  const branch = String(meta.default_branch || 'main');
  const tree = (await gh(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`)) as { tree?: { path: string; type: string; size?: number }[] };
  const candidates = (tree.tree || [])
    .filter((t) => t.type === 'blob' && EXT.test(t.path) && !SKIP_DIR.test(t.path) && (t.size ?? 0) <= 300_000)
    .sort((a, b) => relevance(b.path) - relevance(a.path))
    .slice(0, 80);
  log(`GitHub ${owner}/${repo}@${branch}: fetching ${candidates.length} candidate files`);
  const files: RepoFile[] = [];
  for (const c of candidates) {
    const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${c.path.split('/').map(encodeURIComponent).join('/')}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);
    if (res?.ok) files.push({ path: c.path, content: await res.text() });
  }
  return files;
}

interface Term {
  text: string;
  weight: number;
  kind: string;
}

type Loc = { classes?: string[]; pages?: string[]; routes?: string[]; selectors?: string[]; texts?: string[]; imageSrc?: string; workflow?: string; scenarioKinds?: string[]; apiKinds?: string[]; clipper?: string; styles?: Record<string, string> };

export function searchTerms(bug: Pick<BugDoc, 'category' | 'title' | 'location'>): Term[] {
  const loc = (bug.location || {}) as Loc;
  const terms: Term[] = [];
  const add = (text: string | undefined, weight: number, kind: string) => {
    if (text && text.length >= 3 && !terms.some((t) => t.text.toLowerCase() === text.toLowerCase())) terms.push({ text, weight, kind });
  };
  for (const r of loc.routes || []) {
    const [, p] = r.split(' ');
    const segs = p.split('/').filter((s) => s && s !== 'api' && s !== ':id');
    const last = segs[segs.length - 1];
    add(`'/${segs.join('/')}`, 8, 'route');
    add(`"/${segs.join('/')}`, 8, 'route');
    add(`/${segs.join('/')}`, 6, 'route');
    if (last) add(last, 2, 'noun');
  }
  for (const p of loc.pages || []) add(p.split('/').filter(Boolean).pop()?.replace(/\.html?$/, ''), 2, 'noun');
  for (const s of loc.selectors || []) {
    for (const cls of s.match(/\.([a-zA-Z][\w-]+)/g) || []) add(cls.slice(1), 6, 'selector');
    for (const id of s.match(/#([a-zA-Z][\w-]+)/g) || []) add(id.slice(1), 6, 'selector');
  }
  const GENERIC = /^(btn|button|card|container|row|col|primary|secondary|active|hidden|body|wrapper|content|item|link|nav|form|input|label|title|text)$/i;
  for (const cls of loc.classes || []) if (!GENERIC.test(cls)) add(cls, 6, 'selector');
  if (loc.clipper) for (const cls of String(loc.clipper).match(/\.([a-zA-Z][\w-]+)/g) || []) add(cls.slice(1), 4, 'selector');
  for (const t of loc.texts || []) add(t, 5, 'text');
  if (loc.imageSrc) add(loc.imageSrc.split('/').pop(), 10, 'asset');
  const kinds = [...(loc.scenarioKinds || []), ...(loc.apiKinds || [])];
  if (kinds.some((k) => k.startsWith('auth')) || kinds.includes('invalid_credentials')) ['login', 'password'].forEach((t) => add(t, 2, 'noun'));
  if (/total/i.test(bug.title)) ['total', 'quantity', 'reduce'].forEach((t) => add(t, 2, 'noun'));
  if (kinds.includes('checkout_special_chars')) ['JSON.parse', 'receipt', 'greeting'].forEach((t) => add(t, 3, 'noun'));
  return terms;
}

const count = (hay: string, needle: string) => {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1 && n < 5) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
};

export function rankFiles(files: RepoFile[], terms: Term[], category: string) {
  return files
    .map((f) => {
      let score = 0;
      const lower = f.content.toLowerCase();
      for (const t of terms) {
        const n = t.kind === 'text' ? count(lower, t.text.toLowerCase()) : count(f.content, t.text);
        score += n * t.weight;
        if (t.kind === 'noun' && f.path.toLowerCase().includes(t.text.toLowerCase())) score += 6;
      }
      if (category === 'visual' && /\.(css|scss|sass|less)$/.test(f.path)) score *= 1.5;
      if (category === 'api' && /(routes?|controllers?|api|handlers?|server)\//i.test(f.path)) score *= 1.5;
      if (/\.json$/.test(f.path)) score *= 0.3;
      if (/(^|\/)(tests?|__tests__|spec)\//.test(f.path)) score *= 0.3;
      return { file: f, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

export interface CodeHit {
  path: string;
  line: number;
  snippet: string;
  reason: string;
  pattern?: string;
  patch?: string;
}

const snippetAt = (lines: string[], idx: number, before = 2, after = 3) =>
  lines
    .slice(Math.max(0, idx - before), idx + after + 1)
    .map((l, i) => `${String(Math.max(0, idx - before) + i + 1).padStart(4)} | ${l}`)
    .join('\n');

function singleLinePatch(file: string, lineNo: number, before: string, after: string) {
  return `--- a/${file}\n+++ b/${file}\n@@ -${lineNo} +${lineNo} @@\n-${before}\n+${after}\n`;
}
function insertPatch(file: string, lineNo: number, anchor: string, inserted: string) {
  return `--- a/${file}\n+++ b/${file}\n@@ -${lineNo} +${lineNo},2 @@\n ${anchor}\n+${inserted}\n`;
}

function insideValidator(lines: string[], i: number) {
  for (let j = i; j >= 0; j--) {
    const fn = lines[j].match(/function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(|\.(get|post|put|patch|delete)\(/);
    if (fn) return /valid|check|sanitize/i.test(fn[1] || fn[2] || '');
  }
  return false;
}

/** Detects well-known defect patterns in a file and proposes a concrete patch where possible. */
export function detectPatterns(file: RepoFile, bug: Pick<BugDoc, 'category' | 'title' | 'location'>): CodeHit[] {
  const loc = (bug.location || {}) as Loc;
  const hits: CodeHit[] = [];
  const lines = file.content.split('\n');
  const kinds = [...(loc.scenarioKinds || []), ...(loc.apiKinds || [])];
  const isRoute = (loc.routes || []).length > 0;
  const isAuth = kinds.some((k) => k.startsWith('auth')) || kinds.includes('invalid_credentials');
  const isSpecial = kinds.includes('checkout_special_chars');
  const isCss = /\.(css|scss|sass|less)$/.test(file.path);

  lines.forEach((line, i) => {
    if (isSpecial && /JSON\.parse\(\s*[`'"]/.test(line) && /\$\{|\+\s*\w/.test(line)) {
      hits.push({
        path: file.path, line: i + 1, snippet: snippetAt(lines, i), pattern: 'string-built-json',
        reason: 'JSON is assembled by string interpolation — quotes or backslashes in user input produce invalid JSON and JSON.parse throws.',
      });
    }
    if (isRoute && !isAuth && !isSpecial && /\bbody\.\w+\.\w+(\.(trim|toLowerCase|toUpperCase)\(|\b)/.test(line) && !/validate|schema|safeParse|isArray|typeof|errors?\.push|\?\./.test(line) && !insideValidator(lines, i)) {
      if (!hits.some((h) => h.pattern === 'unvalidated-body')) {
        const obj = line.match(/body\.(\w+)\./)?.[1];
        const indent = line.match(/^\s*/)?.[0] || '';
        let anchorIdx = -1;
        for (let j = i; j >= Math.max(0, i - 25); j--) if (/\.(post|put|patch)\(/.test(lines[j])) { anchorIdx = j; break; }
        hits.push({
          path: file.path, line: i + 1, snippet: snippetAt(lines, i), pattern: 'unvalidated-body',
          reason: `Request payload field \`body.${obj}\` is dereferenced without validation — a missing or malformed field throws and returns 500.`,
          patch: anchorIdx >= 0 ? insertPatch(file.path, anchorIdx + 1, lines[anchorIdx], `${indent}if (!req.body || typeof req.body.${obj} !== 'object') return res.status(400).json({ error: '${obj} is required' });`) : undefined,
        });
      }
    }
    if (isRoute && isAuth) {
      const m = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*[^;]*\.find(?:One)?\(/);
      if (m) {
        const v = m[1];
        const window = lines.slice(i + 1, i + 5).join('\n');
        if (new RegExp(`\\b${v}\\.\\w+`).test(window) && !new RegExp(`!\\s*${v}\\b|${v}\\s*[=!]==?\\s*(null|undefined)|${v}\\?\\.`).test(window)) {
          const indent = line.match(/^\s*/)?.[0] || '';
          hits.push({
            path: file.path, line: i + 1, snippet: snippetAt(lines, i, 1, 4), pattern: 'missing-null-check',
            reason: `\`${v}\` from a lookup is used without a null check — unknown accounts throw "Cannot read properties of undefined" (HTTP 500).`,
            patch: insertPatch(file.path, i + 1, line, `${indent}if (!${v}) return res.status(401).json({ error: 'Invalid email or password' });`),
          });
        }
      }
    }
    if (isAuth && /\.(js|jsx|ts|tsx)$/.test(file.path) && /await\s+\w+\.json\(\)/.test(line) && !/catch|\.ok/.test(line)) {
      const window = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
      if (!/\.ok\b|try\s*\{/.test(window)) {
        hits.push({
          path: file.path, line: i + 1, snippet: snippetAt(lines, i), pattern: 'unchecked-response',
          reason: 'The response is parsed as JSON without checking `res.ok` or catching errors — an HTML 500 page makes the promise reject silently and no message is shown.',
        });
      }
    }
    if (/total/i.test(bug.title) && /reduce\(/.test(line) && /\bprice\b/.test(line) && !/quantity|qty/.test(line)) {
      const fixed = line.replace(/(\w+)\.price\b(?!\s*\*)/, '$1.price * $1.quantity');
      hits.push({
        path: file.path, line: i + 1, snippet: snippetAt(lines, i), pattern: 'quantity-ignored',
        reason: 'The total sums unit prices without multiplying by quantity.',
        patch: fixed !== line ? singleLinePatch(file.path, i + 1, line, fixed) : undefined,
      });
    }
    if (loc.imageSrc && line.includes(String(loc.imageSrc).split('/').pop()!)) {
      hits.push({
        path: file.path, line: i + 1, snippet: snippetAt(lines, i), pattern: 'missing-asset',
        reason: `References ${loc.imageSrc}, which the browser could not load.`,
      });
    }
  });

  if (isCss && bug.category === 'visual') {
    const classes = [
      ...(loc.classes || []),
      ...(loc.selectors || []).flatMap((s) => (s.match(/[.#]([a-zA-Z][\w-]+)/g) || []).map((c) => c.slice(1))),
    ];
    const ruleRe = /([^{}]+)\{([^}]*)\}/g;
    // Blank out comments (keeping offsets/line numbers) so they never pollute selectors.
    const css = file.content.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    for (const m of css.matchAll(ruleRe)) {
      const selector = m[1].trim();
      if (!classes.some((c) => new RegExp(`[.#]${c}(?![\\w-])`).test(selector))) continue;
      const decl = m[2].match(/(?<![\w-])(min-width|width)\s*:\s*(\d{3,})px/);
      if (!decl) continue;
      const offset = m.index! + m[0].indexOf(decl[0]);
      const lineNo = css.slice(0, offset).split('\n').length;
      const before = lines[lineNo - 1];
      const after = before.replace(/(?<![\w-])(min-width|width)\s*:\s*\d{3,}px/, decl[1] === 'min-width' ? 'min-width: 0; width: 100%' : 'width: 100%; max-width: 100%');
      hits.push({
        path: file.path, line: lineNo, snippet: snippetAt(lines, lineNo - 1, 3, 2), pattern: 'fixed-width',
        reason: `\`${selector.replace(/\s+/g, ' ')}\` sets ${decl[1]}: ${decl[2]}px, wider than the container on small screens (the container clips overflow).`,
        patch: singleLinePatch(file.path, lineNo, before, after),
      });
    }
  }
  return hits;
}

const FIXES: Record<string, string> = {
  'string-built-json': 'Build the response as an object and let `res.json()` serialise it (e.g. `return { greeting: `Thanks ${name}!`, total }`) instead of concatenating JSON strings.',
  'unvalidated-body': 'Validate the request body (zod/joi/express-validator) and return 400 with field errors before reading nested fields; wrap the handler so unexpected errors never leak as HTML 500 pages.',
  'missing-null-check': 'Guard the lookup and return 401 for unknown accounts: `if (!user || user.password !== password) return res.status(401).json({ error: "Invalid email or password" })`.',
  'unchecked-response': 'Check `res.ok` before parsing, wrap the call in try/catch and render the error message in the form’s alert region.',
  'quantity-ignored': 'Multiply by quantity when computing the total: `cart.reduce((sum, line) => sum + line.price * line.quantity, 0)`.',
  'fixed-width': 'Replace the fixed pixel width with a fluid width (`width: 100%; min-width: 0`) or add a narrow-viewport media query.',
  'missing-asset': 'Point the reference at an existing asset (or add the missing file) and render a fallback image on error.',
};

const PATTERN_PRIORITY = ['missing-null-check', 'unvalidated-body', 'string-built-json', 'quantity-ignored', 'fixed-width', 'missing-asset', 'unchecked-response'];

function genericFix(bug: Pick<BugDoc, 'category'>) {
  return bug.category === 'visual'
    ? 'Make the layout responsive at the failing viewport (fluid widths, flex-wrap, media queries) and add a visual regression check.'
    : bug.category === 'api'
      ? 'Validate input and map expected failures to 4xx responses; add an error-handling middleware so unexpected errors are logged and return JSON.'
      : 'Fix the workflow handler and cover it with the generated regression test.';
}

export async function analyzeBugAgainstRepo(bug: BugDoc, files: RepoFile[]) {
  const terms = searchTerms(bug);
  const ranked = rankFiles(files, terms, bug.category).slice(0, 6);
  const hits: CodeHit[] = [];
  for (const r of ranked) hits.push(...detectPatterns(r.file, bug));
  // Root-cause patterns (server/data/style) outrank symptom patterns (client error handling).
  hits.sort((a, b) => PATTERN_PRIORITY.indexOf(a.pattern || '') - PATTERN_PRIORITY.indexOf(b.pattern || ''));
  // Pattern hits first; otherwise point at the best term match.
  const refs: CodeHit[] = [...hits];
  for (const r of ranked.slice(0, 3)) {
    if (refs.some((h) => h.path === r.file.path)) continue;
    const lines = r.file.content.split('\n');
    const strongest = [...terms].sort((a, b) => b.weight - a.weight).find((t) => lines.some((l) => l.includes(t.text)));
    const idx = strongest ? lines.findIndex((l) => l.includes(strongest.text)) : -1;
    if (idx >= 0) refs.push({ path: r.file.path, line: idx + 1, snippet: snippetAt(lines, idx), reason: `Matches ${strongest!.kind} “${strongest!.text}”` });
  }
  const primary = hits[0];
  const likelyCause = primary
    ? `${primary.reason} (${primary.path}:${primary.line})`
    : refs[0]
      ? `${(bug.rootCause as { analyzer?: { likelyCause?: string } })?.analyzer?.likelyCause || 'Likely location'} — most relevant code: ${refs[0].path}:${refs[0].line}`
      : (bug.rootCause as { likelyCause?: string })?.likelyCause || 'No matching code found';
  const fixes = [...new Set(hits.map((h) => h.pattern && FIXES[h.pattern]).filter(Boolean))] as string[];
  return {
    likelyCause,
    confidence: primary ? 'high' : refs.length ? 'medium' : 'low',
    fileReferences: refs.slice(0, 5).map((r) => ({ path: r.path, line: r.line, snippet: r.snippet, reason: r.reason, pattern: r.pattern })),
    suggestedFix: fixes.length ? fixes.join(' ') : genericFix(bug),
    patch: hits.map((h) => h.patch).filter(Boolean).join('\n') || undefined,
    termsUsed: terms.map((t) => t.text).slice(0, 12),
  };
}

export async function runCodeAnalysis(ctx: RunContext, bugIds: Types.ObjectId[]) {
  const bugs = (await Bug.find({ _id: { $in: bugIds }, status: 'open' })) as unknown as (BugDoc & { save: () => Promise<unknown>; set: (v: object) => void })[];
  if (!bugs.length) return { output: { analyzed: 0, results: [] } };
  let files: RepoFile[];
  let source: string;
  const isLocal = ctx.repoUrl.startsWith('file://') || path.isAbsolute(ctx.repoUrl);
  if (isLocal) {
    if (!config.allowLocalRepos) throw new Error('Local repositories are disabled on this server');
    const root = ctx.repoUrl.replace(/^file:\/\//, '');
    files = await loadLocalRepo(root);
    source = `local:${path.basename(root)}`;
  } else {
    const allTerms = bugs.flatMap((b) => searchTerms(b));
    const relevance = (p: string) => allTerms.reduce((s, t) => s + (p.toLowerCase().includes(t.text.toLowerCase().replace(/^['"/]+/, '')) ? t.weight : 0), 0) + (/src|app|routes|components|styles|public/.test(p) ? 1 : 0);
    files = await loadGithubRepo(ctx.repoUrl, ctx.githubToken, relevance, (m) => ctx.log('code_analysis', m));
    source = ctx.repoUrl.replace(/^https:\/\/github\.com\//, 'github:');
  }
  ctx.log('code_analysis', `Indexed ${files.length} source files from ${source}`);
  const results: Record<string, unknown>[] = [];
  let llmBudget = llmEnabled() ? 4 : 0;
  for (const bug of bugs) {
    const a = await analyzeBugAgainstRepo(bug, files);
    let llm: { likelyCause?: string; patch?: string } | null = null;
    if (llmBudget-- > 0 && a.fileReferences.length) {
      ctx.aiCalls++;
      const top = a.fileReferences.slice(0, 2).map((r) => `File ${r.path} around line ${r.line}:\n${files.find((f) => f.path === r.path)?.content.split('\n').slice(Math.max(0, r.line - 25), r.line + 25).join('\n')}`);
      llm = await askJson<{ likelyCause?: string; patch?: string }>({
        system: 'You are a senior engineer doing root-cause analysis. Propose minimal fixes as unified diffs. Never include secrets.',
        prompt: `Bug: ${bug.title}\nExpected: ${bug.expected}\nActual: ${bug.actual}\nHeuristic cause: ${a.likelyCause}\n\n${top.join('\n\n')}\n\nReturn {"likelyCause": "1-2 sentences", "patch": "unified diff or empty"}`,
        maxTokens: 900,
      });
    }
    const rootCause = {
      ...(bug.rootCause as object),
      likelyCause: a.likelyCause,
      confidence: a.confidence,
      fileReferences: a.fileReferences,
      suggestedFix: a.suggestedFix,
      suggestedPatch: llm?.patch ? sanitizeText(llm.patch, 6000) : a.patch,
      llmExplanation: llm?.likelyCause ? sanitizeText(llm.likelyCause, 600) : undefined,
      codeAnalysis: { source, filesScanned: files.length, terms: a.termsUsed, engine: llm ? 'patterns+llm' : 'patterns', at: new Date() },
    };
    bug.set({ rootCause });
    await bug.save();
    results.push({ bugId: bug._id, bug: bug.title, likelyCause: a.likelyCause, files: a.fileReferences.map((r) => `${r.path}:${r.line}`), suggestedFix: a.suggestedFix, hasPatch: Boolean(rootCause.suggestedPatch) });
    ctx.log('code_analysis', `${bug.title.slice(0, 60)} → ${a.fileReferences.map((r) => `${r.path}:${r.line}`).slice(0, 2).join(', ') || 'no matching files'}`);
  }
  return { output: { repository: source, filesScanned: files.length, analyzed: results.length, results } };
}
