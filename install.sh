#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '需要 Node.js 24–26。请从 https://nodejs.org/ 安装 Node，再运行此脚本。'
  exit 1
fi
node --input-type=module -e 'const major=+process.versions.node.split(".")[0]; if(major<24||major>=27){console.error("需要 Node.js 24–26");process.exit(1)}'
exec node scripts/manage.mjs start --open
