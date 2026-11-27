// When API_PROXY_TARGET is set (the Codespaces demo), the app serves the API
// from its OWN origin and Next forwards /api/v1/* to the backend server-side.
// This keeps the browser same-origin, so there is no cross-port GitHub
// interstitial, no CORS, and no SameSite cookie hop. Unset (prod / local
// direct) => no rewrite, and NEXT_PUBLIC_API_URL is used as an absolute URL.
const path = require('path');

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
    // Allow HTTPS Blob/CDN origins in staging/prod; allow loopback Blob emulator only when opted in for local E2E.
    ...(process.env.ALLOW_LOCAL_BLOB_EMULATOR === 'true' ? { unoptimized: true } : {}),
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
      ...(process.env.ALLOW_LOCAL_BLOB_EMULATOR === 'true'
        ? [
            { protocol: 'http', hostname: '127.0.0.1' },
            { protocol: 'http', hostname: 'localhost' },
          ]
        : []),
    ],
  },
  ...(apiProxyTarget
    ? {
        async rewrites() {
          return [{ source: '/api/v1/:path*', destination: `${apiProxyTarget}/api/v1/:path*` }];
        },
      }
    : {}),
};

module.exports = nextConfig;
