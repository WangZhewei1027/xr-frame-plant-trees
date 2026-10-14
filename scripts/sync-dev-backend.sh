#!/bin/sh
# DevTools launched from Finder does not inherit the terminal's Node.js PATH.
set -e
cd "$(dirname "$0")/.."

if command -v node >/dev/null 2>&1; then
  exec node scripts/sync-dev-backend.cjs
fi

for miniapp_node in /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -x "$miniapp_node" ]; then
    exec "$miniapp_node" scripts/sync-dev-backend.cjs
  fi
done

miniapp_nvm_dir="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$miniapp_nvm_dir/nvm.sh" ]; then
  . "$miniapp_nvm_dir/nvm.sh" --no-use
  nvm use --silent default >/dev/null
  exec node scripts/sync-dev-backend.cjs
fi

echo '[miniapp backend] 找不到 Node.js；请安装 Node.js 或将其加入开发者工具的 PATH。' >&2
exit 127
