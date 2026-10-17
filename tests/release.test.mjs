import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { packageRelease, zipEntries } from '../scripts/package.mjs';
import { privacy, scan } from '../scripts/privacy.mjs';
import { temp } from './helpers.mjs';

function extract(bytes) {
  const files = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const length = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'), start = offset + 30 + nameLength + extra;
    files.set(name, inflateRawSync(bytes.subarray(start, start + length))); offset = start + length;
  } return files;
}
test('release contains Chinese launchers and source, excludes every runtime identity and data category', () => {
  assert.deepEqual(privacy(), []); const destination = temp('release'), result = packageRelease(destination), files = extract(readFileSync(result.archive));
  assert.ok(files.has('devspace-shell/一键安装.cmd')); assert.ok(files.has('devspace-shell/src/server.mjs')); assert.ok(files.has('devspace-shell/scripts/install.ps1'));
  for (const name of files.keys()) assert.doesNotMatch(name, /\/(?:\.runtime|\.git|node_modules|thread-memory|logs|state|conversations)\/|\.sqlite|\/config\.json/);
  assert.equal(JSON.parse(readFileSync(join(destination, 'manifest.json'))).files.length, files.size);
});
test('archive building is deterministic and rejects traversal', () => {
  const entries = [{ name: '中文/a.txt', content: '你好' }]; assert.deepEqual(zipEntries(entries), zipEntries(entries)); assert.throws(() => zipEntries([{ name: '../x', content: '' }]));
});
