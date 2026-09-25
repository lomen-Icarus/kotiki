#!/usr/bin/env bash
# deploy/bootstrap-vps.sh — одноразовая подготовка VPS под .github/workflows/vps.yml
#
# Запуск на сервере от root:
#   bash bootstrap-vps.sh              # подготовить сервер и вывести 3 блока
#   bash bootstrap-vps.sh --new-key    # выпустить новый ключ для GitHub (старый отзывается)
#   bash bootstrap-vps.sh --pubkey 'ssh-ed25519 AAAA…'   # пустить уже существующий ключ GitHub
#                                      # (переезд на новый сервер: VPS_SSH_KEY в GitHub не меняется)
#   VPS_HOST=1.2.3.4 bash bootstrap-vps.sh   # если автоопределение IP ошиблось
#
# Что делает (повторный запуск безопасен):
#   - пользователь deploy: вход только по ключу, sudo без пароля;
#   - ключ ed25519 для GitHub Actions (приватная часть хранится в /root/.vps-deploy/, только для root);
#   - /opt/apps (владелец deploy) и помощник /usr/local/bin/vps-deploy (deploy/status/rollback);
#   - печатает: [1] секрет VPS_SSH_KEY, [2] секрет VPS_KNOWN_HOSTS, [3] данные о сервере (без секретов).
# Чего НЕ делает: не трогает настройки sshd, порт 22 и фаервол.
set -euo pipefail

DEPLOY_USER=deploy
KEY_DIR=/root/.vps-deploy
KEY="$KEY_DIR/github_actions_ed25519"

if [ "$(id -u)" -ne 0 ]; then echo "Запустите от root: sudo bash $0" >&2; exit 1; fi
new_key=""
ext_pub=""
case "${1:-}" in
  --new-key) new_key=1 ;;
  --pubkey)
    ext_pub="$(printf '%s' "${2:-}" | tr -d '\r' | awk '{print $1" "$2" "$3}' | sed 's/ *$//')"
    [[ "$ext_pub" =~ ^ssh-(ed25519|rsa)\ AAAA[A-Za-z0-9+/=]+ ]] || { echo "--pubkey: нужен публичный ключ вида 'ssh-ed25519 AAAA…'" >&2; exit 2; }
    ;;
  "") ;;
  *) sed -n '2,17p' "$0" >&2; exit 2 ;;
esac

log() { printf '\n\033[1m== %s\033[0m\n' "$*" >&2; }

# ---------- пакеты ----------
need=()
for c in sudo ssh-keygen tar gzip curl flock; do command -v "$c" >/dev/null || need+=("$c"); done
if [ "${#need[@]}" -gt 0 ]; then
  log "Ставлю недостающее: ${need[*]}"
  if command -v apt-get >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    dpkg --configure -a || true   # долечить прерванную установку пакетов, если была
    apt-get update
    apt-get install -y -o Dpkg::Options::=--force-confold sudo openssh-client tar gzip curl util-linux
  elif command -v dnf >/dev/null; then
    dnf install -y -q sudo openssh-clients tar gzip curl util-linux
  elif command -v yum >/dev/null; then
    yum install -y -q sudo openssh-clients tar gzip curl util-linux
  else
    echo "Не знаю пакетный менеджер — поставьте вручную: ${need[*]}" >&2; exit 1
  fi
fi

# ---------- пользователь deploy ----------
log "Пользователь $DEPLOY_USER"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$DEPLOY_USER"
fi
# '*' — пароля нет, но учётка не «заблокирована» (с '!' sshd без PAM не пустит даже по ключу)
usermod -p '*' "$DEPLOY_USER"
home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$home/.ssh"
touch "$home/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"

sudoers=/etc/sudoers.d/90-vps-deploy
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$DEPLOY_USER" > "$sudoers.tmp"
chmod 440 "$sudoers.tmp"
if visudo -cf "$sudoers.tmp" >/dev/null; then mv -f "$sudoers.tmp" "$sudoers"; else rm -f "$sudoers.tmp"; echo "sudoers не прошёл проверку" >&2; exit 1; fi

# ---------- ключ для GitHub Actions ----------
log "Ключ для GitHub Actions"
install -d -m 700 "$KEY_DIR"
if [ -n "$ext_pub" ]; then
  grep -qF "$(cut -d' ' -f1,2 <<<"$ext_pub")" "$home/.ssh/authorized_keys" || printf '%s\n' "$ext_pub" >> "$home/.ssh/authorized_keys"
  echo "Добавлен существующий ключ GitHub: $(ssh-keygen -lf <(printf '%s\n' "$ext_pub") | awk '{print $2}')" >&2
