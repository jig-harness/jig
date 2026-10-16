FROM node:24-slim
# A build argument is an environment variable to the RUNs of this stage, so
# it pins the store as ENV would; its value is the one the build passes,
# which the check is given with --build-arg.
ARG npm_config_store_dir=/pnpm-store
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile
COPY . .
# The build step reads the same store, without the mount.
RUN pnpm run build
