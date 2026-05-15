#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
EXPORT_DIR="$ROOT_DIR/src-tauri/gen/apple"
ACTIVE="$EXPORT_DIR/ExportOptions.plist"
STORE="$EXPORT_DIR/ExportOptions.store.plist"

cleanup() {
  git -C "$ROOT_DIR" checkout -- "$ACTIVE" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

cp "$STORE" "$ACTIVE"

PATH="$ROOT_DIR/scripts:$PATH" \
APPLE_DEVELOPMENT_TEAM=JD647S9RT6 \
npx tauri ios build

mkdir -p "$ROOT_DIR/for-distribution"
cp "$ROOT_DIR/src-tauri/gen/apple/build/arm64/ReDD Block.ipa" "$ROOT_DIR/for-distribution/ReDD Block.ipa"
echo ""
echo "✅ App Store IPA ready: for-distribution/ReDD Block.ipa"
echo "   Upload with Transporter or: xcrun altool --upload-app --type ios --file \"for-distribution/ReDD Block.ipa\" --apiKey \$APPLE_API_KEY_ID --apiIssuer \$APPLE_API_ISSUER"
