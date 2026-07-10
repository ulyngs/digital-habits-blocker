#!/usr/bin/env node
// Convert a Cold Turkey Blocker .ctbbl export into redd-block blocklists + schedules.
//
// Usage:
//   node scripts/import-ctbbl.js <file.ctbbl>                  # print converted JSON to stdout
//   node scripts/import-ctbbl.js <file.ctbbl> --merge <data.json>  # merge into redd-block-data.json (writes .bak)
//
// CTBBL day numbering: Sun=0..Sat=6. redd-block: Mon=0..Sun=6.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

// TEST MODE: forces every imported blocklist to overrideDifficulty.count = 1
// (1-char unlock challenge) so blocks are easy to dismiss during testing.
// Flip to false to use CTBBL's randomTextLength as-is.
const TEST_MODE_LOW_DIFFICULTY = true;

const APP_BUNDLE_ID = 'com.reddblock';
// Binary name (lowercase) — the productName "ReDD Block" is the .app bundle name,
// but the running executable inside is `redd-block`.
const APP_PROCESS_PATTERN = '/ReDD Block.app/Contents/MacOS/redd-block';

function findAppPids() {
    if (process.platform !== 'darwin') return [];
    try {
        const out = execFileSync('pgrep', ['-f', APP_PROCESS_PATTERN], { encoding: 'utf8' });
        return out.trim().split('\n').filter(Boolean).map(Number);
    } catch {
        return [];
    }
}

function killApp() {
    // SIGKILL directly — a graceful quit would let the app save its stale in-memory
    // state and clobber the merge we're about to write.
    const pids = findAppPids();
    if (pids.length === 0) return;
    try { execFileSync('kill', ['-9', ...pids.map(String)], { stdio: 'ignore' }); } catch {}
}

function startApp() {
    if (process.platform !== 'darwin') return;
    try {
        const child = spawn('open', ['-b', APP_BUNDLE_ID], { detached: true, stdio: 'ignore' });
        child.unref();
    } catch {}
}

const CTBBL_TO_REDD_DAY = (d) => (d + 6) % 7;

function parseTime(str) {
    const [day, hour, minute] = str.split(',').map(Number);
    return { day, hour, minute };
}

function parseRandomTextLength(str) {
    // CTBBL format: "300,words,show,keep,". The leading number is a character count
    // (matches redd-block's overrideDifficulty.count semantics, which is also a char target).
    if (typeof str !== 'string') return null;
    const n = parseInt(str.split(',')[0], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function parseAppToken(token) {
    // Format: "app:Name.app:bundle.id" — keep filename stem to match the picker.
    const parts = token.split(':');
    if (parts[0] === 'app' && parts[1]) {
        return parts[1].replace(/\.app$/i, '');
    }
    return token;
}

function newId() {
    return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function convertSchedule(ctbblSchedule) {
    // Each CTBBL entry is one window: {startTime, endTime}. Group by (startH, startM, endH, endM)
    // so identical windows across multiple days collapse into one segment with days[].
    const groups = new Map();
    for (const entry of ctbblSchedule) {
        const s = parseTime(entry.startTime);
        const e = parseTime(entry.endTime);
        // The window is anchored on its start day. redd-block wraps overnight if end <= start.
        const reddDay = CTBBL_TO_REDD_DAY(s.day);
        const key = `${s.hour}:${s.minute}-${e.hour}:${e.minute}`;
        if (!groups.has(key)) {
            groups.set(key, {
                startHour: s.hour,
                startMinute: s.minute,
                endHour: e.hour,
                endMinute: e.minute,
                days: [],
            });
        }
        const seg = groups.get(key);
        if (!seg.days.includes(reddDay)) seg.days.push(reddDay);
    }
    return Array.from(groups.values()).map((seg) => ({
        ...seg,
        days: seg.days.sort((a, b) => a - b),
    }));
}

function convert(ctbbl) {
    const blocklists = [];
    const schedules = [];
    const now = Math.floor(Date.now() / 1000);

    for (const [name, cfg] of Object.entries(ctbbl)) {
        const blocklistId = newId();
        const blocklist = {
            id: blocklistId,
            name,
            mode: 'block',
            websites: Array.isArray(cfg.web) ? [...cfg.web] : [],
            apps: Array.isArray(cfg.apps) ? cfg.apps.map(parseAppToken) : [],
            showItemDetails: true,
        };

        const charCount = TEST_MODE_LOW_DIFFICULTY ? 1 : parseRandomTextLength(cfg.randomTextLength);
        if (charCount !== null) {
            blocklist.overrideDifficulty = { type: 'random-words', count: charCount };
        }

        blocklists.push(blocklist);

        const segments = Array.isArray(cfg.schedule) ? convertSchedule(cfg.schedule) : [];
        if (segments.length > 0) {
            schedules.push({
                id: newId(),
                blocklistId,
                segments,
                // 'forever' = weekly recurrence with no end date. Anything else gets pruned
                // by the app's expired-schedule sweep (app.js:1782) when there's no upcoming one-shot.
                repeatType: 'forever',
                createdAt: now,
            });
        }
    }

    return { blocklists, schedules };
}

function main() {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: import-ctbbl.js <file.ctbbl> [--merge <redd-block-data.json>]');
        process.exit(1);
    }

    const ctbblPath = args[0];
    const mergeIdx = args.indexOf('--merge');
    const mergePath = mergeIdx >= 0 ? args[mergeIdx + 1] : null;

    const ctbbl = JSON.parse(fs.readFileSync(ctbblPath, 'utf8'));
    const converted = convert(ctbbl);

    if (!mergePath) {
        console.log(JSON.stringify(converted, null, 2));
        return;
    }

    const wasRunning = findAppPids().length > 0;
    if (wasRunning) {
        console.error('Force-killing ReDD Block (avoid stale-state save)…');
        killApp();
    }

    const existing = JSON.parse(fs.readFileSync(mergePath, 'utf8'));
    fs.copyFileSync(mergePath, mergePath + '.bak');

    existing.blocklists = (existing.blocklists || []).concat(converted.blocklists);
    existing.schedules = (existing.schedules || []).concat(converted.schedules);

    fs.writeFileSync(mergePath, JSON.stringify(existing, null, 2));
    console.error(
        `Merged ${converted.blocklists.length} blocklists and ${converted.schedules.length} schedules into ${mergePath} (backup at ${path.basename(mergePath)}.bak)`
    );

    if (wasRunning) {
        console.error('Restarting ReDD Block…');
        startApp();
    }
}

main();
