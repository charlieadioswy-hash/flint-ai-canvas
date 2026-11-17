package app

import (
	"encoding/json"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"yingce/backend/internal/model"
)

type dramaSourceAssetName struct {
	name string
	ids  map[string]struct{}
}

type dramaSourceAssetSpan struct {
	start int
	end   int
}

// dramaSourceAssetIDs recovers explicit name mentions in the linked originals.
// It does not establish on-screen appearances or persist episode membership.
// The caller must restrict both inputs to the authorized project and chapters.
func dramaSourceAssetIDs(chapters []model.ProjectUnit, casts []model.DramaCast) []string {
	namesByKind := make(map[string]map[string]map[string]struct{})
	for _, cast := range casts {
		if strings.TrimSpace(cast.ID) == "" || cast.ParentID != "" || !validDramaCastKind(cast.Kind) {
			continue
		}
		var aliases []string
		_ = json.Unmarshal([]byte(cast.AliasesJSON), &aliases)
		for _, name := range append(aliases, cast.Name) {
			name = dramaNormalizeSourceAssetText(name)
			if name == "" {
				continue
			}
			if namesByKind[cast.Kind] == nil {
				namesByKind[cast.Kind] = make(map[string]map[string]struct{})
			}
			if namesByKind[cast.Kind][name] == nil {
				namesByKind[cast.Kind][name] = make(map[string]struct{})
			}
			namesByKind[cast.Kind][name][cast.ID] = struct{}{}
		}
	}

	texts := make([]string, 0, len(chapters))
	for _, chapter := range chapters {
		if text := dramaNormalizeSourceAssetText(chapter.SourceText); text != "" {
			texts = append(texts, text)
		}
	}
	matched := make(map[string]struct{})
	for _, names := range namesByKind {
		patterns := make([]dramaSourceAssetName, 0, len(names))
		for name, ids := range names {
			patterns = append(patterns, dramaSourceAssetName{name: name, ids: ids})
		}
		sort.Slice(patterns, func(i, j int) bool {
			if len(patterns[i].name) != len(patterns[j].name) {
				return len(patterns[i].name) > len(patterns[j].name)
			}
			return patterns[i].name < patterns[j].name
		})
		for _, text := range texts {
			var occupied []dramaSourceAssetSpan
			for _, pattern := range patterns {
				for offset := 0; offset < len(text); {
					index := strings.Index(text[offset:], pattern.name)
					if index < 0 {
						break
					}
					start := offset + index
					end := start + len(pattern.name)
					_, width := utf8.DecodeRuneInString(text[start:])
					offset = start + width
					if !dramaSourceAssetWordBoundary(text, pattern.name, start, end) {
						continue
					}
					covered := false
					for _, span := range occupied {
						if span.start <= start && end <= span.end {
							covered = true
							break
						}
					}
					if covered {
						continue
					}
					// Ambiguous long names still prevent a contained short name
					// from being mistaken for a separate asset mention.
					occupied = append(occupied, dramaSourceAssetSpan{start: start, end: end})
					if len(pattern.ids) == 1 {
						for id := range pattern.ids {
							matched[id] = struct{}{}
						}
					}
				}
			}
		}
	}

	ids := make([]string, 0, len(matched))
	for _, cast := range casts {
		if _, ok := matched[cast.ID]; ok {
			ids = append(ids, cast.ID)
			delete(matched, cast.ID)
		}
	}
	return ids
}

func dramaNormalizeSourceAssetText(value string) string {
	value = strings.Map(func(r rune) rune {
		switch r {
		case '（':
			return '('
		case '）':
			return ')'
		}
		return unicode.ToLower(r)
	}, value)
	// Preserve punctuation and word separation: deleting them can invent a
	// name across sentences, or turn a prop blueprint into a different prop.
	return strings.Join(strings.Fields(value), " ")
}

func dramaSourceAssetWordBoundary(text, name string, start, end int) bool {
	first, _ := utf8.DecodeRuneInString(name)
	last, _ := utf8.DecodeLastRuneInString(name)
	if start > 0 && dramaSourceAssetLatinWord(first) {
		previous, _ := utf8.DecodeLastRuneInString(text[:start])
		if dramaSourceAssetLatinWord(previous) {
			return false
		}
	}
	if end < len(text) && dramaSourceAssetLatinWord(last) {
		next, _ := utf8.DecodeRuneInString(text[end:])
		if dramaSourceAssetLatinWord(next) {
			return false
		}
	}
	return true
}

func dramaSourceAssetLatinWord(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_'
}
