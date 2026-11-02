/**
 * Turn an API error body into one readable line. Mirrors the legacy portal's
 * `_errorFromResponse` (the retired classic portal's api.js): FastAPI validation errors are
 * an array of {msg}, domain errors are a string or {message}.
 */
export function formatApiError(status: number, body: unknown): string {
  let detail = '';
  if (body && typeof body === 'object') {
    const b = body as { detail?: unknown; message?: unknown };
    if (Array.isArray(b.detail)) {
      detail = b.detail
        .map((item) => (item && typeof item === 'object' && 'msg' in item ? String((item as { msg: unknown }).msg) : JSON.stringify(item)))
        .join('; ');
    } else if (b.detail && typeof b.detail === 'object') {
      const d = b.detail as { message?: unknown };
      detail = d.message ? String(d.message) : JSON.stringify(b.detail);
    } else if (b.detail) {
      detail = String(b.detail);
    } else if (b.message) {
      detail = String(b.message);
    }
  } else if (typeof body === 'string') {
    detail = body;
  }
  return `API error: ${status}${detail ? ` ${detail}` : ''}`;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    body: unknown,
  ) {
    super(formatApiError(status, body));
    this.name = 'ApiError';
  }
}
