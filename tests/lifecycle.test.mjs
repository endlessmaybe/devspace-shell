import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { temp } from './helpers.mjs';
import { appRoot, loadConfig, readJson } from '../src/config.mjs';
import { manage } from '../scripts/manage.mjs';
import { Store } from '../src/store.mjs';
import { NewAppToolAdmission } from '../src/adapters/new-app-tool-admission.mjs';
import { setTimeout as delay } from 'node:timers/promises';

test('background lifecycle is idempotent, survives server exit, retains tasks and stops only itself', { timeout: 30000 }, async t => {
  const dataDir = temp('lifecycle-中文 空格');
  t.after(async () => { await manage('stop', { dataDir }).catch(() => {}); });
  const first = await manage('start', { dataDir }), second = await manage('start', { dataDir }); assert.equal(first.url, second.url);
  const loaded = loadConfig(dataDir);
  const request = (path, body) => fetch(first.url + path, { method: 'POST', headers: { Authorization: `Bearer ${loaded.config.adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const task = await (await request('/api/tasks', { request: 'restart persistence', workspace: dataDir })).json(); assert.ok(task.task.id);
  const old = readJson(join(dataDir, 'instance.json'));
  // Stop only the authenticated controller, leaving its own supervisor to recover it.
  await request('/api/system/stop', {});
  let current;
  for (let i = 0; i < 80; i++) { await delay(150); current = readJson(join(dataDir, 'instance.json')); if (current?.pid !== old.pid) { try { if ((await fetch(current.url + '/healthz')).ok) break; } catch {} } }
  assert.notEqual(current.pid, old.pid);
  const response = await fetch(current.url + '/api/status', { headers: { Authorization: `Bearer ${loaded.config.adminToken}` } });
  assert.equal((await response.json()).tasks[0].id, task.task.id);
  assert.equal((await manage('stop', { dataDir })).stopped, true); assert.equal((await manage('status', { dataDir })).running, false);
  assert.equal((await manage('stop', { dataDir })).stopped, true);
});
test('upstream rate-limit admission survives restart and blocks both sends and reads', t => {
  const path = join(temp('admission'), 'tasks.sqlite'); const store = new Store(path); t.after(() => store.close()); let now = 10000;
  const first = new NewAppToolAdmission(store.db, { clock: () => now }); first.recordFailure(new Error('HTTP 429 Too Many Requests'), 'send');
  const second = new NewAppToolAdmission(store.db, { clock: () => now }); assert.equal(second.status().blocked, true);
  return assert.rejects(second.run('read', () => { throw new Error('should not call'); }), /cooling down/);
});
test('Windows PowerShell entry scripts parse and validate existing Node without installing or launching', { skip: process.platform !== 'win32' }, () => {
  for (const name of ['install.ps1', 'autostart.ps1']) {
    const script = join(appRoot, 'scripts', name), literal = script.replaceAll("'", "''");
    const parsed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${literal}',[ref]$tokens,[ref]$errors); if($errors.Count){$errors | ForEach-Object {$_.Message}; exit 1}`], { encoding: 'utf8', windowsHide: true });
    assert.equal(parsed.status, 0, parsed.stdout + parsed.stderr);
    assert.deepEqual([...readFileSync(script).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  }
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(appRoot, 'scripts', 'install.ps1'), '-ValidateOnly', '-NodePath', process.execPath], { encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr);
});
test('Windows login shortcut enable/disable is idempotent and owned by this test installation', { skip: process.platform !== 'win32' }, () => {
  const dataDir = temp('startup'), loaded = loadConfig(dataDir);
  const call = mode => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(appRoot, 'scripts', 'autostart.ps1'), '-Mode', mode, '-NodePath', process.execPath, '-DataDir', dataDir], { encoding: 'utf8', windowsHide: true });
  try {
    assert.equal(call('Enable').status, 0); assert.equal(call('Enable').status, 0);
    assert.equal(JSON.parse(call('Status').stdout).enabled, true);
  } finally { assert.equal(call('Disable').status, 0); }
  assert.equal(call('Disable').status, 0); assert.equal(JSON.parse(call('Status').stdout).enabled, false);
});
