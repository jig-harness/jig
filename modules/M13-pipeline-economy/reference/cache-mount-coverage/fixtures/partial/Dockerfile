FROM node:24-slim AS base
ENV npm_config_store_dir /pnpm-store

FROM base AS deps
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# The build step invokes pnpm with no mount: its lifecycle scripts find an
# empty store.
RUN pnpm --filter app build
RUN ["sh", "-c", "pnpm licenses list"]
