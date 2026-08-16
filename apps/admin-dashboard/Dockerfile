# syntax=docker/dockerfile:1
#
# IrieFishmongers admin dashboard (Next.js standalone) production image.
# BUILD CONTEXT = repository root:  docker build -f apps/admin-dashboard/Dockerfile .
#
# Relies on `output: 'standalone'` + `outputFileTracingRoot` (Phase 17B.1):
# the build emits a self-contained server at
# .next/standalone/apps/admin-dashboard/server.js with its own traced
# node_modules, so the runtime stage needs NO npm install.
#
# admin HARD-REQUIRES NEXT_PUBLIC_API_URL at build time (lib/env.ts throws if
# missing); the production build fails without it. There is no public/ dir for
# this app, so none is copied (no fabricated directory).

FROM node:20-bookworm-slim AS base
WORKDIR /app

# ---- builder ----
FROM base AS builder
ENV NODE_ENV=production
# NEXT_PUBLIC_* are inlined at build time. NEXT_PUBLIC_API_URL is mandatory for
# admin - the build will fail (by design) if it is not supplied.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_ENVIRONMENT
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NEXT_PUBLIC_ENVIRONMENT=${NEXT_PUBLIC_ENVIRONMENT}
# All workspace manifests are required so `npm ci` matches the root lockfile.
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./tsconfig.base.json
COPY backend/package.json ./backend/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/admin-dashboard/package.json ./apps/admin-dashboard/package.json
COPY packages/types/package.json ./packages/types/package.json
COPY packages/ui/package.json ./packages/ui/package.json
RUN npm ci --include=dev
# Only this app's source + the shared packages it transpiles are needed.
COPY apps/admin-dashboard ./apps/admin-dashboard
COPY packages ./packages
RUN npm run build -w @iriefishmongers/admin-dashboard

# ---- runner: standalone server, non-root, no npm install ----
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3002
ENV HOSTNAME=0.0.0.0
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs
# Traced standalone tree → /app/apps/admin-dashboard/server.js, /app/node_modules...
COPY --from=builder --chown=nextjs:nodejs /app/apps/admin-dashboard/.next/standalone ./
# Standalone does NOT include static assets — copy them in. admin has no public/.
COPY --from=builder --chown=nextjs:nodejs /app/apps/admin-dashboard/.next/static ./apps/admin-dashboard/.next/static
USER nextjs
EXPOSE 3002
# Stable proven route for the probe: GET /login (see Phase 17B.1 runtime proof).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/admin-dashboard/server.js"]
