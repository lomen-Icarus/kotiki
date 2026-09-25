package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"kotiki/backend/internal/db"
	"kotiki/backend/internal/steps"
)

// ======================= пользователи =======================

// GET /api/admin/users?role=&q=
func (s *Server) adminUsers(w http.ResponseWriter, r *http.Request) error {
	cond, args := "1 = 1", []any{}
	if role := r.URL.Query().Get("role"); role != "" {
		cond += " AND role = ?"
		args = append(args, role)
	}
	if q := strings.TrimSpace(r.URL.Query().Get("q")); q != "" {
		cond += " AND (name LIKE ? OR name LIKE ? OR login LIKE ?)"
		args = append(args, "%"+q+"%", "%"+capitalize(q)+"%", "%"+q+"%")
	}
	rows, err := s.DB.Query(`SELECT id, name, login, role, COALESCE(grade, ''), last_seen_at FROM users WHERE `+cond+` ORDER BY role, name`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	type item struct {
		User
		LastSeenAt *string `json:"last_seen_at"`
	}
	list := []item{}
	for rows.Next() {
		var it item
		var seen sql.NullString
		if err := rows.Scan(&it.ID, &it.Name, &it.Login, &it.Role, &it.Grade, &seen); err != nil {
			return err
		}
		it.LastSeenAt = nullStr(seen)
		list = append(list, it)
	}
	return writeJSON(w, 200, list)
}

type userInput struct {
	Name     *string `json:"name"`
	Login    *string `json:"login"`
	Password *string `json:"password"`
	Role     *string `json:"role"`
}

func validRole(role string) bool { return role == "student" || role == "curator" || role == "admin" }

// POST /api/admin/users
func (s *Server) adminCreateUser(w http.ResponseWriter, r *http.Request) error {
	var in userInput
	if err := readJSON(r, &in); err != nil {
		return err
	}
	if in.Name == nil || in.Login == nil || in.Password == nil || in.Role == nil ||
		strings.TrimSpace(*in.Name) == "" || strings.TrimSpace(*in.Login) == "" || len(*in.Password) < 4 {
		return errBadRequest("нужны name, login, password (от 4 символов) и role")
	}
	if !validRole(*in.Role) {
		return errBadRequest("role: student, curator или admin")
	}
	hash, err := HashPassword(*in.Password)
	if err != nil {
		return err
	}
	res, err := s.DB.Exec(`INSERT INTO users (name, login, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)`,
		strings.TrimSpace(*in.Name), strings.TrimSpace(*in.Login), hash, *in.Role, db.Now())
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return errConflict("логин уже занят")
		}
		return err
	}
	id, _ := res.LastInsertId()
	return writeJSON(w, 201, User{ID: id, Name: *in.Name, Login: *in.Login, Role: *in.Role})
}

// PATCH /api/admin/users/{id}
func (s *Server) adminUpdateUser(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in userInput
	if err := readJSON(r, &in); err != nil {
		return err
	}
	if in.Role != nil && !validRole(*in.Role) {
		return errBadRequest("role: student, curator или admin")
	}
	sets, args := []string{}, []any{}
	if in.Name != nil {
		sets, args = append(sets, "name = ?"), append(args, strings.TrimSpace(*in.Name))
	}
	if in.Login != nil {
		sets, args = append(sets, "login = ?"), append(args, strings.TrimSpace(*in.Login))
	}
	if in.Role != nil {
		sets, args = append(sets, "role = ?"), append(args, *in.Role)
	}
	if in.Password != nil {
		hash, err := HashPassword(*in.Password)
		if err != nil {
			return err
		}
		sets, args = append(sets, "password_hash = ?"), append(args, hash)
	}
	if len(sets) > 0 {
		if _, err := s.DB.Exec(`UPDATE users SET `+strings.Join(sets, ", ")+` WHERE id = ?`, append(args, id)...); err != nil {
			if strings.Contains(err.Error(), "UNIQUE") {
				return errConflict("логин уже занят")
			}
			return err
		}
	}
	var u User
	if err := s.DB.QueryRow(`SELECT id, name, login, role FROM users WHERE id = ?`, id).Scan(&u.ID, &u.Name, &u.Login, &u.Role); err != nil {
		return err
	}
	return writeJSON(w, 200, u)
}

