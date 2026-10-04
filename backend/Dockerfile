FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.8.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build && pnpm prune --prod

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./
# The build emits to dist/src (drizzle.config.ts sits beside src/).
# Migration files, for the release job: `node dist/src/db/migrate.js`
COPY --from=builder --chown=node:node /app/src/db/migrations ./migrations
ENV MIGRATIONS_DIR=/app/migrations
USER node
EXPOSE 4611
CMD ["node", "dist/src/main.js"]
