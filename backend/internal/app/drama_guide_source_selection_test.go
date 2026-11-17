package app

import (
	"strings"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

type guideChapterView struct {
	ID     string
	Title  string
	Text   string
	Status model.ProjectUnitStatus
}

type guideEpisodeView struct {
	ID           string
	SourceFormat string
	ChapterIDs   []string
}

func loadGuideChapters(t *testing.T, svc *Service, projectID string) []guideChapterView {
	t.Helper()
	rows, err := svc.repo.DramaGuideSourceChapters(projectID)
	if err != nil {
		t.Fatal(err)
	}
	views := make([]guideChapterView, len(rows))
	for i, row := range rows {
		views[i] = guideChapterView{ID: row.ID, Title: row.Title, Text: row.SourceText, Status: row.Status}
	}
	return views
}

func loadGuideEpisodes(t *testing.T, svc *Service, summary DramaSummary) []guideEpisodeView {
	t.Helper()
	views := make([]guideEpisodeView, 0, len(summary.Episodes))
	for _, episode := range summary.Episodes {
		row, err := svc.repo.DramaEpisode(summary.Project.ID, episode.ID)
		if err != nil {
			t.Fatal(err)
		}
		views = append(views, guideEpisodeView{
			ID:           row.ID,
			SourceFormat: string(row.SourceFormat),
			ChapterIDs:   decodeStringList(row.ChapterIDsJSON),
		})
	}
	return views
}

func sameStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func countDramaEpisodes(t *testing.T, fake *fakeDramaBackend, projectID string) int64 {
	t.Helper()
	var count int64
	if err := fake.db.Model(&model.DramaEpisode{}).Where("project_id = ?", projectID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	return count
}

// 只改素材类型时保留所有章 ID 与原文；旧客户端选章字段不再缩减分集目录。
func TestDramaGuideSourceSelectionSwitchesFormatWithoutLosingChapters(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc,
		DramaChapterInput{Title: "甲", Text: "甲原文"},
		DramaChapterInput{Title: "乙", Text: "乙原文"},
		DramaChapterInput{Title: "丙", Text: "丙原文"},
	)
	projectID := draft.Project.ID
	before := loadGuideChapters(t, svc, projectID)
	if len(before) != 3 || len(draft.Episodes) != 3 {
		t.Fatalf("guided project must start with one episode per chapter: chapters=%d episodes=%d", len(before), len(draft.Episodes))
	}
	requestsBefore := len(fake.requests)

	next, err := svc.UpdateDramaGuideSource("usr-drama", projectID, UpdateDramaGuideSourceRequest{
		ExpectedRevision: draft.Production.Revision,
		SourceFormat:     production.SourceScript,
		SelectedChapters: []int{0, 2},
	})
	if err != nil {
		t.Fatal(err)
	}
	if next.Production.Revision != draft.Production.Revision+1 {
		t.Fatalf("source save must bump the shared revision once: got %d want %d", next.Production.Revision, draft.Production.Revision+1)
	}
	if next.Production.GuideStep != draft.Production.GuideStep {
		t.Fatalf("source save must not change the guide step: before=%s after=%s", draft.Production.GuideStep, next.Production.GuideStep)
	}
	if next.Production.Settings.EpisodeMode != DramaEpisodeModeChapter || next.Production.Settings.ChaptersPerEpisode != 1 {
		t.Fatalf("script source must force one chapter per episode: %+v", next.Production.Settings)
	}
	if len(fake.requests) != requestsBefore {
		t.Fatalf("source save must not start generation: %d requests", len(fake.requests))
	}

	saved := guideSummary(t, svc, projectID)
	if saved.Production.Revision != next.Production.Revision || saved.Production.GuideStep != draft.Production.GuideStep {
		t.Fatalf("persisted production drifted: %+v", saved.Production)
	}
	if saved.Production.Settings.EpisodeMode != DramaEpisodeModeChapter || saved.Production.Settings.ChaptersPerEpisode != 1 {
		t.Fatalf("episode settings must be persisted: %+v", saved.Production.Settings)
	}
	after := loadGuideChapters(t, svc, projectID)
	wantStatus := []model.ProjectUnitStatus{model.ProjectUnitStatusReady, model.ProjectUnitStatusReady, model.ProjectUnitStatusReady}
	if len(after) != len(wantStatus) {
		t.Fatalf("metadata save must keep all chapters: %+v", after)
	}
	for i, row := range after {
		if row.ID != before[i].ID || row.Title != before[i].Title || row.Text != before[i].Text || row.Status != wantStatus[i] {
			t.Fatalf("chapter %d must keep its id and text in the complete catalog: before=%+v after=%+v", i, before[i], row)
		}
	}
	if len(saved.Episodes) != 3 || countDramaEpisodes(t, fake, projectID) != 3 {
		t.Fatalf("all three chapters must have episodes: summary=%d stored=%d", len(saved.Episodes), countDramaEpisodes(t, fake, projectID))
	}
	episodes := loadGuideEpisodes(t, svc, saved)
	wantRefs := []string{before[0].ID, before[1].ID, before[2].ID}
	for i, episode := range episodes {
		if episode.SourceFormat != string(production.SourceScript) || !sameStrings(episode.ChapterIDs, []string{wantRefs[i]}) {
			t.Fatalf("episode %d must reference its original script chapter: %+v", i, episode)
		}
		if _, err := svc.repo.DramaChaptersByIDs(projectID, episode.ChapterIDs); err != nil {
			t.Fatal(err)
		}
	}
	confirmed := confirmGuide(t, svc, saved)
	if len(confirmed.Episodes) != 3 {
		t.Fatalf("configuration confirmation lost catalog episodes: %+v", confirmed.Episodes)
	}
	runDramaTicks(t, svc, projectID, 2)
	completeSourceRead := false
	for _, request := range fake.requests {
		if strings.Contains(request.Prompt, "甲原文") && strings.Contains(request.Prompt, "乙原文") && strings.Contains(request.Prompt, "丙原文") {
			completeSourceRead = true
		}
	}
	if !completeSourceRead {
		t.Fatal("asset extraction must read all catalog source after explicit confirmation")
	}
}

func TestDramaGuideSourceSelectionRejectsInvalidUpdates(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc,
		DramaChapterInput{Title: "甲", Text: "甲原文"},
		DramaChapterInput{Title: "乙", Text: "乙原文"},
		DramaChapterInput{Title: "丙", Text: "丙原文"},
	)
	projectID := draft.Project.ID
	chaptersBefore := loadGuideChapters(t, svc, projectID)
	episodesBefore := loadGuideEpisodes(t, svc, draft)
	requestsBefore := len(fake.requests)
	assertUnchanged := func(t *testing.T) {
		t.Helper()
		current := guideSummary(t, svc, projectID)
		if current.Production.Revision != draft.Production.Revision || current.Production.GuideStep != draft.Production.GuideStep {
			t.Fatalf("rejected source update changed production: %+v", current.Production)
		}
		if !sameChapterViews(chaptersBefore, loadGuideChapters(t, svc, projectID)) {
			t.Fatalf("rejected source update changed chapters: %+v", loadGuideChapters(t, svc, projectID))
		}
		if !sameEpisodeViews(episodesBefore, loadGuideEpisodes(t, svc, current)) || countDramaEpisodes(t, fake, projectID) != int64(len(episodesBefore)) {
			t.Fatalf("rejected source update changed episodes: %+v", loadGuideEpisodes(t, svc, current))
		}
		if len(fake.requests) != requestsBefore {
			t.Fatalf("rejected source update started generation: %d requests", len(fake.requests))
		}
	}

	t.Run("unknown format", func(t *testing.T) {
		_, err := svc.UpdateDramaGuideSource("usr-drama", projectID, UpdateDramaGuideSourceRequest{
			ExpectedRevision: draft.Production.Revision,
			SourceFormat:     "comic",
			SelectedChapters: []int{0},
		})
		if err == nil {
			t.Fatal("unknown source format must be rejected")
		}
		assertUnchanged(t)
	})
	t.Run("empty replacement", func(t *testing.T) {
		_, err := svc.UpdateDramaGuideSource("usr-drama", projectID, UpdateDramaGuideSourceRequest{
			ExpectedRevision: draft.Production.Revision,
			Chapters:         []DramaChapterInput{},
		})
		if err == nil {
			t.Fatal("empty source replacement must be rejected")
		}
		assertUnchanged(t)
	})
	t.Run("foreign owner", func(t *testing.T) {
		_, err := svc.UpdateDramaGuideSource("other-user", projectID, UpdateDramaGuideSourceRequest{
			ExpectedRevision: draft.Production.Revision,
			Chapters:         []DramaChapterInput{{Title: "替换", Text: "新正文"}},
		})
		if err == nil {
			t.Fatal("a foreign owner cannot replace source")
		}
		assertUnchanged(t)
	})
	t.Run("stale revision", func(t *testing.T) {
		_, err := svc.UpdateDramaGuideSource("usr-drama", projectID, UpdateDramaGuideSourceRequest{
			ExpectedRevision: draft.Production.Revision - 1,
			SourceFormat:     production.SourceScript,
			SelectedChapters: []int{0},
		})
		requireGuideConflict(t, err)
		assertUnchanged(t)
	})
	t.Run("wrong stage", func(t *testing.T) {
		if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("guide_step", model.DramaGuideAssets).Error; err != nil {
			t.Fatal(err)
		}
		_, err := svc.UpdateDramaGuideSource("usr-drama", projectID, UpdateDramaGuideSourceRequest{
			ExpectedRevision: draft.Production.Revision,
			SourceFormat:     production.SourceScript,
			SelectedChapters: []int{0},
		})
		if err == nil {
			t.Fatal("source metadata must remain locked after configuration")
		}
		current := guideSummary(t, svc, projectID)
		if current.Production.Revision != draft.Production.Revision || current.Production.GuideStep != model.DramaGuideAssets {
			t.Fatalf("stage rejection must not write source changes: %+v", current.Production)
		}
		if !sameChapterViews(chaptersBefore, loadGuideChapters(t, svc, projectID)) || !sameEpisodeViews(episodesBefore, loadGuideEpisodes(t, svc, current)) {
			t.Fatal("stage rejection must leave chapters and episodes untouched")
		}
		if len(fake.requests) != requestsBefore {
			t.Fatalf("stage rejection started generation: %d requests", len(fake.requests))
		}
	})
}

