import { createHash } from 'node:crypto';

const roles = {
  open: { names: ['open_workspace'], props: { path: 'string' } },
  exec: { names: ['exec_command'], props: { workspaceId: 'string', cmd: 'string' } },
  stdin: { names: ['write_stdin'], props: { workspaceId: 'string', sessionId: 'number' } },
  patch: { names: ['apply_patch'], props: { workspaceId: 'string', patch: 'string' } },
};
const stripType = schema => schema?.type || (schema?.anyOf || schema?.oneOf || []).find(s => s.type && s.type !== 'null')?.type;
function compatible(schema, properties) {
  return schema?.type === 'object' && Object.entries(properties).every(([name, type]) => {
    const actual = stripType(schema.properties?.[name]);
    return schema.required?.includes(name) && (actual === type || (type === 'number' && actual === 'integer'));
  });
}
function roleFor(tool) {
  for (const [role, spec] of Object.entries(roles)) for (const base of spec.names) {
    const i = tool.name.length - base.length;
    if (i >= 0 && tool.name.slice(i) === base && (i === 0 || /[_./:-]$/.test(tool.name.slice(0, i))) && compatible(tool.inputSchema, spec.props)) {
      return { role, prefix: tool.name.slice(0, i) };
    }
  }
  return null;
}
export function discoverPlugins(catalog) {
  const tools = Array.isArray(catalog) ? catalog : catalog?.tools;
  if (!Array.isArray(tools) || tools.length > 2000) throw new Error('需要工具描述数组（最多 2000 项），每项包含 name 和 inputSchema。');
  const groups = new Map();
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || tool.name.length > 300) continue;
    const match = roleFor(tool);
    if (!match) continue;
    const serverId = String(tool.serverId || catalog?.serverId || 'endpoint');
    const key = `${serverId}:${match.prefix}`;
    const group = groups.get(key) || { id: key, serverId, prefix: match.prefix, tools: {}, ambiguousRoles: [] };
    if (group.tools[match.role]) group.ambiguousRoles.push(match.role);
    group.tools[match.role] = { name: tool.name, inputSchema: tool.inputSchema };
    groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const missing = Object.keys(roles).filter(role => !group.tools[role]);
    const fingerprint = createHash('sha256').update(JSON.stringify(Object.keys(group.tools).sort().map(role => [role, group.tools[role].name, group.tools[role].inputSchema]))).digest('hex');
    return { ...group, compatible: !missing.length && !group.ambiguousRoles.length, missing, fingerprint,
      label: group.prefix.replace(/[_./:-]+$/, '') || String(catalog?.serverInfo?.name || 'DevSpace-compatible'),
      identity: 'capability-compatible', modelVerified: false };
  });
}
export function choosePlugin(catalog, selectedId) {
  const candidates = discoverPlugins(catalog).filter(p => p.compatible);
  const selected = selectedId ? candidates.find(p => p.id === selectedId) : candidates.length === 1 ? candidates[0] : null;
  if (!selected) throw new Error(candidates.length > 1 ? '检测到多个兼容插件，请明确选择一个连接器。' : '未找到完整的 DevSpace 工具能力，需 open_workspace / exec_command / write_stdin / apply_patch 及匹配参数。');
  return selected;
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
  let session;
  const rpc = async (method, params, id) => {
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-06-18' } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
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
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'devspace-shell-setup', version: '0.1.0' } }, 1);
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
  return { tools, serverInfo: init.serverInfo, candidates: discoverPlugins({ tools, serverInfo: init.serverInfo }), observedAt: new Date().toISOString() };
}
