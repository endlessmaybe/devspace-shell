import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { appRoot } from '../src/config.mjs';
import { sourceFiles } from './source-files.mjs';
import { privacy } from './privacy.mjs';

const files = sourceFiles();
for (const name of files.filter(s => /\.(?:mjs|js)$/.test(s))) {
  const result = spawnSync(process.execPath, ['--check', join(appRoot, name)], { windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) { console.error(result.stderr); process.exit(result.status || 1); }
}
console.log('JavaScript syntax: passed');
const findings = privacy();
if (findings.length) { console.error(JSON.stringify(findings)); process.exit(1); }
console.log('Source privacy scan: passed');
const tests = files.filter(s => /^tests\/.*\.test\.mjs$/.test(s));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], { cwd: appRoot, windowsHide: true, stdio: 'inherit' });
process.exitCode = result.status || (result.error ? 1 : 0);
