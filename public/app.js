import { setupMemory } from './memory.js';
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1));
if (params.has('token')) { sessionStorage.setItem('devshell-token', params.get('token')); history.replaceState(null, '', location.pathname); }
let state, selectedId = null, editing = false, confirmAction = null, fetching = false;
let hiddenCursor = null, hiddenLoading = false;
const hiddenChoices = new Map(), hiddenCursors = new Set();
const labels = { queued: '等待执行', dispatching: '正在派发', waiting_executor: '等待 GPT 领取', running: '运行中 · RUNNING', paused: '已暂停', lease_expired: '租约过期', delivery_unknown: '发送结果未知', completed: '已完成', cancelled: '已取消' };
function notice(error) { $('notice').textContent = error?.message || String(error); $('notice').hidden = false; }
async function api(path, input) {
  const response = await fetch(path, { method: input ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('devshell-token') || ''}` }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401) { $('auth-view').hidden = false; $('setup-view').hidden = true; $('work-view').hidden = true; } throw new Error(data.error || '请求失败'); }
  return data;
}
function safe(operation) { return async event => { event?.preventDefault(); try { $('notice').hidden = true; await operation(event); } catch (error) { notice(error); } }; }
function node(tag, text, className) { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; }
function showText(title, text, description) { $('text-title').textContent = title; $('text-output').value = text; $('text-description').textContent = description || ''; if (!$('text-dialog').open) $('text-dialog').showModal(); }
function showSetup(show) {
  editing = show; $('setup-view').hidden = !show; $('work-view').hidden = show;
  $('page-title').textContent = show ? '连接你的 DevSpace' : '工作台';
}
function fillSettings() {
  const c = state.config;
  $('workspace').value = c.workspace; $('command-runtime').value = c.commandRuntime; $('executor-mode').value = c.executor.mode;
  $('model-label').value = c.modelLabel;
  $('auto-dispatch').checked = c.autoDispatch; $('desktop-fields').hidden = c.executor.mode !== 'desktop';
  hiddenChoices.clear(); hiddenCursors.clear(); hiddenCursor = null; $('hidden-picker').hidden = true;
}
function render() {
  const c = state.config, paired = Boolean(c.plugin?.pairedAt) && c.plugin.compatible !== false;
  $('version').textContent = `v${state.version}`; $('task-count').textContent = state.tasks.length;
  $('pair-state').textContent = paired ? '已配对' : '尚未配对'; $('pair-state').className = `badge${paired ? ' paired' : ''}`;
  $('ready-note').textContent = c.executor.mode === 'desktop' && !c.executor.bound ? '请先识别并连接专用隐藏会话，然后在该会话完成插件配对。' : paired ? `已识别 ${c.plugin.label}。命令回连成功；模型身份由客户端负责。` : '完成设置和 GPT 插件配对后，即可提交第一个任务。';
  $('plugin-label').textContent = c.plugin?.label || '尚未配对';
  $('compatibility-note').textContent = c.plugin?.compatibility?.message || '支持 1.0.8 驼峰与 1.1 预览版下划线工具契约；版本未知时按实际参数核对，不自动升级 DevSpace。';
  $('hidden-connection').textContent = c.executor.bound ? `已连接：${c.executor.title}。重启后继续复用。` : '尚未连接。先保存执行方式，再点击“识别隐藏会话”。';
  $('executor-note').textContent = c.executor.mode === 'manual' ? '通用模式 · 复制口令到 GPT' : !c.executor.bound ? '等待连接专用隐藏会话' : state.readiness.desktopBridgeAvailable ? `隐藏会话 · ${c.executor.title}` : '桌面桥接未就绪 · 请打开兼容客户端';
  $('model-note').textContent = c.modelLabel || '由客户端选择';
  $('begin-button').disabled = !c.workspace || !paired || (c.executor.mode === 'desktop' && !c.executor.bound);
  $('task-list').replaceChildren();
  if (!state.tasks.length) $('task-list').append(node('p', '这里会保存你自己的任务。', 'hint'));
  for (const task of state.tasks) {
    const item = node('button', '', `task-item${task.id === selectedId ? ' active' : ''}`); item.append(node('strong', task.title));
    const small = node('small', ''); small.append(node('span', labels[task.state] || task.state), node('span', new Date(task.created_at).toLocaleDateString())); item.append(small);
    item.addEventListener('click', safe(async () => { selectedId = task.id; showSetup(false); render(); await detail(); })); $('task-list').append(item);
  }
  $('empty-state').hidden = Boolean(selectedId); $('task-detail').hidden = !selectedId;
}
async function detail() {
  if (!selectedId || editing) return;
  const id = selectedId, data = await api(`/api/tasks/${id}`); if (id !== selectedId) return;
  const task = data.task, terminal = ['completed', 'cancelled'].includes(task.state);
  $('task-title').textContent = task.title; $('task-workspace').textContent = task.workspace; $('task-request').textContent = task.request;
  $('task-state').textContent = labels[task.state] || task.state; $('task-state').className = `badge ${task.state}`;
  $('events').replaceChildren();
  for (const event of data.events) { const li = node('li', ''); const content = node('div', ''); content.append(node('div', event.text, 'event-text'), node('time', new Date(event.created_at).toLocaleString())); li.append(content); $('events').append(li); }
  $('checkpoint-card').hidden = !task.checkpoint; $('checkpoint').textContent = task.checkpoint || '';
  $('result-card').hidden = !task.result; if (task.result) { const result = JSON.parse(task.result); $('result').textContent = `${result.text}\n\n验证证据：\n${result.evidence.join('\n')}`; }
  const warnings = { delivery_unknown: '上一次发送可能已经成功。已停止自动重发；请核实原 GPT 聊天后处理。', lease_expired: '租约已过期，检查点仍在。请先停止并核实原执行器，再恢复此任务。', paused: '本地任务已暂停。请同时停止原 GPT，暂停不会撤销已经发生的操作。', waiting_executor: '派发已确认，正在等待 GPT 的真实领取回执。', running: task.last_progress ? '' : '已领取租约，尚无业务进展回执。心跳不计作业务进展。' };
  const warning = warnings[task.state] || task.error || ''; $('task-warning').hidden = !warning; $('task-warning').textContent = warning;
  $('task-prompt').hidden = terminal; $('task-dispatch').hidden = state.config.executor.mode !== 'desktop' || task.state !== 'queued';
  $('task-pause').hidden = terminal || task.state === 'paused' || task.state === 'delivery_unknown';
  $('task-resume').hidden = !['paused', 'lease_expired'].includes(task.state); $('task-reconcile').hidden = task.state !== 'delivery_unknown'; $('task-cancel').hidden = terminal;
}
async function refresh(first = false) {
  if (fetching) return; fetching = true;
  try {
    state = await api('/api/status'); $('auth-view').hidden = true; $('service-status').textContent = '本机服务在线'; $('service-dot').className = 'dot';
    if (first) { fillSettings(); selectedId = state.tasks[0]?.id || null; showSetup(!state.config.workspace || !state.config.plugin?.pairedAt || state.config.plugin.compatible === false || (state.config.executor.mode === 'desktop' && !state.config.executor.bound)); }
    render(); await detail();
  } catch (error) { $('service-status').textContent = '连接中断'; $('service-dot').className = 'dot offline'; if (first) notice(error); }
  finally { fetching = false; }
}
$('setup-form').addEventListener('submit', safe(async () => {
  await api('/api/setup', { workspace: $('workspace').value.trim(), commandRuntime: $('command-runtime').value, modelLabel: $('model-label').value, autoDispatch: $('auto-dispatch').checked,
    executor: { mode: $('executor-mode').value } }); await refresh();
  $('notice').hidden = false; $('notice').textContent = state.config.executor.mode === 'desktop' && !state.config.executor.bound ? '设置已保存。接下来点击“识别隐藏会话”。' : state.config.plugin?.pairedAt ? '设置已保存。' : '设置已保存。接下来完成 GPT 插件配对。';
}));
$('executor-mode').addEventListener('change', () => { $('desktop-fields').hidden = $('executor-mode').value !== 'desktop'; if ($('executor-mode').value === 'manual') $('auto-dispatch').checked = false; });
async function desktopBootstrap() {
  const result = await api('/api/desktop/ticket', {});
  showText('首次桌面连接 · 自动获取上下文', result.prompt, '把口令发给兼容 Codex 桌面客户端，让它执行一次本地连接命令。无需手填 ID；不会向 GPT 发送任务。完成后回到这里点击“识别隐藏会话”。');
}
async function findHidden(more = false) {
  if (hiddenLoading) return;
  if (state.config.executor.mode !== 'desktop') throw new Error('请先保存“桌面隐藏会话”执行方式。');
  hiddenLoading = true; $('find-hidden').disabled = true; $('more-hidden').disabled = true; $('bind-hidden').disabled = true;
  try {
    const result = await api('/api/desktop/list', more && hiddenCursor ? { cursor: hiddenCursor } : {});
    if (result.needsBootstrap) { await desktopBootstrap(); return; }
    const previous = $('hidden-choice').value;
    if (!more) { hiddenChoices.clear(); hiddenCursors.clear(); }
    if (result.nextCursor && hiddenCursors.has(result.nextCursor)) throw new Error('客户端返回重复翻页，请重新识别隐藏会话。');
    if (result.nextCursor) hiddenCursors.add(result.nextCursor);
    for (const choice of result.threads) hiddenChoices.set(choice.id, choice);
    hiddenCursor = result.nextCursor; $('hidden-choice').replaceChildren(node('option', '请选择专用会话'));
    $('hidden-choice').firstElementChild.value = '';
    for (const choice of hiddenChoices.values()) {
      const option = node('option', choice.title); option.value = choice.id; $('hidden-choice').append(option);
    }
    // Even one result may be a personal chat. Never bind it automatically.
    if (more && hiddenChoices.has(previous)) $('hidden-choice').value = previous;
    $('hidden-picker').hidden = false; $('more-hidden').hidden = !hiddenCursor;
    if (!hiddenChoices.size) notice('没有发现隐藏归档的 GPT 会话。请先在客户端准备专用会话并归档，再重新识别。');
  } finally { hiddenLoading = false; $('find-hidden').disabled = false; $('more-hidden').disabled = false; $('bind-hidden').disabled = false; }
}
$('find-hidden').addEventListener('click', safe(() => findHidden()));
$('more-hidden').addEventListener('click', safe(() => findHidden(true)));
$('desktop-bootstrap').addEventListener('click', safe(desktopBootstrap));
$('bind-hidden').addEventListener('click', safe(async () => {
  if (hiddenLoading) return;
  const selection = $('hidden-choice').value;
  if (!hiddenChoices.has(selection)) throw new Error('请选择你专门准备的隐藏执行会话。');
  $('bind-hidden').disabled = true;
  try {
    const result = await api('/api/desktop/connect', { selection }); await refresh();
    $('notice').hidden = false; $('notice').textContent = `已连接隐藏会话“${result.title}”。请在此会话完成 DevSpace 插件配对，然后开启自动派发。`;
  } finally { $('bind-hidden').disabled = false; }
}));
$('settings-button').addEventListener('click', () => { if (!state) return; fillSettings(); showSetup(true); });
$('begin-button').addEventListener('click', () => { showSetup(false); render(); detail().catch(notice); });
$('pair-button').addEventListener('click', safe(async () => { const result = await api('/api/plugins/ticket', {}); showText('发给已启用插件的 GPT', result.prompt, '口令十分钟内有效，只能使用一次。桌面模式请在已选的专用会话中配对，完成后保持归档。请让 GPT 实际执行回连命令。'); }));
$('reset-pair').addEventListener('click', safe(async () => { await api('/api/plugins/reset', {}); await refresh(); }));
$('probe-button').addEventListener('click', safe(async () => {
  const token = $('mcp-bearer').value; $('mcp-bearer').value = '';
  const result = await api('/api/plugins/probe', { url: $('mcp-url').value, bearer: token }); $('probe-result').hidden = false;
  $('probe-result').textContent = JSON.stringify({ server: result.serverInfo, protocolVersion: result.protocolVersion, candidates: result.candidates.map(p => ({ name: p.label, compatible: p.compatible, compatibility: p.compatibility, missing: p.missing, fingerprint: p.fingerprint })) }, null, 2);
}));
$('client-config').addEventListener('click', safe(async () => { const result = await api('/api/config/client'); showText('通用 MCP 客户端配置', JSON.stringify(result, null, 2), '合并到你客户端的 MCP 配置。此连接器提供任务管理；文件和命令仍使用你自己的 DevSpace 插件。'); }));
for (const [id, enabled] of [['autostart-enable', true], ['autostart-disable', false]]) $(id).addEventListener('click', safe(async () => { await api('/api/system/autostart', { enabled }); $('notice').textContent = enabled ? '本安装的登录自启动已开启。' : '本安装的登录自启动已关闭。'; $('notice').hidden = false; }));
function newTask() { if (!state) return; if (!state.config.workspace || !state.config.plugin?.pairedAt || state.config.plugin.compatible === false || (state.config.executor.mode === 'desktop' && !state.config.executor.bound)) { fillSettings(); showSetup(true); notice('请先保存项目目录、完成所选执行方式的连接与 GPT 插件配对。'); return; } $('task-dialog').showModal(); }
$('new-task').addEventListener('click', newTask); $('first-task').addEventListener('click', newTask);
$('task-form').addEventListener('submit', safe(async () => { const result = await api('/api/tasks', { title: $('new-title').value, request: $('new-request').value }); selectedId = result.task.id; $('task-dialog').close(); $('task-form').reset(); showSetup(false); await refresh(); }));
$('task-prompt').addEventListener('click', safe(async () => { const result = await api(`/api/tasks/${selectedId}/prompt`, {}); showText('任务执行口令', result.prompt, '将口令发给已完成配对的 GPT。包含本任务的执行权限，请勿公开分享。'); }));
$('task-dispatch').addEventListener('click', safe(async () => { await api(`/api/tasks/${selectedId}/dispatch`, {}); await refresh(); }));
$('task-pause').addEventListener('click', safe(async () => { await api(`/api/tasks/${selectedId}/action`, { action: 'pause' }); await refresh(); }));
for (const [id, action] of [['task-resume', 'resume'], ['task-reconcile', 'confirm-not-delivered'], ['task-cancel', 'cancel']]) $(id).addEventListener('click', () => { confirmAction = action; $('confirm-check').checked = false; $('confirm-description').textContent = '继续前请查看原 GPT 聊天，核实命令是否已执行，避免重复修改。检查点会保留。'; $('confirm-dialog').showModal(); });
$('confirm-action').addEventListener('click', safe(async () => { if (!$('confirm-check').checked) throw new Error('请先核实并勾选确认。'); await api(`/api/tasks/${selectedId}/action`, { action: confirmAction, acknowledged: true }); $('confirm-dialog').close(); await refresh(); }));
$('copy-text').addEventListener('click', safe(async () => { try { await navigator.clipboard.writeText($('text-output').value); $('copy-text').textContent = '已复制'; setTimeout(() => $('copy-text').textContent = '复制全部内容', 1500); } catch { $('text-output').select(); throw new Error('浏览器未允许自动复制，内容已选中，请按 Ctrl+C。'); } }));
setupMemory({ api, node, getWorkspace: () => state?.config.workspace || '' });
for (const button of document.querySelectorAll('.close-dialog')) button.addEventListener('click', () => button.closest('dialog').close());
await refresh(true); setInterval(() => refresh(), 4000);
