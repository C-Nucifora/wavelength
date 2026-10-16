#!/bin/zsh
set -eu
cd "${0:A:h}"
task_bun="$(command -v bun || true)"
if [[ -z "$task_bun" && -x "$HOME/.bun/bin/bun" ]]; then task_bun="$HOME/.bun/bin/bun"; fi
if [[ -z "$task_bun" ]]; then
  print 'Install Bun from https://bun.com, then open this launcher again.'
  read '?Press Return to close.'
  exit 1
fi
exec "$task_bun" src/index.ts --open
