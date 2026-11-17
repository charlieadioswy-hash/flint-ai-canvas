package repository

import (
	"fmt"
	"unicode/utf8"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

// SyncDramaEpisodeCatalog 在持有作品行锁和调度租约的事务内补集，并按原文重排目录。
// 原有集只修改集号和默认标题，不改版本、配置、内容或媒体。
func (r *Repository) SyncDramaEpisodeCatalog(projectID string, ordered []model.DramaEpisode, chapterIDs []string) error {
	existing, err := r.DramaEpisodes(projectID)
	if err != nil {
		return err
	}
	byID := make(map[string]model.DramaEpisode, len(existing))
	for _, episode := range existing {
		byID[episode.ID] = episode
	}
	// (project_id, number) 唯一；先暂存为负数，避免新旧顺序互相占号。
	if err := r.db.Model(&model.DramaEpisode{}).Where("project_id = ?", projectID).UpdateColumn("number", gorm.Expr("-number")).Error; err != nil {
		return err
	}
	for index, episode := range ordered {
		number := index + 1
		previous, exists := byID[episode.ID]
		if !exists {
			episode.Number = number
			if err := r.db.Create(&episode).Error; err != nil {
				return err
			}
			continue
		}
		fields := map[string]any{"number": number}
		before, after := model.DramaEpisodeDefaultTitle(previous.Number), model.DramaEpisodeDefaultTitle(number)
		if previous.Title == before {
			fields["title"] = after
		}
		if err := r.db.Model(&model.DramaEpisode{}).Where("project_id = ? AND id = ?", projectID, previous.ID).UpdateColumns(fields).Error; err != nil {
			return err
		}
		if previous.Number != number {
			if err := r.db.Model(&model.DramaJob{}).Where("project_id = ? AND episode_id = ? AND label LIKE ?", projectID, previous.ID, before+"%").
				UpdateColumn("label", gorm.Expr(fmt.Sprintf("CAST(? AS TEXT) || SUBSTR(label, %d)", utf8.RuneCountInString(before)+1), after)).Error; err != nil {
				return err
			}
		}
	}
	return r.db.Model(&model.ProjectUnit{}).Where("project_id = ? AND kind = ? AND id IN ? AND status <> ?", projectID, model.ProjectUnitKindChapter, chapterIDs, model.ProjectUnitStatusRemoved).
		UpdateColumn("status", model.ProjectUnitStatusReady).Error
}