elif [ -n "$new_key" ] && [ -f "$KEY.pub" ]; then
  old="$(cut -d' ' -f1,2 "$KEY.pub")"
  grep -vF "$old" "$home/.ssh/authorized_keys" > "$home/.ssh/authorized_keys.tmp" || true
  cat "$home/.ssh/authorized_keys.tmp" > "$home/.ssh/authorized_keys"
  rm -f "$home/.ssh/authorized_keys.tmp" "$KEY" "$KEY.pub"
  echo "Старый ключ отозван" >&2
fi
if [ -z "$ext_pub" ]; then
  if [ ! -f "$KEY" ]; then
    ssh-keygen -q -t ed25519 -N '' -C "github-actions-vps-deploy@$(hostname)" -f "$KEY"
  fi
  chmod 600 "$KEY"
  pub="$(cat "$KEY.pub")"
  grep -qxF "$pub" "$home/.ssh/authorized_keys" || printf '%s\n' "$pub" >> "$home/.ssh/authorized_keys"
fi

# ---------- /opt/apps и vps-deploy ----------
log "/opt/apps и /usr/local/bin/vps-deploy"
install -d -m 755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /opt/apps

cat > /usr/local/bin/vps-deploy.tmp <<'VPSDEPLOY'
#!/usr/bin/env bash
# vps-deploy — релизы в /opt/apps/<app>: releases/<id>, current -> releases/<id>, shared/
#   vps-deploy deploy   <app> <release-id>   (архив .tar.gz — на stdin)
#   vps-deploy status   <app>
#   vps-deploy rollback <app>
# Хуки из релиза: deploy/remote-build.sh (до переключения current), deploy/remote-start.sh (после).
set -euo pipefail
umask 022
KEEP="${VPS_DEPLOY_KEEP:-5}"
ROOT="${VPS_DEPLOY_ROOT:-/opt/apps}"

usage() { sed -n '2,6p' "$0" >&2; exit 2; }
action="${1:-}"; app="${2:-}"
[ -n "$action" ] && [ -n "$app" ] || usage
[[ "$app" =~ ^[A-Za-z0-9._-]+$ ]] && [ "$app" != . ] && [ "$app" != .. ] || { echo "плохое имя приложения: $app" >&2; exit 2; }

export APP_NAME="$app"
export APP_DIR="$ROOT/$app"
export SHARED_DIR="$APP_DIR/shared"
export CURRENT_DIR="$APP_DIR/current"
RELEASES="$APP_DIR/releases"
JOURNAL="$APP_DIR/deploy.log"

