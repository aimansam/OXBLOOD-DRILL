import { describe, expect, it } from 'vitest';
import { cn, formatWhen } from './utils';

describe('formatWhen', () => {
  it('shows a dash for empty or invalid input', () => {
    expect(formatWhen(null)).toBe('—');
    expect(formatWhen('not a date')).toBe('—');
  });
  it('treats naive API timestamps as UTC', () => {
    // The API returns naive UTC; without the Z the browser would read it as local time.
    const naive = formatWhen('2026-11-02T08:00:00');
    const explicit = formatWhen('2026-11-02T08:00:00Z');
    expect(naive).toBe(explicit);
  });
});

describe('cn', () => {
  it('merges conflicting tailwind classes', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });
});
