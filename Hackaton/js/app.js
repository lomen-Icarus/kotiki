
let db=loadDB();
const app=document.getElementById("app");
let state={role:db.user.role||null,view:"dashboard",courseId:null,stepId:null,reviewId:null,toast:""};

const TYPE_ICONS={"Теория":"T","Контрольный вопрос":"?","Scratch":"S","Minecraft Education":"M","Задача с тестами":"⌘","Проект":"P"};
const STATUS={
 done:["✓","Зачтено","done"],
 review:["◷","На проверке","review"],
 returned:["↩","Возвращено","returned"],
 failed:["!","Не пройдено","failed"],
 idle:["○","Не начато","idle"]
};
const SIGNAL={"Выпадает":["↘","Выпадает","danger"],"Замедлился":["◌","Замедлился","warn"],"В графике":["✓","В графике","ok"],"ЖДЁТ":["◷","ЖДЁТ","warn"]};

function esc(v=""){return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}
function course(id){return db.courses.find(x=>x.id===id)}
function allSteps(c){return c?.modules.flatMap(m=>m.steps)||[]}
function progress(c){const a=allSteps(c),done=a.filter(x=>x.status==="done").length;return {done,total:a.length,pct:a.length?Math.round(done/a.length*100):0}}
function nextStep(c){return allSteps(c).find(s=>s.status!=="done"&&s.status!=="review")||allSteps(c).find(s=>s.status==="review")||null}
function stepOf(cid,sid){return allSteps(course(cid)).find(s=>s.id===sid)}
function iconFor(type){return TYPE_ICONS[type]||"•"}
function statusHTML(status,extra=""){
 const [i,label,c]=STATUS[status]||STATUS.idle;
 return `<span class="status ${c}"><b>${i}</b>${label}${extra?`<small>${esc(extra)}</small>`:""}</span>`;
}
function signalHTML(v){const [i,label,c]=SIGNAL[v]||["•",v,"idle"];return `<span class="signal ${c}"><b>${i}</b>${esc(label)}</span>`}
function toast(msg){state.toast=msg;render();setTimeout(()=>{state.toast="";render()},2200)}
function login(){
 app.innerHTML=`<div class="login">
  <div class="login-glow"></div>
  <div class="login-card">
    <div class="eyebrow light">ФСП Чувашии · Демо-стенд</div>
    <h1>Образовательная<br>платформа</h1>
    <p class="login-lead">Дистанционная подготовка школьников 1–9 классов по спортивному программированию.</p>
    <div class="role-grid">
      <button class="role-btn" onclick="enter('student')"><span class="role-kicker">01</span><strong>Ученик</strong><small>Курсы · следующий шаг · прогресс</small></button>
      <button class="role-btn" onclick="enter('curator')"><span class="role-kicker">02</span><strong>Куратор</strong><small>Ученики · очередь · обратная связь</small></button>
      <button class="role-btn" onclick="enter('admin')"><span class="role-kicker">03</span><strong>Администратор</strong><small>Курсы · сборка · публикация</small></button>
    </div>
    <div class="login-note">Все демонстрационные данные синтетические.</div>
  </div>
</div>`;
}
function enter(role){state.role=role;db.user.role=role;saveDB(db);state.view=role==="student"?"dashboard":role==="curator"?"queue":"admin";render()}
function logout(){state.role=null;db.user.role=null;saveDB(db);login()}
function navItem(v,label,active,badge=""){return `<button class="nav-item ${active===v?"active":""}" onclick="go('${v}')"><span>${label}</span>${badge?`<em>${badge}</em>`:""}</button>`}
function go(view){state.view=view;state.courseId=null;state.stepId=null;state.reviewId=null;render()}
function shell(content,active){
 const student=state.role==="student";
 const nav=student
 ? `${navItem("dashboard","Главная",active)}${navItem("courses","Мои курсы",active)}${navItem("history","История",active)}${navItem("rating","Рейтинг",active)}`
 : state.role==="curator"
 ? `${navItem("queue","Очередь проверки",active,db.reviews.length)}${navItem("students","Ученики",active)}${navItem("questions","Вопросы",active)}`
 : `${navItem("admin","Курсы",active)}${navItem("assignments","Назначения",active)}${navItem("types","Типы шагов",active)}`;
 const who=student?"Маша К. · 4 класс":state.role==="curator"?"Анна Сергеевна":"Администратор";
 const initials=student?"МК":state.role==="curator"?"АС":"А";
 app.innerHTML=`<div class="shell ${student?"student":"staff"}">
  <header class="topbar">
   <div class="brand-lockup"><span class="brand-mark">О</span><span>Образовательная платформа</span></div>
   <div class="top-actions"><span class="who">${who}</span><span class="avatar">${initials}</span><button class="btn" onclick="logout()">Выйти</button></div>
  </header>
  <div class="layout">
   <aside class="side"><div class="side-label">${student?"Кабинет ученика":state.role==="curator"?"Рабочее место куратора":"Администрирование"}</div><nav class="nav">${nav}</nav><div class="side-bottom"><span>Демо-стенд</span><span class="mono">v4.0</span></div></aside>
   <main class="main">${content}</main>
  </div>
 </div>${state.toast?`<div class="toast">${esc(state.toast)}</div>`:""}`;
}

