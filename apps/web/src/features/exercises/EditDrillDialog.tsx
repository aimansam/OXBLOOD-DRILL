import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { drillsApi } from '@/api/drills';
import type { Drill } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Select, Textarea } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MAX_PARTICIPANTS, validateDetails } from '../wizard/readiness';

export function EditDrillDialog({ drill, open, onOpenChange }: { drill: Drill; open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const initial = () => ({
    title: drill.title,
    description: drill.description ?? '',
    type: drill.drill_type,
    duration: drill.duration_limit_minutes ? String(drill.duration_limit_minutes) : '',
    maxParticipants: drill.max_participants ? String(drill.max_participants) : '',
  });
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const errors = validateDetails(f);
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  const save = async () => {
    setBusy(true);
    try {
      await drillsApi.update(drill.id, {
        title: f.title.trim(),
        description: f.description.trim() || null,
        drill_type: f.type,
        duration_limit_minutes: f.duration ? Number(f.duration) : null,
        max_participants: f.maxParticipants ? Number(f.maxParticipants) : null,
      });
      toast.success('Changes saved');
      await queryClient.invalidateQueries({ queryKey: ['drills'] });
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setF(initial());
        onOpenChange(o);
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Edit exercise</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Field label="Title" error={errors.title}>
            <Input value={f.title} onChange={(e) => set('title', e.target.value)} />
          </Field>
          <Field label="Type">
            <Select value={f.type} onChange={(e) => set('type', e.target.value)}>
              <option value="individual">Individual</option>
              <option value="team">Team</option>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Duration (minutes)" error={errors.duration}>
              <Input type="number" min={1} value={f.duration} onChange={(e) => set('duration', e.target.value)} />
            </Field>
            <Field label="Max participants" error={errors.maxParticipants} hint={`1 to ${MAX_PARTICIPANTS}`}>
              <Input type="number" min={1} max={MAX_PARTICIPANTS} value={f.maxParticipants} onChange={(e) => set('maxParticipants', e.target.value)} />
            </Field>
          </div>
          <Field label="Description">
            <Textarea value={f.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || Object.keys(errors).length > 0}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
