import { useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useDrills } from '@/api/hooks';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { inviteUrl, participantName, teamsApi, useRoster } from './api';

const SIDES = ['red', 'blue'] as const;

export function TeamsPage() {
  const queryClient = useQueryClient();
  const drills = useDrills();
  const [params, setParams] = useSearchParams();
  const list = drills.data ?? [];
  const requested = Number(params.get('drill')) || null;
  const selected = list.find((d) => d.id === requested) ?? list.find((d) => d.status === 'scheduled') ?? list[0];
  const drillId = selected?.id ?? null;
  const scheduled = selected?.status === 'scheduled';
  const roster = useRoster(drillId);
  const [fresh, setFresh] = useState<{ drillId: number; side: string; url: string } | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // A link belongs to one exercise; it is not shown after the operator switches.
  const freshHere = fresh && fresh.drillId === drillId ? fresh : null;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['roster', drillId] });
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.success(ok);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const generate = (side: 'red' | 'blue') =>
    act(async () => {
      const invite = await teamsApi.invite(drillId as number, side);
      setFresh({ drillId: drillId as number, side, url: inviteUrl(invite.token) });
    }, `${side === 'red' ? 'Red' : 'Blue'} invitation link ready to copy`);

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      toast.error('Copy failed — select the link and copy it manually');
    }
  };

  if (drills.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!selected) return <EmptyState title="No exercises are available yet" hint="Create an exercise first, then assign players here." />;

  return (
    <>
      <PageHeader title="Teams" description="Invite and assign Red and Blue players before launch." />
      <div className="mb-6 max-w-md">
        <Select
          aria-label="Exercise"
          value={drillId ?? ''}
          onChange={(e) => setParams({ drill: e.target.value }, { replace: true })}
        >
          {list.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title} #{d.id} · {d.status}
            </option>
          ))}
        </Select>
      </div>

      {roster.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {SIDES.map((side) => {
              const members = (roster.data?.participants ?? []).filter((p) => String(p.role).toLowerCase() === side);
              const available = (roster.data?.candidates ?? []).filter((c) => String(c.role).toLowerCase() === side);
              return (
                <Card key={side}>
                  <CardHeader>
                    <CardTitle className={cn(side === 'red' ? 'text-danger' : 'text-info')}>{side === 'red' ? 'Red team' : 'Blue team'}</CardTitle>
                    <span className="text-xs text-muted-foreground">{members.length} assigned</span>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {members.length === 0 ? (
                      <p className="text-muted-foreground">No player assigned</p>
                    ) : (
                      <ul className="divide-y divide-border">
                        {members.map((p) => (
                          <li key={p.user_id} className="flex items-center justify-between gap-2 py-2">
                            <span>
                              <b className="font-medium">{participantName(p)}</b>
                              <span className="ml-2 text-xs text-muted-foreground">{p.last_login_at ? 'signed in' : 'not signed in'}</span>
                            </span>
                            {scheduled && (
                              <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => teamsApi.remove(drillId as number, p.user_id), 'Player removed')}>
                                Remove
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {scheduled && (
                      <div className="flex gap-2">
                        <Select aria-label={`Choose ${side} player`} value={pick[side] ?? ''} onChange={(e) => setPick((s) => ({ ...s, [side]: e.target.value }))}>
                          <option value="">Add {side} player</option>
                          {available.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.sub}
                            </option>
                          ))}
                        </Select>
                        <Button
                          variant="outline"
                          disabled={busy || !pick[side]}
                          onClick={() => act(() => teamsApi.assign(drillId as number, Number(pick[side]), side), 'Player added').then(() => setPick((s) => ({ ...s, [side]: '' })))}
                        >
                          Add
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {scheduled ? (
            <Card className="mt-4">
              <CardHeader>
                <CardTitle>Invite players</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-muted-foreground">Create a separate single-use link for each player. They choose a username and password, then join the selected team automatically.</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" disabled={busy} onClick={() => generate('red')}>New red link</Button>
                  <Button variant="outline" disabled={busy} onClick={() => generate('blue')}>New blue link</Button>
                </div>
                {freshHere && (
                  <div role="status" className="space-y-2 rounded-md border border-success/40 bg-success/10 p-3">
                    <div className="font-medium text-success">{freshHere.side.toUpperCase()} link ready</div>
                    <div className="text-xs text-muted-foreground">Copy this link now; it cannot be retrieved after refresh.</div>
                    <div className="flex gap-2">
                      <Input readOnly aria-label="Participant invitation link" value={freshHere.url} onFocus={(e) => e.currentTarget.select()} />
                      <Button variant="outline" onClick={() => copy(freshHere.url)}>
                        <Copy className="h-4 w-4" /> Copy
                      </Button>
                    </div>
                  </div>
                )}
                {(roster.data?.invitations ?? []).length > 0 && (
                  <div>
                    <h3 className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Pending links ({roster.data?.invitations.length})</h3>
                    <ul className="divide-y divide-border">
                      {roster.data?.invitations.map((i) => (
                        <li key={i.id} className="flex items-center justify-between py-2">
                          <span className="capitalize">{i.side} link</span>
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => teamsApi.revoke(drillId as number, i.id), 'Link revoked')}>
                            Revoke
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          ) : (
            <p className="mt-4 text-muted-foreground">Registration is closed for this {selected.status} exercise. Select a scheduled exercise above.</p>
          )}
        </>
      )}
    </>
  );
}
