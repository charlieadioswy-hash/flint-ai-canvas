package app

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

type DramaSourceExportChapter struct {
	ID string `json:"id"`
	DramaChapterInput
}

type DramaSourceExport struct {
	Revision      int64                      `json:"revision"`
	SourceFormat  string                     `json:"sourceFormat"`
	ReferenceText string                     `json:"referenceText"`
	Chapters      []DramaSourceExportChapter `json:"chapters"`
}

func (s *Service) DramaSourceExport(userID, projectID string) (DramaSourceExport, error) {
	rows, err := s.repo.DramaSourceExport(userID, strings.TrimSpace(projectID))
	if err != nil {
		return DramaSourceExport{}, dramaLookupError(err)
	}
	source := DramaSourceExport{
		Revision: rows[0].Revision, SourceFormat: production.NormalizeSourceFormat(rows[0].SourceType),
		Chapters: make([]DramaSourceExportChapter, 0, len(rows)),
	}
	for _, row := range rows {
		switch row.Kind {
		case model.ProjectUnitKindChapter:
			source.Chapters = append(source.Chapters, DramaSourceExportChapter{ID: row.ID, DramaChapterInput: DramaChapterInput{Title: row.Title, Text: row.SourceText}})
		case model.ProjectUnitKindSourceReference:
			source.ReferenceText = row.SourceText
		}
	}
	return source, nil
}

func dramaSourceReferenceUnit(projectID, input string, now time.Time) (*model.ProjectUnit, error) {
	text := strings.TrimSpace(strings.ReplaceAll(input, "\r\n", "\n"))
	if text == "" {
		return nil, nil
	}
	runes := utf8.RuneCountInString(text)
	if runes > production.ScriptSourceChapterRunes {
		return nil, BadAuthRequest(fmt.Sprintf("作品参考资料不能超过 %d 字", production.ScriptSourceChapterRunes))
	}
	return &model.ProjectUnit{
		ID: newID(), ProjectID: projectID, Kind: model.ProjectUnitKindSourceReference,
		Title: "作品参考资料", SourceText: text, WordCount: runes, Status: model.ProjectUnitStatusReady,
		CreatedAt: now, UpdatedAt: now,
	}, nil
}
