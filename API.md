# API образовательной платформы

Договорённость между бэкендом (Go) и фронтендом. Пока бэкенд не готов, фронтенд может верстать на этих JSON-примерах как на моках.

## Общие правила

- Базовый адрес: `/api`. Формат — JSON, кодировка UTF-8.
- Авторизация: после входа в каждом запросе заголовок `Authorization: Bearer <token>`.
- Роли: `student` (ученик), `curator` (куратор), `admin` (администратор).
- Даты — ISO 8601: `"2026-09-25T14:30:00Z"`. ID — целые числа.
- Списки с пагинацией: `?page=1&limit=20` → `{ "items": [...], "total": 42 }`.
- Ошибки — всегда в одном формате:

```json
{ "error": { "code": "not_found", "message": "Курс не найден" } }
```

| HTTP | code | Когда |
|---|---|---|
| 400 | `bad_request` | неверный JSON или поля |
| 401 | `unauthorized` | нет токена / токен истёк |
| 403 | `forbidden` | роль не подходит |
| 404 | `not_found` | объекта нет |
| 409 | `conflict` | например, логин занят |

---

## 1. Справочник: типы шагов и проверки

Это ядро кейса. Шаг описывается двумя полями:

- `type` — **как шаг выглядит**: `theory`, `quiz`, `scratch`, `minecraft`, `code`, `project` (список открытый, будут новые);
- `check_mode` — **как проверяется**: `none` (засчитывается при прочтении), `answer` (сверка ответа, сразу), `tests` (прогон кода по тестам, сразу), `manual` (уходит куратору).

Каждый шаг ученику приходит с блоком `submit` — описанием формы ответа. **Фронтенд рисует форму по `submit.fields`, а не по `type`.** Благодаря этому новый тип шага на бэкенде не требует переделки формы сдачи.

Виды полей в `submit.fields[].kind`:

| kind | Что рисовать | Что прислать в `answer` |
|---|---|---|
| `single_choice` | радиокнопки из `options` | `"b"` |
| `multi_choice` | чекбоксы из `options` | `["a", "c"]` |
| `number` | поле для числа | `"45"` |
| `text` | многострочный текст | `"Я использовал два цикла..."` |
| `link` | поле для ссылки | `"https://scratch.mit.edu/projects/123"` |
| `file` | загрузка файла (сначала `POST /api/uploads`) | `17` (id загруженного файла) |
| `code` | редактор кода, язык в `language` | `"a, b = map(int, input().split())\nprint(a+b)"` |

Если `submit` = `null` — шаг теоретический, показываем кнопку «Прочитано».

### Содержимое `content` по типам

Текстовые поля с суффиксом `_md` — Markdown. Блочные программы Scratch/Minecraft — поле `program`: текст, одна строка = один блок, отступ = вложенность.

**theory** — теория
```json
{ "body_md": "Scratch — это среда, в которой программы собирают из цветных блоков..." }
```

**quiz** — контрольный вопрос
```json
{
  "question_md": "Где в Scratch происходит всё, что делает программа?",
  "program": null,
  "options": [
    { "id": "a", "text": "В палитре блоков" },
    { "id": "b", "text": "На сцене" },
    { "id": "c", "text": "В области скриптов" },
    { "id": "d", "text": "В меню «Файл»" }
  ]
}
```
(для вопроса «ответ числом» `options` = `null`)

**scratch** — разбор блочной программы
```json
{
  "body_md": "Посмотри на программу спрайта Мяч. Собери её у себя и запусти.",
  "program": "когда щёлкнут по зелёному флажку\nперейти в x: (-200) y: (0)\nповторить (10) раз\n    идти (20) шагов\n    ждать (0.1) секунд\nконец",
  "task_md": "Чему будет равен x мяча, когда программа закончится?"
}
```

**minecraft** — задание в мире
```json
{
  "world_md": "Плоский мир, творческий режим...",
  "task_md": "Собери программу, которая по команде «дорога» строит каменную дорожку длиной 10 блоков.",
  "program": "[Игрок] при команде в чате «прыг»\n    [Агент] телепортировать агента к игроку",
  "blocks_md": "«при команде в чате» из раздела «Игрок»..."
}
```

