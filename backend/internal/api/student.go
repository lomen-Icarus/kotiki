package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"kotiki/backend/internal/db"
	"kotiki/backend/internal/steps"
)

// ---------- доступ ----------

// checkCourseAccess: ученик должен быть записан на опубликованный курс; куратор и админ видят всё.
func (s *Server) checkCourseAccess(u User, courseID int64) error {
	if u.Role != "student" {
		return nil
	}
	var status string
	err := s.DB.QueryRow(`
		SELECT c.status FROM enrollments e JOIN courses c ON c.id = e.course_id
		WHERE e.course_id = ? AND e.student_id = ?`, courseID, u.ID).Scan(&status)
	if err == sql.ErrNoRows {
		return errForbidden("вы не записаны на этот курс")
	}
	if err != nil {
		return err
	}
	if status != "published" {
		return errForbidden("курс снят с публикации")
	}
	return nil
}

// ---------- сдачи ----------

type submissionJSON struct {
	ID          int64           `json:"id"`
	StepID      int64           `json:"step_id"`
	Attempt     int             `json:"attempt"`
	Status      string          `json:"status"`
	Score       *int64          `json:"score"`
	MaxScore    int             `json:"max_score"`
	CheckSource string          `json:"check_source"`
	Answer      json.RawMessage `json:"answer"`
	Feedback    *string         `json:"feedback"`
	Hint        *string         `json:"hint"`
	Tests       json.RawMessage `json:"tests"`
	CreatedAt   string          `json:"created_at"`
	ReviewedAt  *string         `json:"reviewed_at"`
	Reviewer    *IDName         `json:"reviewer"`
}

const submissionSelect = `
	SELECT sb.id, sb.step_id, sb.attempt, sb.status, sb.score, st.max_score, sb.check_source, sb.answer,
	       sb.feedback, sb.hint, sb.tests, sb.created_at, sb.reviewed_at, rv.id, rv.name
	FROM submissions sb
	JOIN steps st ON st.id = sb.step_id
	LEFT JOIN users rv ON rv.id = sb.reviewer_id `

func scanSubmission(row interface{ Scan(...any) error }) (submissionJSON, error) {
	var sb submissionJSON
	var score, reviewerID sql.NullInt64
	var answer string
	var feedback, hint, tests, reviewed, reviewerName sql.NullString
	err := row.Scan(&sb.ID, &sb.StepID, &sb.Attempt, &sb.Status, &score, &sb.MaxScore, &sb.CheckSource, &answer,
		&feedback, &hint, &tests, &sb.CreatedAt, &reviewed, &reviewerID, &reviewerName)
	sb.Score, sb.Feedback, sb.Hint, sb.ReviewedAt = nullInt(score), nullStr(feedback), nullStr(hint), nullStr(reviewed)
	sb.Answer, sb.Tests = json.RawMessage(answer), rawOrNull(tests)
	if reviewerID.Valid {
		sb.Reviewer = &IDName{reviewerID.Int64, reviewerName.String}
	}
	return sb, err
}

func (s *Server) submissionByID(id int64) (submissionJSON, error) {
	sb, err := scanSubmission(s.DB.QueryRow(submissionSelect+`WHERE sb.id = ?`, id))
	if err == sql.ErrNoRows {
		return sb, errNotFound("сдача не найдена")
	}
	return sb, err
}

