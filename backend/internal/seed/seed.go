// Пакет seed заполняет пустую базу: три курса из базового пакета организатора
// и синтетические пользователи с историей, чтобы на демо были видны очередь,
// прогресс и сигналы отставания. Реальных персональных данных здесь нет.
package seed

import (
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"kotiki/backend/internal/api"
	"kotiki/backend/internal/steps"
)

//go:embed content.json
var contentJSON []byte

type seedStep struct {
	Type     string          `json:"type"`
	Title    string          `json:"title"`
	MaxScore int             `json:"max_score"`
	Content  json.RawMessage `json:"content"`
	Check    json.RawMessage `json:"check"`
}

type seedCourse struct {
	Title            string     `json:"title"`
	ShortDescription string     `json:"short_description"`
	DescriptionMD    string     `json:"description_md"`
	Goal             string     `json:"goal"`
	Tool             string     `json:"tool"`
	ToolName         string     `json:"tool_name"`
	Grades           api.Grades `json:"grades"`
	Volume           string     `json:"volume"`
	Modules          []struct {
		Title string     `json:"title"`
		Steps []seedStep `json:"steps"`
	} `json:"modules"`
}

type stepInfo struct {
	id       int64
	maxScore int
	mode     string
}

// Run заполняет базу, только если в ней ещё нет пользователей.
func Run(conn *sql.DB) error {
	var n int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	log.Println("База пустая — загружаю курсы из базового пакета и демо-пользователей")

	var courses []seedCourse
	if err := json.Unmarshal(contentJSON, &courses); err != nil {
		return fmt.Errorf("content.json: %w", err)
	}
	now := time.Now().UTC()
	ts := func(hoursAgo float64) string {
		return now.Add(-time.Duration(hoursAgo * float64(time.Hour))).Format(time.RFC3339)
	}

	// ---------- курсы ----------
	courseIDs := make([]int64, len(courses))
	courseSteps := make([][]stepInfo, len(courses))
	for ci, c := range courses {
		res, err := conn.Exec(`INSERT INTO courses (title, short_description, description_md, goal, tool, tool_name,
			grade_from, grade_to, volume, status, created_at, updated_at, published_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)`,
			c.Title, c.ShortDescription, c.DescriptionMD, c.Goal, c.Tool, c.ToolName, c.Grades.From, c.Grades.To,
			c.Volume, ts(24*30), ts(24*30), ts(24*30))
		if err != nil {
			return err
		}
		courseIDs[ci], _ = res.LastInsertId()
		for mi, m := range c.Modules {
			res, err := conn.Exec(`INSERT INTO modules (course_id, position, title) VALUES (?, ?, ?)`, courseIDs[ci], mi+1, m.Title)
			if err != nil {
				return err
			}
			moduleID, _ := res.LastInsertId()
			for _, st := range m.Steps {
				if err := steps.Validate(st.Type, st.Content, st.Check); err != nil {
					return fmt.Errorf("шаг «%s»: %w", st.Title, err)
				}
				score := st.MaxScore
				if score == 0 {
					score = api.DefaultScore[st.Type]
				}
				id, err := api.InsertStep(conn, moduleID, st.Type, st.Title, st.Content, st.Check, score)
				if err != nil {
					return err
				}
				courseSteps[ci] = append(courseSteps[ci], stepInfo{id, score, steps.ModeOf(st.Check)})
			}
		}
	}

	// ---------- пользователи (синтетические) ----------
	// Логины совпадают с подсказкой на экране входа фронтенда, пароль у всех 1234.
	users := []struct{ login, name, role, grade string }{
		{"admin", "Администратор платформы", "admin", ""},
		{"curator", "Анна Сергеевна Кузнецова", "curator", ""},
		{"curator2", "Павел Игоревич Смирнов", "curator", ""},
		{"masha", "Маша Королёва", "student", "4 класс"},
		{"liza", "Лиза Орлова", "student", "3 класс"},
		{"artem", "Артём Волков", "student", "5 класс"},
		{"sofia", "София Белова", "student", "4 класс"},
		{"timur", "Тимур Гаранин", "student", "5 класс"},
		{"ivan", "Иван Петров", "student", "7 класс"},
		{"nikita", "Никита Зайцев", "student", "6 класс"},
		{"vera", "Вера Лебедева", "student", "8 класс"},
	}
	const demoPassword = "1234"
	uid := map[string]int64{}
	for _, u := range users {
		hash, err := api.HashPassword(demoPassword)
		if err != nil {
			return err
		}
		var grade any
		if u.grade != "" {
			grade = u.grade
		}
		res, err := conn.Exec(`INSERT INTO users (name, login, password_hash, role, grade, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
			u.name, u.login, hash, u.role, grade, ts(24*30))
		if err != nil {
			return err
		}
		uid[u.login], _ = res.LastInsertId()
	}

	// ---------- назначения ----------
	const scratch, minecraft, python = 0, 1, 2
	enroll := func(course int, curator string, students ...string) error {
		for _, s := range students {
			if _, err := conn.Exec(`INSERT INTO enrollments (course_id, student_id, curator_id, created_at) VALUES (?, ?, ?, ?)`,
				courseIDs[course], uid[s], uid[curator], ts(24*14)); err != nil {
				return err
			}
		}
		return nil
	}
	if err := enroll(scratch, "curator", "masha", "liza", "artem", "sofia"); err != nil {
		return err
	}
	if err := enroll(minecraft, "curator", "masha", "timur", "sofia"); err != nil {
		return err
	}
	if err := enroll(python, "curator2", "ivan", "nikita", "vera", "artem"); err != nil {
		return err
	}

	// ---------- история сдач ----------
	attempts := map[string]int{}
	lastSeen := map[string]float64{}
	// sub добавляет сдачу. step — номер шага в курсе по порядку, начиная с 1.
	sub := func(login string, course, step int, status string, hoursAgo float64, answer, feedback string) error {
		st := courseSteps[course][step-1]
		key := fmt.Sprintf("%s/%d", login, st.id)
		attempts[key]++
		var score any
		switch status {
		case "passed":
			score = st.maxScore
		case "failed":
			score = 0
		}
		source, reviewer, reviewedAt := "auto", any(nil), any(ts(hoursAgo))
		if st.mode == "manual" {
			source = "curator"
			reviewedAt = nil
			if status != "pending" {
				reviewedAt = ts(hoursAgo - 2)
				if course == python {
					reviewer = uid["curator2"]
				} else {
					reviewer = uid["curator"]
				}
			}
		}
		var fb any
		if feedback != "" {
			fb = feedback
		}
		if answer == "" {
			answer = "{}"
		}
		if prev, ok := lastSeen[login]; !ok || hoursAgo < prev {
			lastSeen[login] = hoursAgo
		}
		_, err := conn.Exec(`INSERT INTO submissions (step_id, student_id, attempt, answer, status, score, feedback,
			check_source, reviewer_id, created_at, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			st.id, uid[login], attempts[key], answer, status, score, fb, source, reviewer, ts(hoursAgo), reviewedAt)
		return err
	}
	link := func(url string) string { return fmt.Sprintf(`{"url":%q}`, url) }
	mc := func(url string) string { return fmt.Sprintf(`{"project_url":%q}`, url) }
	code := func(src string) string { b, _ := json.Marshal(map[string]string{"code": src}); return string(b) }

	type s = struct {
		login           string
		course, step    int
		status          string
		hoursAgo        float64
		answer, comment string
	}
	history := []s{
		// Маша (демо-ученик masha): идёт в графике, одна работа на проверке в каждом курсе
		{"masha", scratch, 1, "passed", 120, "", ""},
		{"masha", scratch, 2, "passed", 119, `{"value":"b"}`, ""},
		{"masha", scratch, 3, "failed", 118, `{"value":"200"}`, ""},
		{"masha", scratch, 3, "passed", 117, `{"value":"0"}`, ""},
		{"masha", scratch, 4, "passed", 50, "", ""},
		{"masha", scratch, 5, "passed", 49, `{"value":"45"}`, ""},
		{"masha", scratch, 6, "returned", 30, link("https://scratch.mit.edu/projects/100000001"), "Угол 60° не замыкает фигуру. Подумай: на сколько градусов нужно повернуть, чтобы после трёх поворотов вернуться в исходное направление?"},
		{"masha", scratch, 6, "pending", 2, link("https://scratch.mit.edu/projects/100000002"), ""},
		{"masha", minecraft, 1, "passed", 26, "", ""},
		{"masha", minecraft, 2, "passed", 25, `{"value":"c"}`, ""},
		{"masha", minecraft, 3, "pending", 5, mc("https://makecode.com/_demo0001"), ""},

		// Лиза: застряла на вопросе — 3 неудачные попытки подряд (ранний сигнал)
		{"liza", scratch, 1, "passed", 72, "", ""},
		{"liza", scratch, 2, "passed", 71, `{"value":"b"}`, ""},
		{"liza", scratch, 3, "passed", 70, `{"value":"0"}`, ""},
		{"liza", scratch, 4, "passed", 30, "", ""},
		{"liza", scratch, 5, "failed", 29, `{"value":"30"}`, ""},
		{"liza", scratch, 5, "failed", 28, `{"value":"15"}`, ""},
		{"liza", scratch, 5, "failed", 27, `{"value":"35"}`, ""},

		// Артём: не заходит больше недели
		{"artem", scratch, 1, "passed", 24 * 9, "", ""},
		{"artem", scratch, 2, "failed", 24 * 9, `{"value":"c"}`, ""},
		{"artem", python, 1, "passed", 24 * 8, "", ""},

		// София: впереди группы, работы приняты куратором
		{"sofia", scratch, 1, "passed", 24 * 6, "", ""},
		{"sofia", scratch, 2, "passed", 24 * 6, `{"value":"b"}`, ""},
		{"sofia", scratch, 3, "passed", 24 * 6, `{"value":"0"}`, ""},
		{"sofia", scratch, 4, "passed", 24 * 5, "", ""},
		{"sofia", scratch, 5, "passed", 24 * 5, `{"value":"45"}`, ""},
		{"sofia", scratch, 6, "passed", 24 * 4, link("https://scratch.mit.edu/projects/100000011"), "Отлично: цикл на 3 повтора и угол 120°."},
		{"sofia", scratch, 7, "passed", 24 * 3, link("https://scratch.mit.edu/projects/100000012"), "Кот говорит «Круг!» — всё по заданию."},
		{"sofia", scratch, 8, "passed", 24 * 2, "", ""},
		{"sofia", scratch, 9, "passed", 24 * 2, `{"value":["a","c","d"]}`, ""},
		{"sofia", scratch, 10, "pending", 20, link("https://scratch.mit.edu/projects/100000013"), ""},
		{"sofia", minecraft, 1, "passed", 20, "", ""},

		// Тимур: работу вернули 3 дня назад, он её не исправил
		{"timur", minecraft, 1, "passed", 24 * 5, "", ""},
		{"timur", minecraft, 2, "passed", 24 * 5, `{"value":"c"}`, ""},
		{"timur", minecraft, 3, "returned", 24*3 + 2, mc("https://makecode.com/_demo0002"), "Дорожка из 11 блоков и сделана копиями блоков. Используй «повторить 10 раз»."},

		// Иван: Python, идёт нормально, на вопросе по високосному году
		{"ivan", python, 1, "passed", 48, "", ""},
		{"ivan", python, 2, "passed", 48, `{"value":"b"}`, ""},
		{"ivan", python, 3, "passed", 47, code("a, b = map(int, input().split())\nprint(a + b)"), ""},
		{"ivan", python, 4, "failed", 46, code("a = int(input())\nb = int(input())\nc = int(input())\nprint((a + b + c) // 2)"), ""},
		{"ivan", python, 4, "passed", 45, code("a = int(input())\nb = int(input())\nc = int(input())\nprint((a + 1) // 2 + (b + 1) // 2 + (c + 1) // 2)"), ""},
		{"ivan", python, 5, "passed", 6, "", ""},
		{"ivan", python, 6, "passed", 6, `{"value":"2"}`, ""},
		{"ivan", python, 7, "passed", 5, code("a, b, c = map(int, input().split())\nm = a\nif b > m:\n    m = b\nif c > m:\n    m = c\nprint(m)"), ""},

		// Никита: начал и пропал на 5 дней
		{"nikita", python, 1, "passed", 24 * 5, "", ""},
		{"nikita", python, 2, "passed", 24 * 5, `{"value":"b"}`, ""},
		{"nikita", python, 3, "passed", 24 * 5, code("print(sum(map(int, input().split())))"), ""},

		// Вера: быстро идёт, уже на циклах
		{"vera", python, 1, "passed", 24 * 3, "", ""},
		{"vera", python, 2, "passed", 24 * 3, `{"value":"b"}`, ""},
		{"vera", python, 3, "passed", 24 * 3, code("a, b = map(int, input().split())\nprint(a + b)"), ""},
		{"vera", python, 4, "passed", 24 * 2, code("print(sum((int(input()) + 1) // 2 for _ in range(3)))"), ""},
		{"vera", python, 5, "passed", 24 * 2, "", ""},
		{"vera", python, 6, "passed", 24 * 2, `{"value":"2"}`, ""},
		{"vera", python, 7, "passed", 30, code("a, b, c = map(int, input().split())\nm = a\nif b > m: m = b\nif c > m: m = c\nprint(m)"), ""},
		{"vera", python, 8, "passed", 29, code("y = int(input())\nprint('YES' if y % 400 == 0 or (y % 4 == 0 and y % 100 != 0) else 'NO')"), ""},
		{"vera", python, 9, "passed", 4, "", ""},
	}
	for _, h := range history {
		if err := sub(h.login, h.course, h.step, h.status, h.hoursAgo, h.answer, h.comment); err != nil {
			return fmt.Errorf("сдача %s шаг %d: %w", h.login, h.step, err)
		}
	}
	for login, h := range lastSeen {
		if _, err := conn.Exec(`UPDATE users SET last_seen_at = ? WHERE id = ?`, ts(h), uid[login]); err != nil {
			return err
		}
	}

	// ---------- вопросы по шагам ----------
	questions := []struct {
		login        string
		course, step int
		text, answer string
		hoursAgo     float64
	}{
		{"masha", scratch, 7, "Почему нужно именно 120 повторов, а не 60?", "", 3},
		{"ivan", python, 8, "Не понимаю условие про 100 лет: 2000 делится на 100, но он високосный?", "", 5},
		{"liza", scratch, 5, "Я считаю 10 + 5 = 15, почему неправильно?", "", 26},
		{"sofia", scratch, 3, "Почему x получается 0, а не 200?", "Мяч стартует с −200 и проходит 10 × 20 = 200 шагов вправо: −200 + 200 = 0.", 24 * 6},
	}
	for _, q := range questions {
		st := courseSteps[q.course][q.step-1]
		var answer, answeredBy, answeredAt, status any = nil, nil, nil, "open"
		if q.answer != "" {
			answer, answeredBy, answeredAt, status = q.answer, uid["curator"], ts(q.hoursAgo-1), "answered"
		}
		if _, err := conn.Exec(`INSERT INTO questions (step_id, student_id, text, status, answer, answered_by, created_at, answered_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, st.id, uid[q.login], q.text, status, answer, answeredBy, ts(q.hoursAgo), answeredAt); err != nil {
			return err
		}
	}
	log.Printf("Загружено: %d курса, %d пользователей, %d сдач", len(courses), len(users), len(history))
	return nil
}
