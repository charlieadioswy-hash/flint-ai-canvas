# Use the BuildKit bundled frontend for cache mounts and COPY permissions.

ARG BUN_IMAGE=oven/bun:1.3.9
ARG NGINX_IMAGE=nginx:1.27-alpine

# 构建 Vite 前端产物。
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile --cache-dir=/root/.bun/install/cache --registry="$NPM_REGISTRY"
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY README.md /app/README.md
COPY assets /app/assets
COPY web ./
ARG VITE_TLDRAW_LICENSE_KEY
ARG BUILD_VERSION
ARG BUILD_COMMIT=unknown
ARG BUILD_TIME=unknown
ENV VITE_TLDRAW_LICENSE_KEY=${VITE_TLDRAW_LICENSE_KEY}
ENV CANVAS_BUILD_VERSION=${BUILD_VERSION}
ENV CANVAS_BUILD_COMMIT=${BUILD_COMMIT}
ENV CANVAS_BUILD_TIME=${BUILD_TIME}
# 生产镜像只构建云端工作台前端；Agent Runtime 在后端 Worker 中运行。
RUN bun --bun ./node_modules/vite/bin/vite.js build

# 运行镜像：nginx 托管静态前端，并在 Compose 中把 /api 转发到后端服务。
FROM ${NGINX_IMAGE}

COPY --from=web-build /app/web/dist /opt/canvas-release
RUN find /opt/canvas-release \( -type d ! -perm -0555 -o -type f ! -perm -0444 \) -exec chmod a+rX {} +
COPY --chmod=0755 docker/canvas-web-entrypoint.sh /usr/local/bin/canvas-web-entrypoint
COPY --chmod=0644 nginx.conf /etc/nginx/conf.d/default.conf

ENTRYPOINT ["/usr/local/bin/canvas-web-entrypoint"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
