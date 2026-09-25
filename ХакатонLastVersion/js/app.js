/*
 * Educational Platform MVP
 * Clean Code pass v6
 *
 * Structure:
 * 1. Data helpers
 * 2. Rendering
 * 3. Student flow
 * 4. Curator/Admin actions
 * 5. Events
 *
 * Course data remains in data.js.
 */

let db=loadDB();
migrateDemoData();
const app=document.getElementById("app");
let state={role:null,view:"dashboard",courseId:null,stepId:null,reviewId:null,attemptId:null,toast:"",authMode:"login"};

const TYPE_ICONS={"Теория":"T","Контрольный вопрос":"?","Scratch":"S","Minecraft Education":"M","Задача с тестами":"⌘","Проект":"P"};
const STATUS={done:["✓","Зачтено","done"],review:["◷","На проверке","review"],returned:["↩","Возвращено","returned"],failed:["!","Не прошло тесты","failed"],progress:["→","В процессе","progress"],idle:["○","Не начато","idle"]};
const SIGNAL={"Выпадает":["↘","Выпадает","danger"],"Замедлился":["◌","Замедлился","warn"],"В графике":["✓","В графике","ok"],"ЖДЁТ":["◷","ЖДЁТ","warn"]};
const DEFAULT_TYPES=[["Теория","T","Прочтение"],["Контрольный вопрос","?","Автопроверка"],["Scratch","S","Авто или вручную"],["Minecraft Education","M","Ручная"],["Задача с тестами","⌘","Автопроверка"],["Проект","P","Ручная"]];

// ======================
// DATA HELPERS
// ======================

function esc(v=""){return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}
function course(id){return db.courses.find(x=>x.id===id)}
function allSteps(c){return c?.modules?.flatMap(m=>m.steps||[])||[]}
function stepOf(cid,sid){return allSteps(course(cid)).find(s=>s.id===sid)}
function currentAccount(){return (db.accounts||[]).find(a=>a.id===db.user?.accountId)}
function currentStudent(){const a=currentAccount();return db.students.find(s=>s.id===a?.studentId)||db.students.find(s=>s.id==="u1")}
function currentStudentId(){return currentStudent()?.id||"u1"}
function ensureQuestions(){if(!Array.isArray(db.questions))db.questions=[]}
function progress(c,studentId=currentStudentId()){
 const a=allSteps(c),done=a.filter(x=>x.statusByStudent?.[studentId]==="done"||(!x.statusByStudent&&x.status==="done")).length;
 return {done,total:a.length,pct:a.length?Math.round(done/a.length*100):0};
}
function stepStatus(s,studentId=currentStudentId()){
 return s.statusByStudent?.[studentId] || (studentId==="u1" ? (s.status || "idle") : "idle");
}
function setStepStatus(s,status,studentId=currentStudentId()){
 s.statusByStudent=s.statusByStudent||{};s.statusByStudent[studentId]=status;
 if(status==="done"||status==="failed"||status==="returned"||status==="review"||status==="progress") touchStudent(studentId);
}
function nextStep(c,studentId=currentStudentId()){
 const a=allSteps(c);return a.find(s=>stepStatus(s,studentId)!=="done"&&stepStatus(s,studentId)!=="review")||a.find(s=>stepStatus(s,studentId)==="review")||null;
}
// ======================
// UI HELPERS
// ======================

function iconFor(type){const p={
"Теория":'<path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H19v16H7.5A2.5 2.5 0 0 0 5 20.5z"/><path d="M5 4.5v16M9 6h7M9 10h7"/>',
"Контрольный вопрос":'<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.2a2.6 2.6 0 1 1 4.5 1.8c-1 .9-2 1.3-2 2.7M12 16.5h.01"/>',
"Scratch":'<path d="M7 6.5 12 4l5 2.5v5L12 14l-5-2.5z"/><path d="M12 14v6M7 11.5l5 2.5 5-2.5"/>',
"Minecraft Education":'<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
"Задача с тестами":'<path d="M8 4 4 8l4 4M16 4l4 4-4 4M13.5 3 10.5 13"/>',
"Проект":'<path d="M3.5 7.5h6l1.8 2H20.5v9h-17z"/><path d="M3.5 7.5V5.5h6l1.8 2"/>'}[type]||'<circle cx="12" cy="12" r="6"/>';return `<svg class="type-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`}
function statusHTML(status,extra=""){
 const [i,label,c]=STATUS[status]||STATUS.idle;
 return `<span class="status ${c}"><b>${i}</b><span>${label}${extra?`<small>${esc(extra)}</small>`:""}</span></span>`
}
function verificationLabel(s,status){
 if(status!=="done") return "";
 if(s?.checkedBy==="curator") return `Проверил куратор · ${esc(s.checkedAt||"только что")}`;
 if(s?.checkedBy==="tests") return `Проверено тестами · ${esc(s.checkedAt||"только что")}`;
 if(/ручная|куратор/i.test(s?.check||"")) return "Проверил куратор · ранее";
 if(/тест|автомат/i.test(s?.check||"")) return "Проверено тестами · ранее";
 return "Проверено по правилу шага · ранее";
}
function touchStudent(studentId=currentStudentId(),courseId=null,stepId=null){
 const u=db.students.find(x=>x.id===studentId); if(!u)return;
 u.lastActivityAt=Date.now();
 if(courseId)u.lastCourseId=courseId;
 if(stepId)u.lastStepId=stepId;
}
function activityDays(u){return u?.lastActivityAt?Math.max(0,Math.floor((Date.now()-u.lastActivityAt)/86400000)):null}
function sourceStatus(s,status){return verificationLabel(s,status)}
function signalHTML(v){const [i,label,c]=SIGNAL[v]||["•",v,"idle"];return `<span class="signal ${c}"><b>${i}</b>${esc(label)}</span>`}
function toast(msg){state.toast=msg;render();setTimeout(()=>{if(state.toast===msg){state.toast="";render()}},2200)}
function save(){saveDB(db)}
function draftKey(studentId,cid,sid){return `${studentId}::${cid}::${sid}`}
function getDraft(studentId,cid,sid){return (db.drafts||{})[draftKey(studentId,cid,sid)]||""}
function setDraft(studentId,cid,sid,value){db.drafts=db.drafts||{};db.drafts[draftKey(studentId,cid,sid)]=value;save()}
function migrateDemoData(){
 db.questions=Array.isArray(db.questions)?db.questions:[];
 // Normalize the multi-select answers from the supplied course content.
 const conditionStep=stepOf("scratch","1.3.2"); if(conditionStep) conditionStep.answer=[0,2,3];
 const agentStep=stepOf("minecraft","2.3.2"); if(agentStep) agentStep.answer=[0,2];
 db.attempts=Array.isArray(db.attempts)?db.attempts:[];
 db.drafts=(db.drafts&&typeof db.drafts==="object")?db.drafts:{};
 db.students=(db.students||[]).map(u=>{if(!u.lastActivityAt)u.lastActivityAt=u.id==="u2"?Date.now()-6*86400000:Date.now()-2*3600000;return u});
 db.courses.forEach(c=>allSteps(c).forEach(s=>{if(s.status==="done"&&!s.checkedBy){s.checkedBy=/ручная|куратор/i.test(s.check||"")?"curator":"tests";s.checkedAt="ранее"}}));
 db.questions.forEach(q=>{
  q.messages=Array.isArray(q.messages)?q.messages:[];
  if(!q.messages.length&&q.text){q.messages.push({author:"student",text:q.text,time:q.createdAt||"ранее"})}
  if(q.answer&&!q.messages.some(m=>m.author==="curator")){q.messages.push({author:"curator",text:q.answer,time:q.answeredAt||"ранее"})}
  q.text=q.messages[0]?.text||q.text||"";
 });
 const q1=db.questions.find(q=>q.id==="q1");
 if(q1&&!db.attempts.some(a=>a.studentId===q1.studentId&&a.course===q1.course&&a.stepId===q1.stepId)){
  db.attempts.push({id:"a-demo-q1",student:q1.student,studentId:q1.studentId,course:q1.course,stepId:q1.stepId,step:q1.step||"Разбор: кот по кругу",type:"Scratch",answer:"https://scratch.mit.edu/projects/demo-kot-po-krugu/",createdAt:"сегодня, 09:18",ts:Date.now()-3600000,resultLabel:"На проверке"});
 }
}

// ======================
// AUTHENTICATION
// ======================

