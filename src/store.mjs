import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';

export function failure(message, status = 409) { const error = new Error(message); error.status = status; return error; }
export function equalToken(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}
export class Store {
  constructor(path, { now = Date.now, leaseMs = 15 * 60_000 } = {}) {
    this.now = now; this.leaseMs = leaseMs; this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, title TEXT, request TEXT NOT NULL, workspace TEXT NOT NULL,
      state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      executor_token TEXT NOT NULL, lease_id TEXT, lease_until INTEGER, checkpoint TEXT, result TEXT,
      dispatch_id TEXT, dispatch_state TEXT, error TEXT, last_progress INTEGER);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(task_id TEXT NOT NULL, command_id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(task_id,command_id));
      CREATE TABLE IF NOT EXISTS tickets(nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    // A crash after marking 'sending' may have delivered the message. Preserve uncertainty.
    this.db.prepare("UPDATE tasks SET state='delivery_unknown',dispatch_state='unknown' WHERE dispatch_state='sending' AND state='dispatching'").run();
  }
  close() { this.db.close(); }
  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id, privateData = false) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!row) throw failure('任务不存在。', 404);
    if (!privateData) delete row.executor_token;
    return { ...row };
  }
  list() { return this.db.prepare("SELECT id,title,state,created_at,updated_at,workspace,dispatch_state,last_progress,error FROM tasks ORDER BY CASE WHEN state IN ('dispatching','waiting_executor','running','lease_expired','delivery_unknown','paused') THEN 0 ELSE 1 END,created_at DESC LIMIT 500").all(); }
  hasActiveTask() { return Boolean(this.db.prepare("SELECT id FROM tasks WHERE state IN ('dispatching','waiting_executor','running','lease_expired','delivery_unknown','paused') LIMIT 1").get()); }
  nextQueued() { return this.db.prepare("SELECT id FROM tasks WHERE state='queued' ORDER BY created_at ASC,rowid ASC LIMIT 1").get() || null; }
  events(id) { this.get(id); return this.db.prepare('SELECT kind,text,created_at FROM events WHERE task_id=? ORDER BY id DESC LIMIT 300').all(id).reverse(); }
  event(id, kind, text) { this.db.prepare('INSERT INTO events(task_id,kind,text,created_at) VALUES(?,?,?,?)').run(id, kind, String(text).slice(0, 32000), this.now()); }
  create({ title, request, workspace }) {
    if (typeof request !== 'string' || !request.trim() || request.length > 40000 || typeof workspace !== 'string' || !workspace) throw failure('请填写任务内容和项目目录。', 400);
    const id = randomUUID(), now = this.now();
    return this.transaction(() => {
      this.db.prepare("INSERT INTO tasks(id,title,request,workspace,state,created_at,updated_at,executor_token) VALUES(?,?,?,?,'queued',?,?,?)")
        .run(id, String(title || request.slice(0, 24)).slice(0, 120), request.trim(), workspace, now, now, randomBytes(32).toString('base64url'));
      this.event(id, 'created', '任务已保存，等待 GPT 执行器领取。'); return this.get(id);
    });
  }
  authorize(id, token) { const row = this.get(id, true); if (!equalToken(token, row.executor_token)) throw failure('任务授权无效。', 401); return row; }
  beginDispatch(id) {
    return this.transaction(() => {
      const row = this.get(id, true);
      if (row.state !== 'queued' || row.dispatch_state === 'unknown') throw failure('该任务不能再次派发。');
      const other = this.db.prepare("SELECT id FROM tasks WHERE id<>? AND state IN ('dispatching','waiting_executor','running','lease_expired','delivery_unknown','paused') LIMIT 1").get(id);
      if (other) throw failure('已有任务占用执行槽，请先处理原任务。');
      const callId = randomUUID();
      this.db.prepare("UPDATE tasks SET state='dispatching',dispatch_state='sending',dispatch_id=?,updated_at=? WHERE id=?").run(callId, this.now(), id);
      this.event(id, 'dispatch', '开始派发到用户配置的执行聊天。');
      return this.get(id, true);
    });
  }
  finishDispatch(id, outcome, error = '') {
    return this.transaction(() => {
      const row = this.get(id);
      if (row.state === 'running') return row; // A fast executor may claim before the send acknowledgement.
      const state = outcome === 'sent' ? 'waiting_executor' : outcome === 'refused' ? 'queued' : 'delivery_unknown';
      this.db.prepare('UPDATE tasks SET state=?,dispatch_state=?,error=?,updated_at=? WHERE id=?').run(state, outcome, String(error).slice(0, 1500), this.now(), id);
      this.event(id, 'dispatch', outcome === 'sent' ? '发送已确认，等待真实领取。' : outcome === 'refused' ? '发送未发生，可稍后重试。' : '发送结果未知，已停止自动重发。');
      return this.get(id);
    });
  }
  command(id, token, commandId, kind, body) {
    if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(commandId || '')) throw failure('需要稳定、唯一的 commandId。', 400);
    return this.transaction(() => {
      const row = this.authorize(id, token);
      const digest = createHash('sha256').update(JSON.stringify({ kind, body })).digest('hex');
      const previous = this.db.prepare('SELECT * FROM commands WHERE task_id=? AND command_id=?').get(id, commandId);
      if (previous) { if (previous.digest !== digest) throw failure('同一 commandId 的内容不能改变。'); return JSON.parse(previous.result); }
      const now = this.now();
      if (kind === 'claim') {
        if (!['queued', 'waiting_executor', 'delivery_unknown', 'dispatching'].includes(row.state)) throw failure('任务已经领取或暂停，需明确恢复。');
        const other = this.db.prepare("SELECT id FROM tasks WHERE id<>? AND state IN ('running','lease_expired','paused','dispatching','waiting_executor','delivery_unknown') LIMIT 1").get(id);
        if (other) throw failure('另一个任务占用执行槽。');
        this.db.prepare("UPDATE tasks SET state='running',lease_id=?,lease_until=?,updated_at=?,error=NULL WHERE id=?").run(randomUUID(), now + this.leaseMs, now, id);
        this.event(id, 'claim', 'GPT 已领取任务；领取本身不计作业务进展。');
      } else {
        if (row.state !== 'running' || !equalToken(body.leaseId, row.lease_id) || row.lease_until < now) throw failure('租约失效，请先在控制台核实并恢复原任务。');
        if (kind === 'heartbeat') this.db.prepare('UPDATE tasks SET lease_until=?,updated_at=? WHERE id=?').run(now + this.leaseMs, now, id);
        else if (kind === 'checkpoint' || kind === 'activity') {
          if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 32000) throw failure('进展内容不能为空或超过 32000 字符。', 400);
          this.db.prepare(`UPDATE tasks SET ${kind === 'checkpoint' ? 'checkpoint=?,' : ''} last_progress=?,lease_until=?,updated_at=? WHERE id=?`).run(...(kind === 'checkpoint' ? [body.text] : []), now, now + this.leaseMs, now, id);
          this.event(id, kind, body.text);
        } else if (kind === 'complete') {
          if (typeof body.result !== 'string' || !body.result.trim() || body.result.length > 32000 || !Array.isArray(body.evidence) || !body.evidence.length || body.evidence.length > 40 || body.evidence.some(v => typeof v !== 'string' || !v.trim() || v.length > 2000)) throw failure('完成需要结果说明和至少一条真实验证证据。', 400);
          this.db.prepare("UPDATE tasks SET state='completed',result=?,lease_until=NULL,updated_at=? WHERE id=?").run(JSON.stringify({ text: body.result, evidence: body.evidence }), now, id);
          this.event(id, 'complete', body.result);
        } else throw failure('未知执行器操作。', 400);
      }
      const result = this.get(id);
      this.db.prepare('INSERT INTO commands(task_id,command_id,digest,result) VALUES(?,?,?,?)').run(id, commandId, digest, JSON.stringify(result));
      return result;
    });
  }
  expire() {
    const expired = this.db.prepare("SELECT id FROM tasks WHERE state='running' AND lease_until<?").all(this.now());
    for (const { id } of expired) {
      this.db.prepare("UPDATE tasks SET state='lease_expired',updated_at=? WHERE id=?").run(this.now(), id);
      this.event(id, 'attention', '租约超时，保留断点和执行槽。核实原执行器后恢复，避免重复写操作。');
    }
  }
  action(id, action, acknowledged = false) {
    return this.transaction(() => {
      const row = this.get(id);
      if (!['pause', 'resume', 'cancel', 'confirm-not-delivered'].includes(action)) throw failure('未知操作。', 400);
      if (row.state === 'completed' || row.state === 'cancelled') throw failure('任务已经结束。');
      if (action === 'resume' && row.state !== 'paused' && row.state !== 'lease_expired') throw failure('只能恢复已暂停或租约过期的任务。');
      if (action === 'confirm-not-delivered' && row.state !== 'delivery_unknown') throw failure('只有发送未知的任务需要此确认。');
      if (['resume', 'cancel', 'confirm-not-delivered'].includes(action) && !acknowledged) throw failure('请确认原执行器已经停止，并已核实已有副作用。');
      const state = action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'queued';
      this.db.prepare('UPDATE tasks SET state=?,lease_id=NULL,lease_until=NULL,dispatch_state=NULL,updated_at=? WHERE id=?').run(state, this.now(), id);
      this.event(id, 'control', action === 'pause' ? '任务暂停；请同时停止 GPT 执行器。' : action === 'cancel' ? '任务已取消；历史检查点保留。' : '原任务重新进入队列，已有检查点保留。');
      return this.get(id);
    });
  }
  ticket() {
    const nonce = randomBytes(32).toString('base64url');
    this.db.prepare('DELETE FROM tickets').run();
    this.db.prepare('INSERT INTO tickets(nonce,expires_at) VALUES(?,?)').run(nonce, this.now() + 10 * 60_000);
    return nonce;
  }
  consumeTicket(nonce, operation) {
    return this.transaction(() => {
      const ticket = this.db.prepare('SELECT * FROM tickets WHERE nonce=?').get(String(nonce));
      if (!ticket || ticket.consumed || ticket.expires_at < this.now()) throw failure('配对口令已过期或已使用，请重新生成。', 401);
      const result = operation();
      this.db.prepare('UPDATE tickets SET consumed=1 WHERE nonce=?').run(nonce); return result;
    });
  }
}
