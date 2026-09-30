#!/usr/bin/env bash
# FLINT AI 影策工作台 - 服务器生产部署脚本（PostgreSQL + Redis 标准版）
# 用法: /opt/open-ai-canvas/deploy.sh [pull|build|restart|status]
#   pull    仅拉取最新代码（走 gh-proxy 加速）
#   build   拉取并重建生产镜像
#   restart 重启服务栈
#   status  查看容器状态
set -euo pipefail
cd "$(dirname "$0")"

ACTION="${1:-status}"
COMPOSE_FILES="-f docker-compose.deploy.yml -f docker-compose.prod.port.yml"

log() { echo "[deploy $(date "+%H:%M:%S")] $*"; }

case "$ACTION" in
  pull)
    log "拉取最新代码（经 gh-proxy 加速）..."
    git pull --ff-only https://gh-proxy.com/https://github.com/charlieadioswy-hash/flint-ai-canvas.git main
    log "当前版本: $(git log --oneline -1)"
    ;;
  build)
    log "拉取最新代码..."
    git pull --ff-only https://gh-proxy.com/https://github.com/charlieadioswy-hash/flint-ai-canvas.git main
    log "当前版本: $(git log --oneline -1)"
    log "重建生产镜像（约需数分钟）..."
    docker compose --env-file .env -f docker-compose.deploy.yml -f docker-compose.build.yml build
    log "重建 yingce-agent 镜像（build 上下文为仓库根目录）..."
    docker build -t open-ai-canvas-yingce-agent:server -f yingce-agent/Dockerfile .
    log "重启服务栈..."
    docker compose --env-file .env $COMPOSE_FILES up -d --remove-orphans
    ;;
  restart)
    log "重启服务栈..."
    docker compose --env-file .env $COMPOSE_FILES up -d --remove-orphans
    ;;
  status)
    docker compose --env-file .env $COMPOSE_FILES ps
    ;;
  *)
    echo "用法: $0 [pull|build|restart|status]"
    exit 1
    ;;
esac

# restart/build 后等待后端就绪
if [[ "$ACTION" == "build" || "$ACTION" == "restart" ]]; then
  log "等待后端健康检查..."
  for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:8000/api/health/ready >/dev/null 2>&1; then
      log "后端已就绪，部署完成"
      exit 0
    fi
    sleep 2
  done
  log "警告: 后端 60 秒内未就绪，请检查: docker compose $COMPOSE_FILES logs backend"
  exit 1
fi