// DELETE /api/admin/users/{id}
func (s *Server) adminDeleteUser(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	if id == currentUser(r).ID {
		return errBadRequest("нельзя удалить самого себя")
	}
	if _, err := s.DB.Exec(`DELETE FROM users WHERE id = ?`, id); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// ======================= курсы =======================

// GET /api/admin/courses — все курсы, включая черновики.
func (s *Server) adminCourses(w http.ResponseWriter, r *http.Request) error {
	rows, err := s.DB.Query(`
		SELECT c.id, c.title, c.short_description, c.tool, c.tool_name, c.grade_from, c.grade_to, c.volume, c.cover_url, c.status, ` + countsSQL + `,
		       (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id)
		FROM courses c WHERE c.status != 'archived' ORDER BY c.id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type item struct {
		courseCard
		StudentsCount int `json:"students_count"`
	}
	list := []item{}
	for rows.Next() {
		var it item
		var cover sql.NullString
		if err := rows.Scan(&it.ID, &it.Title, &it.ShortDescription, &it.Tool, &it.ToolName, &it.Grades.From, &it.Grades.To,
			&it.Volume, &cover, &it.Status, &it.ModulesCount, &it.StepsCount, &it.StudentsCount); err != nil {
			return err
		}
		it.CoverURL = nullStr(cover)
		list = append(list, it)
	}
	return writeJSON(w, 200, list)
}

type courseInput struct {
	Title            *string `json:"title"`
	ShortDescription *string `json:"short_description"`
	DescriptionMD    *string `json:"description_md"`
	Goal             *string `json:"goal"`
	Tool             *string `json:"tool"`
	ToolName         *string `json:"tool_name"`
	Grades           *Grades `json:"grades"`
	Volume           *string `json:"volume"`
	CoverURL         *string `json:"cover_url"`
}

func (in courseInput) sets() ([]string, []any, error) {
	var sets []string
	var args []any
	add := func(col string, v *string) {
		if v != nil {
			sets, args = append(sets, col+" = ?"), append(args, strings.TrimSpace(*v))
		}
	}
	if in.Title != nil && strings.TrimSpace(*in.Title) == "" {
		return nil, nil, errBadRequest("title: название не может быть пустым")
	}
	add("title", in.Title)
	add("short_description", in.ShortDescription)
	add("description_md", in.DescriptionMD)
	add("goal", in.Goal)
	add("tool", in.Tool)
	add("tool_name", in.ToolName)
	add("volume", in.Volume)
	add("cover_url", in.CoverURL)
	if in.Grades != nil {
		if in.Grades.From < 1 || in.Grades.To > 11 || in.Grades.From > in.Grades.To {
			return nil, nil, errBadRequest("grades: from и to от 1 до 11, from ≤ to")
		}
		sets = append(sets, "grade_from = ?", "grade_to = ?")
		args = append(args, in.Grades.From, in.Grades.To)
	}
	return sets, args, nil
}

// POST /api/admin/courses — создаёт черновик.
func (s *Server) adminCreateCourse(w http.ResponseWriter, r *http.Request) error {
	var in courseInput
	if err := readJSON(r, &in); err != nil {
		return err
	}
	if in.Title == nil {
		return errBadRequest("title: обязательное поле")
	}
	now := db.Now()
	res, err := s.DB.Exec(`INSERT INTO courses (title, created_at, updated_at) VALUES (?, ?, ?)`, *in.Title, now, now)
	if err != nil {
		return err
	}
	id, _ := res.LastInsertId()
	if err := s.applyCourse(id, in); err != nil {
		return err
	}
	return s.writeAdminCourse(w, 201, id)
}

func (s *Server) applyCourse(id int64, in courseInput) error {
	sets, args, err := in.sets()
	if err != nil {
		return err
	}
	sets, args = append(sets, "updated_at = ?"), append(args, db.Now())
	_, err = s.DB.Exec(`UPDATE courses SET `+strings.Join(sets, ", ")+` WHERE id = ?`, append(args, id)...)
	return err
}

// GET /api/admin/courses/{id} — курс целиком, со скрытыми настройками проверки.
func (s *Server) adminCourse(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	return s.writeAdminCourse(w, 200, id)
}

type adminStepJSON struct {
	ID        int64           `json:"id"`
	ModuleID  int64           `json:"module_id"`
	Position  int             `json:"position"`
	Type      string          `json:"type"`
	Title     string          `json:"title"`
	CheckMode string          `json:"check_mode"`
	MaxScore  int             `json:"max_score"`
	Content   json.RawMessage `json:"content"`
	Check     json.RawMessage `json:"check"`
}

func toAdminStep(st stepRow) adminStepJSON {
	return adminStepJSON{ID: st.ID, ModuleID: st.ModuleID, Position: st.Position, Type: st.Type, Title: st.Title,
		CheckMode: st.CheckMode(), MaxScore: st.MaxScore, Content: st.Content, Check: st.Check}
}

func (s *Server) writeAdminCourse(w http.ResponseWriter, status int, id int64) error {
	c, err := s.loadCourse(id)
	if err != nil {
		return err
	}
	mods, err := s.loadOutline(id)
	if err != nil {
		return err
	}
	type mod struct {
		ID       int64           `json:"id"`
		Position int             `json:"position"`
		Title    string          `json:"title"`
		Steps    []adminStepJSON `json:"steps"`
	}
	out := []mod{}
	for _, m := range mods {
		mm := mod{ID: m.ID, Position: m.Position, Title: m.Title, Steps: []adminStepJSON{}}
		for _, st := range m.Steps {
			mm.Steps = append(mm.Steps, toAdminStep(st))
		}
		out = append(out, mm)
	}
	return writeJSON(w, status, map[string]any{"course": c, "modules": out})
}

// PATCH /api/admin/courses/{id} — работает и для опубликованного курса: правки видны сразу.
func (s *Server) adminUpdateCourse(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	if _, err := s.loadCourse(id); err != nil {
		return err
	}
	var in courseInput
	if err := readJSON(r, &in); err != nil {
		return err
	}
	if err := s.applyCourse(id, in); err != nil {
		return err
	}
	return s.writeAdminCourse(w, 200, id)
}

func (s *Server) setCourseStatus(w http.ResponseWriter, r *http.Request, status string) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	if _, err := s.loadCourse(id); err != nil {
		return err
	}
	if status == "published" {
		mods, err := s.loadOutline(id)
		if err != nil {
			return err
		}
		if len(flatSteps(mods)) == 0 {
			return errBadRequest("нельзя опубликовать пустой курс — добавьте хотя бы один шаг")
		}
		_, err = s.DB.Exec(`UPDATE courses SET status = ?, published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?`,
			status, db.Now(), db.Now(), id)
		if err != nil {
			return err
		}
	} else if _, err := s.DB.Exec(`UPDATE courses SET status = ?, updated_at = ? WHERE id = ?`, status, db.Now(), id); err != nil {
		return err
	}
	return s.writeAdminCourse(w, 200, id)
}

func (s *Server) adminPublish(w http.ResponseWriter, r *http.Request) error {
	return s.setCourseStatus(w, r, "published")
}
func (s *Server) adminUnpublish(w http.ResponseWriter, r *http.Request) error {
	return s.setCourseStatus(w, r, "draft")
}

// DELETE /api/admin/courses/{id} — в архив; с ?hard=1 — удалить навсегда вместе
// с модулями, шагами, сдачами, вопросами и назначениями.
func (s *Server) adminArchiveCourse(w http.ResponseWriter, r *http.Request) error {
	if r.URL.Query().Get("hard") != "1" {
		return s.setCourseStatus(w, r, "archived")
	}
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	res, err := s.DB.Exec(`DELETE FROM courses WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errNotFound("курс не найден")
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) touchCourse(courseID int64) {
	_, _ = s.DB.Exec(`UPDATE courses SET updated_at = ? WHERE id = ?`, db.Now(), courseID)
}

// ======================= модули =======================

func (s *Server) moduleCourse(moduleID int64) (int64, error) {
	var courseID int64
	err := s.DB.QueryRow(`SELECT course_id FROM modules WHERE id = ? AND archived = 0`, moduleID).Scan(&courseID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, errNotFound("модуль не найден")
	}
	return courseID, err
}

// POST /api/admin/courses/{id}/modules
func (s *Server) adminCreateModule(w http.ResponseWriter, r *http.Request) error {
	courseID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	if _, err := s.loadCourse(courseID); err != nil {
		return err
	}
	var in struct {
		Title string `json:"title"`
	}
	if err := readJSON(r, &in); err != nil {
		return err
	}
	if strings.TrimSpace(in.Title) == "" {
		return errBadRequest("title: обязательное поле")
	}
	res, err := s.DB.Exec(`INSERT INTO modules (course_id, position, title)
		VALUES (?, (SELECT COALESCE(MAX(position), 0) + 1 FROM modules WHERE course_id = ?), ?)`,
		courseID, courseID, strings.TrimSpace(in.Title))
	if err != nil {
		return err
	}
	id, _ := res.LastInsertId()
	s.touchCourse(courseID)
	return writeJSON(w, 201, map[string]any{"id": id, "course_id": courseID, "title": strings.TrimSpace(in.Title)})
}

// PATCH /api/admin/modules/{id}
func (s *Server) adminUpdateModule(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	courseID, err := s.moduleCourse(id)
	if err != nil {
		return err
	}
	var in struct {
		Title string `json:"title"`
	}
	if err := readJSON(r, &in); err != nil {
		return err
	}
	if strings.TrimSpace(in.Title) == "" {
		return errBadRequest("title: обязательное поле")
	}
	if _, err := s.DB.Exec(`UPDATE modules SET title = ? WHERE id = ?`, strings.TrimSpace(in.Title), id); err != nil {
		return err
	}
	s.touchCourse(courseID)
	return writeJSON(w, 200, map[string]any{"id": id, "course_id": courseID, "title": strings.TrimSpace(in.Title)})
}

// DELETE /api/admin/modules/{id} — если по шагам модуля уже есть сдачи, модуль уходит в архив.
func (s *Server) adminDeleteModule(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	courseID, err := s.moduleCourse(id)
	if err != nil {
		return err
	}
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM submissions sb JOIN steps st ON st.id = sb.step_id WHERE st.module_id = ?`, id).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		_, err = s.DB.Exec(`UPDATE modules SET archived = 1 WHERE id = ?`, id)
	} else {
		_, err = s.DB.Exec(`DELETE FROM modules WHERE id = ?`, id)
	}
	if err != nil {
		return err
	}
	s.touchCourse(courseID)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// reorder проставляет position по порядку ids, проверив, что все id принадлежат родителю.
func (s *Server) reorder(table, parentCol string, parentID int64, ids []int64) error {
	if len(ids) == 0 {
		return errBadRequest("ids: пустой список")
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for i, id := range ids {
		res, err := tx.Exec(`UPDATE `+table+` SET position = ? WHERE id = ? AND `+parentCol+` = ?`, i+1, id, parentID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return errBadRequest("ids: элемент " + itoa(id) + " не относится к этому родителю")
		}
	}
	return tx.Commit()
}

// PUT /api/admin/courses/{id}/modules/order
func (s *Server) adminOrderModules(w http.ResponseWriter, r *http.Request) error {
	courseID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		IDs []int64 `json:"ids"`
	}
	if err := readJSON(r, &in); err != nil {
		return err
	}
	if err := s.reorder("modules", "course_id", courseID, in.IDs); err != nil {
		return err
	}
	s.touchCourse(courseID)
	return s.writeAdminCourse(w, 200, courseID)
}

// ======================= шаги =======================

// DefaultScore — баллы за шаг по умолчанию: чем сложнее шаг, тем больше.
var DefaultScore = map[string]int{"theory": 1, "quiz": 2, "scratch": 3, "minecraft": 3, "code": 3, "project": 5}

// defaultScore — баллы по умолчанию; для типов, добавленных администратором, — 2.
func defaultScore(typ string) int {
	if v, ok := DefaultScore[typ]; ok {
		return v
	}
	return 2
}

// GET /api/admin/step-types — справочник для конструктора: типы шагов и поля способов проверки.
func (s *Server) adminStepTypes(w http.ResponseWriter, r *http.Request) error {
	type mode struct {
		Mode         string        `json:"mode"`
		Title        string        `json:"title"`
		ConfigFields []steps.Field `json:"check_fields"`
	}
	type item struct {
		steps.Type
		DefaultScore int    `json:"default_score"`
		Modes        []mode `json:"modes"`
	}
	list := []item{}
	for _, t := range steps.AllTypes() {
		it := item{Type: t, DefaultScore: defaultScore(t.Name)}
		for _, m := range t.CheckModes {
			ch := steps.Checkers[m]
			fields := ch.ConfigFields()
			if fields == nil {
				fields = []steps.Field{}
			}
			it.Modes = append(it.Modes, mode{Mode: m, Title: ch.Title(), ConfigFields: fields})
		}
		list = append(list, it)
	}
	return writeJSON(w, 200, list)
}

type stepInput struct {
	Type     *string         `json:"type"`
	Title    *string         `json:"title"`
	MaxScore *int            `json:"max_score"`
	Content  json.RawMessage `json:"content"`
	Check    json.RawMessage `json:"check"`
}

// POST /api/admin/modules/{id}/steps
func (s *Server) adminCreateStep(w http.ResponseWriter, r *http.Request) error {
	moduleID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	courseID, err := s.moduleCourse(moduleID)
	if err != nil {
		return err
	}
	var in stepInput
	if err := readJSON(r, &in); err != nil {
		return err
	}
	if in.Type == nil || in.Title == nil || strings.TrimSpace(*in.Title) == "" {
		return errBadRequest("нужны type и title")
	}
	if len(in.Content) == 0 {
		in.Content = json.RawMessage("{}")
	}
	if len(in.Check) == 0 {
		in.Check = json.RawMessage("{}")
	}
	if err := steps.Validate(*in.Type, in.Content, in.Check); err != nil {
		return errBadRequest(err.Error())
	}
	score := defaultScore(*in.Type)
	if in.MaxScore != nil {
		score = max(*in.MaxScore, 0)
	}
	id, err := InsertStep(s.DB, moduleID, *in.Type, strings.TrimSpace(*in.Title), in.Content, in.Check, score)
	if err != nil {
		return err
	}
	s.touchCourse(courseID)
	st, _, err := s.loadStep(id)
	if err != nil {
		return err
	}
	return writeJSON(w, 201, toAdminStep(st))
}

// InsertStep добавляет шаг в конец модуля. Используется и конструктором, и начальными данными.
func InsertStep(conn *sql.DB, moduleID int64, typ, title string, content, check json.RawMessage, score int) (int64, error) {
	now := db.Now()
	res, err := conn.Exec(`INSERT INTO steps (module_id, position, type, title, content, check_json, max_score, created_at, updated_at)
		VALUES (?, (SELECT COALESCE(MAX(position), 0) + 1 FROM steps WHERE module_id = ?), ?, ?, ?, ?, ?, ?, ?)`,
		moduleID, moduleID, typ, title, string(content), string(check), score, now, now)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// GET /api/admin/steps/{id}
func (s *Server) adminStep(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	st, _, err := s.loadStep(id)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, toAdminStep(st))
}

// PATCH /api/admin/steps/{id} — можно менять и в опубликованном курсе. Старые сдачи сохраняются.
func (s *Server) adminUpdateStep(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	st, courseID, err := s.loadStep(id)
	if err != nil {
		return err
	}
	var in stepInput
	if err := readJSON(r, &in); err != nil {
		return err
	}
	if in.Type != nil {
		st.Type = *in.Type
	}
	if in.Title != nil {
		if strings.TrimSpace(*in.Title) == "" {
			return errBadRequest("title: не может быть пустым")
		}
		st.Title = strings.TrimSpace(*in.Title)
	}
	if in.MaxScore != nil {
		st.MaxScore = max(*in.MaxScore, 0)
	}
	if len(in.Content) > 0 {
		st.Content = in.Content
	}
	if len(in.Check) > 0 {
		st.Check = in.Check
	}
	if err := steps.Validate(st.Type, st.Content, st.Check); err != nil {
		return errBadRequest(err.Error())
	}
	if _, err := s.DB.Exec(`UPDATE steps SET type = ?, title = ?, max_score = ?, content = ?, check_json = ?, updated_at = ? WHERE id = ?`,
		st.Type, st.Title, st.MaxScore, string(st.Content), string(st.Check), db.Now(), id); err != nil {
		return err
	}
	s.touchCourse(courseID)
	st, _, err = s.loadStep(id)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, toAdminStep(st))
}

// DELETE /api/admin/steps/{id} — шаг с историей сдач уходит в архив, чтобы не потерять работы учеников.
func (s *Server) adminDeleteStep(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	_, courseID, err := s.loadStep(id)
	if err != nil {
		return err
	}
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM submissions WHERE step_id = ?`, id).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		_, err = s.DB.Exec(`UPDATE steps SET archived = 1, updated_at = ? WHERE id = ?`, db.Now(), id)
	} else {
		_, err = s.DB.Exec(`DELETE FROM steps WHERE id = ?`, id)
	}
	if err != nil {
		return err
	}
	s.touchCourse(courseID)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// PUT /api/admin/modules/{id}/steps/order
func (s *Server) adminOrderSteps(w http.ResponseWriter, r *http.Request) error {
	moduleID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	courseID, err := s.moduleCourse(moduleID)
	if err != nil {
		return err
	}
	var in struct {
		IDs []int64 `json:"ids"`
	}
	if err := readJSON(r, &in); err != nil {
		return err
	}
	if err := s.reorder("steps", "module_id", moduleID, in.IDs); err != nil {
		return err
	}
	s.touchCourse(courseID)
	return s.writeAdminCourse(w, 200, courseID)
}

// POST /api/admin/steps/{id}/preview-check — как сработает автопроверка на этом ответе (без сохранения).
func (s *Server) adminPreviewCheck(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	st, _, err := s.loadStep(id)
	if err != nil {
		return err
	}
	var in struct {
		Answer json.RawMessage `json:"answer"`
	}
	if err := readJSON(r, &in); err != nil {
		return err
	}
	if len(in.Answer) == 0 {
		in.Answer = json.RawMessage("{}")
	}
	ch, ok := steps.Checkers[st.CheckMode()]
	if !ok {
		return errBadRequest("у шага неизвестный способ проверки")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	res, err := ch.Check(ctx, st.Content, st.Check, in.Answer)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, map[string]any{"status": res.Status, "hint": res.Hint, "tests": res.Tests})
}

// ======================= назначения =======================

type enrollmentJSON struct {
	ID        int64   `json:"id"`
	Course    IDTitle `json:"course"`
	Student   IDName  `json:"student"`
	Curator   *IDName `json:"curator"`
	CreatedAt string  `json:"created_at"`
}

func (s *Server) enrollmentsWhere(cond string, args ...any) ([]enrollmentJSON, error) {
	rows, err := s.DB.Query(`
		SELECT e.id, c.id, c.title, stu.id, stu.name, cu.id, cu.name, e.created_at
		FROM enrollments e JOIN courses c ON c.id = e.course_id JOIN users stu ON stu.id = e.student_id
		LEFT JOIN users cu ON cu.id = e.curator_id
		WHERE `+cond+` ORDER BY c.id, stu.name`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []enrollmentJSON{}
	for rows.Next() {
		var e enrollmentJSON
		var cuID sql.NullInt64
		var cuName sql.NullString
		if err := rows.Scan(&e.ID, &e.Course.ID, &e.Course.Title, &e.Student.ID, &e.Student.Name, &cuID, &cuName, &e.CreatedAt); err != nil {
			return nil, err
		}
		if cuID.Valid {
			e.Curator = &IDName{cuID.Int64, cuName.String}
		}
		list = append(list, e)
	}
	return list, rows.Err()
}

// GET /api/admin/enrollments?course_id=&curator_id=&student_id=
func (s *Server) adminEnrollments(w http.ResponseWriter, r *http.Request) error {
	cond, args := "1 = 1", []any{}
	for param, col := range map[string]string{"course_id": "e.course_id", "curator_id": "e.curator_id", "student_id": "e.student_id"} {
		if v := queryInt(r, param, 0); v > 0 {
			cond += " AND " + col + " = ?"
			args = append(args, v)
		}
	}
	list, err := s.enrollmentsWhere(cond, args...)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, list)
}

func (s *Server) checkRole(userID int64, role string) error {
	var got string
	err := s.DB.QueryRow(`SELECT role FROM users WHERE id = ?`, userID).Scan(&got)
	if errors.Is(err, sql.ErrNoRows) {
		return errBadRequest("пользователь " + itoa(userID) + " не найден")
	}
	if err != nil {
		return err
	}
	if got != role && !(role == "curator" && got == "admin") {
		return errBadRequest("пользователь " + itoa(userID) + " не " + role)
	}
	return nil
}

// POST /api/admin/enrollments — записать учеников на курс и назначить куратора.
// Если ученик уже записан, у него просто меняется куратор.
func (s *Server) adminEnroll(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		CourseID   int64   `json:"course_id"`
		CuratorID  *int64  `json:"curator_id"`
		StudentIDs []int64 `json:"student_ids"`
	}
	if err := readJSON(r, &in); err != nil {
		return err
	}
	if _, err := s.loadCourse(in.CourseID); err != nil {
		return err
	}
	if len(in.StudentIDs) == 0 {
		return errBadRequest("student_ids: выберите хотя бы одного ученика")
	}
	if in.CuratorID != nil {
		if err := s.checkRole(*in.CuratorID, "curator"); err != nil {
			return err
		}
	}
	for _, sid := range in.StudentIDs {
		if err := s.checkRole(sid, "student"); err != nil {
			return err
		}
		if _, err := s.DB.Exec(`INSERT INTO enrollments (course_id, student_id, curator_id, created_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (course_id, student_id) DO UPDATE SET curator_id = excluded.curator_id`,
			in.CourseID, sid, in.CuratorID, db.Now()); err != nil {
			return err
		}
	}
	list, err := s.enrollmentsWhere("e.course_id = ?", in.CourseID)
	if err != nil {
		return err
	}
	return writeJSON(w, 201, list)
}

// PATCH /api/admin/enrollments/{id} — сменить куратора.
func (s *Server) adminUpdateEnrollment(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		CuratorID *int64 `json:"curator_id"`
	}
	if err := readJSON(r, &in); err != nil {
		return err
	}
	if in.CuratorID != nil {
		if err := s.checkRole(*in.CuratorID, "curator"); err != nil {
			return err
		}
	}
	res, err := s.DB.Exec(`UPDATE enrollments SET curator_id = ? WHERE id = ?`, in.CuratorID, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errNotFound("назначение не найдено")
	}
	list, err := s.enrollmentsWhere("e.id = ?", id)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, list[0])
}

// DELETE /api/admin/enrollments/{id}
func (s *Server) adminDeleteEnrollment(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	if _, err := s.DB.Exec(`DELETE FROM enrollments WHERE id = ?`, id); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
