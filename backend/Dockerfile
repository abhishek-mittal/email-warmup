# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# --- deps + build ---
FROM base AS build
COPY package.json pnpm-lock.yaml ./
# pnpm 10+ blocks dependency build scripts by default (ERR_PNPM_IGNORED_BUILDS).
# --frozen-lockfile + pnpm's supply-chain verification bound this to the exact
# pinned tree (the same scripts local dev runs), so allow them in the image.
RUN pnpm install --frozen-lockfile --config.dangerously-allow-all-builds=true
COPY . .
RUN pnpm build
# nest build does not copy .sql — migrator resolves ./migrations next to the
# compiled file (dist/src/db/migrate.js), so place the SQL there explicitly.
RUN cp -r src/db/migrations dist/src/db/migrations

# --- production deps only ---
FROM base AS proddeps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --config.dangerously-allow-all-builds=true

# --- runtime ---
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 1001 --create-home appuser
COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER appuser
EXPOSE 4611
CMD ["node", "dist/src/main"]
