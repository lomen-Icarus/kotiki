// Пакет db открывает SQLite и создаёт таблицы.
package db

import (
	"database/sql"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite" // драйвер SQLite на чистом Go, не нужен компилятор C
)

//go:embed schema.sql
var schema string

// Open открывает (или создаёт) файл базы и применяет схему.
func Open(path string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	dsn := fmt.Sprintf("file:%s?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)", path)
	conn, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// SQLite любит одного писателя за раз — так проще избежать ошибок "database is locked".
	conn.SetMaxOpenConns(1)
	if _, err := conn.Exec(schema); err != nil {
		return nil, fmt.Errorf("применение схемы: %w", err)
	}
	// Колонки, добавленные после первой версии схемы. В уже созданной базе их
	// нужно дописать; ошибка «duplicate column» значит, что колонка уже есть.
	for _, m := range []string{`ALTER TABLE users ADD COLUMN grade TEXT`} {
		if _, err := conn.Exec(m); err != nil && !strings.Contains(err.Error(), "duplicate column") {
			return nil, fmt.Errorf("миграция %q: %w", m, err)
		}
	}
	return conn, nil
}

// Now — текущее время в формате, который мы храним в базе.
func Now() string {
	return time.Now().UTC().Format(time.RFC3339)
}
