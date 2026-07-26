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
//
// CRITICAL: each process.env.NEXT_PUBLIC_* below MUST be written as a
// static member expression, never a dynamic lookup (process.env[name]).
// Next.js's build-time inlining only substitutes literal references; a
// computed key is left as-is and evaluates to `undefined` in the browser,
// which would silently fall through to the dev fallback and force the
// client to call the absolute localhost API URL - breaking the Codespaces
// same-origin proxy (relative "/api/v1") and failing CORS. The `raw`
// value is therefore captured at each call site by the caller, not read
// from a passed-in name here.
function required(name: string, raw: string | undefined, devFallback: string): string {
  if (raw) {
    return raw;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return devFallback;
}

export const env = {
  apiUrl: required('NEXT_PUBLIC_API_URL', process.env.NEXT_PUBLIC_API_URL, 'http://localhost:3001/api/v1'),
  environment: required('NEXT_PUBLIC_ENVIRONMENT', process.env.NEXT_PUBLIC_ENVIRONMENT, 'development'),
  appUrl: required('NEXT_PUBLIC_APP_URL', process.env.NEXT_PUBLIC_APP_URL, 'http://localhost:3002'),
};
