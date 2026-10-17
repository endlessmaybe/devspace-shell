import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { appRoot } from '../src/config.mjs';
import { sourceFiles } from './source-files.mjs';
import { privacy } from './privacy.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function zipEntries(entries) {
  const local = [], central = []; let offset = 0;
  for (const { name, content } of entries) {
    if (name.includes('..') || name.startsWith('/') || name.includes('\\')) throw new Error('Unsafe archive path');
    const filename = Buffer.from(name, 'utf8'), data = Buffer.from(content), compressed = deflateRawSync(data), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10); directory.writeUInt16LE(33, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, filename, compressed); central.push(directory, filename); offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export function packageRelease(destination = join(appRoot, 'release')) {
  const findings = privacy(); if (findings.length) throw new Error('Privacy scan failed; release not generated.');
  const files = sourceFiles(), metadata = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
  const entries = files.map(name => ({ name: `devspace-shell/${name}`, content: readFileSync(join(appRoot, name)) }));
  const archive = zipEntries(entries), name = `devspace-shell-v${metadata.version}.zip`, sha256 = createHash('sha256').update(archive).digest('hex');
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, name), archive);
  writeFileSync(join(destination, 'SHA256SUMS.txt'), `${sha256}  ${name}\n`);
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify({ version: metadata.version, files, sha256, personalDataIncluded: false }, null, 2) + '\n');
  return { archive: join(destination, name), sha256, files: files.length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(packageRelease(), null, 2));
