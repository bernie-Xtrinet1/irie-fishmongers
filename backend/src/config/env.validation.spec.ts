import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  const validConfig = {
    NODE_ENV: 'test',
    PORT: '3001',
    API_PREFIX: 'api/v1',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_ACCESS_EXPIRES_IN: '15m',
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    JWT_REFRESH_EXPIRES_IN: '7d',
    APP_BASE_URL: 'http://localhost:3001',
    CORS_ORIGIN: 'http://localhost:3000',
    WIPAY_API_URL: 'https://tx.wipayfinancial.com/plugins/payments',
    WIPAY_ACCOUNT_NUMBER: 'test-account-number',
    WIPAY_API_KEY: 'test-wipay-key',
    SENDGRID_API_KEY: 'test-sendgrid-key',
    SENDGRID_FROM_EMAIL: 'notifications@iriefishmongers.com',
    FCM_SERVER_KEY: 'test-fcm-key',
  };

  it('returns a validated, transformed config for valid input', () => {
    const result = validateEnv(validConfig);

    expect(result.NODE_ENV).toBe('test');
    expect(result.PORT).toBe(3001);
    expect(result.API_PREFIX).toBe('api/v1');
    expect(result.DATABASE_URL).toBe(validConfig.DATABASE_URL);
    expect(result.REDIS_URL).toBe(validConfig.REDIS_URL);
  });

  it('throws when NODE_ENV is not one of the allowed values', () => {
    expect(() => validateEnv({ ...validConfig, NODE_ENV: 'staging' })).toThrow(
      /Environment validation failed/,
    );
  });

  it('throws when PORT is out of range', () => {
    expect(() => validateEnv({ ...validConfig, PORT: '70000' })).toThrow(
      /Environment validation failed/,
    );
  });

  it('throws when DATABASE_URL is not a valid postgres URL', () => {
    expect(() => validateEnv({ ...validConfig, DATABASE_URL: 'not-a-url' })).toThrow(
      /Environment validation failed/,
    );
  });

  it('throws when a required variable is missing', () => {
    const { REDIS_URL: _REDIS_URL, ...withoutRedis } = validConfig;
    expect(() => validateEnv(withoutRedis)).toThrow(/Environment validation failed/);
  });

  it('accepts a comma-separated CORS_ORIGIN allowlist', () => {
    const result = validateEnv({
      ...validConfig,
      CORS_ORIGIN: 'http://localhost:3000,http://localhost:3002',
    });
    expect(result.CORS_ORIGIN).toBe('http://localhost:3000,http://localhost:3002');
  });

  it('throws when CORS_ORIGIN is not a valid http(s) URL list', () => {
    expect(() => validateEnv({ ...validConfig, CORS_ORIGIN: 'not-a-url' })).toThrow(
      /Environment validation failed/,
    );
  });
});
