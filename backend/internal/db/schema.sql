-- Схема базы данных платформы.
-- Главная идея: у всех шагов одна таблица steps. Чем типы шагов отличаются,
-- лежит в JSON-колонках content (видит ученик) и check_json (видят только куратор и система).
-- Поэтому новый тип шага не требует новой таблицы или миграции.

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    login         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('student', 'curator', 'admin')),
    grade         TEXT,                        -- класс ученика, например «4 класс»
    created_at    TEXT    NOT NULL,
    last_seen_at  TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL,
    expires_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    title             TEXT    NOT NULL,
    short_description TEXT    NOT NULL DEFAULT '',
    description_md    TEXT    NOT NULL DEFAULT '',
    goal              TEXT    NOT NULL DEFAULT '',
    tool              TEXT    NOT NULL DEFAULT '',
    tool_name         TEXT    NOT NULL DEFAULT '',
    grade_from        INTEGER NOT NULL DEFAULT 1,
    grade_to          INTEGER NOT NULL DEFAULT 9,
    volume            TEXT    NOT NULL DEFAULT '',
    cover_url         TEXT,
    status            TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL,
    published_at      TEXT
);

CREATE TABLE IF NOT EXISTS modules (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    title     TEXT    NOT NULL,
    archived  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS steps (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    module_id  INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    type       TEXT    NOT NULL,              -- theory, quiz, scratch, minecraft, code, project, ...
    title      TEXT    NOT NULL,
    content    TEXT    NOT NULL DEFAULT '{}', -- JSON: то, что видит ученик
    check_json TEXT    NOT NULL DEFAULT '{}', -- JSON: как проверять (ответы, тесты, критерии)
    max_score  INTEGER NOT NULL DEFAULT 1,
    archived   INTEGER NOT NULL DEFAULT 0,    -- удалённый шаг с историей сдач уходит в архив
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS enrollments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    curator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT    NOT NULL,
    UNIQUE (course_id, student_id)
);

CREATE TABLE IF NOT EXISTS submissions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    step_id      INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    student_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attempt      INTEGER NOT NULL,
    answer       TEXT    NOT NULL DEFAULT '{}',
    status       TEXT    NOT NULL CHECK (status IN ('passed', 'failed', 'pending', 'returned')),
    score        INTEGER,
    feedback     TEXT,
    hint         TEXT,
    tests        TEXT,                -- JSON: результаты прогона по тестам
    check_source TEXT    NOT NULL,    -- auto | curator
    reviewer_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT    NOT NULL,
    reviewed_at  TEXT
);

CREATE TABLE IF NOT EXISTS questions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    step_id     INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    student_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text        TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered')),
    answer      TEXT,
    answered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT    NOT NULL,
    answered_at TEXT
);

-- Типы шагов, которые администратор добавил сам, без изменения кода.
-- Встроенные типы (theory, quiz, ...) описаны в internal/steps/types.go.
CREATE TABLE IF NOT EXISTS step_types (
    name           TEXT PRIMARY KEY,           -- латиницей, например video
    title          TEXT NOT NULL,
    icon           TEXT NOT NULL DEFAULT '•',
    description    TEXT NOT NULL DEFAULT '',
    check_modes    TEXT NOT NULL DEFAULT '["manual"]', -- JSON-список способов проверки
    content_fields TEXT NOT NULL DEFAULT '[]',         -- JSON-список полей содержания
    created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS uploads (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT    NOT NULL,
    path         TEXT    NOT NULL,
    size         INTEGER NOT NULL,
    content_type TEXT    NOT NULL,
    created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_modules_course      ON modules(course_id, position);
CREATE INDEX IF NOT EXISTS idx_steps_module        ON steps(module_id, position);
CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_id, step_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status  ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_curator ON enrollments(curator_id);
CREATE INDEX IF NOT EXISTS idx_questions_step      ON questions(step_id);
