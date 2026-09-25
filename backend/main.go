// Сервер образовательной платформы.
//
// Запуск:  go run .
// Настройки через переменные окружения (у всех есть значения по умолчанию):
//
//	PORT        — порт, по умолчанию 8080
//	DB_PATH     — файл базы SQLite, по умолчанию data/kotiki.db
//	UPLOAD_DIR  — куда сохранять файлы учеников, по умолчанию data/uploads
//	STATIC_DIR  — папка фронтенда, которую сервер отдаёт по адресу /, по умолчанию ../Hackaton
//	PYTHON_BIN  — чем запускать решения на Python, по умолчанию ищется python3 / python / py -3
package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"kotiki/backend/internal/api"
	"kotiki/backend/internal/db"
	"kotiki/backend/internal/seed"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	conn, err := db.Open(env("DB_PATH", "data/kotiki.db"))
	if err != nil {
		log.Fatalf("база данных: %v", err)
	}
	defer conn.Close()

	if err := seed.Run(conn); err != nil {
		log.Fatalf("начальные данные: %v", err)
	}

	srv := &api.Server{
		DB:        conn,
		UploadDir: env("UPLOAD_DIR", "data/uploads"),
		StaticDir: env("STATIC_DIR", "../Hackaton"),
	}
	addr := ":" + env("PORT", "8080")
	log.Printf("Сервер запущен: http://localhost%s  (API: http://localhost%s/api/health)", addr, addr)
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Fatal(httpServer.ListenAndServe())
}
