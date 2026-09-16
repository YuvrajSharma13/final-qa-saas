import { useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { Logo } from '../components/Layout';
import { Button, ErrorBox, Field, Input, Tabs } from '../components/ui';
import { useAuth } from '../lib/auth';

export default function Login() {
  const [params] = useSearchParams();
  const [mode, setMode] = useState<'login' | 'register'>(params.get('mode') === 'register' ? 'register' : 'login');
  const { user, login, register } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '', workspaceName: '' });
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState(params.get('next') || '/dashboard');

  // After sign-up the auth context updates first; this redirect then sends new users to project setup.
  if (user) return <Navigate to={target} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') setTarget('/projects/new');
      if (mode === 'login') await login(form.email, form.password);
      else await register({ name: form.name, email: form.email, password: form.password, workspaceName: form.workspaceName || undefined });
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="grid-bg flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-2xl border border-ink-700 bg-ink-900 p-6 shadow-2xl">
          <Tabs
            tabs={[
              { id: 'login', label: 'Sign in' },
              { id: 'register', label: 'Create account' },
            ]}
            value={mode}
            onChange={(m) => {
              setMode(m);
              setError(null);
            }}
          />
          <form onSubmit={submit} className="mt-5 space-y-4" noValidate>
            <ErrorBox error={error} />
            {mode === 'register' && (
              <>
                <Field label="Your name" htmlFor="name">
                  <Input id="name" autoComplete="name" value={form.name} onChange={set('name')} required />
                </Field>
                <Field label="Workspace name" htmlFor="workspaceName" hint="Your team or company. You can change it later.">
                  <Input id="workspaceName" placeholder="Acme Web Team" value={form.workspaceName} onChange={set('workspaceName')} />
                </Field>
              </>
            )}
            <Field label="Email" htmlFor="email">
              <Input id="email" type="email" autoComplete="email" value={form.email} onChange={set('email')} required />
            </Field>
            <Field label="Password" htmlFor="password" hint={mode === 'register' ? 'At least 8 characters.' : undefined}>
              <Input id="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={set('password')} required />
            </Field>
            <Button type="submit" variant="primary" className="w-full" loading={busy}>
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
