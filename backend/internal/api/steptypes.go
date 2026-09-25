package api

import (
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"kotiki/backend/internal/db"
	"kotiki/backend/internal/steps"
)

// Типы шагов, которые администратор добавляет сам — без программиста и без
// перезапуска сервера. Например, «Видео-урок» (засчитывается при просмотре)
// или «Эссе» (проверяет куратор). Шаги такого типа хранятся, выдаются ученику
// и проверяются теми же механизмами, что и встроенные.

var typeNameRe = regexp.MustCompile(`^[a-z][a-z0-9_]{1,30}$`)

var contentFieldKinds = []string{"markdown", "code_block", "text", "options", "list", "limits"}

// customTypes читает типы из таблицы step_types. Вызывается при каждой проверке типа.
func (s *Server) customTypes() []steps.Type {
	rows, err := s.DB.Query(`SELECT name, title, icon, description, check_modes, content_fields FROM step_types ORDER BY created_at`)
	if err != nil {
		log.Printf("step_types: %v", err)
		return nil
	}
	defer rows.Close()
	var list []steps.Type
	for rows.Next() {
		var t steps.Type
		var modes, fields string
		if err := rows.Scan(&t.Name, &t.Title, &t.Icon, &t.Description, &modes, &fields); err != nil {
			log.Printf("step_types: %v", err)
			return list
		}
		_ = json.Unmarshal([]byte(modes), &t.CheckModes)
		_ = json.Unmarshal([]byte(fields), &t.ContentFields)
		t.Custom = true
		list = append(list, t)
	}
	return list
}

// POST /api/admin/step-types — добавить тип шага.
func (s *Server) adminCreateStepType(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Type          string        `json:"type"`
		Title         string        `json:"title"`
		Icon          string        `json:"icon"`
		Description   string        `json:"description"`
		CheckModes    []string      `json:"check_modes"`
		ContentFields []steps.Field `json:"content_fields"`
	}
	if err := readJSON(r, &in); err != nil {
		return err
	}
	in.Type, in.Title = strings.TrimSpace(in.Type), strings.TrimSpace(in.Title)
	if !typeNameRe.MatchString(in.Type) {
		return errBadRequest("type: латиницей в нижнем регистре, 2–31 символ, например video")
	}
	if in.Title == "" {
		return errBadRequest("title: укажите название типа")
	}
	if _, exists := steps.FindType(in.Type); exists {
		return errConflict("тип " + in.Type + " уже существует")
	}
	if len(in.CheckModes) == 0 {
		in.CheckModes = []string{"manual"}
	}
	for _, m := range in.CheckModes {
		if _, ok := steps.Checkers[m]; !ok {
			return errBadRequest("check_modes: неизвестный способ проверки " + m + " (есть none, answer, tests, manual)")
		}
	}
	if len(in.ContentFields) == 0 {
		in.ContentFields = []steps.Field{{Name: "body_md", Kind: "markdown", Label: "Текст задания", Required: true}}
	}
	seen := map[string]bool{}
	for _, f := range in.ContentFields {
		if f.Name == "" || seen[f.Name] {
			return errBadRequest("content_fields: у каждого поля нужно уникальное name")
		}
		seen[f.Name] = true
		if !slices.Contains(contentFieldKinds, f.Kind) {
			return errBadRequest("content_fields." + f.Name + ": kind должен быть одним из " + strings.Join(contentFieldKinds, ", "))
		}
	}
	icon := strings.TrimSpace(in.Icon)
	if icon == "" {
		icon = strings.ToUpper(string([]rune(in.Title)[:1]))
	}
	modes, _ := json.Marshal(in.CheckModes)
	fields, _ := json.Marshal(in.ContentFields)
	if _, err := s.DB.Exec(`INSERT INTO step_types (name, title, icon, description, check_modes, content_fields, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, in.Type, in.Title, icon, strings.TrimSpace(in.Description), string(modes), string(fields), db.Now()); err != nil {
		return err
	}
	t, _ := steps.FindType(in.Type)
	return writeJSON(w, 201, t)
}

// DELETE /api/admin/step-types/{type} — удалить добавленный тип, если он нигде не используется.
func (s *Server) adminDeleteStepType(w http.ResponseWriter, r *http.Request) error {
	name := r.PathValue("type")
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM step_types WHERE name = ?`, name).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return errBadRequest("удалять можно только типы, добавленные администратором")
	}
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM steps WHERE type = ?`, name).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return errConflict("этот тип используется в шагах курсов — сначала удалите или измените их")
	}
	if _, err := s.DB.Exec(`DELETE FROM step_types WHERE name = ?`, name); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}
