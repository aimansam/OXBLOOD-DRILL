import { useQuery } from '@tanstack/react-query';
import { http } from '@/api/http';

export interface Report {
  id: number;
  drill_id?: number | null;
  title?: string;
  status?: string;
  report_type?: string;
  quality_score?: number | null;
  summary?: string;
  created_at?: string | null;
}
export interface Finding {
  severity?: string;
  title?: string;
  description?: string;
}

export const useReports = () =>
  useQuery({ queryKey: ['reports'], queryFn: async () => (await http.get<{ reports?: Report[] }>('/api/v2/reports')).reports ?? [] });

export const useReport = (id: number | null) =>
  useQuery({
    queryKey: ['report', id],
    enabled: id !== null,
    queryFn: async () => {
      const report = await http.get<Report>(`/api/v2/reports/${id}`);
      const findings = await http.get<{ findings?: Finding[] }>(`/api/v2/reports/${id}/findings`).catch(() => ({ findings: [] as Finding[] }));
      const drillId = report.drill_id ?? null;
      const [debrief, board] = drillId
        ? await Promise.all([
            fetch(`/api/v1/drills/${drillId}/debrief.md`, { headers: { 'X-Divide-Token': localStorage.getItem('divide_token') ?? '' } })
              .then((r) => (r.ok ? r.text() : ''))
              .catch(() => ''),
            http.get<{ leaderboard?: { user_id: number; total_points: number }[] }>(`/api/v2/leaderboard/drill/${drillId}`).catch(() => ({ leaderboard: [] })),
          ])
        : ['', { leaderboard: [] }];
      return { report, findings: findings.findings ?? [], debrief, top: (board.leaderboard ?? []).slice(0, 3) };
    },
  });

export const reportResult = (r: Report) => (r.status === 'graded' ? 'Completed' : 'In progress');
export const severityTone = (s: string | undefined) =>
  ({ critical: 'text-danger', high: 'text-danger', medium: 'text-warning', low: 'text-info' })[String(s ?? 'info').toLowerCase()] ?? 'text-muted-foreground';
