// Пакет runner запускает решение ученика на Python и сравнивает вывод с ожидаемым.
//
// ВАЖНО: это не песочница. Код запускается отдельным процессом с ограничением по времени,
// во временной папке и с пустым окружением, но без изоляции файловой системы и сети.
// Для хакатона этого достаточно; для настоящей эксплуатации решения нужно запускать
// в контейнере (Docker с --network none и лимитом памяти) или через готовую систему вроде Judge0.
package runner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// TestCase — один тест: что подать на вход и что ожидаем на выходе.
type TestCase struct {
	Input    string
	Expected string
	Visible  bool
}

// TestResult — результат одного теста. Для скрытых тестов вход и ответ не заполняются.
type TestResult struct {
	N        int    `json:"n"`
	Verdict  string `json:"verdict"` // OK | WA | TL | RE | CE | SK (пропущен после TL)
	Visible  bool   `json:"visible"`
	Input    string `json:"input,omitempty"`
	Expected string `json:"expected,omitempty"`
	Output   string `json:"output,omitempty"`
	Error    string `json:"error,omitempty"`
	TimeMS   int    `json:"time_ms"`
}

// Запуск интерпретатора сам занимает 50–150 мс, поэтому даём небольшой запас к лимиту задачи.
const startupGrace = 400 * time.Millisecond

// Не больше двух проверок одновременно, чтобы сервер не лёг от наплыва решений.
var slots = make(chan struct{}, 2)

var (
	pythonOnce sync.Once
	pythonCmd  []string
	pythonErr  error
)

// findPython ищет интерпретатор: переменная PYTHON_BIN, затем python3, python, py -3.
func findPython() ([]string, error) {
	pythonOnce.Do(func() {
		candidates := [][]string{{"python3"}, {"python"}, {"py", "-3"}}
		if bin := os.Getenv("PYTHON_BIN"); bin != "" {
			candidates = [][]string{strings.Fields(bin)}
		}
		for _, c := range candidates {
			out, err := exec.Command(c[0], append(c[1:], "--version")...).CombinedOutput()
			if err == nil && strings.HasPrefix(strings.TrimSpace(string(out)), "Python 3") {
				pythonCmd = c
				return
			}
		}
		pythonErr = errors.New("не найден Python 3: установите его или задайте PYTHON_BIN")
	})
	return pythonCmd, pythonErr
}

// RunPython проверяет решение на всех тестах.
func RunPython(ctx context.Context, code string, tests []TestCase, timeLimitMS int) ([]TestResult, error) {
	py, err := findPython()
	if err != nil {
		return nil, err
	}
	slots <- struct{}{}
	defer func() { <-slots }()

	dir, err := os.MkdirTemp("", "kotiki-run-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	file := filepath.Join(dir, "solution.py")
	if err := os.WriteFile(file, []byte(code), 0o600); err != nil {
		return nil, err
	}

	// Сначала проверяем синтаксис: если код не компилируется, все тесты получают CE.
	if msg := syntaxError(ctx, py, dir, file); msg != "" {
		results := make([]TestResult, len(tests))
		for i, t := range tests {
			results[i] = TestResult{N: i + 1, Verdict: "CE", Visible: t.Visible}
		}
		results[0].Error = strings.ReplaceAll(msg, "\r\n", "\n")
		return results, nil
	}

	limit := time.Duration(timeLimitMS) * time.Millisecond
	results := make([]TestResult, 0, len(tests))
	timedOut := false
	for i, t := range tests {
		if timedOut {
			// После превышения времени остальные тесты не гоняем, иначе проверка
			// бесконечного цикла займёт секунды на каждый тест. SK — «не проверялся».
			results = append(results, TestResult{N: i + 1, Verdict: "SK", Visible: t.Visible})
			continue
		}
		r := runOne(ctx, py, dir, file, t.Input, limit)
		timedOut = r.Verdict == "TL"
		r.Output = strings.ReplaceAll(r.Output, "\r\n", "\n")
		r.N = i + 1
		r.Visible = t.Visible
		if r.Verdict == "" {
			if sameOutput(r.Output, t.Expected) {
				r.Verdict = "OK"
			} else {
				r.Verdict = "WA"
			}
		}
		if t.Visible {
			r.Input, r.Expected = t.Input, t.Expected
		} else {
			r.Output, r.Error = "", "" // по выводу на скрытом тесте можно было бы подобрать ответ
		}
		results = append(results, r)
	}
	return results, nil
}

func syntaxError(ctx context.Context, py []string, dir, file string) string {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	args := append(py[1:], "-I", "-c", "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())", file)
	cmd := exec.CommandContext(ctx, py[0], args...)
	cmd.Dir = dir
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return lastLines(stderr.String(), 3)
	}
	return ""
}

func runOne(ctx context.Context, py []string, dir, file, input string, limit time.Duration) TestResult {
	ctx, cancel := context.WithTimeout(ctx, limit+startupGrace)
	defer cancel()

	args := append(py[1:], "-I", file)
	cmd := exec.CommandContext(ctx, py[0], args...)
	cmd.Dir = dir
	cmd.Env = minimalEnv()
	cmd.Stdin = strings.NewReader(input)
	stdout := &limitedBuffer{max: 1 << 20}
	stderr := &limitedBuffer{max: 64 << 10}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.WaitDelay = time.Second

	start := time.Now()
	err := cmd.Run()
	elapsed := time.Since(start)
	r := TestResult{Output: stdout.String(), TimeMS: int(elapsed.Milliseconds())}

	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded) || elapsed > limit+startupGrace:
		r.Verdict = "TL"
		r.TimeMS = int(limit.Milliseconds())
	case err != nil:
		r.Verdict = "RE"
		r.Error = lastLines(stderr.String(), 3)
	}
	return r
}

// sameOutput сравнивает вывод построчно, не обращая внимания на пробелы в конце строк
// и пустые строки в конце — так делают почти все олимпиадные проверяющие системы.
func sameOutput(got, want string) bool {
	return normalize(got) == normalize(want)
}

func normalize(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " \t")
	}
	return strings.TrimRight(strings.Join(lines, "\n"), "\n")
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(strings.ReplaceAll(s, "\r\n", "\n")), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// minimalEnv — пустое окружение, чтобы решение не видело секретов сервера.
// На Windows без SYSTEMROOT Python не стартует, поэтому его оставляем.
func minimalEnv() []string {
	env := []string{"PYTHONIOENCODING=utf-8", "PYTHONDONTWRITEBYTECODE=1"}
	for _, key := range []string{"SYSTEMROOT", "PATH", "TEMP", "TMP"} {
		if v := os.Getenv(key); v != "" {
			env = append(env, fmt.Sprintf("%s=%s", key, v))
		}
	}
	return env
}

// limitedBuffer не даёт решению забить память сервера бесконечным выводом.
type limitedBuffer struct {
	buf bytes.Buffer
	max int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := b.max - b.buf.Len(); room > 0 {
		if len(p) > room {
			b.buf.Write(p[:room])
		} else {
			b.buf.Write(p)
		}
	}
	return len(p), nil
}

func (b *limitedBuffer) String() string { return b.buf.String() }