**code** — задача с тестами
```json
{
  "statement_md": "Даны два целых числа. Выведите их сумму.",
  "input_md": "В одной строке через пробел два целых числа a и b (−10⁹ ≤ a, b ≤ 10⁹).",
  "output_md": "Одно целое число — a + b.",
  "limits": { "time_ms": 1000, "memory_mb": 256 },
  "samples": [
    { "input": "2 3", "output": "5" },
    { "input": "-5 7", "output": "2" }
  ],
  "tests_total": 6
}
```

**project** — самостоятельный проект
```json
{
  "body_md": "Собери свою первую игру «Поймай яблоко»...",
  "requirements": ["Чаша двигается стрелками", "Яблоко падает сверху"],
  "hints_md": "Случайное место: блок «перейти в x: (выдать случайное от −220 до 220) y: 170»."
}
```

Правильные ответы, скрытые тесты, критерии проверки и эталонное решение **никогда не приходят ученику** — только куратору и админу (поле `check`).

---

## 2. Авторизация

### `POST /api/auth/login`
```json
{ "login": "ivanov", "password": "demo123" }
```
Ответ `200`:
```json
{
  "token": "eyJhbGciOi...",
  "user": { "id": 5, "name": "Иван Петров", "login": "ivanov", "role": "student" }
}
```

### `GET /api/auth/me` — кто я
Ответ: объект `user` (как выше).

### `POST /api/auth/logout`
Ответ `204` без тела.

### `POST /api/auth/register` — регистрация ученика
```json
{ "name": "Алексей Тестов", "grade": "5 класс", "login": "alex", "password": "1234" }
```
Ответ `201` — как у входа: `{ "token": "...", "user": { "id": 12, "name": "Алексей Тестов", "login": "alex", "role": "student", "grade": "5 класс" } }`. Создаётся только ученик; курсы у него появятся после назначения администратором. Занятый логин — `409`.

Демо-аккаунты (создаются при первом старте, все данные синтетические, **пароль у всех `1234`**):

| Логин | Роль | Кто это |
|---|---|---|
| `admin` | admin | администратор |
| `curator` | curator | Анна Сергеевна — Scratch и Minecraft |
| `curator2` | curator | Павел Игоревич — Python |
| `masha` | student | Маша Королёва, 4 класс — Scratch + Minecraft, идёт в графике |
| `liza`, `artem`, `sofia`, `timur`, `ivan`, `nikita`, `vera` | student | разные ситуации: застряла на шаге, не заходит неделю, опережает группу, не исправила возвращённую работу |

---

## 3. Каталог (без авторизации)

### `GET /api/catalog`
Параметры (все необязательные): `q` — поиск по названию, `tool` — `scratch|minecraft|python`, `grade` — класс 1–9, `page`, `limit`.

```json
{
  "items": [
    {
      "id": 1,
      "title": "Первые программы в Scratch",
      "short_description": "Собираем программы из блоков: последовательность, цикл, событие, условие.",
      "tool": "scratch",
      "tool_name": "Scratch 3",
      "grades": { "from": 2, "to": 4 },
      "volume": "6–8 занятий по 40 минут",
      "modules_count": 3,
      "steps_count": 11,
      "cover_url": null
    }
  ],
  "total": 3
}
```

### `GET /api/catalog/filters` — значения для фильтров
```json
{
  "tools": [
    { "id": "scratch", "name": "Scratch", "count": 1 },
    { "id": "minecraft", "name": "Minecraft Education", "count": 1 },
    { "id": "python", "name": "Python", "count": 1 }
  ],
  "grades": [2, 3, 4, 5, 6, 7, 8, 9]
}
```

### `GET /api/courses/{id}` — страница курса (паспорт + программа)
Без токена — просто программа. С токеном ученика — ещё его статусы по шагам и прогресс.

