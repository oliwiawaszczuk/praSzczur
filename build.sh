#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$ROOT/app"
BUNDLE="$APP_DIR/src-tauri/target/release/bundle/macos/praSzczur.app"
DEST="$ROOT/praSzczur.app"

echo "▶ Budowanie aplikacji..."
cd "$APP_DIR"
pnpm tauri build

echo "▶ Kopiowanie praSzczur.app do roota projektu..."
rm -rf "$DEST"
cp -R "$BUNDLE" "$DEST"

echo "✓ Gotowe: $DEST"
