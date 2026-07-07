# Multi-stage build of the Readsmith serving app as a standalone Next server.
# Context is the monorepo root (see docker-compose.yml). Docs pages are
# prerendered at build; the app talks to Postgres at runtime for the backbone.

FROM node:24-bookworm-slim AS base
ENV CI=1
RUN corepack enable
WORKDIR /repo

# --- Build: install the workspace and produce the standalone bundle ---
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
# turbo builds every workspace package (dist) then `next build` (standalone output).
RUN pnpm build

# --- Runtime: minimal image with just the standalone server + assets ---
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=4321
ENV HOSTNAME=0.0.0.0
WORKDIR /app

# Standalone output is traced from the monorepo root, so it nests under apps/web.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
# Migration SQL for the boot-time runner (READSMITH_MIGRATIONS_DIR points here).
COPY --from=build /repo/packages/db/migrations ./migrations

EXPOSE 4321
CMD ["node", "apps/web/server.js"]
