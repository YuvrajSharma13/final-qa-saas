import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { AppLayout } from './components/Layout';
import { PageLoader } from './components/ui';
import './index.css';
import { AuthProvider, useAuth } from './lib/auth';
import Billing from './pages/Billing';
import BugDetail from './pages/BugDetail';
import Bugs from './pages/Bugs';
import Dashboard from './pages/Dashboard';
import Landing from './pages/Landing';
import Login from './pages/Login';
import NewProject from './pages/NewProject';
import ProjectOverview from './pages/ProjectOverview';
import Projects from './pages/Projects';
import RunConfig from './pages/RunConfig';
import RunView from './pages/RunView';
import Settings from './pages/Settings';

function RequireAuth() {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <PageLoader />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <Outlet />;
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-lg py-20 text-center">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-ink-400">{this.state.error.message}</p>
        <button className="mt-4 rounded-lg bg-ink-800 px-3 py-2 text-sm" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

function NotFound() {
  return (
    <div className="py-20 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-ink-400">The page you requested does not exist.</p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth />}>
            <Route element={<AppLayout />}>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/projects/new" element={<NewProject />} />
              <Route path="/projects/:id" element={<ProjectOverview />} />
              <Route path="/projects/:id/run" element={<RunConfig />} />
              <Route path="/runs/:id" element={<RunView />} />
              <Route path="/bugs" element={<Bugs />} />
              <Route path="/bugs/:id" element={<BugDetail />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/billing" element={<Billing />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