func TestDramaGuideSourceSelectionCannotHideOversizedChapter(t *testing.T) {
	svc, fake := newDramaTestService(t)
	longText := strings.Repeat("长", 13000)
	settings := DramaSettings{ReviewMode: DramaReviewAuto, MediaMode: DramaMediaManual, Models: fakeDramaModels, EpisodeMode: DramaEpisodeModeChapter, ChaptersPerEpisode: 1}
	_, err := svc.CreateDrama("usr-drama", CreateDramaRequest{
		Name:             "全量长度校验",
		Guided:           true,
		Settings:         settings,
		Chapters:         []DramaChapterInput{{Title: "短章", Text: "短正文"}, {Title: "长章", Text: longText}},
		SelectedChapters: []int{0},
	})
	if err == nil {
		t.Fatal("legacy selection cannot bypass the source length limit on creation")
	}
	created := createGuidedDrama(t, svc, DramaChapterInput{Title: "甲", Text: "甲原文"}, DramaChapterInput{Title: "乙", Text: "乙原文"})
	projectID := created.Project.ID
	chapters := loadGuideChapters(t, svc, projectID)
	episodes := loadGuideEpisodes(t, svc, created)
	requestsBefore := len(fake.requests)
	_, err = svc.UpdateDramaGuideSource("usr-drama", projectID, UpdateDramaGuideSourceRequest{
		ExpectedRevision: created.Production.Revision,
		SourceFormat:     production.SourceStoryboard,
		Chapters:         []DramaChapterInput{{Title: "短章", Text: "短正文"}, {Title: "长章", Text: longText}},
		SelectedChapters: []int{0},
	})
	if err == nil {
		t.Fatal("legacy selection cannot bypass the source length limit on replacement")
	}
	after := guideSummary(t, svc, projectID)
	if after.Production.Revision != created.Production.Revision || after.Production.GuideStep != created.Production.GuideStep {
		t.Fatalf("rejected source must roll back the production: %+v", after.Production)
	}
	if after.Production.Settings.EpisodeMode != created.Production.Settings.EpisodeMode || after.Production.Settings.ChaptersPerEpisode != created.Production.Settings.ChaptersPerEpisode || after.Project.SourceType != created.Project.SourceType {
		t.Fatalf("rejected source must keep original source format and episode settings: %+v", after)
	}
	if !sameChapterViews(chapters, loadGuideChapters(t, svc, projectID)) || !sameEpisodeViews(episodes, loadGuideEpisodes(t, svc, after)) {
		t.Fatal("rejected source must not change chapters or episode references")
	}
	if len(fake.requests) != requestsBefore {
		t.Fatalf("rejected source started generation: %d requests", len(fake.requests))
	}
}

