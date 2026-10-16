ARG BASE=deps
FROM node:24-slim AS deps
ENV npm_config_store_dir=/pnpm-store
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile

# Which stage this one inherits from is decided by the build command, so
# whether it inherits the pin cannot be read from the file.
FROM ${BASE} AS build
RUN pnpm run build
