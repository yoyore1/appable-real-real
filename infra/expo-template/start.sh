#!/bin/sh
# Container entrypoint: seed the project volume from the golden template on
# first boot, init the checkpoint repo, then run the Expo dev server.
set -e

if [ ! -f /app/package.json ]; then
  echo "[appable] seeding project from golden template..."
  cp -a /template/. /app/
fi

cd /app

if [ ! -d .git ]; then
  git init -q
  git add -A
  git commit -q -m "checkpoint: golden template"
fi

PORT="${EXPO_PORT:-8081}"
echo "[appable] starting expo dev server on port ${PORT}..."
# NOTE: do NOT set CI=1 here - CI mode disables Metro's file watcher, which
# kills hot reload and hides agent-written files from the bundler. The
# container has no TTY, so the Expo CLI is already non-interactive.
exec npx expo start --port "${PORT}" --host lan
