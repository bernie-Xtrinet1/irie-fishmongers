# syntax=docker/dockerfile:1
#
# IrieFishmongers customer web (Next.js standalone) production image.
# BUILD CONTEXT = repository root:  docker build -f apps/web/Dockerfile .
#
# Relies on `output: 'standalone'` + `outputFileTracingRoot` (Phase 17B.1):
# the build emits a self-contained server at .next/standalone/apps/web/server.js
# with its own traced node_modules, so the runtime stage needs NO npm install.
# NEXT_PUBLIC_* are inlined at BUILD time and must be passed as build args.

FROM node:20-bookworm-slim AS base
WORKDIR /app

# ---- builder ----
FROM base AS builder
ENV NODE_ENV=production
# NEXT_PUBLIC_* are compiled into the client bundle at build time (not runtime).
# web reads NEXT_PUBLIC_API_URL softly ('/api/v1' fallback), but pass all three
# for a correct staging build.
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
RUN npm ci
# Only this app's source + the shared packages it transpiles are needed.
COPY apps/web ./apps/web
COPY packages ./packages
RUN npm run build -w @iriefishmongers/web

# ---- runner: standalone server, non-root, no npm install ----
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs
# The traced standalone tree (server.js + node_modules + package.json) rooted
# at the monorepo root → lands as /app/apps/web/server.js, /app/node_modules...
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
# Standalone does NOT include static assets or public/ — copy them into the
# app's own location under the standalone tree.
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
USER nextjs
EXPOSE 3000
# Stable proven route for the probe: GET / (see Phase 17B.1 runtime proof).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
