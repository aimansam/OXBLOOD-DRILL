import { describe, expect, it } from 'vitest';
import { inviteUrl, participantName } from './api';

describe('teams helpers', () => {
  it('builds the join link with the token in the fragment (never sent to the server)', () => {
    expect(inviteUrl('abc123', 'https://range.example')).toBe('https://range.example/join#token=abc123');
  });
  it('names a participant from username, then sub, then id', () => {
    expect(participantName({ user_id: 1, role: 'red', username: 'ana', sub: 'x' })).toBe('ana');
    expect(participantName({ user_id: 2, role: 'red', sub: 'bob' })).toBe('bob');
    expect(participantName({ user_id: 3, role: 'red' })).toBe('User 3');
  });
});
