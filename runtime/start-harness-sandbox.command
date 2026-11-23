#!/bin/zsh
set -eu
script_dir="${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  candidates=("$HOME/.local/share/fnm/node-versions"/v*/installation/bin/node(NOn))
  if (( ${#candidates} )); then node_bin="${candidates[1]}"; fi
fi
if [[ -z "$node_bin" ]]; then
  printf '%s\n' '未找到 Node.js。请安装 Node.js 22 或从已有 Node.js 终端执行沙箱服务文件。'
  exit 1
fi
exec "$node_bin" "$script_dir/agent-harness-sandbox.mjs" --open
