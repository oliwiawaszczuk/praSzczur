#!/usr/bin/env bash
# Uruchamia praSzczur w trybie dev (hot-reload frontend + Tauri)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/app"

echo "▶ praSzczur dev mode (Ctrl+C aby zatrzymać)"
pnpm tauri dev
