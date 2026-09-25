package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"time"

	"kotiki/backend/internal/steps"
)

// Здесь собрана вся логика прогресса, рейтинга и сигналов отставания.
// Прогресс считается по таблице submissions: ручная и автоматическая проверка
// попадают туда одинаково, поэтому влияют на прогресс наравне (требование кейса).

type Progress struct {
	Done    int `json:"done"`
	Total   int `json:"total"`
	Percent int `json:"percent"`
}

type Score struct {
	Value int `json:"value"`
	Max   int `json:"max"`
}

type StepRef struct {
	ID          int64  `json:"id"`
	Title       string `json:"title"`
	Type        string `json:"type,omitempty"`
	ModuleTitle string `json:"module_title,omitempty"`
}

type IDName struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type IDTitle struct {
	ID    int64  `json:"id"`
	Title string `json:"title"`
	Tool  string `json:"tool,omitempty"`
}

// ---------- курс и его структура ----------

type course struct {
	ID               int64   `json:"id"`
	Title            string  `json:"title"`
	ShortDescription string  `json:"short_description"`
	DescriptionMD    string  `json:"description_md"`
	Goal             string  `json:"goal"`
	Tool             string  `json:"tool"`
	ToolName         string  `json:"tool_name"`
	Grades           Grades  `json:"grades"`
	Volume           string  `json:"volume"`
	CoverURL         *string `json:"cover_url"`
	Status           string  `json:"status"`
	UpdatedAt        string  `json:"updated_at"`
	PublishedAt      *string `json:"published_at"`
}

type Grades struct {
	From int `json:"from"`
	To   int `json:"to"`
}

const courseCols = `id, title, short_description, description_md, goal, tool, tool_name, grade_from, grade_to,
	volume, cover_url, status, updated_at, published_at`

func scanCourse(row interface{ Scan(...any) error }) (course, error) {
	var c course
	var cover, published sql.NullString
	err := row.Scan(&c.ID, &c.Title, &c.ShortDescription, &c.DescriptionMD, &c.Goal, &c.Tool, &c.ToolName,
		&c.Grades.From, &c.Grades.To, &c.Volume, &cover, &c.Status, &c.UpdatedAt, &published)
	c.CoverURL, c.PublishedAt = nullStr(cover), nullStr(published)
	return c, err
}

