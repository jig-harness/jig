FROM node:24-slim
ARG STORE=/pnpm-store
ENV npm_config_store_dir=$STORE
RUN --mount=type=cache,target=/pnpm-store pnpm install
