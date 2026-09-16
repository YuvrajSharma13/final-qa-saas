import type { Types } from 'mongoose';
import type { Severity } from '../models/index.js';

/** How an agent points at an element. Resolved by the step executor. */
export interface Locator {
  css?: string;
  role?: 'button' | 'link' | 'textbox' | 'checkbox' | 'heading' | 'alert' | 'status';
  name?: string;
  label?: string;
  text?: string;
  nth?: number;
}

/** Declarative, serialisable test steps shared by the Functional, API and Regression agents. */
export type Step =
  | { action: 'setViewport'; viewport: string }
  | { action: 'goto'; path: string }
  | { action: 'click'; target: Locator; description?: string }
  | { action: 'fill'; target: Locator; value: string; secret?: boolean }
  | { action: 'press'; target: Locator; key: string }
  | { action: 'wait'; ms: number }
  | { action: 'expectVisible'; target: Locator; timeoutMs?: number }
  | { action: 'expectAnyVisible'; targets: Locator[]; timeoutMs?: number; description?: string }
  | { action: 'expectText'; pattern: string; flags?: string; timeoutMs?: number; description?: string }
  | { action: 'expectNoServerErrors' }
  | { action: 'expectNoPageErrors' }
  | { action: 'expectImagesLoaded' }
  | { action: 'expectCartMath' }
  | { action: 'expectFullyVisible'; target: Locator; description?: string }
  | {
      action: 'request';
      method: string;
      path: string;
      body?: unknown;
      rawBody?: string;
      headers?: Record<string, string>;
      expectStatus: number[];
      /** Pass for any status below 500 (used for endpoints without a contract). */
      allowAnyBelow500?: boolean;
      expectJson?: boolean;
      requiredKeys?: string[];
      maxMs?: number;
      description?: string;
    };

export interface NetworkEntry {
  method: string;
  url: string;
  path: string;
  status: number;
  resourceType: string;
  durationMs?: number;
  requestBody?: unknown;
  responseSnippet?: string;
}

export interface ConsoleEntry {
  type: string;
  text: string;
}

export interface StepFailure {
  stepIndex: number;
  step: Step;
  expected: string;
  actual: string;
  symptom: Symptom;
  data?: Record<string, unknown>;
}

export type Symptom =
  | 'server_error'
  | 'page_error'
  | 'broken_image'
  | 'missing_feedback'
  | 'calculation_mismatch'
  | 'unexpected_status'
  | 'schema_mismatch'
  | 'slow_response'
  | 'element_missing'
  | 'not_fully_visible'
  | 'text_missing'
  | 'step_error';

export type ScenarioKind =
  | 'page_health'
  | 'auth_invalid_login'
  | 'auth_valid_login'
  | 'cart_quantity'
  | 'checkout_happy_path'
  | 'checkout_special_chars'
  | 'checkout_empty_submit'
  | 'form_smoke';

export interface Scenario {
  id: string;
  kind: ScenarioKind;
  name: string;
  workflow: string;
  page: string;
  expected: string;
  steps: Step[];
}

export type ApiCheckKind = 'contract' | 'not_found' | 'empty_body' | 'missing_field' | 'wrong_type' | 'invalid_format' | 'malformed_json' | 'invalid_credentials' | 'unknown_route' | 'discovered_get' | 'discovered_post';

export interface ApiCheck {
  id: string;
  kind: ApiCheckKind;
  name: string;
  method: string;
  path: string;
  /** Normalised route template used for correlation, e.g. "GET /api/orders/:id" */
  route: string;
  expected: string;
  step: Extract<Step, { action: 'request' }>;
}

export interface VisualTarget {
  id: string;
  name: string;
  path: string;
  setup: Step[];
}

export interface DiscoveredField {
  locator: Locator;
  type: string;
  name: string;
  label: string;
  required: boolean;
  semantic: 'email' | 'username' | 'password' | 'name' | 'phone' | 'address' | 'text' | 'number' | 'other';
}

export interface DiscoveredForm {
  fields: DiscoveredField[];
  submit: Locator | null;
  submitText: string;
}

export interface PageInfo {
  path: string;
  url: string;
  title: string;
  status: number;
  role: 'login' | 'catalog' | 'cart' | 'checkout' | 'confirmation' | 'content';
  headings: string[];
  forms: DiscoveredForm[];
  addToCart: { locator: Locator; count: number } | null;
  links: string[];
  images: number;
}

export interface DiscoveredEndpoint {
  method: string;
  path: string;
  source: 'spec' | 'traffic' | 'script';
}

export interface TestPlan {
  appUrl: string;
  engine: string;
  pages: PageInfo[];
  workflows: string[];
  scenarios: Scenario[];
  apiChecks: ApiCheck[];
  visualTargets: VisualTarget[];
  viewports: string[];
  endpoints: DiscoveredEndpoint[];
  spec: { url: string; loaded: boolean; operations: number; error?: string };
  notes: string[];
}

/** A normalised failure handed from the testing agents to the Bug Analyzer. */
export interface Finding {
  source: 'functional' | 'api' | 'vision';
  testCaseId: string;
  title: string;
  symptom: Symptom | VisualIssueType;
  page?: string;
  workflow?: string;
  scenarioKind?: string;
  route?: string;
  status?: number;
  viewport?: string;
  element?: { selector: string; text: string; box?: Box; styles?: Record<string, string>; classes?: string[] };
  expected: string;
  actual: string;
  severityHint: Severity;
  confidence: 'high' | 'medium' | 'low';
  screenshotIds: string[];
  network: NetworkEntry[];
  console: ConsoleEntry[];
  steps?: Step[];
  apiCheck?: ApiCheck;
  details?: Record<string, unknown>;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type VisualIssueType =
  | 'clipped_element'
  | 'offscreen_element'
  | 'horizontal_overflow'
  | 'overlapping_elements'
  | 'broken_image'
  | 'reference_mismatch'
  | 'ai_visual_defect';

export interface VisualIssue {
  type: VisualIssueType;
  description: string;
  severity: Severity;
  confidence: 'high' | 'medium' | 'low';
  region: Box;
  regionLabel: string;
  element?: { selector: string; text: string; box?: Box; styles?: Record<string, string>; classes?: string[] };
  metrics?: Record<string, number | string | boolean>;
  method: string[];
}

export interface RunContext {
  runId: Types.ObjectId;
  projectId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  appUrl: string;
  repoUrl: string;
  apiSpecUrl: string;
  apiBaseUrl: string;
  viewports: string[];
  maxPages: number;
  credentials: { username: string; password: string } | null;
  githubToken: string;
  log: (agent: string, message: string, level?: 'info' | 'warn' | 'error') => void;
  isCanceled: () => boolean;
  aiCalls: number;
}
