# syntax=docker/dockerfile:1
#
# IrieFishmongers backend (NestJS + Prisma) production image.
# BUILD CONTEXT = repository root:  docker build -f backend/Dockerfile .
#
# Prisma engine strategy (Phase 17B.2, approved): schema.prisma is left with
# the implicit `native` binaryTarget. Every stage is pinned to the SAME
# node:20-bookworm-slim platform, and `prisma generate` runs inside the Linux
# build stage, so the generated native query engine matches the runtime OS.
# No explicit binaryTargets unless a real docker build later proves an
# OpenSSL/engine mismatch.

# Single pinned base for build + runtime so the Prisma native engine matches.
FROM node:20-bookworm-slim AS base
WORKDIR /app

# ---- builder: full install → prisma generate → nest build → prune to prod ----
FROM base AS builder
ENV NODE_ENV=development
# Manifests first for layer caching. All workspace manifests are required so
# `npm ci` can satisfy the single root lockfile's workspace set.
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./tsconfig.base.json
COPY backend/package.json ./backend/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/admin-dashboard/package.json ./apps/admin-dashboard/package.json
COPY packages/types/package.json ./packages/types/package.json
COPY packages/ui/package.json ./packages/ui/package.json
RUN npm ci
# Backend source (incl. prisma/ schema needed for generate) + shared packages.
COPY backend ./backend
COPY packages ./packages
# Generate the Prisma client (no postinstall hook exists, so this is explicit),
# then compile Nest to backend/dist. In this workspace @prisma/client is NOT
# hoisted - `prisma generate` writes the client + native engine into
# backend/node_modules/{.prisma,@prisma/client} (relative to the schema), while
# other backend runtime deps (@nestjs/*, etc.) ARE hoisted to the root
# node_modules. Generating here in the Linux stage produces the matching Linux
# native engine.
RUN npm run prisma:generate -w @iriefishmongers/backend
RUN npm run build -w @iriefishmongers/backend

# ---- migrator: self-contained `prisma migrate deploy` (Container Apps Job) ----
# Branches off the UNPRUNED builder, so it keeps the Prisma CLI
# (backend/node_modules/prisma), the migration + query engines fetched at
# `npm ci` / `prisma generate`, the schema, and all committed migrations. Runs
# the LOCAL prisma executable directly (never npm/npx), so it performs NO
# runtime install or download - the engines are already baked into this image.
# `migrate deploy` needs only DATABASE_URL (from env), the schema, and the
# migrations; no shadow database, no generate, no seed.
FROM builder AS migrator
ENV NODE_ENV=production
RUN groupadd --system --gid 1002 migrator \
  && useradd --system --uid 1002 --gid migrator migrator
USER migrator
WORKDIR /app/backend
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

# ---- pruned: production-only dependency tree that feeds the runtime image ----
# The prune/removal that previously ran inline in `builder` lives here now so
# the migrator stage above could branch off the un-pruned tree. Behaviour is
# unchanged: removes devDeps (@nestjs/cli, typescript, jest, prisma CLI, ...)
# from both the root and nested backend node_modules, keeps @prisma/client (a
# prod dep), and leaves the generated .prisma engine dir untouched.
FROM builder AS pruned
RUN npm prune --omit=dev \
    && rm -rf /app/backend/node_modules/prisma /app/node_modules/prisma \
              /app/backend/node_modules/typescript /app/node_modules/typescript

# ---- runner: minimal, non-root, no build/test tooling ----
FROM base AS runner
ENV NODE_ENV=production
# Non-secret, stable deployment defaults; all other required env
# (DATABASE_URL, REDIS_URL, JWT secrets, provider keys, CORS_ORIGIN,
# APP_BASE_URL, WIPAY_*) are supplied at runtime by the platform / Key Vault.
ENV PORT=3001
ENV API_PREFIX=api/v1
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nestjs
# Two node_modules trees, both pruned to production (sourced from `pruned`):
#  - root: hoisted runtime deps (@nestjs/*, etc.)
#  - backend/node_modules: the non-hoisted, generated @prisma/client + engine
# Node resolves from backend/node_modules upward to the root, so both are needed.
COPY --from=pruned --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=pruned --chown=nestjs:nodejs /app/backend/node_modules ./backend/node_modules
COPY --from=pruned --chown=nestjs:nodejs /app/backend/dist ./backend/dist
COPY --from=pruned --chown=nestjs:nodejs /app/backend/package.json ./backend/package.json
USER nestjs
WORKDIR /app/backend
EXPOSE 3001
# Readiness probe endpoint for Container Apps: GET /api/v1/health.
# Node-based HEALTHCHECK (global fetch on Node 20) — no curl installed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