func (s *Server) submissionsWhere(cond string, args ...any) ([]submissionJSON, error) {
	rows, err := s.DB.Query(submissionSelect+`WHERE `+cond+` ORDER BY sb.id DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []submissionJSON{}
	for rows.Next() {
		sb, err := scanSubmission(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, sb)
	}
	return list, rows.Err()
}

// ---------- кабинет ----------

// GET /api/me/courses
func (s *Server) myCourses(w http.ResponseWriter, r *http.Request) error {
	u := currentUser(r)
	rows, err := s.DB.Query(`
		SELECT c.id, c.title, c.tool, c.tool_name, c.grade_from, c.grade_to, cu.id, cu.name
		FROM enrollments e JOIN courses c ON c.id = e.course_id LEFT JOIN users cu ON cu.id = e.curator_id
		WHERE e.student_id = ? AND c.status = 'published' ORDER BY e.id`, u.ID)
	if err != nil {
		return err
	}
	type item struct {
		Course         map[string]any `json:"course"`
		Progress       Progress       `json:"progress"`
		Score          Score          `json:"score"`
		NextStep       *StepRef       `json:"next_step"`
		PendingCount   int            `json:"pending_count"`
		ReturnedCount  int            `json:"returned_count"`
		Curator        *IDName        `json:"curator"`
		LastActivityAt *string        `json:"last_activity_at"`
	}
	type enr struct {
		c       map[string]any
		curator *IDName
		id      int64
	}
	var list []enr
	for rows.Next() {
		var id, from, to int64
		var title, tool, toolName string
		var curID sql.NullInt64
		var curName sql.NullString
		if err := rows.Scan(&id, &title, &tool, &toolName, &from, &to, &curID, &curName); err != nil {
			rows.Close()
			return err
		}
		e := enr{id: id, c: map[string]any{"id": id, "title": title, "tool": tool, "tool_name": toolName,
			"grades": Grades{int(from), int(to)}}}
		if curID.Valid {
			e.curator = &IDName{curID.Int64, curName.String}
		}
		list = append(list, e)
	}
	rows.Close()

	items := []item{}
	for _, e := range list {
		mods, err := s.loadOutline(e.id)
		if err != nil {
			return err
		}
		states, err := s.studentStates(u.ID, e.id)
		if err != nil {
			return err
		}
		sum := summarize(mods, states)
		it := item{Course: e.c, Progress: sum.Progress, Score: sum.Score, NextStep: sum.NextStep,
			PendingCount: sum.PendingCount, ReturnedCount: sum.ReturnedCount, Curator: e.curator}
		if sum.LastActivity != "" {
			it.LastActivityAt = &sum.LastActivity
		}
		items = append(items, it)
	}
	return writeJSON(w, 200, items)
}

// ---------- шаг ----------

// publicContent — content шага плюс то, что способ проверки разрешает показать (например, примеры тестов).
func publicContent(st stepRow) map[string]any {
	content := map[string]any{}
	_ = json.Unmarshal(st.Content, &content)
	if ch, ok := steps.Checkers[st.CheckMode()]; ok {
		for k, v := range ch.Public(st.Content, st.Check) {
			content[k] = v
		}
	}
	return content
}

func submitForm(st stepRow) any {
	ch, ok := steps.Checkers[st.CheckMode()]
	if !ok {
		return nil
	}
	fields := ch.SubmitFields(st.Content, st.Check)
	if fields == nil {
		return nil
	}
	return map[string]any{"fields": fields}
}

// GET /api/steps/{id}
func (s *Server) getStep(w http.ResponseWriter, r *http.Request) error {
	u := currentUser(r)
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	st, courseID, err := s.loadStep(id)
	if err != nil {
		return err
	}
	if err := s.checkCourseAccess(u, courseID); err != nil {
		return err
	}
	c, err := s.loadCourse(courseID)
	if err != nil {
		return err
	}
	mods, err := s.loadOutline(courseID)
	if err != nil {
		return err
	}
	all := flatSteps(mods)
	var prev, next *int64
	index := 0
	for i, x := range all {
		if x.ID == st.ID {
			index = i + 1
			if i > 0 {
				prev = &all[i-1].ID
			}
			if i+1 < len(all) {
				next = &all[i+1].ID
			}
		}
	}

	resp := map[string]any{
		"id": st.ID, "title": st.Title, "type": st.Type, "check_mode": st.CheckMode(), "max_score": st.MaxScore,
		"content": publicContent(st), "submit": submitForm(st),
		"breadcrumbs": map[string]any{
			"course": IDTitle{ID: c.ID, Title: c.Title},
			"module": IDTitle{ID: st.ModuleID, Title: st.ModuleTitle},
		},
		"index": index, "total": len(all), "prev_step_id": prev, "next_step_id": next,
		"status": "not_started", "last_submission": nil,
	}
	if u.Role == "student" {
		states, err := s.studentStates(u.ID, courseID)
		if err != nil {
			return err
		}
		resp["status"] = statusOf(states, st.ID)
		subs, err := s.submissionsWhere(`sb.step_id = ? AND sb.student_id = ?`, st.ID, u.ID)
		if err != nil {
			return err
		}
		if len(subs) > 0 {
			resp["last_submission"] = subs[0]
		}
	}
	return writeJSON(w, 200, resp)
}

// POST /api/steps/{id}/submissions — сдать ответ.
func (s *Server) submit(w http.ResponseWriter, r *http.Request) error {
	u := currentUser(r)
	if u.Role != "student" {
		return errForbidden("сдавать ответы может только ученик; админ может проверить шаг через preview-check")
	}
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Answer json.RawMessage `json:"answer"`
	}
	if err := readJSON(r, &in); err != nil {
		return err
	}
	if len(in.Answer) == 0 || string(in.Answer) == "null" {
		in.Answer = json.RawMessage("{}")
	}
	st, courseID, err := s.loadStep(id)
	if err != nil {
		return err
	}
	if err := s.checkCourseAccess(u, courseID); err != nil {
		return err
	}

	mode := st.CheckMode()
	checker, ok := steps.Checkers[mode]
	if !ok {
		return fmt.Errorf("шаг %d: неизвестный способ проверки %q", st.ID, mode)
	}
	states, err := s.studentStates(u.ID, courseID)
	if err != nil {
		return err
	}
	cur := statusOf(states, st.ID)
	if cur == "pending" {
		return errConflict("работа уже на проверке у куратора — дождитесь результата")
	}
	if cur == "passed" && (mode == "manual" || mode == "none") {
		subs, err := s.submissionsWhere(`sb.step_id = ? AND sb.student_id = ?`, st.ID, u.ID)
		if err != nil {
			return err
		}
		return writeJSON(w, 200, subs[0]) // уже зачтено — просто возвращаем последний результат
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	res, err := checker.Check(ctx, st.Content, st.Check, in.Answer)
	if err != nil {
		return err
	}

	var score any
	source, reviewedAt := "auto", any(db.Now())
	switch res.Status {
	case "passed":
		score = st.MaxScore
	case "failed":
		score = 0
	case "pending":
		source, reviewedAt = "curator", nil
	}
	var hint, tests any
	if res.Hint != "" {
		hint = res.Hint
	}
	if res.Tests != nil {
		b, _ := json.Marshal(res.Tests)
		tests = string(b)
	}
	attempt := 1
	if prev := states[st.ID]; prev != nil {
		attempt = prev.Attempts + 1
	}
	result, err := s.DB.Exec(`
		INSERT INTO submissions (step_id, student_id, attempt, answer, status, score, hint, tests, check_source, created_at, reviewed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		st.ID, u.ID, attempt, string(in.Answer), res.Status, score, hint, tests, source, db.Now(), reviewedAt)
	if err != nil {
		return err
	}
	newID, _ := result.LastInsertId()
	sb, err := s.submissionByID(newID)
	if err != nil {
		return err
	}
	return writeJSON(w, 201, sb)
}

// GET /api/steps/{id}/submissions — мои попытки по шагу.
func (s *Server) stepSubmissions(w http.ResponseWriter, r *http.Request) error {
	u := currentUser(r)
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	list, err := s.submissionsWhere(`sb.step_id = ? AND sb.student_id = ?`, id, u.ID)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, list)
}

