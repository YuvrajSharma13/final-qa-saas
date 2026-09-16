import mongoose, { Schema, type InferSchemaType, type Types } from 'mongoose';

const { Mixed, ObjectId } = Schema.Types;
const opts = { timestamps: true } as const;

// ---------------------------------------------------------------- users
const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String },
    authProvider: { type: String, default: 'password' },
  },
  opts,
);
export const User = mongoose.model('User', userSchema, 'users');

// ---------------------------------------------------------------- workspaces
const workspaceSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    ownerId: { type: ObjectId, ref: 'User', required: true },
    plan: { type: String, enum: ['free', 'pro', 'team'], default: 'free' },
    billing: {
      status: { type: String, default: 'active' },
      provider: { type: String, default: 'test-mode' },
      renewsAt: Date,
    },
    usage: {
      periodStart: { type: Date, default: () => new Date() },
      runs: { type: Number, default: 0 },
      aiCalls: { type: Number, default: 0 },
      browserSeconds: { type: Number, default: 0 },
      checks: { type: Number, default: 0 },
    },
  },
  opts,
);
export const Workspace = mongoose.model('Workspace', workspaceSchema, 'workspaces');

// ---------------------------------------------------------------- members
export const ROLES = ['owner', 'admin', 'developer', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
const memberSchema = new Schema(
  {
    workspaceId: { type: ObjectId, ref: 'Workspace', required: true, index: true },
    userId: { type: ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ROLES, default: 'developer' },
  },
  opts,
);
memberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
export const Member = mongoose.model('Member', memberSchema, 'members');

// ---------------------------------------------------------------- projects
const projectSchema = new Schema(
  {
    workspaceId: { type: ObjectId, ref: 'Workspace', required: true, index: true },
    name: { type: String, required: true, trim: true },
    appUrl: { type: String, required: true },
    repoUrl: { type: String, default: '' },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    settings: {
      apiSpecUrl: { type: String, default: '' },
      apiBaseUrl: { type: String, default: '' },
      viewports: { type: [String], default: ['desktop', 'mobile'] },
      maxPages: { type: Number, default: 8 },
      agents: {
        functional: { type: Boolean, default: true },
        api: { type: Boolean, default: true },
        vision: { type: Boolean, default: true },
        code: { type: Boolean, default: true },
      },
      testUsername: { type: String, default: '' },
      testPasswordEnc: { type: String, default: '' },
      githubTokenEnc: { type: String, default: '' },
      notifyOnCritical: { type: Boolean, default: true },
      // Repository selected through the GitHub integration.
      github: {
        owner: { type: String, default: '' },
        repo: { type: String, default: '' },
        baseBranch: { type: String, default: '' },
        defaultBranch: { type: String, default: '' },
        private: { type: Boolean, default: false },
        connectedBy: { type: ObjectId, ref: 'User' },
        linkedAt: Date,
      },
    },
    lastRun: {
      runId: { type: ObjectId, ref: 'TestRun' },
      status: String,
      qaScore: Number,
      at: Date,
    },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  opts,
);
export const Project = mongoose.model('Project', projectSchema, 'projects');

// ---------------------------------------------------------------- testRuns
const testRunSchema = new Schema(
  {
    projectId: { type: ObjectId, ref: 'Project', required: true, index: true },
    workspaceId: { type: ObjectId, ref: 'Workspace', required: true, index: true },
    triggeredBy: { type: ObjectId, ref: 'User' },
    trigger: { type: String, default: 'manual' },
    status: { type: String, enum: ['queued', 'running', 'completed', 'failed', 'canceled'], default: 'queued', index: true },
    startedAt: Date,
    completedAt: Date,
    config: { type: Mixed, default: {} },
    plan: { type: Mixed },
    progress: { phase: { type: String, default: 'queued' }, percent: { type: Number, default: 0 } },
    events: {
      type: [{ ts: Date, agent: String, level: String, message: String, _id: false }],
      default: [],
    },
    summary: { type: Mixed, default: {} },
    error: String,
  },
  opts,
);
export const TestRun = mongoose.model('TestRun', testRunSchema, 'testRuns');

// ---------------------------------------------------------------- testCases
const testCaseSchema = new Schema(
  {
    runId: { type: ObjectId, ref: 'TestRun', required: true, index: true },
    projectId: { type: ObjectId, ref: 'Project', index: true },
    agentType: String,
    category: { type: String, enum: ['functional', 'api', 'visual', 'regression'], required: true },
    kind: String,
    name: { type: String, required: true },
    target: String,
    expected: String,
    actual: String,
    status: { type: String, enum: ['passed', 'failed', 'error', 'skipped'], required: true },
    durationMs: Number,
    evidence: { type: Mixed, default: {} },
  },
  opts,
);
export const TestCase = mongoose.model('TestCase', testCaseSchema, 'testCases');

// ---------------------------------------------------------------- bugs
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];
const bugSchema = new Schema(
  {
    projectId: { type: ObjectId, ref: 'Project', required: true, index: true },
    workspaceId: { type: ObjectId, ref: 'Workspace', required: true, index: true },
    runId: { type: ObjectId, ref: 'TestRun', index: true },
    lastSeenRunId: { type: ObjectId, ref: 'TestRun' },
    fingerprint: { type: String, required: true, index: true },
    title: { type: String, required: true },
    description: String,
    category: { type: String, enum: ['functional', 'api', 'visual'], required: true },
    severity: { type: String, enum: SEVERITIES, required: true },
    status: { type: String, enum: ['open', 'fixed', 'ignored'], default: 'open', index: true },
    sources: [String],
    location: { type: Mixed, default: {} },
    evidence: { type: Mixed, default: {} },
    rootCause: { type: Mixed, default: {} },
    reproSteps: [String],
    expected: String,
    actual: String,
    occurrences: { type: Number, default: 1 },
    history: {
      type: [{ at: Date, event: String, message: String, runId: ObjectId, userId: ObjectId, _id: false }],
      default: [],
    },
  },
  opts,
);
export const Bug = mongoose.model('Bug', bugSchema, 'bugs');

// ---------------------------------------------------------------- agentRuns
export const AGENT_TYPES = ['test_planner', 'functional_qa', 'api_qa', 'vision_qa', 'bug_analyzer', 'code_analysis', 'regression_test'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];
const agentRunSchema = new Schema(
  {
    runId: { type: ObjectId, ref: 'TestRun', required: true, index: true },
    agentType: { type: String, enum: AGENT_TYPES, required: true },
    status: { type: String, enum: ['pending', 'running', 'completed', 'failed', 'skipped'], default: 'pending' },
    inputRef: { type: Mixed, default: {} },
    output: { type: Mixed, default: {} },
    engine: { type: String, default: 'deterministic' },
    logs: { type: [String], default: [] },
    error: String,
    startedAt: Date,
    completedAt: Date,
    durationMs: Number,
  },
  opts,
);
export const AgentRun = mongoose.model('AgentRun', agentRunSchema, 'agentRuns');

// ---------------------------------------------------------------- screenshots
const screenshotSchema = new Schema(
  {
    runId: { type: ObjectId, ref: 'TestRun', index: true },
    projectId: { type: ObjectId, ref: 'Project', required: true, index: true },
    kind: { type: String, enum: ['capture', 'failure', 'reference'], default: 'capture' },
    agentType: String,
    viewport: { name: String, width: Number, height: Number },
    url: String,
    pagePath: String,
    imageRef: { type: String, required: true },
    annotatedRef: String,
    width: Number,
    height: Number,
    annotations: { type: [Mixed], default: [] },
    isBaseline: { type: Boolean, default: false },
  },
  opts,
);
export const Screenshot = mongoose.model('Screenshot', screenshotSchema, 'screenshots');

// ---------------------------------------------------------------- regressionTests
const regressionTestSchema = new Schema(
  {
    bugId: { type: ObjectId, ref: 'Bug', required: true, index: true },
    projectId: { type: ObjectId, ref: 'Project', required: true, index: true },
    name: String,
    steps: { type: [Mixed], default: [] },
    expected: String,
    status: { type: String, enum: ['pending', 'failing', 'passing', 'error'], default: 'pending' },
    code: String,
    suggestedFix: String,
    lastRunAt: Date,
    lastRunId: { type: ObjectId, ref: 'TestRun' },
    lastResult: { type: Mixed },
    results: { type: [{ at: Date, runId: ObjectId, status: String, detail: String, _id: false }], default: [] },
  },
  opts,
);
export const RegressionTest = mongoose.model('RegressionTest', regressionTestSchema, 'regressionTests');

// ---------------------------------------------------------------- notifications
const notificationSchema = new Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true, index: true },
    workspaceId: { type: ObjectId, ref: 'Workspace' },
    type: String,
    title: String,
    body: String,
    link: String,
    read: { type: Boolean, default: false },
    emailed: { type: Boolean, default: false },
  },
  opts,
);
export const Notification = mongoose.model('Notification', notificationSchema, 'notifications');

