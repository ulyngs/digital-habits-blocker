#!/usr/bin/env node
/**
 * Run the Tauri CLI with repo-root .env loaded (Windows signing needs AZURE_*).
 * Usage: node scripts/run-tauri.js build --target x86_64-pc-windows-msvc ...
 */
const { spawnSync } = require('child_process');
const path = require('path');
const { loadDotenv } = require('./load-dotenv');
const { getBuildEnvironment } = require('./build-env');

const repoRoot = path.join(__dirname, '..');
const { count, path: envPath, missing } = loadDotenv(repoRoot);

if (missing) {
  console.warn(`[run-tauri] No .env at ${envPath} — Azure signing will be skipped unless vars are in the shell environment.`);
} else if (count === 0) {
  console.warn(`[run-tauri] .env exists but no variables loaded from ${envPath}`);
} else {
  console.log(`[run-tauri] Loaded ${count} variable(s) from .env`);
}

const args = ['tauri', ...process.argv.slice(2)];
const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const result = spawnSync(cmd, args, {
  cwd: repoRoot,
  env: getBuildEnvironment(process.env),
  stdio: 'inherit',
  shell: true,
});

process.exit(result.status === null ? 1 : result.status);
