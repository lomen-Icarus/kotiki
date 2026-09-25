#!/usr/bin/env bash
# deploy/remote-build.sh — выполняется на VPS от пользователя deploy в каталоге нового релиза,
# до переключения current. Если скрипт падает, релиз выбрасывается и продолжает работать прежний.
# Переменные от vps-deploy: APP_NAME, APP_DIR, RELEASE_DIR, SHARED_DIR, CURRENT_DIR, PREVIOUS_RELEASE_DIR.
set -euo pipefail

APP_USER="$APP_NAME"   # системный пользователь сервиса: без sudo, без shell, без домашнего каталога
BIN="backend/kotiki-server"

apt_install() {  # ставим только недостающие пакеты Debian
  local need=() p
  for p in "$@"; do
    [ "$(dpkg-query -W -f='${Status}' "$p" 2>/dev/null || true)" = "install ok installed" ] || need+=("$p")
  done
  if [ "${#need[@]}" -gt 0 ]; then
    echo "Ставлю пакеты: ${need[*]}"
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -q
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${need[@]}"
  fi
}

# 1. Пакеты: python3 — проверка решений учеников, util-linux — prlimit для песочницы,
#    nginx и certbot — сайт по HTTPS (deploy/web.sh). Проверяем через dpkg: nginx лежит в /usr/sbin,
#    которого нет в PATH пользователя deploy.
apt_install python3 util-linux curl nginx certbot ca-certificates
echo "$(python3 --version)"

# 2. Сервер на Go. Обычно его уже собрал раннер GitHub (deploy/ci-build.sh), иначе собираем здесь.
if [ ! -f "$BIN" ]; then
  echo "Готового $BIN нет — собираю на сервере"
  apt_install golang-go git
  mkdir -p "$SHARED_DIR/go-cache" "$SHARED_DIR/go-path"
  ( cd backend && GOTOOLCHAIN=auto GOCACHE="$SHARED_DIR/go-cache" GOPATH="$SHARED_DIR/go-path" \
      CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o kotiki-server . )
fi
chmod 755 "$BIN"
[ "$(head -c 4 "$BIN" | od -An -c | tr -d ' ')" = "177ELF" ] || { echo "$BIN — не исполняемый файл Linux"; exit 1; }

# 3. Пользователь, от которого работает сервис и выполняется код учеников.
if ! id "$APP_USER" >/dev/null 2>&1; then
  sudo -n useradd --system --user-group --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin "$APP_USER"
  echo "Создан системный пользователь $APP_USER"
fi

# 4. База и файлы учеников живут в shared/data и переживают релизы. Писать туда может только сервис.
sudo -n install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$SHARED_DIR/data"

# 5. Проверка релиза до переключения.
[ -f ХакатонLastVersion/index.html ] || [ -f Hackaton/index.html ] || { echo "нет папки фронтенда"; exit 1; }
chmod 755 deploy/sandbox/python3
deploy/sandbox/python3 -c 'print("песочница python3: ok")'
bash -n deploy/remote-start.sh
bash -n deploy/web.sh
. deploy/site.conf
[ -n "${DOMAINS:-}" ] || { echo "в deploy/site.conf пустой DOMAINS"; exit 1; }

if [ -f "$SHARED_DIR/.env" ]; then
  ln -sfn "$SHARED_DIR/.env" "$RELEASE_DIR/.env"
fi

echo "Сборка релиза $(basename "$RELEASE_DIR") готова"
