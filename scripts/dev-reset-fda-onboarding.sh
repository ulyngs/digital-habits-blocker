#!/usr/bin/env bash
# dev-reset-fda-onboarding.sh — restore "first-time user" state on
# macOS so the FDA onboarding flow can be re-tested against the
# already-installed .app, without having to reinstall the .pkg.
#
# Usage:
#   scripts/dev-reset-fda-onboarding.sh           # default: keep EULA + blocklists
#   scripts/dev-reset-fda-onboarding.sh --eula    # also reset EULA acceptance
#   scripts/dev-reset-fda-onboarding.sh --nuke    # delete everything (incl. blocklists)
#
# Always:
#   - Quits any running ReDD Blocker process.
#   - Resets every TCC consent for `com.reddblock` (FDA + per-prompt
#     data-isolation consents, etc.) so macOS treats the next launch
#     as a brand-new (app, target-container) pair.
#   - Removes our onboarding marker files so the FDA overlay and
#     native-host install both run again.
#   - Deletes the native-messaging manifests from each browser dir so
#     we observe them being installed fresh.
#   - Wipes the tauri-plugin-log file so the next launch's TCC probe
#     trace starts clean.
#
# Optional --eula also wipes EULA acceptance from redd-block-data.json
# so the EULA screen reappears (full first-time flow).
#
# Optional --nuke removes ~/Library/Application Support/com.reddblock
# wholesale (blocklists too — useful for a true "this is a new
# Mac" simulation).

set -euo pipefail

EULA=0
NUKE=0
for arg in "$@"; do
    case "$arg" in
        --eula) EULA=1 ;;
        --nuke) NUKE=1 ;;
        --help|-h)
            head -n 25 "$0" | sed 's|^# \{0,1\}||'
            exit 0
            ;;
        *)
            echo "unknown flag: $arg (try --help)" >&2
            exit 1
            ;;
    esac
done

APP_DATA_DIR="$HOME/Library/Application Support/com.reddblock"
SHARED_DATA_DIR="/var/lib/redd-block"
LOG_DIR="$HOME/Library/Logs/com.reddblock"

echo "==> Quitting any running Digital Habits Blocker / ReDD Blocker process"
pkill -9 -f "Digital Habits Blocker.app/Contents/MacOS/redd-block" 2>/dev/null || true
pkill -9 -f "ReDD Blocker.app/Contents/MacOS/redd-block" 2>/dev/null || true
pkill -9 -x "Digital Habits Blocker" 2>/dev/null || true
pkill -9 -x "ReDD Blocker" 2>/dev/null || true
sleep 0.5

echo "==> Resetting all TCC consents for com.reddblock"
# `tccutil reset All <bundle-id>` clears every per-service decision
# (Full Disk Access, "data from other apps", Accessibility, etc.).
# Safe to re-run; idempotent.
tccutil reset All com.reddblock 2>&1 || echo "  (tccutil exited non-zero — usually means no consents to reset, harmless)"

if [[ "$NUKE" == "1" ]]; then
    echo "==> --nuke: removing entire ${APP_DATA_DIR}"
    rm -rf "$APP_DATA_DIR"
else
    echo "==> Removing onboarding marker files (blocklists preserved)"
    for marker in \
        fda-onboarded.v1 \
        native-host-install.v1 \
        extension-hints-installed.v1 \
        external-uninstalls-scrubbed.v1 \
        native-host-manifest.v1.fingerprint
    do
        if [[ -f "$APP_DATA_DIR/$marker" ]]; then
            rm -f "$APP_DATA_DIR/$marker"
            echo "  removed $marker"
        fi
    done
fi

