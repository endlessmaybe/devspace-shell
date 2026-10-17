import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { dataDirectory, readJson } from './config.mjs';

const string = description => ({ type: 'string', description });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const taskId = string('Task identifier returned by devshell_list_tasks or devshell_create_task.');
const commandId = string('Stable unique identifier; reuse it only for an identical request retry.');
const leaseId = string('lease_id returned by devshell_claim_task.');
const tools = [
  ['devshell_list_tasks', 'List durable tasks and their actual lifecycle state.', object({}), true],
  ['devshell_get_task', 'Read a task, checkpoints and business activity.', object({ taskId }, ['taskId']), true],
  ['devshell_create_task', 'Create a task explicitly requested by the user. Requires a local project directory.', object({ request: string('User task'), title: string('Short title'), workspace: string('Absolute project directory') }, ['request']), false],
  ['devshell_claim_task', 'Claim one task after DevSpace plugin pairing. Do not bypass a busy or expired lease.', object({ taskId, commandId }, ['taskId', 'commandId']), false],
  ['devshell_heartbeat', 'Renew a task lease. This does not count as business progress.', object({ taskId, commandId, leaseId }, ['taskId', 'commandId', 'leaseId']), false],
  ['devshell_activity', 'Record real business progress.', object({ taskId, commandId, leaseId, text: string('Actual progress') }, ['taskId', 'commandId', 'leaseId', 'text']), false],
  ['devshell_checkpoint', 'Save a recoverable checkpoint, command sessions and uncertain effects.', object({ taskId, commandId, leaseId, text: string('Checkpoint') }, ['taskId', 'commandId', 'leaseId', 'text']), false],
  ['devshell_complete_task', 'Finish with actual validation evidence.', object({ taskId, commandId, leaseId, result: string('Result'), evidence: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['taskId', 'commandId', 'leaseId', 'result', 'evidence']), false],
].map(([name, description, inputSchema, readOnlyHint]) => ({ name, description, inputSchema, annotations: { readOnlyHint, destructiveHint: false, openWorldHint: false } }));
async function api(path, input) {
  const dir = dataDirectory(), config = readJson(join(dir, 'config.json')), instance = readJson(join(dir, 'instance.json'));
  if (!config || !instance || instance.installationId !== config.installationId) throw new Error('Start DevSpace Shell first.');
  const url = new URL(instance.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Invalid local instance.');
  const response = await fetch(new URL(path, url), { method: input ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.adminToken}` }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
const actions = { devshell_claim_task: 'claim', devshell_heartbeat: 'heartbeat', devshell_activity: 'activity', devshell_checkpoint: 'checkpoint', devshell_complete_task: 'complete' };
export async function handle(message) {
  if (message.method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'devspace-shell-tasks', version: '0.1.0' }, instructions: 'DevSpace Shell is the durable task controller. Coding/file/command operations require the separately paired DevSpace connector. Never infer its namespace from display name.' };
  if (message.method === 'ping') return {};
  if (message.method === 'tools/list') return { tools };
  if (message.method === 'tools/call') {
    const name = message.params?.name, input = message.params?.arguments || {};
    if (!tools.some(t => t.name === name)) throw new Error('Unknown tool');
    try {
      let result;
      if (name === 'devshell_list_tasks') result = (await api('/api/status')).tasks;
      else if (name === 'devshell_create_task') result = await api('/api/tasks', input);
      else {
        if (!/^[a-f0-9-]{36}$/.test(input.taskId || '')) throw new Error('Invalid taskId');
        if (name === 'devshell_get_task') result = await api(`/api/tasks/${input.taskId}`);
        else { const { taskId, ...body } = input; result = await api(`/api/tasks/${taskId}/executor`, { ...body, action: actions[name] }); }
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  }
  throw new Error('Method not found');
}
if (!process.env.DEVSPACE_SHELL_MCP_IMPORT_ONLY) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (Buffer.byteLength(line) > 600_000) continue;
    let message;
    try {
      message = JSON.parse(line); if (message.id === undefined) continue;
      const result = await handle(message); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
    } catch (error) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32601, message: error.message } }) + '\n'); }
  }
}
