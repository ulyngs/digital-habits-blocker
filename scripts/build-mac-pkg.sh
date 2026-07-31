#!/usr/bin/env bash
# build-mac-pkg.sh — wrap the Tauri-built .app into a signed installer .pkg.
#
# Why: Tauri's built-in `pkg` bundle target is App-Store-oriented and
# doesn't accept custom pre/postinstall scripts. For the v1.x → 2.0
# migration we want a real installer that can stop the old daemon and
# launch the new app at the end. So we let Tauri build the .app /
# .dmg as usual, then wrap the .app with `pkgbuild` + `productbuild`
# here.
#
# Usage:
#   scripts/build-mac-pkg.sh                  # debug build
#   scripts/build-mac-pkg.sh --release        # release build
#
# Env vars (auto-sourced from .env if present):
#   APPLE_DEVELOPER_INSTALLER_IDENTITY  — "Developer ID Installer: ..."
#   APPLE_NOTARIZE_USER, APPLE_NOTARIZE_PASS, APPLE_TEAM_ID  (optional, for notarization)
# If APPLE_DEVELOPER_INSTALLER_IDENTITY is unset, produces an unsigned
# .pkg suitable for local testing only.
#
# Picks up the same BUILD_MAC_TARGET as scripts/build-mac.sh (default
# "universal-apple-darwin") so the .pkg wraps the universal .app.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

# Source .env for signing/notarization creds, like build-mac.sh does.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

CARGO_TARGET_DIR="$(node -e 'process.stdout.write(require("./scripts/build-env").getCargoTargetDir(process.env))')"

PROFILE="debug"
if [[ "${1:-}" == "--release" ]]; then
    PROFILE="release"
fi

APP_NAME="Digital Habits Blocker"
PKG_SLUG="Digital-Habits-Blocker"
BUNDLE_ID="com.reddblock"
SCRIPTS_DIR="scripts/macos-pkg/scripts"

# Match build-mac.sh: universal build by default so the resulting .pkg works on
# both Intel and Apple Silicon. Set BUILD_MAC_TARGET="" to use the legacy
# arch-less path produced by a plain `tauri build` (single arch).
BUILD_TARGET="${BUILD_MAC_TARGET-universal-apple-darwin}"

resolve_bundle_base() {
    local target="$1"
    if [[ -n "$target" ]]; then
        echo "${CARGO_TARGET_DIR}/${target}/${PROFILE}/bundle"
    else
        echo "${CARGO_TARGET_DIR}/${PROFILE}/bundle"
    fi
}

BUNDLE_BASE="$(resolve_bundle_base "$BUILD_TARGET")"
APP_PATH="${BUNDLE_BASE}/macos/${APP_NAME}.app"

# Fall back to the legacy non-target path if the targeted .app is missing
# (e.g. someone ran a plain `tauri build` instead of `npm run build:mac`).
if [[ ! -d "$APP_PATH" && -n "$BUILD_TARGET" ]]; then
    LEGACY_BUNDLE_BASE="${REPO_ROOT}/src-tauri/target/${BUILD_TARGET}/${PROFILE}/bundle"
    if [[ ! -d "$LEGACY_BUNDLE_BASE" ]]; then
        LEGACY_BUNDLE_BASE="${REPO_ROOT}/src-tauri/target/${PROFILE}/bundle"
    fi
    LEGACY_APP_PATH="${LEGACY_BUNDLE_BASE}/macos/${APP_NAME}.app"
    if [[ -d "$LEGACY_APP_PATH" ]]; then
        echo "Note: '${APP_PATH}' missing, falling back to '${LEGACY_APP_PATH}'."
        BUNDLE_BASE="$LEGACY_BUNDLE_BASE"
        APP_PATH="$LEGACY_APP_PATH"
    fi
fi

if [[ ! -d "$APP_PATH" ]]; then
    echo "ERROR: $APP_PATH not found."
    echo "       Run 'npm run build:mac' first (or 'npm run tauri build' for a single-arch dev build)."
    exit 1
fi

# Pull version from tauri.conf.json so the .pkg filename matches.
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
echo "Building .pkg for ${APP_NAME} ${VERSION} (${PROFILE})"

OUT_DIR="${BUNDLE_BASE}/pkg"
mkdir -p "$OUT_DIR"