// GET /api/me/submissions?course_id=&status= — история выполненных заданий.
func (s *Server) mySubmissions(w http.ResponseWriter, r *http.Request) error {
	u := currentUser(r)
	cond := []string{"sb.student_id = ?"}
	args := []any{u.ID}
	if cid := queryInt(r, "course_id", 0); cid > 0 {
		cond = append(cond, "m.course_id = ?")
		args = append(args, cid)
	}
	if st := r.URL.Query().Get("status"); st != "" {
		cond = append(cond, "sb.status = ?")
		args = append(args, st)
	}
	where := strings.Join(cond, " AND ")
	var total int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM submissions sb JOIN steps st ON st.id = sb.step_id
		JOIN modules m ON m.id = st.module_id WHERE `+where, args...).Scan(&total); err != nil {
		return err
	}
	limit, offset := paging(r)
	rows, err := s.DB.Query(`
		SELECT sb.id, st.id, st.title, st.type, c.id, c.title
		FROM submissions sb JOIN steps st ON st.id = sb.step_id JOIN modules m ON m.id = st.module_id
		JOIN courses c ON c.id = m.course_id
		WHERE `+where+` ORDER BY sb.id DESC LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		return err
	}
	type item struct {
		Submission submissionJSON `json:"submission"`
		Step       StepRef        `json:"step"`
		Course     IDTitle        `json:"course"`
	}
	var items []item
	var ids []int64
	for rows.Next() {
		var it item
		var sid int64
		if err := rows.Scan(&sid, &it.Step.ID, &it.Step.Title, &it.Step.Type, &it.Course.ID, &it.Course.Title); err != nil {
			rows.Close()
			return err
		}
		items = append(items, it)
		ids = append(ids, sid)
	}
	rows.Close()
	for i, sid := range ids {
		sb, err := s.submissionByID(sid)
		if err != nil {
			return err
		}
		items[i].Submission = sb
	}
	if items == nil {
		items = []item{}
	}
	return writeJSON(w, 200, map[string]any{"items": items, "total": total})
}

