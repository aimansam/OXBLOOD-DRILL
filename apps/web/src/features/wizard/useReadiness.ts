import { useQuery } from '@tanstack/react-query';
import { http } from '@/api/http';
import type {
  ExpectedBridges,
  PveConfigResponse,
  Scenario,
  ScenarioPreflight,
  SdnStatus,
  StorageStatus,
  TemplateList,
  TemplateStatus,
} from '@/api/types';
import { type Readiness, computeReadiness } from './readiness';

const msg = (e: unknown) => String(e instanceof Error ? e.message : e);

/** Gathers every readiness input (each may fail independently) and reduces them to one model. */
export function useReadiness(scenario: Scenario | undefined, enabled: boolean) {
  return useQuery<Readiness>({
    queryKey: ['readiness', scenario?.id],
    enabled: enabled && Boolean(scenario),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      if (!scenario) throw new Error('No scenario');
      const pve = await http.get<PveConfigResponse>('/api/v1/admin/pve-config').catch(() => ({}) as PveConfigResponse);
      const node = pve.node || pve.config?.node || 'pve';
      const [templateStatus, pveTemplates, bridgePlan, bridgeStatus, storageStatus, preflight] = await Promise.all([
        http.get<TemplateStatus>('/api/v1/admin/drill-template-status').catch((e) => ({ ready: false, error: msg(e), available: [] }) as TemplateStatus),
        http.get<TemplateList>(`/api/v1/proxmox/templates?node=${encodeURIComponent(node)}`).catch((e) => ({ items: [], error: msg(e) }) as TemplateList),
        http.get<ExpectedBridges>('/api/v1/admin/expected-bridges').catch((e) => ({ bridges: [], conflicts: [], error: msg(e) }) as ExpectedBridges),
        http.get<SdnStatus>(`/api/v1/admin/pve-sdn-status?node=${encodeURIComponent(node)}`).catch((e) => ({ reachable: false, error: msg(e) }) as SdnStatus),
        http.get<StorageStatus>(`/api/v1/admin/storage?_=${Date.now()}`).catch((e) => ({ items: [], error: msg(e) }) as StorageStatus),
        http
          .get<ScenarioPreflight>(`/api/v2/drills/scenario-preflight/${scenario.id}`)
          .catch((e) => ({ ready: false, node, checks: [{ ready: false, detail: msg(e) }] }) as ScenarioPreflight),
      ]);
      return computeReadiness({ scenario, pve, templateStatus, pveTemplates, bridgePlan, bridgeStatus, storageStatus, preflight });
    },
  });
}
