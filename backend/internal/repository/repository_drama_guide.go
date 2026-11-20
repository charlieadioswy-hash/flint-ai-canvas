package repository

import (
	"errors"
	"time"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrDramaGuideChanged = errors.New("短剧引导已更新，请刷新后重试")

type DramaSourceExportRow struct {
	Revision   int64
	SourceType string
	ID         string
	Kind       model.ProjectUnitKind
	Title      string
	SourceText string
}

// DramaSourceExport 以同一条查询读取版本、素材类型、正文和参考资料。
func (r *Repository) DramaSourceExport(userID, projectID string) ([]DramaSourceExportRow, error) {
	var rows []DramaSourceExportRow
	result := r.db.Table("drama_productions").
		Select("drama_productions.revision, projects.source_type, project_units.id, project_units.kind, project_units.title, project_units.source_text").
		Joins("JOIN projects ON projects.id = drama_productions.project_id").
		Joins("LEFT JOIN project_units ON project_units.project_id = projects.id AND project_units.kind IN ?", []model.ProjectUnitKind{model.ProjectUnitKindChapter, model.ProjectUnitKindSourceReference}).
		Where("projects.id = ? AND projects.user_id = ?", projectID, userID).
		Order("project_units.position ASC, project_units.id ASC").Scan(&rows)
	if result.Error != nil {
		return nil, result.Error
	}
	if len(rows) == 0 {
		return nil, gorm.ErrRecordNotFound
	}
	return rows, nil
}

// Text results advance the shared workflow snapshot used by concurrent edits.
func (r *Repository) AdvanceDramaGuideRevision(projectID string) error {
	return r.db.Model(&model.DramaProduction{}).
		Where("project_id = ? AND guide_step IN ?", projectID, []string{model.DramaGuideConfiguring, model.DramaGuideAssets, model.DramaGuideStory}).
		Updates(map[string]any{"revision": gorm.Expr("revision + 1"), "updated_at": time.Now()}).Error
}

func (r *Repository) DramaProductionForUpdate(projectID string) (*model.DramaProduction, error) {
	var row model.DramaProduction
	if r.Dialect() == "sqlite" {
		// SQLite 忽略 FOR UPDATE；先写入取得事务写锁，避免读快照后升级写入时立即报 SQLITE_BUSY。
		if err := r.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).
			UpdateColumn("revision", gorm.Expr("revision")).Error; err != nil {
			return &row, err
		}
	}
	err := r.db.Clauses(clause.Locking{Strength: "UPDATE"}).First(&row, "project_id = ?", projectID).Error
	return &row, err
}

func (r *Repository) UpdateDramaGuideIf(projectID string, revision int64, step string, fields map[string]any) error {
	fields["revision"] = gorm.Expr("revision + 1")
	fields["updated_at"] = time.Now()
	result := r.db.Model(&model.DramaProduction{}).Where("project_id = ? AND revision = ? AND guide_step = ?", projectID, revision, step).Updates(fields)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDramaGuideChanged
	}
	return nil
}

func (r *Repository) DramaTextJobsActive(projectID string) (bool, error) {
	return r.dramaTextJobsActive(projectID, []string{model.DramaJobBible, model.DramaJobPlan, model.DramaJobScript, model.DramaJobSegmentPrompt})
}

// DramaPromptInputsChanging excludes independent prompt jobs, but keeps structural text generation mutually exclusive with retries.
func (r *Repository) DramaPromptInputsChanging(projectID string) (bool, error) {
	return r.dramaTextJobsActive(projectID, []string{model.DramaJobBible, model.DramaJobPlan, model.DramaJobScript})
}

func (r *Repository) dramaTextJobsActive(projectID string, kinds []string) (bool, error) {
	var count int64
	err := r.db.Model(&model.DramaJob{}).Where("project_id = ? AND kind IN ? AND status IN ?", projectID,
		kinds,
		[]string{model.DramaJobQueued, model.DramaJobRunning}).Count(&count).Error
	return count > 0, err
}

