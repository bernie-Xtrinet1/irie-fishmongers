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
};

module.exports = nextConfig;
