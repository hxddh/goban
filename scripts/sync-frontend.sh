#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
rm -rf "$ROOT/frontend/dist"
mkdir -p "$ROOT/frontend/dist/js"
cp "$ROOT/src/web/index.html" "$ROOT/frontend/dist/"
cp "$ROOT/src/web/styles.css" "$ROOT/frontend/dist/"
cp "$ROOT/src/web/js/"*.js "$ROOT/frontend/dist/js/"
# Packaged zero:// cannot fetch classic worker scripts — embed sources the
# same way package.sh / CI do, or AI permanently degrades after sync-only.
node "$ROOT/scripts/gen-worker-src.mjs"
# 工具链戳:哪个 SDK / zig 造的这份产物(见 scripts/build-info.mjs 顶部)
node "$ROOT/scripts/build-info.mjs"
echo "synced src/web → frontend/dist (+ worker-src.js + build-info.json)"
