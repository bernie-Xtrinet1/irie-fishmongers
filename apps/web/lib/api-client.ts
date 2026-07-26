// Fallback is the RELATIVE same-origin path, never an absolute localhost URL:
// the real value comes from NEXT_PUBLIC_API_URL (written to .env.local by
// scripts/start-codespaces-demo.sh). If that is ever missing, a relative
// "/api/v1" degrades safely (same-origin, proxied) instead of hard-coding a
// backend host into the shipped bundle - which must never contain localhost.
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';

// Every backend response is wrapped in this envelope by ResponseInterceptor/
// HttpExceptionFilter (see backend/src/common/http) - CLAUDE.md's API RULES
// mandate { success, data, error } on every endpoint.
interface ApiEnvelope<T> {
  success: boolean;
  data: T | null;
  error: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function unwrap<T>(response: Response): Promise<T> {
  const envelope = (await response.json()) as ApiEnvelope<T>;

  if (!response.ok || !envelope.success || envelope.data === null) {
    throw new ApiError(envelope.error ?? `Request failed with status ${response.status}`, response.status);
  }

  return envelope.data;
}

export async function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...init?.headers },
  });

  return unwrap<T>(response);
}

export async function apiPost<T>(path: string, body: unknown, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...init?.headers,
    },
    body: JSON.stringify(body),
  });

  return unwrap<T>(response);
}
