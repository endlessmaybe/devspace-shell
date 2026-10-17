import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { temp } from './helpers.mjs';
import { DatabaseSync } from 'node:sqlite';

function fixture(t) {
  const path = join(temp('store'), 'tasks.sqlite'); let clock = 100000;
  const store = new Store(path, { now: () => clock, leaseMs: 1000 }); t.after(() => { try { store.close(); } catch {} });
  const row = store.create({ request: '修复示例项目并验证', workspace: '/example/project' }), token = store.get(row.id, true).executor_token;
  return { store, row, token, path, advance: n => { clock += n; } };
}
test('fresh database contains no prior tasks or memory', t => { const { store } = fixture(t); assert.equal(store.list().length, 1); assert.equal(store.list()[0].state, 'queued'); assert.equal(store.db.prepare('SELECT count(*) AS n FROM memories').get().n, 0); });
test('lease claim is idempotent for a stable command id', t => {
  const { store, row, token } = fixture(t); const first = store.command(row.id, token, 'claim', 'claim', {});
  assert.deepEqual(store.command(row.id, token, 'claim', 'claim', {}), first); assert.equal(first.last_progress, null);
});
test('heartbeat does not become business progress', t => {
  const { store, row, token, advance } = fixture(t); const claimed = store.command(row.id, token, 'claim', 'claim', {}); advance(100);
  const heartbeat = store.command(row.id, token, 'heartbeat', 'heartbeat', { leaseId: claimed.lease_id }); assert.equal(heartbeat.last_progress, null); assert.equal(store.events(row.id).length, 2);
});
test('a command id cannot be reused for different payloads', t => {
  const { store, row, token } = fixture(t); const claimed = store.command(row.id, token, 'claim', 'claim', {});
  const input = { leaseId: claimed.lease_id, text: '阶段一验证通过' }; store.command(row.id, token, 'checkpoint', 'checkpoint', input);
  assert.throws(() => store.command(row.id, token, 'checkpoint', 'checkpoint', { ...input, text: '另一个写操作' }), /不能改变/);
});
test('two tasks cannot claim the execution slot', t => {
  const { store, row, token } = fixture(t); store.command(row.id, token, 'claim', 'claim', {});
  const second = store.create({ request: '另一个任务', workspace: '/example/project' });
  assert.throws(() => store.command(second.id, store.get(second.id, true).executor_token, 'claim', 'claim', {}), /占用/);
});
test('checkpoint and lease survive a process restart', t => {
  const { store, row, token, path } = fixture(t); const claimed = store.command(row.id, token, 'claim', 'claim', {});
  store.command(row.id, token, 'checkpoint', 'checkpoint', { leaseId: claimed.lease_id, text: '已验证中文 ✓；长命令 sessionId=42' }); store.close();
  const reopened = new Store(path, { now: () => 100100 }); t.after(() => reopened.close());
  assert.equal(reopened.get(row.id).state, 'running'); assert.match(reopened.get(row.id).checkpoint, /中文/); assert.equal(reopened.get(row.id).lease_id, claimed.lease_id);
});
test('expired lease preserves checkpoint and blocks automatic replacement', t => {
  const { store, row, token, advance } = fixture(t); const claimed = store.command(row.id, token, 'claim', 'claim', {}); advance(1001); store.expire();
  assert.equal(store.get(row.id).state, 'lease_expired'); assert.throws(() => store.command(row.id, token, 'h2', 'heartbeat', { leaseId: claimed.lease_id }), /租约/);
  assert.throws(() => store.action(row.id, 'resume'), /核实/); assert.equal(store.action(row.id, 'resume', true).state, 'queued');
});
test('completion requires evidence and supports an identical retry', t => {
  const { store, row, token } = fixture(t); const claimed = store.command(row.id, token, 'claim', 'claim', {});
  assert.throws(() => store.command(row.id, token, 'done', 'complete', { leaseId: claimed.lease_id, result: '完成', evidence: [] }), /证据/);
  const input = { leaseId: claimed.lease_id, result: '修复并验证完成', evidence: ['node --test: 2 passed'] };
  assert.equal(store.command(row.id, token, 'done', 'complete', input).state, 'completed'); assert.equal(store.command(row.id, token, 'done', 'complete', input).state, 'completed');
});
test('crash during delivery becomes unknown rather than queued', t => {
  const { store, row, path } = fixture(t); store.beginDispatch(row.id); store.close(); const reopened = new Store(path); t.after(() => reopened.close());
  assert.equal(reopened.get(row.id).state, 'delivery_unknown'); assert.throws(() => reopened.beginDispatch(row.id));
  assert.throws(() => reopened.action(row.id, 'confirm-not-delivered')); assert.equal(reopened.action(row.id, 'confirm-not-delivered', true).state, 'queued');
});
test('ticket is expiring and single use, failed catalog validation does not consume it', t => {
  const { store, advance } = fixture(t); const nonce = store.ticket(); assert.throws(() => store.consumeTicket(nonce, () => { throw new Error('bad catalog'); }));
  assert.equal(store.consumeTicket(nonce, () => 42), 42); assert.throws(() => store.consumeTicket(nonce, () => 43));
  const expired = store.ticket(); advance(600001); assert.throws(() => store.consumeTicket(expired, () => 42));
});
test('cross-task token and old lease cannot write progress', t => {
  const { store, row, token } = fixture(t); assert.throws(() => store.command(row.id, 'wrong', 'claim', 'claim', {}), /授权/);
  store.command(row.id, token, 'claim', 'claim', {}); assert.throws(() => store.command(row.id, token, 'checkpoint', 'checkpoint', { leaseId: 'wrong', text: '伪进展' }), /租约/);
});
test('a newly generated pairing ticket invalidates the older ticket', t => {
  const { store } = fixture(t); const old = store.ticket(), current = store.ticket();
  assert.throws(() => store.consumeTicket(old, () => true)); assert.equal(store.consumeTicket(current, () => true), true);
});
test('upgrading the pre-purpose ticket schema preserves existing pairing tickets', t => {
  const path = join(temp('old-tickets'), 'tasks.sqlite'), old = new DatabaseSync(path);
  old.exec('CREATE TABLE tickets(nonce TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0)');
  old.prepare('INSERT INTO tickets(nonce,expires_at) VALUES(?,?)').run('legacy-pair-ticket', 700000); old.close();
  const store = new Store(path, { now: () => 100000 }); t.after(() => store.close());
  assert.equal(store.consumeTicket('legacy-pair-ticket', () => 'preserved'), 'preserved');
  const desktop = store.ticket('desktop');
  assert.throws(() => store.consumeTicket(desktop, () => true), /用途/);
  assert.equal(store.consumeTicket(desktop, () => true, 'desktop'), true);
});
test('queue admission and oldest-first selection do not depend on the dashboard history limit', t => {
  const { store, row, token } = fixture(t); store.command(row.id, token, 'claim', 'claim', {});
  store.transaction(() => {
    const insert = store.db.prepare("INSERT INTO tasks(id,title,request,workspace,state,created_at,updated_at,executor_token) VALUES(?,'queued','test','/example/project','queued',?,100000,'test-token')");
    for (let i = 0; i < 510; i++) insert.run(`queued-${i}`, 200000 + i);
  });
  assert.equal(store.list().length, 500); assert.equal(store.list()[0].id, row.id);
  assert.equal(store.list().some(t => t.id === 'queued-0'), false);
  assert.equal(store.hasActiveTask(), true); assert.equal(store.nextQueued().id, 'queued-0');
});
