#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const path = require('node:path');

function run(script) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script), '--all'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log('Starting AMFI AAUM historical backfill.');
run('import-amfi-aaum.js');
console.log('Starting AMFI TER historical backfill.');
run('import-amfi-ter.js');
console.log('AMFI historical backfill completed.');
