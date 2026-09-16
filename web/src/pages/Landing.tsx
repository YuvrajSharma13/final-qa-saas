import { Link } from 'react-router-dom';
import { AGENT_ICON, Icon, type IconName } from '../components/icons';
import { Logo } from '../components/Layout';
import { LinkButton } from '../components/ui';
import { useAuth } from '../lib/auth';
import { AGENT_META } from '../lib/format';

const PILLARS: { icon: IconName; title: string; body: string }[] = [
  { icon: 'terminal', title: 'Built for developers', body: 'Point it at your app, API spec and repo. Get failing checks, network evidence, file:line references, patches and Playwright regression specs.' },
  { icon: 'layers', title: 'Delivered as SaaS', body: 'Accounts, workspaces, persistent projects, run history, a bug tracker, usage limits and plans — nothing to install.' },
  { icon: 'puzzle', title: 'Multi-agent AI', body: 'Seven specialised agents plan, test, correlate and explain. Each has its own input, output and audit trail.' },
  { icon: 'eye', title: 'Computer vision QA', body: 'Screenshots at desktop, tablet and mobile sizes are analysed for clipped, overflowing and overlapping UI and compared with references.' },
];

const PIPELINE = ['test_planner', 'functional_qa', 'api_qa', 'vision_qa', 'bug_analyzer', 'code_analysis', 'regression_test'];

const SAMPLE = `{
  "title": "Checkout UI clipped on mobile",
  "category": "visual",
  "severity": "medium",
  "viewport": "375x812",
  "region": "bottom-right",
  "likelyCause": "min-width: 420px on .place-order-btn inside
                  .checkout-card (overflow: hidden, 343px)",
  "files": ["public/css/styles.css:43"],
  "regressionTest": "regression-checkout-button.spec.ts"
}`;

