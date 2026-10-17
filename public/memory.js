export function setupMemory({ api, node, getWorkspace }) {
  const $ = id => document.getElementById(id);
  let offset = 0, edited = null, pendingDelete = null, generation = 0, saving = false;
  const scopeInput = () => ({ scope: $('memory-scope').value, workspace: getWorkspace() });
  function message(text) { $('memory-message').textContent = text; $('memory-message').hidden = !text; }
  const safe = operation => async event => { event?.preventDefault(); try { message(''); await operation(); } catch (error) { message(error.message); } };
  function stopEditing() { edited = null; $('memory-edit-form').hidden = true; }
  function confirm(text, operation) { pendingDelete = operation; $('memory-confirm-text').textContent = text; $('memory-confirm').hidden = false; }
  function edit(note) {
    edited = note || null; const user = $('memory-scope').value === 'user';
    $('memory-edit-heading').textContent = note ? '修改记忆' : '新增记忆';
    $('memory-kind').value = user || note?.kind === 'preference' ? 'preference' : 'knowledge'; $('memory-kind').disabled = user;
    $('memory-title').value = note?.title || ''; $('memory-content').value = note?.content || ''; $('memory-pinned').checked = note?.pinned || false;
    $('memory-edit-form').hidden = false; $('memory-title').focus();
  }
  async function load() {
    const current = ++generation, input = scopeInput();
    $('memory-confirm').hidden = true; pendingDelete = null;
    $('memory-workspace').textContent = input.scope === 'user' ? '用户偏好会用于本安装的所有项目。' : input.workspace || '请先在“连接与设置”保存项目目录。';
    if (input.scope === 'project' && !input.workspace) {
      $('memory-list').replaceChildren(); $('memory-count').textContent = '尚未选择项目';
      $('memory-previous').disabled = true; $('memory-next').disabled = true; return;
    }
    const result = await api('/api/memory/search', { ...input, query: $('memory-query').value, offset, limit: 20 });
    if (current !== generation) return;
    if (offset && offset >= result.total) { offset = Math.max(0, Math.floor((result.total - 1) / 20) * 20); return load(); }
    $('memory-list').replaceChildren(); $('memory-count').textContent = `${result.total} 条记忆 · ${result.policy.enabled ? '已启用' : '检索与执行器写入已关闭'}${result.total ? ` · 第 ${Math.floor(offset / 20) + 1} 页` : ''}`;
    $('memory-previous').disabled = offset === 0; $('memory-next').disabled = offset + 20 >= result.total;
    if (!result.notes.length) $('memory-list').append(node('p', '这里还没有匹配的记忆。新安装从空白开始。', 'hint'));
    const kinds = { preference: '偏好', knowledge: '知识', task: '任务记录' }, sources = { user: '用户保存', executor: '执行器保存', task: '自动记录' };
    for (const note of result.notes) {
      const card = node('article', '', 'memory-note');
      card.append(node('h3', `${note.pinned ? '★ ' : ''}${note.title}`), node('p', `${kinds[note.kind]} · ${sources[note.source]} · ${new Date(note.updated_at).toLocaleString()}`, 'hint'));
      const content = node('details', ''); content.append(node('summary', '查看内容'), node('div', note.content, 'prose')); card.append(content);
      const actions = node('div', '', 'actions'), change = node('button', '修改', 'quiet'), remove = node('button', '删除', 'quiet danger');
      change.addEventListener('click', () => edit(note));
      remove.addEventListener('click', () => confirm(`删除“${note.title}”？以后不再检索此条。已发给 GPT 的内容和原任务历史不会因此撤回。`, async () => { await api('/api/memory/delete', { id: note.id, revision: note.revision }); stopEditing(); await load(); }));
      actions.append(change, remove); card.append(actions); $('memory-list').append(card);
    }
  }
  $('memory-button').addEventListener('click', safe(async () => {
    $('memory-dialog').showModal(); stopEditing(); offset = 0;
    const policy = await api('/api/memory/settings');
    $('memory-enabled').checked = policy.enabled; $('memory-auto').checked = policy.autoCapture; $('memory-limit').value = policy.autoLimit;
    await load();
  }));
  $('memory-policy-form').addEventListener('submit', safe(async () => {
    await api('/api/memory/settings', { enabled: $('memory-enabled').checked, autoCapture: $('memory-auto').checked, autoLimit: Number($('memory-limit').value) });
    await load(); message('记忆设置已保存。');
  }));
  $('memory-scope').addEventListener('change', safe(async () => { offset = 0; stopEditing(); await load(); }));
  $('memory-search-form').addEventListener('submit', safe(async () => { offset = 0; await load(); }));
  $('memory-previous').addEventListener('click', safe(async () => { offset = Math.max(0, offset - 20); await load(); }));
  $('memory-next').addEventListener('click', safe(async () => { offset += 20; await load(); }));
  $('memory-new').addEventListener('click', () => edit(null));
  $('memory-edit-cancel').addEventListener('click', stopEditing);
  $('memory-edit-form').addEventListener('submit', safe(async () => {
    if (saving) return; saving = true;
    try {
      await api('/api/memory/save', { ...scopeInput(), ...(edited ? { id: edited.id, revision: edited.revision } : {}), kind: $('memory-kind').value,
        title: $('memory-title').value, content: $('memory-content').value, pinned: $('memory-pinned').checked });
      stopEditing(); await load(); message('记忆已保存。后续任务会按范围检索。');
    } finally { saving = false; }
  }));
  $('memory-clear').addEventListener('click', () => confirm('清空当前范围的全部记忆？检索和导出都将移除这些条目，原任务历史仍保留。其他项目及另一范围不受影响。', async () => {
    await api('/api/memory/clear', { ...scopeInput(), acknowledged: true }); offset = 0; stopEditing(); await load();
  }));
  $('memory-confirm-yes').addEventListener('click', safe(async () => {
    const operation = pendingDelete; pendingDelete = null; $('memory-confirm').hidden = true; if (operation) await operation();
  }));
  $('memory-confirm-no').addEventListener('click', () => { pendingDelete = null; $('memory-confirm').hidden = true; });
  $('memory-export').addEventListener('click', safe(async () => {
    const input = scopeInput(), notes = [], ids = new Set(); let total;
    do {
      const result = await api('/api/memory/search', { ...input, limit: 100, offset: notes.length });
      if ((total !== undefined && result.total !== total) || result.notes.some(note => ids.has(note.id))) throw new Error('记忆正在变化，请稍后重新导出。');
      for (const note of result.notes) ids.add(note.id);
      notes.push(...result.notes); total = result.total;
      if (!result.notes.length && notes.length < total) throw new Error('记忆正在变化，请稍后重新导出。');
    } while (notes.length < total);
    const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'devspace-shell-memory-v1', exportedAt: new Date().toISOString(), ...input, notes }, null, 2)], { type: 'application/json' }));
    const link = node('a', ''); link.href = url; link.download = 'devspace-shell-memory.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    message('已导出当前范围。导出文件包含你保存的内容，请自行保管。');
  }));
}
