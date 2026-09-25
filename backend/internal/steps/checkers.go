package steps

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"

	"kotiki/backend/internal/runner"
)

// Result — итог проверки одной сдачи.
type Result struct {
	Status string              // passed | failed | pending
	Hint   string              // подсказка ученику после неверного ответа
	Tests  []runner.TestResult // результаты прогона по тестам (только для mode=tests)
}

// AnswerError — ученик прислал ответ не в том формате. API превращает её в HTTP 400.
type AnswerError struct{ Msg string }

func (e AnswerError) Error() string { return e.Msg }

// Checker — способ проверки шага.
type Checker interface {
	// Title — название для конструктора курса.
	Title() string
	// ConfigFields — какие поля нужно заполнить в check_json (для конструктора курса).
	ConfigFields() []Field
	// Validate проверяет check_json при сохранении шага.
	Validate(content, check json.RawMessage) error
	// SubmitFields — форма ответа для ученика. nil — отвечать не нужно (теория).
	SubmitFields(content, check json.RawMessage) []Field
	// Public — что из check можно показать ученику (например, тесты-примеры).
	Public(content, check json.RawMessage) map[string]any
	// Check проверяет ответ ученика.
	Check(ctx context.Context, content, check, answer json.RawMessage) (Result, error)
}

// Checkers — реестр способов проверки.
var Checkers = map[string]Checker{
	"none":   noneChecker{},
	"answer": answerChecker{},
	"tests":  testsChecker{},
	"manual": manualChecker{},
}

// ---------- none: теория, засчитывается при прочтении ----------

type noneChecker struct{}

func (noneChecker) Title() string                              { return "Засчитывается при прочтении" }
func (noneChecker) ConfigFields() []Field                      { return nil }
func (noneChecker) Validate(_, _ json.RawMessage) error        { return nil }
func (noneChecker) SubmitFields(_, _ json.RawMessage) []Field  { return nil }
func (noneChecker) Public(_, _ json.RawMessage) map[string]any { return nil }
func (noneChecker) Check(context.Context, json.RawMessage, json.RawMessage, json.RawMessage) (Result, error) {
	return Result{Status: "passed"}, nil
}

// ---------- answer: выбор варианта, число или короткий текст ----------

type answerCheck struct {
	AnswerKind string          `json:"answer_kind"` // single_choice | multi_choice | number | text
	Correct    json.RawMessage `json:"correct"`     // "b" | ["a","c"] | "45" | ["ответ", "вариант ответа"]
	Hint       string          `json:"hint"`
	Label      string          `json:"label"`
}

type contentOptions struct {
	Options []Option `json:"options"`
}

type answerChecker struct{}

func (answerChecker) Title() string { return "Автоматическая: сверка ответа" }

func (answerChecker) ConfigFields() []Field {
	return []Field{
		{Name: "answer_kind", Kind: "select", Label: "Вид ответа", Required: true, Options: []Option{
			{ID: "single_choice", Text: "Один верный вариант"},
			{ID: "multi_choice", Text: "Несколько верных вариантов"},
			{ID: "number", Text: "Число"},
			{ID: "text", Text: "Короткий текст"},
		}},
		{Name: "correct", Kind: "json", Label: `Верный ответ: "b", ["a","c"] или "45"`, Required: true},
		{Name: "hint", Kind: "text", Label: "Подсказка после неверного ответа"},
		{Name: "label", Kind: "text", Label: "Подпись поля ответа"},
	}
}

func (answerChecker) Validate(content, check json.RawMessage) error {
	var c answerCheck
	if err := json.Unmarshal(check, &c); err != nil {
		return fmt.Errorf("check: %v", err)
	}
	var co contentOptions
	_ = json.Unmarshal(content, &co)
	optionIDs := make([]string, 0, len(co.Options))
	for _, o := range co.Options {
		optionIDs = append(optionIDs, o.ID)
	}
	switch c.AnswerKind {
	case "single_choice":
		var s string
		if json.Unmarshal(c.Correct, &s) != nil || !slices.Contains(optionIDs, s) {
			return fmt.Errorf("check.correct: должен быть id одного из вариантов content.options")
		}
	case "multi_choice":
		var ss []string
		if json.Unmarshal(c.Correct, &ss) != nil || len(ss) == 0 {
			return fmt.Errorf("check.correct: должен быть непустым списком id вариантов")
		}
		for _, s := range ss {
			if !slices.Contains(optionIDs, s) {
				return fmt.Errorf("check.correct: варианта %q нет в content.options", s)
			}
		}
	case "number":
		var s string
		if json.Unmarshal(c.Correct, &s) != nil {
			return fmt.Errorf("check.correct: число нужно записать строкой, например \"45\"")
		}
		if _, ok := parseNumber(s); !ok {
			return fmt.Errorf("check.correct: %q — не число", s)
		}
	case "text":
		if len(textAlternatives(c.Correct)) == 0 {
			return fmt.Errorf("check.correct: нужен текст или список допустимых ответов")
		}
	default:
		return fmt.Errorf("check.answer_kind: ожидается single_choice, multi_choice, number или text")
	}
	return nil
}

