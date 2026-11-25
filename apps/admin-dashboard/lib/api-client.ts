import {
  isActiveAdminPortalUser,
  isActiveAdminUser,
  type RefreshedSessionUser,
} from './auth/admin-access';
import { env } from './env';

export { isActiveAdminPortalUser, isActiveAdminUser, type RefreshedSessionUser };

const API_BASE_URL = env.apiUrl;

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
  user?: RefreshedSessionUser;
}

interface ApiClientConfig {
  getAccessToken: () => string | null;
  onTokenRefreshed: (accessToken: string, user?: RefreshedSessionUser) => void;
  // Called when a session fails authentication/role checks on silent refresh
  // or receives a forbidden admin response. AuthProvider clears in-memory state
  // + cached queries and redirects to /login - see ADR-004.
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

function revokeCookieSessionBestEffort(): Promise<void> {
  return fetch(`${API_BASE_URL}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({}),
  })
    .then(() => undefined)
    .catch(() => undefined);
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
      .then(async (session) => {
        if (!isActiveAdminPortalUser(session.user)) {
          // Role missing or inactive after refresh: discard the refreshed
          // access token, revoke the refresh session server-side, and abort
          // without retrying the protected request.
          await revokeCookieSessionBestEffort();
          throw new ApiError('Administrator or operations staff access is required', 403);
        }
        clientConfig?.onTokenRefreshed(session.accessToken, session.user);
        return session.accessToken;
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
    } catch (error) {
      clientConfig?.onUnauthorized();
      if (error instanceof ApiError && error.status === 403) {
        throw error;
      }
      throw new ApiError('Session expired', 401);
    }

    return request<T>(path, init, false);
  }

  if (
    response.status === 403 &&
    accessToken !== null &&
    !RETRY_EXEMPT_PATHS.some((exempt) => path.startsWith(exempt)) &&
    !path.startsWith('/auth/logout')
  ) {
    await revokeCookieSessionBestEffort();
    clientConfig?.onUnauthorized();
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
