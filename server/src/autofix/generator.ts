import fs from 'node:fs/promises';
import path from 'node:path';
import { askJson, llmEnabled } from '../ai/llm.js';
import { sanitizeText } from '../lib/sanitize.js';
import type { BugDoc } from '../models/index.js';
import { collectHits, loadLocalRepo, type CodeHit, type RepoFile } from '../qa/agents/codeAnalysis.js';
import { applyEdits, diffAndRevert, PatchError, type FileEdit } from './patch.js';

/**
 * Fix generator. With an ANTHROPIC_API_KEY the model writes the patch (and receives validation errors from previous
 * attempts). Without one — or when the model's patch cannot be applied — a rule engine turns the Code Analysis
 * agent's detected defect patterns into concrete edits.
 */

export interface PreviousAttempt {
  n: number;
  explanation?: string;
  diff?: string;
  feedback?: string;
}

export interface FixProposal {
  engine: 'llm' | 'rules';
  explanation: string;
  edits: FileEdit[];
  diff: string;
  patchHash: string;
  files: { path: string; before: string; after: string; additions: number; deletions: number }[];
}

type Bugish = Pick<BugDoc, 'title' | 'category' | 'location' | 'description' | 'expected' | 'actual' | 'reproSteps' | 'rootCause' | 'evidence'>;

// ------------------------------------------------------------------ rule engine
function lineAt(content: string, line: number) {
  return content.split('\n')[line - 1] ?? '';
}

/** Returns the smallest block of whole lines starting at `line` that occurs exactly once in the file. */
function uniqueBlock(content: string, line: number) {
  const lines = content.split('\n');
  for (let extra = 0; extra < 6; extra++) {
    const block = lines.slice(line - 1, line + extra).join('\n');
    if (block.trim() && content.split(block).length === 2) return block;
  }
  return null;
}

function parsePatch(p: string): { kind: 'replace'; before: string; after: string } | { kind: 'insert'; anchor: string; inserted: string } | null {
  const body = p.split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++') && !l.startsWith('@@') && l !== '');
  const minus = body.filter((l) => l.startsWith('-')).map((l) => l.slice(1));
  const plus = body.filter((l) => l.startsWith('+')).map((l) => l.slice(1));
  const ctx = body.filter((l) => l.startsWith(' ')).map((l) => l.slice(1));
  if (minus.length === 1 && plus.length === 1) return { kind: 'replace', before: minus[0], after: plus[0] };
  if (!minus.length && ctx.length === 1 && plus.length === 1) return { kind: 'insert', anchor: ctx[0], inserted: plus[0] };
  return null;
}

/** Converts `JSON.parse(`{"a":"x ${v}","b":${w}}`)` into an object literal so user input can never break it. */
export function jsonTemplateToObject(line: string): string | null {
  const m = line.match(/JSON\.parse\(\s*`\{([\s\S]*)\}`\s*\)/);
  if (!m) return null;
  const inner = m[1];
  const props: string[] = [];
  const re = /"([A-Za-z_$][\w$]*)"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|(\$\{[^}]+\}|-?\d+(?:\.\d+)?|true|false|null))\s*(?:,|$)/g;
  let consumed = 0;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(inner))) {
    if (mm.index !== consumed) return null;
    consumed = re.lastIndex;
    const [, key, str, raw] = mm;
    if (str !== undefined) props.push(`${key}: \`${str.replace(/`/g, '\\`')}\``);
    else if (raw.startsWith('${')) props.push(`${key}: ${raw.slice(2, -1).trim()}`);
    else props.push(`${key}: ${raw}`);
  }
  if (consumed !== inner.length || !props.length) return null;
  return line.replace(m[0], `{ ${props.join(', ')} }`);
}

const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|avif)$/i;

function findReplacementAsset(files: string[], missing: string) {
  const base = path.basename(missing).replace(ASSET_EXT, '').toLowerCase();
  const tokens = base.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  let best: { file: string; score: number } | null = null;
  for (const f of files) {
    if (!ASSET_EXT.test(f)) continue;
    const name = path.basename(f).replace(ASSET_EXT, '').toLowerCase();
    const score = tokens.filter((t) => name.split(/[^a-z0-9]+/).includes(t)).length;
    if (score && (!best || score > best.score)) best = { file: f, score };
  }
  return best?.file || null;
}

