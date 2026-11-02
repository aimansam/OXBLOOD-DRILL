// Same storage key and header as the classic portal (the retired classic portal's auth.js), so one
// sign-in works in both UIs.
const TOKEN_KEY = 'divide_token';

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode): the session just won't persist */
  }
}
