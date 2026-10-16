FROM node:24-slim
RUN --mount=type=cache,target=/pnpm-store \
    pnpm install --store-dir=/pnpm-store --frozen-lockfile
RUN --mount=type=cache,target=/pnpm-store pnpm install --store-dir /pnpm-store