async function listAllFiles(root: string) {
  const out: string[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > 8 || out.length > 5000) return;
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
  await walk(root, 0);
  return out;
}

async function ruleEdit(hit: CodeHit, file: RepoFile, root: string, bug: Bugish): Promise<FileEdit | null> {
  const content = file.content;
  if (hit.patch) {
    const p = parsePatch(hit.patch);
    if (p?.kind === 'replace') {
      const block = uniqueBlock(content, hit.line);
      if (block && block.startsWith(p.before)) return { path: hit.path, find: block, replace: p.after + block.slice(p.before.length), reason: hit.reason };
    }
    if (p?.kind === 'insert') {
      const idx = content.split('\n').indexOf(p.anchor);
      if (idx >= 0) {
        const block = uniqueBlock(content, idx + 1);
        if (block) return { path: hit.path, find: block, replace: block.replace(p.anchor, `${p.anchor}\n${p.inserted}`), reason: hit.reason };
      }
    }
  }
  const line = lineAt(content, hit.line);
  switch (hit.pattern) {
    case 'string-built-json': {
      const fixed = jsonTemplateToObject(line);
      const block = uniqueBlock(content, hit.line);
      if (fixed && block) return { path: hit.path, find: block, replace: fixed + block.slice(line.length), reason: hit.reason };
      return null;
    }
    case 'unchecked-response': {
      const m = line.match(/await\s+(\w+)\.json\(\)/);
      const block = uniqueBlock(content, hit.line);
      if (!m || !block) return null;
      const fixed = line.replace(m[0], `await ${m[1]}.json().catch(() => ({ error: \`Request failed (HTTP \${${m[1]}.status})\` }))`);
      return { path: hit.path, find: block, replace: fixed + block.slice(line.length), reason: hit.reason };
    }
    case 'missing-asset': {
      const src = String((bug.location as { imageSrc?: string })?.imageSrc || '');
      if (!src) return null;
      const all = await listAllFiles(root);
      const replacement = findReplacementAsset(all, src);
      if (!replacement) return null;
      // Keep the URL prefix (e.g. /img/) and swap the file name for an asset that exists in the repository.
      const newSrc = src.replace(path.basename(src), path.basename(replacement));
      const block = uniqueBlock(content, hit.line);
      if (!block || !line.includes(src)) return null;
      return { path: hit.path, find: block, replace: line.replace(src, newSrc) + block.slice(line.length), reason: `${hit.reason} Points it at the existing asset ${replacement}.` };
    }
    default:
      return null;
  }
}

