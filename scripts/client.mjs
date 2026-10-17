import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export async function run(args = process.argv.slice(2), { environment = process.env } = {}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { ticket: { type: 'string' }, catalog: { type: 'string' }, action: { type: 'string' }, body: { type: 'string' } } });
  if (!values.ticket) throw new Error('缺少 --ticket；请从控制台重新复制口令。');
  const ticket = JSON.parse(Buffer.from(values.ticket, 'base64url').toString('utf8'));
  const url = new URL(ticket.url);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('口令中的本机地址无效。');
  let endpoint, input, token;
  if (positionals[0] === 'pair') {
    if (!values.catalog) throw new Error('请通过 --catalog 提供实际工具目录 JSON。');
    endpoint = '/api/pair'; input = { nonce: ticket.nonce, catalog: JSON.parse(values.catalog) };
  } else if (positionals[0] === 'desktop-connect') {
    const callerThreadId = String(environment.CODEX_THREAD_ID || '').trim();
    if (!callerThreadId) throw new Error('当前命令环境缺少桌面调用上下文。请将连接口令发给兼容 Codex 桌面客户端，使用其本地终端执行，无需手填聊天 ID。');
    endpoint = '/api/desktop/bootstrap'; input = { nonce: ticket.nonce, callerThreadId };
  } else if (positionals[0] === 'task' && /^[a-f0-9-]{36}$/.test(ticket.taskId)) {
    const action = values.action || 'get';
    if (!['get', 'claim', 'heartbeat', 'activity', 'checkpoint', 'complete'].includes(action)) throw new Error('不支持的任务动作。');
    endpoint = `/api/executor/${ticket.taskId}${action === 'get' ? '' : '/' + action}`;
    input = action === 'get' ? null : JSON.parse(values.body || '{}'); token = ticket.token;
  } else throw new Error('用法：client.mjs pair|desktop-connect|task --ticket <口令> ...');
  const response = await fetch(new URL(endpoint, url), { method: input ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await run(), null, 2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
