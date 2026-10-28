export type Role = 'agent' | 'manager' | 'admin';
export type Session = { token: string; user_id: string; role: Role };

const KEY = 'trustdesk.session';

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null) {
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: session lives in memory only */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: unknown,
  ) {
    super(message);
  }
}

let session: Session | null = loadSession();
export const setApiSession = (s: Session | null) => {
  session = s;
  saveSession(s);
};

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(session ? { authorization: `Bearer ${session.token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  if (!res.ok) {
    const e = (data as { error?: { message: string; code: string; details: unknown } })?.error;
    throw new ApiError(e?.message ?? `Request failed (${res.status})`, res.status, e?.code ?? 'UNKNOWN', e?.details);
  }
  return data as T;
}

/** Turns an API error into one plain sentence for the interface. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (Array.isArray(err.details) && err.details.length) {
      return `${err.message}: ${(err.details as Array<{ field: string; message: string }>).map((d) => `${d.field} ${d.message}`).join('; ')}`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
