# Redline API server. Build context is the repo root, so the workspace packages resolve:
#   docker build -f apps/server/Dockerfile .
FROM node:22.23.4-slim

RUN corepack enable && corepack prepare pnpm@11.13.1 --activate

WORKDIR /app

# manifests and sources the server needs; the install layer is cached until a dependency changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server

# the server runs TypeScript directly with tsx (a dependency of @redline/server)
RUN pnpm install --frozen-lockfile --filter "@redline/server..."

ENV NODE_ENV=production
# The host sets PORT. DATABASE_PATH must point into the persistent volume, e.g. /data/redline.db
EXPOSE 8787

CMD ["pnpm", "--filter", "@redline/server", "start"]
