import { NextRequest, NextResponse } from 'next/server';

// Single source of truth for the admin app's Content-Security-Policy.
//
// Next.js 15 App Router hydrates via INLINE <script> tags (the
// self.__next_f.push(...) RSC stream + bootstrap). A static
// `script-src 'self'` blocks those and the page never hydrates (blank screen).
// Instead of relaxing to 'unsafe-inline' (which would reopen the XSS hole the
// httpOnly-refresh-cookie design guards against, ADR-004), we mint a
// per-request cryptographic nonce here and put it on BOTH:
//   - the REQUEST CSP header, which Next.js reads to stamp `nonce="..."` onto
//     its own inline scripts, and
//   - the RESPONSE CSP header the browser enforces.
// `'strict-dynamic'` lets the nonce'd bootstrap load the /_next/static chunk
// scripts; `'self'` is the fallback for browsers without strict-dynamic. No
// `'unsafe-inline'` on script-src in any environment. `'unsafe-eval'` stays in
// development only (webpack HMR needs it).
export function middleware(request: NextRequest): NextResponse {
  const isDev = process.env.NODE_ENV !== 'production';

  // 128 bits of CSPRNG entropy, base64 - a proper CSP nonce.
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = btoa(String.fromCharCode(...nonceBytes));

  // A relative NEXT_PUBLIC_API_URL ("/api/v1") is same-origin (connect-src
  // 'self' covers it); only an absolute backend URL needs an explicit origin.
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';
  const apiOrigin = apiUrl.startsWith('http') ? new URL(apiUrl).origin : '';

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src 'self'${apiOrigin ? ` ${apiOrigin}` : ''}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

  // Forward the nonce to the app: `x-nonce` (readable via headers()) plus the
  // CSP header Next.js parses to auto-nonce its inline scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

// Run on document requests only; skip Next static assets, image optimizer,
// favicon and common static files (they need no per-document CSP/nonce), and
// skip prefetches.
export const config = {
  matcher: [
    {
      source:
        '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|woff2?)$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
