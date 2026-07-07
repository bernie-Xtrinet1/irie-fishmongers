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
};

module.exports = nextConfig;
