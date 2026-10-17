import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const defaults = { enabled: true, autoCapture: true, autoLimit: 200 };
export function projectKey(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw invalid('记忆需要项目绝对路径。');
  let path = resolve(value);
  try { path = realpathSync.native(path); } catch { /* Keep notes accessible after a project is removed. */ }
  return process.platform === 'win32' ? path.toLowerCase() : path;
}
export function searchTokens(text) {
  const normalized = String(text).normalize('NFKC').toLowerCase();
  const words = normalized.match(/[\p{L}\p{N}_]+/gu) || [];
  const tokens = [];
  for (const word of words) {
    // unicode61 alone treats a whole Chinese sentence as one word.
    const parts = word.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) || [];
    for (const part of parts) {
      if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(part)) {
        const chars = [...part];
        tokens.push(...chars, ...chars.slice(1).map((char, index) => chars[index] + char));
      } else tokens.push(part.slice(0, 80));
    }
  }
  return [...new Set(tokens)];
}
export class MemoryStore {
  constructor(db, { now = Date.now } = {}) {
    this.db = db; this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,scope TEXT NOT NULL,workspace TEXT NOT NULL,
      kind TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,pinned INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL,source_task TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope,workspace,updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS memories_task ON memories(source_task) WHERE source='task';
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(tokens);
      CREATE TABLE IF NOT EXISTS memory_forgotten(task_id TEXT PRIMARY KEY);`);
  }
  atomic(operation) {
    this.db.exec('SAVEPOINT memory_write');
    try { const value = operation(); this.db.exec('RELEASE memory_write'); return value; }
    catch (error) { this.db.exec('ROLLBACK TO memory_write; RELEASE memory_write'); throw error; }
  }
  policy(input) {
    const saved = this.db.prepare("SELECT value FROM settings WHERE key='memory_policy'").get();
    const policy = { ...defaults, ...(saved ? JSON.parse(saved.value) : {}) };
    if (input === undefined) return policy;
    for (const key of Object.keys(input)) if (!Object.hasOwn(defaults, key)) throw invalid('未知记忆设置。');
    for (const key of ['enabled', 'autoCapture']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw invalid('记忆开关需要布尔值。');
    if (input.autoLimit !== undefined && (!Number.isInteger(input.autoLimit) || input.autoLimit < 1 || input.autoLimit > 1000)) throw invalid('自动记忆保留数量应为 1–1000。');
    const next = { ...policy, ...input };
    this.atomic(() => {
      this.db.prepare("INSERT INTO settings(key,value) VALUES('memory_policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));
      for (const row of this.db.prepare("SELECT DISTINCT workspace FROM memories WHERE source='task'").all()) this.prune(row.workspace, next.autoLimit);
    });
    return next;
  }
  scope(input) {
    const scope = input.scope || 'project';
    if (!['project', 'user'].includes(scope)) throw invalid('记忆范围只能是当前项目或用户偏好。');
    return { scope, workspace: scope === 'project' ? projectKey(input.workspace) : '' };
  }
  get(id) {
    const row = this.db.prepare('SELECT rowid,* FROM memories WHERE id=?').get(id);
    if (!row) throw invalid('记忆不存在。', 404);
    const { rowid, ...note } = row; return { ...note, pinned: Boolean(note.pinned) };
  }
  put(input, { source = 'user', sourceTask = null } = {}) {
    const { scope, workspace } = this.scope(input), kind = input.kind || 'knowledge';
    if (!['preference', 'knowledge', 'task'].includes(kind) || (kind === 'task' && source !== 'task') || (scope === 'user' && kind !== 'preference')) throw invalid('用户范围用于偏好；项目范围用于偏好、知识及自动任务记录。');
    for (const [key, limit] of [['title', 120], ['content', 12000]]) if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > limit) throw invalid(`记忆 ${key} 不能为空或超过 ${limit} 字符。`);
    if (input.pinned !== undefined && typeof input.pinned !== 'boolean') throw invalid('固定标记需要布尔值。');
    return this.atomic(() => {
      const existing = input.id ? this.get(input.id) : null;
      if (existing && existing.revision !== input.revision) throw invalid('记忆已被修改，请刷新后重试。', 409);
      if (existing && (existing.scope !== scope || existing.workspace !== workspace)) throw invalid('不能更改已有记忆的范围。');
      const id = existing?.id || randomUUID(), now = this.now();
      if (existing?.source === 'task' && source !== 'task') this.db.prepare('INSERT OR IGNORE INTO memory_forgotten(task_id) VALUES(?)').run(existing.source_task);
      this.db.prepare(`INSERT INTO memories(id,scope,workspace,kind,title,content,pinned,source,source_task,created_at,updated_at,revision)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,content=excluded.content,
        pinned=excluded.pinned,source=excluded.source,updated_at=excluded.updated_at,revision=memories.revision+1`).run(id, scope, workspace, kind,
        input.title.trim(), input.content.trim(), Number(input.pinned ?? existing?.pinned ?? false), source,
        existing?.source_task || sourceTask, existing?.created_at || now, now);
      const rowid = this.db.prepare('SELECT rowid FROM memories WHERE id=?').get(id).rowid;
      this.db.prepare('DELETE FROM memory_search WHERE rowid=?').run(rowid);
      this.db.prepare('INSERT INTO memory_search(rowid,tokens) VALUES(?,?)').run(rowid, searchTokens(input.title + ' ' + input.content).join(' '));
      return this.get(id);
    });
  }
  remove(id, revision, forgotten = true) {
    return this.atomic(() => {
      const note = this.get(id);
      if (revision !== note.revision) throw invalid('记忆已被修改，请刷新后重试。', 409);
      if (forgotten && note.source === 'task' && note.source_task) this.db.prepare('INSERT OR IGNORE INTO memory_forgotten(task_id) VALUES(?)').run(note.source_task);
      this.db.prepare('DELETE FROM memory_search WHERE rowid=(SELECT rowid FROM memories WHERE id=?)').run(id);
      this.db.prepare('DELETE FROM memories WHERE id=?').run(id);
      return { ok: true };
    });
  }
  clear(input) {
    if (input.acknowledged !== true) throw invalid('清空需要明确确认。');
    const { scope, workspace } = this.scope(input);
    return this.atomic(() => {
      const notes = this.db.prepare('SELECT id,revision FROM memories WHERE scope=? AND workspace=?').all(scope, workspace);
      for (const note of notes) this.remove(note.id, note.revision);
      return { ok: true, removed: notes.length };
    });
  }
  search(input) {
    const { scope, workspace } = this.scope(input);
    if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 4000)) throw invalid('检索文字不能超过 4000 字符。');
    const limit = input.limit ?? 30, offset = input.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1000000) throw invalid('记忆分页参数无效。');
    const allTokens = searchTokens(input.query || '');
    const hasCjkPair = allTokens.some(token => /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2}$/u.test(token));
    const tokens = allTokens.filter(token => !hasCjkPair || !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(token)).slice(0, 32);
    const match = tokens.map(token => `"${token}"*`).join(' OR ');
    const where = 'm.scope=? AND m.workspace=?', args = [scope, workspace];
    const from = match ? 'memory_search JOIN memories m ON m.rowid=memory_search.rowid' : 'memories m';
    const filter = match ? 'memory_search MATCH ? AND ' : '';
    const bindings = match ? [match, ...args] : args;
    const total = this.db.prepare(`SELECT count(*) AS count FROM ${from} WHERE ${filter}${where}`).get(...bindings).count;
    const rows = this.db.prepare(`SELECT m.* FROM ${from} WHERE ${filter}${where} ORDER BY m.pinned DESC,${match ? 'bm25(memory_search),' : ''}m.updated_at DESC,m.id LIMIT ? OFFSET ?`).all(...bindings, limit, offset);
    return { notes: rows.map(row => ({ ...row, pinned: Boolean(row.pinned) })), total, offset, limit, policy: this.policy() };
  }
  prune(workspace, limit) {
    const rows = this.db.prepare("SELECT id,revision FROM memories WHERE workspace=? AND source='task' AND pinned=0 ORDER BY updated_at DESC,id LIMIT -1 OFFSET ?").all(workspace, limit);
    for (const row of rows) this.remove(row.id, row.revision, false);
  }
  capture(task) {
    const policy = this.policy();
    if (!policy.enabled || !policy.autoCapture || this.db.prepare('SELECT task_id FROM memory_forgotten WHERE task_id=?').get(task.id)) return null;
    const previous = this.db.prepare("SELECT id,revision FROM memories WHERE source='task' AND source_task=?").get(task.id);
    // Human edits create a tombstone above; pinned records also stop automatic updates.
    if (previous && this.get(previous.id).pinned) return null;
    const result = task.result ? JSON.parse(task.result) : null;
    const content = [`任务：${task.title}`, `状态：${task.state}`, task.checkpoint && `检查点：\n${task.checkpoint.slice(0, 5000)}`,
      result && `结果：\n${result.text.slice(0, 4000)}\n验证证据：\n${result.evidence.join('\n').slice(0, 2000)}`].filter(Boolean).join('\n\n').slice(0, 12000);
    return this.atomic(() => {
      const note = this.put({ ...previous, scope: 'project', workspace: task.workspace, kind: 'task', title: task.title || '任务记录', content }, { source: 'task', sourceTask: task.id });
      this.prune(projectKey(task.workspace), policy.autoLimit); return note;
    });
  }
  context(workspace, query = '') {
    if (!this.policy().enabled) return { enabled: false, notes: [], characters: 0 };
    const project = { scope: 'project', workspace };
    const preferences = this.db.prepare("SELECT * FROM memories WHERE (scope='user' OR (scope='project' AND workspace=?)) AND (kind='preference' OR pinned=1) ORDER BY pinned DESC,updated_at DESC,id LIMIT 12").all(projectKey(workspace));
    const related = this.search({ ...project, query: String(query).slice(0, 4000), limit: 20 }).notes;
    const notes = [], ids = new Set(); let characters = 0;
    for (const row of [...preferences, ...related]) {
      if (ids.has(row.id) || notes.length === 12) continue;
      const note = { id: row.id, scope: row.scope, kind: row.kind, title: row.title, source: row.source, updatedAt: row.updated_at, content: row.content.slice(0, 3000) };
      const size = JSON.stringify(note).length;
      if (characters + size > 8000) continue;
      notes.push(note); ids.add(row.id); characters += size;
    }
    return { enabled: true, referenceOnly: true, notes, characters };
  }
}
