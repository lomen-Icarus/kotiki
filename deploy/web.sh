#!/usr/bin/env bash
# deploy/web.sh <порт приложения> — вызывается из deploy/remote-start.sh.
# Ставит сайт nginx для доменов из deploy/site.conf и получает сертификат Let's Encrypt.
# Сертификат продлевает certbot.timer из пакета certbot; после продления nginx перечитывает конфиг.
set -euo pipefail

port="$1"
# shellcheck source=site.conf
. deploy/site.conf
read -r -a domains <<<"$DOMAINS"
primary="${domains[0]}"

SITE="/etc/nginx/sites-available/$APP_NAME.conf"
LINK="/etc/nginx/sites-enabled/$APP_NAME.conf"
WEBROOT=/var/www/letsencrypt
CERT_DIR="/etc/letsencrypt/live/$APP_NAME"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

# «http2 on;» понимает nginx 1.25.1+ (в Debian 13 — 1.26). На более старом строку выкидываем.
nginx_ver="$(sudo -n nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9.]*\).*#\1#p')"
old_nginx=""
if [ "$(printf '%s\n' 1.25.1 "$nginx_ver" | sort -V | head -n 1)" != 1.25.1 ]; then old_nginx=1; fi

render() {  # render <http|https> → путь к готовому конфигу
  local out="$tmpdir/$1.conf"
  sed -e "s#@APP_NAME@#${APP_NAME}#g" -e "s#@DOMAINS@#${DOMAINS}#g" -e "s#@PRIMARY@#${primary}#g" \
      -e "s#@PORT@#${port}#g" -e "s#@WEBROOT@#${WEBROOT}#g" -e "s#@CERT_DIR@#${CERT_DIR}#g" \
      "deploy/nginx-$1.conf.in" > "$out"
  if [ -n "$old_nginx" ]; then sed -i '/http2 on;/d' "$out"; fi
  echo "$out"
}

apply_site() {  # apply_site <файл>: поставить конфиг, проверить nginx -t, при ошибке вернуть прежний
  local new="$1" backup="" out
  if sudo -n test -f "$SITE"; then
    backup="$tmpdir/backup.conf"
    sudo -n cat "$SITE" > "$backup"
  fi
  sudo -n install -m 644 "$new" "$SITE"
  sudo -n ln -sfn "$SITE" "$LINK"
  if ! out="$(sudo -n nginx -t 2>&1)"; then
    echo "$out"
    if [ -n "$backup" ]; then sudo -n install -m 644 "$backup" "$SITE"; else sudo -n rm -f "$SITE" "$LINK"; fi
    echo "✗ nginx -t не прошёл — прежний конфиг восстановлен"
    return 1
  fi
  sudo -n systemctl enable --quiet nginx
  sudo -n systemctl reload-or-restart nginx
}

sudo -n install -d -m 755 "$WEBROOT"
# стандартная заглушка nginx тоже претендует на default_server :80 — выключаем её (файл в sites-available остаётся)
if [ -L /etc/nginx/sites-enabled/default ]; then sudo -n rm -f /etc/nginx/sites-enabled/default; fi

have_cert() { sudo -n test -s "$CERT_DIR/fullchain.pem"; }

# Без сертификата сначала поднимаем HTTP: через него Let's Encrypt проверяет домены.
if ! have_cert; then
  apply_site "$(render http)"
fi

d_args=()
for d in "${domains[@]}"; do d_args+=(-d "$d"); done
if ! sudo -n certbot certonly --webroot -w "$WEBROOT" --cert-name "$APP_NAME" "${d_args[@]}" \
     --keep-until-expiring --expand --non-interactive --agree-tos --register-unsafely-without-email \
     --deploy-hook "systemctl reload nginx"; then
  echo "⚠ certbot не получил сертификат для: ${DOMAINS}"
fi

if have_cert; then
  apply_site "$(render https)"
  echo "✓ сайт: https://${primary}"
else
  echo "⚠ HTTPS не настроен, сайт доступен только по http://${primary}"
fi
