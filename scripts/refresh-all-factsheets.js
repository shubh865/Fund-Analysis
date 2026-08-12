const path = require('node:path');
const { spawnSync } = require('node:child_process');
const packageJson = require('../package.json');

const refreshers = Object.entries(packageJson.scripts)
  .filter(([name, command]) => /^refresh:.*-factsheets$/.test(name)
    && name !== 'refresh:all-factsheets'
    && /^node scripts\/[^ ]+\.js$/.test(command))
  .sort(([left], [right]) => left.localeCompare(right));

const failures = [];
for (const [index, [name, command]] of refreshers.entries()) {
  console.log(`\n[${index + 1}/${refreshers.length}] ${name}`);
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '..', command.replace(/^node\s+/, ''))], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
  });
  if (result.status !== 0) failures.push(name);
}

console.log(`\nFactsheet refresh finished: ${refreshers.length - failures.length}/${refreshers.length} refreshers succeeded.`);
if (failures.length) {
  console.error(`Failures: ${failures.join(', ')}`);
  process.exitCode = 1;
}
