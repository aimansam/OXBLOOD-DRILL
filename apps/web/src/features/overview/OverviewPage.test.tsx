import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WizardProvider } from '../wizard/WizardProvider';
import { OverviewPage } from './OverviewPage';

function mockApi(drills: unknown[], scenarios: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      const body = url.includes('/api/v2/drills') ? { drills } : url.includes('/api/v1/audit') ? { items: [{ id: 1, action: 'run.started', actor: 'admin', at: '2026-11-01T00:00:00' }] } : { items: scenarios, total: scenarios.length };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WizardProvider>
          <OverviewPage />
        </WizardProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

const drill = (id: number, status: string, title: string) => ({ id, title, status, drill_type: 'individual', created_at: '2026-11-01T00:00:00' });

describe('OverviewPage', () => {
  it('shows counts and the next exercise', async () => {
    mockApi([drill(1, 'completed', 'Old run'), drill(2, 'scheduled', 'Friday drill'), drill(3, 'scheduled', 'Other')], [{ id: 1 }, { id: 2 }]);
    renderPage();
    expect(await screen.findByText('Friday drill', { selector: 'div.text-lg' })).toBeInTheDocument();
    expect(await screen.findByText('Organizations')).toBeInTheDocument();
    expect(await screen.findByText('Run started')).toBeInTheDocument();
  });

  it('shows a call to action when nothing is scheduled', async () => {
    mockApi([], []);
    renderPage();
    expect(await screen.findByText('Nothing scheduled')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New exercise' }).length).toBeGreaterThan(0);
  });
});
