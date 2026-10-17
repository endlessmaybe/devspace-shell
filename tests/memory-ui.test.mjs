import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from '../src/server.mjs';
import { setupMemory } from '../public/memory.js';
import { temp } from './helpers.mjs';

// Exercise browser event handlers against the actual HTTP service. This minimal
// DOM verifies controls and text handling, not graphical browser rendering.
class Element {
  constructor(tag = 'div', text = '') { this.tagName = tag; this.textContent = text; this.children = []; this.events = {}; this.value = ''; this.hidden = false; this.checked = false; this.disabled = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, handler) { this.events[name] = handler; }
  async trigger(name) { await this.events[name]?.({ preventDefault() {} }); }
  showModal() { this.open = true; }
  focus() {}
}
test('memory interface saves, edits, searches, switches scopes, forgets and persists policy through real API', async t => {
  const dir = temp('memory-ui'), app = await createServer({ dataDir: dir, port: 0 }); t.after(() => app.stop());
  const controls = new Map([...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const previous = globalThis.document; globalThis.document = { getElementById: id => controls.get(id) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const $ = id => controls.get(id), api = async (path, input) => {
    const response = await fetch(app.url + path, { method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.config.adminToken}`, 'Content-Type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
  };
  await api('/api/setup', { workspace: dir }); $('memory-scope').value = 'project';
  setupMemory({ api, node: (tag, text) => new Element(tag, text), getWorkspace: () => dir });
  await $('memory-button').trigger('click'); assert.ok($('memory-dialog').open); assert.match($('memory-count').textContent, /0 条/);
  await $('memory-new').trigger('click'); $('memory-kind').value = 'knowledge'; $('memory-title').value = '<img src=x onerror=alert(1)>';
  $('memory-content').value = '数据库备份已验证'; await $('memory-edit-form').trigger('submit');
  assert.match($('memory-message').textContent, /已保存/); assert.match($('memory-count').textContent, /1 条/);
  let card = $('memory-list').children[0]; assert.equal(card.children[0].textContent, '<img src=x onerror=alert(1)>');
  await card.children[3].children[0].trigger('click'); $('memory-content').value = '数据库恢复已验证'; await $('memory-edit-form').trigger('submit');
  assert.equal(app.store.memory.search({ workspace: dir }).notes[0].content, '数据库恢复已验证');
  $('memory-query').value = '恢复'; await $('memory-search-form').trigger('submit'); assert.match($('memory-count').textContent, /1 条/);
  $('memory-scope').value = 'user'; $('memory-query').value = ''; await $('memory-scope').trigger('change');
  await $('memory-new').trigger('click'); assert.equal($('memory-kind').value, 'preference'); assert.equal($('memory-kind').disabled, true);
  $('memory-title').value = '回复语言'; $('memory-content').value = '中文'; await $('memory-edit-form').trigger('submit');
  assert.equal(app.store.memory.search({ scope: 'user' }).total, 1);
  $('memory-scope').value = 'project'; await $('memory-scope').trigger('change');
  card = $('memory-list').children[0]; await card.children[3].children[1].trigger('click');
  assert.equal(app.store.memory.search({ workspace: dir }).total, 1); assert.equal($('memory-confirm').hidden, false);
  await $('memory-confirm-yes').trigger('click'); assert.equal(app.store.memory.search({ workspace: dir }).total, 0);
  assert.equal(app.store.memory.search({ scope: 'user' }).total, 1);
  $('memory-enabled').checked = false; $('memory-auto').checked = false; $('memory-limit').value = '5';
  await $('memory-policy-form').trigger('submit'); assert.deepEqual(app.store.memory.policy(), { enabled: false, autoCapture: false, autoLimit: 5 });
  $('memory-scope').value = 'user'; await $('memory-scope').trigger('change'); await $('memory-clear').trigger('click');
  await $('memory-confirm-no').trigger('click'); assert.equal(app.store.memory.search({ scope: 'user' }).total, 1);
  await $('memory-clear').trigger('click'); await $('memory-confirm-yes').trigger('click'); assert.equal(app.store.memory.search({ scope: 'user' }).total, 0);
});
