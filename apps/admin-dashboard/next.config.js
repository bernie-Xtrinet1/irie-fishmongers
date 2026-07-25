const isDev = process.env.NODE_ENV !== 'production';
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';
// A relative apiUrl ("/api/v1") means the app calls its OWN origin via the
// dev proxy (see API_PROXY_TARGET below), which connect-src 'self' already
// covers; only an absolute URL needs an explicit connect-src origin.
const apiOrigin = apiUrl.startsWith('http') ? new URL(apiUrl).origin : '';

// When set (the Codespaces demo), serve the API from this app's own origin and
// forward /api/v1/* to the backend server-side - keeps the browser same-origin
// (no cross-port GitHub interstitial, no CORS, no SameSite cookie hop).
const apiProxyTarget = process.env.API_PROXY_TARGET;

// Even with the httpOnly refresh cookie (ADR-004), the in-memory access
// token is only as safe as this page is from XSS - these headers are the
// second line of defense. 'unsafe-eval'/'unsafe-inline' on script-src are
// relaxed in dev only, for webpack HMR; production stays strict.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self'${isDev ? " 'unsafe-eval' 'unsafe-inline'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  `connect-src 'self'${apiOrigin ? ` ${apiOrigin}` : ''}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@iriefishmongers/types', '@iriefishmongers/ui'],
  images: {
    // Vendor-uploaded product images have no fixed CDN host yet (AWS S3
    // integration is still unwired per tech-stack.md) - allow any HTTPS
    // source for now, narrow this once a production image host exists.
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
  ...(apiProxyTarget
    ? {
        async rewrites() {
          return [{ source: '/api/v1/:path*', destination: `${apiProxyTarget}/api/v1/:path*` }];
        },
      }
    : {}),
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // Legacy fallback for browsers that don't honor frame-ancestors.
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
