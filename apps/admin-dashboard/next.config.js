const isDev = process.env.NODE_ENV !== 'production';
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';
const apiOrigin = new URL(apiUrl).origin;

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
  `connect-src 'self' ${apiOrigin}`,
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
