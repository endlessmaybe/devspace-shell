import http from 'node:http';
import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, appRoot, writeJson } from './config.mjs';
import { Store, equalToken, failure } from './store.mjs';
import { choosePlugin, discoverPlugins, probeMcp, restorePair } from './plugins.mjs';
import { pairingPrompt, taskPrompt, desktopConnectPrompt } from './prompts.mjs';
import { Controller } from './controller.mjs';
import { listHiddenExecutors, verifyHiddenExecutor } from './adapters/desktop-pipe.mjs';

const version = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).version;
const staticFiles = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/styles.css', ['styles.css', 'text/css']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]]);
function publicConfig(config) {
  const { adminToken, installationId, executor, ...safe } = config;
  return { ...safe, executor: { mode: executor.mode, bound: Boolean(executor.callerThreadId && executor.destinationThreadId),
    title: executor.destinationTitle || (executor.destinationThreadId ? '已绑定的专用隐藏会话' : ''), connectedAt: executor.connectedAt || null } };
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
export async function createServer({ dataDir, port = 17861, writeInstance = true, send, environment = process.env,
  listExecutors = listHiddenExecutors, verifyExecutor = verifyHiddenExecutor } = {}) {
  const loaded = loadConfig(dataDir), { config } = loaded;
  if (config.plugin?.pairedAt) { config.plugin = restorePair(config.plugin); loaded.save(); }
  const store = new Store(join(loaded.dataDir, 'tasks.sqlite'));
  let url, closing = false, interval;
  const controller = new Controller({ store, config, url: () => url, ...(send ? { send } : {}) });
  const callerContext = () => config.executor.callerThreadId || String(environment.CODEX_THREAD_ID || '').trim();
  const idleSettings = () => {
    if (store.hasActiveTask() || controller.busy) throw failure('请先处理当前任务或等待连接完成，再更换执行会话。');
  };
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
      if (path === '/api/desktop/bootstrap' && req.method === 'POST') {
        const input = await body(req); idleSettings();
        store.consumeTicket(input.nonce, () => {
          if (typeof input.callerThreadId !== 'string' || !input.callerThreadId.trim() || input.callerThreadId.length > 150) throw failure('客户端未提供有效调用上下文。', 400);
          config.executor.callerThreadId = input.callerThreadId.trim(); loaded.save();
        }, 'desktop');
        return json(res, 200, { ok: true, message: '桌面调用上下文已自动连接。请回到工作台识别并选择专用隐藏会话。' });
      }
      if (path === '/api/pair' && req.method === 'POST') {
        const input = await body(req);
        if (store.hasActiveTask()) throw failure('请先处理当前执行任务，再切换配对的插件。');
        const selected = store.consumeTicket(input.nonce, () => choosePlugin(input.catalog, input.selectedId));
        config.plugin = { ...selected, pairedAt: new Date().toISOString(), proof: 'command-callback', modelVerified: false };
        loaded.save();
        return json(res, 200, { ok: true, plugin: config.plugin.label, compatibility: config.plugin.compatibility, message: '工具契约与命令回连配对完成；版本声明及模型身份未核验。' });
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
      if (path === '/api/desktop/ticket') {
        idleSettings();
        return json(res, 200, { prompt: desktopConnectPrompt(config, url, store.ticket('desktop')), expiresInSeconds: 600 });
      }
      if (path === '/api/desktop/list') {
        const callerThreadId = callerContext();
        if (!callerThreadId) return json(res, 200, { needsBootstrap: true, threads: [] });
        if (input.cursor !== undefined && (typeof input.cursor !== 'string' || !input.cursor.trim() || input.cursor.length > 4096)) throw failure('翻页参数无效。', 400);
        return json(res, 200, await controller.admission.run('list_hidden_executors', () => listExecutors({ callerThreadId, cursor: input.cursor })));
      }
      if (path === '/api/desktop/connect') {
        idleSettings();
        const callerThreadId = callerContext();
        if (!callerThreadId) throw failure('请先使用自动连接口令完成桌面连接。', 400);
        if (config.executor.mode !== 'desktop') throw failure('请先保存“桌面隐藏会话”执行方式。', 400);
        if (typeof input.selection !== 'string' || !input.selection.trim() || input.selection.length > 150) throw failure('请选择专用隐藏会话。', 400);
        controller.busy = true;
        try {
          const selected = await controller.admission.run('verify_hidden_executor', () => verifyExecutor({ callerThreadId, destinationThreadId: input.selection }));
          if (store.hasActiveTask()) throw failure('已有任务领取执行槽，保留原会话。');
          if (selected?.id !== input.selection) throw failure('客户端返回了不同会话，连接未保存。', 400);
          Object.assign(config.executor, { callerThreadId, destinationThreadId: selected.id, destinationTitle: selected.title, connectedAt: new Date().toISOString() });
          loaded.save(); return json(res, 200, { ok: true, title: selected.title });
        } finally { controller.busy = false; }
      }
      if (path === '/api/setup') {
        if (controller.busy) throw failure('派发或连接正在进行，请稍后保存设置。');
        const next = {
          workspace: input.workspace ? validateWorkspace(input.workspace) : '',
          commandRuntime: ['native', 'wsl'].includes(input.commandRuntime) ? input.commandRuntime : 'native',
          modelLabel: String(input.modelLabel || '').slice(0, 100),
          autoDispatch: input.autoDispatch === true,
          executor: { ...config.executor, mode: input.executor?.mode === 'desktop' ? 'desktop' : 'manual' },
        };
        if (next.autoDispatch && (next.executor.mode !== 'desktop' || !next.executor.callerThreadId || !next.executor.destinationThreadId)) throw failure('请先连接专用隐藏会话，再开启自动派发。', 400);
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
          if (!config.plugin?.pairedAt || config.plugin.compatible === false) throw failure('请先在 GPT 中重新核对版本与插件契约并完成配对。');
          return json(res, 200, { prompt: taskPrompt(config, store.get(id, true), url) });
        }
        if (action === 'dispatch') return json(res, 200, { task: await controller.dispatch(id) });
        return json(res, 200, { task: store.action(id, input.action, input.acknowledged === true) });
      }
      const mcpAction = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/executor$/);
      if (mcpAction) {
        if (!config.plugin?.pairedAt || config.plugin.compatible === false) throw failure('请先通过 DevSpace 插件重新核对版本并完成配对。');
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
