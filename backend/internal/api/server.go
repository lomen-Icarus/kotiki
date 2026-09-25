// Пакет api — HTTP-обработчики. Список всех запросов с примерами — в API.md в корне репозитория.
package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"kotiki/backend/internal/db"
	"kotiki/backend/internal/steps"
)

// Server хранит всё, что нужно обработчикам.
type Server struct {
	DB        *sql.DB
	UploadDir string
	StaticDir string
}

// Routes регистрирует все маршруты. Синтаксис "GET /api/x/{id}" появился в Go 1.22.
func (s *Server) Routes() http.Handler {
	steps.CustomTypes = s.customTypes // типы шагов, добавленные администратором, берутся из базы

	mux := http.NewServeMux()
	any := []string{"student", "curator", "admin"}
	staff := []string{"curator", "admin"}
	admin := []string{"admin"}

	mux.HandleFunc("GET /api/health", s.h(func(w http.ResponseWriter, r *http.Request) error {
		return writeJSON(w, 200, map[string]string{"status": "ok", "backend": "kotiki-go"})
	}))

	// Авторизация
	mux.HandleFunc("POST /api/auth/login", s.h(s.login))
	mux.HandleFunc("POST /api/auth/register", s.h(s.register))
	mux.HandleFunc("GET /api/auth/me", s.auth(any, s.me))
	mux.HandleFunc("POST /api/auth/logout", s.auth(any, s.logout))

	// Каталог — открыт без входа
	mux.HandleFunc("GET /api/catalog", s.h(s.catalog))
	mux.HandleFunc("GET /api/catalog/filters", s.h(s.catalogFilters))
	mux.HandleFunc("GET /api/courses/{id}", s.h(s.coursePage))
	mux.HandleFunc("GET /api/step-types", s.h(s.adminStepTypes)) // справочник типов: названия, иконки, поля

	// Ученик
	mux.HandleFunc("GET /api/me/courses", s.auth(any, s.myCourses))
	mux.HandleFunc("GET /api/me/courses/{id}/rating", s.auth(any, s.myRating))
	mux.HandleFunc("GET /api/me/submissions", s.auth(any, s.mySubmissions))
	mux.HandleFunc("GET /api/me/questions", s.auth(any, s.myQuestions))
	mux.HandleFunc("GET /api/steps/{id}", s.auth(any, s.getStep))
	mux.HandleFunc("POST /api/steps/{id}/submissions", s.auth(any, s.submit))
	mux.HandleFunc("GET /api/steps/{id}/submissions", s.auth(any, s.stepSubmissions))
	mux.HandleFunc("POST /api/steps/{id}/questions", s.auth(any, s.askQuestion))
	mux.HandleFunc("GET /api/steps/{id}/questions", s.auth(any, s.stepQuestions))
	mux.HandleFunc("POST /api/uploads", s.auth(any, s.upload))

	// Куратор
	mux.HandleFunc("GET /api/curator/students", s.auth(staff, s.curatorStudents))
	mux.HandleFunc("GET /api/curator/students/{id}", s.auth(staff, s.curatorStudent))
	mux.HandleFunc("GET /api/curator/queue", s.auth(staff, s.curatorQueue))
	mux.HandleFunc("GET /api/curator/submissions/{id}", s.auth(staff, s.curatorSubmission))
	mux.HandleFunc("POST /api/curator/submissions/{id}/review", s.auth(staff, s.review))
	mux.HandleFunc("GET /api/curator/questions", s.auth(staff, s.curatorQuestions))
	mux.HandleFunc("POST /api/curator/questions/{id}/answer", s.auth(staff, s.answerQuestion))

	// Администратор: пользователи
	mux.HandleFunc("GET /api/admin/users", s.auth(admin, s.adminUsers))
	mux.HandleFunc("POST /api/admin/users", s.auth(admin, s.adminCreateUser))
	mux.HandleFunc("PATCH /api/admin/users/{id}", s.auth(admin, s.adminUpdateUser))
	mux.HandleFunc("DELETE /api/admin/users/{id}", s.auth(admin, s.adminDeleteUser))
	// курсы
	mux.HandleFunc("GET /api/admin/courses", s.auth(admin, s.adminCourses))
	mux.HandleFunc("POST /api/admin/courses", s.auth(admin, s.adminCreateCourse))
	mux.HandleFunc("GET /api/admin/courses/{id}", s.auth(admin, s.adminCourse))
	mux.HandleFunc("PATCH /api/admin/courses/{id}", s.auth(admin, s.adminUpdateCourse))
	mux.HandleFunc("DELETE /api/admin/courses/{id}", s.auth(admin, s.adminArchiveCourse))
	mux.HandleFunc("POST /api/admin/courses/{id}/publish", s.auth(admin, s.adminPublish))
	mux.HandleFunc("POST /api/admin/courses/{id}/unpublish", s.auth(admin, s.adminUnpublish))
	// модули
	mux.HandleFunc("POST /api/admin/courses/{id}/modules", s.auth(admin, s.adminCreateModule))
	mux.HandleFunc("PATCH /api/admin/modules/{id}", s.auth(admin, s.adminUpdateModule))
	mux.HandleFunc("DELETE /api/admin/modules/{id}", s.auth(admin, s.adminDeleteModule))
	mux.HandleFunc("PUT /api/admin/courses/{id}/modules/order", s.auth(admin, s.adminOrderModules))
	// шаги
	mux.HandleFunc("GET /api/admin/step-types", s.auth(admin, s.adminStepTypes))
	mux.HandleFunc("POST /api/admin/step-types", s.auth(admin, s.adminCreateStepType))
	mux.HandleFunc("DELETE /api/admin/step-types/{type}", s.auth(admin, s.adminDeleteStepType))
	mux.HandleFunc("POST /api/admin/modules/{id}/steps", s.auth(admin, s.adminCreateStep))
	mux.HandleFunc("GET /api/admin/steps/{id}", s.auth(admin, s.adminStep))
	mux.HandleFunc("PATCH /api/admin/steps/{id}", s.auth(admin, s.adminUpdateStep))
	mux.HandleFunc("DELETE /api/admin/steps/{id}", s.auth(admin, s.adminDeleteStep))
	mux.HandleFunc("PUT /api/admin/modules/{id}/steps/order", s.auth(admin, s.adminOrderSteps))
	mux.HandleFunc("POST /api/admin/steps/{id}/preview-check", s.auth(admin, s.adminPreviewCheck))
	// назначения
	mux.HandleFunc("GET /api/admin/enrollments", s.auth(admin, s.adminEnrollments))
	mux.HandleFunc("POST /api/admin/enrollments", s.auth(admin, s.adminEnroll))
	mux.HandleFunc("PATCH /api/admin/enrollments/{id}", s.auth(admin, s.adminUpdateEnrollment))
	mux.HandleFunc("DELETE /api/admin/enrollments/{id}", s.auth(admin, s.adminDeleteEnrollment))

	// Загруженные файлы и фронтенд
	mux.Handle("GET /uploads/", http.StripPrefix("/uploads/", http.FileServer(http.Dir(s.UploadDir))))
	notFound := s.h(func(w http.ResponseWriter, r *http.Request) error {
		return errNotFound("такого запроса нет — см. API.md")
	})
	if st, err := os.Stat(s.StaticDir); err == nil && st.IsDir() {
		static := http.FileServer(http.Dir(s.StaticDir))
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/") || r.Method != http.MethodGet {
				notFound(w, r)
				return
			}
			static.ServeHTTP(w, r)
		})
	} else {
		mux.HandleFunc("/", notFound)
	}

	return withCORS(withLog(mux))
}