// ---------- рейтинг ----------

// GET /api/me/courses/{id}/rating — из чего сложился результат.
//
// Формула: за каждый зачтённый шаг начисляется max_score шага (для ручной проверки —
// столько, сколько поставил куратор). Баллы по умолчанию растут со сложностью шага:
// теория 1, вопрос 2, разбор/задача/задание 3, проект 5. Место в группе — по сумме баллов.
func (s *Server) myRating(w http.ResponseWriter, r *http.Request) error {
	u := currentUser(r)
	courseID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	if err := s.checkCourseAccess(u, courseID); err != nil {
		return err
	}
	mods, err := s.loadOutline(courseID)
	if err != nil {
		return err
	}
	states, err := s.studentStates(u.ID, courseID)
	if err != nil {
		return err
	}
	sum := summarize(mods, states)

	type item struct {
		Step        StepRef `json:"step"`
		Score       int     `json:"score"`
		Max         int     `json:"max"`
		Status      string  `json:"status"`
		CheckSource *string `json:"check_source"`
	}
	items := []item{}
	byType := map[string]*[2]int{} // тип → [набрано, максимум]
	for _, st := range flatSteps(mods) {
		it := item{Step: StepRef{ID: st.ID, Title: st.Title, Type: st.Type, ModuleTitle: st.ModuleTitle},
			Max: st.MaxScore, Status: statusOf(states, st.ID)}
		if state := states[st.ID]; state != nil {
			it.Score = state.Score
			src := state.CheckSource
			it.CheckSource = &src
		}
		items = append(items, it)
		if byType[st.Type] == nil {
			byType[st.Type] = &[2]int{}
		}
		byType[st.Type][0] += it.Score
		byType[st.Type][1] += it.Max
	}

	type typeTotal struct {
		Type  string `json:"type"`
		Title string `json:"title"`
		Score int    `json:"score"`
		Max   int    `json:"max"`
	}
	byTypeList := []typeTotal{}
	for _, t := range steps.Types {
		if v := byType[t.Name]; v != nil {
			byTypeList = append(byTypeList, typeTotal{t.Name, t.Title, v[0], v[1]})
		}
	}

	place, of, err := s.rankInCourse(courseID, u.ID, mods)
	if err != nil {
		return err
	}
	percent := 0
	if sum.Score.Max > 0 {
		percent = sum.Score.Value * 100 / sum.Score.Max
	}
	return writeJSON(w, 200, map[string]any{
		"score": sum.Score.Value, "max": sum.Score.Max, "percent": percent,
		"progress": sum.Progress,
		"rank":     map[string]int{"place": place, "of": of},
		"formula": "За каждый зачтённый шаг начисляются его баллы: теория — 1, контрольный вопрос — 2, " +
			"разбор, задание и задача — 3, проект — 5. Работы, проверенные куратором, учитываются так же, " +
			"как автоматическая проверка. Место в группе — по сумме баллов среди учеников курса.",
		"by_type": byTypeList,
		"items":   items,
	})
}

