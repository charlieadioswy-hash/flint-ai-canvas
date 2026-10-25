#!/usr/bin/env bash
# Install this fixed entry point as /home/dev/deploy-flint-dev.sh.
set -Eeuo pipefail
umask 077

deployment_state=/home/dev/.flint-deploy
exec sudo -n flock "$deployment_state/publish.lock" \
  python3 "$deployment_state/runner.py" "$@"
