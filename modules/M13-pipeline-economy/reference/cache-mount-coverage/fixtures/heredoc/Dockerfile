FROM node:24-slim
ENV npm_config_store_dir=/pnpm-store
RUN --mount=type=cache,target=/pnpm-store <<EOT
pnpm install
pnpm build
EOT