async function rulesProposal(root: string, files: RepoFile[], bug: Bugish, attempt: number): Promise<{ explanation: string; edits: FileEdit[] }> {
  const { hits } = collectHits(bug as BugDoc, files);
  if (!hits.length) throw new PatchError('No known defect pattern was found for this bug. Configure ANTHROPIC_API_KEY to let the AI engine write a fix.');
  const edits: FileEdit[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const key = `${h.path}:${h.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const f = files.find((x) => x.path === h.path);
    if (!f) continue;
    const e = await ruleEdit(h, f, root, bug);
    if (e && !edits.some((x) => x.path === e.path && x.find === e.find)) edits.push(e);
    if (edits.length >= 3) break;
  }
  if (!edits.length) throw new PatchError('Detected the defect but could not derive a safe automatic edit. Configure ANTHROPIC_API_KEY for AI-written fixes.');
  // Attempt 2 narrows the change to the primary root cause only; there is no further rule-based alternative.
  if (attempt === 2 && edits.length > 1) edits.splice(1);
  else if (attempt >= 2) throw new PatchError('The rule engine has no alternative fix after a failed validation. Configure ANTHROPIC_API_KEY for iterative AI fixes, or fix manually.');
  return {
    explanation: `Rule-based fix derived from the Code Analysis agent: ${edits.map((e) => `${e.path} — ${e.reason}`).join(' ')}`,
    edits,
  };
}

// ------------------------------------------------------------------ LLM engine
async function llmProposal(files: RepoFile[], bug: Bugish, previous: PreviousAttempt[], lastError: string | null) {
  const { ranked, hits } = collectHits(bug as BugDoc, files);
  const rc = (bug.rootCause || {}) as { likelyCause?: string; fileReferences?: { path: string }[] };
  const wanted = [...new Set([...(rc.fileReferences || []).map((f) => f.path), ...hits.map((h) => h.path), ...ranked.map((r) => r.file.path)])].slice(0, 5);
  const context = wanted
    .map((p) => files.find((f) => f.path === p))
    .filter(Boolean)
    .map((f) => {
      const lines = f!.content.split('\n');
      const body = lines.length > 500 ? `${lines.slice(0, 500).join('\n')}\n… (${lines.length - 500} more lines)` : f!.content;
      return `<file path="${f!.path}">\n${body}\n</file>`;
    })
    .join('\n\n');
  const ev = (bug.evidence || {}) as { network?: { method: string; path: string; status: number; responseSnippet?: string }[]; console?: { text: string }[] };
  const history = previous
    .map((p) => `Attempt ${p.n} (rejected or failed):\nExplanation: ${p.explanation}\nDiff:\n${(p.diff || '').slice(0, 3000)}\nFeedback / validation errors:\n${(p.feedback || '').slice(0, 4000)}`)
    .join('\n\n');
  return askJson<{ explanation?: string; edits?: FileEdit[] }>({
    system:
      'You are a senior software engineer writing minimal, production-safe bug fixes for a pull request. Change only the lines needed to fix the bug. Never modify lockfiles, CI config, secrets or unrelated code. Never add new files. Preserve code style.',
    prompt: `Bug: ${bug.title}
Category: ${bug.category}
Description: ${bug.description || ''}
Expected: ${bug.expected || ''}
Actual: ${bug.actual || ''}
Steps to reproduce:\n${(bug.reproSteps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}
Likely cause (static analysis): ${rc.likelyCause || 'unknown'}
Network evidence: ${(ev.network || []).slice(0, 4).map((n) => `${n.status} ${n.method} ${n.path} ${n.responseSnippet?.slice(0, 160) || ''}`).join(' | ')}
Console evidence: ${(ev.console || []).slice(0, 3).map((c) => c.text).join(' | ')}

Repository files:
${context}

${history ? `Previous attempts:\n${history}\n` : ''}${lastError ? `Your previous answer could not be applied: ${lastError}\n` : ''}
Return JSON: {"explanation": "2-4 sentences on the root cause and the fix", "edits": [{"path": "relative/path", "find": "exact verbatim text copied from the file, unique in that file (include a few surrounding lines if needed)", "replace": "the new text"}]}`,
    maxTokens: 4000,
  });
}

// ------------------------------------------------------------------ entry point
export async function generateFix(input: { root: string; bug: Bugish; attempt: number; previous: PreviousAttempt[]; log: (m: string) => void }): Promise<FixProposal> {
  const files = await loadLocalRepo(input.root);
  input.log(`Indexed ${files.length} source files`);
  const tryApply = async (edits: FileEdit[]) => {
    const touched = await applyEdits(input.root, edits);
    return diffAndRevert(input.root, touched);
  };

  if (llmEnabled()) {
    let lastError: string | null = null;
    for (let i = 0; i < 2; i++) {
      input.log(i === 0 ? 'Asking the AI model for a minimal patch' : 'Asking the AI model to correct its patch');
      const out = await llmProposal(files, input.bug, input.previous, lastError);
      if (!out?.edits?.length) {
        lastError = 'No edits were returned';
        continue;
      }
      const edits = out.edits.slice(0, 12).map((e) => ({ path: String(e.path), find: String(e.find), replace: String(e.replace) }));
      try {
        const d = await tryApply(edits);
        return { engine: 'llm', explanation: sanitizeText(out.explanation || 'AI-generated fix', 1500), edits, ...d };
      } catch (e) {
        lastError = (e as Error).message;
        input.log(`AI patch rejected: ${lastError}`);
      }
    }
    input.log('Falling back to the rule engine');
  }
  const r = await rulesProposal(input.root, files, input.bug, input.attempt);
  const d = await tryApply(r.edits);
  return { engine: 'rules', explanation: r.explanation, edits: r.edits, ...d };
}
