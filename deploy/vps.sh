#!/usr/bin/env bash
# deploy/vps.sh — запуск .github/workflows/vps.yml из облачной сессии Claude Code и вывод результата
#   deploy/vps.sh deploy [ref]       выкатить ветку/тег/SHA (по умолчанию — текущую ветку)
#   deploy/vps.sh exec '<команда>'   выполнить команду на VPS (пользователь deploy)
#   deploy/vps.sh status             текущий релиз и журнал деплоев
#   deploy/vps.sh rollback           откат на предыдущий релиз
# Только REST API GitHub через curl (gh в облачной сессии нет), токен — $GH_TOKEN или $GITHUB_TOKEN.
# Репозиторий берётся из git remote origin; переопределить: VPS_REPO=owner/repo
set -euo pipefail

action="${1:-}"
arg="${2:-}"
case "$action" in
  deploy|exec|status|rollback) ;;
  *) sed -n '2,8p' "$0" >&2; exit 2 ;;
esac

token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -z "$token" ]; then echo "нет GH_TOKEN/GITHUB_TOKEN" >&2; exit 2; fi
command -v jq >/dev/null || { echo "нужен jq" >&2; exit 2; }

repo="${VPS_REPO:-}"
if [ -z "$repo" ]; then
  repo="$(git remote get-url origin | sed -E 's#\.git$##; s#/+$##; s#^.*[:/]([^/:]+/[^/:]+)$#\1#')"
fi

api() {  # api METHOD PATH [JSON]
  local method="$1" path="$2" data="${3:-}"
  local args=(-sS --fail-with-body --retry 3 --retry-delay 2 -X "$method"
              -H "Authorization: Bearer $token"
              -H "Accept: application/vnd.github+json"
              -H "X-GitHub-Api-Version: 2022-11-28")
  if [ -n "$data" ]; then args+=(-H "Content-Type: application/json" --data "$data"); fi
  curl "${args[@]}" "https://api.github.com/$path"
}

def="$(api GET "repos/$repo" | jq -r .default_branch)"
rid="cl-$(date +%s)-$RANDOM"

inputs="$(jq -n --arg a "$action" --arg r "$rid" '{action:$a, request_id:$r}')"
case "$action" in
  deploy)
    inputs="$(jq --arg v "${arg:-$(git rev-parse --abbrev-ref HEAD)}" '. + {ref:$v}' <<<"$inputs")"
    ;;
  exec)
    if [ -z "$arg" ]; then echo "нужна команда: deploy/vps.sh exec '<команда>'" >&2; exit 2; fi
    inputs="$(jq --arg v "$arg" '. + {command:$v}' <<<"$inputs")"
    ;;
esac

api POST "repos/$repo/actions/workflows/vps.yml/dispatches" \
  "$(jq -n --arg ref "$def" --argjson inputs "$inputs" '{ref:$ref, inputs:$inputs}')" >/dev/null
echo "▶ $action запущен в $repo (метка $rid), ищу запуск…" >&2

run=""
for _ in $(seq 1 40); do
  run="$(api GET "repos/$repo/actions/workflows/vps.yml/runs?event=workflow_dispatch&per_page=30" \
          | jq -r --arg rid "$rid" '[.workflow_runs[] | select(.display_title | contains($rid)) | .id][0] // empty' || true)"
  if [ -n "$run" ]; then break; fi
  sleep 3
done
if [ -z "$run" ]; then echo "запуск с меткой $rid не найден" >&2; exit 1; fi
echo "run: https://github.com/$repo/actions/runs/$run" >&2

status=""
concl=""
for _ in $(seq 1 480); do   # ждём до ~40 минут
  line="$(api GET "repos/$repo/actions/runs/$run" | jq -r '"\(.status) \(.conclusion)"' || true)"
  status="${line%% *}"
  concl="${line#* }"
  if [ "$status" = completed ]; then break; fi
  sleep 5
done

for job in $(api GET "repos/$repo/actions/runs/$run/jobs" | jq -r '.jobs[].id'); do
  api GET "repos/$repo/check-runs/$job/annotations" \
    | jq -r '.[] | "── \(.title // "") [\(.annotation_level)]\n\(.message)\n"'
done
echo "Итог: ${status:-?} / ${concl:-?}" >&2
[ "$concl" = success ]
