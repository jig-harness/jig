FROM node:24-slim
ARG STORE=/pnpm-store
ENV npm_config_store_dir=/pnpm-store
# The mount's target is an expansion: it may well be the pinned path, but the
# file alone does not say.
RUN --mount=type=cache,target=${STORE} pnpm install
