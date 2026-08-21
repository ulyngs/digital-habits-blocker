import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SYSTEM_TEST_PRODUCT_NAME = 'Digital Habits Blocker Test';
export const SYSTEM_TEST_BUNDLE_ID = 'com.reddblock.systemtest';
export const SYSTEM_TEST_ROOT_NAME = 'Digital Habits Blocker System Test';

export function repoRootFrom(url) {
  return path.resolve(path.dirname(new URL(url).pathname), '..');
}

export function defaultSystemTestPaths(env = process.env) {
  const home = env.HOME || os.homedir();
  const expectedRoot = path.resolve(path.join(
    home,
    'Library',
    'Application Support',
    SYSTEM_TEST_ROOT_NAME,
  ));
  const root = path.resolve(env.SYSTEM_TEST_ROOT || expectedRoot);
  if (root !== expectedRoot) {
    throw new Error(`SYSTEM_TEST_ROOT override is not supported; expected ${expectedRoot}`);
  }
  const runId = env.SYSTEM_TEST_RUN_ID || `${Date.now()}-${process.pid}`;
  const expectedAppPath = path.resolve(path.join(home, 'Applications', `${SYSTEM_TEST_PRODUCT_NAME}.app`));
  const appPath = path.resolve(env.SYSTEM_TEST_APP || expectedAppPath);
  if (appPath !== expectedAppPath) {
    throw new Error(`SYSTEM_TEST_APP override is not supported; expected ${expectedAppPath}`);
  }
  return {
    root,
    dataDir: path.resolve(env.SYSTEM_TEST_DATA_DIR || path.join(root, 'data')),
    profileDir: path.resolve(env.SYSTEM_TEST_PROFILE_DIR || path.join(root, 'brave-profile')),
    artifactsDir: path.resolve(env.SYSTEM_TEST_ARTIFACTS_DIR || path.join(root, 'artifacts', runId)),
    appPath,
    appPid: env.SYSTEM_TEST_APP_PID ? Number(env.SYSTEM_TEST_APP_PID) : null,
    bravePort: Number(env.SYSTEM_TEST_BRAVE_PORT || 9229),
  };
}

export function dataFileFor(paths) {
  // The Rust resolver returns the value of REDD_BLOCK_SYSTEM_TEST_DATA_PATH
  // directly, so the public runner variable remains the containing directory.
  return path.join(paths.dataDir, 'redd-block-data.json');
}

export function ensureMac() {
  if (process.platform !== 'darwin') {
    throw new Error('The macOS system-test harness only runs on macOS.');
  }
}

export function discoverAppleDevelopmentIdentity(env = process.env) {
  if (env.APPLE_SIGNING_IDENTITY_OVERRIDE?.trim()) {
    return env.APPLE_SIGNING_IDENTITY_OVERRIDE.trim();
  }

  let output;
  try {
    output = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error?.stderr?.toString?.().trim();
    throw new Error(
      `Unable to inspect the macOS signing identities${detail ? `: ${detail}` : '.'}`,
      { cause: error },
    );
  }

  const identities = [...output.matchAll(/"([^"]*Apple Development:[^"]*)"/g)]
    .map((match) => match[1])
    .filter((identity) => !identity.includes('CSSMERR_TP_CERT_REVOKED'));
  if (identities.length === 0) {
    throw new Error(
      'No usable Apple Development signing identity found. Set APPLE_SIGNING_IDENTITY_OVERRIDE ' +
      'or install an Apple Development certificate with its private key.',
    );
  }
  return identities[0];
}

export function walkDirectories(root) {
  const output = [];
  if (!existsSync(root)) return output;
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      output.push(full);
    }
  }
  return output;
}

export function findBundledApp(targetDir, startedAt = 0) {
  const candidates = walkDirectories(targetDir)
    .filter((candidate) => candidate.endsWith(`${SYSTEM_TEST_PRODUCT_NAME}.app`))
    .filter((candidate) => existsSync(path.join(candidate, 'Contents', 'MacOS')))
    .filter((candidate) => {
      try {
        return statSync(candidate).mtimeMs >= startedAt - 2_000;
      } catch {
        return false;
      }
    });
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] || null;
}

export function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function assertSafeSystemTestPath(paths, target, label) {
  if (!isWithin(paths.root, target)) {
    throw new Error(`${label} must stay below SYSTEM_TEST_ROOT (${paths.root}): ${target}`);
  }
  let cursor = path.resolve(target);
  while (cursor !== paths.root) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`${label} must not traverse a symlink: ${cursor}`);
    }
    cursor = path.dirname(cursor);
  }
}

function parseJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse production data at ${filePath}: ${error.message}`, { cause: error });
  }
}

export function productionDataPath(env = process.env) {
  if (env.REDD_BLOCK_PRODUCTION_DATA_PATH?.trim()) {
    return path.resolve(env.REDD_BLOCK_PRODUCTION_DATA_PATH);
  }

  const home = env.HOME || os.homedir();
  const sharedDir = '/var/lib/redd-block';
  // This mirrors the desktop resolver's shared-storage preference: an
  // existing shared directory is canonical even before its data file exists.
  const sharedData = path.join(sharedDir, 'redd-block-data.json');
  const sharedHelper = path.join(sharedDir, 'helper-state.json');
  let sharedWritable = false;
  if (existsSync(sharedDir)) {
    try {
      accessSync(sharedDir, constants.W_OK);
      sharedWritable = true;
    } catch {}
  }
  if (existsSync(sharedData) || existsSync(sharedHelper) || sharedWritable) return sharedData;
  return path.join(home, 'Library', 'Application Support', 'com.reddblock', 'redd-block-data.json');
}

function productionAppRunning() {
  try {
    const listing = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    return listing.split('\n').some((line) => {
      const command = line.trim();
      return command.includes('/Digital Habits Blocker.app/Contents/MacOS/')
        && !command.includes(`${SYSTEM_TEST_PRODUCT_NAME}.app/Contents/MacOS/`);
    });
  } catch {
    return false;
  }
}

function mondayIndex(date) {
  return (date.getDay() + 6) % 7;
}

function occurrenceOverlaps(start, end, from, until) {
  return end > from && start < until;
}

function segmentWindow(schedule, segment, from, until) {
  if (!segment || !Array.isArray(segment.days)) return [];
  const startHour = Number(segment.startHour);
  const startMinute = Number(segment.startMinute);
  const endHour = Number(segment.endHour);
  const endMinute = Number(segment.endMinute);
  if (![startHour, startMinute, endHour, endMinute].every(Number.isFinite)) return null;
  if (![startHour, endHour].every((value) => value >= 0 && value <= 23)
    || ![startMinute, endMinute].every((value) => value >= 0 && value <= 59)) return null;

  const windows = [];
  const repeat = schedule.repeatType === 'forever' || (schedule.repeatType === 'date' && schedule.repeatDate);
  if (!repeat) {
    const created = new Date(schedule.createdAt || NaN);
    if (!Number.isFinite(created.getTime())) return null;
    const createdDay = mondayIndex(created);
    for (const day of segment.days) {
      if (!Number.isInteger(day) || day < 0 || day > 6) continue;
      let daysUntil = day - createdDay;
      if (daysUntil < 0) daysUntil += 7;
      const start = new Date(created);
      start.setDate(start.getDate() + daysUntil);
      start.setHours(startHour, startMinute, 0, 0);
      const end = new Date(start);
      end.setHours(endHour, endMinute, 0, 0);
      if (end <= start) end.setDate(end.getDate() + 1);
      windows.push([start.getTime(), end.getTime()]);
    }
    return windows;
  }

  const firstDay = new Date(from);
  firstDay.setHours(0, 0, 0, 0);
  firstDay.setDate(firstDay.getDate() - 1);
  const lastDay = new Date(until);
  lastDay.setHours(0, 0, 0, 0);
  lastDay.setDate(lastDay.getDate() + 1);
  for (const dayDate = new Date(firstDay); dayDate <= lastDay; dayDate.setDate(dayDate.getDate() + 1)) {
    if (!segment.days.includes(mondayIndex(dayDate))) continue;
    const start = new Date(dayDate);
    start.setHours(startHour, startMinute, 0, 0);
    const end = new Date(start);
    end.setHours(endHour, endMinute, 0, 0);
    if (end <= start) end.setDate(end.getDate() + 1);
    if (schedule.repeatType === 'date' && schedule.repeatDate) {
      const repeatEnd = new Date(schedule.repeatDate);
      if (Number.isNaN(repeatEnd.getTime())) return null;
      repeatEnd.setHours(23, 59, 59, 999);
      if (start > repeatEnd) continue;
    }
    windows.push([start.getTime(), end.getTime()]);
  }
  return windows;
}

function scheduleWindows(schedule, from, until) {
  if (!Array.isArray(schedule?.segments) || schedule.segments.length === 0) return [];
  const windows = [];
  for (const segment of schedule.segments) {
    const segmentWindows = segmentWindow(schedule, segment, from, until);
    if (segmentWindows === null) return null;
    windows.push(...segmentWindows);
  }
  return windows;
}

export function inspectProductionState(env = process.env, now = Date.now()) {
  const dataPath = productionDataPath(env);
  if (!existsSync(dataPath)) {
    return { dataPath, productionRunning: productionAppRunning(), violations: [] };
  }
  const data = parseJsonFile(dataPath);
  const horizonMs = Math.max(1, Number(env.SYSTEM_TEST_HORIZON_SECONDS || 600)) * 1000;
  const horizonEnd = now + horizonMs;
  const blocklists = new Map((Array.isArray(data.blocklists) ? data.blocklists : []).map((entry) => [entry?.id, entry]));
  const violations = [];
  const activeBlocks = Array.isArray(data.activeBlocks) ? data.activeBlocks : [];

  for (const block of activeBlocks) {
    const start = Number.isFinite(Number(block?.startTime)) ? Number(block.startTime) : now;
    const end = Number.isFinite(Number(block?.endTime)) ? Number(block.endTime) : Infinity;
    const pauseEnd = block?.isPaused && Number.isFinite(Number(block.pauseEndTime))
      ? Number(block.pauseEndTime)
      : now;
    if (end > Math.max(now, pauseEnd) && start < horizonEnd) {
      violations.push(`one-off block ${block?.id || '(unknown)'} is active or may activate during the test horizon`);
      if (blocklists.get(block?.blocklistId)?.mode === 'allowlist' && pauseEnd <= now) {
        violations.push(`allowlist ${block?.blocklistId || '(unknown)'} is active`);
      }
    }
  }

  const schedules = Array.isArray(data.schedules) ? data.schedules : [];
  for (const schedule of schedules) {
    const windows = scheduleWindows(schedule, new Date(now), new Date(horizonEnd));
    if (windows === null) {
      violations.push(`schedule ${schedule?.id || '(unknown)'} has malformed timing data`);
      continue;
    }
    const pauseEnd = schedule?.isPaused && Number.isFinite(Number(schedule.pauseEndTime))
      ? Number(schedule.pauseEndTime)
      : now;
    if (windows.some(([start, end]) => occurrenceOverlaps(Math.max(start, pauseEnd), end, now, horizonEnd))) {
      violations.push(`schedule ${schedule?.id || '(unknown)'} is active or may activate during the test horizon`);
      if (blocklists.get(schedule?.blocklistId)?.mode === 'allowlist' && pauseEnd <= now) {
        violations.push(`allowlist schedule ${schedule?.id || '(unknown)'} is active`);
      }
    }
  }

  const productionRunning = productionAppRunning();
  if (productionRunning && data.settings?.enforcementEnabled === true) {
    violations.push('production enforcementEnabled is true while the production app is running');
  }
  return { dataPath, productionRunning, violations };
}

export function assertProductionSafe(env = process.env) {
  const state = inspectProductionState(env);
  if (state.violations.length > 0) {
    throw new Error(
      `Production preflight refused system tests for ${state.dataPath}:\n` +
      state.violations.map((violation) => `  - ${violation}`).join('\n'),
    );
  }
  console.log(`[system-test] production preflight OK (${state.dataPath})`);
  return state;
}

export function assertProductionBrowserCompatible(testHosts, env = process.env) {
  const state = inspectProductionState(env);
  const unsafe = state.violations.filter((violation) =>
    !/^one-off block .* is active or may activate during the test horizon$/.test(violation)
    && !/^schedule .* is active or may activate during the test horizon$/.test(violation));
  if (unsafe.length > 0) {
    throw new Error(
      `Production preflight refused shared-Brave system tests for ${state.dataPath}:\n` +
      unsafe.map((violation) => `  - ${violation}`).join('\n'),
    );
  }
  if (existsSync(state.dataPath)) {
    const data = parseJsonFile(state.dataPath);
    const fixtureHosts = new Set(testHosts.map((host) => String(host).toLowerCase()));
    const overlap = (Array.isArray(data.blocklists) ? data.blocklists : [])
      .flatMap((blocklist) => Array.isArray(blocklist?.websites) ? blocklist.websites : [])
      .map((host) => String(host).toLowerCase())
      .filter((host) => fixtureHosts.has(host));
    if (overlap.length > 0) {
      throw new Error(`Production blocklists overlap system-test hosts: ${[...new Set(overlap)].join(', ')}`);
    }
  }
  console.log(`[system-test] shared-Brave production preflight OK (${state.dataPath})`);
  return state;
}
