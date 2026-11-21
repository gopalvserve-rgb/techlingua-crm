/** Minimal typed fetch wrapper. JWT lives in localStorage; 401 bounces to /login. */

const TOKEN_KEY = 'tl_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    clearToken();
    if (!location.pathname.startsWith('/login')) location.assign('/login');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = Array.isArray(data?.message) ? data.message.join(', ') : data?.message ?? res.statusText;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

/**
 * Upload a file to a presigned storage link (an upload-url route's `url`). 22 Nov 2026: the R2
 * bucket refuses browser uploads (no CORS rule), so a direct PUT from the browser always failed —
 * the admission-form logo, vertical logo / QR, study material, question media, submissions,
 * franchise and placement files. The bytes now go to our API, which makes the same signed PUT.
 * Returns the response so callers keep their `if (!res.ok)` checks.
 */
export async function putToStorage(url: string, file: Blob, contentType?: string): Promise<Response> {
  const ct = contentType || file.type || 'application/octet-stream';
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'X-Upload-Url': url };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`/api/storage/relay?ct=${encodeURIComponent(ct)}`, { method: 'POST', headers, body: file });
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
