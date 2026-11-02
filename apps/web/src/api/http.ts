import { ApiError } from './errors';
import { getToken, setToken } from './token';

/**
 * Plain JSON helper for endpoints that do not declare a response model yet
 * (see apps/web/README.md). Callers state the shape they expect; prefer the typed
 * `api` client once an endpoint has a `response_model`.
 */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers['X-Divide-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (response.status === 401) {
    setToken(null);
    window.dispatchEvent(new Event('oxblood:unauthorized'));
  }
  if (!response.ok) throw new ApiError(response.status, parsed);
  return parsed as T;
}

export const http = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
