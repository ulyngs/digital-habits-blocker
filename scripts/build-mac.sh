#!/bin/bash
# Build the macOS desktop app bundle (.app). Output is
# `for-distribution/Digital Habits Blocker.app`. For a shippable installer, run
# `scripts/build-mac-pkg.sh --release` next (or `npm run build:mac-all`
# for both in one go).

set -euo pipefail

# Source environment variables for signing/notarization if present.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Support the older APPLE_PASSWORD name by mapping it to the variable
# the notarize hook actually reads.
if [ -n "${APPLE_PASSWORD:-}" ] && [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
  export APPLE_APP_SPECIFIC_PASSWORD="${APPLE_PASSWORD}"
fi

# Tauri v2 expects CI to be "true"/"false", not "1"/"0".
TAURI_CI="${CI:-}"
if [ "$TAURI_CI" = "1" ]; then
  TAURI_CI="true"
elif [ "$TAURI_CI" = "0" ]; then
  TAURI_CI="false"
fi

PROJECT_ROOT="$(pwd)"
BUILD_TARGET="${BUILD_MAC_TARGET:-universal-apple-darwin}"

CONFIG_ARGS=()
if [ -n "${APPLE_SIGNING_IDENTITY_OVERRIDE:-}" ]; then
  echo "Using signing identity override: ${APPLE_SIGNING_IDENTITY_OVERRIDE}"
  CONFIG_ARGS=(
    --config
    "{\"bundle\":{\"macOS\":{\"signingIdentity\":\"${APPLE_SIGNING_IDENTITY_OVERRIDE}\"}}}"
  )
fi

CARGO_TARGET_DIR="$(node -e 'process.stdout.write(require("./scripts/build-env").getCargoTargetDir(process.env))')"
export CARGO_TARGET_DIR
TARGET_DIR="${CARGO_TARGET_DIR}/${BUILD_TARGET}/release/bundle"

echo "Building Digital Habits Blocker for macOS (${BUILD_TARGET})..."
# `--bundles app` tells Tauri to produce only the .app, skipping its
# own .dmg target. We distribute via scripts/build-mac-pkg.sh, which
# wraps the .app in a signed .pkg with migration pre/post-install scripts.
CI="${TAURI_CI:-false}" \
npm run tauri -- build --bundles app --target "${BUILD_TARGET}" ${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"}

APP_SOURCE="${TARGET_DIR}/macos/Digital Habits Blocker.app"

mkdir -p for-distribution

if [ -d "$APP_SOURCE" ]; then
  rm -rf "for-distribution/Digital Habits Blocker.app"
  cp -R "$APP_SOURCE" "for-distribution/Digital Habits Blocker.app"
fi

echo ""
echo "Build complete."
if [ -d "for-distribution/Digital Habits Blocker.app" ]; then
  echo "  App: for-distribution/Digital Habits Blocker.app"
fi
echo "  (Run scripts/build-mac-pkg.sh --release for a shippable .pkg.)"