```json
{
  "id": 1,
  "title": "Первые программы в Scratch",
  "description_md": "...",
  "goal": "Ученик собирает простые программы из блоков...",
  "tool": "scratch",
  "tool_name": "Scratch 3 (scratch.mit.edu или офлайн-редактор)",
  "grades": { "from": 2, "to": 4 },
  "volume": "6–8 занятий по 40 минут",
  "enrolled": true,
  "progress": { "done": 4, "total": 11, "percent": 36 },
  "next_step": { "id": 5, "title": "Проверь себя: сколько шагов", "module_title": "Циклы" },
  "modules": [
    {
      "id": 1,
      "position": 1,
      "title": "Знакомство со Scratch",
      "steps": [
        { "id": 1, "position": 1, "title": "Сцена, спрайты и блоки", "type": "theory", "check_mode": "none", "max_score": 1, "status": "passed" },
        { "id": 2, "position": 2, "title": "Проверь себя: окно Scratch", "type": "quiz", "check_mode": "auto", "max_score": 2, "status": "passed" },
        { "id": 3, "position": 3, "title": "Разбор: мяч летит к центру", "type": "scratch", "check_mode": "auto", "max_score": 3, "status": "failed" }
      ]
    }
  ]
}
```

`status` шага для ученика: `not_started` | `passed` | `failed` (автопроверка не прошла) | `pending` (ждёт куратора) | `returned` (куратор вернул).

---

## 4. Ученик

### `GET /api/me/courses` — личный кабинет: мои курсы
```json
[
  {
    "course": { "id": 1, "title": "Первые программы в Scratch", "tool": "scratch" },
    "progress": { "done": 4, "total": 11, "percent": 36 },
    "score": { "value": 9, "max": 30 },
    "next_step": { "id": 5, "title": "Проверь себя: сколько шагов", "module_title": "Циклы" },
    "pending_count": 1,
    "returned_count": 0,
    "curator": { "id": 2, "name": "Мария Сергеевна" },
    "last_activity_at": "2026-09-25T14:30:00Z"
  }
]
```

### `GET /api/steps/{id}` — открыть шаг
```json
{
  "id": 3,
  "title": "Разбор: мяч летит к центру",
  "type": "scratch",
  "check_mode": "auto",
  "max_score": 3,
  "content": { "...": "см. раздел 1" },
  "submit": {
    "fields": [ { "name": "value", "kind": "number", "label": "Значение x", "required": true } ]
  },
  "breadcrumbs": {
    "course": { "id": 1, "title": "Первые программы в Scratch" },
    "module": { "id": 1, "title": "Знакомство со Scratch" }
  },
  "index": 3,
  "total": 10,
  "prev_step_id": 2,
  "next_step_id": 4,
  "status": "failed",
  "last_submission": { "...": "объект Submission, см. ниже" }
}
```

Пример `submit` для Minecraft (скриншот + ссылка):
```json
{
  "fields": [
    { "name": "screenshot", "kind": "file", "label": "Скриншот из мира", "required": true, "accept": "image/*" },
    { "name": "project_url", "kind": "link", "label": "Ссылка на проект MakeCode", "required": true }
  ]
}
```

### `POST /api/steps/{id}/submissions` — сдать ответ
Тело — значения полей из `submit.fields`:
```json
{ "answer": { "value": "0" } }
```
Для задачи с кодом:
```json
{ "answer": { "code": "a, b = map(int, input().split())\nprint(a + b)" } }
```
Для теории («Прочитано»):
```json
{ "answer": {} }
```

Ответ `201` — объект **Submission**:
```json
{
  "id": 101,
  "step_id": 3,
  "attempt": 2,
  "status": "passed",
  "score": 3,
  "max_score": 3,
  "check_source": "auto",
  "answer": { "value": "0" },
  "feedback": null,
  "hint": null,
  "tests": null,
  "created_at": "2026-09-25T14:31:00Z",
  "reviewed_at": "2026-09-25T14:31:00Z",
  "reviewer": null
}
```

- Неверный ответ: `"status": "failed"`, `"score": 0`, в `hint` — подсказка, если она есть у шага.
- Ручная проверка: `"status": "pending"`, `"score": null`. Позже куратор ставит `passed` или `returned` и пишет `feedback`.
- Задача с тестами — поле `tests`:

```json
"tests": [
  { "n": 1, "verdict": "OK", "visible": true, "input": "2 3", "expected": "5", "output": "5", "time_ms": 21 },
  { "n": 2, "verdict": "OK", "visible": true, "input": "-5 7", "expected": "2", "output": "2", "time_ms": 19 },
  { "n": 3, "verdict": "WA", "visible": false, "time_ms": 20 },
  { "n": 4, "verdict": "TL", "visible": false, "time_ms": 1000 }
]
```
`verdict`: `OK` — верно, `WA` — неверный ответ, `TL` — превышено время, `RE` — ошибка выполнения, `CE` — синтаксическая ошибка (текст ошибки в `error` первого теста), `SK` — тест не запускался, потому что предыдущий превысил время. Для скрытых тестов вход, ответ и вывод не показываются.

