#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getBuildEnvironment, getCargoTargetDir } = require('./build-env');

const root = path.join(__dirname, '..');
const svg = path.join(root, 'assets', 'reddblock-icon.svg');
const tauriDir = path.join(root, 'src-tauri');
const cargoTargetDir = getCargoTargetDir(process.env);

const DEV_ICON = {
  darwin: {
    icon: path.join(tauriDir, 'icons', 'icon.icns'),
    bin: path.join(cargoTargetDir, 'debug', 'redd-block'),
    label: 'icon.icns',
  },
  win32: {
    icon: path.join(tauriDir, 'icons', 'icon.ico'),
    bin: path.join(cargoTargetDir, 'debug', 'redd-block.exe'),
    label: 'icon.ico',
  },
}[process.platform];

if (!DEV_ICON) {
  process.exit(0);
}

if (!fs.existsSync(svg)) {
  console.error(`ensure-dev-icons: missing ${svg}`);
  process.exit(1);
}

function getMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch (e) {
    return 0;
  }
}

const svgMtime = getMtime(svg);

if (!fs.existsSync(DEV_ICON.icon) || svgMtime > getMtime(DEV_ICON.icon)) {
  console.log('ensure-dev-icons: regenerating icons from SVG…');
  const res = spawnSync('node', [path.join(root, 'scripts', 'generate-icons-from-svg.js')], {
    stdio: 'inherit',
    shell: true,
  });
  if (res.status !== 0) {
    process.exit(res.status || 1);
  }
}

const iconMtime = getMtime(DEV_ICON.icon);
if (!fs.existsSync(DEV_ICON.bin) || iconMtime > getMtime(DEV_ICON.bin)) {
  console.log(`ensure-dev-icons: rebuilding debug binary for updated ${DEV_ICON.label}…`);
  const res = spawnSync('cargo', ['build', '-q'], {
    cwd: tauriDir,
    env: getBuildEnvironment(process.env),
    stdio: 'inherit',
    shell: true,
  });
  if (res.status !== 0) {
    process.exit(res.status || 1);
  }
}