// ---------- ошибки ----------

type apiError struct {
	Status int
	Code   string
	Msg    string
}

func (e apiError) Error() string { return e.Msg }

func errBadRequest(msg string) error   { return apiError{400, "bad_request", msg} }
func errUnauthorized(msg string) error { return apiError{401, "unauthorized", msg} }
func errForbidden(msg string) error    { return apiError{403, "forbidden", msg} }
func errNotFound(msg string) error     { return apiError{404, "not_found", msg} }
func errConflict(msg string) error     { return apiError{409, "conflict", msg} }

// h превращает обработчик, возвращающий error, в обычный http.HandlerFunc.
func (s *Server) h(fn func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		err := fn(w, r)
		if err == nil {
			return
		}
		var ae apiError
		var answerErr steps.AnswerError
		switch {
		case errors.As(err, &ae):
		case errors.As(err, &answerErr):
			ae = apiError{400, "bad_request", answerErr.Msg}
		case errors.Is(err, sql.ErrNoRows):
			ae = apiError{404, "not_found", "не найдено"}
		default:
			log.Printf("ОШИБКА %s %s: %v", r.Method, r.URL.Path, err)
			ae = apiError{500, "internal", "внутренняя ошибка сервера"}
		}
		_ = writeJSON(w, ae.Status, map[string]any{"error": map[string]string{"code": ae.Code, "message": ae.Msg}})
	}
}

