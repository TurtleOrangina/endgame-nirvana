#!/usr/bin/env bash
set -euo pipefail
HOST_UID="${HOST_UID:-1000}"
HOST_GID="${HOST_GID:-1000}"

groupmod -g "$HOST_GID" node
usermod  -u "$HOST_UID" -g "$HOST_GID" node

chown node:node /workspace/frontend/node_modules

exec gosu node "$@"