function login(){
 app.innerHTML=`<div class="login"><div class="login-card"><div class="eyebrow light">ФСП Чувашии · Демо-стенд</div><h1>Образовательная<br>платформа</h1><p class="login-lead">Вход по логину и паролю. Для нового ученика доступна регистрация.</p>
 <div class="auth-tabs"><button class="${state.authMode==="login"?"active":""}" onclick="showAuth('login')">Вход</button><button class="${state.authMode==="register"?"active":""}" onclick="showAuth('register')">Регистрация</button></div>
 <form class="auth-form" onsubmit="event.preventDefault();${state.authMode==="login"?"doLogin()":"doRegister()"}">
 ${state.authMode==="register"?`<label>Имя<input id="auth-name" class="field" required placeholder="Например, Алексей"></label><label>Класс<input id="auth-grade" class="field" required placeholder="5 класс"></label>`:""}
 <label>Логин<input id="auth-login" class="field" required autocomplete="username" placeholder="masha"></label><label>Пароль<input id="auth-password" class="field" required type="password" autocomplete="current-password" placeholder="••••••••"></label>
 ${state.authMode==="register"?`<p class="auth-hint">Регистрация создаёт ученическую учётную запись. Назначения курсов выдаёт администратор.</p>`:`<button class="btn primary full auth-submit">Войти</button><div class="demo-credentials"><b>Демо-доступ</b><span>Ученик: <code>masha / 1234</code></span><span>Куратор: <code>curator / 1234</code></span><span>Админ: <code>admin / 1234</code></span></div>`}
 ${state.authMode==="register"?`<button class="btn primary full auth-submit">Создать аккаунт</button>`:""}</form><div class="login-note">Данные сохраняются локально в браузере этого демо.</div></div></div>`;
}
function showAuth(mode){state.authMode=mode;render()}
function doLogin(){const login=document.getElementById("auth-login")?.value.trim();const password=document.getElementById("auth-password")?.value;const a=(db.accounts||[]).find(x=>x.login===login&&x.password===password);if(!a){alert("Неверный логин или пароль");return}db.user={...(db.user||{}),accountId:a.id,role:a.role};if(a.studentId)touchStudent(a.studentId);save();state.role=a.role;state.view=a.role==="student"?"dashboard":a.role==="curator"?"queue":"admin";render()}
function doRegister(){const name=document.getElementById("auth-name")?.value.trim();const grade=document.getElementById("auth-grade")?.value.trim();const login=document.getElementById("auth-login")?.value.trim();const password=document.getElementById("auth-password")?.value;if(!name||!grade||!login||!password)return;if((db.accounts||[]).some(a=>a.login.toLowerCase()===login.toLowerCase())){alert("Такой логин уже занят");return}const sid="u"+Date.now();const aid="a"+Date.now();db.students.push({id:sid,name,grade,courses:[],signals:{},lastActivityAt:Date.now()});db.accounts.push({id:aid,login,password,role:"student",studentId:sid});db.user={accountId:aid,role:"student"};save();state.role="student";state.view="dashboard";render()}
function logout(){db.user={...(db.user||{}),accountId:null,role:null};save();state.role=null;login()}
function enter(role){const a=(db.accounts||[]).find(x=>x.role===role);if(a){db.user={accountId:a.id,role};save();state.role=role;state.view=role==="student"?"dashboard":role==="curator"?"queue":"admin";render()}}
function navItem(v,label,active,badge=""){return `<button class="nav-item ${active===v?"active":""}" onclick="go('${v}')"><span>${label}</span>${badge?`<em>${badge}</em>`:""}</button>`}
function go(view){state.view=view;state.courseId=null;state.stepId=null;state.reviewId=null;state.attemptId=null;render()}
function shell(content,active){
 const student=state.role==="student", sid=currentStudentId();
 const nav=student?`${navItem("dashboard","Главная",active)}${navItem("courses","Мои курсы",active)}${navItem("rating","Рейтинг",active)}${navItem("questions-student","Мои вопросы",active,(db.questions||[]).filter(q=>q.studentId===sid&&!q.answer).length||"")}`:state.role==="curator"?`${navItem("queue","Очередь проверки",active,(db.reviews||[]).length)}${navItem("students","Ученики",active)}${navItem("questions","Вопросы",active)}`:`${navItem("admin","Курсы",active)}${navItem("assignments","Назначения",active)}${navItem("types","Типы шагов",active)}`;
 const a=currentAccount();const who=student?(currentStudent()?.name||a?.login):state.role==="curator"?"Анна Сергеевна":"Администратор";const initials=(who||"А").split(/\s+/).map(x=>x[0]).join("").slice(0,2).toUpperCase();
 app.innerHTML=`<div class="shell ${student?"student":"staff"}"><header class="topbar"><div class="brand-lockup"><span class="brand-mark">О</span><span>Образовательная платформа</span></div><div class="top-actions"><span class="who">${esc(who)}</span><span class="avatar">${esc(initials)}</span><button class="btn" onclick="logout()">Выйти</button></div></header><div class="layout"><aside class="side"><div class="side-label">${student?"Кабинет ученика":state.role==="curator"?"Рабочее место куратора":"Администрирование"}</div><nav class="nav">${nav}</nav><div class="side-bottom"><span>Демо-стенд</span><span class="mono">v6.1</span></div></aside><main class="main">${content}</main></div></div>${state.toast?`<div class="toast">${esc(state.toast)}</div>`:""}`;
}
function pageHead(kicker,title,sub=""){return `<div class="page-head"><div class="eyebrow">${esc(kicker)}</div><h1>${esc(title)}</h1>${sub?`<p class="sub">${esc(sub)}</p>`:""}</div>`}
function visibleStudentCourses(){const sid=currentStudentId();return db.courses.filter(c=>c.published&&(db.assignments||[]).some(a=>a.student===sid&&a.course===c.id))}
function courseCard(c){const p=progress(c),n=nextStep(c);return `<article class="card course-card"><div class="card-top"><span class="tag">${esc(c.grades)}</span><span class="mono muted">${p.done}/${p.total}</span></div><h3>${esc(c.title)}</h3><p class="muted">${esc(c.tool)}</p><div class="progress-row"><div class="progress"><i style="width:${p.pct}%"></i></div><span class="mono">${p.pct}%</span></div><div class="course-meta"><span>${c.modules.length} модуля</span><span>${p.total} шагов</span></div><button class="btn ghost full" onclick="openCourse('${c.id}')">${n?"Продолжить":"Открыть курс"} →</button></article>`}
function studentDashboard(){const courses=visibleStudentCourses(),c=courses[0],p=c?progress(c):{done:0,total:0,pct:0},n=c?nextStep(c):null,idx=n?allSteps(c).indexOf(n)+1:0;const sid=currentStudentId();const pending=(db.reviews||[]).filter(r=>r.studentId===sid).length;return `${pageHead("Мои курсы",`Привет, ${currentStudent()?.name||"ученик"}!`,"Сегодня главное — один следующий шаг. Всё остальное ниже.")}<section class="next-card"><div class="next-copy"><div class="eyebrow light">${n?`Следующий шаг · ${idx} из ${p.total}`:"Нет доступного следующего шага"}</div><h2>${esc(n?.title||"Курсы появятся после назначения")}</h2><p>${esc(n?.type||"")} ${c?`· ${esc(c.title)}`:""}</p><div class="next-progress"><span style="width:${p.pct}%"></span></div><small>${p.done} из ${p.total} шагов уже зачтено</small></div>${n?`<button class="btn light-primary" onclick="openStep('${c.id}','${n.id}')">Перейти к шагу →</button>`:""}</section><div class="grid grid-3"><div class="metric-card"><span class="eyebrow">Прогресс курса</span><strong>${p.pct}%</strong><p>${p.done} из ${p.total} шагов</p></div><div class="metric-card"><span class="eyebrow">На проверке</span><strong>${pending}</strong><p>Ручные работы проверяет куратор. Они не блокируют автоматические шаги.</p></div><div class="metric-card"><span class="eyebrow">Курсов назначено</span><strong>${courses.length}</strong><p>Опубликованные назначения доступны в кабинете.</p></div></div><section class="section"><div class="section-head"><h2>Мои курсы</h2><button class="link-btn" onclick="go('courses')">Все курсы →</button></div><div class="grid grid-3">${courses.map(courseCard).join("")||`<div class="card empty">Пока нет опубликованных назначенных курсов.</div>`}</div></section>`}
function coursesPage(){return `${pageHead("Каталог","Мои курсы","Доступны только опубликованные курсы, назначенные текущему ученику.")}<div class="grid grid-3 section">${visibleStudentCourses().map(courseCard).join("")||`<div class="card empty">Нет доступных курсов.</div>`}</div>`}
function backToCourse(){
 state.stepId=null;
 state.reviewId=null;
 state.attemptId=null;
 state.view="course";
 render();
}

