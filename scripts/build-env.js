#!/usr/bin/env node
/**
 * Shared build environment for commands launched from this repository.
 *
 * Cargo's default target directory lives inside each worktree. That is useful
 * for isolation, but it duplicates the dependency graph for every checkout.
 * Keep the compiled cache outside the repository so linked worktrees can
 * reuse it. CARGO_TARGET_DIR remains the escape hatch for CI or special builds.
 */
const os = require('os');
const path = require('path');

function cacheRoot(env = process.env) {
  if (env.REDD_BLOCK_BUILD_CACHE_DIR) {
    return path.resolve(env.REDD_BLOCK_BUILD_CACHE_DIR);
  }

  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Caches', 'Digital Habits Blocker', 'build-cache');
  }
  if (process.platform === 'win32') {
    return path.join(
      env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
      'Digital Habits Blocker',
      'build-cache',
    );
  }

  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'Digital Habits Blocker', 'build-cache');
}

function getCargoTargetDir(env = process.env) {
  if (env.CARGO_TARGET_DIR) {
    return env.CARGO_TARGET_DIR;
  }
  if (env.REDD_BLOCK_CARGO_TARGET_DIR) {
    return path.resolve(env.REDD_BLOCK_CARGO_TARGET_DIR);
  }
  return path.join(cacheRoot(env), 'cargo-target');
}

function getBuildEnvironment(env = process.env) {
  return {
    ...env,
    CARGO_TARGET_DIR: getCargoTargetDir(env),
  };
}

module.exports = { cacheRoot, getCargoTargetDir, getBuildEnvironment };
