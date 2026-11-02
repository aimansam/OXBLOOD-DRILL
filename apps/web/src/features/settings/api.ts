import { useQuery } from '@tanstack/react-query';
import { http } from '@/api/http';
import type { ExpectedBridges, PveConfigResponse, SdnStatus, StorageStatus, TemplateStatus } from '@/api/types';

export interface PveConfig extends PveConfigResponse {
  host?: string;
  user?: string;
  port?: number;
  token_id?: string;
  token_secret?: boolean | string;
  verify_ssl?: boolean;
  source?: string;
}
export interface PveConfigInput {
  host: string;
  token_id: string;
  token_secret: string;
  user?: string;
  port?: number;
  node?: string;
  clone_storage: string;
  seed_snippet_storage: string;
  verify_ssl: boolean;
}
export interface UserRow {
  sub: string;
  role: string;
  disabled?: boolean;
  last_login_at?: string | null;
}
export interface Guest {
  vmid: number;
  name?: string;
  node?: string;
  status?: string;
  type?: string;
}
export interface Orphan {
  source?: string;
  asset_id?: number;
  pve_vmid?: number;
  pve_node?: string;
  pve_name?: string;
  role?: string;
  reason?: string;
  age_seconds?: number;
}
export interface Health {
  health?: { status?: string; version?: string; env?: string } | null;
  ready?: { status?: string; checks?: Record<string, string> } | null;
}

export const adminApi = {
  savePve: (input: PveConfigInput) => http.post<unknown>('/api/v1/admin/pve-config', input),
  revertPve: () => http.delete<unknown>('/api/v1/admin/pve-config'),
  createUser: (sub: string, password: string, role: string) => http.post<unknown>('/api/v1/auth/users', { sub, password, role }),
  toggleUser: (sub: string) => http.post<unknown>(`/api/v1/auth/users/${encodeURIComponent(sub)}/toggle-disabled`),
  setupBridges: (node: string, dryRun: boolean) => http.post<unknown>('/api/v1/admin/pve-setup-bridges', { node: node || 'pve', dry_run: dryRun }),
  cleanupOrphans: (assetIds: number[], pveVms: { vmid: number; node: string }[]) =>
    http.post<{ destroyed?: number; failed?: unknown[] }>('/api/v1/admin/assets/cleanup', { grace_minutes: 5, asset_ids: assetIds, pve_vms: pveVms }),
};

export const usePveConfig = () => useQuery({ queryKey: ['pve-config'], queryFn: () => http.get<PveConfig>('/api/v1/admin/pve-config'), retry: false });
export const useUsers = () =>
  useQuery({
    queryKey: ['users'],
    queryFn: async () => {
      const r = await http.get<UserRow[] | { items?: UserRow[]; users?: UserRow[] }>('/api/v1/auth/users');
      return Array.isArray(r) ? r : (r.items ?? r.users ?? []);
    },
  });
export const useTemplateStatus = () => useQuery({ queryKey: ['template-status'], queryFn: () => http.get<TemplateStatus>('/api/v1/admin/drill-template-status'), retry: false });
export const useExpectedBridges = () => useQuery({ queryKey: ['expected-bridges'], queryFn: () => http.get<ExpectedBridges>('/api/v1/admin/expected-bridges'), retry: false });
export const useSdnStatus = (node: string) => useQuery({ queryKey: ['sdn-status', node], queryFn: () => http.get<SdnStatus>(`/api/v1/admin/pve-sdn-status?node=${encodeURIComponent(node)}`), retry: false });
export const useStorage = () => useQuery({ queryKey: ['storage'], queryFn: () => http.get<StorageStatus>(`/api/v1/admin/storage?_=${Date.now()}`), retry: false });
export const useGuests = (drillOnly: boolean) =>
  useQuery({
    queryKey: ['guests', drillOnly],
    queryFn: () => http.get<{ items?: Guest[]; total?: number; total_registered?: number }>(`/api/v1/admin/pve-guests?drill_only=${drillOnly}&_=${Date.now()}`),
    retry: false,
    refetchInterval: 30_000,
  });
export const useOrphans = () => useQuery({ queryKey: ['orphans'], queryFn: () => http.get<{ items?: Orphan[]; total?: number }>('/api/v1/admin/assets/orphans?grace_minutes=5'), retry: false });
export const useHealth = () =>
  useQuery({
    queryKey: ['health'],
    queryFn: async (): Promise<Health> => {
      const get = (p: string) => fetch(p).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const [health, ready] = await Promise.all([get('/api/healthz'), get('/api/readyz')]);
      return { health, ready };
    },
    refetchInterval: 30_000,
  });

/** "5m", "2h 10m": the time a token or an orphan has left or lived. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${Math.max(1, m)}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}