Повторная сдача: пока работа на ручной проверке (`pending`), новая сдача по этому шагу вернёт `409`. Зачтённую теорию и принятую ручную работу повторно сдавать не нужно — вернётся последний результат.

### `GET /api/steps/{id}/submissions` — мои попытки по шагу
Массив Submission, новые сверху.

### `GET /api/me/submissions` — история выполненных заданий
Параметры: `course_id`, `status`, `page`, `limit`.
```json
{
  "items": [
    {
      "submission": { "id": 101, "status": "returned", "score": null, "feedback": "Угол 60° не замкнёт фигуру, попробуй 120°", "created_at": "..." },
      "step": { "id": 7, "title": "Разбор: от квадрата к треугольнику", "type": "scratch" },
      "course": { "id": 1, "title": "Первые программы в Scratch" }
    }
  ],
  "total": 12
}
```

### `GET /api/me/courses/{courseId}/rating` — из чего сложился результат
```json
{
  "score": 9,
  "max": 23,
  "percent": 39,
  "progress": { "done": 5, "total": 10, "percent": 50 },
  "rank": { "place": 2, "of": 4 },
  "formula": "За каждый зачтённый шаг начисляются его баллы: теория — 1, контрольный вопрос — 2, разбор, задание и задача — 3, проект — 5. Работы, проверенные куратором, учитываются так же, как автоматическая проверка. Место в группе — по сумме баллов среди учеников курса.",
  "by_type": [
    { "type": "theory", "title": "Теория", "score": 3, "max": 3 },
    { "type": "quiz", "title": "Контрольный вопрос", "score": 4, "max": 6 },
    { "type": "scratch", "title": "Scratch", "score": 6, "max": 9 },
    { "type": "project", "title": "Проект", "score": 0, "max": 5 }
  ],
  "items": [
    { "step": { "id": 1, "title": "Сцена, спрайты и блоки", "type": "theory" }, "score": 1, "max": 1, "status": "passed", "check_source": "auto" },
    { "step": { "id": 7, "title": "От квадрата к треугольнику", "type": "scratch" }, "score": 3, "max": 3, "status": "passed", "check_source": "curator" },
    { "step": { "id": 9, "title": "Поймай яблоко", "type": "project" }, "score": 0, "max": 5, "status": "pending", "check_source": "curator" }
  ]
}
```

### Вопросы куратору по шагу

`POST /api/steps/{id}/questions`
```json
{ "text": "Почему кот не останавливается после круга?" }
```
Ответ `201`:
```json
{
  "id": 12,
  "step_id": 8,
  "text": "Почему кот не останавливается после круга?",
  "status": "open",
  "answer": null,
  "answered_by": null,
  "created_at": "...",
  "answered_at": null
}
```

`GET /api/steps/{id}/questions` — мои вопросы по этому шагу (с ответами).

`GET /api/me/questions` — все мои вопросы.

---

## 5. Куратор

Все запросы — только с ролью `curator` (или `admin`). Куратор видит только закреплённых за ним учеников.

### `GET /api/curator/students` — мои ученики и отставание
Параметры: `course_id`, `risk`. Сначала идут ученики с `danger`, потом `warning`, потом `ok`.
```json
{
  "counts": { "ok": 4, "warning": 2, "danger": 1 },
  "items": [
    {
      "student": { "id": 5, "name": "Лиза Орлова" },
      "course": { "id": 1, "title": "Первые программы в Scratch", "tool": "scratch" },
      "progress": { "done": 4, "total": 10, "percent": 40 },
      "score": { "value": 7, "max": 23 },
      "current_step": { "id": 5, "title": "Проверь себя: сколько шагов", "type": "quiz", "module_title": "Циклы" },
      "last_activity_at": "2026-09-24T04:27:46Z",
      "days_inactive": 1,
      "pending_count": 0,
      "returned_count": 0,
      "failed_attempts_on_current": 3,
      "group_avg_percent": 45,
      "risk": "warning",
      "risk_label": "Замедлился",
      "risk_reasons": ["3 неудачные попытки подряд на текущем шаге"]
    }
  ]
}
```
`risk`: `ok` («В графике») | `warning` («Замедлился») | `danger` («Выпадает»). Готовая подпись — в `risk_label`.

