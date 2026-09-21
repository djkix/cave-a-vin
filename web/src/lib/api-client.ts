export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers: init.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (typeof body.message === 'string') message = body.message;
    } catch {
      /* corps non JSON */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface Me {
  id: string;
  email: string;
  displayName: string | null;
}

export const getMe = () => apiFetch<Me>('/auth/me');
export const localLogin = (email: string, password: string) =>
  apiFetch<Me>('/auth/local-login', { method: 'POST', body: JSON.stringify({ email, password }) });
export const logout = () => apiFetch<{ ok: true }>('/auth/logout', { method: 'POST' });
