import { apiGet, apiPost, ApiError, configureApiClient } from './api-client';

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as Response;
}

describe('api-client', () => {
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('coalesces concurrent 401s into a single /auth/refresh call, then retries each request once', async () => {
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

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/auth/refresh')) {
        refreshCallCount += 1;
        return Promise.resolve(
          jsonResponse(200, { success: true, data: { accessToken: 'fresh-token' }, error: null }),
        );
      }

      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.Authorization === 'Bearer fresh-token') {
        return Promise.resolve(jsonResponse(200, { success: true, data: { ok: true }, error: null }));
      }

      return Promise.resolve(jsonResponse(401, { success: false, data: null, error: 'Unauthorized' }));
    });

    const results = await Promise.all([
      apiGet('/vendors'),
      apiGet('/vendors'),
      apiGet('/drivers'),
      apiGet('/drivers'),
      apiGet('/recalls'),
    ]);

    expect(refreshCallCount).toBe(1);
    expect(onTokenRefreshed).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }]);
  });

  it('reports onUnauthorized and does not loop when the refresh itself fails', async () => {
    const onUnauthorized = jest.fn();
    configureApiClient({
      getAccessToken: () => 'expired-token',
      onTokenRefreshed: jest.fn(),
      onUnauthorized,
    });

    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/auth/refresh')) {
        return Promise.resolve(jsonResponse(401, { success: false, data: null, error: 'Invalid refresh token' }));
      }
      return Promise.resolve(jsonResponse(401, { success: false, data: null, error: 'Unauthorized' }));
    });

    await expect(apiGet('/vendors')).rejects.toBeInstanceOf(ApiError);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    // One call for /vendors, one for /auth/refresh - no retry loop.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never retries /auth/login through the refresh flow', async () => {
    configureApiClient({
      getAccessToken: () => null,
      onTokenRefreshed: jest.fn(),
      onUnauthorized: jest.fn(),
    });

    fetchMock.mockResolvedValue(jsonResponse(401, { success: false, data: null, error: 'Invalid credentials' }));

    await expect(apiPost('/auth/login', { email: 'a@b.com', password: 'wrong' })).rejects.toBeInstanceOf(ApiError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
