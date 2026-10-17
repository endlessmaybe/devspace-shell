import http from 'node:http';
import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, appRoot, writeJson } from './config.mjs';
import { Store, equalToken, failure } from './store.mjs';
import { choosePlugin, discoverPlugins, probeMcp } from './plugins.mjs';
import { pairingPrompt, taskPrompt } from './prompts.mjs';
import { Controller } from './controller.mjs';

const version = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).version;
const staticFiles = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/styles.css', ['styles.css', 'text/css']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]]);
function publicConfig(config) {
  const { adminToken, installationId, ...safe } = config;
  return safe;
}
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw failure('请使用 JSON 请求。', 415);
  let size = 0, chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 600_000) throw failure('请求内容过大。', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('JSON 格式无效。', 400); }
}
function validateWorkspace(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || !existsSync(value) || !statSync(value).isDirectory()) throw failure('项目目录必须是本机存在的绝对路径。', 400);
  return realpathSync(value);
}
export async function createServer({ dataDir, port = 17861, writeInstance = true, send } = {}) {
  const loaded = loadConfig(dataDir), { config } = loaded;
  const store = new Store(join(loaded.dataDir, 'tasks.sqlite'));
  let url, closing = false, interval;
  const controller = new Controller({ store, config, url: () => url, ...(send ? { send } : {}) });
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(url).host) throw failure('Host 不匹配，请使用启动时显示的地址。', 403);
      if (req.headers.origin && req.headers.origin !== url) throw failure('不允许跨站请求。', 403);
      const target = new URL(req.url, url), path = target.pathname;
      if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true, app: 'devspace-shell', version, installationId: config.installationId });
      if (req.method === 'GET' && staticFiles.has(path)) {
        const [name, type] = staticFiles.get(path);
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' }); return res.end(readFileSync(join(appRoot, 'public', name)));
      }
      const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
      if (path === '/api/pair' && req.method === 'POST') {
        const input = await body(req);
        if (store.hasActiveTask()) throw failure('请先处理当前执行任务，再切换配对的插件。');
        const selected = store.consumeTicket(input.nonce, () => choosePlugin(input.catalog, input.selectedId));
        config.plugin = { ...selected, pairedAt: new Date().toISOString(), proof: 'command-callback', modelVerified: false };
        loaded.save();
        return json(res, 200, { ok: true, plugin: config.plugin.label, message: '命令回连配对完成；模型身份未核验。' });
      }
      const executor = path.match(/^\/api\/executor\/([a-f0-9-]{36})(?:\/([a-z]+))?$/);
      if (executor) {
        const [, id, action] = executor;
        store.authorize(id, token);
        if (req.method === 'GET' && !action) return json(res, 200, { task: store.get(id), events: store.events(id) });
        if (req.method !== 'POST' || !action) throw failure('请求方法不支持。', 405);
        const input = await body(req), { commandId, ...details } = input;
        return json(res, 200, store.command(id, token, commandId, action, details));
      }
      if (!equalToken(token, config.adminToken)) throw failure('请从启动器打开控制台以完成本机认证。', 401);
      if (req.method === 'GET' && path === '/api/status') return json(res, 200, { version, config: publicConfig(config), readiness: controller.readiness(), dataDir: loaded.dataDir, tasks: store.list() });
      if (req.method === 'GET' && path === '/api/config/client') return json(res, 200, { mcpServers: { 'devspace-shell-tasks': { command: process.execPath, args: [join(appRoot, 'src', 'mcp-stdio.mjs')], env: { DEVSPACE_SHELL_DATA: loaded.dataDir } } } });
      if (req.method === 'GET' && path.startsWith('/api/tasks/')) {
        const id = path.slice('/api/tasks/'.length); return json(res, 200, { task: store.get(id), events: store.events(id) });
      }
      if (req.method !== 'POST') throw failure('入口不存在。', 404);
      const input = await body(req);
      if (path === '/api/setup') {
        const next = {
          workspace: input.workspace ? validateWorkspace(input.workspace) : '',
          commandRuntime: ['native', 'wsl'].includes(input.commandRuntime) ? input.commandRuntime : 'native',
          modelLabel: String(input.modelLabel || '').slice(0, 100),
          autoDispatch: input.autoDispatch === true,
          executor: { mode: input.executor?.mode === 'desktop' ? 'desktop' : 'manual',
            callerThreadId: String(input.executor?.callerThreadId || '').trim().slice(0, 150),
            destinationThreadId: String(input.executor?.destinationThreadId || '').trim().slice(0, 150) },
        };
        if (next.autoDispatch && (next.executor.mode !== 'desktop' || !next.executor.callerThreadId || !next.executor.destinationThreadId)) throw failure('自动派发需要完整的桌面执行器配置。', 400);
        if (store.hasActiveTask() && (next.workspace !== config.workspace || JSON.stringify(next.executor) !== JSON.stringify(config.executor) || next.commandRuntime !== config.commandRuntime)) throw failure('请先处理当前任务，再切换项目或执行器。');
        Object.assign(config, next); loaded.save(); return json(res, 200, { config: publicConfig(config) });
      }
      if (path === '/api/plugins/discover') return json(res, 200, { candidates: discoverPlugins(input.catalog) });
      if (path === '/api/plugins/probe') return json(res, 200, await probeMcp(input.url, { bearer: String(input.bearer || '') }));
      if (path === '/api/plugins/ticket') {
        if (!config.workspace) throw failure('请先保存你的项目目录，再生成配对口令。', 400);
        const nonce = store.ticket(); return json(res, 200, { prompt: pairingPrompt(config, url, nonce), expiresInSeconds: 600 });
      }
      if (path === '/api/plugins/reset') {
        if (store.hasActiveTask()) throw failure('请先处理当前执行任务。');
        store.db.prepare('DELETE FROM tickets').run();
        config.plugin = null; loaded.save(); return json(res, 200, { ok: true });
      }
      if (path === '/api/tasks') {
        const workspace = validateWorkspace(input.workspace || config.workspace);
        return json(res, 201, { task: store.create({ title: input.title, request: input.request, workspace }) });
      }
      const taskAction = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/(prompt|dispatch|action)$/);
      if (taskAction) {
        const [, id, action] = taskAction;
        if (action === 'prompt') {
          if (!config.plugin?.pairedAt) throw failure('请先在 GPT 中完成插件配对。');
          return json(res, 200, { prompt: taskPrompt(config, store.get(id, true), url) });
        }
        if (action === 'dispatch') return json(res, 200, { task: await controller.dispatch(id) });
        return json(res, 200, { task: store.action(id, input.action, input.acknowledged === true) });
      }
      const mcpAction = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/executor$/);
      if (mcpAction) {
        if (!config.plugin?.pairedAt) throw failure('请先通过 DevSpace 插件完成配对。');
        const row = store.get(mcpAction[1], true), { action, commandId, ...details } = input;
        return json(res, 200, store.command(row.id, row.executor_token, commandId, action, details));
      }
      if (path === '/api/system/stop') {
        json(res, 200, { ok: true }); setTimeout(() => stop(), 20); return;
      }
      if (path === '/api/system/autostart') {
        if (process.platform !== 'win32') throw failure('登录启动项设置目前仅支持 Windows。', 400);
        if (typeof input.enabled !== 'boolean' && input.statusOnly !== true) throw failure('请明确选择开启或关闭。', 400);
        const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(appRoot, 'scripts', 'autostart.ps1'), '-Mode', input.statusOnly ? 'Status' : input.enabled ? 'Enable' : 'Disable', '-NodePath', process.execPath, '-DataDir', loaded.dataDir], { timeout: 15000, windowsHide: true, encoding: 'utf8' });
        return json(res, 200, input.statusOnly ? JSON.parse(result.stdout.trim()) : { enabled: input.enabled });
      }
      throw failure('入口不存在。', 404);
    } catch (error) { if (!res.headersSent) json(res, error.status || 400, { error: error.message }); else res.end(); }
  });
  server.requestTimeout = 45_000; server.headersTimeout = 10_000;
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise((done, fail) => { const error = e => { server.off('listening', done); fail(e); }; server.once('error', error); server.once('listening', () => { server.off('error', error); done(); }); server.listen(port ? port + attempt : 0, '127.0.0.1'); });
      break;
    } catch (error) { if (error.code !== 'EADDRINUSE' || attempt >= 19 || !port) { store.close(); throw error; } }
  }
  url = `http://127.0.0.1:${server.address().port}`;
  if (writeInstance) writeJson(join(loaded.dataDir, 'instance.json'), { url, pid: process.pid, installationId: config.installationId, version });
  interval = setInterval(() => controller.tick().catch(() => {}), 2000); interval.unref();
  const stop = async () => {
    if (closing) return; closing = true; clearInterval(interval);
    await new Promise(done => { server.close(done); server.closeIdleConnections(); });
    store.close();
  };
  return { server, store, config, url, dataDir: loaded.dataDir, stop };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createServer({ port: Number(process.env.DEVSPACE_SHELL_PORT || 17861) });
  console.log(`DevSpace Shell ${version}: ${app.url}`);
  let stopped = false;
  const finish = async () => { if (stopped) return; stopped = true; await app.stop(); process.exit(0); };
  process.on('SIGINT', finish); process.on('SIGTERM', finish);
  app.server.on('close', () => process.exit(0));
}
