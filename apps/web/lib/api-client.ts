// Fallback is the RELATIVE same-origin path, never an absolute localhost URL:
// the real value comes from NEXT_PUBLIC_API_URL (written to .env.local by
// scripts/start-codespaces-demo.sh). If that is ever missing, a relative
// "/api/v1" degrades safely (same-origin, proxied) instead of hard-coding a
// backend host into the shipped bundle - which must never contain localhost.
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';

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

interface RefreshResult {
  accessToken: string;
}

interface ApiClientConfig {
  getAccessToken: () => string | null;
  onTokenRefreshed: (accessToken: string) => void;
  onUnauthorized: () => void;
}

let clientConfig: ApiClientConfig | null = null;

export function configureApiClient(config: ApiClientConfig): void {
  clientConfig = config;
}

async function unwrap<T>(response: Response): Promise<T> {
  const envelope = (await response.json()) as ApiEnvelope<T>;

  if (!response.ok || !envelope.success || envelope.data === null) {
    throw new ApiError(envelope.error ?? `Request failed with status ${response.status}`, response.status);
  }

  return envelope.data;
}

let refreshPromise: Promise<string> | null = null;

function refreshAccessToken(): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({}),
    })
      .then((response) => unwrap<RefreshResult>(response))
      .then(({ accessToken }) => {
        clientConfig?.onTokenRefreshed(accessToken);
        return accessToken;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
}

const RETRY_EXEMPT_PATHS = [
  '/auth/register',
  '/auth/login',
  '/auth/refresh',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/verify-email',
];

async function request<T>(path: string, init: RequestInit, allowRetry = true): Promise<T> {
  const accessToken = clientConfig?.getAccessToken() ?? null;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });

  if (
    response.status === 401 &&
    allowRetry &&
    !RETRY_EXEMPT_PATHS.some((exempt) => path.startsWith(exempt))
  ) {
    try {
      await refreshAccessToken();
    } catch {
      clientConfig?.onUnauthorized();
      throw new ApiError('Session expired', 401);
    }

    return request<T>(path, init, false);
  }

  return unwrap<T>(response);
}

export async function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...init?.headers,
    },
  });
}

export async function apiPost<T>(path: string, body: unknown, init?: RequestInit): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...init?.headers,
    },
    body: JSON.stringify(body),
  });
}

export async function apiPatch<T>(path: string, body: unknown, init?: RequestInit): Promise<T> {
  return request<T>(path, {
    method: 'PATCH',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...init?.headers,
    },
    body: JSON.stringify(body),
  });
}

export async function apiDelete<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, {
    method: 'DELETE',
    ...init,
    headers: {
      Accept: 'application/json',
      ...init?.headers,
    },
  });
}
