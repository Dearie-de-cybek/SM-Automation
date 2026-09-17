# Build context is the repo root: docker build -f apps/dashboard/Dockerfile .
FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/worker/package.json apps/worker/
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /repo/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/dashboard apps/dashboard
RUN npm run build -w @sm/dashboard

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
# Standalone output keeps the workspace layout: the server entry is apps/dashboard/server.js.
COPY --from=build --chown=app:app /repo/apps/dashboard/.next/standalone ./
COPY --from=build --chown=app:app /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=build --chown=app:app /repo/apps/dashboard/public ./apps/dashboard/public
USER app
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]
