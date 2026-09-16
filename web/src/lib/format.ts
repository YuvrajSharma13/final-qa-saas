export function timeAgo(iso?: string | Date | null) {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return d.toLocaleDateString();
}

export function duration(ms?: number) {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function dateTime(iso?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export const AGENT_META: Record<string, { name: string; short: string; role: string }> = {
  test_planner: { name: 'Test Planner', short: 'Planner', role: 'Explores the app, reads the API spec and builds the shared test plan' },
  functional_qa: { name: 'Functional QA', short: 'Functional', role: 'Drives real browser workflows and validates behaviour' },
  api_qa: { name: 'API QA', short: 'API', role: 'Tests endpoints, status codes, validation and edge cases' },
  vision_qa: { name: 'Vision QA', short: 'Vision', role: 'Computer vision on screenshots across viewports' },
  bug_analyzer: { name: 'Bug Analyzer', short: 'Analyzer', role: 'Correlates failures into consolidated, ranked bugs' },
  code_analysis: { name: 'Code Analysis', short: 'Code', role: 'Finds likely source files and proposes a patch' },
  regression_test: { name: 'Regression Test', short: 'Regression', role: 'Turns bugs into repeatable tests and verifies fixes' },
  orchestrator: { name: 'Orchestrator', short: 'Orchestrator', role: 'Coordinates the agents' },
};

export const pct = (a?: number, b?: number) => (b ? Math.round(((a || 0) / b) * 100) : 0);
