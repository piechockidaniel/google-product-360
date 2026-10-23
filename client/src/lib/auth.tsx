import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, onUnauthorized } from './api';
import type { SetupStatus, User } from './types';

interface AuthState {
  user: User | null;
  mock: boolean;
  /** DEMO_MODE – synthetic data, guided tour on the dashboard. */
  demo: boolean;
  accountId: string | null;
  /** Merchant Center connection is configured (mock or real credentials). */
  configured: boolean;
  setupCompleted: boolean;
  googleOAuthConfigured: boolean;
  localLoginEnabled: boolean;
  /** No user exists yet – the wizard must create the administrator first. */
  needsAdmin: boolean;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  acknowledge: () => Promise<void>;
  /** Re-reads /auth/me and /setup/status (after the wizard changed something). */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

interface Me {
  user: User;
  mock: boolean;
  demo?: boolean;
  configured: boolean;
  setupCompleted: boolean;
  accountId: string;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [mock, setMock] = useState(false);
  const [demo, setDemo] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [configured, setConfigured] = useState(false);
  const [setupCompleted, setSetupCompleted] = useState(false);
  const [googleOAuthConfigured, setGoogleOAuthConfigured] = useState(false);
  const [localLoginEnabled, setLocalLoginEnabled] = useState(false);
  const [needsAdmin, setNeedsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  const applyMe = (me: Me) => {
    setUser(me.user);
    setMock(me.mock);
    setDemo(!!me.demo);
    setAccountId(me.accountId);
    setConfigured(me.configured);
    setSetupCompleted(me.setupCompleted);
  };

  const refresh = useCallback(async () => {
    const status = await api.get<SetupStatus>('/api/setup/status').catch(() => null);
    if (status) {
      setNeedsAdmin(status.needsAdmin);
      setConfigured(status.configured);
      setSetupCompleted(status.setupCompleted);
      setMock(status.mock);
      setDemo(!!status.demo);
      setGoogleOAuthConfigured(!!status.googleOAuthConfigured);
      setLocalLoginEnabled(!!status.localLoginEnabled);
    }
    try {
      applyMe(await api.get<Me>('/api/auth/me'));
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
    return onUnauthorized(() => setUser(null));
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    await api.post<{ user: User }>('/api/auth/login', { username, password });
    applyMe(await api.get<Me>('/api/auth/me'));
    setNeedsAdmin(false);
  }, []);

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout');
    setUser(null);
  }, []);

  const acknowledge = useCallback(async () => {
    const r = await api.post<{ user: User }>('/api/auth/acknowledge');
    setUser(r.user);
  }, []);

  return (
    <AuthContext.Provider value={{ user, mock, demo, accountId, configured, setupCompleted, googleOAuthConfigured, localLoginEnabled, needsAdmin, loading, login, logout, acknowledge, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
