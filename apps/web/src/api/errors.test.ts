import { describe, expect, it } from 'vitest';
import { formatApiError } from './errors';

describe('formatApiError', () => {
  it('uses a string detail', () => {
    expect(formatApiError(401, { detail: 'invalid credentials' })).toBe('API error: 401 invalid credentials');
  });
  it('joins FastAPI validation messages', () => {
    expect(formatApiError(422, { detail: [{ msg: 'Field required' }, { msg: 'too short' }] })).toBe('API error: 422 Field required; too short');
  });
  it('prefers detail.message for domain errors', () => {
    expect(formatApiError(409, { detail: { code: 'x', message: 'Range already prepared' } })).toBe('API error: 409 Range already prepared');
  });
  it('falls back to message, then to status only', () => {
    expect(formatApiError(500, { message: 'boom' })).toBe('API error: 500 boom');
    expect(formatApiError(502, undefined)).toBe('API error: 502');
  });
});
