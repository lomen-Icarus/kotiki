package api

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"kotiki/backend/internal/db"
)

const sessionTTL = 30 * 24 * time.Hour

// POST /api/auth/login
func (s *Server) login(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Login    string `json:"login"`
		Password string `json:"password"`
	}
	if err := readJSON(r, &in); err != nil {
		return err
	}
	var u User
	var hash string
	err := s.DB.QueryRow(`SELECT id, name, login, role, COALESCE(grade, ''), password_hash FROM users WHERE login = ?`,
		strings.TrimSpace(in.Login)).Scan(&u.ID, &u.Name, &u.Login, &u.Role, &u.Grade, &hash)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && bcrypt.CompareHashAndPassword([]byte(hash), []byte(in.Password)) != nil) {
		return errUnauthorized("неверный логин или пароль")
	}
	if err != nil {
		return err
	}
	return s.startSession(w, 200, u)
}

// startSession выдаёт новый токен и отвечает {token, user}.
func (s *Server) startSession(w http.ResponseWriter, status int, u User) error {
	token, err := newToken()
	if err != nil {
		return err
	}
	expires := time.Now().UTC().Add(sessionTTL).Format(time.RFC3339)
	if _, err := s.DB.Exec(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		token, u.ID, db.Now(), expires); err != nil {
		return err
	}
	s.touch(u.ID)
	return writeJSON(w, status, map[string]any{"token": token, "user": u})
}

// POST /api/auth/register — самостоятельная регистрация. Создаётся только ученик;
// курсы у него появятся, когда администратор его назначит.
func (s *Server) register(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Name     string `json:"name"`
		Grade    string `json:"grade"`
		Login    string `json:"login"`
		Password string `json:"password"`
	}
	if err := readJSON(r, &in); err != nil {
		return err
	}
	in.Name, in.Grade, in.Login = strings.TrimSpace(in.Name), strings.TrimSpace(in.Grade), strings.TrimSpace(in.Login)
	if in.Name == "" || in.Login == "" {
		return errBadRequest("укажите имя и логин")
	}
	if len([]rune(in.Password)) < 4 {
		return errBadRequest("пароль — не короче 4 символов")
	}
	hash, err := HashPassword(in.Password)
	if err != nil {
		return err
	}
	res, err := s.DB.Exec(`INSERT INTO users (name, login, password_hash, role, grade, created_at) VALUES (?, ?, ?, 'student', ?, ?)`,
		in.Name, in.Login, hash, in.Grade, db.Now())
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return errConflict("такой логин уже занят")
		}
		return err
	}
	id, _ := res.LastInsertId()
	return s.startSession(w, 201, User{ID: id, Name: in.Name, Login: in.Login, Role: "student", Grade: in.Grade})
}

// GET /api/auth/me
func (s *Server) me(w http.ResponseWriter, r *http.Request) error {
	return writeJSON(w, 200, currentUser(r))
}

// POST /api/auth/logout
func (s *Server) logout(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.DB.Exec(`DELETE FROM sessions WHERE token = ?`, bearer(r)); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// HashPassword используется и при создании пользователей админом, и в начальных данных.
func HashPassword(p string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(p), bcrypt.DefaultCost)
	return string(h), err
}
