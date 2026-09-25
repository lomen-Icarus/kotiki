package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"kotiki/backend/internal/db"
	"kotiki/backend/internal/steps"
)

const maxUpload = 10 << 20 // 10 МБ

var allowedExt = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true,
	".pdf": true, ".zip": true, ".sb3": true, ".mcworld": true, ".mcstructure": true, ".txt": true, ".py": true,
}

type uploadJSON struct {
	ID          int64  `json:"id"`
	URL         string `json:"url"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	ContentType string `json:"content_type"`
}

// POST /api/uploads — multipart/form-data с полем file.
func (s *Server) upload(w http.ResponseWriter, r *http.Request) error {
	u := currentUser(r)
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload+1<<20)
	file, header, err := r.FormFile("file")
	if err != nil {
		return errBadRequest("нужен файл в поле file (multipart/form-data), не больше 10 МБ")
	}
	defer file.Close()
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !allowedExt[ext] {
		return errBadRequest("такой тип файла не принимается: " + ext)
	}
	if err := os.MkdirAll(s.UploadDir, 0o755); err != nil {
		return err
	}
	token, err := newToken()
	if err != nil {
		return err
	}
	stored := token[:16] + ext // имя на диске случайное — чужие файлы не угадать
	out, err := os.Create(filepath.Join(s.UploadDir, stored))
	if err != nil {
		return err
	}
	size, err := io.Copy(out, io.LimitReader(file, maxUpload+1))
	out.Close()
	if err != nil {
		return err
	}
	if size > maxUpload {
		os.Remove(filepath.Join(s.UploadDir, stored))
		return errBadRequest("файл больше 10 МБ")
	}
	ctype := header.Header.Get("Content-Type")
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	res, err := s.DB.Exec(`INSERT INTO uploads (user_id, name, path, size, content_type, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		u.ID, header.Filename, stored, size, ctype, db.Now())
	if err != nil {
		return err
	}
	id, _ := res.LastInsertId()
	return writeJSON(w, 201, uploadJSON{ID: id, URL: "/uploads/" + stored, Name: header.Filename, Size: size, ContentType: ctype})
}

// filesOf — файлы, приложенные к ответу (поля формы с kind=file содержат id загрузки).
func (s *Server) filesOf(st stepRow, answer json.RawMessage, ownerID int64) ([]uploadJSON, error) {
	files := []uploadJSON{}
	ch, ok := steps.Checkers[st.CheckMode()]
	if !ok {
		return files, nil
	}
	var a map[string]json.RawMessage
	if json.Unmarshal(answer, &a) != nil {
		return files, nil
	}
	for _, f := range ch.SubmitFields(st.Content, st.Check) {
		if f.Kind != "file" {
			continue
		}
		raw := strings.Trim(string(a[f.Name]), `"`)
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			continue
		}
		var up uploadJSON
		var path string
		err = s.DB.QueryRow(`SELECT id, name, path, size, content_type FROM uploads WHERE id = ? AND user_id = ?`, id, ownerID).
			Scan(&up.ID, &up.Name, &path, &up.Size, &up.ContentType)
		if err == sql.ErrNoRows {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("файл %d: %w", id, err)
		}
		up.URL = "/uploads/" + path
		files = append(files, up)
	}
	return files, nil
}