func (s *Server) loadCourse(id int64) (course, error) {
	c, err := scanCourse(s.DB.QueryRow(`SELECT `+courseCols+` FROM courses WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return c, errNotFound("курс не найден")
	}
	return c, err
}

type stepRow struct {
	ID          int64
	ModuleID    int64
	ModuleTitle string
	Position    int
	Type        string
	Title       string
	Content     json.RawMessage
	Check       json.RawMessage
	MaxScore    int
}

func (st stepRow) CheckMode() string { return steps.ModeOf(st.Check) }

type moduleRow struct {
	ID       int64
	Position int
	Title    string
	Steps    []stepRow
}

// loadOutline — модули и шаги курса по порядку (без архивных).
func (s *Server) loadOutline(courseID int64) ([]moduleRow, error) {
	rows, err := s.DB.Query(`SELECT id, position, title FROM modules WHERE course_id = ? AND archived = 0 ORDER BY position, id`, courseID)
	if err != nil {
		return nil, err
	}
	var mods []moduleRow
	idx := map[int64]int{}
	for rows.Next() {
		var m moduleRow
		if err := rows.Scan(&m.ID, &m.Position, &m.Title); err != nil {
			rows.Close()
			return nil, err
		}
		idx[m.ID] = len(mods)
		mods = append(mods, m)
	}
	rows.Close()

	srows, err := s.DB.Query(`
		SELECT st.id, st.module_id, st.position, st.type, st.title, st.content, st.check_json, st.max_score
		FROM steps st JOIN modules m ON m.id = st.module_id
		WHERE m.course_id = ? AND m.archived = 0 AND st.archived = 0
		ORDER BY st.position, st.id`, courseID)
	if err != nil {
		return nil, err
	}
	defer srows.Close()
	for srows.Next() {
		var st stepRow
		var content, check string
		if err := srows.Scan(&st.ID, &st.ModuleID, &st.Position, &st.Type, &st.Title, &content, &check, &st.MaxScore); err != nil {
			return nil, err
		}
		st.Content, st.Check = json.RawMessage(content), json.RawMessage(check)
		if i, ok := idx[st.ModuleID]; ok {
			st.ModuleTitle = mods[i].Title
			mods[i].Steps = append(mods[i].Steps, st)
		}
	}
	return mods, srows.Err()
}

func flatSteps(mods []moduleRow) []stepRow {
	var all []stepRow
	for _, m := range mods {
		all = append(all, m.Steps...)
	}
	return all
}

// loadStep — один шаг вместе с id курса.
func (s *Server) loadStep(id int64) (stepRow, int64, error) {
	var st stepRow
	var courseID int64
	var content, check string
	err := s.DB.QueryRow(`
		SELECT st.id, st.module_id, m.title, st.position, st.type, st.title, st.content, st.check_json, st.max_score, m.course_id
		FROM steps st JOIN modules m ON m.id = st.module_id WHERE st.id = ? AND st.archived = 0`, id).
		Scan(&st.ID, &st.ModuleID, &st.ModuleTitle, &st.Position, &st.Type, &st.Title, &content, &check, &st.MaxScore, &courseID)
	if err == sql.ErrNoRows {
		return st, 0, errNotFound("шаг не найден")
	}
	st.Content, st.Check = json.RawMessage(content), json.RawMessage(check)
	return st, courseID, err
}

// ---------- состояние ученика по шагам ----------

type stepState struct {
	Status       string // not_started | passed | failed | pending | returned
	Score        int
	Attempts     int
	FailsInRow   int // неудачные попытки подряд после последнего успеха
	LastAt       string
	ReturnedAt   string
	CheckSource  string
	LastFeedback *string
}

// studentStates — состояние каждого шага курса для ученика.
// Правило: если шаг хоть раз зачтён — он зачтён (засчитывается лучший балл);
// иначе статус берётся из последней попытки.
func (s *Server) studentStates(studentID, courseID int64) (map[int64]*stepState, error) {
	rows, err := s.DB.Query(`
		SELECT sb.step_id, sb.status, sb.score, sb.check_source, sb.feedback, sb.created_at, sb.reviewed_at
		FROM submissions sb JOIN steps st ON st.id = sb.step_id JOIN modules m ON m.id = st.module_id
		WHERE sb.student_id = ? AND m.course_id = ?
		ORDER BY sb.id`, studentID, courseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	res := map[int64]*stepState{}
	for rows.Next() {
		var stepID int64
		var status, source, created string
		var score sql.NullInt64
		var feedback, reviewed sql.NullString
		if err := rows.Scan(&stepID, &status, &score, &source, &feedback, &created, &reviewed); err != nil {
			return nil, err
		}
		st := res[stepID]
		if st == nil {
			st = &stepState{}
			res[stepID] = st
		}
		st.Attempts++
		st.LastAt = created
		if feedback.Valid {
			st.LastFeedback = &feedback.String
		}
		if status == "passed" {
			if st.Status != "passed" || int(score.Int64) > st.Score {
				st.Score = int(score.Int64)
				st.CheckSource = source
			}
			st.Status = "passed"
			st.FailsInRow = 0
			continue
		}
		if st.Status == "passed" {
			continue // уже зачтено, новая неудачная попытка не отнимает результат
		}
		st.Status = status
		st.CheckSource = source
		if status == "failed" {
			st.FailsInRow++
		}
		if status == "returned" && reviewed.Valid {
			st.ReturnedAt = reviewed.String
		}
	}
	return res, rows.Err()
}

func statusOf(states map[int64]*stepState, stepID int64) string {
	if st := states[stepID]; st != nil {
		return st.Status
	}
	return "not_started"
}

// courseSummary — сводка по курсу для ученика.
type courseSummary struct {
	Progress      Progress
	Score         Score
	NextStep      *StepRef
	PendingCount  int
	ReturnedCount int
	LastActivity  string
	FailsOnNext   int
	StaleReturned bool
}

func summarize(mods []moduleRow, states map[int64]*stepState) courseSummary {
	var sum courseSummary
	var firstPending *StepRef
	for _, st := range flatSteps(mods) {
		sum.Progress.Total++
		sum.Score.Max += st.MaxScore
		state := states[st.ID]
		status := statusOf(states, st.ID)
		if state != nil {
			sum.Score.Value += state.Score
			if state.LastAt > sum.LastActivity {
				sum.LastActivity = state.LastAt
			}
		}
		switch status {
		case "passed":
			sum.Progress.Done++
			continue
		case "pending":
			sum.PendingCount++
			if firstPending == nil {
				firstPending = &StepRef{ID: st.ID, Title: st.Title, Type: st.Type, ModuleTitle: st.ModuleTitle}
			}
			continue // работа у куратора — не блокирует следующий шаг
		case "returned":
			sum.ReturnedCount++
			if state.ReturnedAt != "" && olderThan(state.ReturnedAt, 48*time.Hour) {
				sum.StaleReturned = true
			}
		}
		if sum.NextStep == nil {
			sum.NextStep = &StepRef{ID: st.ID, Title: st.Title, Type: st.Type, ModuleTitle: st.ModuleTitle}
			if state != nil {
				sum.FailsOnNext = state.FailsInRow
			}
		}
	}
	if sum.NextStep == nil {
		sum.NextStep = firstPending
	}
	if sum.Progress.Total > 0 {
		sum.Progress.Percent = int(math.Round(float64(sum.Progress.Done) * 100 / float64(sum.Progress.Total)))
	}
	return sum
}

// ---------- сигнал отставания ----------

// risk определяет, нужно ли куратору обратить внимание на ученика.
// Смысл: поймать отставание до того, как ученик перестанет заходить, поэтому
// кроме «давно не заходил» смотрим на ранние признаки — застрял на шаге,
// отстаёт от группы, не исправил возвращённую работу.
func risk(daysInactive float64, percent int, groupAvg float64, failsOnNext int, staleReturned bool) (string, []string) {
	level := 0
	var reasons []string
	raise := func(l int, reason string) {
		level = max(level, l)
		reasons = append(reasons, reason)
	}
	switch {
	case daysInactive >= 7:
		raise(2, fmt.Sprintf("Не заходил %d дн.", int(daysInactive)))
	case daysInactive >= 3:
		raise(1, fmt.Sprintf("Не заходил %d дн.", int(daysInactive)))
	}
	if failsOnNext >= 5 {
		raise(2, fmt.Sprintf("%d неудачных попыток подряд на текущем шаге", failsOnNext))
	} else if failsOnNext >= 3 {
		raise(1, fmt.Sprintf("%d неудачные попытки подряд на текущем шаге", failsOnNext))
	}
	if gap := groupAvg - float64(percent); gap >= 25 {
		raise(1, fmt.Sprintf("Отстаёт от группы на %d%%", int(gap)))
	}
	if staleReturned {
		raise(1, "Не исправил возвращённую работу больше 2 дней")
	}
	if level == 1 && len(reasons) >= 3 {
		level = 2 // несколько тревожных признаков сразу — это уже серьёзно
	}
	return [...]string{"ok", "warning", "danger"}[level], reasons
}

var riskLabels = map[string]string{"ok": "В графике", "warning": "Замедлился", "danger": "Выпадает"}

func olderThan(ts string, d time.Duration) bool {
	t, err := time.Parse(time.RFC3339, ts)
	return err == nil && time.Since(t) > d
}

func daysSince(ts string) float64 {
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return 0
	}
	return time.Since(t).Hours() / 24
}
