import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, unwrap } from '@/api/client';
import { setToken } from '@/api/token';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [sub, setSub] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = unwrap(await api.POST('/api/v1/auth/login', { body: { sub: sub.trim(), password } }));
      setToken(data.token);
      await queryClient.invalidateQueries();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^API error: \d+ /, '') : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-lg border border-border bg-card p-6">
        <div>
          <div className="mb-3 flex items-center gap-2 text-base font-semibold">
            <span className="h-2.5 w-2.5 rounded-full bg-primary" aria-hidden />
            OxBlood
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1 text-muted-foreground">Use the account your operator gave you.</p>
        </div>
        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-muted-foreground">Username</span>
            <Input value={sub} onChange={(e) => setSub(e.target.value)} autoComplete="username" required autoFocus />
          </label>
          <label className="block space-y-1.5">
            <span className="text-muted-foreground">Password</span>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </label>
        </div>
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={busy || !sub || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