Как считается сигнал (цель — заметить отставание **до того**, как ученик перестанет заходить):

| Признак | warning | danger |
|---|---|---|
| Не заходил на платформу | 3+ дня | 7+ дней |
| Неудачные попытки подряд на текущем шаге | 3+ | 5+ |
| Процент прохождения ниже среднего по группе | на 25+ пунктов | — |
| Возвращённая работа не исправлена | больше 2 дней | — |
| Три признака уровня warning одновременно | — | да |

### `GET /api/curator/students/{id}` — карточка ученика
```json
{ "student": { "id": 5, "name": "Лиза Орлова" }, "courses": [ "...как items выше..." ], "submissions": [ "...Submission..." ], "questions": [ "...Question..." ] }
```

### `GET /api/curator/queue` — очередь на ручную проверку
Параметры: `course_id`, `type`. Сначала самые старые.
```json
[
  {
    "submission_id": 101,
    "student": { "id": 5, "name": "Иван Петров" },
    "course": { "id": 1, "title": "Первые программы в Scratch" },
    "step": { "id": 7, "title": "Разбор: от квадрата к треугольнику", "type": "scratch" },
    "attempt": 1,
    "submitted_at": "2026-09-25T14:31:00Z",
    "waiting_hours": 3
  }
]
```

### `GET /api/curator/submissions/{id}` — открыть работу
```json
{
  "submission": { "id": 101, "status": "pending", "answer": { "url": "https://scratch.mit.edu/projects/123" }, "created_at": "...", "...": "весь объект Submission" },
  "files": [ { "id": 17, "url": "/uploads/ab12cd34.png", "name": "screenshot.png", "size": 204800, "content_type": "image/png" } ],
  "student": { "id": 5, "name": "Иван Петров" },
  "course": { "id": 1, "title": "Первые программы в Scratch" },
  "step": {
    "id": 7,
    "title": "Разбор: от квадрата к треугольнику",
    "type": "scratch",
    "module_title": "Циклы",
    "content": { "...": "..." },
    "submit": { "fields": [ { "name": "url", "kind": "link", "label": "Ссылка на проект Scratch" } ] },
    "max_score": 3,
    "check": {
      "mode": "manual",
      "criteria": [
        "Программа рисует замкнутый треугольник с тремя равными сторонами.",
        "Используется цикл «повторить 3 раз», а не три копии блоков.",
        "Угол поворота 120 градусов."
      ]
    }
  },
  "previous_attempts": []
}
```

### `POST /api/curator/submissions/{id}/review` — принять или вернуть
```json
{ "decision": "accept", "score": 3, "comment": "Отлично!" }
```
`score` необязателен: по умолчанию ставится максимум за шаг (`max_score`).
```json
{ "decision": "return", "comment": "Угол 60° не замкнёт фигуру — попробуй 120°" }
```
При `return` комментарий обязателен. Ответ — обновлённый Submission.

### Вопросы учеников
`GET /api/curator/questions?status=open` — вопросы моих учеников (с шагом и курсом).

`POST /api/curator/questions/{id}/answer`
```json
{ "text": "Замени «повторять всегда» на «повторить 120 раз»." }
```

---

## 6. Администратор

Все запросы — только с ролью `admin`.

### Пользователи
| Метод | Путь | Тело / параметры |
|---|---|---|
| GET | `/api/admin/users?role=student&q=` | список |
| POST | `/api/admin/users` | `{ "name", "login", "password", "role" }` |
| PATCH | `/api/admin/users/{id}` | любые из полей выше |
| DELETE | `/api/admin/users/{id}` | — |