func TestDramaGuideSourceReplacementKeepsEveryChapterText(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc, DramaChapterInput{Title: "旧章节", Text: "旧正文"})
	projectID := draft.Project.ID
	oldEpisodeID := draft.Episodes[0].ID
	requestsBefore := len(fake.requests)
	next, err := svc.UpdateDramaGuideSource("usr-drama", projectID, UpdateDramaGuideSourceRequest{
		ExpectedRevision: draft.Production.Revision,
		SourceFormat:     production.SourceStoryboard,
		Chapters: []DramaChapterInput{
			{Title: "新一", Text: "保留甲"},
			{Title: "新二", Text: "选中乙"},
			{Title: "新三", Text: "保留丙"},
			{Title: "新四", Text: "选中丁"},
		},
		SelectedChapters: []int{1, 3},
	})
	if err != nil {
		t.Fatal(err)
	}
	if next.Production.Revision != draft.Production.Revision+1 || next.Production.GuideStep != draft.Production.GuideStep {
		t.Fatalf("replacement must bump revision without leaving configuration: %+v", next.Production)
	}
	if next.Production.Settings.EpisodeMode != DramaEpisodeModeChapter || next.Production.Settings.ChaptersPerEpisode != 1 {
		t.Fatalf("storyboard replacement must produce one episode per chapter: %+v", next.Production.Settings)
	}
	if len(fake.requests) != requestsBefore {
		t.Fatalf("replacement must not start generation: %d requests", len(fake.requests))
	}
	chapters := loadGuideChapters(t, svc, projectID)
	want := []guideChapterView{
		{Title: "新一", Text: "保留甲", Status: model.ProjectUnitStatusReady},
		{Title: "新二", Text: "选中乙", Status: model.ProjectUnitStatusReady},
		{Title: "新三", Text: "保留丙", Status: model.ProjectUnitStatusReady},
		{Title: "新四", Text: "选中丁", Status: model.ProjectUnitStatusReady},
	}
	if len(chapters) != len(want) {
		t.Fatalf("replacement must store every submitted chapter: %+v", chapters)
	}
	seen := map[string]bool{}
	for i, row := range chapters {
		if row.ID == "" || seen[row.ID] || row.Title != want[i].Title || row.Text != want[i].Text || row.Status != want[i].Status {
			t.Fatalf("chapter %d was not stored in the complete catalog: %+v", i, row)
		}
		seen[row.ID] = true
		if row.Text == "旧正文" {
			t.Fatal("replaced source text must not remain")
		}
	}
	saved := guideSummary(t, svc, projectID)
	if len(saved.Episodes) != 4 || countDramaEpisodes(t, fake, projectID) != 4 {
		t.Fatalf("all four replacement chapters must become episodes: %d", len(saved.Episodes))
	}
	for _, episode := range saved.Episodes {
		if episode.ID == oldEpisodeID {
			t.Fatal("replacement must not keep the previous episode reference")
		}
	}
	if _, err := svc.repo.DramaEpisode(projectID, oldEpisodeID); err == nil {
		t.Fatal("previous episode row must be removed with the replaced source")
	}
	episodes := loadGuideEpisodes(t, svc, saved)
	wantRefs := []string{chapters[0].ID, chapters[1].ID, chapters[2].ID, chapters[3].ID}
	for i, episode := range episodes {
		if episode.SourceFormat != string(production.SourceStoryboard) || !sameStrings(episode.ChapterIDs, []string{wantRefs[i]}) {
			t.Fatalf("episode %d must reference its storyboard chapter: %+v", i, episode)
		}
		if _, err := svc.repo.DramaChaptersByIDs(projectID, episode.ChapterIDs); err != nil {
			t.Fatal(err)
		}
	}
}