export default function Landing() {
  const { user } = useAuth();
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Logo />
        <nav className="flex items-center gap-2">
          <a href="#how" className="hidden rounded-lg px-3 py-2 text-sm text-ink-300 hover:text-ink-100 sm:block">
            How it works
          </a>
          <a href="#pricing" className="hidden rounded-lg px-3 py-2 text-sm text-ink-300 hover:text-ink-100 sm:block">
            Pricing
          </a>
          {user ? (
            <LinkButton to="/dashboard" variant="primary">
              Open dashboard
            </LinkButton>
          ) : (
            <>
              <LinkButton to="/login" variant="ghost">
                Sign in
              </LinkButton>
              <LinkButton to="/login?mode=register" variant="primary">
                Start free
              </LinkButton>
            </>
          )}
        </nav>
      </header>

      <section className="grid-bg border-y border-ink-800">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:py-24">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-ink-600 bg-ink-900 px-3 py-1 text-xs text-ink-300">
              <span className="h-1.5 w-1.5 rounded-full bg-accent-400" /> Developer QA platform · delivered as SaaS
            </p>
            <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
              An automated testing team for <span className="text-accent-300">small dev teams</span>.
            </h1>
            <p className="mt-5 max-w-xl text-lg text-ink-300">
              Test functionality, APIs and UI, find bugs, and turn failures into developer-ready fixes and regression tests — without maintaining a dedicated QA team.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <LinkButton to={user ? '/projects/new' : '/login?mode=register'} variant="primary" icon="play" className="px-5 py-2.5 text-base">
                Run AI QA on your app
              </LinkButton>
              <a href="#how" className="inline-flex items-center gap-2 rounded-lg border border-ink-600 px-5 py-2.5 text-ink-100 hover:bg-ink-800">
                See the agents
              </a>
            </div>
            <p className="mt-4 text-sm text-ink-400">Free plan · 1 project · 25 runs a month · no card needed</p>
          </div>
          <div className="overflow-hidden rounded-xl border border-ink-600 bg-ink-900 shadow-2xl">
            <div className="flex items-center gap-1.5 border-b border-ink-700 px-3 py-2">
              <span className="h-2.5 w-2.5 rounded-full bg-ink-600" />
              <span className="h-2.5 w-2.5 rounded-full bg-ink-600" />
              <span className="h-2.5 w-2.5 rounded-full bg-ink-600" />
              <span className="ml-2 font-mono text-xs text-ink-400">bug_analyzer.output.json</span>
            </div>
            <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-ink-100">{SAMPLE}</pre>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight">Four pillars, one workflow</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PILLARS.map((p) => (
            <div key={p.title} className="rounded-xl border border-ink-700 bg-ink-900 p-5">
              <div className="mb-3 inline-flex rounded-lg bg-accent-400/10 p-2 text-accent-300">
                <Icon name={p.icon} size={18} />
              </div>
              <h3 className="font-semibold">{p.title}</h3>
              <p className="mt-2 text-sm text-ink-300">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="how" className="border-y border-ink-800 bg-ink-900/50">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight">How the agents collaborate</h2>
          <p className="mt-2 max-w-2xl text-ink-300">
            The Test Planner builds a shared plan. Functional, API and Vision agents execute it in parallel. The Bug Analyzer clusters their evidence, Code Analysis inspects your repository, and the Regression agent turns each confirmed issue into a repeatable check.
          </p>
          <ol className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {PIPELINE.map((a, i) => (
              <li key={a} className="rounded-xl border border-ink-700 bg-ink-900 p-4">
                <div className="flex items-center gap-2 text-sm">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-ink-800 text-xs font-semibold text-ink-300">{i + 1}</span>
                  <Icon name={AGENT_ICON[a]} className="text-accent-300" />
                  <span className="font-semibold">{AGENT_META[a].name}</span>
                </div>
                <p className="mt-2 text-sm text-ink-400">{AGENT_META[a].role}</p>
              </li>
            ))}
            <li className="rounded-xl border border-accent-400/30 bg-accent-400/5 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Icon name="dashboard" className="text-accent-300" /> SaaS dashboard
              </div>
              <p className="mt-2 text-sm text-ink-400">Runs, bugs, evidence, trends and regression status stored per project.</p>
            </li>
          </ol>
          <div className="mt-10 grid gap-4 lg:grid-cols-3">
            {[
              ['Why multi-agent?', 'Each QA task needs different reasoning and evidence. Separate agents produce structured, traceable outputs instead of one opaque answer.'],
              ['Where is computer vision used?', 'In visual QA: screenshots across viewports are analysed for clipped buttons, overflow, overlaps and broken media, and compared with reference mockups.'],
              ['Can it fix code?', 'It proposes a patch with file and line references for you to review. It never edits your production code on its own.'],
            ].map(([q, a]) => (
              <div key={q} className="rounded-xl border border-ink-700 p-5">
                <h3 className="font-semibold">{q}</h3>
                <p className="mt-2 text-sm text-ink-300">{a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="pricing" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight">Plans</h2>
        <p className="mt-2 text-ink-400">Example pricing — billing runs in test mode in this build.</p>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {[
            ['Free', '$0', ['1 project', '25 QA runs / month', 'Functional, API & visual QA (desktop + mobile)', 'Basic reports']],
            ['Pro', '$29/mo', ['10 projects', '300 QA runs / month', 'Tablet viewport + visual baselines', 'Repository root-cause analysis', 'Email alerts, 90-day history']],
            ['Team', '$99/mo', ['Up to 10 developers', 'Shared workspace & roles', '1,500 QA runs / month', 'Advanced reporting', 'CI/CD triggers (coming soon)']],
          ].map(([name, price, feats], i) => (
            <div key={name as string} className={`rounded-xl border p-6 ${i === 1 ? 'border-accent-400/50 bg-accent-400/5' : 'border-ink-700 bg-ink-900'}`}>
              <h3 className="font-semibold">{name}</h3>
              <div className="mt-2 text-3xl font-semibold">{price}</div>
              <ul className="mt-4 space-y-2 text-sm text-ink-300">
                {(feats as string[]).map((f) => (
                  <li key={f} className="flex gap-2">
                    <Icon name="check" className="mt-0.5 shrink-0 text-accent-300" />
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-ink-800">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-sm text-ink-400 sm:px-6">
          <span>AI QA SaaS — a developer QA platform for small businesses and small development teams.</span>
          <Link to="/login" className="hover:text-ink-100">
            Sign in →
          </Link>
        </div>
      </footer>
    </div>
  );
}
