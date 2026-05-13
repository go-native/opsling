# syntax=docker/dockerfile:1.7

# ------------------------------------------------------------------
# 1. install deps
# ------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && \
    if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; \
    else pnpm install --no-frozen-lockfile; fi

# ------------------------------------------------------------------
# 2. build
# ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable && pnpm build

# ------------------------------------------------------------------
# 3. production deps only
# ------------------------------------------------------------------
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && \
    if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile --prod; \
    else pnpm install --no-frozen-lockfile --prod; fi

# ------------------------------------------------------------------
# 4. runtime (distroless)
#
# Runs as root inside the container. Reason: Opsling needs to talk to the
# host's Docker daemon via /var/run/docker.sock, which on most Linux
# distros is owned by root:docker and unreadable by the distroless
# `nonroot` user (UID 65532). And on macOS Docker Desktop, the socket
# inside the container is owned root:root regardless of host setup.
#
# This is the same pattern used by cAdvisor, watchtower, portainer,
# node-exporter, and other monitoring tools that read the Docker socket.
# Container root is not host root — namespaces still isolate us — and any
# container with docker.sock access has root-equivalent capabilities via
# the Docker API anyway, so the in-container user is theatrical.
# ------------------------------------------------------------------
FROM gcr.io/distroless/nodejs22-debian12 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 4717
CMD ["dist/index.js"]
