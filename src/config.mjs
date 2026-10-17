import { homedir, platform } from 'node:os';
import { resolve, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const appRoot = fileURLToPath(new URL('..', import.meta.url));
export function dataDirectory(env = process.env) {
  if (env.DEVSPACE_SHELL_DATA) return resolve(env.DEVSPACE_SHELL_DATA);
  return platform() === 'win32' ? join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'DevSpaceShell', 'data')
    : join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'devspace-shell');
}
export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}
export function writeJson(path, value) {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}
export function loadConfig(dataDir = dataDirectory()) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'config.json');
  const value = readJson(path) || {
    version: 1, installationId: randomBytes(16).toString('hex'),
    adminToken: randomBytes(32).toString('base64url'),
    workspace: '', commandRuntime: 'native', executor: { mode: 'manual' },
    plugin: null, modelLabel: '', autoDispatch: false,
  };
  if (value.version !== 1 || !value.adminToken || !value.installationId) throw new Error('配置格式无效，请保留数据并查看故障排查说明。');
  if (!existsSync(path)) writeJson(path, value);
  return { dataDir, config: value, save: () => writeJson(path, value) };
}
