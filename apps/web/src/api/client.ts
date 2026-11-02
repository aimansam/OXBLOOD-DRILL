import createClient, { type Middleware } from 'openapi-fetch';
import { ApiError } from './errors';
import type { paths } from './schema';
import { getToken, setToken } from './token';

const auth: Middleware = {
  onRequest({ request }) {
    const token = getToken();
    if (token) request.headers.set('X-Divide-Token', token);
    return request;
  },
  onResponse({ response }) {
    // An expired or invalid token: drop it so the router sends the user to sign in.
    if (response.status === 401) {
      setToken(null);
      window.dispatchEvent(new Event('oxblood:unauthorized'));
    }
    return response;
  },
};

// Absolute same-origin base: `Request` needs a full URL (browsers resolve '' fine, jsdom/Node do not).
// Resolve fetch at call time (not at import) so tests can stub it.
export const api = createClient<paths>({ baseUrl: window.location.origin, fetch: (request) => fetch(request) });
api.use(auth);

/** Unwrap an openapi-fetch result: return data, or throw an ApiError with a readable message. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || result.data === undefined) {
    throw new ApiError(result.response.status, result.error);
  }
  return result.data;
}
