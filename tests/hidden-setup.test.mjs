import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from '../src/server.mjs';
import { appRoot } from '../src/config.mjs';
import { run } from '../scripts/client.mjs';
import { temp } from './helpers.mjs';

async function fixture(t, options = {}) {
  const dataDir = options.dataDir || temp('hidden-中文 空格');
  const app = await createServer({ dataDir, port: 0, environment: {}, ...options });
  t.after(() => app.stop());
  const api = async (path, input) => {
    const response = await fetch(app.url + path, { method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.config.adminToken}`, 'Content-Type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const setup = input => api('/api/setup', { workspace: dataDir, executor: { mode: 'desktop' }, ...input });
  const ticket = nonce => Buffer.from(JSON.stringify({ url: app.url, nonce })).toString('base64url');
  return { app, api, setup, ticket, dataDir };
}

test('fresh setup has no ID fields; selecting desktop mode does not select or create a chat', async t => {
  const { app, api, setup } = await fixture(t);
  assert.deepEqual(app.config.executor, { mode: 'manual' });
  assert.equal((await setup()).status, 200);
  assert.equal((await api('/api/desktop/list', {})).data.needsBootstrap, true);
  assert.equal((await setup({ autoDispatch: true })).status, 400);
  const html = readFileSync(join(appRoot, 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /id="(?:caller-id|destination-id)"/);
  assert.match(html, /识别隐藏会话/); assert.match(html, /不等于临时聊天或关闭记忆/);
});

test('first connection captures caller from the tool environment without asking for an ID', async t => {
  const { app, api, ticket } = await fixture(t);
  const nonce = app.store.ticket('desktop');
  const result = await run(['desktop-connect', '--ticket', ticket(nonce)], { environment: { CODEX_THREAD_ID: 'client-provided-context' } });
  assert.equal(result.ok, true); assert.equal(app.config.executor.callerThreadId, 'client-provided-context');
  assert.equal(app.config.executor.destinationThreadId, undefined);
  await assert.rejects(run(['desktop-connect', '--ticket', ticket(nonce)], { environment: { CODEX_THREAD_ID: 'different' } }), /使用/);
  assert.equal((await api('/api/desktop/bootstrap', { nonce: app.store.ticket(), callerThreadId: 'wrong-ticket-purpose' })).status, 401);
  assert.equal(app.config.executor.callerThreadId, 'client-provided-context');
});

test('missing client context is actionable and never fabricates one', async t => {
  const { app, ticket } = await fixture(t);
  await assert.rejects(run(['desktop-connect', '--ticket', ticket(app.store.ticket('desktop'))], { environment: {} }), /无需手填/);
  assert.equal(app.config.executor.callerThreadId, undefined);
});

test('plugin and desktop tickets are separate, single use and cannot authorize each other', async t => {
  const { app, api, setup } = await fixture(t); await setup();
  const desktopNonce = app.store.ticket('desktop'), pairNonce = app.store.ticket();
  assert.equal(app.store.consumeTicket(pairNonce, () => true), true);
  assert.throws(() => app.store.consumeTicket(desktopNonce, () => true), /用途/);
  assert.equal((await api('/api/desktop/bootstrap', { nonce: desktopNonce, callerThreadId: 'auto-context' })).status, 200);
});

test('select by name once, enable queue and persist the exact hidden target through restart', async t => {
  const sent = [], discovered = [], verified = [];
  const options = { environment: { CODEX_THREAD_ID: 'auto-context' },
    listExecutors: async input => { discovered.push(input); return { threads: [{ id: 'hidden-target', title: '专用后台' }], nextCursor: null }; },
    verifyExecutor: async input => { verified.push(input); return { id: input.destinationThreadId, title: '专用后台' }; },
    send: async input => { sent.push(input); return { sent: true }; } };
  const { app, api, setup, dataDir } = await fixture(t, options); await setup();
  assert.equal((await api('/api/desktop/list', {})).data.threads[0].title, '专用后台');
  assert.equal(discovered[0].callerThreadId, 'auto-context');
  assert.equal(app.config.executor.destinationThreadId, undefined, 'a single result is never silently bound');
  assert.equal((await api('/api/desktop/connect', { selection: 'hidden-target' })).status, 200);
  assert.equal(verified[0].destinationThreadId, 'hidden-target');
  assert.equal((await setup({ autoDispatch: true })).status, 200);
  const status = (await api('/api/status')).data;
  assert.equal(status.config.executor.bound, true); assert.equal(status.config.executor.callerThreadId, undefined); assert.equal(status.config.executor.destinationThreadId, undefined);
  // Legacy/manual ID inputs cannot overwrite the chosen destination.
  await setup({ executor: { mode: 'desktop', callerThreadId: 'injected', destinationThreadId: 'personal-chat' } });
  assert.equal(app.config.executor.destinationThreadId, 'hidden-target');
  await app.stop();
  const restored = await fixture(t, { ...options, dataDir, environment: { CODEX_THREAD_ID: 'different-context' } });
  assert.equal(restored.app.config.executor.destinationThreadId, 'hidden-target');
  await restored.api('/api/desktop/list', {}); assert.equal(discovered.at(-1).callerThreadId, 'auto-context');
  restored.app.config.plugin = { pairedAt: new Date().toISOString(), tools: {} };
  const row = (await restored.api('/api/tasks', { request: 'controlled transport test only' })).data.task;
  assert.equal((await restored.api(`/api/tasks/${row.id}/dispatch`, {})).status, 200);
  assert.equal(sent.length, 1); assert.equal(sent[0].destinationThreadId, 'hidden-target'); assert.equal(sent[0].callerThreadId, 'auto-context');
  assert.equal(restored.app.store.get(row.id).state, 'waiting_executor');
});

test('removed or mismatched target never replaces an existing connection', async t => {
  const { app, api, setup } = await fixture(t, { environment: { CODEX_THREAD_ID: 'auto-context' }, verifyExecutor: async () => ({ id: 'different', title: 'wrong' }) }); await setup();
  Object.assign(app.config.executor, { destinationThreadId: 'original', callerThreadId: 'original-context' });
  assert.equal((await api('/api/desktop/connect', { selection: 'removed' })).status, 400);
  assert.equal(app.config.executor.destinationThreadId, 'original');
});

test('active lease prevents hidden target changes and bootstrap; checkpoints survive', async t => {
  let verifies = 0;
  const { app, api, setup } = await fixture(t, { environment: { CODEX_THREAD_ID: 'auto-context' }, verifyExecutor: async () => { verifies++; return { id: 'different' }; } }); await setup();
  Object.assign(app.config.executor, { callerThreadId: 'original-context', destinationThreadId: 'original' });
  const row = app.store.create({ request: 'preserve my lease', workspace: app.dataDir }), token = app.store.get(row.id, true).executor_token;
  const claimed = app.store.command(row.id, token, 'claim', 'claim', {});
  app.store.command(row.id, token, 'checkpoint', 'checkpoint', { leaseId: claimed.lease_id, text: '原任务检查点' });
  assert.equal((await api('/api/desktop/connect', { selection: 'different' })).status, 409);
  assert.equal((await api('/api/desktop/bootstrap', { nonce: app.store.ticket('desktop'), callerThreadId: 'other' })).status, 409);
  assert.equal(verifies, 0); assert.equal(app.config.executor.destinationThreadId, 'original'); assert.equal(app.store.get(row.id).checkpoint, '原任务检查点');
});

test('claim arriving during asynchronous hidden verification prevents target replacement', async t => {
  let entered, release;
  const enteredPromise = new Promise(r => entered = r), gate = new Promise(r => release = r);
  const { app, api, setup } = await fixture(t, { environment: { CODEX_THREAD_ID: 'auto-context' }, verifyExecutor: async () => { entered(); await gate; return { id: 'new-hidden', title: '新后台' }; } }); await setup();
  Object.assign(app.config.executor, { callerThreadId: 'original-context', destinationThreadId: 'original' });
  const connecting = api('/api/desktop/connect', { selection: 'new-hidden' });
  await enteredPromise;
  try {
    assert.equal((await setup()).status, 409);
    const row = app.store.create({ request: 'claim while connecting', workspace: app.dataDir });
    app.store.command(row.id, app.store.get(row.id, true).executor_token, 'claim', 'claim', {});
  } finally { release(); }
  assert.equal((await connecting).status, 409); assert.equal(app.config.executor.destinationThreadId, 'original');
});

test('discovery rate limit persists across controller restart and also blocks binding', async t => {
  let calls = 0;
  const options = { environment: { CODEX_THREAD_ID: 'auto-context' }, listExecutors: async () => { calls++; throw new Error('HTTP 429 Too Many Requests'); }, verifyExecutor: async () => { calls++; return { id: 'hidden' }; } };
  const { app, api, setup, dataDir } = await fixture(t, options); await setup();
  assert.equal((await api('/api/desktop/list', {})).status, 400); await app.stop();
  const restored = await fixture(t, { ...options, dataDir });
  assert.equal((await restored.api('/api/desktop/connect', { selection: 'hidden' })).status, 400);
  assert.equal(calls, 1); assert.equal((await restored.api('/api/status')).data.readiness.admission.blocked, true);
});
