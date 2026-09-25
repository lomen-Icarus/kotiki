package api

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
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
	err := s.DB.QueryRow(`SELECT id, name, login, role, password_hash FROM users WHERE login = ?`, in.Login).
		Scan(&u.ID, &u.Name, &u.Login, &u.Role, &hash)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && bcrypt.CompareHashAndPassword([]byte(hash), []byte(in.Password)) != nil) {
		return errUnauthorized("неверный логин или пароль")
	}
	if err != nil {
		return err
	}
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
	return writeJSON(w, 200, map[string]any{"token": token, "user": u})
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