say() { printf '[vps-deploy] %s\n' "$*"; }
journal() { printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$JOURNAL"; }
current_id() { if [ -L "$CURRENT_DIR" ]; then basename "$(readlink "$CURRENT_DIR")"; fi; }
switch_to() {  # атомарно переключить current на releases/$1
  ln -sfn "releases/$1" "$APP_DIR/.current.tmp"
  mv -Tf "$APP_DIR/.current.tmp" "$CURRENT_DIR"
}
run_hook() {  # run_hook <каталог релиза> <имя> [PREVIOUS_RELEASE_DIR]
  local dir="$1" name="$2" hook="$1/deploy/$2"
  if [ ! -f "$hook" ]; then say "хука deploy/$name нет — пропускаю"; return 0; fi
  say "▶ deploy/$name ($(basename "$dir"))"
  ( cd "$dir" && RELEASE_DIR="$dir" PREVIOUS_RELEASE_DIR="${3:-}" bash "$hook" ) < /dev/null
}
prune() {
  local cur; cur="$(current_id)"
  local list; list="$(ls -1 "$RELEASES" | sort)"
  local n; n="$(printf '%s\n' "$list" | grep -c . || true)"
  [ "$n" -gt "$KEEP" ] || return 0
  printf '%s\n' "$list" | head -n "$((n - KEEP))" | while read -r old; do
    [ -n "$old" ] && [ "$old" != "$cur" ] || continue
    rm -rf -- "${RELEASES:?}/$old" && say "удалён старый релиз $old"
  done
}

mkdir -p "$RELEASES" "$SHARED_DIR"
touch "$JOURNAL"

exec 9>"$APP_DIR/.lock"
if [ "$action" != status ] && ! flock -w 600 9; then say "другая операция держит блокировку"; exit 1; fi

case "$action" in
  deploy)
    rel="${3:-}"
    [[ "$rel" =~ ^[A-Za-z0-9._-]+$ ]] || { say "плохой id релиза: $rel"; exit 2; }
    new="$RELEASES/$rel"
    [ ! -e "$new" ] || { say "релиз $rel уже есть"; exit 1; }
    prev_id="$(current_id)"
    prev_dir=""; [ -n "$prev_id" ] && [ -d "$RELEASES/$prev_id" ] && prev_dir="$RELEASES/$prev_id"

    mkdir -p "$new"
    say "распаковка в $new"
    if ! tar -xzf - -C "$new" --no-same-owner; then
      rm -rf -- "$new"; journal "deploy $rel FAILED (распаковка)"; say "✗ архив не распакован"; exit 1
    fi

    if ! run_hook "$new" remote-build.sh "$prev_dir"; then
      rm -rf -- "$new"; journal "deploy $rel FAILED (remote-build)"
      say "✗ remote-build.sh упал — релиз выброшен, работает прежний: ${prev_id:-нет}"; exit 1
    fi

    switch_to "$rel"
    say "current → $rel"
    if ! run_hook "$new" remote-start.sh "$prev_dir"; then
      if [ -n "$prev_dir" ]; then
        say "✗ remote-start.sh упал — откат на $prev_id"
        switch_to "$prev_id"
        if run_hook "$prev_dir" remote-start.sh ""; then
          journal "deploy $rel FAILED (remote-start), откат на $prev_id"
        else
          journal "deploy $rel FAILED (remote-start), откат на $prev_id — и его start тоже упал"
          say "✗ remote-start.sh прежнего релиза тоже упал"
        fi
      else
        journal "deploy $rel FAILED (remote-start), откатываться некуда"
        say "✗ remote-start.sh упал, предыдущего релиза нет"
      fi
      exit 1
    fi
    journal "deploy $rel OK"
    prune
    say "✓ релиз $rel активен"
    ;;
  rollback)
    cur="$(current_id)"
    [ -n "$cur" ] || { say "активного релиза нет"; exit 1; }
    target="$(ls -1 "$RELEASES" | sort | awk -v c="$cur" '($0 "") < (c "")' | tail -n 1)"
    [ -n "$target" ] || { say "релиза старше $cur нет"; exit 1; }
    switch_to "$target"
    say "current → $target (было $cur)"
    if run_hook "$RELEASES/$target" remote-start.sh "$RELEASES/$cur"; then
      journal "rollback $cur -> $target OK"; say "✓ откат выполнен"
    else
      journal "rollback $cur -> $target: remote-start FAILED"; say "✗ remote-start.sh упал после отката"; exit 1
    fi
    ;;
  status)
    say "приложение: $APP_NAME ($APP_DIR)"
    say "активный релиз: $(current_id || true)"
    echo "релизы:"; ls -1 "$RELEASES" | sort | sed 's/^/  /'
    echo "shared:"; ls -1A "$SHARED_DIR" | sed 's/^/  /'
    echo "журнал (последние 20):"; tail -n 20 "$JOURNAL" | sed 's/^/  /'
    ;;
  *) usage ;;
esac
VPSDEPLOY
chmod 755 /usr/local/bin/vps-deploy.tmp
mv -f /usr/local/bin/vps-deploy.tmp /usr/local/bin/vps-deploy

# ---------- адрес и порт SSH ----------
sshd_bin="$(command -v sshd || echo /usr/sbin/sshd)"
port=""
if [ -x "$sshd_bin" ]; then port="$("$sshd_bin" -T 2>/dev/null | awk '$1=="port"{print $2; exit}' || true)"; fi
port="${port:-22}"
host="${VPS_HOST:-}"
if [ -z "$host" ]; then
  host="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
fi
[ -n "$host" ] || host="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
if [ "$port" = 22 ]; then kh_host="$host"; else kh_host="[$host]:$port"; fi

known_hosts=""
for f in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ecdsa_key.pub /etc/ssh/ssh_host_rsa_key.pub; do
  [ -f "$f" ] && known_hosts+="$kh_host $(cut -d' ' -f1,2 "$f")"$'\n'
done

