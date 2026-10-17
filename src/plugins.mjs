import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const shellVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const protocols = new Set(['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28']);
const profiles = [
  { id: 'codex-camel', baseline: 'DevSpace 1.0.8', workspace: 'workspaceId', session: 'sessionId', exit: 'exitCode', configuration: 'DEVSPACE_TOOL_MODE=codex' },
  { id: 'codex-snake', baseline: 'DevSpace 1.1.0-beta.4', workspace: 'workspace_id', session: 'session_id', exit: 'exit_code', configuration: 'config.jsonc: tools.mode=codex' },
];

const roles = {
  open: { names: ['open_workspace'], props: { path: 'string' } },
  exec: { names: ['exec_command'], props: { workspace: 'string', cmd: 'string' } },
  stdin: { names: ['write_stdin'], props: { workspace: 'string', session: 'number' } },
  patch: { names: ['apply_patch'], props: { workspace: 'string', patch: 'string' } },
};
const stripType = schema => schema?.type || (schema?.anyOf || schema?.oneOf || []).find(s => s.type && s.type !== 'null')?.type;
function compatible(schema, properties) {
  return schema?.type === 'object' && Array.isArray(schema.required) && schema.required.every(name => Object.hasOwn(properties, name)) && Object.entries(properties).every(([name, type]) => {
    const actual = stripType(schema.properties?.[name]);
    return schema.required?.includes(name) && (actual === type || (type === 'number' && actual === 'integer'));
  });
}
function roleFor(tool, profile) {
  for (const [role, spec] of Object.entries(roles)) for (const base of spec.names) {
    const i = tool.name.length - base.length;
    const argumentsMap = Object.fromEntries(Object.keys(spec.props).map(key => [key, profile[key] || key]));
    const props = Object.fromEntries(Object.entries(spec.props).map(([key, type]) => [argumentsMap[key], type]));
    if (i >= 0 && tool.name.slice(i) === base && (i === 0 || /[_./:-]$/.test(tool.name.slice(0, i))) && compatible(tool.inputSchema, props)) {
      const outputName = role === 'open' ? profile.workspace : ['exec', 'stdin'].includes(role) ? profile.session : null;
      const output = outputName && tool.outputSchema?.properties;
      if (output && (!output[outputName] || !['string', 'number', 'integer'].includes(stripType(output[outputName])) || (role === 'open' ? stripType(output[outputName]) !== 'string' : !['number', 'integer'].includes(stripType(output[outputName]))))) continue;
      return { role, prefix: tool.name.slice(0, i), argumentsMap };
    }
  }
  return null;
}
export function discoverPlugins(catalog) {
  const tools = Array.isArray(catalog) ? catalog : catalog?.tools;
  if (!Array.isArray(tools) || tools.length > 2000) throw new Error('需要工具描述数组（最多 2000 项），每项包含 name 和 inputSchema。');
  const groups = new Map();
  for (const profile of profiles) for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || tool.name.length > 300) continue;
    const match = roleFor(tool, profile);
    if (!match) continue;
    const serverId = String(tool.serverId || catalog?.serverId || 'endpoint');
    const key = `${serverId}:${match.prefix}:${profile.id}`;
    const group = groups.get(key) || { id: `${serverId}:${match.prefix}`, serverId, prefix: match.prefix, profile, tools: {}, ambiguousRoles: [] };
    if (group.tools[match.role]) group.ambiguousRoles.push(match.role);
    group.tools[match.role] = { name: tool.name, inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}), arguments: match.argumentsMap };
    groups.set(key, group);
  }
  const candidates = [...groups.values()].map(group => {
    const missing = Object.keys(roles).filter(role => !group.tools[role]);
    const fingerprint = createHash('sha256').update(JSON.stringify([group.profile.id, ...Object.keys(group.tools).sort().map(role => [role, group.tools[role].name, group.tools[role].inputSchema, group.tools[role].outputSchema])])).digest('hex');
    const reportedVersion = typeof catalog?.serverInfo?.version === 'string' ? catalog.serverInfo.version.slice(0, 100) : null;
    const compatibility = { profile: group.profile.id, baseline: group.profile.baseline, reportedVersion, versionVerified: false,
      configuration: group.profile.configuration, returns: { workspace: group.profile.workspace, session: group.profile.session, exit: group.profile.exit },
      level: reportedVersion === '1.0.8' && group.profile.id === 'codex-camel' ? 'baseline' : reportedVersion === '1.1.0-beta.4' && group.profile.id === 'codex-snake' ? 'preview' : 'schema-only',
      message: `${group.profile.baseline} 输入契约；版本${reportedVersion ? `声明 ${reportedVersion}` : '未提供'}，以实际 Schema 和命令回连为准。` };
    return { ...group, compatible: !missing.length && !group.ambiguousRoles.length, missing, fingerprint,
      label: group.prefix.replace(/[_./:-]+$/, '') || String(catalog?.serverInfo?.name || 'DevSpace-compatible'),
      compatibility, identity: 'capability-compatible', modelVerified: false };
  });
  // open_workspace.path is common to both profiles; hide its redundant partial
  // group when a complete contract from this same connector has been found.
  return candidates.filter(candidate => candidate.compatible || !candidates.some(other => other.id === candidate.id && other.compatible));
}
export function choosePlugin(catalog, selectedId) {
  const candidates = discoverPlugins(catalog).filter(p => p.compatible);
  const selected = selectedId ? candidates.find(p => p.id === selectedId) : candidates.length === 1 ? candidates[0] : null;
  if (!selected) throw new Error(candidates.length > 1 ? '检测到多个兼容插件或工具契约，请明确选择一个连接器并仅提交所选契约。' : '未找到完整兼容契约：需同一连接器的 open_workspace / exec_command / write_stdin / apply_patch；1.0.8 使用 workspaceId/sessionId，1.1 使用 workspace_id/session_id，不能混用。检查 codex 工具模式、参数类型、额外必填项和输出字段。');
  if (candidates.filter(p => p.id === selected.id).length > 1) throw new Error('同一连接器同时提供多个工具契约，请仅提交实际要使用的一组工具。');
  return selected;
}
export function restorePair(plugin) {
  if (!plugin?.pairedAt) return plugin;
  try {
    const selected = choosePlugin({ tools: Object.values(plugin.tools || {}), serverId: plugin.serverId, serverInfo: { version: plugin.compatibility?.reportedVersion } }, plugin.id);
    return { ...plugin, ...selected, pairedAt: plugin.pairedAt };
  } catch (error) { return { ...plugin, compatible: false, compatibility: { message: `旧配对需要重新核对：${error.message}` } }; }
}
export function validateEndpoint(raw) {
  const url = new URL(raw);
  if (url.username || url.password || url.hash || url.search) throw new Error('端点不能含用户名、密码、查询参数或片段。');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('此检测入口只连接本机 HTTP MCP 服务。远程 OAuth 插件请使用 GPT 配对。');
  if (!/^\/mcp\/?$/.test(url.pathname)) throw new Error('请输入本机 DevSpace 的 /mcp 地址。');
  return url.href;
}
export async function probeMcp(raw, { bearer = '', fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const url = validateEndpoint(raw);
  const signal = AbortSignal.timeout(timeoutMs);
  let session, protocol = '2025-06-18';
  const rpc = async (method, params, id) => {
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocol, ...(session ? { 'Mcp-Session-Id': session } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, ...(params ? { params } : {}) }) });
    session = response.headers.get('mcp-session-id') || session;
    if (!response.ok) throw new Error(response.status === 401 ? 'DevSpace 需要 OAuth 授权。请在 GPT 中启用插件后使用配对口令；不要填 Owner 密码。' : `MCP 检测失败（HTTP ${response.status}）`);
    if (!id) return;
    const reader = response.body.getReader(); let bytes = 0, rawText = '';
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.length; if (bytes > 2_000_000) throw new Error('MCP 返回超过检测上限。');
        rawText += decoder.decode(value, { stream: true });
        if (response.headers.get('content-type')?.includes('text/event-stream')) {
          const events = rawText.split(/\r?\n\r?\n/).slice(0, -1);
          for (const event of events) {
            const data = event.split(/\r?\n/).filter(s => s.startsWith('data:')).map(s => s.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const message = JSON.parse(data); if (message.id === id) { if (message.error) throw new Error(message.error.message); return message.result; }
          }
        }
      }
      const message = JSON.parse(rawText); if (message.id !== id || message.error) throw new Error(message.error?.message || 'MCP 响应 ID 不匹配。');
      return message.result;
    } finally { await reader.cancel().catch(() => {}); }
  };
  const init = await rpc('initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'devspace-shell-setup', version: shellVersion } }, 1);
  if (!protocols.has(init?.protocolVersion)) throw new Error(`不支持或缺少 MCP 协议版本：${String(init?.protocolVersion || '未提供').slice(0, 80)}。请检查 DevSpace 版本；未发送工具调用。`);
  protocol = init.protocolVersion;
  if (!init?.capabilities?.tools) throw new Error('此 MCP 服务没有声明工具能力。');
  await rpc('notifications/initialized');
  const tools = []; let cursor, id = 2; const seen = new Set();
  do {
    const page = await rpc('tools/list', cursor ? { cursor } : {}, id++);
    if (!Array.isArray(page?.tools)) throw new Error('MCP 工具目录格式无效。');
    tools.push(...page.tools); if (tools.length > 2000) throw new Error('MCP 工具数超出检测上限。');
    cursor = page.nextCursor;
    if (cursor && (typeof cursor !== 'string' || seen.has(cursor) || seen.size > 20)) throw new Error('MCP 目录分页无效。');
    seen.add(cursor);
  } while (cursor);
  return { tools, serverInfo: init.serverInfo, protocolVersion: protocol, candidates: discoverPlugins({ tools, serverInfo: init.serverInfo }), observedAt: new Date().toISOString() };
}