# Clear welcome / EULA flags from redd-block-data.json. The canonical
# file is the per-user app-data one, but a machine that ran a pre-3.x
# build can still have /var/lib/redd-block — and the app imports from
# there on first launch, which would put the flags straight back. Reset
# both so a relaunch actually starts on the welcome screen.
# (--nuke deletes the per-user dir but shared storage persists.)
clear_onboarding_json_fields() {
    local data_file="$1"
    [[ -f "$data_file" ]] || return 0
    if ! command -v jq >/dev/null 2>&1; then
        echo "  WARNING: jq not installed; could not edit $data_file (install with 'brew install jq')"
        return 0
    fi
    local tmp
    tmp=$(mktemp /tmp/redd-block-data.XXXXXX.json)
    if [[ "$EULA" == "1" ]]; then
        jq 'if .settings then .settings |= (del(.eulaAcceptedRevision) | del(.eulaAcceptedAt) | del(.onboardingComplete) | del(.welcomeOnboardingShown) | if .extra then .extra |= del(.eulaAccepted) | del(.eulaAcceptedAt) | del(.eulaAcceptedRevision) else . end) else . end' \
            "$data_file" > "$tmp"
        echo "  cleared EULA + welcome fields in $data_file"
    else
        jq 'if .settings then .settings |= del(.welcomeOnboardingShown) else . end' \
            "$data_file" > "$tmp"
        echo "  cleared welcomeOnboardingShown in $data_file"
    fi
    if [[ -w "$data_file" ]]; then
        mv "$tmp" "$data_file"
    elif command -v sudo >/dev/null 2>&1; then
        sudo mv "$tmp" "$data_file"
        echo "  (wrote via sudo — $data_file is not user-writable)"
    else
        rm -f "$tmp"
        echo "  WARNING: could not write $data_file (not writable and sudo unavailable)"
    fi
}

for data_file in \
    "$SHARED_DATA_DIR/redd-block-data.json" \
    "$APP_DATA_DIR/redd-block-data.json" \
    "$HOME/Library/Application Support/com.redd.block/redd-block-data.json" \
    "$HOME/Library/Application Support/redd-block/redd-block-data.json"
do
    clear_onboarding_json_fields "$data_file"
done

if [[ "$NUKE" != "1" ]]; then
    fda_marker="$APP_DATA_DIR/fda-onboarded.v1"
    if [[ -f "$fda_marker" ]]; then
        echo "  WARNING: fda-onboarded.v1 still present at $fda_marker (remove failed?)"
    else
        echo "  fda-onboarded.v1 absent (good — cross-app work stays deferred until FDA screen)"
    fi
fi

echo "==> Removing browser native-messaging manifests so install runs fresh"
for manifest in \
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.ulriklyngs.mindshield.json" \
    "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.ulriklyngs.mindshield.json" \
    "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.ulriklyngs.mindshield.json" \
    "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts/com.ulriklyngs.mindshield.json"
do
    if [[ -f "$manifest" ]]; then
        rm -f "$manifest"
        echo "  removed $(basename "$(dirname "$(dirname "$manifest")")")/$(basename "$(dirname "$manifest")")/$(basename "$manifest")"
    fi
done

echo "==> Wiping log file(s)"
for log in "$LOG_DIR/Digital Habits Blocker.log" "$LOG_DIR/ReDD Blocker.log" "$LOG_DIR/ReDD Block.log" "$LOG_DIR/Fristed.log"; do
    if [[ -f "$log" ]]; then
        : > "$log"
        echo "  truncated $log"
    fi
done

cat <<EOF

==> Done. To test the first-time flow:

  1. (In one terminal) follow the log:
       tail -F "$LOG_DIR/Digital Habits Blocker.log" "$LOG_DIR/ReDD Blocker.log" | grep tcc-probe

  2. (Then) rebuild and launch (required — source fixes are not in
     /Applications until you rebuild):
       pnpm tauri build
       open "/Applications/Digital Habits Blocker.app"

  Or for dev:
       pnpm tauri dev

  Expected:
    - Welcome (explains ReDD Focus + FDA on Mac) → EULA (always in
      `pnpm dev`; persisted acceptance reset with --eula) →
      FDA overlay (Mac only, required — no skip).
    - Zero cross-app prompts until FDA is granted.
    - After FDA grant, ReDD Focus is installed in browsers; extension
      setup overlay may follow.
EOF
