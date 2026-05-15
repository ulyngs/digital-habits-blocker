#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PATH="$ROOT_DIR/scripts:$PATH" \
APPLE_DEVELOPMENT_TEAM=JD647S9RT6 \
tauri ios dev --host "$@"
