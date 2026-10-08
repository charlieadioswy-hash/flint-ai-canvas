# Use the BuildKit bundled frontend for cache mounts and COPY permissions.

ARG NODE_IMAGE=node:22.19-alpine
FROM ${NODE_IMAGE}

ARG ALPINE_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/alpine
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    sed -i "s#https*://dl-cdn.alpinelinux.org/alpine#${ALPINE_MIRROR%/}#g" /etc/apk/repositories \
    && apk --cache-dir /var/cache/apk add --update-cache ca-certificates wget \
    && addgroup -S app \
    && adduser -S app -G app

WORKDIR /app
COPY --chmod=0644 backend/agent-runtime/pi/package.json backend/agent-runtime/pi/package-lock.json /app/agent-runtime/
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts --prefer-offline --no-audit --no-fund \
      --registry="$NPM_REGISTRY" --cache=/root/.npm --prefix /app/agent-runtime
COPY --chmod=0644 backend/agent-runtime/pi/agent-runtime.mjs /app/agent-runtime/agent-runtime.mjs
COPY --chmod=0644 yingce-agent/server.mjs /app/server.mjs

ENV NODE_ENV=production
USER app
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8081/healthz >/dev/null || exit 1
CMD ["node", "server.mjs"]
