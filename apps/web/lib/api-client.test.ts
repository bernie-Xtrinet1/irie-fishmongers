import { apiGet, apiPatch, apiPost, ApiError, configureApiClient } from './api-client';

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as Response;
}

describe('web api-client', () => {
  let fetchMock: jest.MockedFunction<typeof fetch>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    global.fetch = fetchMock;
    configureApiClient({
      getAccessToken: () => null,
      onTokenRefreshed: jest.fn(),
      onUnauthorized: jest.fn(),
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends the access token and includes credentials', async () => {
    configureApiClient({
      getAccessToken: () => 'access-token',
      onTokenRefreshed: jest.fn(),
      onUnauthorized: jest.fn(),
    });

    fetchMock.mockResolvedValue(
      jsonResponse(200, { success: true, data: { ok: true }, error: null }),
    );

    await apiGet<{ ok: boolean }>('/products');

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const requestUrl = fetchMock.mock.calls[0]?.[0] as string;
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const requestHeaders = requestInit.headers as Record<string, string>;

    expect(requestUrl).toContain('/products');
    expect(requestInit.credentials).toBe('include');
    expect(requestHeaders.Accept).toBe('application/json');
    expect(requestHeaders.Authorization).toBe('Bearer access-token');
  });

  it('coalesces concurrent 401s into one refresh and retries each request once', async () => {
    let accessToken = 'expired-token';
    let refreshCallCount = 0;

    const onTokenRefreshed = jest.fn((token: string) => {
      accessToken = token;
    });
    const onUnauthorized = jest.fn();

    configureApiClient({
      getAccessToken: () => accessToken,
      onTokenRefreshed,
      onUnauthorized,
    });

    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

      if (url.includes('/auth/refresh')) {
        refreshCallCount += 1;
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            data: { accessToken: 'fresh-token' },
            error: null,
          }),
        );
      }

      const headers = init?.headers as Record<string, string> | undefined;

      if (headers?.Authorization === 'Bearer fresh-token') {
        return Promise.resolve(
          jsonResponse(200, { success: true, data: { ok: true }, error: null }),
        );
      }

      return Promise.resolve(
        jsonResponse(401, { success: false, data: null, error: 'Unauthorized' }),
      );
    });

    const results = await Promise.all([
      apiGet('/products'),
      apiGet('/products'),
      apiGet('/cart'),
      apiGet('/orders'),
    ]);

    expect(refreshCallCount).toBe(1);
    expect(onTokenRefreshed).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(results).toEqual([
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: true },
    ]);
  });

  it('reports unauthorized and does not loop when refresh fails', async () => {
    const onUnauthorized = jest.fn();

    configureApiClient({
      getAccessToken: () => 'expired-token',
      onTokenRefreshed: jest.fn(),
      onUnauthorized,
    });

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

      if (url.includes('/auth/refresh')) {
        return Promise.resolve(
          jsonResponse(401, {
            success: false,
            data: null,
            error: 'Invalid refresh token',
          }),
        );
      }

      return Promise.resolve(
        jsonResponse(401, { success: false, data: null, error: 'Unauthorized' }),
      );
    });

    await expect(apiGet('/cart')).rejects.toEqual(
      expect.objectContaining({
        name: 'ApiError',
        message: 'Session expired',
        status: 401,
      }),
    );

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['/auth/register', { email: 'customer@example.com' }],
    ['/auth/login', { email: 'customer@example.com', password: 'wrong' }],
    ['/auth/refresh', {}],
    ['/auth/forgot-password', { email: 'customer@example.com' }],
    ['/auth/reset-password', { token: 'bad-token', password: 'NewPass!23' }],
    ['/auth/verify-email', { token: 'bad-token' }],
  ])('does not refresh when public auth endpoint %s returns 401', async (path, body) => {
    const onUnauthorized = jest.fn();

    configureApiClient({
      getAccessToken: () => null,
      onTokenRefreshed: jest.fn(),
      onUnauthorized,
    });

    fetchMock.mockResolvedValue(
      jsonResponse(401, { success: false, data: null, error: 'Authentication failed' }),
    );

    await expect(apiPost(path, body)).rejects.toBeInstanceOf(ApiError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('supports authenticated PATCH requests', async () => {
    configureApiClient({
      getAccessToken: () => 'access-token',
      onTokenRefreshed: jest.fn(),
      onUnauthorized: jest.fn(),
    });

    fetchMock.mockResolvedValue(
      jsonResponse(200, { success: true, data: { updated: true }, error: null }),
    );

    const result = await apiPatch<{ updated: boolean }>('/profile', { firstName: 'Test' });

    expect(result).toEqual({ updated: true });

    const requestUrl = fetchMock.mock.calls[0]?.[0] as string;
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const requestHeaders = requestInit.headers as Record<string, string>;

    expect(requestUrl).toContain('/profile');
    expect(requestInit.method).toBe('PATCH');
    expect(requestInit.credentials).toBe('include');
    expect(requestInit.body).toBe(JSON.stringify({ firstName: 'Test' }));
    expect(requestHeaders.Authorization).toBe('Bearer access-token');
  });
});
