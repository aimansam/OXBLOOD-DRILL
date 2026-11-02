import { useQuery } from '@tanstack/react-query';
import { http } from '@/api/http';

export interface Participant {
  user_id: number;
  username?: string;
  sub?: string;
  role: string;
  status?: string;
  last_login_at?: string | null;
}
export interface Candidate {
  id: number;
  sub: string;
  role: string;
}
export interface Invitation {
  id: number;
  side: string;
  status: string;
  expires_at?: string;
}

export const participantName = (p: Participant) => p.username || p.sub || `User ${p.user_id}`;

export const teamsApi = {
  invite: (drillId: number, side: 'red' | 'blue') => http.post<Invitation & { token: string }>(`/api/v2/drills/${drillId}/invitations`, { side }),
  revoke: (drillId: number, inviteId: number) => http.delete<unknown>(`/api/v2/drills/${drillId}/invitations/${inviteId}`),
  assign: (drillId: number, userId: number, role: 'red' | 'blue') => http.post<unknown>(`/api/v2/drills/${drillId}/participants`, { user_id: userId, role }),
  remove: (drillId: number, userId: number) => http.delete<unknown>(`/api/v2/drills/${drillId}/participants/${userId}`),
};

export function useRoster(drillId: number | null) {
  return useQuery({
    queryKey: ['roster', drillId],
    enabled: drillId !== null,
    queryFn: async () => {
      const [people, candidates, invites] = await Promise.all([
        http.get<{ participants?: Participant[] }>(`/api/v2/drills/${drillId}/participants`),
        http.get<{ candidates?: Candidate[] }>(`/api/v2/drills/${drillId}/roster-candidates`).catch(() => ({ candidates: [] })),
        http.get<{ invitations?: Invitation[] }>(`/api/v2/drills/${drillId}/invitations`).catch(() => ({ invitations: [] })),
      ]);
      return {
        // Removed and departed players stay in the table but are not on the team any more.
        participants: (people.participants ?? []).filter((p) => !['removed', 'left'].includes(String(p.status ?? '').toLowerCase())),
        candidates: candidates.candidates ?? [],
        invitations: (invites.invitations ?? []).filter((i) => i.status === 'pending'),
      };
    },
  });
}

/** The link participants open to register; it only exists in the response that created it. */
export const inviteUrl = (token: string, origin = window.location.origin) => `${origin}/join#token=${token}`;