// rankInCourse — место ученика по сумме баллов среди всех учеников курса.
func (s *Server) rankInCourse(courseID, studentID int64, mods []moduleRow) (int, int, error) {
	rows, err := s.DB.Query(`SELECT student_id FROM enrollments WHERE course_id = ?`, courseID)
	if err != nil {
		return 0, 0, err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	scores := make([]int, 0, len(ids))
	mine := 0
	for _, id := range ids {
		states, err := s.studentStates(id, courseID)
		if err != nil {
			return 0, 0, err
		}
		v := summarize(mods, states).Score.Value
		if id == studentID {
			mine = v
		}
		scores = append(scores, v)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(scores)))
	place := 1
	for _, v := range scores {
		if v > mine {
			place++
		}
	}
	return place, len(scores), nil
}

// ---------- вопросы по шагу ----------

type questionJSON struct {
	ID         int64   `json:"id"`
	StepID     int64   `json:"step_id"`
	StepTitle  string  `json:"step_title"`
	Course     IDTitle `json:"course"`
	Student    IDName  `json:"student"`
	Text       string  `json:"text"`
	Status     string  `json:"status"`
	Answer     *string `json:"answer"`
	AnsweredBy *IDName `json:"answered_by"`
	CreatedAt  string  `json:"created_at"`
	AnsweredAt *string `json:"answered_at"`
}

const questionSelect = `
	SELECT q.id, q.step_id, st.title, c.id, c.title, stu.id, stu.name, q.text, q.status, q.answer,
	       ab.id, ab.name, q.created_at, q.answered_at
	FROM questions q
	JOIN steps st ON st.id = q.step_id JOIN modules m ON m.id = st.module_id JOIN courses c ON c.id = m.course_id
	JOIN users stu ON stu.id = q.student_id
	LEFT JOIN users ab ON ab.id = q.answered_by `

func (s *Server) questionsWhere(cond string, args ...any) ([]questionJSON, error) {
	rows, err := s.DB.Query(questionSelect+`WHERE `+cond+` ORDER BY q.id DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []questionJSON{}
	for rows.Next() {
		var q questionJSON
		var answer, abName, answeredAt sql.NullString
		var abID sql.NullInt64
		if err := rows.Scan(&q.ID, &q.StepID, &q.StepTitle, &q.Course.ID, &q.Course.Title, &q.Student.ID, &q.Student.Name,
			&q.Text, &q.Status, &answer, &abID, &abName, &q.CreatedAt, &answeredAt); err != nil {
			return nil, err
		}
		q.Answer, q.AnsweredAt = nullStr(answer), nullStr(answeredAt)
		if abID.Valid {
			q.AnsweredBy = &IDName{abID.Int64, abName.String}
		}
		list = append(list, q)
	}
	return list, rows.Err()
}

// POST /api/steps/{id}/questions
func (s *Server) askQuestion(w http.ResponseWriter, r *http.Request) error {
	u := currentUser(r)
	if u.Role != "student" {
		return errForbidden("вопросы задают ученики")
	}
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Text string `json:"text"`
	}
	if err := readJSON(r, &in); err != nil {
		return err
	}
	if strings.TrimSpace(in.Text) == "" {
		return errBadRequest("text: напишите вопрос")
	}
	_, courseID, err := s.loadStep(id)
	if err != nil {
		return err
	}
	if err := s.checkCourseAccess(u, courseID); err != nil {
		return err
	}
	res, err := s.DB.Exec(`INSERT INTO questions (step_id, student_id, text, created_at) VALUES (?, ?, ?, ?)`,
		id, u.ID, strings.TrimSpace(in.Text), db.Now())
	if err != nil {
		return err
	}
	qid, _ := res.LastInsertId()
	list, err := s.questionsWhere(`q.id = ?`, qid)
	if err != nil {
		return err
	}
	return writeJSON(w, 201, list[0])
}

// GET /api/steps/{id}/questions — ученик видит свои вопросы, куратор и админ — все.
func (s *Server) stepQuestions(w http.ResponseWriter, r *http.Request) error {
	u := currentUser(r)
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var list []questionJSON
	if u.Role == "student" {
		list, err = s.questionsWhere(`q.step_id = ? AND q.student_id = ?`, id, u.ID)
	} else {
		list, err = s.questionsWhere(`q.step_id = ?`, id)
	}
	if err != nil {
		return err
	}
	return writeJSON(w, 200, list)
}

// GET /api/me/questions
func (s *Server) myQuestions(w http.ResponseWriter, r *http.Request) error {
	list, err := s.questionsWhere(`q.student_id = ?`, currentUser(r).ID)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, list)
}
