# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

# mcp-server-sevdesk as a container image. It serves MCP over Streamable HTTP (`--http`) by
# default; `--stdio` and the utility commands (`healthcheck`, `generate-secret`, `grants …`) replace
# the default command. Configuration is environment only: see docs/remote.md.
#
#   docker build -t mcp-server-sevdesk .
#   docker run --rm --read-only mcp-server-sevdesk --version
#
# The build stages run on the build host's platform ($BUILDPLATFORM). The bundle and every runtime
# dependency are plain JavaScript, so a multi-arch build needs no emulation: the runtime stage only
# copies files. If a runtime dependency ever ships a native addon, install the production
# dependencies for $TARGETPLATFORM instead.

# Node.js with pnpm. corepack installs the version pinned by `packageManager` in package.json.
FROM --platform=$BUILDPLATFORM node:24-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable pnpm && pnpm --version

# The bundle (dist/). `--ignore-scripts`: no dependency build scripts, and the `prepare` script (a
# git hook setup) does not run, so the build needs no git. pnpm-workspace.yaml comes along for the
# lockfile's overrides and the minimumReleaseAge policy.
FROM base AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir=/pnpm/store
COPY tsconfig.json tsdown.config.ts ./
COPY src ./src
RUN pnpm build
# The state directory, owned by the runtime user in the final stage. Docker initializes a named or
# anonymous volume mounted here with this owner and mode.
RUN mkdir -p /rootfs/data && chmod 0700 /rootfs/data

# Production dependencies only (the bundle keeps them external).
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --prod --frozen-lockfile --ignore-scripts --store-dir=/pnpm/store

# Runtime: distroless Node.js, no shell or package manager, non-root user 65532 ("nonroot"). The
# application files belong to root and are read-only for the server; only /data is writable, so the
# container runs with a read-only root filesystem.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:088a01637f22908632ba09018be2e0b516f2fa6f7869c191d29491139db43c78 AS runtime
LABEL org.opencontainers.image.title="mcp-server-sevdesk" \
      org.opencontainers.image.description="Safety-first MCP server for the sevDesk accounting API (remote mode over Streamable HTTP). Unofficial." \
      org.opencontainers.image.source="https://github.com/jaylann/mcp-server-sevdesk" \
      org.opencontainers.image.url="https://github.com/jaylann/mcp-server-sevdesk" \
      org.opencontainers.image.documentation="https://github.com/jaylann/mcp-server-sevdesk/blob/main/docs/remote.md" \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="io.github.jaylann/mcp-server-sevdesk"
WORKDIR /app
# package.json marks dist/index.js as an ES module ("type": "module").
COPY package.json LICENSE ./
COPY --from=build /app/dist ./dist
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /rootfs/ /
ENV NODE_ENV=production \
    SEVDESK_HTTP_HOST=0.0.0.0 \
    SEVDESK_HTTP_PORT=8080 \
    SEVDESK_HTTP_STATE_DIR=/data
VOLUME /data
EXPOSE 8080
USER 65532:65532
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --start-interval=2s --retries=3 \
    CMD ["/nodejs/bin/node", "/app/dist/index.js", "healthcheck"]
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/index.js"]
CMD ["--http"]
