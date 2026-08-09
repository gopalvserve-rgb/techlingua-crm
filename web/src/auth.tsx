import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api, clearToken, getToken, setToken } from './api';

export interface Me {
  user: { id: number; name: string; email: string | null; phone?: string };
  permissionKeys: string[];
  assignments: Array<Record<string, unknown> & { role_name: string }>;
}

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  can: (permission: string) => boolean;
  /** identifier = mobile number OR email (client update #1) */
  login: (identifier: string, password: string) => Promise<void>;
  /** OTP flow: token already minted by /auth/otp/verify */
  loginWithToken: (token: string) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  // Persist the current user id for per-user client-side prefs (e.g. the column-visibility
  // chooser keys off tlc.uid). Cleared on logout so a shared machine never leaks prefs.
  useEffect(() => {
    try {
      if (me?.user?.id != null) localStorage.setItem('tlc.uid', String(me.user.id));
      else localStorage.removeItem('tlc.uid');
    } catch { /* private mode */ }
  }, [me]);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api.get<Me>('/auth/me')
      .then(setMe)
      .catch(() => clearToken())
      .finally(() => setLoading(false));
  }, []);

  const login = async (identifier: string, password: string) => {
    const res = await api.post<{ token: string }>('/auth/login', { identifier, password });
    setToken(res.token);
    setMe(await api.get<Me>('/auth/me'));
  };

  const loginWithToken = async (token: string) => {
    setToken(token);
    setMe(await api.get<Me>('/auth/me'));
  };

  const logout = () => {
    clearToken();
    setMe(null);
    location.assign('/login');
  };

  const can = (permission: string) => me?.permissionKeys.includes(permission) ?? false;

  return <Ctx.Provider value={{ me, loading, can, login, loginWithToken, logout }}>{children}</Ctx.Provider>;
}
