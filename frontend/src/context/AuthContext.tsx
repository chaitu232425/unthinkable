import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthResponse, PublicUser, RegistrationPendingResponse, UserRole } from '@shared';
import { api, request, setAccessToken, setAuthLostHandler } from '@/lib/api';

interface AuthState {
  user: PublicUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<PublicUser>;
  /** Step 1 of 2: stages the account and emails a code. No session yet. */
  register: (input: {
    fullName: string;
    email: string;
    password: string;
    role: UserRole;
  }) => Promise<RegistrationPendingResponse>;
  /** Step 2 of 2: confirms the emailed code, creates the account, and signs in. */
  verifyEmail: (email: string, code: string) => Promise<PublicUser>;
  logout: () => Promise<void>;
  hasRole: (...roles: UserRole[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Module-scoped, not component-scoped: React 18 StrictMode deliberately mounts every
 * component twice in development, which would otherwise fire two real
 * `/api/auth/refresh` requests back to back. The refresh token rotates on use and the
 * *previous* one is immediately marked revoked, so the second request — arriving a
 * moment later with what is now a stale cookie — reads as a stolen token and trips the
 * reuse-detection path in auth.service.ts, which revokes the session the first request
 * had just legitimately established. Caching the in-flight promise means both mounts
 * observe the same single request instead of racing each other.
 */
let bootSession: Promise<AuthResponse | null> | null = null;
function refreshBootSession(): Promise<AuthResponse | null> {
  bootSession ??= request<AuthResponse>('/api/auth/refresh', {
    method: 'POST',
    retryOnUnauthorized: false,
  }).catch(() => null);
  return bootSession;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * On boot the app has no access token — it lives in memory and memory is gone after
   * a reload. The httpOnly refresh cookie survives, so a single silent refresh restores
   * the session without ever having put a token in localStorage.
   */
  useEffect(() => {
    let cancelled = false;
    refreshBootSession().then((session) => {
      if (cancelled) return;
      if (session) {
        setAccessToken(session.accessToken);
        setUser(session.user);
      } else {
        setUser(null);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setAuthLostHandler(() => setUser(null));
    return () => setAuthLostHandler(null);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const session = await request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
      retryOnUnauthorized: false,
    });
    setAccessToken(session.accessToken);
    setUser(session.user);
    return session.user;
  }, []);

  const register = useCallback(
    async (input: { fullName: string; email: string; password: string; role: UserRole }) => {
      return request<RegistrationPendingResponse>('/api/auth/register', {
        method: 'POST',
        body: input,
        retryOnUnauthorized: false,
      });
    },
    [],
  );

  const verifyEmail = useCallback(async (email: string, code: string) => {
    const session = await request<AuthResponse>('/api/auth/verify-email', {
      method: 'POST',
      body: { email, code },
      retryOnUnauthorized: false,
    });
    setAccessToken(session.accessToken);
    setUser(session.user);
    return session.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      setAccessToken(null);
      setUser(null);
    }
  }, []);

  const hasRole = useCallback(
    (...roles: UserRole[]) => (user ? roles.includes(user.role) : false),
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, login, register, verifyEmail, logout, hasRole }),
    [user, loading, login, register, verifyEmail, logout, hasRole],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