func (answerChecker) SubmitFields(content, check json.RawMessage) []Field {
	var c answerCheck
	_ = json.Unmarshal(check, &c)
	label := c.Label
	if label == "" {
		label = "Ответ"
	}
	f := Field{Name: "value", Kind: c.AnswerKind, Label: label, Required: true}
	if c.AnswerKind == "single_choice" || c.AnswerKind == "multi_choice" {
		var co contentOptions
		_ = json.Unmarshal(content, &co)
		f.Options = co.Options
	}
	return []Field{f}
}

func (answerChecker) Public(_, _ json.RawMessage) map[string]any { return nil }

func (answerChecker) Check(_ context.Context, _, check, answer json.RawMessage) (Result, error) {
	var c answerCheck
	if err := json.Unmarshal(check, &c); err != nil {
		return Result{}, err
	}
	var a struct {
		Value json.RawMessage `json:"value"`
	}
	if json.Unmarshal(answer, &a) != nil || len(a.Value) == 0 || string(a.Value) == "null" {
		return Result{}, AnswerError{"нужно поле answer.value"}
	}

	var ok bool
	switch c.AnswerKind {
	case "single_choice":
		var want, got string
		_ = json.Unmarshal(c.Correct, &want)
		if json.Unmarshal(a.Value, &got) != nil {
			return Result{}, AnswerError{"answer.value: ожидается id варианта строкой"}
		}
		ok = got == want
	case "multi_choice":
		var want, got []string
		_ = json.Unmarshal(c.Correct, &want)
		if json.Unmarshal(a.Value, &got) != nil {
			return Result{}, AnswerError{"answer.value: ожидается список id вариантов"}
		}
		slices.Sort(want)
		slices.Sort(got)
		ok = slices.Equal(slices.Compact(want), slices.Compact(got))
	case "number":
		var want string
		_ = json.Unmarshal(c.Correct, &want)
		wantN, _ := parseNumber(want)
		gotN, parsed := parseNumber(rawToString(a.Value))
		if !parsed {
			return Result{}, AnswerError{"answer.value: нужно ввести число"}
		}
		ok = math.Abs(wantN-gotN) < 1e-9
	case "text":
		got := normalizeText(rawToString(a.Value))
		for _, alt := range textAlternatives(c.Correct) {
			if normalizeText(alt) == got {
				ok = true
			}
		}
	}
	if ok {
		return Result{Status: "passed"}, nil
	}
	return Result{Status: "failed", Hint: c.Hint}, nil
}

// ---------- tests: код на Python прогоняется по тестам ----------

type testCase struct {
	Input   string `json:"input"`
	Output  string `json:"output"`
	Visible bool   `json:"visible"`
}

type testsCheck struct {
	Language          string     `json:"language"`
	Tests             []testCase `json:"tests"`
	ReferenceSolution string     `json:"reference_solution"`
}

type limits struct {
	TimeMS   int `json:"time_ms"`
	MemoryMB int `json:"memory_mb"`
}

func limitsOf(content json.RawMessage) limits {
	var c struct {
		Limits limits `json:"limits"`
	}
	_ = json.Unmarshal(content, &c)
	if c.Limits.TimeMS <= 0 {
		c.Limits.TimeMS = 1000
	}
	if c.Limits.MemoryMB <= 0 {
		c.Limits.MemoryMB = 256
	}
	return c.Limits
}

type testsChecker struct{}

func (testsChecker) Title() string {
	return "Автоматическая: прогон по тестам"
}

func (testsChecker) ConfigFields() []Field {
	return []Field{
		{Name: "language", Kind: "select", Label: "Язык", Required: true, Options: []Option{{ID: "python3", Text: "Python 3"}}},
		{Name: "tests", Kind: "tests", Label: "Тесты: input, output, visible (виден ли ученику как пример)", Required: true},
		{Name: "reference_solution", Kind: "code", Label: "Эталонное решение (видит только куратор)", Language: "python3"},
	}
}

func (testsChecker) Validate(_, check json.RawMessage) error {
	var c testsCheck
	if err := json.Unmarshal(check, &c); err != nil {
		return fmt.Errorf("check: %v", err)
	}
	if c.Language != "python3" {
		return fmt.Errorf("check.language: пока поддерживается только python3")
	}
	if len(c.Tests) == 0 {
		return fmt.Errorf("check.tests: нужен хотя бы один тест")
	}
	return nil
}

func (testsChecker) SubmitFields(_, _ json.RawMessage) []Field {
	return []Field{{Name: "code", Kind: "code", Label: "Решение", Required: true, Language: "python3"}}
}

