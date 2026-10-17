import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { appRoot } from '../src/config.mjs';

export const sourceRoots = ['src', 'public', 'scripts', 'tests', 'docs', 'examples', '.github'];
export const sourceNames = ['AGENTS.md', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'CONTRIBUTING.md', '.gitignore', '.gitattributes', 'package.json', 'package-lock.json', 'Install.cmd', '一键安装.cmd', '启动Dev.cmd', '停止Dev.cmd', '卸载Dev.cmd', 'install.sh'];
export function sourceFiles(root = appRoot) {
  const result = [...sourceNames];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Source symlinks are not packaged.');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else result.push(relative(root, path).replaceAll('\\', '/'));
    }
  };
  for (const name of sourceRoots) walk(join(root, name));
  return result.sort();
}
