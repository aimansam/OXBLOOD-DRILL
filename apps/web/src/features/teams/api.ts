import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '@/api/client';
import { http } from '@/api/http';
import type { components } from '@/api/schema';

export type Participant = components['schemas']['ParticipantOut'];
export type Candidate = components['schemas']['CandidateOut'];
export type Invitation = components['schemas']['InvitationOut'];

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
      const path = { params: { path: { drill_id: drillId as number } } };
      const [people, candidates, invites] = await Promise.all([
        api.GET('/api/v2/drills/{drill_id}/participants', path).then(unwrap),
        api.GET('/api/v2/drills/{drill_id}/roster-candidates', path).then(unwrap).catch(() => ({ candidates: [] as Candidate[] })),
        api.GET('/api/v2/drills/{drill_id}/invitations', path).then(unwrap).catch(() => ({ invitations: [] as Invitation[] })),
      ]);
      return {
        // Removed and departed players stay in the table but are not on the team any more.
        participants: people.participants.filter((p) => !['removed', 'left'].includes(String(p.status ?? '').toLowerCase())),
        candidates: candidates.candidates,
        invitations: invites.invitations.filter((i) => i.status === 'pending'),
      };
    },
  });
}

/** The link participants open to register; it only exists in the response that created it. */
export const inviteUrl = (token: string, origin = window.location.origin) => `${origin}/join#token=${token}`;
