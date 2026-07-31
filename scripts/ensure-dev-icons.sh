#!/usr/bin/env bash
# Regenerate macOS bundle icons when the source SVG changes, then rebuild
# the debug binary so `tauri dev` picks up the new icon.icns (embedded at
# compile time for the Dock / app switcher on macOS).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVG="$ROOT/assets/reddblock-icon.svg"
ICNS="$ROOT/src-tauri/icons/icon.icns"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${REDD_BLOCK_CARGO_TARGET_DIR:-${REDD_BLOCK_BUILD_CACHE_DIR:-$HOME/Library/Caches/Digital Habits Blocker/build-cache}/cargo-target}}"
BIN="$CARGO_TARGET_DIR/debug/redd-block"

if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

if [[ ! -f "$SVG" ]]; then
  echo "ensure-dev-icons: missing $SVG" >&2
  exit 1
fi

if [[ ! -f "$ICNS" || "$SVG" -nt "$ICNS" ]]; then
  echo "ensure-dev-icons: regenerating icons from SVG…"
  node "$ROOT/scripts/generate-icons-from-svg.js"
fi

if [[ ! -f "$BIN" || "$ICNS" -nt "$BIN" ]]; then
  echo "ensure-dev-icons: rebuilding debug binary for updated icon.icns…"
  (cd "$ROOT/src-tauri" && CARGO_TARGET_DIR="$CARGO_TARGET_DIR" cargo build -q)
fi
