import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getWorkspaceId, setToken, setWorkspaceId } from './api';

export interface WorkspaceInfo {
  id: string;
  name: string;
  plan: string;
  planName: string;
  role: 'owner' | 'admin' | 'developer' | 'viewer';
}
export interface User {
  id: string;
  name: string;
  email: string;
}

interface AuthState {
  user: User | null;
  workspaces: WorkspaceInfo[];
  workspace: WorkspaceInfo | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { name: string; email: string; password: string; workspaceName?: string }) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  switchWorkspace: (id: string) => void;
  can: (min: WorkspaceInfo['role']) => boolean;
}

const Ctx = createContext<AuthState | null>(null);
const RANK = { viewer: 0, developer: 1, admin: 2, owner: 3 };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [wsId, setWsId] = useState(getWorkspaceId());
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ user: User; workspaces: WorkspaceInfo[] }>('/auth/me');
      setUser(me.user);
      setWorkspaces(me.workspaces);
      const current = me.workspaces.find((w) => w.id === getWorkspaceId()) || me.workspaces[0];
      if (current) {
        setWorkspaceId(current.id);
        setWsId(current.id);
      }
    } catch {
      setUser(null);
      setWorkspaces([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo<AuthState>(() => {
    const workspace = workspaces.find((w) => w.id === wsId) || workspaces[0] || null;
    return {
      user,
      workspaces,
      workspace,
      loading,
      refresh,
      login: async (email, password) => {
        const res = await api<{ token?: string }>('/auth/login', { method: 'POST', body: { email, password } });
        if (res.token) setToken(res.token);
        await refresh();
      },
      register: async (input) => {
        const res = await api<{ token?: string }>('/auth/register', { method: 'POST', body: input });
        if (res.token) setToken(res.token);
        await refresh();
      },
      logout: async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        setToken('');
        setUser(null);
        setWorkspaces([]);
      },
      switchWorkspace: (id) => {
        setWorkspaceId(id);
        setWsId(id);
      },
      can: (min) => Boolean(workspace && RANK[workspace.role] >= RANK[min]),
    };
  }, [user, workspaces, wsId, loading, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
