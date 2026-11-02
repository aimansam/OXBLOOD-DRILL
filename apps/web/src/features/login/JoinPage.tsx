import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { setToken } from '@/api/token';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

interface Preview {
  title: string;
  side: string;
}

/** Invitation links carry a 43-character URL-safe token in the fragment, so it never reaches a server log. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function readInviteToken(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return token && TOKEN_PATTERN.test(token) ? token : null;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/v2/invitations/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(typeof data.detail === 'string' ? data.detail : 'Something went wrong. Please try again.'), { status: response.status });
  }
  return data as T;
}

export function JoinPage() {
  const navigate = useNavigate();
  // Read once, then take the secret out of the address bar.
  const [token] = useState(() => readInviteToken(window.location.hash));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(token ? null : 'Open the full link shared by your operator.');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    post<Preview>('preview', { token })
      .then((p) => !cancelled && setPreview(p))
      .catch((e: Error & { status?: number }) => !cancelled && setUnavailable(e.status === 404 ? e.message : 'Unable to check the invitation. Please try again later.'));
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await post<{ token: string }>('redeem', { token, username: username.trim(), password });
      setToken(result.token);
      window.history.replaceState(null, '', '/app/join');
      navigate('/mission', { replace: true });
    } catch (e) {
      const failure = e as Error & { status?: number };
      if (failure.status === 404) setUnavailable(failure.message);
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  };

  if (unavailable) {
    return (
      <div className="flex min-h-full items-center justify-center px-4">
        <div className="w-full max-w-sm space-y-2 rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold">Link unavailable</h1>
          <p className="text-muted-foreground">{unavailable}</p>
          <p className="text-muted-foreground">Ask the operator for a new link.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-lg border border-border bg-card p-6">
        <div>
          <div className="mb-3 flex items-center gap-2 text-base font-semibold">
            <span className="h-2.5 w-2.5 rounded-full bg-primary" aria-hidden />
            OxBlood
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{preview?.title ?? 'Checking your invitation…'}</h1>
          {preview && (
            <p className="mt-1 text-muted-foreground">
              <span className="font-semibold uppercase">{preview.side} team</span> · Your place is reserved
            </p>
          )}
        </div>
        {preview && (
          <>
            <Field label="Username">
              <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
            </Field>
            <Field label="Password">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
            </Field>
            {error && <p role="alert" className="text-danger">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy || !username.trim() || !password}>
              {busy ? 'Joining mission…' : 'Create account & join'}
            </Button>
          </>
        )}
      </form>
    </div>
  );
}
