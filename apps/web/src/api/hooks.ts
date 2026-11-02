import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from './client';
import { http } from './http';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => unwrap(await api.GET('/api/v1/me')),
    staleTime: 60_000,
    retry: false,
  });
}

/** Drills are polled: status changes (prepare/start/stop) happen outside this tab. */
export function useDrills() {
  return useQuery({
    queryKey: ['drills'],
    queryFn: async () => unwrap(await api.GET('/api/v2/drills')).drills,
    refetchInterval: 10_000,
  });
}

export function useScenarios() {
  return useQuery({
    queryKey: ['scenarios'],
    queryFn: async () => unwrap(await api.GET('/api/v1/scenarios')).items,
    staleTime: 5 * 60_000,
  });
}

/** Scenario catalog including specs (needed by the wizard and Organizations). */
export function useScenarioCatalog() {
  return useQuery({
    queryKey: ['scenarios', 'catalog'],
    queryFn: async () => unwrap(await api.GET('/api/v1/scenarios', { params: { query: { include_run_count: true } } })).items,
    staleTime: 60_000,
  });
}

export interface EnvironmentLock {
  available: boolean;
  drill_id?: number | null;
  owner_sub?: string | null;
}

/** The range is shared: only one exercise can hold it at a time. */
export function useEnvironmentLock() {
  return useQuery({
    queryKey: ['environment-lock'],
    queryFn: () => http.get<EnvironmentLock>('/api/v2/drills/environment-lock'),
    refetchInterval: 15_000,
  });
}
