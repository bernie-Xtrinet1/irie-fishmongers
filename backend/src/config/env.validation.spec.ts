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
    FIREBASE_PROJECT_ID: 'test-project',
    FIREBASE_CLIENT_EMAIL: 'firebase@test-project.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n',
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

  it.each([
    'SENDGRID_API_KEY',
    'SENDGRID_FROM_EMAIL',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_PRIVATE_KEY',
  ] as const)(
    'throws when the required notification variable %s is missing',
    (key) => {
      const { [key]: _omitted, ...withoutKey } = validConfig;
      expect(() => validateEnv(withoutKey)).toThrow(/Environment validation failed/);
    },
  );

  it.each([
    'SENDGRID_API_KEY',
    'SENDGRID_FROM_EMAIL',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_PRIVATE_KEY',
  ] as const)(
    'throws when the required notification variable %s is empty',
    (key) => {
      expect(() => validateEnv({ ...validConfig, [key]: '' })).toThrow(
        /Environment validation failed/,
      );
    },
  );

  it('accepts the placeholder values documented in backend/.env.example', () => {
    // Mirrors the example file's notification placeholders so the documented
    // example provably satisfies the actual validators when populated as shown.
    const result = validateEnv({
      ...validConfig,
      SENDGRID_API_KEY: 'replace-with-sendgrid-api-key',
      SENDGRID_FROM_EMAIL: 'notifications@iriefishmongers.com',
      FIREBASE_PROJECT_ID: 'replace-with-firebase-project-id',
      FIREBASE_CLIENT_EMAIL: 'replace-with-firebase-client-email',
      FIREBASE_PRIVATE_KEY: 'replace-with-firebase-private-key',
    });

    expect(result.SENDGRID_API_KEY).toBe('replace-with-sendgrid-api-key');
    expect(result.SENDGRID_FROM_EMAIL).toBe('notifications@iriefishmongers.com');
    expect(result.FIREBASE_PROJECT_ID).toBe('replace-with-firebase-project-id');
    expect(result.FIREBASE_CLIENT_EMAIL).toBe('replace-with-firebase-client-email');
    expect(result.FIREBASE_PRIVATE_KEY).toBe('replace-with-firebase-private-key');
  });

  it('allows the SendGrid credentials to be absent when EMAIL_ENABLED is false', () => {
    // Staging/UAT with no approved email provider: the backend must boot
    // without a SendGrid key (no fake key is ever supplied).
    const { SENDGRID_API_KEY: _k, SENDGRID_FROM_EMAIL: _f, ...withoutSendgrid } = validConfig;
    const result = validateEnv({ ...withoutSendgrid, EMAIL_ENABLED: 'false' });

    expect(result.EMAIL_ENABLED).toBe('false');
    expect(result.SENDGRID_API_KEY).toBeUndefined();
  });

  it.each(['SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL'] as const)(
    'still requires %s when EMAIL_ENABLED is explicitly true',
    (key) => {
      const withoutKey: Record<string, unknown> = { ...validConfig, EMAIL_ENABLED: 'true' };
      delete withoutKey[key];
      expect(() => validateEnv(withoutKey)).toThrow(/Environment validation failed/);
    },
  );

  it('disabling email does NOT relax any non-email required variable', () => {
    // EMAIL_ENABLED=false must scope only to SendGrid - Firebase (and the rest)
    // stay mandatory.
    const { FIREBASE_PRIVATE_KEY: _fpk, ...withoutFirebaseKey } = validConfig;
    expect(() => validateEnv({ ...withoutFirebaseKey, EMAIL_ENABLED: 'false' })).toThrow(
      /Environment validation failed/,
    );
  });

  it('rejects an EMAIL_ENABLED value other than true/false', () => {
    expect(() => validateEnv({ ...validConfig, EMAIL_ENABLED: 'maybe' })).toThrow(
      /Environment validation failed/,
    );
  });
});
