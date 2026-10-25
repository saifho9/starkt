import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.name === 'node_modules' || e.name.startsWith('.') ? [] : e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []);
}
for (const file of files('.')) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status) process.exit(result.status);
}
console.log('JavaScript syntax: OK');
