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
node "$ROOT_DIR/scripts/run-tauri.js" ios build

mkdir -p "$ROOT_DIR/for-distribution"
cp "$ROOT_DIR/src-tauri/gen/apple/build/arm64/Digital Habits Blocker.ipa" "$ROOT_DIR/for-distribution/Digital Habits Blocker.ipa"
echo ""
echo "✅ App Store IPA ready: for-distribution/Digital Habits Blocker.ipa"
echo "   Upload with Transporter or: xcrun altool --upload-app --type ios --file \"for-distribution/Digital Habits Blocker.ipa\" --apiKey \$APPLE_API_KEY_ID --apiIssuer \$APPLE_API_ISSUER"