// ReplaceDramaGuideSource only replaces unstarted draft data; generated entities never enter this path.
func (r *Repository) ReplaceDramaGuideSource(projectID, sourceFormat string, chapters []model.ProjectUnit, episodes []model.DramaEpisode, cursor int, done, replaceReference bool) error {
	kinds := []model.ProjectUnitKind{model.ProjectUnitKindChapter}
	if replaceReference {
		kinds = append(kinds, model.ProjectUnitKindSourceReference)
	}
	if err := r.db.Where("project_id = ? AND kind IN ?", projectID, kinds).Delete(&model.ProjectUnit{}).Error; err != nil {
		return err
	}
	if len(chapters) > 0 {
		if err := r.db.CreateInBatches(chapters, 200).Error; err != nil {
			return err
		}
	}
	return r.ResetDramaGuideEpisodes(projectID, sourceFormat, episodes, cursor, done)
}

// UpdateDramaGuideDraftFields is used inside a transaction whose final CAS increments the revision.
func (r *Repository) UpdateDramaGuideDraftFields(projectID string, fields map[string]any) error {
	return r.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Updates(fields).Error
}

// DramaGuideSourceChapters 为配置阶段的范围编辑读取全部正文，包含不参与当前制作的预留章。
func (r *Repository) DramaGuideSourceChapters(projectID string) ([]model.ProjectUnit, error) {
	var units []model.ProjectUnit
	err := r.db.Where("project_id = ? AND kind = ?", projectID, model.ProjectUnitKindChapter).Order("position asc").Find(&units).Error
	return units, err
}

// SetDramaGuideChapterSelection 只修改未开工章节的制作范围，保留正文和章节引用标识。
func (r *Repository) SetDramaGuideChapterSelection(projectID string, selectedIDs []string) error {
	query := r.db.Model(&model.ProjectUnit{}).Where("project_id = ? AND kind = ?", projectID, model.ProjectUnitKindChapter)
	if err := query.Update("status", model.ProjectUnitStatusReserved).Error; err != nil {
		return err
	}
	return r.db.Model(&model.ProjectUnit{}).Where("project_id = ? AND kind = ? AND id IN ?", projectID, model.ProjectUnitKindChapter, selectedIDs).
		Update("status", model.ProjectUnitStatusReady).Error
}

func (r *Repository) ResetDramaGuideEpisodes(projectID, sourceFormat string, episodes []model.DramaEpisode, cursor int, done bool) error {
	if err := r.db.Where("project_id = ?", projectID).Delete(&model.DramaEpisode{}).Error; err != nil {
		return err
	}
	if len(episodes) > 0 {
		if err := r.db.CreateInBatches(episodes, 200).Error; err != nil {
			return err
		}
	}
	if err := r.db.Model(&model.Project{}).Where("id = ?", projectID).Update("source_type", sourceFormat).Error; err != nil {
		return err
	}
	return r.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Updates(map[string]any{"plan_cursor": cursor, "plan_done": done}).Error
}

func (r *Repository) CompleteDramaGuideEpisodes(projectID string) error {
	return r.db.Model(&model.DramaEpisode{}).Where("project_id = ? AND stage IN ? AND video_requests_only = ?", projectID, []string{model.DramaEpisodePrompts, model.DramaEpisodeReview}, false).
		Updates(map[string]any{"approved": true, "stage": model.DramaEpisodeReview, "media_released": false, "revision": gorm.Expr("revision + 1"), "updated_at": time.Now()}).Error
}

func (r *Repository) UpdateDramaCastImageRevision(id string, revision int64, allowed []string, fields map[string]any) (bool, error) {
	return r.updateDramaCastMediaConditional(id, fields, func(db *gorm.DB) *gorm.DB {
		return db.Where("revision = ? AND image_status IN ?", revision, allowed)
	})
}
