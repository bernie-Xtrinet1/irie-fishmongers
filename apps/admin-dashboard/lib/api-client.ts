const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';

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

interface RefreshResult {
  accessToken: string;
}

interface ApiClientConfig {
  getAccessToken: () => string | null;
  onTokenRefreshed: (accessToken: string) => void;
  // Called when a 401 could not be resolved by a silent refresh (expired/
  // missing refresh cookie). The auth context wires this to clear its
  // in-memory session and redirect to /login - see ADR-004.
  onUnauthorized: () => void;
}

let clientConfig: ApiClientConfig | null = null;

// Wired once by AuthProvider on mount (see lib/auth/auth-context.tsx). Every
// request needs the current access token and a way to report refresh
// outcomes back to the context that owns the in-memory session state -
// this indirection avoids a circular import between the two modules.
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

// Concurrent-401 refresh lock (ADR-004): every request that hits a 401 while
// a refresh is already in flight awaits this same promise instead of firing
// its own /auth/refresh call. The refresh token itself is never touched by
// this code - it lives only in the httpOnly cookie the browser sends
// automatically via `credentials: 'include'`.
let refreshPromise: Promise<string> | null = null;

function refreshAccessToken(): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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

// A 401 from these two paths means "not authenticated", not "token expired"
// - retrying them through the refresh flow would loop.
const RETRY_EXEMPT_PATHS = ['/auth/login', '/auth/refresh'];

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

  if (response.status === 401 && allowRetry && !RETRY_EXEMPT_PATHS.some((exempt) => path.startsWith(exempt))) {
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
    headers: { Accept: 'application/json', ...init?.headers },
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