COMPONENT_PKG="$OUT_DIR/component.pkg"
DIST_PKG="$OUT_DIR/${PKG_SLUG}-${VERSION}.pkg"
DIST_DIR=$(mktemp -d /tmp/redd-block-dist.XXXXXX)
DIST_FILE="$DIST_DIR/distribution.xml"

# Stage the .app inside an OTHERWISE-EMPTY directory before invoking
# pkgbuild --root. The Tauri DMG bundler writes a writable working
# copy of each DMG to bundle/macos/ as `rw.<pid>.<name>.dmg` and only
# deletes it on a clean success — any interrupted build leaves an
# orphan there, and `pkgbuild --root` would happily ship them to
# /Applications alongside the .app on every install. Copying just the
# .app into a clean staging dir means we no longer care what other
# junk Tauri leaves in bundle/macos/.
PKG_ROOT_DIR=$(mktemp -d /tmp/redd-block-pkgroot.XXXXXX)
ditto "$APP_PATH" "$PKG_ROOT_DIR/$(basename "$APP_PATH")"

# Block page assets must be world-readable: Safari loads blocked.html as
# the logged-in user via file://, so mode-600 SVGs show as broken images.
STAGED_APP="$PKG_ROOT_DIR/$(basename "$APP_PATH")"
BLOCKED_RES="$STAGED_APP/Contents/Resources/blocked"
if [[ -d "$BLOCKED_RES" ]]; then
    chmod 644 "$BLOCKED_RES"/* 2>/dev/null || true
fi

# Build a *temporary* scripts dir so we can copy in the shared
# cleanup.sh template alongside preinstall/postinstall — the
# preinstall reads cleanup.sh at runtime via `dirname "$0"/cleanup.sh`.
# Keeping cleanup.sh in src-tauri/src/commands/migration/ as the single
# source of truth (the in-app Rust migration code also include_str!s
# from there) and copying it at build time avoids duplicate
# maintenance.
PKG_SCRIPTS_DIR=$(mktemp -d /tmp/redd-block-pkgscripts.XXXXXX)
cp "$SCRIPTS_DIR"/* "$PKG_SCRIPTS_DIR/"
cp "src-tauri/src/commands/migration/cleanup.sh" "$PKG_SCRIPTS_DIR/cleanup.sh"
chmod 755 "$PKG_SCRIPTS_DIR"/preinstall "$PKG_SCRIPTS_DIR"/postinstall
echo "Bundled scripts in $PKG_SCRIPTS_DIR:"
ls -l "$PKG_SCRIPTS_DIR"

# Generate a component plist with BundleIsRelocatable=false. By default,
# pkgbuild auto-emits a component plist that flags the .app as relocatable
# AND emits a `<relocate>` block in the resulting PackageInfo. macOS
# Installer.app then redirects installs to overwrite any pre-existing copy
# of `com.reddblock` it finds elsewhere on disk (an old build artifact in
# for-distribution/, a copy in Downloads, etc.) instead of installing to
# /Applications. The Installer UI still says "Installation successful" and
# the receipt still claims /Applications, but the bytes go to the stale
# copy — leaving /Applications/Digital Habits Blocker.app missing and the user's new
# launch-at-login plist pointing at a binary that doesn't exist.
# Disabling relocation is the standard fix for non-App-Store .pkg
# installers; pkgbuild --analyze + PlistBuddy is Apple's recommended
# pattern for it.
COMPONENT_PLIST_DIR=$(mktemp -d /tmp/redd-block-cplist.XXXXXX)
COMPONENT_PLIST="$COMPONENT_PLIST_DIR/component.plist"
pkgbuild --analyze --root "$PKG_ROOT_DIR" "$COMPONENT_PLIST" >/dev/null
/usr/libexec/PlistBuddy -c "Set :0:BundleIsRelocatable false" "$COMPONENT_PLIST"
echo "Component plist (post-tweak):"
cat "$COMPONENT_PLIST"

# 1. Component package: just wraps the .app.
pkgbuild \
    --root "$PKG_ROOT_DIR" \
    --component-plist "$COMPONENT_PLIST" \
    --identifier "$BUNDLE_ID.app" \
    --version "$VERSION" \
    --install-location "/Applications" \
    --scripts "$PKG_SCRIPTS_DIR" \
    "$COMPONENT_PKG"

# 2. Distribution definition (XML) — wraps the component package and
#    declares product metadata, minimum OS, etc.
cat > "$DIST_FILE" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>${APP_NAME}</title>
    <organization>${BUNDLE_ID}</organization>
    <domains enable_localSystem="true" />
    <options customize="never" require-scripts="false" rootVolumeOnly="true" />
    <volume-check>
        <allowed-os-versions>
            <os-version min="11.0" />
        </allowed-os-versions>
    </volume-check>
    <choices-outline>
        <line choice="default">
            <line choice="${BUNDLE_ID}.app" />
        </line>
    </choices-outline>
    <choice id="default" />
    <choice id="${BUNDLE_ID}.app" visible="false">
        <pkg-ref id="${BUNDLE_ID}.app" />
    </choice>
    <pkg-ref id="${BUNDLE_ID}.app" version="${VERSION}" onConclusion="none">component.pkg</pkg-ref>
</installer-gui-script>
EOF

# 3. productbuild combines it into the user-facing .pkg.
SIGN_ARGS=()
if [[ -n "${APPLE_DEVELOPER_INSTALLER_IDENTITY:-}" ]]; then
    # Trim accidental whitespace/newlines from CI secrets.
    APPLE_DEVELOPER_INSTALLER_IDENTITY="$(printf '%s' "$APPLE_DEVELOPER_INSTALLER_IDENTITY" | tr -d '\r\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

    # Resolve to a certificate hash when possible — productbuild in CI is more
    # reliable with the 40-char SHA-1 than with the human-readable name.
    RESOLVED_SIGN_IDENTITY="$APPLE_DEVELOPER_INSTALLER_IDENTITY"
    IDENTITY_HASH="$(security find-identity -v 2>/dev/null \
        | grep -F "$APPLE_DEVELOPER_INSTALLER_IDENTITY" \
        | head -1 \
        | sed -E 's/^[[:space:]]*[0-9]+\) ([0-9A-Fa-f]{40}) .*/\1/')"
    if [[ "$IDENTITY_HASH" =~ ^[0-9A-Fa-f]{40}$ ]]; then
        RESOLVED_SIGN_IDENTITY="$IDENTITY_HASH"
        echo "Signing with: $APPLE_DEVELOPER_INSTALLER_IDENTITY"
        echo "  (resolved hash: $RESOLVED_SIGN_IDENTITY)"
    else
        echo "Signing with: $APPLE_DEVELOPER_INSTALLER_IDENTITY"
        echo "  (warning: could not resolve hash from keychain; using name directly)"
        security find-identity -v 2>/dev/null | grep "Developer ID Installer" || true
    fi

    SIGN_ARGS=(--sign "$RESOLVED_SIGN_IDENTITY")