func TestDramaGuideSourceMetadataKeepsCompleteCatalog(t *testing.T) {
	svc, fake := newDramaTestService(t)
	settings := DramaSettings{ReviewMode: DramaReviewAuto, MediaMode: DramaMediaManual, Models: fakeDramaModels, EpisodeMode: DramaEpisodeModeChapter, ChaptersPerEpisode: 1}
	created, err := svc.CreateDrama("usr-drama", CreateDramaRequest{
		Name:             "保留完整目录",
		Guided:           true,
		Settings:         settings,
		Chapters:         []DramaChapterInput{{Title: "甲", Text: "甲原文"}, {Title: "乙", Text: "乙原文"}, {Title: "丙", Text: "丙原文"}},
		SelectedChapters: []int{1},
	})
	if err != nil {
		t.Fatal(err)
	}
	projectID := created.Project.ID
	before := loadGuideChapters(t, svc, projectID)
	if len(created.Episodes) != 3 || len(before) != 3 {
		t.Fatalf("legacy selection on create must not shrink the catalog: episodes=%d chapters=%+v", len(created.Episodes), before)
	}
	for _, chapter := range before {
		if chapter.Status != model.ProjectUnitStatusReady {
			t.Fatalf("every source chapter must be part of the catalog: %+v", chapter)
		}
	}
	requestsBefore := len(fake.requests)
	next, err := svc.UpdateDramaGuideSource("usr-drama", projectID, UpdateDramaGuideSourceRequest{
		ExpectedRevision: created.Production.Revision,
		SourceFormat:     production.SourceNovel,
	})
	if err != nil {
		t.Fatal(err)
	}
	if next.Production.Revision != created.Production.Revision+1 || next.Production.GuideStep != created.Production.GuideStep {
		t.Fatalf("omitted selection must still save format and revision: %+v", next.Production)
	}
	if len(fake.requests) != requestsBefore {
		t.Fatalf("format-only save must not generate: %d requests", len(fake.requests))
	}
	after := loadGuideChapters(t, svc, projectID)
	if len(after) != 3 {
		t.Fatalf("omitted selection must keep every chapter: %+v", after)
	}
	for i, row := range after {
		if row.ID != before[i].ID || row.Title != before[i].Title || row.Text != before[i].Text || row.Status != before[i].Status {
			t.Fatalf("omitted selection changed chapter %d: before=%+v after=%+v", i, before[i], row)
		}
	}
	saved := guideSummary(t, svc, projectID)
	episodes := loadGuideEpisodes(t, svc, saved)
	if len(episodes) != 3 || countDramaEpisodes(t, fake, projectID) != 3 {
		t.Fatalf("omitted selection must keep every catalog episode: %+v", episodes)
	}
	for i, episode := range episodes {
		if episode.SourceFormat != string(production.SourceNovel) || !sameStrings(episode.ChapterIDs, []string{before[i].ID}) {
			t.Fatalf("episode %d must keep its own source reference: %+v", i, episode)
		}
		if _, err := svc.repo.DramaChaptersByIDs(projectID, episode.ChapterIDs); err != nil {
			t.Fatal(err)
		}
	}
}

