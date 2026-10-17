import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { appRoot } from '../src/config.mjs';
import { sourceFiles } from './source-files.mjs';

// Output locations/rules only, never the matching text.
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['provider-key', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/],
  ['credential-uri', /[a-z]+:\/\/[^\s/@:]+:[^\s/@]+@/i],
  ['personal-home', /[A-Za-z]:[\\/]Users[\\/](?!Public\b|Default\b|<)[A-Za-z0-9_.-]+/i],
  ['private-network-address', /\b(?:100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])|192\.168|10\.\d+)\.\d+\.\d+\b/],
  ['credential-literal', /(?:adminToken|api_key|access_token|refresh_token|client_secret|password)\s*[:=]\s*["'][A-Za-z0-9_+\/-]{24,}["']/i],
];
export function scan(files, root = appRoot, read = name => readFileSync(join(root, name), 'utf8')) {
  const findings = [];
  for (const name of files) {
    if (/(?:^|\/)(?:\.runtime|\.local|node_modules|data|state|logs|uploads|memory|thread-memory|conversations|backups)(?:\/|$)|\.(?:sqlite|db|pem|key|zip)(?:$|-)/i.test(name) || /(?:^|\/)(?:(?:config|instance|auth)\.json|known_hosts)$/.test(name)) findings.push({ file: name, line: 0, rule: 'runtime-or-credential-file' });
    const lines = read(name).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const [rule, regex] of rules) {
        if (name === 'tests/plugins.test.mjs' && rule === 'credential-uri' && lines[i].includes('user:pass@127.0.0.1')) continue;
        if (regex.test(lines[i])) findings.push({ file: name, line: i + 1, rule });
      }
    }
  }
  return findings;
}
export function privacy({ staged = false } = {}) {
  let files = sourceFiles();
  if (staged) {
    const result = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { cwd: appRoot, encoding: 'utf8', windowsHide: true });
    if (result.status) throw new Error('Cannot inspect staged files.');
    files = result.stdout.split('\0').filter(Boolean);
    const allowed = new Set(sourceFiles());
    const unexpected = files.filter(name => !allowed.has(name));
    if (unexpected.length) return unexpected.map(file => ({ file, line: 0, rule: 'not-in-release-source-allowlist' }));
  }
  return scan(files, appRoot, staged ? name => {
    const result = spawnSync('git', ['show', `:${name}`], { cwd: appRoot, encoding: 'utf8', windowsHide: true });
    if (result.status) throw new Error('Cannot inspect staged file content.');
    return result.stdout;
  } : undefined);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const findings = privacy({ staged: process.argv.includes('--staged') });
  console.log(JSON.stringify({ ok: findings.length === 0, scope: process.argv.includes('--staged') ? 'staged' : 'source', findings }, null, 2));
  if (findings.length) process.exitCode = 1;
}
