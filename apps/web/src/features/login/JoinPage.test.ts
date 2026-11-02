import { describe, expect, it } from 'vitest';
import { readInviteToken } from './JoinPage';

const token = 'A'.repeat(43);

describe('readInviteToken', () => {
  it('accepts a 43-character URL-safe token from the fragment', () => {
    expect(readInviteToken(`#token=${token}`)).toBe(token);
    expect(readInviteToken(`token=${token}`)).toBe(token);
  });
  it('rejects missing, short, long or unsafe tokens', () => {
    expect(readInviteToken('')).toBeNull();
    expect(readInviteToken('#token=abc')).toBeNull();
    expect(readInviteToken(`#token=${token}x`)).toBeNull();
    expect(readInviteToken(`#token=${'A'.repeat(42)}!`)).toBeNull();
    expect(readInviteToken(`#other=${token}`)).toBeNull();
  });
});
