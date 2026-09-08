# ── Stage 1: Install dependencies ──────────────────────────────────────────────
FROM node:20-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma/

# `npm install` (not `npm ci`) so the build is resilient to the npm 10↔11
# lockfile differences around optional native deps (@emnapi/*): node:20-slim
# ships npm 10, which otherwise rejects a lockfile written by npm 11. Versions
# are still pinned by package-lock.json; install just tolerates the optional-dep
# delta instead of hard-failing.
RUN npm install --ignore-scripts && npx prisma generate

# ── Stage 2: Build Next.js ──────────────────────────────────────────────────────
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# Dummy values so Next.js build doesn't fail on env validation
ENV DATABASE_URL=file:/tmp/build.db
ENV ADMIN_PASSWORD=build

RUN npm run build

# ── Stage 3: Production runtime ─────────────────────────────────────────────────
FROM node:20-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
# Booking-day boundaries, weekend detection and same-day cancellation all use
# local time; pin it so a UTC host never shifts them.
ENV TZ=Europe/Oslo
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# Runs in `next start` mode (non-standalone). The app intentionally does NOT
# use Next's standalone output (it caused "client reference manifest" runtime
# errors under Next 16 — see next.config.ts), so we ship the regular build,
# node_modules, and next.config.ts and start with `next start`. next.config.ts
# is required at runtime for the security headers + /vilkår redirect.
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

# Entrypoint
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Persistent database volume
RUN mkdir -p /app/db && chown nextjs:nodejs /app/db
VOLUME ["/app/db"]

USER nextjs

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
