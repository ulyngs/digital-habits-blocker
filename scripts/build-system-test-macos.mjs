#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCargoTargetDir } from './build-env.js';
import {
  discoverAppleDevelopmentIdentity,
  ensureMac,
  findBundledApp,
} from './system-test-common.mjs';

ensureMac();

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const configPath = path.join(repoRoot, 'src-tauri', 'tauri.system-test.conf.json');
const targetDir = getCargoTargetDir(process.env);
const startedAt = Date.now();
const identity = discoverAppleDevelopmentIdentity(process.env);
const buildTarget = process.env.SYSTEM_TEST_BUILD_TARGET?.trim() || null;
const generatedConfigDir = mkdtempSync(path.join(repoRoot, 'src-tauri', '.system-test-config-'));
const generatedConfigPath = path.join(generatedConfigDir, 'tauri.system-test.generated.json');
const checkedConfig = JSON.parse(readFileSync(configPath, 'utf8'));
const source = (relativePath) => path.join(repoRoot, 'src-tauri', relativePath);
// Generate one complete config for this invocation. Tauri's config merge is
// intentionally not used: this avoids a production/base config silently
// supplying an identifier, App Group, or beforeBuildCommand.
checkedConfig.build.frontendDist = path.join(repoRoot, 'dist');
checkedConfig.bundle.resources = {
  [source('blocked/blocked.html')]: 'blocked/blocked.html',
  [source('blocked/blocked.js')]: 'blocked/blocked.js',
  [source('blocked/reddblock-icon.svg')]: 'blocked/reddblock-icon.svg',
};
checkedConfig.bundle.icon = checkedConfig.bundle.icon.map((entry) => source(entry));
checkedConfig.bundle.macOS.entitlements = source(checkedConfig.bundle.macOS.entitlements);
checkedConfig.bundle.macOS.infoPlist = source(checkedConfig.bundle.macOS.infoPlist);
checkedConfig.bundle.macOS.frameworks = checkedConfig.bundle.macOS.frameworks.map((entry) => source(entry));
checkedConfig.bundle.macOS.signingIdentity = identity;
writeFileSync(generatedConfigPath, `${JSON.stringify(checkedConfig, null, 2)}\n`);
const args = [
  'tauri',
  'build',
  '--debug',
  '--bundles',
  'app',
  '--features',
  'system-test,e2e-webdriver',
  '--config',
  generatedConfigPath,
];
if (buildTarget) args.push('--target', buildTarget);

console.log(`[system-test] signing identity: ${identity}`);
console.log(`[system-test] config: ${configPath}`);
console.log(`[system-test] cargo target: ${targetDir}`);

let child;
let buildStatus;
try {
  child = spawnSync('pnpm', args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      CARGO_TARGET_DIR: targetDir,
      REDD_BLOCK_SYSTEM_TEST_BUILD: '1',
      // Avoid pnpm trying to remove a worktree-local node_modules directory
      // without a TTY when this script is called from CI or another runner.
      CI: process.env.CI || 'true',
    },
    stdio: 'inherit',
  });
  if (child.error) throw child.error;
  buildStatus = child.status ?? 1;
} finally {
  rmSync(generatedConfigDir, { recursive: true, force: true });
}
if (buildStatus !== 0) process.exit(buildStatus);

const appSource = findBundledApp(targetDir, startedAt);
if (!appSource) {
  throw new Error(
    `Tauri completed but no fresh ${path.basename(configPath)} app bundle was found under ${targetDir}. ` +
    'Set SYSTEM_TEST_BUILD_TARGET if the default target is not installed.',
  );
}

const installPath = path.resolve(
  process.env.SYSTEM_TEST_APP || path.join(os.homedir(), 'Applications', 'Digital Habits Blocker Test.app'),
);
const expectedInstallPath = path.resolve(path.join(
  os.homedir(),
  'Applications',
  'Digital Habits Blocker Test.app',
));
if (installPath !== expectedInstallPath) {
  throw new Error(`SYSTEM_TEST_APP override is not supported; expected ${expectedInstallPath}`);
}
mkdirSync(path.dirname(installPath), { recursive: true });
rmSync(installPath, { recursive: true, force: true });
cpSync(appSource, installPath, { recursive: true, force: true });

const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', installPath], {
  cwd: repoRoot,
  encoding: 'utf8',
  stdio: 'inherit',
});
if (verify.error) throw verify.error;
if (verify.status !== 0) {
  throw new Error(`codesign verification failed for ${installPath}`);
}

console.log(`[system-test] app: ${installPath}`);
