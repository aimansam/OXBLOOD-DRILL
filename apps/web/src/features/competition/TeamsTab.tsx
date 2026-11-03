import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { http } from '@/api/http';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { inviteUrl, useRoster } from '../teams/api';
import { competitionApi, useMatchMode, useTeams } from './api';

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Request failed');

export function TeamsTab({ drillId, scheduled }: { drillId: number; scheduled: boolean }) {
  const qc = useQueryClient();
  const teams = useTeams(drillId);
  const matchMode = useMatchMode(drillId).data ?? 'shared';
  const roster = useRoster(drillId);
  const [count, setCount] = useState('4');
  const [pick, setPick] = useState<Record<number, string>>({});
  const [link, setLink] = useState<{ teamId: number; url: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ['teams', drillId] }), qc.invalidateQueries({ queryKey: ['roster', drillId] })]);
  };
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.success(ok);
      await refresh();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (teams.isLoading || roster.isLoading) return <Skeleton className="h-48 w-full" />;
  const list = teams.data ?? [];
  if (list.length === 0) {
    return (
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Set up teams</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground">Create the teams for this competition. In a two-round swap, half the teams attack while the other half defend, then they switch.</p>
          <div className="flex gap-2">
            <Select aria-label="Number of teams" value={count} onChange={(e) => setCount(e.target.value)} className="w-32">
              {['2', '4', '6'].map((n) => (
                <option key={n} value={n}>
                  {n} teams
                </option>
              ))}
            </Select>
            <Button disabled={busy} onClick={() => act(() => competitionApi.createTeams(drillId, Number(count)), 'Teams created')}>
              Create teams
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const inTeam = new Set(list.flatMap((t) => t.members.map((m) => m.user_id)));
  const enrolledFree = (roster.data?.participants ?? []).filter((p) => !inTeam.has(p.user_id));
  const candidates = roster.data?.candidates ?? [];

  const addPlayer = (teamId: number) =>
    act(async () => {
      const value = pick[teamId];
      if (!value) return;
      const [kind, id] = value.split(':');
      const userId = Number(id);
      if (kind === 'new') {
        const candidate = candidates.find((c) => c.id === userId);
        await http.post(`/api/v2/drills/${drillId}/participants`, { user_id: userId, role: candidate?.role ?? 'red' });
      }
      await competitionApi.assign(drillId, teamId, userId);
      setPick((s) => ({ ...s, [teamId]: '' }));
    }, 'Player added');

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      toast.error('Copy failed — select the link and copy it manually');
    }
  };

  return (
    <div className="space-y-4">
      {list.length >= 4 && list.length % 2 === 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-semibold">Range</div>
              <p className="text-muted-foreground">
                {matchMode === 'separate'
                  ? `Each pair of teams plays on its own copy of the range (${list.length / 2} matches), so one team's flags and changes cannot help another match.`
                  : 'All teams share one range.'}
              </p>
            </div>
            <Select
              aria-label="Range layout"
              className="w-60"
              value={matchMode}
              disabled={busy || !scheduled}
              onChange={(e) => act(() => competitionApi.setMatchMode(drillId, e.target.value as 'shared' | 'separate'), 'Range layout saved')}
            >
              <option value="shared">One shared range</option>
              <option value="separate">One range per match</option>
            </Select>
          </CardContent>
        </Card>
      )}
      <p className="text-muted-foreground">
        {inTeam.size} of {list.reduce((n, t) => n + t.member_count, 0) + enrolledFree.length} enrolled players are in a team.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {list.map((team, index) => (
          <Card key={team.id}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full" style={{ background: team.color ?? 'currentColor' }} aria-hidden />
                <TeamName name={team.name} disabled={busy} onSave={(name) => act(() => competitionApi.renameTeam(drillId, team.id, name), 'Team renamed')} />
              </CardTitle>
              <span className="text-xs text-muted-foreground">
                {matchMode === 'separate' && <>Match {team.match_number} · </>}
                {team.member_count} players
              </span>
            </CardHeader>
            <CardContent className="space-y-3">
              {team.members.length === 0 ? (
                <p className="text-muted-foreground">No players yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {team.members.map((m) => (
                    <li key={m.user_id} className="flex items-center justify-between py-1.5">
                      <span className="flex items-center gap-2">
                        {m.sub}
                        {team.captain_user_id === m.user_id && <span className="rounded border border-border px-1.5 text-xs uppercase text-muted-foreground">Captain</span>}
                      </span>
                      <span className="flex gap-1">
                        {team.captain_user_id !== m.user_id && (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Make ${m.sub} captain of ${team.name}`}
                            disabled={busy}
                            onClick={() => act(() => competitionApi.setCaptain(drillId, team.id, m.user_id), `${m.sub} is captain`)}
                          >
                            Make captain
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => competitionApi.unassign(drillId, team.id, m.user_id), 'Player removed')}>
                          Remove
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2">
                <Select aria-label={`Add a player to ${team.name}`} value={pick[team.id] ?? ''} onChange={(e) => setPick((s) => ({ ...s, [team.id]: e.target.value }))}>
                  <option value="">Add a player…</option>
                  {enrolledFree.map((p) => (
                    <option key={`e${p.user_id}`} value={`enrolled:${p.user_id}`}>
                      {p.username ?? p.sub ?? `User ${p.user_id}`}
                    </option>
                  ))}
                  {candidates.map((c) => (
                    <option key={`n${c.id}`} value={`new:${c.id}`}>
                      {c.sub} (enroll)
                    </option>
                  ))}
                </Select>
                <Button variant="outline" disabled={busy || !pick[team.id]} onClick={() => addPlayer(team.id)}>
                  Add
                </Button>
              </div>
              {scheduled && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      const side = index < list.length / 2 ? 'red' : 'blue';
                      const invite = await competitionApi.invite(drillId, side, team.id);
                      setLink({ teamId: team.id, url: inviteUrl(invite.token) });
                    })
                  }
                >
                  New invitation link
                </Button>
              )}
              {link?.teamId === team.id && (
                <div className="flex gap-2">
                  <Input readOnly aria-label={`Invitation link for ${team.name}`} value={link.url} onFocus={(e) => e.currentTarget.select()} />
                  <Button variant="outline" onClick={() => copy(link.url)}>
                    Copy
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function TeamName({ name, disabled, onSave }: { name: string; disabled: boolean; onSave: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  if (!editing) {
    return (
      <button className="text-left hover:underline" title="Rename" onClick={() => { setValue(name); setEditing(true); }}>
        {name}
      </button>
    );
  }
  const finish = (save: boolean) => {
    setEditing(false);
    if (save && value.trim() && value.trim() !== name) onSave(value.trim());
  };
  return (
    <Input
      autoFocus
      aria-label="Team name"
      value={value}
      disabled={disabled}
      className="h-7 w-36"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
    />
  );
}
