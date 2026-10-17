import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createServer } from '../src/server.mjs';
import { appRoot } from '../src/config.mjs';
import { temp, catalog } from './helpers.mjs';
import { run } from '../scripts/client.mjs';

async function fixture(t, options = {}) {
  const dataDir = temp('integration-中文 空格'), app = await createServer({ dataDir, port: 0, ...options }); t.after(() => app.stop());
  const api = async (path, input, extra = {}) => {
    const r = await fetch(app.url + path, { method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.config.adminToken}`, 'Content-Type': 'application/json', ...extra }, ...(input ? { body: JSON.stringify(input) } : {}) }); return { status: r.status, data: await r.json() };
  };
  const setup = await api('/api/setup', { workspace: dataDir, executor: { mode: 'manual' }, commandRuntime: 'native' }); assert.equal(setup.status, 200);
  return { app, api, dataDir };
}
test('fresh user config is empty and credentials are absent from public status', async t => {
  const { api } = await fixture(t); const result = await api('/api/status'); assert.equal(result.data.tasks.length, 0); assert.equal(result.data.config.plugin, null); assert.equal(result.data.config.adminToken, undefined);
});
test('private APIs reject missing auth and untrusted origin', async t => {
  const { app, api } = await fixture(t);
  assert.equal((await fetch(app.url + '/api/status')).status, 401); assert.equal((await api('/api/setup', {}, { Origin: 'https://other.example' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const request = http.get(app.url + '/healthz', { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject);
  }); assert.equal(hostStatus, 403);
});
test('pairing is real callback, cannot replay, and task lifecycle works over HTTP', async t => {
  const { app, api } = await fixture(t), nonce = app.store.ticket();
  const pairTicket = Buffer.from(JSON.stringify({ url: app.url, nonce })).toString('base64url');
  const paired = await run(['pair', '--ticket', pairTicket, '--catalog', JSON.stringify(catalog('mcp__my-connector__'))]); assert.equal(paired.ok, true);
  await assert.rejects(run(['pair', '--ticket', pairTicket, '--catalog', JSON.stringify(catalog())]), /过期|使用/);
  const created = await api('/api/tasks', { request: '在独立临时目录检查中文，不接触其他安装' }); assert.equal(created.status, 201);
  const id = created.data.task.id, row = app.store.get(id, true), ticket = Buffer.from(JSON.stringify({ url: app.url, taskId: id, token: row.executor_token })).toString('base64url');
  const call = (action, body) => run(['task', '--ticket', ticket, '--action', action, '--body', JSON.stringify(body)]);
  const claimed = await call('claim', { commandId: 'claim' }); assert.equal(claimed.state, 'running');
  await call('checkpoint', { commandId: 'checkpoint', leaseId: claimed.lease_id, text: '中文持久化 ✓' });
  const done = await call('complete', { commandId: 'done', leaseId: claimed.lease_id, result: '完成', evidence: ['临时验证通过'] }); assert.equal(done.state, 'completed');
  assert.equal((await api('/api/tasks/' + id)).data.task.checkpoint, '中文持久化 ✓');
});
test('unknown desktop send is attempted once and never replayed by the controller', async t => {
  let calls = 0;
  const { app, api } = await fixture(t, { send: async () => { calls++; const error = new Error('connection closed after send'); error.deliveryState = 'unknown'; throw error; } });
  app.config.plugin = { pairedAt: new Date().toISOString(), tools: {} }; Object.assign(app.config.executor, { mode: 'desktop', callerThreadId: 'test-caller', destinationThreadId: 'test-executor' }); app.config.autoDispatch = true;
  const row = (await api('/api/tasks', { request: 'one send only' })).data.task;
  await api(`/api/tasks/${row.id}/dispatch`, {});
  await new Promise(r => setTimeout(r, 2200)); assert.equal(calls, 1); assert.equal(app.store.get(row.id).state, 'delivery_unknown');
});
test('cannot switch project or executor while a task owns the slot', async t => {
  const { app, api } = await fixture(t); const row = app.store.create({ request: 'task', workspace: app.dataDir });
  app.store.command(row.id, app.store.get(row.id, true).executor_token, 'claim', 'claim', {});
  assert.equal((await api('/api/setup', { workspace: app.dataDir, executor: { mode: 'desktop', destinationThreadId: 'different' } })).status, 409);
  const nonce = app.store.ticket(); assert.equal((await api('/api/pair', { nonce, catalog: catalog('different__') })).status, 409);
});
test('occupied port is preserved while shell selects another', async t => {
  const foreign = http.createServer((_q, r) => r.end('foreign')); await new Promise(r => foreign.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => foreign.close(r)));
  const originalPort = foreign.address().port, { app } = await fixture(t, { port: originalPort });
  assert.notEqual(new URL(app.url).port, String(originalPort)); assert.equal(await (await fetch(`http://127.0.0.1:${originalPort}`)).text(), 'foreign');
});
test('stdio MCP is usable by a different client and prints only JSON RPC', async t => {
  const { app, api, dataDir } = await fixture(t);
  await api('/api/tasks', { request: 'stdio verification' });
  // Async child avoids blocking the in-process HTTP server while the client calls it.
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [join(appRoot, 'src', 'mcp-stdio.mjs')], { env: { ...process.env, DEVSPACE_SHELL_DATA: dataDir }, windowsHide: true });
  let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
  child.stdin.end([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'devshell_list_tasks', arguments: {} } }].map(JSON.stringify).join('\n') + '\n');
  const code = await new Promise(r => child.once('exit', r)); assert.equal(code, 0, stderr);
  const messages = stdout.trim().split('\n').map(JSON.parse); assert.equal(messages.length, 3); assert.ok(messages[1].result.tools.some(tool => tool.name === 'devshell_search_memory')); assert.ok(messages[1].result.tools.some(tool => tool.name === 'devshell_remember')); assert.match(messages[2].result.content[0].text, /stdio verification/);
});
