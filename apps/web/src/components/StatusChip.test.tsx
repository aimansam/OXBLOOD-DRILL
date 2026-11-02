import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusChip, drillStatusTone } from './StatusChip';

describe('StatusChip', () => {
  it('labels known statuses', () => {
    render(<StatusChip status="active" />);
    expect(screen.getByText('Live')).toBeInTheDocument();
  });
  it('renders unknown statuses neutrally instead of failing', () => {
    expect(drillStatusTone('weird')).toEqual({ label: 'weird', tone: 'neutral' });
    expect(drillStatusTone('')).toEqual({ label: 'Unknown', tone: 'neutral' });
  });
});
