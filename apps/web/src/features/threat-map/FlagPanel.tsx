import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { http } from '@/api/http';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface SubmissionResult {
  is_correct: boolean;
  points_earned?: number;
  first_blood?: boolean;
}

/** Player flag submission, floating over the live map. The server resolves which flag it matches. */
export function FlagPanel({ drillId }: { drillId: number }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const flag = value.trim();
    if (!flag) return toast.error('Please enter a flag');
    setBusy(true);
    try {
      const result = await http.post<SubmissionResult>('/api/v2/submissions?user_id=0', {
        drill_id: drillId,
        lab_flag_id: 0, // resolved server-side from the drill's objectives
        flag_value: flag,
        hints_used: 0,
      });
      if (result.is_correct) {
        toast.success(result.first_blood ? `First blood! +${result.points_earned ?? 0} pts` : `Correct! +${result.points_earned ?? 0} pts`);
        await queryClient.invalidateQueries({ queryKey: ['leaderboard', drillId] });
      } else {
        toast.error('Incorrect flag');
      }
      setValue('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      aria-label="Submit a flag"
      className="absolute bottom-4 right-4 z-30 flex w-80 max-w-[calc(100%-2rem)] items-center gap-2 rounded-lg border border-border bg-card/95 p-2 shadow-lg backdrop-blur"
    >
      <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Submit a flag" aria-label="Flag" autoComplete="off" spellCheck={false} />
      <Button type="submit" size="sm" disabled={busy || !value.trim()}>
        {busy ? 'Checking…' : 'Submit'}
      </Button>
    </form>
  );
}