### Курсы
| Метод | Путь | Что делает |
|---|---|---|
| GET | `/api/admin/courses` | все курсы, включая черновики (`status`: `draft` / `published` / `archived`) |
| POST | `/api/admin/courses` | создать черновик |
| GET | `/api/admin/courses/{id}` | `{ "course": {...}, "modules": [ { "id", "title", "steps": [ { "id", "type", "title", "max_score", "content", "check" } ] } ] }` — **включая `check`** |
| PATCH | `/api/admin/courses/{id}` | изменить паспорт |
| POST | `/api/admin/courses/{id}/publish` | опубликовать (проверяет, что есть хотя бы один шаг) |
| POST | `/api/admin/courses/{id}/unpublish` | снять с публикации |
| DELETE | `/api/admin/courses/{id}` | в архив; `?hard=1` — удалить навсегда вместе с модулями, шагами, работами, вопросами и назначениями |

Тело создания/изменения курса:
```json
{
  "title": "Первые программы в Scratch",
  "short_description": "...",
  "description_md": "...",
  "goal": "...",
  "tool": "scratch",
  "tool_name": "Scratch 3",
  "grades": { "from": 2, "to": 4 },
  "volume": "6–8 занятий по 40 минут"
}
```

Изменять можно и опубликованный курс: правки видны ученикам сразу. Удалённый шаг с уже сданными работами не стирается, а уходит в архив, поэтому история ученика сохраняется.

### Модули
| Метод | Путь | Тело |
|---|---|---|
| POST | `/api/admin/courses/{id}/modules` | `{ "title": "Циклы" }` (добавляется в конец) |
| PATCH | `/api/admin/modules/{id}` | `{ "title": "..." }` |
| DELETE | `/api/admin/modules/{id}` | — |
| PUT | `/api/admin/courses/{id}/modules/order` | `{ "ids": [3, 1, 2] }` — новый порядок |

### Типы шагов — для конструктора курса
`GET /api/step-types` (без входа — нужен ученику, чтобы показать название и иконку типа) и `GET /api/admin/step-types` отдают одно и то же. У каждого типа есть `icon` и признак `custom` — тип добавлен администратором.

**Новый тип шага без изменения кода** — `POST /api/admin/step-types`:
```json
{
  "type": "video",
  "title": "Видео-урок",
  "icon": "▶",
  "description": "Засчитывается после просмотра",
  "check_modes": ["none"],
  "content_fields": [
    { "name": "body_md", "kind": "markdown", "label": "Конспект", "required": true },
    { "name": "video_url", "kind": "text", "label": "Ссылка на видео" }
  ]
}
```
Тип сразу доступен в конструкторе курса, ученик видит такие шаги и сдаёт их теми же механизмами проверки. `DELETE /api/admin/step-types/{type}` удаляет добавленный тип, если нет шагов этого типа (иначе `409`). Встроенные типы удалить нельзя.

`GET /api/admin/step-types` — какие типы шагов есть и какие поля у каждого. **Админ-форма строится по этому ответу.** Когда на бэкенде появляется новый тип, он сразу появляется в конструкторе.

```json
[
  {
    "type": "scratch",
    "title": "Scratch",
    "description": "Разбор блочной программы: ответ числом (автоматически) или изменённый проект по ссылке (куратор).",
    "check_modes": ["answer", "manual"],
    "default_score": 3,
    "content_fields": [
      { "name": "body_md", "kind": "markdown", "label": "Вводный текст" },
      { "name": "program", "kind": "code_block", "label": "Блочная программа (одна строка — один блок)" },
      { "name": "task_md", "kind": "markdown", "label": "Задание", "required": true }
    ],
    "modes": [
      {
        "mode": "answer",
        "title": "Автоматическая: сверка ответа",
        "check_fields": [
          { "name": "answer_kind", "kind": "select", "label": "Вид ответа", "required": true,
            "options": [ { "id": "single_choice", "text": "Один верный вариант" }, { "id": "multi_choice", "text": "Несколько верных вариантов" },
                         { "id": "number", "text": "Число" }, { "id": "text", "text": "Короткий текст" } ] },
          { "name": "correct", "kind": "json", "label": "Верный ответ: \"b\", [\"a\",\"c\"] или \"45\"", "required": true },
          { "name": "hint", "kind": "text", "label": "Подсказка после неверного ответа" }
        ]
      },
      {
        "mode": "manual",
        "title": "Ручная: проверяет куратор",
        "check_fields": [
          { "name": "submit_fields", "kind": "fields", "label": "Что сдаёт ученик: список полей (kind: text, link, file, number, code)", "required": true },
          { "name": "criteria", "kind": "list", "label": "Критерии проверки для куратора" }
        ]
      }
    ]
  }
]
```

