package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"kotiki/backend/internal/db"
)

// curatorFilter — условие «ученики этого куратора». Админ видит всех.
func curatorFilter(u User, alias string) (string, []any) {
	if u.Role == "admin" {
		return "1 = 1", nil
	}
	return alias + ".curator_id = ?", []any{u.ID}
}

// checkCurates — закреплён ли ученик на курсе за этим куратором.
func (s *Server) checkCurates(u User, studentID, courseID int64) error {
	if u.Role == "admin" {
		return nil
	}
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM enrollments WHERE student_id = ? AND course_id = ? AND curator_id = ?`,
		studentID, courseID, u.ID).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return errForbidden("этот ученик не закреплён за вами")
	}
	return nil
}

type studentRow struct {
	Student         IDName   `json:"student"`
	Course          IDTitle  `json:"course"`
	Progress        Progress `json:"progress"`
	Score           Score    `json:"score"`
	CurrentStep     *StepRef `json:"current_step"`
	LastActivityAt  *string  `json:"last_activity_at"`
	DaysInactive    int      `json:"days_inactive"`
	PendingCount    int      `json:"pending_count"`
	ReturnedCount   int      `json:"returned_count"`
	FailsOnCurrent  int      `json:"failed_attempts_on_current"`
	GroupAvgPercent int      `json:"group_avg_percent"`
	Risk            string   `json:"risk"`
	RiskLabel       string   `json:"risk_label"`
	RiskReasons     []string `json:"risk_reasons"`
	enrolledAt      string
	lastSeen        string
}

// studentRows считает прогресс и сигнал отставания для набора записей на курсы.
func (s *Server) studentRows(cond string, args ...any) ([]studentRow, error) {
	rows, err := s.DB.Query(`
		SELECT u.id, u.name, c.id, c.title, c.tool, e.created_at, COALESCE(u.last_seen_at, '')
		FROM enrollments e JOIN users u ON u.id = e.student_id JOIN courses c ON c.id = e.course_id
		WHERE c.status != 'archived' AND `+cond+` ORDER BY u.name`, args...)
	if err != nil {
		return nil, err
	}
	var list []studentRow
	for rows.Next() {
		var sr studentRow
		if err := rows.Scan(&sr.Student.ID, &sr.Student.Name, &sr.Course.ID, &sr.Course.Title, &sr.Course.Tool,
			&sr.enrolledAt, &sr.lastSeen); err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, sr)
	}
	rows.Close()

	outlines := map[int64][]moduleRow{}
	groupAvg := map[int64]float64{}
	for i := range list {
		sr := &list[i]
		mods, ok := outlines[sr.Course.ID]
		if !ok {
			if mods, err = s.loadOutline(sr.Course.ID); err != nil {
				return nil, err
			}
			outlines[sr.Course.ID] = mods
			if groupAvg[sr.Course.ID], err = s.groupAverage(sr.Course.ID, mods); err != nil {
				return nil, err
			}
		}
		states, err := s.studentStates(sr.Student.ID, sr.Course.ID)
		if err != nil {
			return nil, err
		}
		sum := summarize(mods, states)
		sr.Progress, sr.Score, sr.CurrentStep = sum.Progress, sum.Score, sum.NextStep
		sr.PendingCount, sr.ReturnedCount, sr.FailsOnCurrent = sum.PendingCount, sum.ReturnedCount, sum.FailsOnNext
		sr.GroupAvgPercent = int(groupAvg[sr.Course.ID])

		// последняя активность — самое позднее из: вход на платформу, сдача, запись на курс
		last := sr.enrolledAt
		for _, t := range []string{sr.lastSeen, sum.LastActivity} {
			if t > last {
				last = t
			}
		}
		sr.LastActivityAt = &last
		days := daysSince(last)
		sr.DaysInactive = int(days)
		sr.Risk, sr.RiskReasons = risk(days, sum.Progress.Percent, groupAvg[sr.Course.ID], sum.FailsOnNext, sum.StaleReturned)
		sr.RiskLabel = riskLabels[sr.Risk]
		if sr.RiskReasons == nil {
			sr.RiskReasons = []string{}
		}
	}
	return list, nil
}

// groupAverage — средний процент прохождения курса по всем его ученикам.
func (s *Server) groupAverage(courseID int64, mods []moduleRow) (float64, error) {
	rows, err := s.DB.Query(`SELECT student_id FROM enrollments WHERE course_id = ?`, courseID)
	if err != nil {
		return 0, err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if len(ids) == 0 {
		return 0, nil
	}
	total := 0
	for _, id := range ids {
		states, err := s.studentStates(id, courseID)
		if err != nil {
			return 0, err
		}
		total += summarize(mods, states).Progress.Percent
	}
	return float64(total) / float64(len(ids)), nil
}

// GET /api/curator/students?course_id=&risk=
func (s *Server) curatorStudents(w http.ResponseWriter, r *http.Request) error {
	u := currentUser(r)
	cond, args := curatorFilter(u, "e")
	if cid := queryInt(r, "course_id", 0); cid > 0 {
		cond += " AND e.course_id = ?"
		args = append(args, cid)
	}
	list, err := s.studentRows(cond, args...)
	if err != nil {
		return err
	}
	riskFilter := r.URL.Query().Get("risk")
	order := map[string]int{"danger": 0, "warning": 1, "ok": 2}
	out := []studentRow{}
	for _, sr := range list {
		if riskFilter == "" || sr.Risk == riskFilter {
			out = append(out, sr)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return order[out[i].Risk] < order[out[j].Risk] })
	counts := map[string]int{"ok": 0, "warning": 0, "danger": 0}
	for _, sr := range list {
		counts[sr.Risk]++
	}
	return writeJSON(w, 200, map[string]any{"items": out, "counts": counts})
}

// GET /api/curator/students/{id} — карточка ученика.
func (s *Server) curatorStudent(w http.ResponseWriter, r *http.Request) error {
	u := currentUser(r)
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	cond, args := curatorFilter(u, "e")
	courses, err := s.studentRows(cond+" AND e.student_id = ?", append(args, id)...)
	if err != nil {
		return err
	}
	if len(courses) == 0 {
		return errNotFound("ученик не найден среди ваших")
	}
	subs, err := s.submissionsWhere(`sb.student_id = ?`, id)
	if err != nil {
		return err
	}
	subs = subs[:min(len(subs), 30)]
	questions, err := s.questionsWhere(`q.student_id = ?`, id)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, map[string]any{
		"student": courses[0].Student, "courses": courses, "submissions": subs, "questions": questions,
	})
}

// GET /api/curator/queue?course_id=&type= — работы на ручную проверку, сначала самые старые.
func (s *Server) curatorQueue(w http.ResponseWriter, r *http.Request) error {
	u := currentUser(r)
	cond, args := curatorFilter(u, "e")
	cond = "sb.status = 'pending' AND " + cond
	if cid := queryInt(r, "course_id", 0); cid > 0 {
		cond += " AND c.id = ?"
		args = append(args, cid)
	}
	if t := r.URL.Query().Get("type"); t != "" {
		cond += " AND st.type = ?"
		args = append(args, t)
	}
	rows, err := s.DB.Query(`
		SELECT sb.id, sb.attempt, sb.created_at, stu.id, stu.name, c.id, c.title, st.id, st.title, st.type, m.title
		FROM submissions sb
		JOIN steps st ON st.id = sb.step_id JOIN modules m ON m.id = st.module_id JOIN courses c ON c.id = m.course_id
		JOIN users stu ON stu.id = sb.student_id
		JOIN enrollments e ON e.student_id = sb.student_id AND e.course_id = c.id
		WHERE `+cond+` ORDER BY sb.created_at, sb.id`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	type item struct {
		SubmissionID int64   `json:"submission_id"`
		Attempt      int     `json:"attempt"`
		SubmittedAt  string  `json:"submitted_at"`
		WaitingHours int     `json:"waiting_hours"`
		Student      IDName  `json:"student"`
		Course       IDTitle `json:"course"`
		Step         StepRef `json:"step"`
	}
	items := []item{}
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.SubmissionID, &it.Attempt, &it.SubmittedAt, &it.Student.ID, &it.Student.Name,
			&it.Course.ID, &it.Course.Title, &it.Step.ID, &it.Step.Title, &it.Step.Type, &it.Step.ModuleTitle); err != nil {
			return err
		}
		it.WaitingHours = int(daysSince(it.SubmittedAt) * 24)
		items = append(items, it)
	}
	return writeJSON(w, 200, items)
}

// submissionOwner — чья сдача и к какому курсу относится.
func (s *Server) submissionOwner(id int64) (studentID, courseID int64, err error) {
	err = s.DB.QueryRow(`SELECT sb.student_id, m.course_id FROM submissions sb
		JOIN steps st ON st.id = sb.step_id JOIN modules m ON m.id = st.module_id WHERE sb.id = ?`, id).
		Scan(&studentID, &courseID)
	if err == sql.ErrNoRows {
		err = errNotFound("сдача не найдена")
	}
	return
}

// GET /api/curator/submissions/{id} — работа вместе с критериями проверки.
func (s *Server) curatorSubmission(w http.ResponseWriter, r *http.Request) error {
	u := currentUser(r)
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	studentID, courseID, err := s.submissionOwner(id)
	if err != nil {
		return err
	}
	if err := s.checkCurates(u, studentID, courseID); err != nil {
		return err
	}
	sb, err := s.submissionByID(id)
	if err != nil {
		return err
	}
	var st stepRow
	var content, check string
	if err := s.DB.QueryRow(`SELECT st.id, st.title, st.type, st.content, st.check_json, st.max_score, m.title
		FROM steps st JOIN modules m ON m.id = st.module_id WHERE st.id = ?`, sb.StepID).
		Scan(&st.ID, &st.Title, &st.Type, &content, &check, &st.MaxScore, &st.ModuleTitle); err != nil {
		return err
	}
	st.Content, st.Check = json.RawMessage(content), json.RawMessage(check)
	var student IDName
	if err := s.DB.QueryRow(`SELECT id, name FROM users WHERE id = ?`, studentID).Scan(&student.ID, &student.Name); err != nil {
		return err
	}
	prev, err := s.submissionsWhere(`sb.step_id = ? AND sb.student_id = ? AND sb.id != ?`, sb.StepID, studentID, sb.ID)
	if err != nil {
		return err
	}
	files, err := s.filesOf(st, sb.Answer, studentID)
	if err != nil {
		return err
	}
	var c IDTitle
	if err := s.DB.QueryRow(`SELECT id, title FROM courses WHERE id = ?`, courseID).Scan(&c.ID, &c.Title); err != nil {
		return err
	}
	return writeJSON(w, 200, map[string]any{
		"submission": sb,
		"files":      files,
		"student":    student,
		"course":     c,
		"step": map[string]any{
			"id": st.ID, "title": st.Title, "type": st.Type, "module_title": st.ModuleTitle, "max_score": st.MaxScore,
			"content": publicContent(st), "check": st.Check, "submit": submitForm(st),
		},
		"previous_attempts": prev,
	})
}

// POST /api/curator/submissions/{id}/review — принять или вернуть работу.
func (s *Server) review(w http.ResponseWriter, r *http.Request) error {
	u := currentUser(r)
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Decision string `json:"decision"` // accept | return
		Score    *int   `json:"score"`
		Comment  string `json:"comment"`
	}
	if err := readJSON(r, &in); err != nil {
		return err
	}
	in.Comment = strings.TrimSpace(in.Comment)
	studentID, courseID, err := s.submissionOwner(id)
	if err != nil {
		return err
	}
	if err := s.checkCurates(u, studentID, courseID); err != nil {
		return err
	}
	sb, err := s.submissionByID(id)
	if err != nil {
		return err
	}
	if sb.Status != "pending" {
		return errConflict("работа уже проверена")
	}

	var status string
	var score any
	switch in.Decision {
	case "accept":
		status = "passed"
		v := sb.MaxScore
		if in.Score != nil {
			v = min(max(*in.Score, 0), sb.MaxScore)
		}
		score = v
	case "return":
		if in.Comment == "" {
			return errBadRequest("comment: при возврате объясните ученику, что исправить")
		}
		status = "returned"
	default:
		return errBadRequest(`decision: ожидается "accept" или "return"`)
	}
	var comment any
	if in.Comment != "" {
		comment = in.Comment
	}
	if _, err := s.DB.Exec(`UPDATE submissions SET status = ?, score = ?, feedback = ?, reviewer_id = ?, reviewed_at = ?
		WHERE id = ?`, status, score, comment, u.ID, db.Now(), id); err != nil {
		return err
	}
	updated, err := s.submissionByID(id)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, updated)
}

// GET /api/curator/questions?status=open
func (s *Server) curatorQuestions(w http.ResponseWriter, r *http.Request) error {
	u := currentUser(r)
	cond := `EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = q.student_id AND e.course_id = c.id AND `
	fc, args := curatorFilter(u, "e")
	cond += fc + ")"
	if st := r.URL.Query().Get("status"); st != "" {
		cond += " AND q.status = ?"
		args = append(args, st)
	}
	list, err := s.questionsWhere(cond, args...)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, list)
}

// POST /api/curator/questions/{id}/answer
func (s *Server) answerQuestion(w http.ResponseWriter, r *http.Request) error {
	u := currentUser(r)
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
		return errBadRequest("text: напишите ответ")
	}
	list, err := s.questionsWhere(`q.id = ?`, id)
	if err != nil {
		return err
	}
	if len(list) == 0 {
		return errNotFound("вопрос не найден")
	}
	if err := s.checkCurates(u, list[0].Student.ID, list[0].Course.ID); err != nil {
		return err
	}
	if _, err := s.DB.Exec(`UPDATE questions SET answer = ?, status = 'answered', answered_by = ?, answered_at = ? WHERE id = ?`,
		strings.TrimSpace(in.Text), u.ID, db.Now(), id); err != nil {
		return err
	}
	list, err = s.questionsWhere(`q.id = ?`, id)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, list[0])
}
