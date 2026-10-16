FROM node:24-slim
ARG PM=pnpm
ENV npm_config_store_dir=/pnpm-store
RUN --mount=type=cache,target=/pnpm-store $PM install
