import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, appRoot, writeJson, readJson } from '../src/config.mjs';

const loaded = loadConfig(), state = join(loaded.dataDir, 'supervisor.json'), stopPath = join(loaded.dataDir, 'stop.json');
writeJson(state, { pid: process.pid, installationId: loaded.config.installationId, startedAt: Date.now() });
let stopping = false, child;
process.on('SIGTERM', () => { stopping = true; child?.kill('SIGTERM'); });
process.on('SIGINT', () => { stopping = true; child?.kill('SIGTERM'); });
const stopRequested = () => existsSync(stopPath) && readJson(stopPath)?.installationId === loaded.config.installationId;
let failures = 0;
while (!stopping && !stopRequested()) {
  const started = Date.now();
  child = spawn(process.execPath, [join(appRoot, 'src', 'server.mjs')], { cwd: appRoot, env: { ...process.env, DEVSPACE_SHELL_DATA: loaded.dataDir }, stdio: 'inherit', windowsHide: true });
  await new Promise(resolve => { child.once('exit', resolve); child.once('error', error => { console.error(error.message); resolve(); }); });
  if (stopping || stopRequested()) break;
  failures = Date.now() - started > 60_000 ? 0 : failures + 1;
  const wait = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
  console.error(`Controller exited; restart in ${wait} ms.`);
  // A local sleep is broken into short checks so stop stays responsive.
  for (let elapsed = 0; elapsed < wait && !stopping && !stopRequested(); elapsed += 250) await delay(250);
}
writeJson(state, { pid: null, installationId: loaded.config.installationId, stoppedAt: Date.now() });