function pageHead(kicker,title,sub=""){return `<div class="page-head"><div class="eyebrow">${kicker}</div><h1>${title}</h1>${sub?`<p class="sub">${sub}</p>`:""}</div>`}
function courseCard(c){
 const p=progress(c),n=nextStep(c);
 return `<article class="card course-card">
   <div class="card-top"><span class="tag">${esc(c.grades)}</span><span class="mono muted">${p.done}/${p.total}</span></div>
   <h3>${esc(c.title)}</h3><p class="muted">${esc(c.tool)}</p>
   <div class="progress-row"><div class="progress"><i style="width:${p.pct}%"></i></div><span class="mono">${p.pct}%</span></div>
   <div class="course-meta"><span>${c.modules.length} модуля</span><span>${p.total} шагов</span></div>
   <button class="btn ghost full" onclick="openCourse('${c.id}')">${n?"Продолжить":"Открыть курс"} →</button>
 </article>`;
}
function studentDashboard(){
 const c=course("scratch"),p=progress(c),n=nextStep(c),idx=n?allSteps(c).indexOf(n)+1:p.total;
 return `${pageHead("Мои курсы","Привет, Маша!","Сегодня главное — один следующий шаг. Всё остальное ниже.")}

 <section class="next-card">
  <div class="next-copy"><div class="eyebrow light">Следующий шаг · ${idx} из ${p.total}</div><h2>${esc(n?.title||"Курс завершён")}</h2>
   <p>${esc(n?.type||"")} · ${esc(c.title)}</p>
   <div class="next-progress"><span style="width:${p.pct}%"></span></div><small>${p.done} из ${p.total} шагов уже зачтено</small>
  </div>
  ${n?`<button class="btn light-primary" onclick="openStep('${c.id}','${n.id}')">Перейти к шагу →</button>`:""}
 </section>

 <div class="grid grid-3">
  <div class="metric-card"><span class="eyebrow">Прогресс курса</span><strong>${p.pct}%</strong><p>${p.done} из ${p.total} шагов · текущий модуль 1.2</p></div>
  <div class="metric-card"><span class="eyebrow">На проверке</span><strong>2</strong><p>Работы проверит куратор. Это не блокирует следующий автоматический шаг.</p></div>
  <div class="metric-card"><span class="eyebrow">Серия</span><strong>5 дней</strong><p>Заходишь и занимаешься без пропусков.</p></div>
 </div>

 <section class="section"><div class="section-head"><h2>Мои курсы</h2><button class="link-btn" onclick="go('courses')">Все курсы →</button></div>
  <div class="grid grid-3">${db.courses.map(courseCard).join("")}</div>
 </section>`;
}
function coursesPage(){return `${pageHead("Каталог","Мои курсы","Три программы из базового пакета организатора.")}<div class="grid grid-3 section">${db.courses.map(courseCard).join("")}</div>`}
function openCourse(id){state.courseId=id;state.view="course";render()}
function coursePage(c){
 const p=progress(c),n=nextStep(c);
 return `<div class="back"><button class="btn" onclick="go('courses')">← Все курсы</button></div>
 <div class="course-head"><div class="course-intro"><div class="eyebrow">${esc(c.grades)} · ${esc(c.tool)}</div><h1>${esc(c.title)}</h1><p class="sub">${esc(c.goal)}</p><div class="passport"><span><b>Объём</b>${esc(c.duration)}</span><span><b>Модулей</b>${c.modules.length}</span><span><b>Шагов</b>${p.total}</span></div></div>
 <div class="card progress-card"><span class="eyebrow">Прогресс</span><strong>${p.done}/${p.total}</strong><div class="progress"><i style="width:${p.pct}%"></i></div><span class="mono">${p.pct}%</span>${n?`<button class="btn primary full" onclick="openStep('${c.id}','${n.id}')">Следующий шаг →</button>`:""}</div></div>
 <div class="section">${c.modules.map(m=>`<section class="module"><div class="module-head"><div><span class="eyebrow">Модуль ${m.id}</span><h2>${esc(m.title)}</h2></div><span class="mono muted">${m.steps.length} шагов</span></div>
  <div class="steps">${m.steps.map(s=>`<button class="step ${n?.id===s.id?"current":""}" onclick="openStep('${c.id}','${s.id}')"><span class="step-icon">${iconFor(s.type)}</span><span class="step-copy"><b>${esc(s.title)}</b><small>${esc(s.type)}</small></span>${statusHTML(s.status)}</button>`).join("")}</div>
 </section>`).join("")}</div>`;
}