func (testsChecker) Public(content, check json.RawMessage) map[string]any {
	var c testsCheck
	_ = json.Unmarshal(check, &c)
	samples := []map[string]string{}
	for _, t := range c.Tests {
		if t.Visible {
			samples = append(samples, map[string]string{"input": t.Input, "output": t.Output})
		}
	}
	return map[string]any{
		"samples":     samples,
		"tests_total": len(c.Tests),
		"limits":      limitsOf(content),
		"language":    "python3",
	}
}

func (testsChecker) Check(ctx context.Context, content, check, answer json.RawMessage) (Result, error) {
	var c testsCheck
	if err := json.Unmarshal(check, &c); err != nil {
		return Result{}, err
	}
	var a struct {
		Code string `json:"code"`
	}
	if json.Unmarshal(answer, &a) != nil || strings.TrimSpace(a.Code) == "" {
		return Result{}, AnswerError{"нужно поле answer.code с решением"}
	}
	cases := make([]runner.TestCase, len(c.Tests))
	for i, t := range c.Tests {
		cases[i] = runner.TestCase{Input: t.Input, Expected: t.Output, Visible: t.Visible}
	}
	lim := limitsOf(content)
	results, err := runner.RunPython(ctx, a.Code, cases, lim.TimeMS)
	if err != nil {
		return Result{}, err
	}
	status := "passed"
	for _, r := range results {
		if r.Verdict != "OK" {
			status = "failed"
		}
	}
	return Result{Status: status, Tests: results}, nil
}

// ---------- manual: работу проверяет куратор ----------

type manualCheck struct {
	SubmitFields []Field  `json:"submit_fields"`
	Criteria     []string `json:"criteria"`
}

var manualFieldKinds = []string{"text", "link", "file", "number", "code"}

type manualChecker struct{}

func (manualChecker) Title() string { return "Ручная: проверяет куратор" }

func (manualChecker) ConfigFields() []Field {
	return []Field{
		{Name: "submit_fields", Kind: "fields", Label: "Что сдаёт ученик: список полей (kind: text, link, file, number, code)", Required: true},
		{Name: "criteria", Kind: "list", Label: "Критерии проверки для куратора"},
	}
}

func (manualChecker) Validate(_, check json.RawMessage) error {
	var c manualCheck
	if err := json.Unmarshal(check, &c); err != nil {
		return fmt.Errorf("check: %v", err)
	}
	if len(c.SubmitFields) == 0 {
		return fmt.Errorf("check.submit_fields: укажите, что сдаёт ученик")
	}
	seen := map[string]bool{}
	for _, f := range c.SubmitFields {
		if f.Name == "" || seen[f.Name] {
			return fmt.Errorf("check.submit_fields: у каждого поля нужно уникальное name")
		}
		seen[f.Name] = true
		if !slices.Contains(manualFieldKinds, f.Kind) {
			return fmt.Errorf("check.submit_fields.%s: kind должен быть одним из %v", f.Name, manualFieldKinds)
		}
	}
	return nil
}

func (manualChecker) SubmitFields(_, check json.RawMessage) []Field {
	var c manualCheck
	_ = json.Unmarshal(check, &c)
	return c.SubmitFields
}

func (manualChecker) Public(_, _ json.RawMessage) map[string]any { return nil }

func (manualChecker) Check(_ context.Context, _, check, answer json.RawMessage) (Result, error) {
	var c manualCheck
	if err := json.Unmarshal(check, &c); err != nil {
		return Result{}, err
	}
	var a map[string]json.RawMessage
	if json.Unmarshal(answer, &a) != nil {
		return Result{}, AnswerError{"answer должен быть объектом"}
	}
	for _, f := range c.SubmitFields {
		v := strings.TrimSpace(rawToString(a[f.Name]))
		if v == "" || v == "null" {
			if f.Required {
				return Result{}, AnswerError{fmt.Sprintf("заполните поле «%s»", f.Label)}
			}
			continue
		}
		if f.Kind == "link" && !strings.HasPrefix(v, "http://") && !strings.HasPrefix(v, "https://") {
			return Result{}, AnswerError{fmt.Sprintf("«%s»: ссылка должна начинаться с http:// или https://", f.Label)}
		}
	}
	return Result{Status: "pending"}, nil
}

// ---------- вспомогательные функции ----------

func rawToString(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return strings.TrimSpace(string(raw)) // число пришло без кавычек
}

func parseNumber(s string) (float64, bool) {
	s = strings.ReplaceAll(strings.TrimSpace(s), ",", ".")
	s = strings.ReplaceAll(s, "−", "-") // «типографский» минус
	f, err := strconv.ParseFloat(s, 64)
	return f, err == nil
}

func normalizeText(s string) string {
	return strings.ToLower(strings.Join(strings.Fields(s), " "))
}

func textAlternatives(raw json.RawMessage) []string {
	var one string
	if json.Unmarshal(raw, &one) == nil && one != "" {
		return []string{one}
	}
	var many []string
	_ = json.Unmarshal(raw, &many)
	return many
}
