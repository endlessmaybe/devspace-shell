import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const temp = name => mkdtempSync(join(process.env.DEVSPACE_SHELL_TEST_ROOT || tmpdir(), `devshell-${name}-`));
export function catalog(prefix = '', serverId) {
  const make = (name, properties) => ({ name: prefix + name, ...(serverId ? { serverId } : {}), inputSchema: { type: 'object', properties: Object.fromEntries(Object.entries(properties).map(([key, type]) => [key, { type }])), required: Object.keys(properties) } });
  return { tools: [make('open_workspace', { path: 'string' }), make('exec_command', { workspaceId: 'string', cmd: 'string' }), make('write_stdin', { workspaceId: 'string', sessionId: 'number' }), make('apply_patch', { workspaceId: 'string', patch: 'string' })] };
}
