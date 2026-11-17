package app

import (
	"fmt"
	"sort"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"
)

// ensureDramaEpisodeCatalog 补齐旧引导作品缺失的目录项，不启动制作或覆盖已有集的内容。
func (s *Service) ensureDramaEpisodeCatalog(project *model.Project, p *model.DramaProduction) (bool, error) {
	if p.GuideStep == "" && p.Status == model.DramaStatusDraft || !p.PlanDone || parseDramaSettings(p.SettingsJSON).EpisodeMode != DramaEpisodeModeChapter {
		return false, nil
	}
	chapters, err := s.repo.DramaChapterOutline(project.ID)
	if err != nil {
		return false, err
	}
	episodes, err := s.repo.DramaEpisodes(project.ID)
	if err != nil {
		return false, err
	}
	if len(dramaUnassignedChapters(chapters, episodes)) == 0 {
		return false, nil
	}
	release, err := s.lockDramaSchedule(project.ID)
	if err != nil {
		return false, err
	}
	defer release()
	changed := false
	err = s.repo.Transaction(func(tx *repository.Repository) error {
		current, err := tx.DramaProductionForUpdate(project.ID)
		if err != nil {
			return err
		}
		if current.GuideStep == "" && current.Status == model.DramaStatusDraft || !current.PlanDone || parseDramaSettings(current.SettingsJSON).EpisodeMode != DramaEpisodeModeChapter {
			return nil
		}
		changed, err = syncDramaEpisodeCatalog(tx, project, current, model.DramaEpisodeDraft)
		return err
	})
	return changed, dramaGuideError(err)
}

func syncDramaEpisodeCatalog(tx *repository.Repository, project *model.Project, current *model.DramaProduction, stage string) (bool, error) {
	chapters, err := tx.DramaChapterOutline(project.ID)
	if err != nil {
		return false, err
	}
	episodes, err := tx.DramaEpisodes(project.ID)
	if err != nil {
		return false, err
	}
	missing := dramaUnassignedChapters(chapters, episodes)
	if len(missing) == 0 {
		return false, nil
	}
	settings := parseDramaSettings(current.SettingsJSON)
	if stage == model.DramaEpisodeQueued {
		for _, chapter := range missing {
			if chapter.WordCount > production.ScriptSourceChapterRunes {
				return false, BadAuthRequest(fmt.Sprintf("第 %d 章原文 %d 字，单章不超过 %d 字，请先拆分原文", chapter.Position+1, chapter.WordCount, production.ScriptSourceChapterRunes))
			}
		}
	}
	added, err := groupDramaChapterEpisodesForStage(project.ID, 1, missing, settings.ChaptersPerEpisode, production.NormalizeSourceFormat(project.SourceType), time.Now(), stage)
	if err != nil {
		return false, err
	}
	initializeDramaEpisodeSettings(added, dramaInitialEpisodeSettingsJSON(*current))
	positions := make(map[string]int, len(chapters))
	lastPosition, cursor := 0, 0
	missingIDs := make([]string, 0, len(missing))
	for _, chapter := range missing {
		missingIDs = append(missingIDs, chapter.ID)
	}
	for _, chapter := range chapters {
		positions[chapter.ID] = chapter.Position
		lastPosition = max(lastPosition, chapter.Position)
		if chapter.Status != model.ProjectUnitStatusRemoved {
			cursor++
		}
	}
	ordered := append(episodes, added...)
	position := func(episode model.DramaEpisode) int {
		first := lastPosition + episode.Number + 1
		for _, id := range decodeStringList(episode.ChapterIDsJSON) {
			if value, ok := positions[id]; ok {
				first = min(first, value)
			}
		}
		return first
	}
	sort.SliceStable(ordered, func(i, j int) bool { return position(ordered[i]) < position(ordered[j]) })
	if err := tx.SyncDramaEpisodeCatalog(project.ID, ordered, missingIDs); err != nil {
		return false, err
	}
	if err := tx.UpdateDramaGuideIf(project.ID, current.Revision, current.GuideStep, map[string]any{"plan_cursor": cursor}); err != nil {
		return false, err
	}
	return true, nil
}

func dramaUnassignedChapters(chapters []model.ProjectUnit, episodes []model.DramaEpisode) []model.ProjectUnit {
	assigned := make(map[string]bool)
	for _, episode := range episodes {
		for _, id := range decodeStringList(episode.ChapterIDsJSON) {
			assigned[id] = true
		}
	}
	missing := make([]model.ProjectUnit, 0)
	for _, chapter := range chapters {
		if chapter.Status != model.ProjectUnitStatusRemoved && !assigned[chapter.ID] {
			missing = append(missing, chapter)
		}
	}
	return missing
}
