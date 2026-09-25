package api

import (
	"database/sql"
	"net/http"
	"strings"
)

type courseCard struct {
	ID               int64   `json:"id"`
	Title            string  `json:"title"`
	ShortDescription string  `json:"short_description"`
	Tool             string  `json:"tool"`
	ToolName         string  `json:"tool_name"`
	Grades           Grades  `json:"grades"`
	Volume           string  `json:"volume"`
	ModulesCount     int     `json:"modules_count"`
	StepsCount       int     `json:"steps_count"`
	CoverURL         *string `json:"cover_url"`
	Status           string  `json:"status,omitempty"`
}

// countsSQL — сколько модулей и шагов в курсе (без архивных).
const countsSQL = `
	(SELECT COUNT(*) FROM modules m WHERE m.course_id = c.id AND m.archived = 0),
	(SELECT COUNT(*) FROM steps st JOIN modules m ON m.id = st.module_id
	  WHERE m.course_id = c.id AND m.archived = 0 AND st.archived = 0)`

// GET /api/catalog?q=&tool=&grade=&page=&limit=
func (s *Server) catalog(w http.ResponseWriter, r *http.Request) error {
	where := []string{"c.status = 'published'"}
	var args []any
	q := r.URL.Query()
	if v := strings.TrimSpace(q.Get("q")); v != "" {
		// LOWER в SQLite не понимает кириллицу, поэтому ищем по двум вариантам регистра
		where = append(where, "(c.title LIKE ? OR c.title LIKE ? OR c.short_description LIKE ?)")
		args = append(args, "%"+v+"%", "%"+capitalize(v)+"%", "%"+v+"%")
	}
	if v := q.Get("tool"); v != "" {
		where = append(where, "c.tool = ?")
		args = append(args, v)
	}
	if g := queryInt(r, "grade", 0); g > 0 {
		where = append(where, "c.grade_from <= ? AND c.grade_to >= ?")
		args = append(args, g, g)
	}
	cond := strings.Join(where, " AND ")

	var total int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM courses c WHERE `+cond, args...).Scan(&total); err != nil {
		return err
	}
	limit, offset := paging(r)
	rows, err := s.DB.Query(`
		SELECT c.id, c.title, c.short_description, c.tool, c.tool_name, c.grade_from, c.grade_to, c.volume, c.cover_url, `+countsSQL+`
		FROM courses c WHERE `+cond+` ORDER BY c.grade_from, c.id LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []courseCard{}
	for rows.Next() {
		var c courseCard
		var cover sql.NullString
		if err := rows.Scan(&c.ID, &c.Title, &c.ShortDescription, &c.Tool, &c.ToolName, &c.Grades.From, &c.Grades.To,
			&c.Volume, &cover, &c.ModulesCount, &c.StepsCount); err != nil {
			return err
		}
		c.CoverURL = nullStr(cover)
		items = append(items, c)
	}
	return writeJSON(w, 200, map[string]any{"items": items, "total": total})
}

// GET /api/catalog/filters
func (s *Server) catalogFilters(w http.ResponseWriter, r *http.Request) error {
	rows, err := s.DB.Query(`SELECT tool, MIN(tool_name), COUNT(*), MIN(grade_from), MAX(grade_to)
		FROM courses WHERE status = 'published' GROUP BY tool ORDER BY MIN(grade_from)`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type tool struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Count int    `json:"count"`
	}
	tools := []tool{}
	lo, hi := 10, 0
	for rows.Next() {
		var t tool
		var from, to int
		if err := rows.Scan(&t.ID, &t.Name, &t.Count, &from, &to); err != nil {
			return err
		}
		tools = append(tools, t)
		lo, hi = min(lo, from), max(hi, to)
	}
	grades := []int{}
	for g := lo; g <= hi; g++ {
		grades = append(grades, g)
	}
	return writeJSON(w, 200, map[string]any{"tools": tools, "grades": grades})
}

type outlineStep struct {
	ID        int64  `json:"id"`
	Position  int    `json:"position"`
	Title     string `json:"title"`
	Type      string `json:"type"`
	CheckMode string `json:"check_mode"`
	MaxScore  int    `json:"max_score"`
	Status    string `json:"status,omitempty"`
}

type outlineModule struct {
	ID       int64         `json:"id"`
	Position int           `json:"position"`
	Title    string        `json:"title"`
	Steps    []outlineStep `json:"steps"`
}

// GET /api/courses/{id} — паспорт и программа курса. С токеном ученика — ещё и его статусы.
func (s *Server) coursePage(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	c, err := s.loadCourse(id)
	if err != nil {
		return err
	}
	user := s.optionalUser(r)
	if c.Status != "published" && (user == nil || user.Role == "student") {
		return errNotFound("курс не найден")
	}
	mods, err := s.loadOutline(id)
	if err != nil {
		return err
	}

	resp := map[string]any{
		"id": c.ID, "title": c.Title, "short_description": c.ShortDescription, "description_md": c.DescriptionMD,
		"goal": c.Goal, "tool": c.Tool, "tool_name": c.ToolName, "grades": c.Grades, "volume": c.Volume,
		"cover_url": c.CoverURL, "status": c.Status, "enrolled": false,
	}
	var states map[int64]*stepState
	if user != nil && user.Role == "student" {
		var n int
		_ = s.DB.QueryRow(`SELECT COUNT(*) FROM enrollments WHERE course_id = ? AND student_id = ?`, id, user.ID).Scan(&n)
		if n > 0 {
			if states, err = s.studentStates(user.ID, id); err != nil {
				return err
			}
			sum := summarize(mods, states)
			resp["enrolled"] = true
			resp["progress"] = sum.Progress
			resp["score"] = sum.Score
			resp["next_step"] = sum.NextStep
		}
	}
	outline := make([]outlineModule, 0, len(mods))
	for _, m := range mods {
		om := outlineModule{ID: m.ID, Position: m.Position, Title: m.Title, Steps: []outlineStep{}}
		for _, st := range m.Steps {
			os := outlineStep{ID: st.ID, Position: st.Position, Title: st.Title, Type: st.Type,
				CheckMode: st.CheckMode(), MaxScore: st.MaxScore}
			if states != nil {
				os.Status = statusOf(states, st.ID)
			}
			om.Steps = append(om.Steps, os)
		}
		outline = append(outline, om)
	}
	resp["modules"] = outline
	return writeJSON(w, 200, resp)
}

func capitalize(s string) string {
	r := []rune(s)
	if len(r) == 0 {
		return s
	}
	return strings.ToUpper(string(r[0])) + string(r[1:])
}
