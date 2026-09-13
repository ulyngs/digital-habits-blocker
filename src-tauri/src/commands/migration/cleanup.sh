#!/bin/bash
# Bundled elevated cleanup for the v1.x → 2.0 migration on macOS.
#
# Loaded by Rust via `include_str!` and templated with two paths:
#   {STAGED}  — temp file holding the cleaned hosts content
#   {STATUS}  — temp file we write "ok" to on success (Rust gates on it)
#
# DO NOT add other template placeholders without updating
# run_elevated_macos in commands/migration.rs to substitute them.
#
# Run inside `osascript do shell script "..." with administrator
# privileges`. set -e ensures any failed gate aborts before any
# destructive step. Status marker is written ONLY at the very end.
#
# Numbered exit codes (so log surfaces *which* gate failed):
#   11  daemon still registered after bootout
#   12  post-write hosts missing localhost
#   13  post-write hosts still contains markers
#   14  daemon file still present after rm

set -e

# 1. Validate the staged cleaned content one more time before doing
#    anything destructive.
test -s '{STAGED}'
grep -q localhost '{STAGED}'

# 2. STOP the daemon FIRST so it can't race us by re-adding markers
#    to the hosts file. bootout returns immediately, so we poll
#    launchd's own registry until it confirms the service is gone
#    (10 s ceiling). We use launchctl as the authoritative signal —
#    pgrep against the process name is unreliable here because our
#    script's own command line literally contains the helper path
#    string.
launchctl bootout system/com.redd.block.helper 2>/dev/null || true
launchctl bootout system/org.reddfocus.redd-block-helper 2>/dev/null || true
launchctl unload /Library/LaunchDaemons/com.redd.block.helper.plist 2>/dev/null || true
for i in 1 2 3 4 5 6 7 8 9 10; do
    if ! launchctl print system/com.redd.block.helper >/dev/null 2>&1; then
        break
    fi
    sleep 1
done
# Final hard check + 1 s settle so any in-flight signal handlers in
# the daemon finish their last writes before we touch hosts.
if launchctl print system/com.redd.block.helper >/dev/null 2>&1; then
    echo "daemon still registered after bootout" >&2
    exit 11
fi
sleep 1

# 3. Atomic rename onto /etc/hosts via a UNIQUE temp file (avoid
#    collision if two migration runs race).
TMP=$(mktemp /etc/hosts.redd-tmp.XXXXXX)
cp '{STAGED}' "$TMP"
chown root:wheel "$TMP" 2>/dev/null || true
chmod 644 "$TMP"
mv "$TMP" /etc/hosts

# 4. VERIFY the write actually landed — defence against weird FS
#    behaviour.
grep -q localhost /etc/hosts || { echo "post-write hosts missing localhost" >&2; exit 12; }
if grep -qE '^# === BEGIN REDD BLOCK|^# ReDD Block Start' /etc/hosts; then
    echo "post-write hosts still contains markers" >&2
    exit 13
fi

# 5. Flush DNS so the cleaned hosts file takes effect immediately.
dscacheutil -flushcache 2>/dev/null || true
killall -HUP mDNSResponder 2>/dev/null || true

# 6. ONLY NOW remove the daemon's persistent state. Hosts is clean,
#    daemon is stopped — safe to make the removal permanent.
#
#    CRITICAL: do NOT `rm -rf /var/lib/redd-block` blindly. The new
#    app no longer writes there, but it still imports the user's
#    blocklist data (redd-block-data.json) out of it into their own
#    per-user store — see commands/data.rs::import_shared_data_into_per_user.
#    Deleting it before every account on the machine has launched the
#    new build loses their blocklists. We only delete the
#    daemon-specific files and leave the data file + directory in place.
rm -f /Library/LaunchDaemons/com.redd.block.helper.plist
rm -f /Library/LaunchDaemons/org.reddfocus.redd-block-helper.plist
rm -f /Library/PrivilegedHelperTools/com.redd.block.helper
rm -f /var/lib/redd-block/helper-state.json
rm -f /tmp/redd-block-helper.sock

# 7. VERIFY removal — `rm -f` is silent if the file is held open or
#    on a read-only mount. We re-stat to be sure. Note: we don't
#    check /var/lib/redd-block itself; it intentionally stays.
for f in /Library/LaunchDaemons/com.redd.block.helper.plist \
         /Library/LaunchDaemons/org.reddfocus.redd-block-helper.plist \
         /Library/PrivilegedHelperTools/com.redd.block.helper \
         /var/lib/redd-block/helper-state.json; do
    if [ -e "$f" ]; then
        echo "failed to remove $f" >&2
        exit 14
    fi
done

# 8. INTENTIONALLY KEEP /etc/hosts.redd-backup. Last-resort recovery
#    copy. Only deleted during uninstall (see purge_legacy_backups_sync).

# 9. Reset any stale Full Disk Access (TCC) entries for com.reddblock so
#    v2.0 registers cleanly under its current code-signature
#    requirement. TCC keys entries on the signature requirement, not
#    just bundle id, so a previous build (e.g. a beta signed with a
#    different identity) can shadow the new entry and prevent the app
#    from showing up in System Settings → Privacy & Security → Full
#    Disk Access. Harmless if no entry exists. Best-effort: failure
#    here must not abort migration, hence `|| true`.
tccutil reset SystemPolicyAllFiles com.reddblock 2>/dev/null || true

# 10. Status marker — written only if every gate above passed.
echo 'ok' > '{STATUS}'