else
    echo "WARNING: APPLE_DEVELOPER_INSTALLER_IDENTITY unset — producing UNSIGNED .pkg (local-test-only)"
fi

productbuild \
    --distribution "$DIST_FILE" \
    --package-path "$OUT_DIR" \
    "${SIGN_ARGS[@]+"${SIGN_ARGS[@]}"}" \
    "$DIST_PKG"

rm -rf "$DIST_DIR" "$PKG_SCRIPTS_DIR" "$COMPONENT_PLIST_DIR" "$PKG_ROOT_DIR"
rm -f "$COMPONENT_PKG"

# 4. Notarization (optional).
if [[ -n "${APPLE_NOTARIZE_USER:-}" && -n "${APPLE_NOTARIZE_PASS:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
    echo "Submitting to notarization service (this may take a few minutes)…"
    xcrun notarytool submit "$DIST_PKG" \
        --apple-id "$APPLE_NOTARIZE_USER" \
        --password "$APPLE_NOTARIZE_PASS" \
        --team-id "$APPLE_TEAM_ID" \
        --wait
    xcrun stapler staple "$DIST_PKG"
    echo "Notarized + stapled."
else
    echo "Skipping notarization (APPLE_NOTARIZE_USER / APPLE_NOTARIZE_PASS / APPLE_TEAM_ID not all set)."
fi

echo
echo "Built: $DIST_PKG"
ls -lh "$DIST_PKG"

# Mirror build-mac.sh: also drop a copy in for-distribution/ so all shippable
# artifacts (.app, .dmg, .pkg) live in one well-known folder.
mkdir -p for-distribution
DIST_PKG_COPY="for-distribution/$(basename "$DIST_PKG")"
cp "$DIST_PKG" "$DIST_PKG_COPY"
echo "Copied to: $DIST_PKG_COPY"
