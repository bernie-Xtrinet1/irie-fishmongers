const path = require('path');

// When set (the Codespaces demo), serve the API from this app's own origin and
// forward /api/v1/* to the backend server-side - keeps the browser same-origin
// (no cross-port GitHub interstitial, no CORS, no SameSite cookie hop).
const apiProxyTarget = process.env.API_PROXY_TARGET;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Phase 17B.1: self-contained server bundle for container hosting. In this
  // npm-workspaces monorepo the traced root must be the repo root so the
  // standalone output includes the source-consumed workspace packages
  // (@iriefishmongers/types, @iriefishmongers/ui via transpilePackages) and
  // the hoisted root node_modules (incl. sharp) - without it tracing misses
  // them and server.js lands at the wrong relative path.
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
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
          // Content-Security-Policy is set per-request in middleware.ts (it
          // needs a per-request nonce); it is deliberately NOT set here so
          // there is a single CSP authority.
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
