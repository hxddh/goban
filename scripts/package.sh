#!/usr/bin/env bash
# Build frontend dist, compile ReleaseFast, package Goban.app + zip.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PATH="${HOME}/.native/toolchains/zig-0.16.0:${PATH}"

echo "==> sync frontend/dist from src/web"
rm -rf frontend/dist
mkdir -p frontend/dist/js
cp src/web/index.html frontend/dist/
cp src/web/styles.css frontend/dist/
cp src/web/js/*.js frontend/dist/js/
# sanity: required files
test -f frontend/dist/index.html
test -f frontend/dist/js/app.js
test -f frontend/dist/js/core.js
test -f frontend/dist/js/host.js
test -f frontend/dist/js/state.js
test -f frontend/dist/js/draw.js
test -f frontend/dist/js/ai.js
test -f frontend/dist/js/ai-worker.js

echo "==> unit tests"
node scripts/test-game.mjs

echo "==> AI strength regression (self-play, ~15-30s; skip: SKIP_STRENGTH=1)"
if [[ "${SKIP_STRENGTH:-0}" != "1" ]]; then
  node scripts/test-strength.mjs
fi

echo "==> zig build -Doptimize=ReleaseFast"
zig build -Doptimize=ReleaseFast

echo "==> native package"
mkdir -p dist
rm -rf dist/Goban.app
native package --target macos --signing adhoc --output dist/Goban.app --binary zig-out/bin/goban

echo "==> zip + remove package .app (avoid duplicate Launchpad entry)"
(
  cd dist
  rm -f Goban-macOS-arm64.zip
  ditto -c -k --sequesterRsrc --keepParent Goban.app Goban-macOS-arm64.zip
  rm -rf Goban.app
  ls -lh Goban-macOS-arm64.zip
)

echo "==> install ~/Applications/Goban.app"
rm -rf "${HOME}/Applications/Goban.app"
# re-extract zip for install (we deleted .app)
unzip -q -o dist/Goban-macOS-arm64.zip -d dist
ditto dist/Goban.app "${HOME}/Applications/Goban.app"
rm -rf dist/Goban.app

echo "OK: ${HOME}/Applications/Goban.app"
echo "    dist/Goban-macOS-arm64.zip"
