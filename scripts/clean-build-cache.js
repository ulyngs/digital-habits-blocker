#!/usr/bin/env node
/**
 * Remove generated build caches without touching source, dependencies, or
 * distribution artifacts. Stop active builds before using --shared-rust or
 * --all-worktrees.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getCargoTargetDir } = require('./build-env');

const repoRoot = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const cleanSharedRust = args.has('--shared-rust') || args.has('--all');
const cleanAllWorktrees = args.has('--all-worktrees') || args.has('--all');
const dryRun = args.has('--dry-run');
const allowedArgs = new Set(['--shared-rust', '--all-worktrees', '--all', '--help', '-h']);
allowedArgs.add('--dry-run');

if ([...args].some((arg) => !allowedArgs.has(arg))) {
  console.error('Unknown option. Use --help for usage.');
  process.exit(2);
}

if (args.has('--help') || args.has('-h')) {
  console.log(`Usage: npm run clean:build-cache -- [options]

Options:
  (none)          Clean generated caches in the current worktree.
  --shared-rust   Remove the shared Cargo target cache.
  --all-worktrees Clean generated caches in every Git worktree.
  --all           Combine --shared-rust and --all-worktrees.
  --dry-run       List what would be removed without deleting anything.

Stop active builds first. No source, node_modules, or for-distribution files
are removed.`);
  process.exit(0);
}

function worktrees() {
  if (!cleanAllWorktrees) return [repoRoot];

  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((worktree) => worktree && fs.existsSync(worktree));
}

function removeGenerated(label, target) {
  if (!fs.existsSync(target)) return;
  if (dryRun) {
    console.log(`Would remove ${label}: ${target}`);
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`Removed ${label}: ${target}`);
}

function cleanWorktree(worktree) {
  const generated = [
    ['legacy Cargo target', path.join(worktree, 'src-tauri', 'target')],
    ['Vite output', path.join(worktree, 'dist')],
    ['Vite cache', path.join(worktree, 'node_modules', '.vite')],
    ['Android Gradle cache', path.join(worktree, 'src-tauri', 'gen', 'android', '.gradle')],
    ['Android build output', path.join(worktree, 'src-tauri', 'gen', 'android', 'app', 'build')],
    ['Android native build output', path.join(worktree, 'src-tauri', 'gen', 'android', 'app', '.cxx')],
    ['Android root build output', path.join(worktree, 'src-tauri', 'gen', 'android', 'build')],
    ['Android buildSrc output', path.join(worktree, 'src-tauri', 'gen', 'android', 'buildSrc', 'build')],
  ];
  generated.forEach(([label, target]) => removeGenerated(label, target));
}

if (cleanSharedRust) {
  const target = getCargoTargetDir(process.env);
  if (path.resolve(target) === path.parse(path.resolve(target)).root) {
    throw new Error(`Refusing to remove filesystem root as Cargo target: ${target}`);
  }
  removeGenerated('shared Cargo target', target);
}

worktrees().forEach(cleanWorktree);
