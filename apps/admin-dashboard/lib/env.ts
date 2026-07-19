// Central, validated access to the admin dashboard's public runtime
// config. No other file should read process.env.NEXT_PUBLIC_* directly -
// the API URL, environment name, and app URL are consumed from here so
// they're never scattered as literal fallbacks across api-client.ts,
// dashboard-shell.tsx, etc.
//
// NEXT_PUBLIC_* values are inlined into the client bundle at build time,
// so "startup validation" here means "fail loudly the first time this
// module is evaluated" rather than a separate build step - in production
// a missing required value throws immediately instead of silently falling
// back to a localhost default that could never work.
function readEnv(name: string, devFallback: string): string {
  const value = process.env[name];
  if (value) {
    return value;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return devFallback;
}

export const env = {
  apiUrl: readEnv('NEXT_PUBLIC_API_URL', 'http://localhost:3001/api/v1'),
  environment: readEnv('NEXT_PUBLIC_ENVIRONMENT', 'development'),
  appUrl: readEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3002'),
};