// ---------- авторизация ----------

// User — вошедший пользователь.
type User struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Login string `json:"login"`
	Role  string `json:"role"`
	Grade string `json:"grade,omitempty"`
}

type ctxKey struct{}

func currentUser(r *http.Request) User { return r.Context().Value(ctxKey{}).(User) }

// auth пропускает запрос дальше, только если есть действующий токен и подходящая роль.
func (s *Server) auth(roles []string, fn func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return s.h(func(w http.ResponseWriter, r *http.Request) error {
		u, err := s.userFromToken(r)
		if err != nil {
			return err
		}
		allowed := false
		for _, role := range roles {
			if u.Role == role {
				allowed = true
			}
		}
		if !allowed {
			return errForbidden("недостаточно прав")
		}
		s.touch(u.ID)
		return fn(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, u)))
	})
}

func bearer(r *http.Request) string {
	return strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
}

func (s *Server) userFromToken(r *http.Request) (User, error) {
	token := bearer(r)
	if token == "" {
		return User{}, errUnauthorized("нужен вход: заголовок Authorization: Bearer <token>")
	}
	var u User
	err := s.DB.QueryRow(`
		SELECT u.id, u.name, u.login, u.role, COALESCE(u.grade, '') FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token = ? AND s.expires_at > ?`, token, db.Now()).Scan(&u.ID, &u.Name, &u.Login, &u.Role, &u.Grade)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, errUnauthorized("токен недействителен или истёк — войдите заново")
	}
	return u, err
}

// optionalUser — пользователь, если токен есть, иначе nil (для каталога).
func (s *Server) optionalUser(r *http.Request) *User {
	if bearer(r) == "" {
		return nil
	}
	u, err := s.userFromToken(r)
	if err != nil {
		return nil
	}
	return &u
}

// touch запоминает, когда пользователь был активен (нужно для сигнала отставания).
func (s *Server) touch(userID int64) {
	cutoff := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339)
	_, _ = s.DB.Exec(`UPDATE users SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`,
		db.Now(), userID, cutoff)
}

// ---------- JSON ----------

func writeJSON(w http.ResponseWriter, status int, v any) error {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	return json.NewEncoder(w).Encode(v)
}

func readJSON(r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, 2<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		return errBadRequest("неверный JSON: " + err.Error())
	}
	return nil
}

func pathID(r *http.Request, name string) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	if err != nil || id <= 0 {
		return 0, errBadRequest("неверный id в адресе")
	}
	return id, nil
}

func queryInt(r *http.Request, name string, def int) int {
	v, err := strconv.Atoi(r.URL.Query().Get(name))
	if err != nil {
		return def
	}
	return v
}

func paging(r *http.Request) (limit, offset int) {
	limit = min(max(queryInt(r, "limit", 50), 1), 200)
	page := max(queryInt(r, "page", 1), 1)
	return limit, (page - 1) * limit
}

// ---------- middleware ----------

// withCORS разрешает фронтенду с другого адреса (например, Live Server на :5500) ходить в API.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func withLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
		}
	})
}

// ---------- мелочи ----------

// nullStr превращает sql.NullString в *string, чтобы в JSON было null, а не "".
func nullStr(ns sql.NullString) *string {
	if !ns.Valid {
		return nil
	}
	return &ns.String
}

func nullInt(ni sql.NullInt64) *int64 {
	if !ni.Valid {
		return nil
	}
	return &ni.Int64
}

func rawOrNull(s sql.NullString) json.RawMessage {
	if !s.Valid || s.String == "" {
		return json.RawMessage("null")
	}
	return json.RawMessage(s.String)
}
