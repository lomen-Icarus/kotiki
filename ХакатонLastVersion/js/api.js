/*
 * Мост между интерфейсом (app.js) и сервером на Go (папка backend/).
 *
 * Если страница открыта с сервера (есть /api/health), этот файл подменяет
 * функции app.js, которые работают с данными: вход, курсы, шаги, сдача работ,
 * очередь куратора, конструктор курсов. Вёрстка и стили остаются из app.js/style.css.
 * Если сервера нет (index.html открыт как файл или через Live Server), ничего не
 * меняется и работает демо-версия на localStorage.
 *
 * Шаг курса рисуется по данным с сервера, а не по названию типа:
 * содержимое — по списку полей типа (content_fields), форма ответа — по submit.fields.
 * Поэтому новый тип шага, добавленный администратором, отображается без правок этого файла.
 */
(function () {
  "use strict";

  const TOKEN_KEY = "kotiki-api-token";
  const API = { token: null, user: null, types: {}, cache: {} };
  window.KOTIKI_API = API;

  // ---------------------------------------------------------------- запросы

  async function call(method, path, body, isForm) {
    const headers = {};
    if (API.token) headers.Authorization = "Bearer " + API.token;
    if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";
    const res = await fetch("/api" + path, {
      method,
      headers,
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch (e) { /* пустой ответ */ }
    if (!res.ok) {
      const msg = data?.error?.message || `Ошибка ${res.status}`;
      if (res.status === 401 && API.token && !path.startsWith("/auth/login")) {
        setToken(null); API.user = null; state.role = null;
        render();
      }
      const err = new Error(msg); err.status = res.status; throw err;
    }
    return data;
  }
  const get = (p) => call("GET", p);
  const post = (p, b) => call("POST", p, b === undefined ? {} : b);
  const patch = (p, b) => call("PATCH", p, b);
  const put = (p, b) => call("PUT", p, b);
  const del = (p) => call("DELETE", p);

  function setToken(t) {
    API.token = t;
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) { /* приватный режим */ }
  }

  function fail(e) { toast(e.message || String(e)); }
  function invalidate() { API.cache = {}; }

  // ---------------------------------------------------------------- помощники разметки

  const STATUS_MAP = { passed: "done", pending: "review", returned: "returned", failed: "failed", not_started: "idle" };
  const st = (s) => STATUS_MAP[s] || "idle";
  const typeOf = (name) => API.types[name] || { type: name, title: name, icon: "•", content_fields: [] };
  const typeTitle = (name) => typeOf(name).title;
  const typeIcon = (name) => typeOf(name).icon || "•";
  const grades = (g) => (g ? (g.from === g.to ? `${g.from} класс` : `${g.from}–${g.to} класс`) : "");
  const MODE_TITLES = { none: "Засчитывается при прочтении", answer: "Автоматическая (ответ)", tests: "Автоматическая (тесты)", manual: "Ручная (куратор)" };
  const VERDICTS = { OK: "верно", WA: "неверный ответ", TL: "превышено время", RE: "ошибка выполнения", CE: "синтаксическая ошибка", SK: "не запускался" };

  function ago(iso) {
    if (!iso) return "—";
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "только что";
    if (m < 60) return `${m} мин назад`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} ч назад`;
    const d = Math.round(h / 24);
    return `${d} дн назад`;
  }

  // Небольшой Markdown: заголовки, списки, код, цитаты, **жирный**, `код`.
  function md(src) {
    if (!src) return "";
    const lines = String(src).replace(/\r\n/g, "\n").split("\n");
    let html = "", i = 0;
    const inline = (t) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    while (i < lines.length) {
      const l = lines[i];
      if (/^```/.test(l)) {
        const buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++; html += `<pre class="source">${esc(buf.join("\n"))}</pre>`; continue;
      }
      if (/^#{1,6}\s/.test(l)) { html += `<h3>${inline(l.replace(/^#+\s*/, ""))}</h3>`; i++; continue; }
      if (/^>\s?/.test(l)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
        html += `<div class="notice">${inline(buf.join(" "))}</div>`; continue;
      }
      if (/^\s*[-*]\s/.test(l)) {
        const buf = [];
        while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) buf.push(`<li>${inline(lines[i++].replace(/^\s*[-*]\s/, ""))}</li>`);
        html += `<ul>${buf.join("")}</ul>`; continue;
      }
      if (/^\s*\d+\.\s/.test(l)) {
        const buf = [];
        while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) buf.push(`<li>${inline(lines[i++].replace(/^\s*\d+\.\s/, ""))}</li>`);
        html += `<ol>${buf.join("")}</ol>`; continue;
      }
      if (!l.trim()) { i++; continue; }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|>|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])) buf.push(lines[i++]);
      html += `<p>${inline(buf.join(" "))}</p>`;
    }
    return html;
  }

  const STYLE = `
  .api-md ul,.api-md ol{padding-left:22px;line-height:1.6}.api-md code{font-family:var(--mono);background:var(--mist);padding:1px 5px;border-radius:5px}
  .api-md .notice{margin:12px 0}.api-badge{font:600 11px var(--mono);padding:3px 7px;border-radius:999px;background:var(--brand-blue-50);color:var(--brand-blue);margin-left:6px}
  .tests-table{width:100%;border-collapse:collapse;margin-top:12px;font-size:14px}.tests-table td,.tests-table th{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}
  .tests-table pre{margin:0;font:13px var(--mono);white-space:pre-wrap}.v-OK{color:var(--done);font-weight:700}.v-WA,.v-RE,.v-CE{color:var(--failed);font-weight:700}.v-TL{color:var(--returned);font-weight:700}.v-SK{color:var(--ink-3)}
  .result-box{margin-top:16px;padding:16px;border-radius:12px;border:1px solid var(--line);background:#fff}.result-box.ok{background:var(--done-bg);border-color:transparent}.result-box.bad{background:var(--failed-bg);border-color:transparent}
  .step-nav{display:flex;justify-content:space-between;gap:12px;margin-top:24px}.form-grid{display:grid;gap:14px}.form-grid label{display:grid;gap:6px;font-weight:600;font-size:14px}
  .form-grid small{font-weight:400;color:var(--ink-3)}.inline-2{display:grid;grid-template-columns:1fr 1fr;gap:12px}.reasons{margin:4px 0 0;padding-left:18px;color:var(--ink-2);font-size:13px}
  .file-thumb{max-width:100%;max-height:320px;border-radius:12px;border:1px solid var(--line);display:block;margin-top:8px}.chk{display:flex;gap:8px;align-items:center;font-weight:400}
  .loading{padding:48px;text-align:center;color:var(--ink-3)}.select-inline{height:40px;border:1px solid var(--line);border-radius:10px;padding:0 10px;background:#fff}`;

  // ---------------------------------------------------------------- загрузка данных по экрану

  function viewKey() {
    return [state.role, state.view, state.courseId, state.stepId, state.reviewId, state.ratingCourse].join("|");
  }

  async function load() {
    const v = state.view;
    if (state.role === "student") {
      if (v === "course") return { course: await get(`/courses/${state.courseId}`) };
      if (v === "step") {
        const [step, questions] = await Promise.all([get(`/steps/${state.stepId}`), get(`/steps/${state.stepId}/questions`)]);
        return { step, questions };
      }
      if (v === "rating") {
        const mine = await get("/me/courses");
        const cid = state.ratingCourse || mine[0]?.course.id;
        return { mine, cid, rating: cid ? await get(`/me/courses/${cid}/rating`) : null };
      }
      if (v === "questions-student") return { questions: await get("/me/questions") };
      if (v === "history") return { history: await get("/me/submissions?limit=100") };
      if (v === "courses") {
        const [mine, catalog] = await Promise.all([get("/me/courses"), get("/catalog")]);
        return { mine, catalog };
      }
      const [mine, questions] = await Promise.all([get("/me/courses"), get("/me/questions")]);
      return { mine, questions };
    }
    if (state.role === "curator") {
      if (v === "review") return { sub: await get(`/curator/submissions/${state.reviewId}`) };
      if (v === "students") return { students: await get("/curator/students") };
      if (v === "questions") return { questions: await get("/curator/questions") };
      const [queue, students] = await Promise.all([get("/curator/queue"), get("/curator/students")]);
      return { queue, students };
    }
    // admin
    if (v === "edit-course") return { data: await get(`/admin/courses/${state.courseId}`) };
    if (v === "edit-step") return { step: await get(`/admin/steps/${state.stepId}`) };
    if (v === "assignments") {
      const [enr, students, curators, courses] = await Promise.all([
        get("/admin/enrollments"), get("/admin/users?role=student"), get("/admin/users?role=curator"), get("/admin/courses")]);
      return { enr, students, curators, courses };
    }
    if (v === "types") return {};
    if (v === "users") return { users: await get("/admin/users") };
    const courses = await get("/admin/courses");
    const details = await Promise.all(courses.map((c) => get(`/admin/courses/${c.id}`)));
    return { courses, details };
  }

  async function loadTypes() {
    const list = await get("/step-types");
    API.types = {};
    list.forEach((t) => { API.types[t.type] = t; });
  }

  // ---------------------------------------------------------------- оболочка

  function navFor(active) {
    const r = state.role;
    if (r === "student") return `${navItem("dashboard", "Главная", active)}${navItem("courses", "Мои курсы", active)}${navItem("history", "История", active)}${navItem("rating", "Рейтинг", active)}${navItem("questions-student", "Мои вопросы", active)}`;
    if (r === "curator") return `${navItem("queue", "Очередь проверки", active, API.badge || "")}${navItem("students", "Ученики", active)}${navItem("questions", "Вопросы", active)}`;
    return `${navItem("admin", "Курсы", active)}${navItem("assignments", "Назначения", active)}${navItem("types", "Типы шагов", active)}${navItem("users", "Пользователи", active)}`;
  }

  function apiShell(content, active) {
    const u = API.user || {};
    const student = state.role === "student";
    const who = u.name + (u.grade ? ` · ${u.grade}` : "");
    const initials = (u.name || "?").split(/\s+/).map((x) => x[0]).join("").slice(0, 2).toUpperCase();
    const label = student ? "Кабинет ученика" : state.role === "curator" ? "Рабочее место куратора" : "Администрирование";
    app.innerHTML = `<div class="shell ${student ? "student" : "staff"}"><header class="topbar"><div class="brand-lockup"><span class="brand-mark">О</span><span>Образовательная платформа</span></div><div class="top-actions"><span class="who">${esc(who)}</span><span class="avatar">${esc(initials)}</span><button class="btn" onclick="logout()">Выйти</button></div></header><div class="layout"><aside class="side"><div class="side-label">${label}</div><nav class="nav">${navFor(active)}</nav><div class="side-bottom"><span>Сервер</span><span class="mono">API</span></div></aside><main class="main">${content}</main></div></div>${state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ""}`;
  }

  function apiRender() {
    if (!state.role || !API.user) { login(); return; }
    const key = viewKey();
    const active = activeNav();
    if (!(key in API.cache)) {
      API.cache[key] = null;
      apiShell(`<div class="loading">Загрузка…</div>`, active);
      load().then((d) => { API.cache[key] = d; if (viewKey() === key) apiRender(); })
        .catch((e) => { delete API.cache[key]; apiShell(`<div class="card empty">Не удалось загрузить: ${esc(e.message)}</div>`, active); });
      return;
    }
    const d = API.cache[key];
    if (d === null) return; // ещё грузится
    apiShell(page(d), active);
    afterRender();
  }

  function activeNav() {
    const v = state.view;
    if (v === "step" || v === "course") return "courses";
    if (v === "review") return "queue";
    if (v === "edit-course" || v === "edit-step") return "admin";
    return v;
  }

  function page(d) {
    const v = state.view, r = state.role;
    if (r === "student") {
      if (v === "course") return coursePageApi(d.course);
      if (v === "step") return stepPageApi(d.step, d.questions);
      if (v === "rating") return ratingPageApi(d);
      if (v === "questions-student") return studentQuestionsApi(d.questions);
      if (v === "history") return historyPageApi(d.history);
      if (v === "courses") return coursesPageApi(d);
      return dashboardApi(d);
    }
    if (r === "curator") {
      if (v === "review") return reviewPageApi(d.sub);
      if (v === "students") return studentsPageApi(d.students);
      if (v === "questions") return curatorQuestionsApi(d.questions);
      API.badge = d.queue.length || "";
      return queuePageApi(d);
    }
    if (v === "edit-course") return editCoursePageApi(d.data);
    if (v === "edit-step") return editStepPageApi(d.step);
    if (v === "assignments") return assignmentsPageApi(d);
    if (v === "types") return typesPageApi();
    if (v === "users") return usersPageApi(d.users);
    return adminPageApi(d);
  }

  let afterRenderHooks = [];
  function afterRender() { const hooks = afterRenderHooks; afterRenderHooks = []; hooks.forEach((f) => f()); }

  // ---------------------------------------------------------------- вход

  function loginApi() {
    origLogin();
    const note = app.querySelector(".login-note");
    if (note) note.textContent = "Данные хранятся на сервере платформы. Все учётные записи синтетические.";
  }

  async function doLoginApi() {
    const login = document.getElementById("auth-login")?.value.trim();
    const password = document.getElementById("auth-password")?.value;
    try {
      const r = await post("/auth/login", { login, password });
      await startSession(r);
    } catch (e) { alert(e.message); }
  }

  async function doRegisterApi() {
    const body = {
      name: document.getElementById("auth-name")?.value.trim(),
      grade: document.getElementById("auth-grade")?.value.trim(),
      login: document.getElementById("auth-login")?.value.trim(),
      password: document.getElementById("auth-password")?.value,
    };
    try {
      const r = await post("/auth/register", body);
      await startSession(r);
      toast("Аккаунт создан. Курсы появятся после назначения администратором.");
    } catch (e) { alert(e.message); }
  }

  async function startSession(r) {
    setToken(r.token);
    API.user = r.user;
    invalidate();
    state.role = r.user.role;
    state.view = r.user.role === "student" ? "dashboard" : r.user.role === "curator" ? "queue" : "admin";
    state.courseId = state.stepId = state.reviewId = null;
    render();
  }

  async function logoutApi() {
    try { await post("/auth/logout"); } catch (e) { /* токен уже недействителен */ }
    setToken(null); API.user = null; invalidate();
    state.role = null; state.authMode = "login";
    render();
  }

  // ---------------------------------------------------------------- ученик

  function courseCardApi(m) {
    const p = m.progress, c = m.course;
    return `<article class="card course-card"><div class="card-top"><span class="tag">${esc(grades(c.grades))}</span><span class="mono muted">${p.done}/${p.total}</span></div><h3>${esc(c.title)}</h3><p class="muted">${esc(c.tool_name || c.tool)}</p>${m.next_step ? `<p class="muted">Дальше: <b>${esc(m.next_step.title)}</b></p>` : `<p class="muted">Курс пройден</p>`}<div class="progress-row"><div class="progress"><i style="width:${p.percent}%"></i></div><span class="mono">${p.percent}%</span></div><div class="course-meta"><span>${m.score.value} из ${m.score.max} баллов</span><span>${m.curator ? "Куратор: " + esc(m.curator.name) : ""}</span></div><button class="btn ghost full" onclick="openCourse('${c.id}')">${m.next_step ? "Продолжить" : "Открыть курс"} →</button></article>`;
  }

  function dashboardApi(d) {
    const mine = d.mine, m = mine.find((x) => x.next_step) || mine[0];
    const pending = mine.reduce((n, x) => n + x.pending_count, 0);
    const returned = mine.reduce((n, x) => n + x.returned_count, 0);
    const answered = d.questions.filter((q) => q.status === "answered").length;
    const n = m?.next_step;
    return `${pageHead("Мои курсы", `Привет, ${(API.user.name || "").split(" ")[0]}!`, "Сегодня главное — один следующий шаг. Всё остальное ниже.")}
    <section class="next-card"><div class="next-copy"><div class="eyebrow light">${n ? `Следующий шаг · ${esc(n.module_title || "")}` : "Нет доступного следующего шага"}</div><h2>${esc(n?.title || (mine.length ? "Все шаги пройдены" : "Курсы появятся после назначения"))}</h2><p>${n ? esc(typeTitle(n.type)) + " · " + esc(m.course.title) : ""}</p><div class="next-progress"><span style="width:${m?.progress.percent || 0}%"></span></div><small>${m ? `${m.progress.done} из ${m.progress.total} шагов уже зачтено` : ""}</small></div>${n ? `<button class="btn light-primary" onclick="openStep('${m.course.id}','${n.id}')">Перейти к шагу →</button>` : ""}</section>
    <div class="grid grid-3"><div class="metric-card"><span class="eyebrow">Прогресс</span><strong>${m ? m.progress.percent : 0}%</strong><p>${m ? esc(m.course.title) : "—"}</p></div><div class="metric-card"><span class="eyebrow">На проверке / возвращено</span><strong>${pending} / ${returned}</strong><p>Работы проверяет куратор. Они не блокируют следующие шаги.</p></div><div class="metric-card"><span class="eyebrow">Ответы куратора</span><strong>${answered}</strong><p>из ${d.questions.length} заданных вопросов</p></div></div>
    <section class="section"><div class="section-head"><h2>Мои курсы</h2><button class="link-btn" onclick="go('courses')">Все курсы →</button></div><div class="grid grid-3">${mine.map(courseCardApi).join("") || `<div class="card empty">Пока нет назначенных курсов.</div>`}</div></section>`;
  }

  function coursesPageApi(d) {
    const mineIds = new Set(d.mine.map((m) => m.course.id));
    const others = d.catalog.items.filter((c) => !mineIds.has(c.id));
    return `${pageHead("Каталог", "Мои курсы", "Курсы, на которые вас записал администратор, и весь каталог платформы.")}
    <div class="grid grid-3 section">${d.mine.map(courseCardApi).join("") || `<div class="card empty">Нет назначенных курсов.</div>`}</div>
    ${others.length ? `<section class="section"><div class="section-head"><h2>Другие курсы платформы</h2></div><div class="grid grid-3">${others.map((c) => `<article class="card course-card"><div class="card-top"><span class="tag">${esc(grades(c.grades))}</span><span class="mono muted">${c.steps_count} шагов</span></div><h3>${esc(c.title)}</h3><p class="muted">${esc(c.short_description)}</p><div class="course-meta"><span>${esc(c.volume)}</span><span>${c.modules_count} модуля</span></div><p class="muted">Записывает администратор.</p></article>`).join("")}</div></section>` : ""}`;
  }

  function openCourseApi(id) { state.courseId = Number(id); state.view = "course"; render(); }

  function coursePageApi(c) {
    if (!c.enrolled) return `<div class="card empty">Вы не записаны на этот курс.</div>`;
    const p = c.progress, n = c.next_step;
    return `<div class="back"><button class="btn" onclick="go('courses')">← Все курсы</button></div><div class="course-head"><div class="course-intro"><div class="eyebrow">${esc(grades(c.grades))} · ${esc(c.tool_name)}</div><h1>${esc(c.title)}</h1><p class="sub">${esc(c.goal)}</p><div class="passport"><span><b>Объём</b>${esc(c.volume)}</span><span><b>Модулей</b>${c.modules.length}</span><span><b>Шагов</b>${p.total}</span><span><b>Баллы</b>${c.score.value} / ${c.score.max}</span></div></div><div class="card progress-card"><span class="eyebrow">Прогресс</span><strong>${p.done}/${p.total}</strong><div class="progress"><i style="width:${p.percent}%"></i></div><span class="mono">${p.percent}%</span>${n ? `<button class="btn primary full" onclick="openStep('${c.id}','${n.id}')">Следующий шаг →</button>` : ""}</div></div>
    <div class="section">${c.modules.map((m, mi) => `<section class="module"><div class="module-head"><div><span class="eyebrow">Модуль ${mi + 1}</span><h2>${esc(m.title)}</h2></div><span class="mono muted">${m.steps.length} шагов</span></div><div class="steps">${m.steps.map((s) => `<button class="step ${n?.id === s.id ? "current" : ""}" onclick="openStep('${c.id}','${s.id}')"><span class="step-icon">${esc(typeIcon(s.type))}</span><span class="step-copy"><b>${esc(s.title)}</b><small>${esc(typeTitle(s.type))} · ${s.max_score} б.</small></span>${statusHTML(st(s.status))}</button>`).join("")}</div></section>`).join("")}</div>`;
  }

  function openStepApi(cid, sid) { state.courseId = Number(cid); state.stepId = Number(sid); state.view = "step"; render(); }

  const PRIMARY_FIELDS = ["body_md", "question_md", "statement_md", "program", "options", "limits"];

  function contentHTML(step) {
    const t = typeOf(step.type), c = step.content || {};
    let html = "";
    for (const f of t.content_fields || []) {
      const val = c[f.name];
      if (val === undefined || val === null || val === "" || (Array.isArray(val) && !val.length)) continue;
      if (f.kind === "options") continue; // варианты рисуются в форме ответа
      const head = PRIMARY_FIELDS.includes(f.name) ? "" : `<h3>${esc(f.label)}</h3>`;
      if (f.kind === "markdown") html += head + md(val);
      else if (f.kind === "code_block") html += head + `<pre class="source">${esc(val)}</pre>`;
      else if (f.kind === "list") html += head + `<ul>${val.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
      else if (f.kind === "limits") html += `<p class="muted mono">Ограничения: ${val.time_ms / 1000} с · ${val.memory_mb} МБ</p>`;
      else if (/^https?:\/\//.test(String(val))) html += head + `<p><a class="real-link" href="${esc(val)}" target="_blank" rel="noopener">${esc(val)} ↗</a></p>`;
      else html += head + `<p>${esc(val)}</p>`;
    }
    if (c.samples?.length) {
      html += `<h3>Примеры</h3><table class="tests-table"><thead><tr><th>Ввод</th><th>Вывод</th></tr></thead><tbody>${c.samples.map((s) => `<tr><td><pre>${esc(s.input)}</pre></td><td><pre>${esc(s.output)}</pre></td></tr>`).join("")}</tbody></table><p class="muted">Всего тестов: ${c.tests_total}. Остальные скрыты.</p>`;
    }
    return `<div class="api-md">${html}</div>`;
  }

  function fieldInput(f) {
    const id = `sf-${f.name}`;
    const label = `<div class="answer-label">${esc(f.label)}${f.required ? "" : " <small class='muted'>(необязательно)</small>"}</div>`;
    switch (f.kind) {
      case "single_choice":
      case "multi_choice":
        return `${label}${(f.options || []).map((o) => `<label class="option"><input type="${f.kind === "single_choice" ? "radio" : "checkbox"}" name="${id}" value="${esc(o.id)}"><span>${esc(o.text)}</span></label>`).join("")}`;
      case "number": return `${label}<input id="${id}" class="field" inputmode="decimal" placeholder="Число">`;
      case "text": return `${label}<textarea id="${id}" class="field" rows="4"></textarea>`;
      case "link": return `${label}<input id="${id}" class="field" type="url" placeholder="https://…">`;
      case "file": return `${label}<input id="${id}" class="field" type="file" ${f.accept ? `accept="${esc(f.accept)}"` : ""}>`;
      case "code": return `${label}<textarea id="${id}" class="code-editor" spellcheck="false" placeholder="# решение на Python 3"></textarea>`;
      default: return `${label}<input id="${id}" class="field">`;
    }
  }

  async function collectAnswer(fields) {
    const answer = {};
    for (const f of fields) {
      const id = `sf-${f.name}`;
      if (f.kind === "single_choice") answer[f.name] = document.querySelector(`input[name="${id}"]:checked`)?.value || null;
      else if (f.kind === "multi_choice") answer[f.name] = [...document.querySelectorAll(`input[name="${id}"]:checked`)].map((x) => x.value);
      else if (f.kind === "file") {
        const file = document.getElementById(id)?.files?.[0];
        if (file) {
          const fd = new FormData(); fd.append("file", file);
          const up = await call("POST", "/uploads", fd, true);
          answer[f.name] = up.id;
        }
      } else answer[f.name] = document.getElementById(id)?.value ?? "";
      const v = answer[f.name];
      if (f.required && (v === null || v === "" || v === undefined || (Array.isArray(v) && !v.length))) {
        throw new Error(`Заполните: «${f.label}»`);
      }
    }
    return answer;
  }

  function testsHTML(tests) {
    if (!tests?.length) return "";
    const ok = tests.filter((t) => t.verdict === "OK").length;
    return `<div class="eyebrow" style="margin-top:12px">Тесты: ${ok} из ${tests.length}</div><table class="tests-table"><thead><tr><th>№</th><th>Результат</th><th>Ввод</th><th>Ожидалось</th><th>Вывод</th><th>Время</th></tr></thead><tbody>${tests.map((t) => `<tr><td class="mono">${t.n}</td><td class="v-${t.verdict}">${t.verdict} <small class="muted">${VERDICTS[t.verdict] || ""}</small>${t.error ? `<pre>${esc(t.error)}</pre>` : ""}</td>${t.visible ? `<td><pre>${esc(t.input || "")}</pre></td><td><pre>${esc(t.expected || "")}</pre></td><td><pre>${esc(t.output || "")}</pre></td>` : `<td colspan="3" class="muted">скрытый тест</td>`}<td class="mono">${t.time_ms} мс</td></tr>`).join("")}</tbody></table>`;
  }

  function lastResultHTML(sub) {
    if (!sub) return "";
    const cls = sub.status === "passed" ? "ok" : sub.status === "failed" || sub.status === "returned" ? "bad" : "";
    const title = { passed: "✓ Зачтено", failed: "✗ Не зачтено", pending: "◷ На проверке у куратора", returned: "↩ Работа возвращена" }[sub.status];
    return `<div class="result-box ${cls}"><b>${title}</b> <span class="muted">· попытка ${sub.attempt} · ${ago(sub.created_at)}${sub.score !== null ? ` · ${sub.score} из ${sub.max_score} б.` : ""}</span>${sub.hint ? `<p>Подсказка: ${esc(sub.hint)}</p>` : ""}${sub.feedback ? `<p><b>Комментарий куратора${sub.reviewer ? " (" + esc(sub.reviewer.name) + ")" : ""}:</b> ${esc(sub.feedback)}</p>` : ""}${testsHTML(sub.tests)}</div>`;
  }

  function stepPageApi(s, questions) {
    const status = s.status, fields = s.submit?.fields || null;
    const canSubmit = status !== "pending" && !(status === "passed" && (s.check_mode === "manual" || s.check_mode === "none"));
    let form = "";
    if (canSubmit) {
      if (!fields) form = `<button class="btn primary submit-btn" onclick="submitStep()">Прочитано, дальше →</button>`;
      else form = `<div class="answer-block">${fields.map(fieldInput).join("")}</div><button class="btn primary submit-btn" onclick="submitStep()">${s.check_mode === "manual" ? "Отправить куратору →" : status === "passed" ? "Отправить ещё раз" : "Проверить →"}</button>`;
    }
    const banner = status === "passed" ? `<div class="success-box">✓ Шаг зачтён <small>${s.last_submission?.check_source === "curator" ? "работу принял куратор" : "проверено автоматически"}</small></div>`
      : status === "pending" ? `<div class="review-box">◷ Работа у куратора <small>Можно продолжать обучение, пока работа проверяется.</small></div>`
      : status === "returned" ? `<div class="return-box">↩ Работа возвращена <small>Исправь по комментарию и отправь снова.</small></div>` : "";
    const qs = questions || [];
    return `<div class="back"><button class="btn" onclick="openCourse('${s.breadcrumbs.course.id}')">← Карта курса</button></div><div class="step-layout"><article class="step-main"><div class="step-top"><span class="tag">${esc(typeTitle(s.type))}</span><span class="mono muted">Шаг ${s.index} из ${s.total} · ${esc(s.breadcrumbs.module.title)}</span></div><h1>${esc(s.title)}</h1><div class="step-content">${contentHTML(s)}</div>
    <div class="step-actions">${banner}${form}</div>${lastResultHTML(s.last_submission)}
    <div class="step-nav">${s.prev_step_id ? `<button class="btn" onclick="openStep('${s.breadcrumbs.course.id}','${s.prev_step_id}')">← Предыдущий</button>` : "<span></span>"}${s.next_step_id ? `<button class="btn" onclick="openStep('${s.breadcrumbs.course.id}','${s.next_step_id}')">Следующий →</button>` : ""}</div>
    <div class="question-box"><div><b>Есть вопрос по этому шагу?</b><small>Напиши куратору — ответ появится здесь.</small></div><button class="btn" onclick="askCurator('${s.breadcrumbs.course.id}','${s.id}')">Задать вопрос</button></div>${qs.map((q) => `<div class="feedback-thread"><div class="eyebrow">Вопрос куратору · ${ago(q.created_at)}</div><p>${esc(q.text)}</p>${q.answer ? `<div class="answer"><b>Ответ: ${esc(q.answered_by?.name || "куратор")}</b><p>${esc(q.answer)}</p></div>` : `<span class="muted">Ожидает ответа</span>`}</div>`).join("")}</article>
    <aside class="step-aside"><div class="card"><div class="eyebrow">Паспорт шага</div><dl><div><dt>Тип</dt><dd>${esc(typeIcon(s.type))} ${esc(typeTitle(s.type))}</dd></div><div><dt>Проверка</dt><dd>${esc(MODE_TITLES[s.check_mode] || s.check_mode)}</dd></div><div><dt>Сдача</dt><dd>${fields ? esc(fields.map((f) => f.label).join(", ")) : "—"}</dd></div><div><dt>Баллы</dt><dd>${s.max_score}</dd></div></dl></div></aside></div>`;
  }

  async function submitStepApi() {
    const d = API.cache[viewKey()];
    if (!d?.step) return;
    const s = d.step, btn = document.querySelector(".submit-btn");
    try {
      const answer = s.submit?.fields ? await collectAnswer(s.submit.fields) : {};
      if (btn) { btn.disabled = true; btn.textContent = s.check_mode === "tests" ? "Проверяем на тестах…" : "Отправляем…"; }
      const sub = await post(`/steps/${s.id}/submissions`, { answer });
      invalidate();
      const msg = { passed: "Зачтено · прогресс обновлён", failed: "Не зачтено — посмотри результат ниже", pending: "Работа отправлена куратору" }[sub.status];
      toast(msg || "Готово");
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = "Проверить →"; }
      fail(e);
    }
  }

  async function askCuratorApi(cid, sid) {
    const text = prompt("Напиши вопрос куратору:");
    if (!text?.trim()) return;
    try { await post(`/steps/${sid}/questions`, { text: text.trim() }); invalidate(); toast("Вопрос отправлен куратору"); } catch (e) { fail(e); }
  }

  function studentQuestionsApi(list) {
    return `${pageHead("Обратная связь", "Мои вопросы", "Вопросы по шагам и ответы куратора.")}<div class="section grid grid-2">${list.map((q) => `<article class="card question-card"><div class="question-meta"><b>${esc(q.course.title)}</b><span>${esc(q.step_title)}</span></div><h3>${esc(q.text)}</h3><p class="muted">${ago(q.created_at)}</p><div class="answer-thread"><div class="eyebrow">${q.answer ? "Ответ куратора" : "Ожидает ответа"}</div><p>${q.answer ? esc(q.answer) : "Куратор ещё не ответил."}</p></div></article>`).join("") || `<div class="card empty">Вопросов пока нет.</div>`}</div>`;
  }

  function historyPageApi(h) {
    return `${pageHead("История", "Мои работы", "Все попытки, результаты проверки и комментарии куратора.")}<div class="table-wrap section"><table class="table"><thead><tr><th>Когда</th><th>Курс</th><th>Шаг</th><th>Статус</th><th>Баллы</th><th>Обратная связь</th></tr></thead><tbody>${h.items.map((x) => `<tr><td class="mono">${ago(x.submission.created_at)}</td><td>${esc(x.course.title)}</td><td><b><a href="#" onclick="openStep('${x.course.id}','${x.step.id}');return false">${esc(x.step.title)}</a></b><small>${esc(typeTitle(x.step.type))} · попытка ${x.submission.attempt}</small></td><td>${statusHTML(st(x.submission.status))}</td><td class="mono">${x.submission.score ?? "—"}</td><td>${esc(x.submission.feedback || x.submission.hint || "—")}</td></tr>`).join("") || `<tr><td colspan="6"><div class="empty">Пока нет сданных работ.</div></td></tr>`}</tbody></table></div>`;
  }

  function ratingPageApi(d) {
    const r = d.rating;
    if (!r) return `${pageHead("Рейтинг", "Мой рейтинг", "")}<div class="card empty">Нет назначенных курсов.</div>`;
    const sel = d.mine.length > 1 ? `<select class="select-inline" onchange="state.ratingCourse=Number(this.value);render()">${d.mine.map((m) => `<option value="${m.course.id}" ${m.course.id === d.cid ? "selected" : ""}>${esc(m.course.title)}</option>`).join("")}</select>` : "";
    return `${pageHead("Рейтинг", "Мой рейтинг", "Каждый балл объясним: ниже видно, из чего сложился результат.")}${sel}
    <div class="rating-layout section"><div class="card rating-total"><span class="eyebrow">Результат</span><strong>${r.score}</strong><span>из ${r.max} баллов · ${r.percent}%</span><div class="rank-line"><b>${r.rank.place}-е место</b><span>из ${r.rank.of} учеников курса</span></div></div>
    <div class="card"><div class="eyebrow">Расшифровка по типам шагов</div><div class="breakdown">${r.by_type.map((t) => `<div><b>${t.score}</b><span>${esc(t.title)} · из ${t.max}</span></div>`).join("")}</div><div class="notice">${esc(r.formula)}</div></div></div>
    <div class="table-wrap section"><table class="table"><thead><tr><th>Шаг</th><th>Статус</th><th>Проверка</th><th>Баллы</th></tr></thead><tbody>${r.items.map((it) => `<tr><td><b>${esc(it.step.title)}</b><small>${esc(it.step.module_title)} · ${esc(typeTitle(it.step.type))}</small></td><td>${statusHTML(st(it.status))}</td><td>${it.check_source === "curator" ? "куратор" : it.check_source === "auto" ? "автоматически" : "—"}</td><td class="mono">${it.score} / ${it.max}</td></tr>`).join("")}</tbody></table></div>`;
  }

  // ---------------------------------------------------------------- куратор

  const RISK_SIGNAL = { ok: "В графике", warning: "Замедлился", danger: "Выпадает" };

  function queuePageApi(d) {
    const cnt = d.students.counts;
    return `${pageHead("Рабочее место куратора", "Очередь проверки", "Работы, которые нельзя проверить автоматически. Сначала самые старые.")}<div class="queue-summary"><div><b>${d.queue.length}</b><span>в очереди</span></div><div><b>${cnt.warning}</b><span>замедлились</span></div><div><b>${cnt.danger}</b><span>выпадают</span></div></div>
    <div class="table-wrap section"><table class="table"><thead><tr><th>Ученик</th><th>Шаг</th><th>Тип</th><th>Ждёт</th><th>Действие</th></tr></thead><tbody>${d.queue.map((q) => `<tr><td><b>${esc(q.student.name)}</b><small>${esc(q.course.title)}</small></td><td>${esc(q.step.title)}<small>${esc(q.step.module_title)} · попытка ${q.attempt}</small></td><td>${esc(typeIcon(q.step.type))} ${esc(typeTitle(q.step.type))}</td><td class="mono">${ago(q.submitted_at)}</td><td><button class="btn small" onclick="openReview('${q.submission_id}')">Проверить →</button></td></tr>`).join("") || `<tr><td colspan="5"><div class="empty">Очередь пуста.</div></td></tr>`}</tbody></table></div>`;
  }

  function openReviewApi(id) { state.reviewId = Number(id); state.view = "review"; render(); }

  function answerView(fields, answer, files) {
    const byId = Object.fromEntries((files || []).map((f) => [f.id, f]));
    return (fields || []).map((f) => {
      const v = answer?.[f.name];
      let body;
      if (v === undefined || v === null || v === "") body = `<span class="muted">не заполнено</span>`;
      else if (f.kind === "file") {
        const file = byId[v];
        body = file ? (/^image\//.test(file.content_type) ? `<a href="${esc(file.url)}" target="_blank"><img class="file-thumb" src="${esc(file.url)}" alt="${esc(file.name)}"></a>` : `<a class="real-link" href="${esc(file.url)}" target="_blank">${esc(file.name)} ↗</a>`) : `<span class="muted">файл #${esc(v)}</span>`;
      } else if (f.kind === "link" || /^https?:\/\//.test(String(v))) body = `<a class="real-link" href="${esc(v)}" target="_blank" rel="noopener">Открыть работу ↗<small>${esc(v)}</small></a>`;
      else if (f.kind === "code" || f.kind === "text") body = `<pre class="source">${esc(v)}</pre>`;
      else body = `<p class="mono">${esc(Array.isArray(v) ? v.join(", ") : v)}</p>`;
      return `<div style="margin-bottom:12px"><div class="eyebrow">${esc(f.label)}</div>${body}</div>`;
    }).join("");
  }

  function reviewPageApi(d) {
    const sb = d.submission, s = d.step, chk = s.check || {};
    const done = sb.status !== "pending";
    return `<div class="back"><button class="btn" onclick="go('queue')">← Очередь</button></div>${pageHead("Ручная проверка", s.title, `${d.student.name} · ${d.course.title} · ${typeTitle(s.type)} · отправлено ${ago(sb.created_at)}`)}
    <div class="review-layout section"><article class="card"><div class="review-work-head"><span class="tag">${esc(typeTitle(s.type))}</span><span class="mono">Попытка ${sb.attempt}</span></div><h2>Работа ученика</h2><div class="submission-preview">${answerView(s.submit?.fields, sb.answer, d.files)}</div>
    <h3>Критерии проверки</h3><ol class="criteria">${(chk.criteria?.length ? chk.criteria : ["Результат соответствует условию шага."]).map((x) => `<li>${esc(x)}</li>`).join("")}</ol>
    <details><summary class="muted">Условие шага</summary><div class="step-content">${contentHTML(s)}</div></details>
    ${d.previous_attempts.length ? `<h3>Предыдущие попытки</h3>${d.previous_attempts.map((p) => `<div class="feedback-thread">${statusHTML(st(p.status))} <span class="muted">${ago(p.created_at)}</span>${p.feedback ? `<p>${esc(p.feedback)}</p>` : ""}</div>`).join("")}` : ""}</article>
    <aside class="card"><div class="eyebrow">Решение куратора</div>${done ? `<p>Работа уже проверена: ${statusHTML(st(sb.status))}</p>${sb.feedback ? `<p>${esc(sb.feedback)}</p>` : ""}` : `<label class="form-grid"><span>Баллы (из ${s.max_score})</span><input id="reviewScore" class="field" type="number" min="0" max="${s.max_score}" value="${s.max_score}"></label><textarea id="reviewComment" class="field" rows="7" placeholder="Комментарий ученику (обязателен при возврате)"></textarea><div class="actions vertical"><button class="btn primary full" onclick="acceptReview('${sb.id}')">✓ Принять работу</button><button class="btn full" onclick="returnReview('${sb.id}')">↩ Вернуть с комментарием</button></div>`}</aside></div>`;
  }

  async function reviewApi(id, decision) {
    const comment = document.getElementById("reviewComment")?.value.trim() || "";
    const score = Number(document.getElementById("reviewScore")?.value);
    try {
      await post(`/curator/submissions/${id}/review`, { decision, comment, score: decision === "accept" ? score : undefined });
      invalidate(); state.view = "queue"; state.reviewId = null;
      toast(decision === "accept" ? "Работа принята · прогресс ученика обновлён" : "Работа возвращена с комментарием");
    } catch (e) { fail(e); }
  }

  function studentsPageApi(d) {
    return `${pageHead("Ученики", "Закреплённые ученики", "Сигнал появляется раньше, чем ученик перестанет заходить: застрял на шаге, отстаёт от группы, не исправил работу.")}
    <div class="queue-summary"><div><b>${d.counts.ok}</b><span>в графике</span></div><div><b>${d.counts.warning}</b><span>замедлились</span></div><div><b>${d.counts.danger}</b><span>выпадают</span></div></div>
    <div class="table-wrap section"><table class="table"><thead><tr><th>Ученик</th><th>Курс</th><th>Прогресс</th><th>Сейчас на шаге</th><th>Активность</th><th>Сигнал</th></tr></thead><tbody>${d.items.map((x) => `<tr><td><b>${esc(x.student.name)}</b>${x.pending_count ? `<small>ЖДЁТ проверки: ${x.pending_count}</small>` : ""}</td><td>${esc(x.course.title)}</td><td><div class="mini-progress"><span style="width:${x.progress.percent}%"></span></div><small>${x.progress.done}/${x.progress.total} · ${x.progress.percent}% (группа ${x.group_avg_percent}%)</small></td><td>${esc(x.current_step?.title || "курс пройден")}${x.failed_attempts_on_current ? `<small>неудачных попыток: ${x.failed_attempts_on_current}</small>` : ""}</td><td class="mono">${ago(x.last_activity_at)}</td><td>${signalHTML(RISK_SIGNAL[x.risk])}${x.risk_reasons.length ? `<ul class="reasons">${x.risk_reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}</td></tr>`).join("") || `<tr><td colspan="6"><div class="empty">Нет закреплённых учеников.</div></td></tr>`}</tbody></table></div>`;
  }

  function curatorQuestionsApi(list) {
    const open = list.filter((q) => q.status === "open"), done = list.filter((q) => q.status !== "open");
    const card = (q) => `<article class="card question-card"><div class="question-meta"><b>${esc(q.student.name)}</b><span>${esc(q.course.title)} · ${esc(q.step_title)}</span></div><h3>${esc(q.text)}</h3><p class="muted">${ago(q.created_at)} · ${q.answer ? "Ответ дан" : "Новый вопрос"}</p><textarea class="field" id="answer-${q.id}" rows="4" placeholder="Ответ ученику">${esc(q.answer || "")}</textarea><button class="btn primary" onclick="answerQuestion('${q.id}')">${q.answer ? "Изменить ответ" : "Ответить ученику"}</button></article>`;
    return `${pageHead("Обратная связь", "Вопросы учеников", "Вопрос привязан к шагу курса, ответ ученик увидит прямо в этом шаге.")}<div class="grid grid-2 section">${open.map(card).join("") || `<div class="card empty">Новых вопросов нет.</div>`}</div>${done.length ? `<section class="section"><div class="section-head"><h2>Отвеченные</h2></div><div class="grid grid-2">${done.map(card).join("")}</div></section>` : ""}`;
  }

  async function answerQuestionApi(id) {
    const text = document.getElementById("answer-" + id)?.value.trim();
    if (!text) { toast("Напиши ответ"); return; }
    try { await post(`/curator/questions/${id}/answer`, { text }); invalidate(); toast("Ответ отправлен ученику"); } catch (e) { fail(e); }
  }

  // ---------------------------------------------------------------- администратор: курсы

  const STATUS_LABEL = { published: ["pub", "Опубликован"], draft: ["draft", "Черновик"], archived: ["draft", "В архиве"] };

  function adminPageApi(d) {
    return `${pageHead("Конструктор", "Курсы", "Курс собирается из модулей и шагов разных типов. Опубликованный курс можно менять — ученики увидят правки сразу.")}<div class="admin-toolbar"><button class="btn primary" onclick="newCourse()">＋ Создать курс</button><span class="muted">Опубликовано: ${d.courses.filter((c) => c.status === "published").length} · Всего: ${d.courses.length}</span></div>
    <div class="grid grid-3 section">${d.courses.map((c, i) => { const det = d.details[i]; const [cls, lab] = STATUS_LABEL[c.status] || ["draft", c.status]; return `<article class="card admin-course"><div class="card-top"><span class="tag">${esc(grades(c.grades))}</span><span class="${cls}">${lab}</span></div><h3>${esc(c.title)}</h3><p class="muted">${c.modules_count} модуля · ${c.steps_count} шагов · ${c.students_count} учеников</p><div class="course-tree">${det.modules.map((m, mi) => `<div><b>${mi + 1}. ${esc(m.title)}</b><span>${m.steps.length}</span></div>`).join("") || `<div>Пустой курс</div>`}</div><div class="actions"><button class="btn" onclick="editCourse('${c.id}')">Редактировать</button><button class="btn ${c.status === "published" ? "" : "primary"}" onclick="togglePublish('${c.id}','${c.status}')">${c.status === "published" ? "Снять публикацию" : "Опубликовать"}</button><button class="btn danger" onclick="deleteCourse('${c.id}')">Удалить навсегда</button></div></article>`; }).join("")}</div>`;
  }

  async function newCourseApi() {
    const title = prompt("Название курса:", "Новый курс");
    if (!title?.trim()) return;
    try {
      const r = await post("/admin/courses", { title: title.trim(), grades: { from: 1, to: 9 } });
      invalidate(); state.courseId = r.course.id; state.view = "edit-course"; render();
    } catch (e) { fail(e); }
  }

  function editCourseApi(id) { state.courseId = Number(id); state.view = "edit-course"; render(); }

  async function togglePublishApi(id, status) {
    try {
      await post(`/admin/courses/${id}/${status === "published" ? "unpublish" : "publish"}`);
      invalidate(); toast(status === "published" ? "Публикация снята" : "Курс опубликован");
    } catch (e) { fail(e); }
  }

  async function deleteCourseApi(id) {
    if (!confirm("Удалить курс полностью? Будут удалены модули, шаги, работы учеников, вопросы и назначения.")) return;
    try { await del(`/admin/courses/${id}?hard=1`); invalidate(); state.view = "admin"; state.courseId = null; toast("Курс удалён"); } catch (e) { fail(e); }
  }

  const TOOLS = [["scratch", "Scratch"], ["minecraft", "Minecraft Education"], ["python", "Python"], ["other", "Другое"]];

  function editCoursePageApi(d) {
    const c = d.course;
    return `<div class="back"><button class="btn" onclick="go('admin')">← Курсы</button></div>${pageHead("Редактор курса", c.title, `Статус: ${(STATUS_LABEL[c.status] || [0, c.status])[1]}. Изменения сохраняются на сервере.`)}
    <div class="editor-grid section"><div class="card form-grid"><div class="eyebrow">Паспорт курса</div>
      <label>Название<input class="field" id="ec-title" value="${esc(c.title)}"></label>
      <label>Короткое описание<input class="field" id="ec-short" value="${esc(c.short_description)}"></label>
      <div class="inline-2"><label>Класс с<input class="field" id="ec-from" type="number" min="1" max="11" value="${c.grades.from}"></label><label>по<input class="field" id="ec-to" type="number" min="1" max="11" value="${c.grades.to}"></label></div>
      <label>Инструмент<select class="field" id="ec-tool">${TOOLS.map(([v, l]) => `<option value="${v}" ${c.tool === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>Название инструмента для ученика<input class="field" id="ec-toolname" value="${esc(c.tool_name)}"></label>
      <label>Объём<input class="field" id="ec-volume" value="${esc(c.volume)}"></label>
      <label>Цель<textarea class="field" id="ec-goal" rows="4">${esc(c.goal)}</textarea></label>
      <label>Описание (Markdown)<textarea class="field" id="ec-desc" rows="4">${esc(c.description_md)}</textarea></label>
      <div class="actions"><button class="btn primary" onclick="saveCourseEdit('${c.id}')">Сохранить</button><button class="btn" onclick="togglePublish('${c.id}','${c.status}')">${c.status === "published" ? "Снять публикацию" : "Опубликовать"}</button></div></div>
    <div class="card"><div class="section-head"><div><div class="eyebrow">Состав курса</div><h2>Модули и шаги</h2></div><button class="btn" onclick="addModule('${c.id}')">＋ Модуль</button></div>
    ${d.modules.map((m, mi) => `<div class="admin-module"><div class="admin-module-head"><div><b>${mi + 1}. ${esc(m.title)}</b><small>${m.steps.length} шагов</small></div><div class="actions">${mi > 0 ? `<button class="btn small" title="Выше" onclick="moveModule('${c.id}',${mi},-1)">↑</button>` : ""}<button class="btn small" onclick="editModule('${c.id}','${m.id}')">Переименовать</button><button class="btn small danger" onclick="deleteModule('${c.id}','${m.id}')">Удалить</button></div></div>
      ${m.steps.map((s, si) => `<div class="admin-step"><span class="step-icon">${esc(typeIcon(s.type))}</span><div><b>${si + 1}. ${esc(s.title)}</b><small>${esc(typeTitle(s.type))} · ${esc(MODE_TITLES[s.check_mode] || s.check_mode)} · ${s.max_score} б.</small></div><div class="actions">${si > 0 ? `<button class="btn small" title="Выше" onclick="moveStep('${m.id}',${si},-1)">↑</button>` : ""}<button class="btn small" onclick="editStepAdmin('${c.id}','${m.id}','${s.id}')">Изменить</button></div></div>`).join("")}
      <button class="btn small" onclick="addStep('${c.id}','${m.id}')">＋ Шаг</button></div>`).join("") || `<div class="empty">Добавьте первый модуль.</div>`}</div></div>`;
  }

  async function saveCourseEditApi(id) {
    const v = (x) => document.getElementById(x).value;
    try {
      await patch(`/admin/courses/${id}`, { title: v("ec-title"), short_description: v("ec-short"), grades: { from: Number(v("ec-from")), to: Number(v("ec-to")) },
        tool: v("ec-tool"), tool_name: v("ec-toolname"), volume: v("ec-volume"), goal: v("ec-goal"), description_md: v("ec-desc") });
      invalidate(); toast("Паспорт курса сохранён");
    } catch (e) { fail(e); }
  }

  async function addModuleApi(cid) {
    const title = prompt("Название модуля:");
    if (!title?.trim()) return;
    try { await post(`/admin/courses/${cid}/modules`, { title: title.trim() }); invalidate(); render(); } catch (e) { fail(e); }
  }
  async function editModuleApi(cid, mid) {
    const title = prompt("Новое название модуля:");
    if (!title?.trim()) return;
    try { await patch(`/admin/modules/${mid}`, { title: title.trim() }); invalidate(); render(); } catch (e) { fail(e); }
  }
  async function deleteModuleApi(cid, mid) {
    if (!confirm("Удалить модуль вместе с шагами? Если по шагам уже есть работы учеников, модуль уйдёт в архив.")) return;
    try { await del(`/admin/modules/${mid}`); invalidate(); render(); } catch (e) { fail(e); }
  }
  async function moveModule(cid, index, dir) {
    const d = API.cache[viewKey()].data, ids = d.modules.map((m) => m.id);
    [ids[index], ids[index + dir]] = [ids[index + dir], ids[index]];
    try { await put(`/admin/courses/${cid}/modules/order`, { ids }); invalidate(); render(); } catch (e) { fail(e); }
  }
  async function moveStep(mid, index, dir) {
    const d = API.cache[viewKey()].data, m = d.modules.find((x) => String(x.id) === String(mid)), ids = m.steps.map((s) => s.id);
    [ids[index], ids[index + dir]] = [ids[index + dir], ids[index]];
    try { await put(`/admin/modules/${mid}/steps/order`, { ids }); invalidate(); render(); } catch (e) { fail(e); }
  }

  // Минимально корректные настройки для нового шага — дальше админ правит их в редакторе.
  function templateFor(typeName) {
    const t = typeOf(typeName), mode = t.check_modes[0];
    const content = {};
    (t.content_fields || []).forEach((f) => { if (f.required) content[f.name] = "Текст шага — заполните в редакторе"; });
    const check = { none: { mode: "none" }, answer: { mode: "answer", answer_kind: "number", correct: "0" },
      tests: { mode: "tests", language: "python3", tests: [{ input: "1", output: "1", visible: true }] },
      manual: { mode: "manual", submit_fields: [{ name: "url", kind: "link", label: "Ссылка на работу", required: true }], criteria: [] } }[mode];
    return { content, check };
  }

  function addStepApi(cid, mid) {
    const opts = Object.values(API.types).map((t) => `<option value="${esc(t.type)}">${esc(t.icon)} ${esc(t.title)}${t.custom ? " (добавлен админом)" : ""}</option>`).join("");
    openModal(`<div class="modal-backdrop" onclick="if(event.target===this)closeModal()"><div class="modal-card form-grid"><div class="section-head"><h2>Новый шаг</h2><button class="btn" onclick="closeModal()">Закрыть</button></div><label>Тип шага<select id="ns-type" class="field">${opts}</select></label><label>Название<input id="ns-title" class="field" value="Новый шаг"></label><div class="actions"><button class="btn primary" onclick="createStepApi('${mid}')">Создать и открыть редактор</button></div></div></div>`);
  }

  async function createStepApi(mid) {
    const type = document.getElementById("ns-type").value, title = document.getElementById("ns-title").value.trim() || "Новый шаг";
    try {
      const { content, check } = templateFor(type);
      const s = await post(`/admin/modules/${mid}/steps`, { type, title, content, check });
      closeModal(); invalidate(); state.stepId = s.id; state.view = "edit-step"; render();
    } catch (e) { fail(e); }
  }

  function editStepAdminApi(cid, mid, sid) { state.courseId = Number(cid); state.stepId = Number(sid); state.view = "edit-step"; render(); }

  function contentFieldEditor(f, val) {
    const id = `ce-${f.name}`, lab = `${esc(f.label)}${f.required ? " *" : ""}`;
    if (f.kind === "options") return `<label>${lab}<small>Один вариант на строку: id|текст (например, a|На сцене)</small><textarea id="${id}" class="field" rows="5">${esc((val || []).map((o) => `${o.id}|${o.text}`).join("\n"))}</textarea></label>`;
    if (f.kind === "list") return `<label>${lab}<small>Один пункт на строку</small><textarea id="${id}" class="field" rows="4">${esc((val || []).join("\n"))}</textarea></label>`;
    if (f.kind === "limits") return `<div class="inline-2"><label>Время, мс<input id="${id}-time" class="field" type="number" value="${val?.time_ms || 1000}"></label><label>Память, МБ<input id="${id}-mem" class="field" type="number" value="${val?.memory_mb || 256}"></label></div>`;
    if (f.kind === "text") return `<label>${lab}<input id="${id}" class="field" value="${esc(val || "")}"></label>`;
    return `<label>${lab}${f.kind === "markdown" ? "<small>Markdown: ## заголовок, - список, ```код```</small>" : ""}<textarea id="${id}" class="field ${f.kind === "code_block" ? "code-editor" : ""}" rows="${f.kind === "code_block" ? 6 : 8}">${esc(val || "")}</textarea></label>`;
  }

  function readContent(fields) {
    const out = {};
    for (const f of fields) {
      const el = document.getElementById(`ce-${f.name}`);
      if (f.kind === "limits") { out[f.name] = { time_ms: Number(document.getElementById(`ce-${f.name}-time`).value) || 1000, memory_mb: Number(document.getElementById(`ce-${f.name}-mem`).value) || 256 }; continue; }
      const v = el?.value ?? "";
      if (f.kind === "options") { const opts = v.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [id, ...rest] = l.split("|"); return { id: id.trim(), text: rest.join("|").trim() }; }); if (opts.length) out[f.name] = opts; }
      else if (f.kind === "list") { const list = v.split("\n").map((x) => x.trim()).filter(Boolean); if (list.length) out[f.name] = list; }
      else if (v.trim()) out[f.name] = v;
    }
    return out;
  }

  function checkEditor(mode, chk) {
    if (mode === "none") return `<p class="muted">Шаг засчитывается, когда ученик нажимает «Прочитано».</p>`;
    if (mode === "answer") {
      const correct = Array.isArray(chk.correct) ? chk.correct.join(", ") : chk.correct ?? "";
      return `<label>Вид ответа<select id="ck-kind" class="field">${[["single_choice", "Один верный вариант"], ["multi_choice", "Несколько верных"], ["number", "Число"], ["text", "Короткий текст"]].map(([v, l]) => `<option value="${v}" ${chk.answer_kind === v ? "selected" : ""}>${l}</option>`).join("")}</select></label><label>Верный ответ<small>Для выбора — id вариантов через запятую (a, c); для текста — допустимые ответы через запятую</small><input id="ck-correct" class="field" value="${esc(correct)}"></label><label>Подсказка после неверного ответа<input id="ck-hint" class="field" value="${esc(chk.hint || "")}"></label><label>Подпись поля ответа<input id="ck-label" class="field" value="${esc(chk.label || "")}"></label>`;
    }
    if (mode === "tests") {
      return `<label>Тесты<small>Блоки через строку «---». В блоке: ввод, строка «=>», ответ. Строка «# скрытый» делает тест скрытым.</small><textarea id="ck-tests" class="field code-editor" rows="12">${esc((chk.tests || []).map((t) => `${t.visible ? "" : "# скрытый\n"}${t.input}\n=>\n${t.output}`).join("\n---\n"))}</textarea></label><label>Эталонное решение (видит только куратор)<textarea id="ck-ref" class="field code-editor" rows="6">${esc(chk.reference_solution || "")}</textarea></label>`;
    }
    return `<label>Что сдаёт ученик<small>Одно поле на строку: вид|подпись. Виды: link, file, text, number, code. Например: file|Скриншот из мира</small><textarea id="ck-fields" class="field" rows="4">${esc((chk.submit_fields || []).map((f) => `${f.kind}|${f.label}`).join("\n"))}</textarea></label><label>Критерии проверки для куратора<small>Один критерий на строку</small><textarea id="ck-criteria" class="field" rows="5">${esc((chk.criteria || []).join("\n"))}</textarea></label>`;
  }

  function readCheck(mode) {
    const v = (id) => document.getElementById(id)?.value ?? "";
    if (mode === "none") return { mode };
    if (mode === "answer") {
      const kind = v("ck-kind"), raw = v("ck-correct").trim();
      const list = raw.split(",").map((x) => x.trim()).filter(Boolean);
      const correct = kind === "multi_choice" || (kind === "text" && list.length > 1) ? list : raw;
      return { mode, answer_kind: kind, correct, hint: v("ck-hint").trim(), label: v("ck-label").trim() };
    }
    if (mode === "tests") {
      const tests = v("ck-tests").split(/\n---\n/).map((b) => b.trim()).filter(Boolean).map((b) => {
        const hidden = /^# скрытый\n/.test(b); b = b.replace(/^# скрытый\n/, "");
        const [input, output] = b.split(/\n=>\n/);
        return { input: (input || "").trim(), output: (output || "").trim(), visible: !hidden };
      });
      return { mode, language: "python3", tests, reference_solution: v("ck-ref") };
    }
    // Имена полей сохраняем прежними: по ним хранятся ответы в уже сданных работах.
    const orig = API.editing.check?.submit_fields || [];
    const submit_fields = v("ck-fields").split("\n").map((l) => l.trim()).filter(Boolean).map((l, i) => {
      const [kind, ...rest] = l.split("|"); const k = kind.trim();
      const label = rest.join("|").trim() || k;
      const prev = orig[i]?.kind === k ? orig[i] : null;
      return prev ? { ...prev, label } : { name: k === "link" ? `url${i || ""}` : `${k}${i}`, kind: k, label, required: true };
    });
    return { mode, submit_fields, criteria: v("ck-criteria").split("\n").map((x) => x.trim()).filter(Boolean) };
  }

  function editStepPageApi(s) {
    const t = typeOf(s.type);
    API.editing = { id: s.id, type: s.type, mode: s.check_mode, check: s.check };
    return `<div class="back"><button class="btn" onclick="editCourse('${state.courseId}')">← Редактор курса</button></div>${pageHead("Редактор шага", s.title, `${t.icon} ${t.title}. Поля формы берутся из описания типа шага на сервере.`)}
    <div class="editor-grid section"><div class="card form-grid"><div class="eyebrow">Содержание — видит ученик</div>
      <label>Название<input id="es-title" class="field" value="${esc(s.title)}"></label>
      <div class="inline-2"><label>Тип<input class="field" value="${esc(t.title)}" disabled></label><label>Баллы за шаг<input id="es-score" class="field" type="number" min="0" value="${s.max_score}"></label></div>
      ${(t.content_fields || []).map((f) => contentFieldEditor(f, s.content?.[f.name])).join("")}</div>
    <div class="card form-grid"><div class="eyebrow">Проверка — ученик не видит</div>
      <label>Способ проверки<select id="es-mode" class="field" onchange="switchCheckMode(this.value)">${t.check_modes.map((m) => `<option value="${m}" ${m === s.check_mode ? "selected" : ""}>${esc(MODE_TITLES[m] || m)}</option>`).join("")}</select></label>
      <div id="check-editor" class="form-grid">${checkEditor(s.check_mode, s.check || {})}</div>
      <div class="actions"><button class="btn primary" onclick="saveStepAdmin()">Сохранить шаг</button><button class="btn danger" onclick="deleteStepAdmin('${s.id}')">Удалить шаг</button></div></div></div>`;
  }

  function switchCheckMode(mode) {
    API.editing.mode = mode;
    document.getElementById("check-editor").innerHTML = checkEditor(mode, mode === API.editing.check?.mode ? API.editing.check : {});
  }

  async function saveStepAdminApi() {
    const e = API.editing, t = typeOf(e.type);
    try {
      await patch(`/admin/steps/${e.id}`, { title: document.getElementById("es-title").value.trim(), max_score: Number(document.getElementById("es-score").value),
        content: readContent(t.content_fields || []), check: readCheck(e.mode) });
      invalidate(); toast("Шаг сохранён"); render();
    } catch (err) { fail(err); }
  }

  async function deleteStepAdminApi(sid) {
    if (!confirm("Удалить шаг? Если по нему уже есть работы учеников, шаг уйдёт в архив.")) return;
    try { await del(`/admin/steps/${sid}`); invalidate(); state.view = "edit-course"; render(); } catch (e) { fail(e); }
  }

  // ---------------------------------------------------------------- администратор: назначения, типы, пользователи

  function assignmentsPageApi(d) {
    API.assignData = d;
    return `${pageHead("Назначения", "Кураторы и ученики", "Кто проходит курс и кто его сопровождает. Ученик видит только назначенные опубликованные курсы.")}<div class="card section"><div class="table-wrap"><table class="table"><thead><tr><th>Ученик</th><th>Курс</th><th>Куратор</th><th></th></tr></thead><tbody>${d.enr.map((a) => `<tr><td>${esc(a.student.name)}</td><td>${esc(a.course.title)}</td><td>${esc(a.curator?.name || "—")}</td><td><button class="btn small" onclick="editAssignment(${a.id})">Сменить куратора</button> <button class="btn small danger" onclick="deleteAssignment(${a.id})">Удалить</button></td></tr>`).join("") || `<tr><td colspan="4"><div class="empty">Назначений нет.</div></td></tr>`}</tbody></table></div><div class="actions"><button class="btn primary" onclick="newAssignment()">＋ Новое назначение</button></div></div>`;
  }

  function newAssignmentApi() {
    const d = API.assignData;
    openModal(`<div class="modal-backdrop" onclick="if(event.target===this)closeModal()"><div class="modal-card form-grid"><div class="section-head"><h2>Новое назначение</h2><button class="btn" onclick="closeModal()">Закрыть</button></div>
    <label>Курс<select id="as-course" class="field">${d.courses.map((c) => `<option value="${c.id}">${esc(c.title)}${c.status !== "published" ? " (черновик)" : ""}</option>`).join("")}</select></label>
    <label>Куратор<select id="as-curator" class="field">${d.curators.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></label>
    <label>Ученики<small>Можно выбрать нескольких (Ctrl + клик)</small><select id="as-students" class="field" multiple size="8" style="height:auto">${d.students.map((s) => `<option value="${s.id}">${esc(s.name)}${s.grade ? " · " + esc(s.grade) : ""}</option>`).join("")}</select></label>
    <div class="actions"><button class="btn primary" onclick="saveAssignment()">Назначить</button></div></div></div>`);
  }

  async function saveAssignmentApi() {
    const student_ids = [...document.getElementById("as-students").selectedOptions].map((o) => Number(o.value));
    try {
      await post("/admin/enrollments", { course_id: Number(document.getElementById("as-course").value), curator_id: Number(document.getElementById("as-curator").value), student_ids });
      closeModal(); invalidate(); toast("Назначение сохранено"); render();
    } catch (e) { fail(e); }
  }

  function editAssignmentApi(id) {
    const d = API.assignData, a = d.enr.find((x) => x.id === id);
    openModal(`<div class="modal-backdrop" onclick="if(event.target===this)closeModal()"><div class="modal-card form-grid"><div class="section-head"><h2>${esc(a.student.name)} · ${esc(a.course.title)}</h2><button class="btn" onclick="closeModal()">Закрыть</button></div><label>Куратор<select id="as-curator" class="field">${d.curators.map((c) => `<option value="${c.id}" ${a.curator?.id === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label><div class="actions"><button class="btn primary" onclick="updateAssignmentApi(${id})">Сохранить</button></div></div></div>`);
  }
  async function updateAssignmentApi(id) {
    try { await patch(`/admin/enrollments/${id}`, { curator_id: Number(document.getElementById("as-curator").value) }); closeModal(); invalidate(); render(); } catch (e) { fail(e); }
  }
  async function deleteAssignmentApi(id) {
    if (!confirm("Удалить назначение? Ученик перестанет видеть курс, история его работ сохранится.")) return;
    try { await del(`/admin/enrollments/${id}`); invalidate(); render(); } catch (e) { fail(e); }
  }

  function typesPageApi() {
    const list = Object.values(API.types);
    return `${pageHead("Архитектура", "Типы шагов", "Тип шага описывает, какие поля есть у шага и какими способами он проверяется. Новый тип добавляется здесь, без программиста: он сразу доступен в конструкторе, а ученик видит его в курсе.")}
    <div class="type-grid section">${list.map((t) => `<div class="type-card"><span class="step-icon">${esc(t.icon)}</span><div><b>${esc(t.title)}${t.custom ? `<span class="api-badge">новый</span>` : ""}</b><small>${esc(t.description || "")}</small><small>Проверка: ${t.check_modes.map((m) => MODE_TITLES[m] || m).join(" / ")}</small>${t.custom ? `<button class="btn small danger" style="margin-top:8px" onclick="deleteStepType('${esc(t.type)}')">Удалить тип</button>` : ""}</div></div>`).join("")}<button class="type-card dashed type-add" onclick="newStepType()"><span class="step-icon">＋</span><div><b>Новый тип</b><small>Без изменения кода</small></div></button></div>`;
  }

  function newStepTypeApi() {
    openModal(`<div class="modal-backdrop" onclick="if(event.target===this)closeModal()"><div class="modal-card form-grid"><div class="section-head"><h2>Новый тип шага</h2><button class="btn" onclick="closeModal()">Закрыть</button></div>
    <div class="inline-2"><label>Код (латиницей)<input id="nt-type" class="field" placeholder="video"></label><label>Иконка<input id="nt-icon" class="field" maxlength="2" placeholder="▶"></label></div>
    <label>Название<input id="nt-title" class="field" placeholder="Видео-урок"></label>
    <label>Описание<input id="nt-desc" class="field" placeholder="Засчитывается после просмотра"></label>
    <div><div class="answer-label">Способы проверки</div>${Object.entries(MODE_TITLES).map(([m, l]) => `<label class="chk"><input type="checkbox" name="nt-mode" value="${m}" ${m === "manual" ? "checked" : ""}> ${l}</label>`).join("")}</div>
    <label>Поля содержания<small>Одно поле на строку: код|вид|подпись. Виды: markdown, text, code_block, list, options, limits. Первое поле обязательное.</small><textarea id="nt-fields" class="field" rows="4">body_md|markdown|Текст задания\nvideo_url|text|Ссылка на видео</textarea></label>
    <div class="actions"><button class="btn primary" onclick="createStepTypeApi()">Добавить тип</button></div></div></div>`);
  }

  async function createStepTypeApi() {
    const v = (id) => document.getElementById(id).value.trim();
    const content_fields = v("nt-fields").split("\n").map((l) => l.trim()).filter(Boolean).map((l, i) => {
      const [name, kind, ...label] = l.split("|").map((x) => x.trim());
      return { name, kind: kind || "markdown", label: label.join("|") || name, required: i === 0 };
    });
    const check_modes = [...document.querySelectorAll('input[name="nt-mode"]:checked')].map((x) => x.value);
    try {
      await post("/admin/step-types", { type: v("nt-type"), title: v("nt-title"), icon: v("nt-icon"), description: v("nt-desc"), check_modes, content_fields });
      await loadTypes(); closeModal(); invalidate(); toast("Тип шага добавлен — он уже доступен в конструкторе курса"); render();
    } catch (e) { fail(e); }
  }

  async function deleteStepType(name) {
    if (!confirm("Удалить этот тип шага?")) return;
    try { await del(`/admin/step-types/${name}`); await loadTypes(); invalidate(); render(); } catch (e) { fail(e); }
  }

  const ROLE_LABEL = { student: "Ученик", curator: "Куратор", admin: "Администратор" };

  function usersPageApi(users) {
    return `${pageHead("Пользователи", "Учётные записи", "Администратор создаёт кураторов и учеников. Ученик может зарегистрироваться и сам.")}<div class="card section"><div class="table-wrap"><table class="table"><thead><tr><th>Имя</th><th>Логин</th><th>Роль</th><th>Был на платформе</th><th></th></tr></thead><tbody>${users.map((u) => `<tr><td><b>${esc(u.name)}</b>${u.grade ? `<small>${esc(u.grade)}</small>` : ""}</td><td class="mono">${esc(u.login)}</td><td>${ROLE_LABEL[u.role]}</td><td class="mono">${ago(u.last_seen_at)}</td><td>${u.id !== API.user.id ? `<button class="btn small danger" onclick="deleteUserApi(${u.id})">Удалить</button>` : ""}</td></tr>`).join("")}</tbody></table></div><div class="actions"><button class="btn primary" onclick="newUserApi()">＋ Пользователь</button></div></div>`;
  }
  function newUserApi() {
    openModal(`<div class="modal-backdrop" onclick="if(event.target===this)closeModal()"><div class="modal-card form-grid"><div class="section-head"><h2>Новый пользователь</h2><button class="btn" onclick="closeModal()">Закрыть</button></div><label>Имя<input id="nu-name" class="field"></label><div class="inline-2"><label>Логин<input id="nu-login" class="field"></label><label>Пароль<input id="nu-pass" class="field" type="password"></label></div><label>Роль<select id="nu-role" class="field"><option value="student">Ученик</option><option value="curator">Куратор</option><option value="admin">Администратор</option></select></label><div class="actions"><button class="btn primary" onclick="createUserApi()">Создать</button></div></div></div>`);
  }
  async function createUserApi() {
    const v = (id) => document.getElementById(id).value;
    try { await post("/admin/users", { name: v("nu-name"), login: v("nu-login"), password: v("nu-pass"), role: v("nu-role") }); closeModal(); invalidate(); render(); } catch (e) { fail(e); }
  }
  async function deleteUserApi(id) {
    if (!confirm("Удалить пользователя вместе с его работами?")) return;
    try { await del(`/admin/users/${id}`); invalidate(); render(); } catch (e) { fail(e); }
  }

  // ---------------------------------------------------------------- подключение

  let origLogin;

  function install() {
    origLogin = window.login;
    const over = {
      login: loginApi, doLogin: doLoginApi, doRegister: doRegisterApi, logout: logoutApi, render: apiRender,
      openCourse: openCourseApi, openStep: openStepApi, submitStep: submitStepApi, askCurator: askCuratorApi,
      openReview: openReviewApi, acceptReview: (id) => reviewApi(id, "accept"), returnReview: (id) => reviewApi(id, "return"),
      answerQuestion: answerQuestionApi,
      newCourse: newCourseApi, editCourse: editCourseApi, saveCourseEdit: saveCourseEditApi, togglePublish: togglePublishApi,
      deleteCourse: deleteCourseApi, addModule: addModuleApi, editModule: editModuleApi, deleteModule: deleteModuleApi,
      addStep: addStepApi, editStepAdmin: editStepAdminApi, saveStepAdmin: saveStepAdminApi, deleteStepAdmin: deleteStepAdminApi,
      newAssignment: newAssignmentApi, editAssignment: editAssignmentApi, saveAssignment: saveAssignmentApi, deleteAssignment: deleteAssignmentApi,
      newStepType: newStepTypeApi,
      // новые функции, которых нет в app.js
      createStepApi, switchCheckMode, moveModule, moveStep, updateAssignmentApi, createStepTypeApi, deleteStepType,
      newUserApi, createUserApi, deleteUserApi,
    };
    Object.assign(window, over);
    // toast() из app.js вызывает render() — после любой операции экран перерисуется с сервера.
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  async function boot() {
    await loadTypes(); // если сервер не отвечает как надо — остаёмся в демо-режиме
    install();
    try { API.token = localStorage.getItem(TOKEN_KEY); } catch (e) { API.token = null; }
    state.role = null; state.view = "dashboard";
    if (API.token) {
      try {
        API.user = await get("/auth/me");
        state.role = API.user.role;
        state.view = API.user.role === "student" ? "dashboard" : API.user.role === "curator" ? "queue" : "admin";
      } catch (e) { setToken(null); }
    }
    render();
  }

  if (location.protocol.startsWith("http")) {
    fetch("/api/health").then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (j?.backend === "kotiki-go") boot().catch((e) => console.error("api.js:", e));
    }).catch(() => { /* сервера нет — работает демо на localStorage */ });
  }
})();