function openCourse(id){if(!visibleStudentCourses().some(c=>c.id===id)){toast("Курс недоступен для этого ученика");return}touchStudent(currentStudentId(),id);state.courseId=id;state.view="course";render()}
function coursePage(c){const p=progress(c),n=nextStep(c);return `<div class="back"><button class="btn" onclick="go('courses')">← Все курсы</button></div><div class="course-head"><div class="course-intro"><div class="eyebrow">${esc(c.grades)} · ${esc(c.tool)}</div><h1>${esc(c.title)}</h1><p class="sub">${esc(c.goal)}</p><div class="passport"><span><b>Объём</b>${esc(c.duration)}</span><span><b>Модулей</b>${c.modules.length}</span><span><b>Шагов</b>${p.total}</span></div></div><div class="card progress-card"><span class="eyebrow">Прогресс</span><strong>${p.done}/${p.total}</strong><div class="progress"><i style="width:${p.pct}%"></i></div><span class="mono">${p.pct}%</span>${n?`<button class="btn primary full" onclick="openStep('${c.id}','${n.id}')">Следующий шаг →</button>`:""}</div></div><div class="section">${c.modules.map(m=>`<section class="module"><div class="module-head"><div><span class="eyebrow">Модуль ${esc(m.id)}</span><h2>${esc(m.title)}</h2></div><span class="mono muted">${m.steps.length} шагов</span></div><div class="steps">${m.steps.map(s=>`<button class="step ${n?.id===s.id?"current":""}" onclick="openStep('${c.id}','${s.id}')"><span class="step-icon">${iconFor(s.type)}</span><span class="step-copy"><b>${esc(s.title)}</b><small>${esc(s.type)}</small></span>${statusHTML(stepStatus(s),verificationLabel(s,stepStatus(s)))}</button>`).join("")}</div></section>`).join("")}</div>`}
function openStep(cid,sid){if(!visibleStudentCourses().some(c=>c.id===cid)){toast("Курс недоступен");return}touchStudent(currentStudentId(),cid,sid);const st=stepOf(cid,sid);if(st&&st.type==="Теория"&&/прочт/i.test(st.check||"")&&stepStatus(st,currentStudentId())!=="done"){setStepStatus(st,"done",currentStudentId());st.checkedBy="tests";st.checkedAt="только что"}else if(st&&stepStatus(st,currentStudentId())==="idle")setStepStatus(st,"progress",currentStudentId());save();state.courseId=cid;state.stepId=sid;state.view="step";render()}
function getStep(){return stepOf(state.courseId,state.stepId)}
// ======================
// RENDERING
// ======================

function renderSourceText(text){return esc(text||"").split("\n\n").map(block=>block.includes("\n")?`<pre class="source">${esc(block)}</pre>`:`<p>${esc(block)}</p>`).join("")}
function answerSpec(s){
 const sub=String(s?.submission||"");
 const manual=/ручная|куратор/i.test(String(s?.check||""));
 if(s?.type==="Теория") return {kind:"theory",manual:false};
 if(s?.type==="Контрольный вопрос") return {kind:s?.options?"choice":"number",manual:false};
 if(s?.type==="Задача с тестами") return {kind:"python",manual:false};
 if(s?.type==="Minecraft Education") return {kind:"minecraft",manual:true};
 if(s?.type==="Scratch") return {kind:/числ/i.test(sub)?"number": "link",manual};
 if(s?.type==="Проект") return {kind:"project",manual:true};
 return {kind:manual?"manual":"unsupported",manual};
}
function stepPage(c,s){
 if(!c||!s)return `<div class="card empty">Шаг не найден.</div>`;
 const sid=currentStudentId(),status=stepStatus(s,sid),idx=allSteps(c).findIndex(x=>x.id===s.id)+1,spec=answerSpec(s);
 let input="";
 if(spec.kind==="choice"){
  input=`<div class="answer-block"><div class="answer-label">Твой ответ</div>${(s.options||[]).map((o,i)=>`<label class="option"><input type="${s.multi?"checkbox":"radio"}" name="ans" value="${i}"><span>${esc(o)}</span></label>`).join("")}</div>`;
 }else if(spec.kind==="number"){
  input=`<div class="answer-block"><div class="answer-label">Ответ числом</div><input id="numberAnswer" class="field" inputmode="numeric" placeholder="Например, 45"></div>`;
 }else if(spec.kind==="link"){
  input=`<div class="answer-block"><div class="answer-label">Ссылка на проект Scratch</div><input id="linkAnswer" class="field" type="url" placeholder="https://scratch.mit.edu/projects/..."><small class="muted">Сохрани проект в Scratch и вставь ссылку «Поделиться».</small></div>`;
 }else if(spec.kind==="minecraft"){
  input=`<div class="answer-block"><div class="answer-label">Что сдаёшь</div><label>Ссылка на проект MakeCode<input id="linkAnswer" class="field" type="url" placeholder="https://makecode..." required></label><label class="file-drop">＋ Прикрепить скриншот<input id="fileAnswer" type="file" accept="image/*" class="file-input" onchange="saveFileDraft()"><small id="fileAnswerName">Нужен скриншот выполненной работы.</small></label></div>`;
 }else if(spec.kind==="project"){
  input=`<div class="answer-block"><div class="answer-label">Ссылка на работу</div><input id="linkAnswer" class="field" type="url" placeholder="Вставь ссылку на проект / работу"><label class="file-drop">＋ Прикрепить файл (если нужен)<input id="fileAnswer" type="file" class="file-input" onchange="saveFileDraft()"><small id="fileAnswerName">Можно приложить файл к работе.</small></label></div>`;
 }else if(spec.kind==="python"){
  const draft=getDraft(sid,c.id,s.id),judge=s.lastJudge;
  input=`<div class="answer-block"><div class="notebook-head"><div><div class="answer-label">Блокнот решения · Python 3</div><span class="muted">Пиши код прямо здесь. Это простой блокнот, не полноценная IDE.</span></div><span class="mono muted">${esc(s.constraints||"Встроенные тесты")}</span></div><textarea id="codeAnswer" class="code-editor" spellcheck="false" placeholder="# напиши решение" oninput="saveCodeDraft()">${esc(draft)}</textarea><div class="notebook-actions"><button class="btn" type="button" onclick="saveCodeDraft(true)">Сохранить черновик</button><button class="btn primary" type="button" onclick="runPythonTests()">Запустить тесты</button></div>${judge?`<div class="judge-result ${judge.ok?"judge-ok":"judge-bad"}"><b>${judge.ok?"✓ Все тесты пройдены":"! Не все тесты пройдены"}</b><span>${esc(judge.message||`${judge.passed}/${judge.total} тестов`)}</span></div>`:""}</div>`;
 }else if(spec.kind==="theory"){
  input=``;
 }else{
  input=`<div class="warning-card card">Для этого нового типа шага пока не задан формат ответа. Настройте его в редакторе шага.</div>`;
 }
 let action="";
 if(status==="done") action=`<div class="success-box">✓ Работа зачтена <small>${verificationLabel(s,"done")}</small></div>`;
 else if(status==="review") action=`<div class="review-box">◷ Работа отправлена куратору <small>Можно продолжать обучение, пока работа проверяется.</small></div>`;
 else if(status==="returned") action=`<div class="return-box">↩ Работа возвращена <small>${esc(s.commentByStudent?.[sid]||s.comment||"Посмотри комментарий куратора и отправь исправленную версию.")}</small></div>`;
 else if(spec.kind==="theory") action=`<div class="success-box">✓ Шаг завершён <small>Засчитывается при прочтении</small></div>`;
 else if(spec.kind==="choice"||spec.kind==="number") action=`<button class="btn primary submit-btn" onclick="submitStep()">Проверить ответ →</button>`;
 else if(spec.kind==="python") action= status==="failed" ? `<div class="actions"><button class="btn primary" onclick="runPythonTests()">Запустить тесты ещё раз</button></div>` : `<div class="muted step-action-note">Сначала запусти тесты. При успешной проверке шаг засчитается автоматически.</div>`;
 else if(spec.manual) action=`<button class="btn primary submit-btn" onclick="submitStep()">Отправить на проверку →</button>`;
 return `<div class="back"><button class="btn" onclick="backToCourse()">← К курсу</button></div><div class="step-layout"><article class="step-main"><div class="step-top"><span class="tag">${iconFor(s.type)} ${esc(s.type)}</span>${statusHTML(status,verificationLabel(s,status))}</div><h1>${esc(s.title)}</h1><div class="step-content">${renderSourceText(s.text)}</div>${input}<div class="step-actions">${action}</div></article><aside class="step-aside"><div class="card"><div class="eyebrow">Шаг ${idx} из ${allSteps(c).length}</div><h3>${esc(c.title)}</h3><dl><div><dt>Проверка</dt><dd>${esc(s.check||"—")}</dd></div><div><dt>Что сдаётся</dt><dd>${esc(s.submission||"—")}</dd></div></dl></div>${s.criteria?.length?`<div class="card"><div class="eyebrow">Критерии</div><ol class="criteria">${s.criteria.filter(x=>!/^КУРС|^Модуль/.test(x)).map(x=>`<li>${esc(x)}</li>`).join("")}</ol></div>`:""}</aside></div>`;
}
function saveCodeDraft(showToast=false){const c=course(state.courseId),s=getStep(),sid=currentStudentId(),el=document.getElementById("codeAnswer");if(!c||!s||!el)return;setDraft(sid,c.id,s.id,el.value);if(showToast)toast("Черновик сохранён")}
function saveFileDraft(){const c=course(state.courseId),s=getStep(),sid=currentStudentId(),el=document.getElementById("fileAnswer"),name=document.getElementById("fileAnswerName");if(!c||!s||!sid||!el||!el.files?.[0])return;const f=el.files[0];db.fileDrafts=db.fileDrafts||{};db.fileDrafts[draftKey(sid,c.id,s.id)]={name:f.name,size:f.size,type:f.type};save();if(name)name.textContent=`Прикреплён: ${f.name}`;toast("Файл прикреплён к черновику")}
function manualAnswer(){const link=document.getElementById("linkAnswer")?.value.trim();const code=document.getElementById("codeAnswer")?.value.trim();const number=document.getElementById("numberAnswer")?.value.trim();const file=(db.fileDrafts||{})[draftKey(currentStudentId(),course(state.courseId)?.id,getStep()?.id)];if(link)return {answer:link,answerType:"link"};if(code)return {answer:code,answerType:"code"};if(number)return {answer:number,answerType:"text"};if(file)return {answer:file.name,answerType:"file",file};return null}
// ======================
// ANSWERS AND SUBMISSIONS
// ======================

