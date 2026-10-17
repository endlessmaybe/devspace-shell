import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { choosePlugin, discoverPlugins, probeMcp, restorePair } from '../src/plugins.mjs';
import { taskPrompt, pairingPrompt } from '../src/prompts.mjs';
import { createServer } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { temp } from './helpers.mjs';

const fixture = version => JSON.parse(readFileSync(new URL(`./fixtures/devspace-${version}.json`, import.meta.url), 'utf8'));
for (const [version, profile, workspace, session] of [
  ['1.0.8', 'codex-camel', 'workspaceId', 'sessionId'],
  ['1.1.0-beta.4', 'codex-snake', 'workspace_id', 'session_id'],
]) {
  test(`published DevSpace ${version} input schemas pair under a renamed connector and generate correct calls`, () => {
    const input = fixture(version);
    input.tools.forEach(t => t.name = `mcp__我的自定义插件__${t.name}`);
    const plugin = choosePlugin(input);
    assert.equal(plugin.compatibility.profile, profile);
    assert.equal(plugin.tools.exec.arguments.workspace, workspace);
    assert.equal(plugin.tools.stdin.arguments.session, session);
    assert.equal(plugin.compatibility.versionVerified, false);
    const prompt = taskPrompt({ plugin }, { id: 'task', executor_token: 'sample', request: 'read documentation' }, 'http://127.0.0.1:1234');
    assert.ok(prompt.includes(`返回工作区字段：${workspace}`));
    assert.ok(prompt.includes(`进程会话字段：${session}`));
    assert.ok(prompt.includes(`"workspace":"${workspace}"`));
    assert.ok(prompt.includes('Schema 改变则停止'));
  });
  test(`DevSpace ${version} pairing persists, survives restart and exposes compatibility without losing tasks`, async t => {
    const dataDir = temp('version-upgrade');
    const app = await createServer({ dataDir, port: 0 });
    const row = app.store.create({ request: 'retain this task', workspace: dataDir });
    const response = await fetch(`${app.url}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: app.store.ticket(), catalog: fixture(version) }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).compatibility.profile, profile);
    await app.stop();
    const restarted = await createServer({ dataDir, port: 0 }); t.after(() => restarted.stop());
    assert.equal(restarted.config.plugin.tools.exec.arguments.workspace, workspace);
    assert.equal(restarted.store.get(row.id).state, 'queued');
    assert.equal(restarted.config.plugin.compatible, true);
  });
}
test('mixed camel and snake required arguments cannot form one compatible profile', () => {
  const input = fixture('1.0.8'); input.tools[2] = fixture('1.1.0-beta.4').tools[2];
  assert.equal(discoverPlugins(input).some(p => p.compatible), false);
  assert.throws(() => choosePlugin(input), /不能混用/);
});
test('new unknown required arguments and contradictory output schemas require an adapter', () => {
  const input = fixture('1.1.0-beta.4'); input.tools[1].inputSchema.required.push('new_required_option');
  input.tools[1].inputSchema.properties.new_required_option = { type: 'string' };
  assert.throws(() => choosePlugin(input), /额外必填项/);
  const other = fixture('1.1.0-beta.4'); other.tools[0].outputSchema = { type: 'object', properties: { workspaceId: { type: 'string' } } };
  assert.throws(() => choosePlugin(other));
});
test('version labels never override the real schema and unknown versions stay schema-only', () => {
  const input = fixture('1.0.8');
  assert.equal(choosePlugin(input).compatibility.reportedVersion, '0.1.0');
  assert.equal(choosePlugin(input).compatibility.level, 'schema-only');
  input.serverInfo.version = '99.0.0';
  assert.equal(choosePlugin(input).compatibility.level, 'schema-only');
  input.serverInfo.version = '1.1.0-beta.4';
  assert.equal(choosePlugin(input).compatibility.profile, 'codex-camel');
  assert.equal(choosePlugin(input).compatibility.level, 'schema-only');
});
test('old 0.1.0 pairing is upgraded from its recorded schemas and bad pairings block new dispatch', async t => {
  const valid = choosePlugin(fixture('1.0.8'));
  const old = { ...valid, pairedAt: '2026-01-01T00:00:00.000Z' }; delete old.compatibility;
  Object.values(old.tools).forEach(tool => { delete tool.arguments; });
  assert.equal(restorePair(old).tools.exec.arguments.workspace, 'workspaceId');
  const dataDir = temp('invalid-old-pair'), loaded = loadConfig(dataDir);
  loaded.config.plugin = { pairedAt: old.pairedAt, tools: {} };
  Object.assign(loaded.config.executor, { mode: 'desktop', callerThreadId: 'sample-caller', destinationThreadId: 'sample-target' }); loaded.config.autoDispatch = true; loaded.save();
  let sends = 0;
  const app = await createServer({ dataDir, port: 0, send: async () => { sends++; return { sent: true }; } }); t.after(() => app.stop());
  const row = app.store.create({ request: 'must not be dispatched', workspace: dataDir });
  const response = await fetch(`${app.url}/api/tasks/${row.id}/dispatch`, { method: 'POST', headers: { Authorization: `Bearer ${app.config.adminToken}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 400); assert.equal(sends, 0); assert.equal(app.store.get(row.id).state, 'queued');
});
test('pairing prompt requests actual version metadata and both input contracts', () => {
  const text = pairingPrompt({ workspace: 'sample', commandRuntime: 'native' }, 'http://127.0.0.1:1234', 'sample');
  assert.match(text, /serverInfo/); assert.match(text, /workspace_id/); assert.match(text, /1\.0\.8 服务可能声明 0\.1\.0/);
});
for (const protocol of ['2025-06-18', '2026-07-28']) test(`stateless MCP probe sends negotiated ${protocol} on all later requests`, async () => {
  const input = fixture('1.1.0-beta.4'), calls = [];
  const result = await probeMcp('http://127.0.0.1:1234/mcp', { fetchImpl: async (_url, request) => {
    const message = JSON.parse(request.body); calls.push(message.method);
    if (message.method === 'initialize') return Response.json({ id: message.id, result: { protocolVersion: protocol, capabilities: { tools: {} }, serverInfo: input.serverInfo } });
    assert.equal(request.headers['MCP-Protocol-Version'], protocol);
    assert.equal(request.headers['Mcp-Session-Id'], undefined);
    if (!message.id) return new Response(null, { status: 202 });
    return Response.json({ id: message.id, result: { tools: input.tools } });
  } });
  assert.equal(result.protocolVersion, protocol); assert.equal(result.candidates[0].compatibility.profile, 'codex-snake');
  assert.deepEqual(calls, ['initialize', 'notifications/initialized', 'tools/list']);
});
test('unsupported protocol is rejected before catalog access or any tool call', async () => {
  const methods = [];
  await assert.rejects(probeMcp('http://127.0.0.1:1234/mcp', { fetchImpl: async (_url, request) => {
    const m = JSON.parse(request.body); methods.push(m.method);
    return Response.json({ id: m.id, result: { protocolVersion: '2099-01-01', capabilities: { tools: {} } } });
  } }), /不支持/);
  assert.deepEqual(methods, ['initialize']);
});