Все значения `kind` в `content_fields`: `markdown`, `code_block`, `options` (список `{id, text}`), `list` (список строк), `limits` (`{time_ms, memory_mb}`).
В `check_fields`: `select`, `json`, `text`, `tests` (список `{input, output, visible}`), `code`, `fields` (список полей формы сдачи), `list`.

### Шаги
| Метод | Путь | Тело |
|---|---|---|
| POST | `/api/admin/modules/{id}/steps` | шаг (см. ниже) |
| GET | `/api/admin/steps/{id}` | шаг целиком, с `check` |
| PATCH | `/api/admin/steps/{id}` | любые поля шага |
| DELETE | `/api/admin/steps/{id}` | — |
| PUT | `/api/admin/modules/{id}/steps/order` | `{ "ids": [5, 4, 6] }` |
| POST | `/api/admin/steps/{id}/preview-check` | `{ "answer": {...} }` — проверить, как сработает автопроверка, без сохранения |

Тело шага — пример «Задача с тестами»:
```json
{
  "type": "code",
  "title": "Задача: сумма двух чисел",
  "max_score": 3,
  "content": {
    "statement_md": "Даны два целых числа. Выведите их сумму.",
    "input_md": "В одной строке через пробел два целых числа a и b.",
    "output_md": "Одно целое число — a + b.",
    "limits": { "time_ms": 1000, "memory_mb": 256 }
  },
  "check": {
    "mode": "tests",
    "language": "python3",
    "tests": [
      { "input": "2 3", "output": "5", "visible": true },
      { "input": "-5 7", "output": "2", "visible": true },
      { "input": "0 0", "output": "0", "visible": false }
    ],
    "reference_solution": "a, b = map(int, input().split())\nprint(a + b)"
  }
}
```

Пример «Scratch с ручной проверкой»:
```json
{
  "type": "scratch",
  "title": "Разбор: от квадрата к треугольнику",
  "max_score": 3,
  "content": { "body_md": "...", "program": "...", "task_md": "..." },
  "check": {
    "mode": "manual",
    "submit_fields": [ { "name": "url", "kind": "link", "label": "Ссылка на проект Scratch", "required": true } ],
    "criteria": ["Треугольник замкнут", "Цикл «повторить 3 раз»", "Угол 120°"]
  }
}
```

При сохранении бэкенд проверяет `content` и `check` для указанного `type`. Если что-то не так, отвечает `400` и указывает, какое поле неверное.

### Назначения (ученик ↔ курс ↔ куратор)
| Метод | Путь | Тело |
|---|---|---|
| GET | `/api/admin/enrollments?course_id=&curator_id=` | список |
| POST | `/api/admin/enrollments` | `{ "course_id": 1, "curator_id": 2, "student_ids": [5, 6, 7] }` |
| PATCH | `/api/admin/enrollments/{id}` | `{ "curator_id": 3 }` — сменить куратора |
| DELETE | `/api/admin/enrollments/{id}` | отчислить с курса |

---

## 7. Файлы

### `POST /api/uploads`
`multipart/form-data`, поле `file`. Максимум 10 МБ, картинки и архивы.
```json
{ "id": 17, "url": "/uploads/17-screenshot.png", "name": "screenshot.png", "size": 204800 }
```
В ответе на шаг передаётся `id` файла: `{ "answer": { "screenshot": 17, "project_url": "..." } }`.

---

## 8. Служебное

`GET /api/health` → `{ "status": "ok", "backend": "kotiki-go" }`

---

## Минимум для ядра (с чего начать фронтенду)

1. `POST /api/auth/login`, `GET /api/auth/me`
2. `GET /api/catalog`, `GET /api/courses/{id}`
3. `GET /api/me/courses`, `GET /api/steps/{id}`, `POST /api/steps/{id}/submissions`
4. `GET /api/curator/queue`, `GET /api/curator/submissions/{id}`, `POST /api/curator/submissions/{id}/review`
5. `POST /api/admin/courses`, `POST /api/admin/courses/{id}/modules`, `POST /api/admin/modules/{id}/steps`, `POST /api/admin/courses/{id}/publish`, `POST /api/admin/enrollments`

Остальное — после того как ядро работает.