// ---------------------------------------------------------------- githubConnections
// One GitHub identity per SaaS user. The access token is AES-256-GCM encrypted and never serialised to clients.
const githubConnectionSchema = new Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true, unique: true },
    githubUserId: { type: Number, required: true, index: true },
    login: { type: String, required: true },
    name: String,
    email: String,
    avatarUrl: String,
    method: { type: String, enum: ['oauth', 'token'], required: true },
    scopes: { type: [String], default: [] },
    tokenEnc: { type: String, required: true },
    lastUsedAt: Date,
    lastError: String,
  },
  opts,
);
export const GithubConnection = mongoose.model('GithubConnection', githubConnectionSchema, 'githubConnections');

// ---------------------------------------------------------------- autoFixes
export const AUTOFIX_STATUSES = [
  'queued',
  'generating',
  'awaiting_approval',
  'applying',
  'validating',
  'committing',
  'pushing',
  'creating_pr',
  'pr_open',
  'merged',
  'closed',
  'rejected',
  'failed',
  'canceled',
] as const;
export type AutoFixStatus = (typeof AUTOFIX_STATUSES)[number];

const fixAttemptSchema = new Schema(
  {
    n: Number,
    engine: String,
    explanation: String,
    edits: { type: [Mixed], default: [] },
    files: { type: [{ path: String, before: String, after: String, additions: Number, deletions: Number, _id: false }], default: [] },
    diff: String,
    patchHash: String,
    feedback: String,
    validation: { type: Mixed },
    status: { type: String, default: 'proposed' },
    error: String,
    createdAt: { type: Date, default: () => new Date() },
    approvedBy: { type: ObjectId, ref: 'User' },
    approvedAt: Date,
  },
  { _id: false },
);