func TestDramaGuideSourceSelectionLegacyFieldsCannotShrinkCatalog(t *testing.T) {
	for _, tc := range []struct {
		name     string
		selected []int
	}{
		{name: "omitted"},
		{name: "empty", selected: []int{}},
		{name: "partial", selected: []int{1}},
		{name: "obsolete indexes", selected: []int{-1, 99}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			created := createGuidedDrama(t, svc, DramaChapterInput{Title: "旧", Text: "旧原文"})
			updated, err := svc.UpdateDramaGuideSource("usr-drama", created.Project.ID, UpdateDramaGuideSourceRequest{
				ExpectedRevision: created.Production.Revision,
				Chapters:         []DramaChapterInput{{Title: "甲", Text: "甲原文"}, {Title: "乙", Text: "乙原文"}, {Title: "丙", Text: "丙原文"}},
				SelectedChapters: tc.selected,
			})
			if err != nil {
				t.Fatal(err)
			}
			if len(updated.Episodes) != 3 || updated.Production.ChapterCount != 3 || updated.Production.ReservedChapterCount != 0 || updated.Production.Revision != created.Production.Revision+1 {
				t.Fatalf("legacy selection cannot change the full-source contract: %+v", updated)
			}
			chapters := loadGuideChapters(t, svc, created.Project.ID)
			episodes := loadGuideEpisodes(t, svc, updated)
			for i, chapter := range chapters {
				if chapter.Status != model.ProjectUnitStatusReady || !sameStrings(episodes[i].ChapterIDs, []string{chapter.ID}) {
					t.Fatalf("every source needs its matching catalog episode: chapter=%+v episode=%+v", chapter, episodes[i])
				}
			}
			if len(fake.requests) != 0 {
				t.Fatal("saving the complete catalog must not invoke models")
			}
		})
	}
}

func sameChapterViews(left, right []guideChapterView) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func sameEpisodeViews(left, right []guideEpisodeView) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i].ID != right[i].ID || left[i].SourceFormat != right[i].SourceFormat || !sameStrings(left[i].ChapterIDs, right[i].ChapterIDs) {
			return false
		}
	}
	return true
}
