# syntax=docker/dockerfile:1
FROM node:24-slim AS base
ENV npm_config_store_dir=/pnpm-store
RUN corepack enable

FROM base AS deps
COPY pnpm-lock.yaml package.json ./
# The install mounts the store; a comment inside a continuation is dropped.
RUN --mount=type=cache,target=/pnpm-store,sharing=locked \
    # fetch first, then install offline
    pnpm fetch && \
    pnpm install --offline --frozen-lockfile

FROM deps AS build
COPY . .
# A lifecycle script of the build reads the store again, so the mount is here too.
RUN --mount=type=cache,dst=/pnpm-store/ \
    NODE_ENV=production pnpm --filter app build
# Wrapped, looped and quoted invocations are read too.
RUN --mount=type=cache,target=/pnpm-store \
    for pkg in a b; do timeout 5m pnpm --filter "app-$pkg" test; done \
    && sh -c 'pnpm licenses list' \
    && env CI=1 pnpm rebuild
RUN --mount=type=cache,target=/pnpm-store ["pnpm", "prune", "--prod"]
RUN echo "pnpm is only text here" && ls

FROM node:24-slim AS runtime
# No pin in this stage: it reads no store, so a plain RUN is fine.
RUN node --version
