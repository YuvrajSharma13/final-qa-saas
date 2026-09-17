import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

const WS_KEY = 'aiqa.workspace';
const TOKEN_KEY = 'aiqa.token';

export const API_BASE = ((import.meta.env.VITE_API_URL as string) || '').replace(/\/$/, '');

export const getWorkspaceId = () => {
  try {
    return localStorage.getItem(WS_KEY) || '';
  } catch {
    return '';
  }
};
export const setWorkspaceId = (id: string) => {
  try {
    localStorage.setItem(WS_KEY, id);
  } catch {
    /* ignore */
  }
};

export const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
};
export const setToken = (token: string) => {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
};

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const ws = getWorkspaceId();
  if (ws) headers['X-Workspace-Id'] = ws;
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api${path}`, {
    method: opts.method || 'GET',
    headers,
    credentials: 'include',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const details = (data as { details?: unknown }).details;
    const msg = (data as { error?: string }).error || `Request failed (${res.status})`;
    throw new ApiError(res.status, Array.isArray(details) && details.length && typeof details[0] === 'string' ? `${msg}: ${details.join('; ')}` : msg, details);
  }
  return data as T;
}

export function useApi<T>(path: string | null, opts: { pollMs?: number | ((data: T | null) => number | false) } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const pollRef = useRef(opts.pollMs);
  pollRef.current = opts.pollMs;
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctrl = new AbortController();
    const load = async (first: boolean) => {
      if (first) setLoading(true);
      try {
        const d = await api<T>(path, { signal: ctrl.signal });
        if (cancelled) return;
        setData(d);
        setError(null);
        const p = typeof pollRef.current === 'function' ? pollRef.current(d) : pollRef.current;
        if (p) timer = setTimeout(() => load(false), p);
      } catch (e) {
        if (cancelled || (e as Error).name === 'AbortError') return;
        setError(e instanceof ApiError ? e : new ApiError(0, (e as Error).message));
      } finally {
        if (!cancelled && first) setLoading(false);
      }
    };
    load(true);
    return () => {
      cancelled = true;
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [path, tick]);

  return { data, error, loading, reload, setData };
}

// ------------------------------------------------------------------ shared types
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type BugStatus = 'open' | 'fixed' | 'ignored';

export interface Project {
  id: string;
  name: string;
  appUrl: string;
  repoUrl: string;
  status: string;
  openBugs?: number;
  createdAt?: string;
  lastRun?: { runId?: string; status?: string; qaScore?: number; at?: string };
  settings: {
    apiSpecUrl?: string;
    apiBaseUrl?: string;
    viewports?: string[];
    maxPages?: number;
    agents?: { functional: boolean; api: boolean; vision: boolean; code: boolean };
    testUsername?: string;
    notifyOnCritical?: boolean;
    hasTestPassword?: boolean;
    hasGithubToken?: boolean;
    github?: GithubLink | null;
  };
}

export interface RunSummary {
  testsExecuted?: number;
  passed?: number;
  failed?: number;
  errors?: number;
  qaScore?: number;
  bugsFound?: number;
  openBugs?: number;
  newBugs?: number;
  fixedBugs?: number;
  reopenedBugs?: number;
  durationMs?: number;
  bugs?: Record<Severity, number>;
  issues?: { functional: number; api: number; visual: number };
  byCategory?: Record<string, { executed: number; passed: number; failed: number }>;
  engine?: string;
  aiCalls?: number;
}

export interface TestRun {
  _id: string;
  projectId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  trigger?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  summary?: RunSummary;
  progress?: { phase: string; percent: number };
  error?: string;
  config?: { agents: Record<string, boolean>; viewports: string[]; maxPages: number; warnings?: string[] };
  events?: { ts: string; agent: string; level: string; message: string }[];
  plan?: {
    workflows: string[];
    engine: string;
    pages: { path: string; role: string; status: number }[];
    scenarios: { id: string; name: string; kind: string; workflow: string }[];
    apiChecks: { id: string; name: string; kind: string; route: string }[];
    visualTargets: { id: string; path: string }[];
    endpoints: { method: string; path: string; source: string }[];
    spec: { url: string; loaded: boolean; operations: number; error?: string };
    notes: string[];
  };
}

export interface AgentRun {
  _id: string;
  agentType: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  inputRef?: Record<string, unknown>;
  output?: Record<string, unknown>;
  engine?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface TestCase {
  _id: string;
  category: 'functional' | 'api' | 'visual' | 'regression';
  agentType: string;
  kind: string;
  name: string;
  target?: string;
  expected?: string;
  actual?: string;
  status: 'passed' | 'failed' | 'error' | 'skipped';
  durationMs?: number;
  evidence?: Record<string, unknown>;
}

export interface Annotation {
  n: number;
  type: string;
  label: string;
  severity: Severity;
  confidence: string;
  box: { x: number; y: number; width: number; height: number };
  region: string;
  method?: string[];
}

export interface Screenshot {
  _id: string;
  kind: 'capture' | 'failure' | 'reference';
  agentType?: string;
  viewport?: { name: string; width: number; height: number };
  url?: string;
  pagePath?: string;
  width?: number;
  height?: number;
  annotations?: Annotation[];
  annotatedRef?: string;
  isBaseline?: boolean;
  createdAt?: string;
}

export interface FileReference {
  path: string;
  line: number;
  snippet: string;
  reason: string;
  pattern?: string;
}

export interface Bug {
  _id: string;
  projectId: string;
  projectName?: string;
  runId?: string;
  title: string;
  description?: string;
  category: 'functional' | 'api' | 'visual';
  severity: Severity;
  status: BugStatus;
  sources?: string[];
  occurrences?: number;
  expected?: string;
  actual?: string;
  reproSteps?: string[];
  location?: Record<string, unknown>;
  runRelation?: string;
  createdAt: string;
  updatedAt: string;
  evidence?: {
    screenshotIds?: string[];
    testCaseIds?: string[];
    network?: { method: string; url: string; path: string; status: number; responseSnippet?: string; requestBody?: unknown; durationMs?: number }[];
    console?: { type: string; text: string }[];
    agentOutputs?: Record<string, unknown>[];
  };
  rootCause?: {
    likelyCause?: string;
    confidence?: string;
    fileReferences?: FileReference[];
    suggestedFix?: string;
    suggestedPatch?: string;
    llmExplanation?: string;
    analyzer?: { likelyCause?: string; confidence?: string };
    codeAnalysis?: { source: string; filesScanned: number; engine: string; terms?: string[] };
  };
  history?: { at: string; event: string; message: string; runId?: string; userName?: string }[];
}

export interface RegressionTest {
  _id: string;
  bugId: string;
  name: string;
  steps: Record<string, unknown>[];
  expected?: string;
  status: 'pending' | 'failing' | 'passing' | 'error';
  code?: string;
  suggestedFix?: string;
  lastRunAt?: string;
  lastResult?: { status: string; failures?: { step: number; description: string; expected: string; actual: string }[] };
  results?: { at: string; status: string; detail: string; runId?: string }[];
}

export interface GithubLink {
  owner: string;
  repo: string;
  baseBranch: string;
  defaultBranch?: string;
  private?: boolean;
  linkedAt?: string;
}

export interface GithubConnection {
  connected: boolean;
  login?: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  method?: 'oauth' | 'token';
  scopes?: string[];
  connectedAt?: string;
  lastUsedAt?: string;
  lastError?: string;
}

export interface ValidationCheck {
  name: string;
  kind: string;
  command: string;
  status: 'passed' | 'failed' | 'skipped' | 'timeout';
  exitCode?: number;
  durationMs?: number;
  failures?: number | null;
  output?: string;
  note?: string;
}

export interface ValidationReport {
  phase: string;
  checks: ValidationCheck[];
  passed: boolean;
  summary: string;
  durationMs: number;
  verdict?: { ok: boolean; problems: string[]; preExisting: string[] };
}

export interface FixAttempt {
  n: number;
  engine: 'llm' | 'rules';
  explanation: string;
  files: { path: string; before: string; after: string; additions: number; deletions: number }[];
  diff: string;
  patchHash: string;
  feedback?: string;
  validation?: ValidationReport;
  status: 'proposed' | 'approved' | 'rejected' | 'validation_failed';
  error?: string;
  createdAt: string;
  approvedAt?: string;
  approvedByName?: string;
}

export type AutoFixStatus =
  | 'queued'
  | 'generating'
  | 'awaiting_approval'
  | 'applying'
  | 'validating'
  | 'committing'
  | 'pushing'
  | 'creating_pr'
  | 'pr_open'
  | 'merged'
  | 'closed'
  | 'rejected'
  | 'failed'
  | 'canceled';

export interface PullInfo {
  number: number;
  url: string;
  state: string;
  merged: boolean;
  draft?: boolean;
  mergeable?: boolean | null;
  title?: string;
  updatedAt?: string;
  checks?: { state: string; total: number; passed: number; failed: number; pending: number; runs: { name: string; status: string; conclusion: string | null; url: string }[] };
}

export interface AutoFix {
  _id: string;
  bugId: string;
  projectId: string;
  status: AutoFixStatus;
  repo: { owner: string; name: string; baseBranch: string; baseSha?: string; defaultBranch?: string };
  branch?: string;
  commitSha?: string;
  attempts: FixAttempt[];
  attemptsCount?: number;
  baseline?: ValidationReport;
  pr?: PullInfo;
  events: { ts: string; level: string; step: string; message: string }[];
  error?: string;
  createdAt: string;
  updatedAt: string;
  createdByName?: string;
  bug?: { _id: string; title: string; severity: Severity; category: string; status: string; expected?: string; actual?: string };
  bugTitle?: string;
  bugSeverity?: Severity;
  project?: { _id: string; name: string };
  projectName?: string;
  maxAttempts?: number;
  repoUrl?: string;
  branchUrl?: string;
  commitUrl?: string;
}

export const FIX_ACTIVE: AutoFixStatus[] = ['queued', 'generating', 'applying', 'validating', 'committing', 'pushing', 'creating_pr'];

export const shotUrl = (id: string, annotated = false) => `${API_BASE}/api/screenshots/${id}/image${annotated ? '?variant=annotated' : ''}`;
