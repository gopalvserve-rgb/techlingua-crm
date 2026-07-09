import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api, clearToken, getToken, setToken } from './api';

export interface Me {
  user: { id: number; name: string; email: string };
  permissionKeys: string[];
  assignments: Array<Record<string, unknown> & { role_name: string }>;
}

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  can: (permission: string) => boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

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

  const login = async (email: string, password: string) => {
    const res = await api.post<{ token: string }>('/auth/login', { email, password });
    setToken(res.token);
    setMe(await api.get<Me>('/auth/me'));
  };

  const logout = () => {
    clearToken();
    setMe(null);
    location.assign('/login');
  };

  const can = (permission: string) => me?.permissionKeys.includes(permission) ?? false;

  return <Ctx.Provider value={{ me, loading, can, login, logout }}>{children}</Ctx.Provider>;
}
