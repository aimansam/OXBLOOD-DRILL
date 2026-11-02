import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatWhen } from '@/lib/utils';
import { ScoreboardView } from './ScoreboardView';
import { competitionApi, useScoreEvents, useScoreboard, useTeams } from './api';

const KINDS = [
  ['award', 'Award points'],
  ['penalty', 'Penalty'],
  ['report', 'Report score'],
  ['detection', 'Detection (blue)'],
] as const;

export function RefereeTab({ drillId }: { drillId: number }) {
  const qc = useQueryClient();
  const board = useScoreboard(drillId);
  const teams = useTeams(drillId);
  const events = useScoreEvents(drillId);
  const [form, setForm] = useState({ team_id: '', kind: 'award', points: '', reason: '' });
  const [busy, setBusy] = useState(false);

  const points = Number(form.points);
  const valid = form.team_id !== '' && Number.isInteger(points) && points !== 0 && form.reason.trim().length >= 3;
  const submit = async () => {
    setBusy(true);
    try {
      await competitionApi.scoreEvent(drillId, { team_id: Number(form.team_id), points, reason: form.reason.trim(), kind: form.kind });
      toast.success(form.kind === 'penalty' ? 'Penalty recorded' : 'Points recorded');
      setForm((f) => ({ ...f, points: '', reason: '' }));
      await Promise.all(['scoreboard', 'score-events'].map((k) => qc.invalidateQueries({ queryKey: [k, drillId] })));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };
  const teamName = (id: number | null) => teams.data?.find((t) => t.id === id)?.name ?? '—';

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-4">
        {board.isLoading ? <Skeleton className="h-40 w-full" /> : board.data && board.data.teams.length ? <ScoreboardView board={board.data} /> : <p className="text-muted-foreground">No teams yet.</p>}
        <Card>
          <CardHeader>
            <CardTitle>Score ledger</CardTitle>
          </CardHeader>
          <CardContent>
            {(events.data ?? []).length === 0 ? (
              <p className="text-muted-foreground">No score changes yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {(events.data ?? []).map((e) => (
                  <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                    <span>
                      <b className="font-medium">{teamName(e.team_id)}</b> <span className="text-muted-foreground">· {e.kind.replace('_', ' ')}</span>
                      {e.reason && <span className="block text-xs text-muted-foreground">{e.reason}</span>}
                    </span>
                    <span className="text-right">
                      <b className={e.points < 0 ? 'text-danger' : 'text-success'}>
                        {e.points > 0 ? '+' : ''}
                        {e.points}
                      </b>
                      <span className="block text-xs text-muted-foreground">
                        {e.created_by ? `${e.created_by} · ` : ''}
                        {formatWhen(e.created_at)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>Referee: change points</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="Team">
            <Select aria-label="Team" value={form.team_id} onChange={(e) => setForm({ ...form, team_id: e.target.value })}>
              <option value="">Choose a team…</option>
              {(teams.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Type">
            <Select aria-label="Type" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {KINDS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Points" hint={form.kind === 'penalty' ? 'Enter a positive number; it is subtracted.' : undefined}>
            <Input aria-label="Points" type="number" value={form.points} onChange={(e) => setForm({ ...form, points: e.target.value })} />
          </Field>
          <Field label="Reason (required, kept in the ledger)">
            <Input aria-label="Reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </Field>
          <Button className="w-full" disabled={busy || !valid} onClick={submit}>
            Record
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