function submitManualStep(c,s,sid){const spec=answerSpec(s),file=(db.fileDrafts||{})[draftKey(sid,c.id,s.id)],link=document.getElementById("linkAnswer")?.value.trim();if(spec.kind==="minecraft"&&(!link||!file)){toast("Для Minecraft нужны ссылка MakeCode и скриншот");return}const payload=manualAnswer();if(!payload){toast("Добавь материал работы перед отправкой");return}const now=Date.now(),aid="a"+now;db.attempts.unshift({id:aid,student:currentStudent()?.name,studentId:sid,course:c.id,stepId:s.id,step:s.title,type:s.type,answer:payload.answer,answerType:payload.answerType,file:payload.file||null,createdAt:"только что",ts:now,resultLabel:"На проверке"});setStepStatus(s,"review",sid);db.reviews.unshift({id:"r"+now,student:currentStudent()?.name,studentId:sid,course:c.id,stepId:s.id,step:s.title,type:s.type,age:"только что",status:"ЖДЁТ",comment:"",answer:payload.answer,answerType:payload.answerType,file:payload.file||null,attemptId:aid});save();toast("Работа отправлена куратору")}
function submitStep(){const c=course(state.courseId),s=getStep(),sid=currentStudentId();if(!s||!c)return;touchStudent(sid,c.id,s.id);const spec=answerSpec(s);if(spec.manual){submitManualStep(c,s,sid);return}if(spec.kind==="choice"){const vals=[...document.querySelectorAll('input[name="ans"]:checked')].map(x=>+x.value).sort((a,b)=>a-b);let expected=Array.isArray(s.answer)?s.answer.map(Number).sort((a,b)=>a-b):[Number(s.answer)];if(s.multi&&Array.isArray(s.answer)==false){const mask=Number(s.answer);expected=(s.options||[]).map((_,i)=>i).filter(i=>(mask&(1<<i))!==0)}if(JSON.stringify(vals)!==JSON.stringify(expected)){setStepStatus(s,"failed",sid);s.lastJudge={passed:0,total:1,ok:false,message:"Ответ не совпал с ключом"};save();toast("Не прошло тесты · проверь ответ и попробуй ещё раз");return}setStepStatus(s,"done",sid);s.checkedBy="tests";s.checkedAt="только что";s.lastJudge={passed:1,total:1,ok:true,message:"Ответ верный"};save();toast("Зачтено · ответ верный");return}if(spec.kind==="number"){const el=document.getElementById("numberAnswer"),expected=String(s.answerText??s.answer??"").trim();if(!el||el.value.trim()!==expected){setStepStatus(s,"failed",sid);s.lastJudge={passed:0,total:1,ok:false,message:"Числовой ответ неверен"};save();toast("Не прошло тесты · проверь число и попробуй ещё раз");return}setStepStatus(s,"done",sid);s.checkedBy="tests";s.checkedAt="только что";s.lastJudge={passed:1,total:1,ok:true,message:"Число верное"};save();toast("Зачтено · ответ верный");return}if(spec.kind==="python"){toast("Запусти тесты кнопкой «Запустить тесты»");return}if(spec.kind==="theory"){setStepStatus(s,"done",sid);s.checkedBy="tests";s.checkedAt="только что";save();toast("Шаг завершён");return}toast("Для этого типа шага не настроена проверка")}
function runPythonTests(){const c=course(state.courseId),s=getStep(),sid=currentStudentId(),code=document.getElementById("codeAnswer")?.value.trim();if(!c||!s||s.type!=="Задача с тестами")return;if(!code){toast("Напиши решение");return}setDraft(sid,c.id,s.id,code);const result=demoPythonJudge(s,code);s.lastJudge=result;db.attempts.unshift({id:"a"+Date.now(),student:currentStudent()?.name,studentId:sid,course:c.id,stepId:s.id,step:s.title,type:s.type,answer:code,answerType:"code",createdAt:"только что",ts:Date.now(),resultLabel:result.ok?`Зачтено · ${result.passed}/${result.total} тестов`:`Не прошло тесты · ${result.passed}/${result.total}`});if(result.ok){setStepStatus(s,"done",sid);s.checkedBy="tests";s.checkedAt="только что";save();toast(`Зачтено · ${result.passed}/${result.total} тестов`)}else{setStepStatus(s,"failed",sid);save();toast(`Не прошло тесты · ${result.passed}/${result.total}`)}render()}

