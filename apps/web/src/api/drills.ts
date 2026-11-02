import { http } from './http';
import type { Drill, DrillStatus } from './types';

// Drill commands. Paths match the FastAPI routers in apps/api/app/routers/drills_v2.
export interface DrillInput {
  title: string;
  description?: string | null;
  drill_type: string;
  duration_limit_minutes?: number | null;
  max_participants?: number | null;
  scenario_id?: number | null;
}

export const drillsApi = {
  create: (input: DrillInput) => http.post<{ drill_id: number }>('/api/v2/drills', input),
  update: (id: number, patch: Partial<DrillInput>) => http.put<unknown>(`/api/v2/drills/${id}`, patch),
  remove: (id: number) => http.delete<unknown>(`/api/v2/drills/${id}`),
  prepare: (id: number) => http.post<{ provision_status?: string; message?: string }>(`/api/v2/drills/${id}/prepare`),
  start: (id: number) => http.post<unknown>(`/api/v2/drills/${id}/start`),
  pause: (id: number) => http.post<unknown>(`/api/v2/drills/${id}/pause`),
  resume: (id: number) => http.post<unknown>(`/api/v2/drills/${id}/resume`),
  stop: (id: number) => http.post<unknown>(`/api/v2/drills/${id}/stop`),
  status: (id: number) => http.get<DrillStatus>(`/api/v2/drills/${id}/status`),
  get: (id: number) => http.get<Drill>(`/api/v2/drills/${id}`),
  /** Duplicate keeps the scenario, so the copy can be prepared immediately. */
  duplicate: (d: Drill) =>
    drillsApi.create({
      title: `${d.title} (Copy)`,
      description: d.description,
      drill_type: d.drill_type,
      duration_limit_minutes: d.duration_limit_minutes,
      max_participants: d.max_participants,
      scenario_id: d.scenario_id,
    }),
};
