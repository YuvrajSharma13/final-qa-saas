// Log/evidence sanitizer: secrets must never be stored in evidence or shown in the UI.
const SECRET_KEY_RE = /(pass(word)?|pwd|secret|token|api[-_]?key|authorization|cookie|session|credit|card|cvv)/i;
const INLINE_PATTERNS: [RegExp, string][] = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED_GITHUB_TOKEN]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]'],
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, '[REDACTED_API_KEY]'],
  [/sk-[A-Za-z0-9]{20,}/g, '[REDACTED_API_KEY]'],
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED_JWT]'],
  [/("?(?:password|token|secret)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[REDACTED]"'],
];

export function sanitizeText(input: unknown, maxLen = 4000): string {
  if (input === undefined || input === null) return '';
  let s = typeof input === 'string' ? input : safeStringify(input);
  for (const [re, rep] of INLINE_PATTERNS) s = s.replace(re, rep);
  if (s.length > maxLen) s = `${s.slice(0, maxLen)}… [truncated ${s.length - maxLen} chars]`;
  return s;
}

export function sanitizeValue<T>(value: T, depth = 0): T {
  if (depth > 8) return '[depth-limit]' as unknown as T;
  if (typeof value === 'string') return sanitizeText(value) as unknown as T;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => sanitizeValue(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k) && (typeof v === 'string' || typeof v === 'number')) out[k] = '[REDACTED]';
      else out[k] = sanitizeValue(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SECRET_KEY_RE.test(k) || k.toLowerCase() === 'set-cookie' ? '[REDACTED]' : sanitizeText(v, 300);
  }
  return out;
}

function safeStringify(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
