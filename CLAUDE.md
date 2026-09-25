# kotiki — заметки для Claude

Кейс хакатона ФСП Чувашии «Образовательная платформа». Сайт: https://kodiki.su (www.kodiki.su → kodiki.su).
- `backend/` — сервер на Go + SQLite: API (описание в `API.md`), проверка ответов и Python-кода, прогресс.
  Отдаёт и фронтенд из `ХакатонLastVersion/` (если папки нет — из `Hackaton/`).
- `ХакатонLastVersion/`, `Hackaton/` — интерфейс; `js/api.js` подключает его к серверу, без сервера работает демо на localStorage.
- `Demo_v6.1/` — статическая демо-версия. `Hackaton/server.js` — старая заглушка на Node, на сервере не используется.

## Деплой на VPS — после каждого изменения

Каждый раз, когда коммитишь и пушишь рабочую ветку, сразу выкатывай её на VPS и проверяй:

```bash
git push -u origin <ветка>
deploy/vps.sh deploy                 # по умолчанию текущая ветка; можно указать ветку, тег или SHA
deploy/vps.sh exec 'systemctl status kotiki --no-pager -n 0 | head -n 5; curl -sS 127.0.0.1:8080/api/health'
curl -sS -o /dev/null -w '%{http_code}\n' https://kodiki.su/   # снаружи, если сеть сессии пускает
```

- Деплой идёт только через GitHub Actions (`.github/workflows/vps.yml` в `main`). Прямого SSH из сессии нет.
- `deploy/vps.sh` вызывает workflow через REST API с `$GH_TOKEN` и печатает хвост вывода сервера.
  Другие действия: `exec '<команда>'`, `status`, `rollback`. Команды в `exec` пиши с короткой выдачей.
- Push в `main` деплоит автоматически.
- На сервере: релизы в `/opt/apps/kotiki/releases/<id>`, активный — симлинк `/opt/apps/kotiki/current`,
  общие файлы и `.env` — в `/opt/apps/kotiki/shared`. Хранятся 5 последних релизов.

### Хуки
- `deploy/ci-build.sh` — на раннере GitHub до упаковки: `go vet` и сборка `backend/kotiki-server` (Linux, без CGO).
- `deploy/remote-build.sh` — до переключения релиза: ставит из Debian python3, util-linux, curl, nginx и certbot,
  (если бинарника нет — golang-go и собирает на сервере), создаёт системного пользователя `kotiki`
  и каталог `shared/data` (база SQLite и файлы учеников, переживают релизы). Упал — релиз выброшен.
- `deploy/remote-start.sh` — после переключения: ставит юнит из `deploy/app.service.in`, перезапускает
  `kotiki.service`, ждёт ответа `/api/health` с `"backend":"kotiki-go"` и `/`, затем вызывает `deploy/web.sh`. Упал — автооткат.
- `deploy/web.sh` — nginx для доменов из `deploy/site.conf` (шаблоны `deploy/nginx-*.conf.in`) и сертификат
  Let's Encrypt (webroot `/var/www/letsencrypt`, продлевает `certbot.timer`). HTTP и www перенаправляются
  на `https://kodiki.su`. Если новый конфиг не прошёл `nginx -t`, возвращается прежний.
- `deploy/sandbox/python3` — обёртка с лимитами для кода учеников (256 МБ, 2 с CPU).
  Сервис работает от `kotiki` без sudo, без внешней сети, с ФС только на чтение, кроме `shared/data` (см. юнит).
- Сбросить демо-данные на сервере: `sudo systemctl stop kotiki && sudo rm -f /opt/apps/kotiki/shared/data/kotiki.db* && sudo systemctl start kotiki`
  (только с согласия владельца — удаляет работы учеников).

### Правила
- Приложение слушает только `127.0.0.1:8080`, снаружи открыты 80 и 443 через nginx (согласовано с владельцем).
  Новые внешние порты и домены — только после согласия владельца.
- Секреты никогда не выводить в команды и логи: репозиторий публичный.
- sshd, порт 22 и фаервол не трогать. Удалять данные и чужие сервисы — только с явного согласия.
- В `.github/workflows/` пушить нельзя (у токена нет scope `workflow`). Изменения workflow — полным текстом владельцу.
- Код учеников не запускать от `deploy`: у него sudo без пароля.
