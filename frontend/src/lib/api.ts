import type { ApiErrorBody, ErrorCode } from '@shared';

/**
 * Thin fetch wrapper.
 *
 * Two things it does that matter:
 *   1. keeps the short-lived access token in memory only (never localStorage), so an
 *      XSS payload cannot read it out of storage; the refresh token lives in an
 *      httpOnly cookie the browser sends automatically;
 *   2. transparently refreshes once on a 401 and replays the original request, with a
 *      single shared in-flight refresh so a page issuing five parallel calls does not
 *      trigger five rotations.
 */

export const API_BASE = import.meta.env.VITE_API_URL ?? '';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(status: number, body: ApiErrorBody | null, fallback: string) {
    super(body?.error?.message ?? fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error?.code ?? 'INTERNAL_ERROR';
    this.details = body?.error?.details;
  }
}

let accessToken: string | null = null;
let onAuthLost: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}
export function getAccessToken(): string | null {
  return accessToken;
}
export function setAuthLostHandler(fn: (() => void) | null): void {
  onAuthLost = fn;
}

let refreshInFlight: Promise<boolean> | null = null;

async function refreshOnce(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { accessToken: string };
      accessToken = data.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      // Allow the next 401 to trigger a fresh attempt.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();
  return refreshInFlight;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Set false for the auth endpoints themselves, to avoid a refresh loop. */
  retryOnUnauthorized?: boolean;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, retryOnUnauthorized = true } = options;

  const send = async (): Promise<Response> =>
    fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      signal: signal ?? null,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  let res = await send();

  if (res.status === 401 && retryOnUnauthorized) {
    if (await refreshOnce()) {
      res = await send();
    } else {
      accessToken = null;
      onAuthLost?.();
    }
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;

  if (!res.ok) {
    throw new ApiError(res.status, data as ApiErrorBody, `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { ...(signal ? { signal } : {}) }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
