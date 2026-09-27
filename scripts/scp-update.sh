#!/usr/bin/env bash
#
# 只同步「有更新」的檔案：本機 <SRC>  ->  遠端 <REMOTE>:<DEST>
# 以 tar 打包更新檔並透過 ssh 一次傳輸（保留目錄結構）；複製前先列出變更並請使用者確認（預設 Yes）。
#
# 用法:
#   ./scp-update.sh [-n|--dry-run] <本機來源路徑> <user@host> <遠端目的路徑> [ssh_port]
# 環境變數:
#   SRC / REMOTE / DEST / SSH_PORT
#   EXCLUDE   排除樣式（逗號分隔 glob），預設 ".env,node_modules,logs,*.log,settings.json,storage.json"
#   DRY_RUN   true 時只列出、不複製
#
# 需求: 本機與遠端皆為 Linux（GNU find / stat / tar）。強烈建議設定 SSH 金鑰（之後免密碼）。
#
# 替代（若兩端都有 rsync）:
#   rsync -avn --itemize-changes --exclude=.env --exclude=node_modules --exclude=logs -e "ssh -p 22" "$SRC/" "$REMOTE:$DEST/"

set -euo pipefail

DRY_RUN="${DRY_RUN:-false}"
EXCLUDE="${EXCLUDE:-.env,node_modules,logs,*.log,settings.json,storage.json}"

args=()
for a in "$@"; do
  case "$a" in
    -n|--dry-run) DRY_RUN=true ;;
    -h|--help)
      echo "用法: $0 [-n|--dry-run] <本機來源路徑> <user@host> <遠端目的路徑> [ssh_port]"
      exit 0
      ;;
    *) args+=("$a") ;;
  esac
done
set -- "${args[@]}"

SRC="${1:-${SRC:-}}"
REMOTE="${2:-${REMOTE:-}}"
DEST="${3:-${DEST:-}}"
SSH_PORT="${4:-${SSH_PORT:-22}}"

if [ -z "$SRC" ] || [ -z "$REMOTE" ] || [ -z "$DEST" ]; then
  echo "用法: $0 [-n|--dry-run] <本機來源路徑> <user@host> <遠端目的路徑> [ssh_port]" >&2
  exit 1
fi

SRC="${SRC%/}"
DEST="${DEST%/}"

[ -d "$SRC" ] || { echo "錯誤：本機來源不存在或不是目錄：$SRC" >&2; exit 1; }
command -v ssh >/dev/null || { echo "錯誤：找不到 ssh" >&2; exit 1; }
command -v scp >/dev/null || { echo "錯誤：找不到 scp" >&2; exit 1; }

IFS=',' read -r -a EXCLUDE_ARR <<< "$EXCLUDE"

matches_exclude() {
  local rel="$1" pat
  for pat in "${EXCLUDE_ARR[@]}"; do
    pat="$(printf '%s' "$pat" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -n "$pat" ] || continue
    case "$rel" in
      $pat | $pat/*) return 0 ;;
    esac
  done
  return 1
}

SSH_OPTS=(-p "$SSH_PORT")
DEST_Q="$(printf '%q' "$DEST")"

echo "來源：$SRC"
echo "目的：$REMOTE:$DEST (port $SSH_PORT)"
echo "排除：$EXCLUDE"
[ "$DRY_RUN" = true ] && echo "模式：dry-run（只列出，不複製）"
echo

# 1) 取得遠端檔案清單：相對路徑 <TAB> 大小 <TAB> mtime(epoch)
remote_list="$(ssh "${SSH_OPTS[@]}" "$REMOTE" \
  "find $DEST_Q -type f -printf '%P\t%s\t%T@\n' 2>/dev/null" || true)"

declare -A r_size=() r_mtime=()
while IFS=$'\t' read -r rel size mtime; do
  [ -n "${rel:-}" ] || continue
  r_size["$rel"]="$size"
  r_mtime["$rel"]="${mtime%%.*}"
done <<< "$remote_list"

# 2) 比對本機檔案：不存在 / 大小不同 / 本機較新 => 需要更新
updated=()
while IFS= read -r -d '' file; do
  rel="${file#"$SRC"/}"
  matches_exclude "$rel" && continue
  lsize="$(stat -c %s "$file")"
  lmtime="$(stat -c %Y "$file")"
  rsize="${r_size[$rel]:-}"
  rmtime="${r_mtime[$rel]:-0}"
  if [ -z "$rsize" ] || [ "$lsize" != "$rsize" ] || [ "$lmtime" -gt "$rmtime" ]; then
    updated+=("$rel")
  fi
done < <(find "$SRC" -type f -print0)

# 3) 列出變更
if [ "${#updated[@]}" -eq 0 ]; then
  echo "沒有需要更新的檔案。"
  exit 0
fi

echo "以下 ${#updated[@]} 個檔案有更新，將複製到 $REMOTE:$DEST ："
for rel in "${updated[@]}"; do
  echo "  $rel"
done
echo

if [ "$DRY_RUN" = true ]; then
  echo "(dry-run) 未複製任何檔案。"
  exit 0
fi

# 4) 確認（預設 Yes）
read -r -p "確定要複製嗎？[Y/n] " ans || true
ans="${ans:-Y}"
case "$ans" in
  [Yy]* ) ;;
  * ) echo "已取消。"; exit 0 ;;
esac

# 5) 複製（打包成單一 tar，一次傳輸）
list_file="$(mktemp)"
printf '%s\n' "${updated[@]}" > "$list_file"
tar -C "$SRC" -czf - -T "$list_file" | ssh "${SSH_OPTS[@]}" "$REMOTE" \
  "mkdir -p $(printf '%q' "$DEST") && tar -xzf - -C $(printf '%q' "$DEST")"
rm -f "$list_file"

echo
echo "完成，共更新 ${#updated[@]} 個檔案。"
