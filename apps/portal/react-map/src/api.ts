import type { Drill, ThreatMap } from './types';

const token = () => window.localStorage.getItem('divide_token') || '';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('X-Divide-Token', token());
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401) {
    window.location.assign('/login?expired=1');
    throw new Error('Your session has expired.');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.detail?.message || body?.detail || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  getMe: () => request<{ role: string; sub: string }>('/api/v1/me'),
  getDrill: (drillId: number) => request<Drill>(`/api/v2/drills/${drillId}`),
  getDrills: () => request<{ drills: Drill[] }>('/api/v2/drills'),
  getThreatMap: (drillId: number) => request<ThreatMap>(`/api/v2/drills/${drillId}/threat-map`),
  openConsole: (drillId: number, assetId: number) => request<{ launch_url: string }>(
    `/api/v2/drills/${drillId}/access/${assetId}/console`,
    { method: 'POST', body: '{}' },
  ),
};
