import { describe, expect, it } from 'vitest';
import { formatDuration } from './api';

describe('formatDuration', () => {
  it('formats minutes and hours', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(30)).toBe('1m');
    expect(formatDuration(600)).toBe('10m');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(7500)).toBe('2h 5m');
  });
  it('treats bad input as zero', () => {
    expect(formatDuration(Number.NaN)).toBe('0m');
    expect(formatDuration(-5)).toBe('0m');
  });
});
