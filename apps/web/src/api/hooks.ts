import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from './client';

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
