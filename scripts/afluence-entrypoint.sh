#!/bin/sh
set -eu

node /app/scripts/render-afluence-config.mjs
exec docker-entrypoint.sh "$@"
