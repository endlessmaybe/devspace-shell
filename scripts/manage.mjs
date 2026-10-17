import { spawn } from 'node:child_process';
import { openSync, closeSync, existsSync, mkdirSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, readJson, appRoot, writeJson } from '../src/config.mjs';

export async function liveInstance(loaded) {
  const instance = readJson(join(loaded.dataDir, 'instance.json'));
  if (!instance || instance.installationId !== loaded.config.installationId) return null;
  try {
    const url = new URL(instance.url); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return null;
    const response = await fetch(new URL('/healthz', url), { signal: AbortSignal.timeout(1500), redirect: 'error' });
    const health = await response.json();
    return response.ok && health.app === 'devspace-shell' && health.installationId === instance.installationId ? instance : null;
  } catch { return null; }
}
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }); child.on('error', () => {}); child.unref();
}
export async function manage(action = 'start', { open = false, dataDir } = {}) {
  const loaded = loadConfig(dataDir), lock = join(loaded.dataDir, 'start.lock'), supervisorPath = join(loaded.dataDir, 'supervisor.json');
  if (action === 'status') return { running: Boolean(await liveInstance(loaded)), instance: await liveInstance(loaded), dataDir: loaded.dataDir };
  if (action === 'stop') {
    writeJson(join(loaded.dataDir, 'stop.json'), { installationId: loaded.config.installationId, at: Date.now() });
    const instance = await liveInstance(loaded);
    if (instance) {
      const response = await fetch(new URL('/api/system/stop', instance.url), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loaded.config.adminToken}` }, body: '{}', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('服务未确认停止，请检查状态。');
    }
    for (let n = 0; n < 80; n++) {
      const supervisor = readJson(supervisorPath);
      if (!await liveInstance(loaded) && !supervisor?.pid) return { stopped: true };
      if (!await liveInstance(loaded) && supervisor?.pid) {
        try { process.kill(supervisor.pid, 0); } catch { return { stopped: true }; }
      }
      await delay(100);
    }
    throw new Error('停止尚未完成，请保留任务并查看日志。');
  }
  if (action !== 'start') throw new Error('用法：manage.mjs start|stop|status [--open]');
  let instance = await liveInstance(loaded), acquired = false;
  try {
    if (!instance) {
      try { mkdirSync(lock); acquired = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (acquired) {
        rmSync(join(loaded.dataDir, 'stop.json'), { force: true });
        const previous = readJson(supervisorPath);
        let exists = false;
        if (previous?.installationId === loaded.config.installationId && previous.pid) {
          try { process.kill(previous.pid, 0); exists = true; } catch {}
        }
        if (!exists) {
          const logPath = join(loaded.dataDir, 'service.log');
          // Bound the current log; user data never goes into the source tree.
          if (existsSync(logPath) && statSync(logPath).size > 5_000_000) rmSync(logPath);
          const log = openSync(logPath, 'a', 0o600);
          try {
            const child = spawn(process.execPath, [join(appRoot, 'scripts', 'supervisor.mjs')], {
              cwd: appRoot, env: { ...process.env, DEVSPACE_SHELL_DATA: loaded.dataDir }, detached: true, stdio: ['ignore', log, log], windowsHide: true,
            });
            await new Promise((done, fail) => { child.once('spawn', done); child.once('error', fail); }); child.unref();
          } finally { closeSync(log); }
        }
      }
      for (let n = 0; n < 100; n++) { instance = await liveInstance(loaded); if (instance) break; await delay(150); }
    }
    if (!instance) throw new Error(`启动未完成，请查看 ${join(loaded.dataDir, 'service.log')}。若上次启动被中断，确认没有本程序进程后删除 start.lock 再试。`);
    if (open) openBrowser(`${instance.url}/#token=${loaded.config.adminToken}`);
    return { running: true, url: instance.url, dataDir: loaded.dataDir };
  } finally { if (acquired) rmdirSync(lock); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await manage(process.argv[2], { open: process.argv.includes('--open') }), null, 2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
