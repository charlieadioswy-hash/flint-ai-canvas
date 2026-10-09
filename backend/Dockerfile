ARG GO_IMAGE=golang:1.25-alpine
ARG ALPINE_IMAGE=alpine:3.22
ARG NODE_IMAGE=node:22.19-alpine

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS go-modules

ARG GOPROXY=https://goproxy.cn,direct
ENV GOPROXY=$GOPROXY

WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
# 本地 replace 的模块必须在下载依赖前可用。
COPY backend/third_party ./third_party
# cache mount 复用依赖变更前的下载；普通层快照供支付插件、后端及 GHA 层缓存共用。
RUN --mount=type=cache,id=canvas-go-modules,target=/go/pkg/mod,sharing=locked \
    go mod download \
    && mkdir -p /opt/go-modules \
    && cp -a /go/pkg/mod/. /opt/go-modules/

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS payment-package-build

ARG GOPROXY=https://goproxy.cn,direct
ARG ALPINE_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/alpine
ENV GOPROXY=$GOPROXY

RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    sed -i "s#https\?://dl-cdn.alpinelinux.org/alpine#${ALPINE_MIRROR%/}#g" /etc/apk/repositories \
    && apk --cache-dir /var/cache/apk --update-cache add nodejs unzip zip

WORKDIR /src
COPY backend ./backend
COPY plugin-packages ./plugin-packages
ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=bind,from=go-modules,source=/opt/go-modules,target=/go/pkg/mod,rw \
    --mount=type=cache,target=/root/.cache/go-build set -eu; \
    test -n "$TARGETOS"; \
    test -n "$TARGETARCH"; \
    PAYMENT_PLUGIN_GOOS="$TARGETOS" \
    PAYMENT_PLUGIN_GOARCH="$TARGETARCH" \
    PAYMENT_PLUGIN_CGO_ENABLED=0 \
      ./plugin-packages/build-packages.sh --payments-only; \
    sh ./plugin-packages/verify-payment-packages.sh "$TARGETOS" "$TARGETARCH"

FROM ${ALPINE_IMAGE} AS payment-package-smoke

ARG ALPINE_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/alpine
ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    sed -i "s#https\?://dl-cdn.alpinelinux.org/alpine#${ALPINE_MIRROR%/}#g" /etc/apk/repositories \
    && apk --cache-dir /var/cache/apk --update-cache add unzip
COPY --from=payment-package-build /src/plugin-packages /app/plugin-packages
RUN PAYMENT_PLUGIN_SMOKE_TEST=1 \
    sh /app/plugin-packages/verify-payment-packages.sh "$TARGETOS" "$TARGETARCH"

FROM ${GO_IMAGE} AS backend-build

ARG GOPROXY=https://goproxy.cn,direct
ARG ALPINE_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/alpine
ENV GOPROXY=$GOPROXY

RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    sed -i "s#https\?://dl-cdn.alpinelinux.org/alpine#${ALPINE_MIRROR%/}#g" /etc/apk/repositories \
    && apk --cache-dir /var/cache/apk --update-cache add build-base

WORKDIR /src/backend
COPY backend ./
COPY VERSION /src/VERSION
ARG BUILD_VERSION
ARG BUILD_COMMIT=unknown
ARG BUILD_TIME=unknown
RUN --mount=type=bind,from=go-modules,source=/opt/go-modules,target=/go/pkg/mod,rw \
    --mount=type=cache,target=/root/.cache/go-build set -eu; \
    version="${BUILD_VERSION:-$(tr -d '\r\n' </src/VERSION)}"; \
    ldflags="-s -w -X yingce/backend/internal/buildinfo.Version=${version} -X yingce/backend/internal/buildinfo.Commit=${BUILD_COMMIT} -X yingce/backend/internal/buildinfo.BuildTime=${BUILD_TIME}"; \
    CGO_ENABLED=1 GOOS=linux go build -trimpath -ldflags="$ldflags" -o /out/yingce-backend ./cmd/server; \
    CGO_ENABLED=1 GOOS=linux go build -trimpath -ldflags="$ldflags" -o /out/migrate-schema ./cmd/migrate-schema; \
    CGO_ENABLED=1 GOOS=linux go build -trimpath -ldflags="$ldflags" -o /out/migrate-sqlite-postgres ./cmd/migrate-sqlite-postgres

FROM ${NODE_IMAGE} AS pi-runtime-deps

ARG NPM_REGISTRY=https://registry.npmmirror.com
WORKDIR /app/backend/agent-runtime/pi
COPY backend/agent-runtime/pi/package.json backend/agent-runtime/pi/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts --prefer-offline --no-audit --no-fund \
    --registry="$NPM_REGISTRY" --replace-registry-host=always --cache=/root/.npm

FROM ${NODE_IMAGE}

ARG ALPINE_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/alpine
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    sed -i "s#https\?://dl-cdn.alpinelinux.org/alpine#${ALPINE_MIRROR%/}#g" /etc/apk/repositories \
    && apk --cache-dir /var/cache/apk --update-cache add ca-certificates tzdata wget \
    && addgroup -S app \
    && adduser -S app -G app

WORKDIR /app
ENV GIN_MODE=release
ENV CANVAS_BACKEND_ADDR=:8080
ENV CANVAS_BACKEND_DATA_DIR=/data

RUN mkdir -p /data && chown -R app:app /data
COPY --from=backend-build /out/yingce-backend /usr/local/bin/yingce-backend
COPY --from=backend-build /out/migrate-schema /usr/local/bin/migrate-schema
COPY --from=backend-build /out/migrate-sqlite-postgres /usr/local/bin/migrate-sqlite-postgres
COPY --from=payment-package-smoke /app/plugin-packages /app/plugin-packages
COPY --from=pi-runtime-deps /app/backend/agent-runtime/pi/node_modules /app/backend/agent-runtime/pi/node_modules
COPY backend/agent-runtime/pi/package.json backend/agent-runtime/pi/package-lock.json /app/backend/agent-runtime/pi/
COPY backend/agent-runtime/pi/agent-runtime.mjs /app/backend/agent-runtime/pi/agent-runtime.mjs
# 部署源码可能来自严格 umask 的归档；运行时资源保持 root 所有并允许 app 读取。
# 只修复缺失权限，避免 OverlayFS 为正常资源复制出另一整层。
RUN find /app/plugin-packages /app/backend \
    \( -type d ! -perm -0555 -o -type f ! -perm -0444 \
    -o -type f \( -perm -0100 -o -perm -0010 -o -perm -0001 \) ! -perm -0111 \) \
    -exec chmod a+rX '{}' +

USER app
RUN test -r /app/backend/agent-runtime/pi/agent-runtime.mjs \
    && for package in /app/plugin-packages/*.yingce-plugin; do test -r "$package" || exit 1; done
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8080/api/health/ready >/dev/null || exit 1
CMD ["yingce-backend"]
