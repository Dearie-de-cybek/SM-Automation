# Build context is the repo root: docker build -f apps/worker/Dockerfile .
# pg-boss 12 requires Node >= 22.12.
FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/worker/package.json apps/worker/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/worker apps/worker
RUN npm run build -w @sm/worker

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
# The bundle is self-contained; only the SQL files are read at runtime.
COPY --from=build --chown=app:app /repo/apps/worker/dist ./dist
COPY --chown=app:app db/migrations ./db/migrations
USER app
CMD ["node", "dist/index.js"]
