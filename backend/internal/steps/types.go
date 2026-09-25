// Пакет steps — сердце платформы: типы шагов и способы их проверки.
//
// Шаг описывается двумя независимыми вещами:
//
//   - Тип (Type) — как шаг выглядит у ученика: теория, вопрос, Scratch, Minecraft, задача, проект.
//     Тип — это просто запись в реестре: название, какие поля есть в content, какие способы
//     проверки допустимы.
//   - Способ проверки (Checker) — как шаг проверяется: none (прочитал — засчитано),
//     answer (сверка ответа), tests (прогон кода по тестам), manual (куратор).
//
// Чтобы добавить новый тип шага, достаточно одной записи в Types ниже — база данных,
// API и фронтенд не меняются. Администратор может добавить тип и вообще без кода:
// POST /api/admin/step-types (такие типы хранятся в таблице step_types).
// Новый способ проверки — это новая реализация Checker.
package steps

import (
	"encoding/json"
	"fmt"
	"slices"
)

// Field описывает одно поле формы: и в конструкторе курса у админа, и в форме сдачи у ученика.
type Field struct {
	Name     string   `json:"name"`
	Kind     string   `json:"kind"`
	Label    string   `json:"label"`
	Required bool     `json:"required,omitempty"`
	Accept   string   `json:"accept,omitempty"`   // для kind=file: какие файлы принимаем
	Language string   `json:"language,omitempty"` // для kind=code
	Options  []Option `json:"options,omitempty"`  // для single_choice / multi_choice
}

// Option — вариант ответа в вопросе.
type Option struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

// Type — тип шага.
type Type struct {
	Name          string   `json:"type"`
	Title         string   `json:"title"`
	Icon          string   `json:"icon"`
	Description   string   `json:"description"`
	CheckModes    []string `json:"check_modes"`
	ContentFields []Field  `json:"content_fields"`
	Custom        bool     `json:"custom"` // добавлен администратором через API, а не в коде
}

// Types — реестр типов шагов. Порядок важен только для отображения в конструкторе.
var Types = []Type{
	{
		Name:        "theory",
		Icon:        "T",
		Title:       "Теория",
		Description: "Текст с примерами. Засчитывается при прочтении.",
		CheckModes:  []string{"none"},
		ContentFields: []Field{
			{Name: "body_md", Kind: "markdown", Label: "Текст", Required: true},
		},
	},
	{
		Name:        "quiz",
		Icon:        "?",
		Title:       "Контрольный вопрос",
		Description: "Один верный вариант, несколько верных или короткий ответ числом.",
		CheckModes:  []string{"answer"},
		ContentFields: []Field{
			{Name: "question_md", Kind: "markdown", Label: "Вопрос", Required: true},
			{Name: "program", Kind: "code_block", Label: "Программа к вопросу (необязательно)"},
			{Name: "options", Kind: "options", Label: "Варианты ответа (для выбора)"},
		},
	},
	{
		Name:        "scratch",
		Icon:        "S",
		Title:       "Scratch",
		Description: "Разбор блочной программы: ответ числом (автоматически) или изменённый проект по ссылке (куратор).",
		CheckModes:  []string{"answer", "manual"},
		ContentFields: []Field{
			{Name: "body_md", Kind: "markdown", Label: "Вводный текст"},
			{Name: "program", Kind: "code_block", Label: "Блочная программа (одна строка — один блок)"},
			{Name: "task_md", Kind: "markdown", Label: "Задание", Required: true},
		},
	},
	{
		Name:        "minecraft",
		Icon:        "M",
		Title:       "Minecraft Education",
		Description: "Задание внутри мира Minecraft, программа из блоков MakeCode. Проверяет куратор.",
		CheckModes:  []string{"manual"},
		ContentFields: []Field{
			{Name: "world_md", Kind: "markdown", Label: "Подготовка мира"},
			{Name: "task_md", Kind: "markdown", Label: "Задание", Required: true},
			{Name: "program", Kind: "code_block", Label: "Программа-пример (необязательно)"},
			{Name: "blocks_md", Kind: "markdown", Label: "Какие блоки понадобятся"},
			{Name: "deliverables_md", Kind: "markdown", Label: "Что сдать"},
		},
	},
	{
		Name:        "code",
		Icon:        "⌘",
		Title:       "Задача с тестами",
		Description: "Код на Python прогоняется по набору тестов.",
		CheckModes:  []string{"tests"},
		ContentFields: []Field{
			{Name: "statement_md", Kind: "markdown", Label: "Условие", Required: true},
			{Name: "input_md", Kind: "markdown", Label: "Входные данные"},
			{Name: "output_md", Kind: "markdown", Label: "Выходные данные"},
			{Name: "notes_md", Kind: "markdown", Label: "Примечание"},
			{Name: "limits", Kind: "limits", Label: "Ограничения: time_ms, memory_mb"},
		},
	},
	{
		Name:        "project",
		Icon:        "P",
		Title:       "Проект",
		Description: "Самостоятельная работа по критериям, проверяет куратор.",
		CheckModes:  []string{"manual"},
		ContentFields: []Field{
			{Name: "body_md", Kind: "markdown", Label: "Описание", Required: true},
			{Name: "requirements", Kind: "list", Label: "Что должно быть в работе"},
			{Name: "hints_md", Kind: "markdown", Label: "Подсказки"},
		},
	},
}

// CustomTypes возвращает типы, которые администратор добавил через API (хранятся в базе).
// Функцию подставляет пакет api при старте сервера.
var CustomTypes func() []Type

// AllTypes — встроенные типы и типы, добавленные администратором.
func AllTypes() []Type {
	all := append([]Type{}, Types...)
	if CustomTypes != nil {
		all = append(all, CustomTypes()...)
	}
	return all
}

// FindType ищет тип по имени.
func FindType(name string) (Type, bool) {
	for _, t := range AllTypes() {
		if t.Name == name {
			return t, true
		}
	}
	return Type{}, false
}

// checkHeader — общая часть любого check_json: какой способ проверки выбран.
type checkHeader struct {
	Mode string `json:"mode"`
}

// ModeOf достаёт способ проверки из check_json.
func ModeOf(check json.RawMessage) string {
	var h checkHeader
	_ = json.Unmarshal(check, &h)
	return h.Mode
}

// Validate проверяет шаг перед сохранением: тип известен, способ проверки допустим,
// обязательные поля содержания заполнены, настройки проверки корректны.
func Validate(typeName string, content, check json.RawMessage) error {
	t, ok := FindType(typeName)
	if !ok {
		return fmt.Errorf("неизвестный тип шага %q", typeName)
	}
	var c map[string]any
	if err := json.Unmarshal(content, &c); err != nil {
		return fmt.Errorf("content: должен быть JSON-объектом")
	}
	for _, f := range t.ContentFields {
		if !f.Required {
			continue
		}
		if s, _ := c[f.Name].(string); s == "" {
			return fmt.Errorf("content.%s: обязательное поле (%s)", f.Name, f.Label)
		}
	}
	mode := ModeOf(check)
	if !slices.Contains(t.CheckModes, mode) {
		return fmt.Errorf("check.mode: для типа %q допустимо %v, получено %q", typeName, t.CheckModes, mode)
	}
	checker, ok := Checkers[mode]
	if !ok {
		return fmt.Errorf("check.mode: неизвестный способ проверки %q", mode)
	}
	return checker.Validate(content, check)
}
