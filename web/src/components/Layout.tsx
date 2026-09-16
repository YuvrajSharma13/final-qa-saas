import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, useApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { timeAgo } from '../lib/format';
import { Icon, type IconName } from './icons';
import { Badge, cx, LinkButton } from './ui';

const NAV: { to: string; label: string; icon: IconName }[] = [
  { to: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { to: '/projects', label: 'Projects', icon: 'folder' },
  { to: '/bugs', label: 'Bugs', icon: 'bug' },
  { to: '/fixes', label: 'AI fixes', icon: 'wand' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
  { to: '/billing', label: 'Billing & usage', icon: 'card' },
];

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-ink-800 ring-1 ring-ink-600">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" stroke="#2dd4bf" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="19" cy="18" r="2.4" fill="#f97316" />
        </svg>
      </span>
      {!compact && (
        <span>
          AI QA <span className="text-ink-400 font-normal">SaaS</span>
        </span>
      )}
    </Link>
  );
}

interface Notif {
  _id: string;
  title: string;
  body: string;
  link: string;
  read: boolean;
  createdAt: string;
  type: string;
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const { data, reload } = useApi<{ notifications: Notif[]; unread: number }>('/notifications', { pollMs: 15000 });
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button aria-label="Notifications" onClick={() => setOpen((o) => !o)} className="relative rounded-lg p-2 text-ink-300 hover:bg-ink-800 hover:text-ink-100">
        <Icon name="bell" size={18} />
        {!!data?.unread && <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">{data.unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-ink-600 bg-ink-850 shadow-2xl">
          <div className="flex items-center justify-between border-b border-ink-700 px-3 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            <button
              className="text-xs text-accent-300 hover:underline"
              onClick={async () => {
                await api('/notifications/read-all', { method: 'POST' });
                reload();
              }}
            >
              Mark all read
            </button>
          </div>
          <div className="scroll-thin max-h-96 overflow-y-auto">
            {!data?.notifications.length && <p className="p-4 text-sm text-ink-400">You're all caught up.</p>}
            {data?.notifications.map((n) => (
              <button
                key={n._id}
                onClick={async () => {
                  await api(`/notifications/${n._id}/read`, { method: 'POST' });
                  reload();
                  setOpen(false);
                  nav(n.link);
                }}
                className={cx('block w-full border-b border-ink-700 px-3 py-2.5 text-left hover:bg-ink-800', !n.read && 'bg-accent-400/5')}
              >
                <div className="flex items-center gap-2">
                  {!n.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400" />}
                  <span className="text-sm font-medium">{n.title}</span>
                </div>
                <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-xs text-ink-400">{n.body}</p>
                <p className="mt-1 text-[11px] text-ink-400">{timeAgo(n.createdAt)}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function AppLayout() {
  const { user, workspace, workspaces, switchWorkspace, logout } = useAuth();
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => setMenu(false), [loc.pathname]);

  const sidebar = (
    <nav className="flex h-full flex-col gap-1 p-3" aria-label="Main">
      <div className="mb-4 px-2 pt-1">
        <Logo />
      </div>
      {workspaces.length > 0 && (
        <div className="mb-3 px-1">
          <label htmlFor="ws" className="mb-1 block px-1 text-[11px] uppercase tracking-wider text-ink-400">
            Workspace
          </label>
          <select
            id="ws"
            value={workspace?.id}
            onChange={(e) => {
              switchWorkspace(e.target.value);
              nav('/dashboard');
            }}
            className="w-full rounded-lg border border-ink-600 bg-ink-850 px-2 py-1.5 text-sm"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          {workspace && (
            <div className="mt-1.5 flex items-center gap-1.5 px-1 text-xs text-ink-400">
              <Badge className="bg-accent-400/10 text-accent-300 ring-accent-400/30">{workspace.planName}</Badge>
              <span>· {workspace.role}</span>
            </div>
          )}
        </div>
      )}
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          className={({ isActive }) => cx('flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition', isActive ? 'bg-ink-800 text-ink-100' : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100')}
        >
          <Icon name={n.icon} size={16} />
          {n.label}
        </NavLink>
      ))}
      <div className="mt-auto rounded-lg border border-ink-700 bg-ink-850 p-3">
        <div className="truncate text-sm font-medium">{user?.name}</div>
        <div className="truncate text-xs text-ink-400">{user?.email}</div>
        <button
          onClick={async () => {
            await logout();
            nav('/login');
          }}
          className="mt-2 flex items-center gap-1.5 text-xs text-ink-300 hover:text-ink-100"
        >
          <Icon name="logout" size={13} /> Sign out
        </button>
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-ink-700 bg-ink-900 lg:block">{sidebar}</aside>
      {menu && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMenu(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-ink-700 bg-ink-900">{sidebar}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-ink-700 bg-ink-950/85 px-4 backdrop-blur">
          <button className="rounded-lg p-2 text-ink-300 hover:bg-ink-800 lg:hidden" aria-label="Open menu" onClick={() => setMenu(true)}>
            <Icon name="menu" size={18} />
          </button>
          <div className="lg:hidden">
            <Logo compact />
          </div>
          <div className="flex-1" />
          <LinkButton to="/projects/new" variant="primary" icon="plus" className="hidden sm:inline-flex">
            New project
          </LinkButton>
          <Notifications />
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