const autoFixSchema = new Schema(
  {
    bugId: { type: ObjectId, ref: 'Bug', required: true, index: true },
    projectId: { type: ObjectId, ref: 'Project', required: true, index: true },
    workspaceId: { type: ObjectId, ref: 'Workspace', required: true, index: true },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    status: { type: String, enum: AUTOFIX_STATUSES, default: 'queued', index: true },
    repo: {
      owner: String,
      name: String,
      baseBranch: String,
      baseSha: String,
      defaultBranch: String,
    },
    branch: String,
    commitSha: String,
    attempts: { type: [fixAttemptSchema], default: [] },
    baseline: { type: Mixed },
    pr: {
      number: Number,
      url: String,
      state: String,
      merged: Boolean,
      draft: Boolean,
      mergeable: { type: Mixed },
      checks: { type: Mixed },
      title: String,
      updatedAt: Date,
    },
    events: { type: [{ ts: Date, level: String, step: String, message: String, _id: false }], default: [] },
    error: String,
  },
  opts,
);
export const AutoFix = mongoose.model('AutoFix', autoFixSchema, 'autoFixes');
export type AutoFixDocument = mongoose.HydratedDocument<InferSchemaType<typeof autoFixSchema>>;

export type ProjectDoc = InferSchemaType<typeof projectSchema> & { _id: Types.ObjectId };
export type BugDoc = InferSchemaType<typeof bugSchema> & { _id: Types.ObjectId };
export type WorkspaceDoc = InferSchemaType<typeof workspaceSchema> & { _id: Types.ObjectId };