# ---------- предупреждения по sshd (ничего не меняем) ----------
warn=()
if [ -x "$sshd_bin" ]; then
  cfg="$("$sshd_bin" -T -C "user=$DEPLOY_USER,host=github,addr=203.0.113.1" 2>/dev/null || true)"
  grep -qi '^pubkeyauthentication no' <<<"$cfg" && warn+=("В sshd выключен PubkeyAuthentication — вход по ключу не сработает")
  if grep -qiE '^(allowusers|allowgroups) ' <<<"$cfg"; then
    warn+=("В sshd задан AllowUsers/AllowGroups — убедитесь, что $DEPLOY_USER туда входит: $(grep -iE '^(allowusers|allowgroups) ' <<<"$cfg" | tr '\n' ' ')")
  fi
  grep -qiE "^denyusers .*\b$DEPLOY_USER\b" <<<"$cfg" && warn+=("В sshd DenyUsers содержит $DEPLOY_USER")
else
  warn+=("sshd не найден — проверьте, что SSH-сервер установлен")
fi
[ -n "$known_hosts" ] || warn+=("Не найдены /etc/ssh/ssh_host_*_key.pub — VPS_KNOWN_HOSTS пуст")

# ---------- вывод ----------
line() { printf '%*s\n' 72 '' | tr ' ' '='; }
echo
line
if [ -n "$ext_pub" ]; then
  echo "БЛОК 1 — секрет VPS_SSH_KEY: НЕ МЕНЯТЬ (сервер пускает уже существующий ключ из GitHub)"
else
  echo "БЛОК 1 — секрет VPS_SSH_KEY (СЕКРЕТ: только в GitHub Secrets, никому не показывать)"
  line
  cat "$KEY"
fi
line
echo "БЛОК 2 — секрет VPS_KNOWN_HOSTS"
line
printf '%s' "$known_hosts"
line
echo "БЛОК 3 — данные о сервере (секретов нет, можно вставить в промпт сессии)"
line
. /etc/os-release 2>/dev/null || true
echo "ОС: ${PRETTY_NAME:-?}; ядро $(uname -r); $(uname -m)"
echo "CPU: $(nproc); RAM: $(free -h | awk '/^Mem:/{print $2" всего, "$7" доступно"}'); swap: $(free -h | awk '/^Swap:/{print $2}')"
echo "Диск /: $(df -h / | awk 'NR==2{print $2" всего, "$4" свободно"}')"
echo "SSH: $DEPLOY_USER@$host порт $port"
[ "$port" = 22 ] || echo "  ! порт не 22 — задайте переменную репозитория VPS_PORT=$port"
[ "$host" = 45.95.202.69 ] || echo "  ! адрес не 45.95.202.69 — задайте переменную репозитория VPS_HOST=$host"
echo "sudo без пароля для $DEPLOY_USER: $(sudo -u "$DEPLOY_USER" sudo -n true 2>/dev/null && echo да || echo НЕТ)"
echo "vps-deploy: /usr/local/bin/vps-deploy; приложения: /opt/apps/<APP_NAME>/{releases,current,shared}"
echo "Установлено:"
for c in git docker node npm python3 pip3 java nginx caddy psql mysql redis-server systemctl; do
  if p="$(command -v "$c" 2>/dev/null)"; then
    v="$("$c" --version 2>/dev/null | head -n1 || true)"; echo "  $c: ${v:-$p}"
  fi
done
echo "Занятые TCP-порты (LISTEN): $(ss -Hltn 2>/dev/null | awk '{n=split($4,a,":"); print a[n]}' | sort -un | tr '\n' ' ' || true)"
echo "Сеть с сервера (HTTP-код за 10 с; 000 — недоступно):"
for u in https://github.com https://api.github.com https://objects.githubusercontent.com \
         https://registry-1.docker.io/v2/ https://registry.npmjs.org https://pypi.org/simple/ \
         https://deb.debian.org https://archive.ubuntu.com https://mirror.yandex.ru; do
  printf '  %-40s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$u" 2>/dev/null || true)"
done
for w in "${warn[@]}"; do echo "  ! $w"; done
line
echo
echo "Дальше: GitHub → репозиторий → Settings → Secrets and variables → Actions:"
if [ -n "$ext_pub" ]; then
  echo "  VPS_SSH_KEY     = не менять"
else
  echo "  VPS_SSH_KEY     = блок 1 целиком (со строками BEGIN/END)"
fi
echo "  VPS_KNOWN_HOSTS = блок 2"
echo "  переменная VPS_HOST = адрес этого сервера, если он не 45.95.202.69"
[ -n "$ext_pub" ] || echo "Приватный ключ хранится в $KEY (только root). Отозвать/перевыпустить: bash $0 --new-key"