function demoPythonJudge(s,code){if(!code)return{ok:false,message:"Напиши решение"};const n=s.id;const compact=code.replace(/\s+/g," ").toLowerCase();const tests={"3.1.3":()=>/input\(\).*split/.test(compact)&&/(a\s*\+\s*b|sum\s*=)/.test(compact),"3.1.4":()=>/int\(input\(\)\)/.test(compact)&&/\/\/\s*2/.test(compact),"3.2.3":()=>/input\(\).*split/.test(compact)&&/(if|elif)/.test(compact)&&/(print\()/.test(compact),"3.2.4":()=>/%\s*4/.test(compact)&&/%\s*100/.test(compact)&&/%\s*400/.test(compact)&&/yes/.test(compact)&&/no/.test(compact),"3.3.3":()=>/input\(\)/.test(compact)&&/(n\s*\*\s*\(n\s*\+\s*1\)\s*\/\/\s*2|for\s+.*range)/.test(compact),"3.3.4":()=>/input\(\)/.test(compact)&&/for\s+.*range/.test(compact)&&/%/.test(compact)};const pass=tests[n]?tests[n]():false;return{ok:pass,passed:pass?6:0,total:6,message:pass?"":"Демо-тесты не подтвердили решение. Проверь ввод, вывод и алгоритм."}}
function askCurator(cid,sid){
 if(state.role!=="student"||!visibleStudentCourses().some(c=>c.id===cid)){toast("Шаг недоступен");return}
 ensureQuestions();
 const q={id:"q"+Date.now(),studentId:currentStudentId(),student:currentStudent()?.name,course:cid,stepId:sid,text:"",createdAt:"только что",messages:[]};
 db.questions.unshift(q);save();openChat(q.id)
}
function openStepChat(cid,sid){
 if(state.role!=="student"||!visibleStudentCourses().some(c=>c.id===cid)){toast("Шаг недоступен");return}
 const q=(db.questions||[]).find(x=>x.course===cid&&x.stepId===sid&&x.studentId===currentStudentId());
 if(q)openChat(q.id);else askCurator(cid,sid)
}
function normalizeQuestion(q){
 q.messages=Array.isArray(q.messages)?q.messages:[];
 if(!q.messages.length&&q.text){q.messages=[{author:"student",text:q.text,time:q.createdAt||"ранее"}];}
 q.text=q.messages[0]?.text||q.text||"";
 return q
}
function openChat(id){
 const q=(db.questions||[]).find(x=>x.id===id);
 if(!q)return;
 if(state.role==="student"&&q.studentId!==currentStudentId()){toast("Этот вопрос недоступен");return}
 if(state.role!=="student"&&state.role!=="curator"){toast("Нет доступа");return}
 normalizeQuestion(q);
 const c=course(q.course),s=stepOf(q.course,q.stepId),a=latestAttempt(q.studentId,q.course,q.stepId);
 const messages=q.messages.map(m=>`<div class="chat-msg ${m.author}"><b>${m.author==='student'?'Ученик':'Куратор'}</b><p>${esc(m.text)}</p><small>${esc(m.time||"")}</small></div>`).join("");
 const composer=`<div class="chat-compose"><textarea id="chatMessage" class="field" rows="3" placeholder="Написать сообщение..."></textarea><button class="btn primary" onclick="sendChatMessage('${q.id}')">Отправить</button></div>`;
 const staffAttempt=state.role==="curator"?`<section class="chat-attempt"><div class="eyebrow">Последняя попытка ученика</div>${attemptHTML(a)}</section>`:"";
 openModal(`<div class="modal-backdrop" onclick="if(event.target===this)closeModal()"><div class="modal-card chat-modal"><div class="section-head"><div><div class="eyebrow">${esc(c?.title||q.course)}</div><h2>${esc(s?.id||q.stepId)} · ${esc(s?.title||"Шаг")}</h2></div><button class="btn" onclick="closeModal()">Закрыть</button></div><div class="chat-context"><b>Вопрос по шагу</b><p>${esc(s?.title||q.stepId)}</p></div>${staffAttempt}<div class="chat-history">${messages||`<div class="empty">Сообщений пока нет.</div>`}</div>${composer}</div></div>`);
}
function sendChatMessage(id){
 const q=(db.questions||[]).find(x=>x.id===id);
 if(!q)return;
 if(state.role==="student"&&q.studentId!==currentStudentId()){toast("Этот вопрос недоступен");return}
 const el=document.getElementById("chatMessage"),text=el?.value.trim();
 if(!text)return;
 normalizeQuestion(q);
 q.messages.push({author:state.role==='student'?"student":"curator",text,time:"только что"});
 q.text=q.messages[0]?.text||text;q.createdAt=q.createdAt||"только что";q.updatedAt="только что";
 save();closeModal();toast("Сообщение отправлено");render()
}
function studentQuestionsPage(){
 const sid=currentStudentId(),mine=(db.questions||[]).filter(q=>q.studentId===sid);
 return `${pageHead("Обратная связь","Мои вопросы","Вопросы привязаны к конкретному шагу; история диалога сохраняется.")}<div class="section grid grid-2">${mine.map(q=>{normalizeQuestion(q);const c=course(q.course),s=stepOf(q.course,q.stepId),last=q.messages[q.messages.length-1];return `<article class="card question-card"><div class="question-meta"><b>${esc(c?.title||q.course)}</b><span>${esc(s?.id||q.stepId)} · ${esc(s?.title||"Шаг")}</span></div><h3>${esc(q.text||"Новый вопрос")}</h3><p class="muted">${esc(q.createdAt||"")}</p><div class="answer-thread"><div class="eyebrow">${last?.author==="curator"?"Есть ответ куратора":"Ожидает ответа"}</div><p>${last?esc(last.text):"Напишите первый вопрос."}</p></div><button class="btn" onclick="openChat('${q.id}')">Открыть диалог</button></article>`}).join("")||`<div class="card empty">Вопросов пока нет.</div>`}</div>`
}
function ratingPage(){const sid=currentStudentId(),courses=visibleStudentCourses(),done=courses.reduce((n,c)=>n+progress(c,sid).done,0),reviews=(db.feedback||[]).filter(f=>f.studentId===sid&&/принята|зачтено/i.test(f.text||"")).length,points=done*8+reviews*10;const total=points+20;return `${pageHead("Рейтинг","Мой рейтинг","Баллы рассчитываются из фактически зачтённых шагов и принятых ручных работ.")}<div class="rating-layout section"><div class="card rating-total"><span class="eyebrow">Результат</span><strong>${total}</strong><span>баллов</span><div class="rank-line"><b>Место рассчитывается после загрузки общей группы</b><span>${done} автошагов · ${reviews} ручных работ</span></div></div><div class="card"><div class="eyebrow">Расшифровка</div><div class="breakdown"><div><b>${done*8}</b><span>автопроверка · 8 баллов за зачтённый шаг</span></div><div><b>${reviews*10}</b><span>ручная проверка · 10 баллов за принятую работу</span></div><div><b>20</b><span>стартовый бонус демонстрационного стенда</span></div></div><div class="notice">Рейтинг больше не содержит фиксированного места: итог зависит от текущего состояния данных.</div></div></div>`}
function curatorQueue(){const reviews=db.reviews||[];return `${pageHead("Рабочее место куратора","Очередь проверки","Ручные работы не теряются: видно ученика, шаг, содержимое сдачи и действие.")}<div class="queue-summary"><div><b>${reviews.length}</b><span>в очереди</span></div><div><b>${db.students.filter(u=>(u.courses||[]).some(cid=>{const c=course(cid);return c&&calcSignal(u,cid,progress(c,u.id))==="Замедлился"})).length}</b><span>замедлились</span></div><div><b>${db.students.filter(u=>(u.courses||[]).some(cid=>{const c=course(cid);return c&&calcSignal(u,cid,progress(c,u.id))==="Выпадает"})).length}</b><span>выпадают</span></div></div><div class="table-wrap section"><table class="table"><thead><tr><th>Ученик</th><th>Шаг</th><th>Тип</th><th>Сигнал</th><th>Действие</th></tr></thead><tbody>${reviews.map(r=>`<tr><td><b>${esc(r.student)}</b><small>${esc(r.age)}</small></td><td>${esc(r.step)}</td><td>${esc(r.type)}</td><td>${signalHTML(r.status)}</td><td><button class="btn small" onclick="openReview('${r.id}')">Проверить →</button></td></tr>`).join("")||`<tr><td colspan="5"><div class="empty">Очередь пуста.</div></td></tr>`}</tbody></table></div>`}
function openReview(id){
 const r=findReview(id);
 if(state.role!=="curator"){toast("Эта работа недоступна");return}
 if(!r){toast("Работа не найдена");return}
 state.reviewId=id;state.view="review";render()
}
function latestAttempt(studentId,cid,sid){
 const attempts=(db.attempts||[]).filter(a=>a.studentId===studentId&&a.course===cid&&a.stepId===sid);
 return attempts.sort((a,b)=>(b.ts||0)-(a.ts||0))[0]||null;
}
function attemptHTML(a){
 if(!a)return `<div class="attempt-empty">Последней попытки пока нет.</div>`;
 const result=a.resultLabel?`<span class="attempt-result">${esc(a.resultLabel)}</span>`:"";
 return `<div class="attempt-meta"><span>${esc(a.createdAt||"только что")}</span>${result}</div><button class="attempt-open" onclick="openAttempt('${esc(a.id)}')">Открыть решение на платформе →</button>`
}
function openAttempt(id){const a=(db.attempts||[]).find(x=>x.id===id);if(!a){toast("Попытка не найдена");return}state.attemptId=id;state.view="attempt";render()}
function attemptPage(a){if(!a)return `<div class="card empty">Попытка не найдена.</div>`;const isLink=a.answerType==="link"||(!a.answerType&&/^https?:\/\//i.test(a.answer||""));const isFile=a.answerType==="file";const body=isLink?`<div class="attempt-link-card"><div class="eyebrow">Внешняя работа</div><p>Ученик отправил ссылку, поэтому она открывается во внешнем сервисе.</p><a class="real-link" href="${esc(a.answer)}" target="_blank" rel="noopener">Открыть ссылку ↗<small>${esc(a.answer)}</small></a></div>`:isFile?`<div class="attempt-link-card"><div class="eyebrow">Прикреплённый файл</div><p>В статическом демо сохраняются имя и параметры файла.</p><div class="file-meta"><b>${esc(a.file?.name||a.answer||"Файл")}</b><span>${esc(a.file?.type||"")}${a.file?.size?` · ${Math.round(a.file.size/1024)} КБ`:""}</span></div></div>`:`<div class="attempt-code-card"><div class="eyebrow">Решение ученика</div><pre class="source attempt-code">${esc(a.answer||"")}</pre></div>`;return `<div class="back"><button class="btn" onclick="historyBackAttempt()">← Назад</button></div>${pageHead("Попытка ученика",a.step,`${a.student} · ${a.type} · ${a.createdAt||"только что"}`)}<section class="section"><article class="card attempt-page-card">${body}</article></section>`}
function historyBackAttempt(){state.view=state.role==="curator"?"questions":"dashboard";state.attemptId=null;render()}
function reviewPage(r){if(!r)return `<div class="card empty">Работа не найдена.</div>`;const s=stepOf(r.course,r.stepId);return `<div class="back"><button class="btn" onclick="go('queue')">← Очередь</button></div>${pageHead("Ручная проверка",r.step,`${r.student} · ${r.type} · работа ждёт ${r.age}`)}<div class="review-layout section"><article class="card"><div class="review-work-head"><span class="tag">${esc(r.type)}</span><span class="mono">ID ${esc(r.id)}</span></div><h2>Работа ученика</h2><div class="submission-preview">${(r.answerType==="link"||(!r.answerType&&/^https?:\/\//i.test(r.answer||"")))?`<a class="real-link" href="${esc(r.answer)}" target="_blank" rel="noopener">Открыть внешнюю работу ↗<small>${esc(r.answer)}</small></a>`:r.answerType==="file"?`<div class="file-meta"><b>${esc(r.file?.name||r.answer||"Файл")}</b><span>${esc(r.file?.type||"")}${r.file?.size?` · ${Math.round(r.file.size/1024)} КБ`:""}</span></div>`:r.answer?`<pre class="source">${esc(r.answer)}</pre>`:`<div class="empty">У старой демонстрационной записи нет содержимого.</div>`}</div><h3>Критерии шага</h3><ol class="criteria">${(s?.criteria?.length?s.criteria:["Результат соответствует условию шага.","Обязательные элементы работы присутствуют."]).map(x=>`<li>${esc(x)}</li>`).join("")}</ol></article><aside class="card"><div class="eyebrow">Решение куратора</div><textarea id="reviewComment" class="field" rows="7" placeholder="Комментарий ученику"></textarea><div class="actions vertical"><button class="btn primary full" onclick="acceptReview('${r.id}')">✓ Принять работу</button><button class="btn full" onclick="returnReview('${r.id}')">↩ Вернуть с комментарием</button></div></aside></div>`}
function findReview(id){return (db.reviews||[]).find(r=>r.id===id)}
function acceptReview(id){const r=findReview(id);if(!r)return;const s=stepOf(r.course,r.stepId);if(s){s.checkedBy="curator";s.checkedAt="только что";setStepStatus(s,"done",r.studentId)}const a=(db.attempts||[]).find(x=>x.id===r.attemptId);if(a)a.resultLabel="Зачтено · проверил куратор";db.reviews=db.reviews.filter(x=>x.id!==id);db.feedback=db.feedback||[];db.feedback.push({student:r.student,studentId:r.studentId,course:r.course,stepId:r.stepId,text:"Работа принята куратором.",createdAt:"только что"});save();state.view="queue";state.reviewId=null;toast("Работа принята · прогресс обновлён")}
function returnReview(id){const r=findReview(id);if(!r)return;const comment=document.getElementById("reviewComment")?.value.trim()||"Добавьте комментарий к исправлению и отправьте работу повторно.";const s=stepOf(r.course,r.stepId);if(s){setStepStatus(s,"returned",r.studentId);s.commentByStudent=s.commentByStudent||{};s.commentByStudent[r.studentId]=comment}r.status="ЖДЁТ";r.comment=comment;r.age="только что";r.answer=r.answer||"";const a=(db.attempts||[]).find(x=>x.id===r.attemptId);if(a)a.resultLabel="Возвращено · комментарий куратора";save();state.view="queue";state.reviewId=null;toast("Работа возвращена с комментарием")}
function signalReason(u,cid,p){const days=activityDays(u),s=stepOf(cid,u.lastStepId),recent=latestAttempt(u.id,cid,u.lastStepId);if(days!==null&&days>=6)return `Не заходил ${days} дней · последний шаг «${s?.title||"не определён"}».`;if(days!==null&&days>=3)return `Не заходил ${days} дня · последний шаг «${s?.title||"не определён"}».`;if(recent)return `Последняя попытка: ${recent.createdAt||"недавно"} · выполнено ${p.done} из ${p.total} шагов.`;return `Прогресс ${p.pct}% · последняя активность ${days===0?"сегодня":days===1?"вчера":`${days} дн. назад`}.`}
function calcSignal(u,cid,p){const days=activityDays(u);if(days!==null&&days>=6)return"Выпадает";if(days!==null&&days>=3)return"Замедлился";const expected=Math.max(1,Math.round(p.total*0.35));if(p.done<expected)return"Замедлился";return"В графике"}
function studentsPage(){
 const account=(db.curators||[])[0]||null;
 const curatorId=account?.id||"c1";
 const assignments=(db.assignments||[]).filter(a=>a.curator===curatorId);
 const rows=assignments.map(a=>{
  const u=db.students.find(x=>x.id===a.student),c=course(a.course);
  if(!u||!c)return "";
  const p=progress(c,u.id),signal=calcSignal(u,c.id,p),reason=signalReason(u,c.id,p),last=stepOf(c.id,u.lastStepId);
  const days=activityDays(u);
  const activity=days===null?"нет данных":days===0?"сегодня":days===1?"вчера":`${days} дн. назад`;
  return `<tr><td><b>${esc(u.name)}</b><small>${esc(u.grade||"")}</small></td><td><b>${esc(c.title)}</b><small>${p.done} из ${p.total} шагов · ${p.pct}%</small><div class="mini-progress"><span style="width:${p.pct}%"></span></div></td><td>${signalHTML(signal)}<small class="signal-reason">${esc(reason)}</small></td><td><span class="muted">${activity}</span><small>Последний шаг: ${esc(last?.title||u.lastStepId||"не начат")}</small></td></tr>`;
 }).join("");
 return `${pageHead("Ученики","Закреплённые ученики","Здесь видно, кто и где остановился, прогресс и сигнал отставания.")}<div class="table-wrap section"><table class="table"><thead><tr><th>Ученик</th><th>Курс и прогресс</th><th>Сигнал</th><th>Активность / последний шаг</th></tr></thead><tbody>${rows||`<tr><td colspan="4"><div class="empty">За вами пока не закреплены ученики.</div></td></tr>`}</tbody></table></div>`;
}
function questionsPage(){ensureQuestions();return `${pageHead("Обратная связь","Вопросы учеников","Куратор видит вопрос по шагу, историю диалога и последнюю попытку ученика.")}<div class="grid grid-2 section">${db.questions.map(q=>{normalizeQuestion(q);const s=stepOf(q.course,q.stepId),a=latestAttempt(q.studentId,q.course,q.stepId),last=q.messages[q.messages.length-1];return `<article class="card question-card"><div class="question-meta"><b>${esc(q.student)}</b><span>${esc(s?.id||q.stepId)} · ${esc(s?.title||"Шаг")}</span></div><h3>${esc(q.text||"Новый вопрос")}</h3><p class="muted">${esc(q.createdAt||"")} · ${last?.author==="curator"?"Ответ дан":"Ожидает ответа"}</p><div class="answer-thread">${q.messages.map(m=>`<div class="chat-msg ${m.author}"><b>${m.author==='student'?'Ученик':'Куратор'}</b><p>${esc(m.text)}</p><small>${esc(m.time||"")}</small></div>`).join("")||`<div class="empty">Сообщений пока нет.</div>`}</div><div class="chat-attempt"><div class="eyebrow">Последняя попытка ученика</div>${attemptHTML(a)}</div><button class="btn primary" onclick="openChat('${q.id}')">Открыть диалог</button></article>`}).join("")||`<div class="card empty">Новых вопросов нет.</div>`}</div>`}
function answerQuestion(id){openChat(id)}

function adminPage(){return `${pageHead("Конструктор","Курсы","Полный цикл: создать, редактировать паспорт, модули и шаги, назначить, опубликовать или удалить.")}<div class="admin-toolbar"><button class="btn primary" onclick="newCourse()">＋ Создать курс</button><span class="muted">Опубликовано: ${db.courses.filter(c=>c.published).length} · Всего: ${db.courses.length}</span></div><div class="grid grid-3 section">${db.courses.map(c=>`<article class="card admin-course"><div class="card-top"><span class="tag">${esc(c.grades)}</span><span class="${c.published?"pub":"draft"}">${c.published?"Опубликован":"Черновик"}</span></div><h3>${esc(c.title)}</h3><p class="muted">${c.modules.length} модуля · ${allSteps(c).length} шагов</p><div class="course-tree">${c.modules.map(m=>`<div><b>${esc(m.id)} ${esc(m.title)}</b><span>${m.steps.length}</span></div>`).join("")||`<div>Пустой курс</div>`}</div><div class="actions"><button class="btn" onclick="editCourse('${c.id}')">Редактировать</button><button class="btn ${c.published?"":"primary"}" onclick="togglePublish('${c.id}')">${c.published?"Снять публикацию":"Опубликовать"}</button><button class="btn danger" onclick="deleteCourse('${c.id}')">Удалить навсегда</button></div></article>`).join("")}</div>`}
function newCourse(){const id="course-"+Date.now();db.courses.push({id,title:"Новый курс",grades:"1–9 класс",duration:"по плану",tool:"Новый инструмент",goal:"Описание цели курса",published:false,modules:[]});save();editCourse(id)}
function editCourse(id){state.courseId=id;state.view="edit-course";render()}
function editCoursePage(c){return `<div class="back"><button class="btn" onclick="go('admin')">← Курсы</button></div>${pageHead("Редактор курса",c.title,"Здесь можно реально менять паспорт, модули и шаги.")}<div class="editor-grid section"><div class="card"><div class="eyebrow">Паспорт курса</div><label>Название<input class="field" id="ec-title" value="${esc(c.title)}"></label><label>Классы<input class="field" id="ec-grades" value="${esc(c.grades)}"></label><label>Инструмент<input class="field" id="ec-tool" value="${esc(c.tool)}"></label><label>Объём<input class="field" id="ec-duration" value="${esc(c.duration)}"></label><label>Цель<textarea class="field" id="ec-goal" rows="5">${esc(c.goal)}</textarea></label><button class="btn primary" onclick="saveCourseEdit('${c.id}')">Сохранить изменения</button></div><div class="card"><div class="section-head"><div><div class="eyebrow">Состав курса</div><h2>Модули и шаги</h2></div><button class="btn" onclick="addModule('${c.id}')">＋ Модуль</button></div>${c.modules.map(m=>`<div class="admin-module"><div class="admin-module-head"><div><b>${esc(m.id)} ${esc(m.title)}</b><small>${m.steps.length} шагов</small></div><div class="actions"><button class="btn small" onclick="editModule('${c.id}','${m.id}')">Изменить</button><button class="btn small danger" onclick="deleteModule('${c.id}','${m.id}')">Удалить</button></div></div>${m.steps.map(s=>`<div class="admin-step"><span class="step-icon">${iconFor(s.type)}</span><div><b>${esc(s.id)} · ${esc(s.title)}</b><small>${esc(s.type)} · ${esc(s.check)}</small></div><button class="btn small" onclick="editStepAdmin('${c.id}','${m.id}','${s.id}')">Изменить</button></div>`).join("")}<button class="btn small" onclick="addStep('${c.id}','${m.id}')">＋ Шаг</button></div>`).join("")||`<div class="empty">Добавьте первый модуль.</div>`}</div></div>`}
function saveCourseEdit(id){const c=course(id);if(!c)return;c.title=document.getElementById("ec-title").value.trim();c.grades=document.getElementById("ec-grades").value.trim();c.tool=document.getElementById("ec-tool").value.trim();c.duration=document.getElementById("ec-duration").value.trim();c.goal=document.getElementById("ec-goal").value.trim();save();toast("Изменения курса сохранены")}
function addModule(cid){const title=prompt("Название модуля:");if(!title?.trim())return;const c=course(cid),num=c.modules.length+1;const id=cid==="scratch"?`1.${num}`:cid==="minecraft"?`2.${num}`:cid==="python"?`3.${num}`:`${num}`;c.modules.push({id,title:title.trim(),steps:[]});save();render()}
function editModule(cid,mid){const m=course(cid).modules.find(x=>x.id===mid);if(!m)return;const title=prompt("Название модуля:",m.title);if(!title?.trim())return;m.title=title.trim();save();render()}
function deleteModule(cid,mid){if(!confirm("Удалить модуль вместе со всеми его шагами?"))return;const c=course(cid);c.modules=c.modules.filter(m=>m.id!==mid);save();render()}
function stepTemplate(type,id,title){const base={id,title,type,check:type==="Теория"?"Засчитывается при прочтении":type==="Проект"||type==="Minecraft Education"||type==="Scratch"?"Ручная":type==="Задача с тестами"?"Автоматическая (тесты)":"Автоматическая",submission:type==="Теория"?"—":type==="Задача с тестами"?"Код на Python":"Ответ",text:"Текст шага",status:"idle",criteria:[],solution:""};if(type==="Контрольный вопрос")Object.assign(base,{options:["Вариант 1","Вариант 2"],answer:0,multi:false});if(type==="Scratch")Object.assign(base,{submission:"Ссылка на проект"});return base}
function addStep(cid,mid){const c=course(cid),m=c.modules.find(x=>x.id===mid);if(!m)return;const type=prompt("Тип шага:\n"+allTypes().map((t,i)=>`${i+1}. ${t.name}`).join("\n"),"1");const idx=Number(type)-1;const t=allTypes()[idx];if(!t)return;const id=`${mid}.${m.steps.length+1}`;m.steps.push(stepTemplate(t.name,id,"Новый шаг"));save();editStepAdmin(cid,mid,id)}
function allTypes(){const custom=(db.stepTypes||[]).map(x=>({name:x.name,icon:x.icon||"•",hint:x.hint||"Конфигурация"}));return [...DEFAULT_TYPES.map(x=>({name:x[0],icon:x[1],hint:x[2]})),...custom.filter(x=>!DEFAULT_TYPES.some(d=>d[0]===x.name))]}
function editStepAdmin(cid,mid,sid){state.courseId=cid;state.stepId=sid;state.view="edit-step";state.moduleId=mid;render()}
function editStepPage(c,m,s){return `<div class="back"><button class="btn" onclick="editCourse('${c.id}')">← Редактор курса</button></div>${pageHead("Редактор шага",`${s.id} · ${s.title}`,"Поля сохраняются прямо в модели курса.")}<div class="card section"><label>Название<input id="es-title" class="field" value="${esc(s.title)}"></label><label>Тип<select id="es-type" class="field">${allTypes().map(t=>`<option ${t.name===s.type?"selected":""}>${esc(t.name)}</option>`).join("")}</select></label><label>Проверка<input id="es-check" class="field" value="${esc(s.check)}"></label><label>Сдача<input id="es-submission" class="field" value="${esc(s.submission)}"></label><label>Текст шага<textarea id="es-text" class="field" rows="12">${esc(s.text)}</textarea></label><label>Критерии ручной проверки<textarea id="es-criteria" class="field" rows="5" placeholder="Один критерий на строку">${esc((s.criteria||[]).join("\n"))}</textarea></label><label>Эталон решения<textarea id="es-solution" class="field" rows="8">${esc(s.solution||"")}</textarea></label><div class="actions"><button class="btn primary" onclick="saveStepAdmin('${c.id}','${m.id}','${s.id}')">Сохранить</button><button class="btn danger" onclick="deleteStepAdmin('${c.id}','${m.id}','${s.id}')">Удалить шаг</button></div></div>`}
function saveStepAdmin(cid,mid,sid){const s=stepOf(cid,sid);if(!s)return;s.title=document.getElementById("es-title").value.trim();s.type=document.getElementById("es-type").value;s.check=document.getElementById("es-check").value.trim();s.submission=document.getElementById("es-submission").value.trim();s.text=document.getElementById("es-text").value;s.criteria=document.getElementById("es-criteria").value.split(/\n+/).map(x=>x.trim()).filter(Boolean);s.solution=document.getElementById("es-solution").value;save();toast("Шаг сохранён");editCourse(cid)}
function deleteStepAdmin(cid,mid,sid){if(!confirm("Удалить шаг?"))return;const m=course(cid).modules.find(x=>x.id===mid);m.steps=m.steps.filter(s=>s.id!==sid);save();editCourse(cid)}
function deleteCourse(id){const c=course(id);if(!c)return;if(!confirm(`Удалить курс «${c.title}» полностью? Будут удалены назначения, вопросы и работы.`))return;db.courses=db.courses.filter(x=>x.id!==id);db.assignments=(db.assignments||[]).filter(a=>a.course!==id);db.students.forEach(u=>u.courses=(u.courses||[]).filter(cid=>cid!==id));db.reviews=(db.reviews||[]).filter(r=>r.course!==id);db.feedback=(db.feedback||[]).filter(f=>f.course!==id);db.questions=(db.questions||[]).filter(q=>q.course!==id);db.attempts=(db.attempts||[]).filter(a=>a.course!==id);db.drafts=Object.fromEntries(Object.entries(db.drafts||{}).filter(([k])=>!k.includes(`::${id}::`)));db.fileDrafts=Object.fromEntries(Object.entries(db.fileDrafts||{}).filter(([k])=>!k.includes(`::${id}::`)));save();state.view="admin";state.courseId=null;toast("Курс удалён полностью")}
function togglePublish(id){const c=course(id);if(!c)return;if(!c.published&&(!c.modules.length||!allSteps(c).length)){toast("Добавьте хотя бы один модуль и шаг перед публикацией");return}c.published=!c.published;save();toast(c.published?"Курс опубликован":"Публикация снята")}
function assignmentsPage(){return `${pageHead("Назначения","Кураторы и ученики","Назначение теперь можно создать, изменить и удалить.")}<div class="card section"><div class="table-wrap"><table class="table"><thead><tr><th>Ученик</th><th>Курс</th><th>Куратор</th><th></th></tr></thead><tbody>${(db.assignments||[]).map((a,i)=>{const u=db.students.find(x=>x.id===a.student),c=course(a.course),cur=db.curators.find(x=>x.id===a.curator);return `<tr><td>${esc(u?.name)}</td><td>${esc(c?.title)}</td><td>${esc(cur?.name)}</td><td><button class="btn small" onclick="editAssignment(${i})">Изменить</button><button class="btn small danger" onclick="deleteAssignment(${i})">Удалить</button></td></tr>`}).join("")||`<tr><td colspan="4"><div class="empty">Назначений нет.</div></td></tr>`}</tbody></table></div><div class="actions"><button class="btn primary" onclick="newAssignment()">＋ Новое назначение</button></div></div>`}
function assignmentForm(index=null){const a=index===null?null:db.assignments[index];const title=a?"Изменить назначение":"Новое назначение";const opts=(arr,val,lab)=>arr.map(x=>`<option value="${esc(x.id)}" ${x.id===val?"selected":""}>${esc(x[lab])}</option>`).join("");const students=db.students.map(x=>({id:x.id,name:x.name}));const courses=db.courses;const curs=db.curators;return `<div class="modal-backdrop" onclick="if(event.target===this)closeModal()"><div class="modal-card"><div class="section-head"><h2>${title}</h2><button class="btn" onclick="closeModal()">Закрыть</button></div><label>Ученик<select id="as-student" class="field">${opts(students,a?.student,"name")}</select></label><label>Курс<select id="as-course" class="field">${opts(courses,a?.course,"title")}</select></label><label>Куратор<select id="as-curator" class="field">${opts(curs,a?.curator,"name")}</select></label><div class="actions"><button class="btn primary" onclick="saveAssignment(${index===null?"null":index})">Сохранить</button></div></div></div>`}
function openModal(html){const el=document.createElement("div");el.id="modal-root";el.innerHTML=html;document.body.appendChild(el)}
function closeModal(){document.getElementById("modal-root")?.remove()}
function newAssignment(){openModal(assignmentForm())}
function editAssignment(i){openModal(assignmentForm(i))}
function saveAssignment(i){const student=document.getElementById("as-student").value,courseId=document.getElementById("as-course").value,curator=document.getElementById("as-curator").value;if(db.assignments.some((a,idx)=>idx!==i&&a.student===student&&a.course===courseId)){toast("Такое назначение уже существует");return}const a={student,course:courseId,curator};if(i===null)db.assignments.push(a);else db.assignments[i]=a;const u=db.students.find(x=>x.id===student);u.courses=Array.from(new Set([...(u.courses||[]),courseId]));save();closeModal();toast("Назначение сохранено");render()}
function deleteAssignment(i){if(!confirm("Удалить назначение?"))return;const a=db.assignments[i];db.assignments.splice(i,1);const u=db.students.find(x=>x.id===a.student);u.courses=(u.courses||[]).filter(cid=>db.assignments.some(x=>x.student===u.id&&x.course===cid));save();render()}
function typesPage(){return `${pageHead("Архитектура","Типы шагов","Базовые типы и новые пользовательские типы хранятся в конфигурации.")}<div class="type-grid section">${allTypes().map(t=>`<div class="type-card"><span class="step-icon">${esc(t.icon)}</span><div><b>${esc(t.name)}</b><small>${esc(t.hint)}</small></div></div>`).join("")}<button class="type-card dashed type-add" onclick="newStepType()"><span class="step-icon">＋</span><div><b>Новый тип</b><small>Добавить конфигурацию</small></div></button></div>`}
function newStepType(){const name=prompt("Название нового типа шага:");if(!name?.trim())return;if(allTypes().some(t=>t.name.toLowerCase()===name.trim().toLowerCase())){toast("Такой тип уже существует");return}const icon=prompt("Короткая иконка/буква:","N")||"N";const hint=prompt("Короткое описание:","Пользовательский тип")||"Пользовательский тип";db.stepTypes=db.stepTypes||[];db.stepTypes.push({id:"type-"+Date.now(),name:name.trim(),icon,hint});save();render()}

function render(){if(!state.role){login();return}if(state.view==="step")return shell(stepPage(course(state.courseId),getStep()),"courses");if(state.view==="review"){if(state.role!=="curator"){state.view=state.role==="student"?"dashboard":"admin";return render()}return shell(reviewPage(findReview(state.reviewId)),"queue");}if(state.view==="attempt"){return shell(attemptPage((db.attempts||[]).find(a=>a.id===state.attemptId)),state.role==="curator"?"questions":"dashboard");}if(state.role==="student"){if(state.view==="course")return shell(coursePage(course(state.courseId)),"courses");if(state.view==="courses")return shell(coursesPage(),"courses");if(state.view==="questions-student")return shell(studentQuestionsPage(),"questions-student");if(state.view==="rating")return shell(ratingPage(),"rating");return shell(studentDashboard(),"dashboard")}if(state.role==="curator"){if(state.view==="students")return shell(studentsPage(),"students");if(state.view==="questions")return shell(questionsPage(),"questions");return shell(curatorQueue(),"queue")}if(state.view==="edit-course")return shell(editCoursePage(course(state.courseId)),"admin");if(state.view==="edit-step"){const c=course(state.courseId),m=c?.modules.find(x=>x.id===state.moduleId),s=m?.steps.find(x=>x.id===state.stepId);return shell(editStepPage(c,m,s),"admin")}if(state.view==="assignments")return shell(assignmentsPage(),"assignments");if(state.view==="types")return shell(typesPage(),"types");return shell(adminPage(),"admin")}

if(db.user?.accountId){state.role=db.user.role||currentAccount()?.role||null}
render();
