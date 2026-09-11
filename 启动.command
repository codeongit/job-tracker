#!/bin/zsh
set -e
cd "$(dirname "$0")"
job_node="$(command -v node || true)"
if [[ -z "$job_node" && -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]]; then
  job_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [[ -z "$job_node" ]]; then
  print '请先安装 Node.js 22 或更新版本，再运行此文件。'
  read
  exit 1
fi
"$job_node" scripts/serve.mjs
