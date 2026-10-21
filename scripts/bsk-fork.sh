#!/bin/sh
# Run only this checkout's build; never auto-update it to the upstream release.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BINARY="$ROOT/target/release/bsk"
if [ ! -x "$BINARY" ]; then
  printf '%s\n' '请先在仓库中执行 cargo build --release --locked。' >&2
  exit 1
fi
for argument in "$@"; do
  case "$argument" in
    -*) ;;
    update)
      printf '%s\n' '这是定制分支，请通过 git pull 和本地构建更新；bsk update 会安装上游版本。' >&2
      exit 2
      ;;
    *) break ;;
  esac
done
export BSK_AUTO_UPDATE=off
exec "$BINARY" "$@"
