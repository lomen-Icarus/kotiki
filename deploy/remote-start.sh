#!/usr/bin/env bash
# deploy/remote-start.sh — выполняется на VPS после переключения current.
# Ставит systemd-юнит из шаблона, перезапускает сервис и проверяет, что он отвечает,
# затем настраивает nginx и HTTPS для доменов из deploy/site.conf (deploy/web.sh).
# Если скрипт падает, vps-deploy откатывает current на предыдущий релиз.
set -euo pipefail

UNIT="$APP_NAME.service"
UNIT_PATH="/etc/systemd/system/$UNIT"

# Порт приложения: PORT из shared/.env, если он там задан, иначе 8080 (как в юните).
port=""
if [ -f "$SHARED_DIR/.env" ]; then
  port="$(sed -n 's/^[[:space:]]*PORT=//p' "$SHARED_DIR/.env" | tail -n 1 | tr -d "\"' \r")"
fi
port="${port:-8080}"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
sed -e "s#@APP_NAME@#${APP_NAME}#g" -e "s#@APP_DIR@#${APP_DIR}#g" deploy/app.service.in > "$tmp"
if ! cmp -s "$tmp" "$UNIT_PATH"; then
  sudo -n install -m 644 "$tmp" "$UNIT_PATH"
  sudo -n systemctl daemon-reload
  echo "Юнит $UNIT обновлён"
fi
diag() {
  sudo -n systemctl status "$UNIT" --no-pager -n 0 || true
  sudo -n journalctl -u "$UNIT" -n 40 --no-pager || true
}

sudo -n systemctl enable --quiet "$UNIT"
if ! sudo -n systemctl restart "$UNIT"; then
  echo "✗ systemctl restart $UNIT завершился ошибкой"
  diag
  exit 1
fi

ok=""
for _ in $(seq 1 30); do
  # "backend":"kotiki-go" — отвечает именно новый сервер на Go, а не что-то старое на этом порту
  if curl -fs --max-time 2 "http://127.0.0.1:$port/api/health" | grep -q '"backend":"kotiki-go"' \
     && curl -fs --max-time 2 -o /dev/null "http://127.0.0.1:$port/"; then
    ok=1
    break
  fi
  sleep 1
done
if [ -z "$ok" ]; then
  echo "✗ $UNIT не ответил на 127.0.0.1:$port за 30 с"
  diag
  exit 1
fi
echo "✓ $UNIT отвечает на 127.0.0.1:$port"

bash deploy/web.sh "$port"
