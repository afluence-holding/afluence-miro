#!/bin/sh
set -eu

node /app/scripts/render-afluence-config.mjs
exec node /app/dist/main.js
