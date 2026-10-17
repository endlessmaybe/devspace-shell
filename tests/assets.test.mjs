import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRoot } from '../src/config.mjs';
import { scan } from '../scripts/privacy.mjs';
import { temp } from './helpers.mjs';

test('browser application references real unique controls and ships without remote assets or inline scripts', () => {
  const html = readFileSync(join(appRoot, 'public', 'index.html'), 'utf8'), js = readFileSync(join(appRoot, 'public', 'app.js'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]); assert.equal(new Set(ids).size, ids.length);
  for (const [, id] of js.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(id), `Missing control ${id}`);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//); assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/); assert.doesNotMatch(html, /\bon\w+=/i);
  assert.match(html, /lang="zh-CN"/); assert.match(html, /name="viewport"/);
});
test('privacy scan finds generated credentials but only emits locations and rules', () => {
  const root = temp('privacy'); const generated = 'sk-' + 'test'.repeat(10);
  writeFileSync(join(root, 'unsafe.txt'), `credential=${generated}\n`);
  const result = scan(['unsafe.txt'], root); assert.ok(result.some(f => f.rule === 'provider-key')); assert.equal(JSON.stringify(result).includes(generated), false);
});
