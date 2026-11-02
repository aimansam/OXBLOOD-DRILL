import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { drillsApi } from '@/api/drills';
import type { Drill } from '@/api/types';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EditDrillDialog } from './EditDrillDialog';
import { availableActions } from './actions';

/** Lifecycle buttons for one exercise. Which ones appear depends on its status and range state. */
export function ExerciseActions({ drill, onRemoved }: { drill: Drill; onRemoved: () => void }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | 'delete' | 'stop'>(null);
  const [editing, setEditing] = useState(false);
  const actions = availableActions(drill);

  const run = async (key: string, label: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      toast.success(label);
      await queryClient.invalidateQueries({ queryKey: ['drills'] });
      await queryClient.invalidateQueries({ queryKey: ['drill-status', drill.id] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {actions.prepare && (
          <Button size="sm" disabled={busy !== null} onClick={() => run('prepare', 'Range preparation started', () => drillsApi.prepare(drill.id))}>
            {actions.prepareLabel}
          </Button>
        )}
        {actions.start && (
          <Button size="sm" disabled={busy !== null} onClick={() => run('start', 'Exercise started', () => drillsApi.start(drill.id))}>
            Start
          </Button>
        )}
        {actions.pause && (
          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => run('pause', 'Exercise paused', () => drillsApi.pause(drill.id))}>
            Pause
          </Button>
        )}
        {actions.resume && (
          <Button size="sm" disabled={busy !== null} onClick={() => run('resume', 'Exercise resumed', () => drillsApi.resume(drill.id))}>
            Resume
          </Button>
        )}
        {actions.stop && (
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setConfirm('stop')}>
            Stop
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {actions.edit && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run('duplicate', 'Exercise duplicated', () => drillsApi.duplicate(drill))}>
          Duplicate
        </Button>
        {actions.remove && (
          <Button size="sm" variant="outline" className="text-danger" disabled={busy !== null} onClick={() => setConfirm('delete')}>
            Delete
          </Button>
        )}
      </div>

      <EditDrillDialog drill={drill} open={editing} onOpenChange={setEditing} />
      <ConfirmDialog
        open={confirm === 'stop'}
        title="Stop this exercise?"
        description="Participants lose access and the range VMs are cleaned up."
        confirmLabel="Stop exercise"
        destructive
        busy={busy === 'stop'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => run('stop', 'Exercise stopped', () => drillsApi.stop(drill.id))}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title="Delete this exercise?"
        description="It is removed from the list. Finish VM cleanup first if the range is still up."
        confirmLabel="Delete"
        destructive
        busy={busy === 'delete'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => run('delete', 'Exercise deleted', async () => { await drillsApi.remove(drill.id); onRemoved(); })}
      />
    </div>
  );
}