function openStep(cid,sid){state.courseId=cid;state.stepId=sid;state.view="step";render()}
function getStep(){return stepOf(state.courseId,state.stepId)}
function renderSourceText(text){
 return esc(text).split("\n\n").map(block=>block.includes("\n")?`<pre class="source">${esc(block)}</pre>`:`<p>${esc(block)}</p>`).join("");
}
function stepPage(c,s){
 const idx=allSteps(c).findIndex(x=>x.id===s.id)+1;
 let input="";
 if(s.type==="Контрольный вопрос"&&s.options){
   input=`<div class="answer-block"><div class="answer-label">Твой ответ</div>${s.options.map((o,i)=>`<label class="option"><input type="${s.multi?"checkbox":"radio"}" name="ans" value="${i}"><span>${esc(o)}</span></label>`).join("")}</div>`;
 } else if(s.type==="Scratch" && /числом/i.test(s.submission)){
   input=`<div class="answer-block"><div class="answer-label">Ответ числом</div><input id="numberAnswer" class="field" inputmode="numeric" placeholder="Например, 0"></div>`;
 } else if(["Scratch","Minecraft Education","Проект"].includes(s.type)){
   input=`<div class="answer-block"><div class="answer-label">Что сдаёшь</div><input id="linkAnswer" class="field" placeholder="Ссылка на проект / работу"><div class="file-drop">＋ Перетащи сюда скриншот или файл <small>В демо можно использовать ссылку</small></div></div>`;
 } else if(s.type==="Задача с тестами"){
   input=`<div class="answer-block"><div class="answer-row"><div class="answer-label">Код на Python 3</div><span class="mono muted">${esc(s.constraints||"1 секунда · 256 МБ")}</span></div><textarea id="codeAnswer" class="code-editor" spellcheck="false" placeholder="# напиши решение"></textarea><div class="judge-note">В стенде отправка проходит через контур автопроверки. В статическом режиме результат демонстрационный.</div></div>`;
 }
 const action = s.status==="done" ? `<div class="success-box">✓ Работа зачтена <small>результат учтён в прогрессе</small></div>` :
 s.status==="review" ? `<div class="review-box">◷ Работа отправлена куратору <small>Можно продолжать обучение, пока работа проверяется.</small></div>` :
 s.status==="returned" ? `<div class="return-box">↩ Работа возвращена <small>Посмотри комментарий куратора и отправь исправленную версию.</small></div>` :
 `<button class="btn primary submit-btn" onclick="submitStep()">Отправить работу →</button>`;
 return `<div class="back"><button class="btn" onclick="state.view='course';render()">← Карта курса</button></div>
 <div class="step-layout"><article class="step-main">
  <div class="step-top"><span class="tag">${esc(s.type)}</span><span class="mono muted">Шаг ${idx} из ${allSteps(c).length}</span></div>
  <h1>${esc(s.title)}</h1>
  <div class="step-content">${renderSourceText(s.text)}</div>
  ${input}
  <div class="step-actions">${action}</div>
 </article>
 <aside class="step-aside"><div class="card"><div class="eyebrow">Паспорт шага</div><dl><div><dt>Тип</dt><dd>${esc(s.type)}</dd></div><div><dt>Проверка</dt><dd>${esc(s.check)}</dd></div><div><dt>Сдача</dt><dd>${esc(s.submission)}</dd></div></dl></div>
 ${s.status==="returned"&&s.comment?`<div class="card warning-card"><div class="eyebrow">Обратная связь</div><p>${esc(s.comment)}</p></div>`:""}
 </aside></div>`;
}
function submitStep(){
 const c=course(state.courseId),s=getStep();
 if(!s)return;
 if(s.check.includes("Ручная")){
   s.status="review";
   const existing=db.reviews.find(r=>r.studentId==="u1"&&r.stepId===s.id);
   if(existing){ existing.status="ЖДЁТ"; existing.comment=""; existing.age="только что"; }
   else db.reviews.unshift({id:"r"+Date.now(),student:"Маша К.",studentId:"u1",course:c.id,stepId:s.id,step:s.title,type:s.type,age:"только что",status:"ЖДЁТ",comment:""});
   db.feedback.push({student:"Маша К.",stepId:s.id,text:"Работа отправлена на ручную проверку."});
   saveDB(db);toast("Работа отправлена куратору");return;
 }
 if(s.type==="Контрольный вопрос"&&s.options){
   const vals=[...document.querySelectorAll('input[name="ans"]:checked')].map(x=>+x.value).sort();
   const raw=Array.isArray(s.answer)?s.answer:[Number(s.answer)];
   const ans=raw.map(Number).sort();
   if(JSON.stringify(vals)!==JSON.stringify(ans)){toast("Проверь ответ и попробуй ещё раз");return}
 }
 if(s.answerText!==undefined){
   const el=document.getElementById("numberAnswer");
   if(el && el.value.trim()!==String(s.answerText).trim()){toast("Проверь число и попробуй ещё раз");return}
 }
 if(s.type==="Задача с тестами"){
   const code=document.getElementById("codeAnswer")?.value.trim();
   if(!code){toast("Напиши решение на Python 3");return}
   const tests=s.tests||[{input:"2 3",output:"5"},{input:"-5 7",output:"2"}];
   const results=tests.map((t,i)=>({n:i+1,verdict:"OK",visible:i<2,input:i<2?t.input:undefined,expected:i<2?t.output:undefined,output:i<2?t.output:undefined,time_ms:20+i}));
   db.feedback.push({student:"Маша К.",stepId:s.id,text:`Автопроверка: ${results.length} тестов, все пройдены.`});
 }
 s.status="done";saveDB(db);toast("Зачтено · прогресс обновлён");
}
function historyPage(){
 const rows=[];
 db.courses.forEach(c=>allSteps(c).forEach(s=>{if(s.status!=="idle") rows.push({c,s})}));
 db.feedback.slice().reverse().forEach(f=>{const found=rows.find(x=>x.s.id===f.stepId);if(found)found.feedback=f.text});
 return `${pageHead("История","Мои работы","Здесь сохраняются результаты, попытки и обратная связь куратора.")}
 <div class="table-wrap section"><table class="table"><thead><tr><th>Курс</th><th>Шаг</th><th>Статус</th><th>Обратная связь</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.c.title)}</td><td><b>${esc(x.s.title)}</b><small>${esc(x.s.type)}</small></td><td>${statusHTML(x.s.status)}</td><td>${esc(x.feedback||x.s.comment||"—")}</td></tr>`).join("")}</tbody></table></div>`;
}

function ratingPage(){
 return `${pageHead("Рейтинг","Мой рейтинг","Каждое число объяснимо: здесь видно, из чего сложился результат.")}
 <div class="rating-layout section"><div class="card rating-total"><span class="eyebrow">Результат</span><strong>142</strong><span>балла</span><div class="rank-line"><b>7-е место</b><span>из 18 в группе</span></div></div>
 <div class="card"><div class="eyebrow">Расшифровка</div><div class="breakdown"><div><b>72</b><span>автопроверка · 9 зачтённых работ</span></div><div><b>50</b><span>ручная проверка · 5 принятых работ</span></div><div><b>20</b><span>серия · 5 дней без пропусков</span></div></div><div class="notice">Следующий шаг даёт ещё один результат после проверки. Ручная и автоматическая проверка одинаково учитываются в прогрессе.</div></div></div>`;
}

function curatorQueue(){
 const reviews=db.reviews;
 return `${pageHead("Рабочее место куратора","Очередь проверки","Ручные работы не теряются: здесь видно ученика, шаг, возраст работы и действие.")}
 <div class="queue-summary"><div><b>${reviews.length}</b><span>в очереди</span></div><div><b>2</b><span>замедлились</span></div><div><b>1</b><span>выпадает</span></div></div>
 <div class="table-wrap section"><table class="table"><thead><tr><th>Ученик</th><th>Шаг</th><th>Тип</th><th>Сигнал</th><th>Действие</th></tr></thead><tbody>${reviews.map(r=>`<tr><td><b>${esc(r.student)}</b><small>${esc(r.age)}</small></td><td>${esc(r.step)}</td><td>${esc(r.type)}</td><td>${signalHTML(r.status)}</td><td><button class="btn small" onclick="openReview('${r.id}')">Проверить →</button></td></tr>`).join("")}</tbody></table></div>`;
}
function openReview(id){state.reviewId=id;state.view="review";render()}
function reviewPage(r){
 const s=stepOf(r.course,r.stepId);
 return `<div class="back"><button class="btn" onclick="go('queue')">← Очередь</button></div>
 ${pageHead("Ручная проверка",r.step,`${r.student} · ${r.type} · работа ждёт ${r.age}`)}
 <div class="review-layout section"><article class="card"><div class="review-work-head"><span class="tag">${esc(r.type)}</span><span class="mono">ID ${esc(r.id)}</span></div><h2>Работа ученика</h2><div class="submission-preview"><div class="fake-link">https://example.edu/work/${esc(r.id)}</div><div class="fake-shot">Скриншот / результат работы</div></div><h3>Критерии шага</h3><ol class="criteria">${(s?.criteria?.length?s.criteria:["Результат соответствует условию шага.","Обязательные элементы работы присутствуют."]).map(x=>`<li>${esc(x)}</li>`).join("")}</ol></article>
 <aside class="card"><div class="eyebrow">Решение куратора</div><textarea id="reviewComment" class="field" rows="7" placeholder="Комментарий ученику"></textarea><div class="actions vertical"><button class="btn primary full" onclick="acceptReview('${r.id}')">✓ Принять работу</button><button class="btn full" onclick="returnReview('${r.id}')">↩ Вернуть с комментарием</button></div></aside></div>`;
}
function findReview(id){return db.reviews.find(r=>r.id===id)}
function acceptReview(id){
 const r=findReview(id); if(!r)return;
 const s=stepOf(r.course,r.stepId); if(s)s.status="done";
 db.reviews=db.reviews.filter(x=>x.id!==id);
 db.feedback.push({student:r.student,stepId:r.stepId,text:"Работа принята куратором."});
 saveDB(db);state.view="queue";state.reviewId=null;toast("Работа принята · прогресс ученика обновлён");
}
function returnReview(id){
 const r=findReview(id); if(!r)return;
 const comment=document.getElementById("reviewComment")?.value.trim()||"Добавьте комментарий к исправлению и отправьте работу повторно.";
 const s=stepOf(r.course,r.stepId); if(s){s.status="returned";s.comment=comment}
 r.status="ЖДЁТ";r.comment=comment;r.age="только что";
 saveDB(db);state.view="queue";state.reviewId=null;toast("Работа возвращена с комментарием");
}
function studentsPage(){
 return `${pageHead("Ученики","Закреплённые ученики","Куратор видит сигнал раньше, чем ученик перестаёт заходить.")}
 <div class="table-wrap section"><table class="table"><thead><tr><th>Ученик</th><th>Курс</th><th>Прогресс</th><th>Сигнал</th></tr></thead><tbody>
 ${db.students.map(u=>u.courses.map(cid=>{const c=course(cid),p=progress(c),sig=u.signals[cid]||"В графике";return `<tr><td><b>${esc(u.name)}</b><small>${esc(u.grade)}</small></td><td>${esc(c.title)}</td><td><div class="mini-progress"><span style="width:${p.pct}%"></span></div><small>${p.done}/${p.total} · ${p.pct}%</small></td><td>${signalHTML(sig)}</td></tr>`}).join("")).join("")}
 </tbody></table></div>`;
}
function questionsPage(){
 return `${pageHead("Обратная связь","Вопросы учеников","Вопрос привязан к конкретному шагу курса — куратор отвечает в контексте.")}
 <div class="grid grid-2 section"><div class="card question-card"><div class="question-meta"><b>Маша К.</b><span>1.2.4 · Scratch</span></div><h3>Почему нужно 120 повторов, а не 60?</h3><p class="muted">Сегодня, 09:42</p><textarea class="field" rows="4" placeholder="Ответ ученику"></textarea><button class="btn primary" onclick="toast('Ответ сохранён')">Ответить</button></div>
 <div class="card"><div class="question-meta"><b>Иван П.</b><span>3.2.4 · Python</span></div><h3>Не понимаю условие про 100 лет.</h3><p class="muted">Вчера, 17:20</p><textarea class="field" rows="4" placeholder="Ответ ученику"></textarea><button class="btn primary" onclick="toast('Ответ сохранён')">Ответить</button></div></div>`;
}

function adminPage(){
 return `${pageHead("Конструктор","Курсы","Курс собирается из модулей и расширяемых типов шагов. Опубликованный курс можно открыть и изменить.")}
 <div class="admin-toolbar"><button class="btn primary" onclick="newCourse()">＋ Создать курс</button><span class="muted">Опубликовано: ${db.courses.filter(c=>c.published).length} · Всего: ${db.courses.length}</span></div>
 <div class="grid grid-3 section">${db.courses.map(c=>`<article class="card admin-course"><div class="card-top"><span class="tag">${esc(c.grades)}</span><span class="${c.published?"pub":"draft"}">${c.published?"Опубликован":"Черновик"}</span></div><h3>${esc(c.title)}</h3><p class="muted">${c.modules.length} модуля · ${allSteps(c).length} шагов</p><div class="course-tree">${c.modules.map(m=>`<div><b>${esc(m.id)} ${esc(m.title)}</b><span>${m.steps.length}</span></div>`).join("")}</div><div class="actions"><button class="btn" onclick="editCourse('${c.id}')">Редактировать</button><button class="btn ${c.published?"":"primary"}" onclick="togglePublish('${c.id}')">${c.published?"Снять публикацию":"Опубликовать"}</button></div></article>`).join("")}</div>`;
}
function newCourse(){
 const id="new-"+Date.now();db.courses.push({id,title:"Новый курс",grades:"1–9 класс",duration:"по плану",tool:"Новый инструмент",goal:"Описание цели курса",published:false,modules:[]});saveDB(db);editCourse(id)
}
function editCourse(id){
 state.courseId=id;state.view="edit-course";render()
}
function editCoursePage(c){
 return `<div class="back"><button class="btn" onclick="go('admin')">← Курсы</button></div>${pageHead("Редактор курса",c.title,"Паспорт, модули и шаги редактируются из одного конструктора.")}
 <div class="editor-grid section"><div class="card"><div class="eyebrow">Паспорт курса</div><label>Название<input class="field" id="ec-title" value="${esc(c.title)}"></label><label>Классы<input class="field" id="ec-grades" value="${esc(c.grades)}"></label><label>Инструмент<input class="field" id="ec-tool" value="${esc(c.tool)}"></label><label>Объём<input class="field" id="ec-duration" value="${esc(c.duration)}"></label><label>Цель<textarea class="field" id="ec-goal" rows="5">${esc(c.goal)}</textarea></label><button class="btn primary" onclick="saveCourseEdit('${c.id}')">Сохранить изменения</button></div>
 <div class="card"><div class="eyebrow">Состав курса</div>${c.modules.map(m=>`<div class="admin-module"><div><b>${esc(m.id)} ${esc(m.title)}</b><small>${m.steps.length} шагов</small></div><div class="actions"><button class="btn small" onclick="renameModule('${c.id}','${m.id}')">Изменить</button><button class="btn small" onclick="addStep('${c.id}','${m.id}')">＋ Шаг</button></div></div><div class="step-list-admin">${m.steps.map((s,i)=>`<div class="admin-step"><span class="step-icon">${iconFor(s.type)}</span><span><b>${esc(s.id)} · ${esc(s.title)}</b><small>${esc(s.type)} · ${esc(s.check)}</small></span><button class="btn small" onclick="removeStep('${c.id}','${m.id}','${s.id}')">Удалить</button></div>`).join("")}</div>`).join("")}<button class="btn full" onclick="addModule('${c.id}')">＋ Добавить модуль</button></div></div>`;
}
function addModule(cid){const c=course(cid);if(!c)return;const title=prompt("Название нового модуля");if(!title)return;const n=c.modules.length+1;c.modules.push({id:`${cid}-m${n}`,title,steps:[]});saveDB(db);render()}
function renameModule(cid,mid){const m=course(cid)?.modules.find(x=>x.id===mid);if(!m)return;const title=prompt("Название модуля",m.title);if(title){m.title=title;saveDB(db);render()}}
function addStep(cid,mid){const c=course(cid),m=c?.modules.find(x=>x.id===mid);if(!m)return;const title=prompt("Название шага");if(!title)return;const type=prompt("Тип: Теория / Контрольный вопрос / Scratch / Minecraft Education / Задача с тестами / Проект","Теория")||"Теория";const id=`${mid}.${m.steps.length+1}`;m.steps.push({id,title,type,check:type==="Теория"?"Засчитывается при прочтении":type==="Контрольный вопрос"||type==="Задача с тестами"?"Автоматическая":"Ручная (куратор)",submission:type==="Теория"?"—":"Ответ",text:"Содержание нового шага. Заполните его в данных курса.",status:"idle",criteria:[],solution:""});saveDB(db);render()}
function removeStep(cid,mid,sid){const m=course(cid)?.modules.find(x=>x.id===mid);if(!m)return;m.steps=m.steps.filter(s=>s.id!==sid);saveDB(db);render()}

function saveCourseEdit(id){
 const c=course(id); if(!c)return;
 c.title=document.getElementById("ec-title").value.trim();c.grades=document.getElementById("ec-grades").value.trim();c.tool=document.getElementById("ec-tool").value.trim();c.duration=document.getElementById("ec-duration").value.trim();c.goal=document.getElementById("ec-goal").value.trim();saveDB(db);toast("Изменения курса сохранены")
}
function togglePublish(id){const c=course(id);c.published=!c.published;saveDB(db);toast(c.published?"Курс опубликован":"Публикация снята")}
function assignmentsPage(){
 return `${pageHead("Назначения","Кураторы и ученики","Связь ученик ↔ курс ↔ куратор сохраняется в демо-модели.")}
 <div class="card section"><div class="table-wrap"><table class="table"><thead><tr><th>Ученик</th><th>Курс</th><th>Куратор</th><th></th></tr></thead><tbody>${db.assignments.map((a,i)=>{const u=db.students.find(x=>x.id===a.student),c=course(a.course),cur=db.curators.find(x=>x.id===a.curator);return `<tr><td>${esc(u?.name)}</td><td>${esc(c?.title)}</td><td><select class="field compact" onchange="changeAssignment(${i},this.value)">${db.curators.map(x=>`<option value="${x.id}" ${x.id===a.curator?"selected":""}>${esc(x.name)}</option>`).join("")}</select></td><td><button class="btn small" onclick="removeAssignment(${i})">Отчислить</button></td></tr>`}).join("")}</tbody></table></div><div class="actions"><button class="btn primary" onclick="newAssignment()">＋ Новое назначение</button></div></div>`;
}
function newAssignment(){const student=prompt("ID ученика: u1 / u2 / u3","u1"),cid=prompt("ID курса: scratch / minecraft / python","scratch"),cur=prompt("ID куратора: c1","c1");if(!student||!cid||!cur)return;if(!db.assignments.some(a=>a.student===student&&a.course===cid)){db.assignments.push({student,course:cid,curator:cur});const u=db.students.find(x=>x.id===student);if(u&&!u.courses.includes(cid))u.courses.push(cid);saveDB(db);render()}}
function changeAssignment(i,curator){if(db.assignments[i]){db.assignments[i].curator=curator;saveDB(db);toast("Куратор назначен")}}
function removeAssignment(i){if(confirm("Отчислить ученика с курса?")){db.assignments.splice(i,1);saveDB(db);render()}}

function typesPage(){
 const types=[["Теория","T","Прочтение"],["Контрольный вопрос","?","Автопроверка"],["Scratch","S","Авто или вручную"],["Minecraft Education","M","Ручная"],["Задача с тестами","⌘","Тесты"],["Проект","P","Ручная"]];
 return `${pageHead("Архитектура","Типы шагов","Список открыт: новый тип не требует переписывать курс, карту или кабинет.")}
 <div class="type-grid section">${types.map(t=>`<div class="type-card"><span class="step-icon">${t[1]}</span><div><b>${t[0]}</b><small>${t[2]}</small></div></div>`).join("")}<div class="type-card dashed"><span class="step-icon">＋</span><div><b>Новый тип</b><small>Добавляется через конфигурацию</small></div></div></div>`;
}

function render(){
 if(!state.role){login();return}
 if(state.view==="step")return shell(stepPage(course(state.courseId),getStep()),"courses");
 if(state.view==="review")return shell(reviewPage(findReview(state.reviewId)),"queue");
 if(state.role==="student"){
   if(state.view==="course")return shell(coursePage(course(state.courseId)),"courses");
   if(state.view==="courses")return shell(coursesPage(),"courses");
   if(state.view==="history")return shell(historyPage(),"history");
   if(state.view==="rating")return shell(ratingPage(),"rating");
   return shell(studentDashboard(),"dashboard");
 }
 if(state.role==="curator"){
   if(state.view==="students")return shell(studentsPage(),"students");
   if(state.view==="questions")return shell(questionsPage(),"questions");
   return shell(curatorQueue(),"queue");
 }
 if(state.view==="edit-course")return shell(editCoursePage(course(state.courseId)),"admin");
 if(state.view==="assignments")return shell(assignmentsPage(),"assignments");
 if(state.view==="types")return shell(typesPage(),"types");
 return shell(adminPage(),"admin");
}
render();
