package repository

import (
	"errors"
	"time"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrDramaGuideChanged = errors.New("短剧引导已更新，请刷新后重试")

// Text results also invalidate proposals made against the previous guide snapshot.
func (r *Repository) AdvanceDramaGuideRevision(projectID string) error {
	return r.db.Model(&model.DramaProduction{}).
		Where("project_id = ? AND guide_step IN ?", projectID, []string{model.DramaGuideConfiguring, model.DramaGuideAssets, model.DramaGuideStory}).
		Updates(map[string]any{"revision": gorm.Expr("revision + 1"), "updated_at": time.Now()}).Error
}

func (r *Repository) DramaProductionForUpdate(projectID string) (*model.DramaProduction, error) {
	var row model.DramaProduction
	err := r.db.Clauses(clause.Locking{Strength: "UPDATE"}).First(&row, "project_id = ?", projectID).Error
	return &row, err
}

// Conversation binding is metadata and must not invalidate proposals made by the first run.
func (r *Repository) BindDramaGuideConversation(projectID string, revision int64, conversationID string) error {
	result := r.db.Model(&model.DramaProduction{}).
		Where("project_id = ? AND revision = ?", projectID, revision).
		Where("guide_conversation_id IS NULL OR guide_conversation_id = '' OR guide_conversation_id = ?", conversationID).
		Updates(map[string]any{"guide_conversation_id": conversationID, "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDramaGuideChanged
	}
	return nil
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
	var count int64
	err := r.db.Model(&model.DramaJob{}).Where("project_id = ? AND kind IN ? AND status IN ?", projectID,
		[]string{model.DramaJobBible, model.DramaJobPlan, model.DramaJobScript, model.DramaJobSegmentPrompt},
		[]string{model.DramaJobQueued, model.DramaJobRunning}).Count(&count).Error
	return count > 0, err
}

// ReplaceDramaGuideSource only replaces unstarted draft data; generated entities never enter this path.
func (r *Repository) ReplaceDramaGuideSource(projectID, sourceFormat string, chapters []model.ProjectUnit, episodes []model.DramaEpisode, cursor int, done bool) error {
	if err := r.db.Where("project_id = ? AND kind = ?", projectID, model.ProjectUnitKindChapter).Delete(&model.ProjectUnit{}).Error; err != nil {
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
	return r.db.Model(&model.DramaEpisode{}).Where("project_id = ?", projectID).
		Updates(map[string]any{"approved": true, "stage": model.DramaEpisodeReview, "media_released": false, "revision": gorm.Expr("revision + 1"), "updated_at": time.Now()}).Error
}

func (r *Repository) UpdateDramaCastImageRevision(id string, revision int64, allowed []string, fields map[string]any) (bool, error) {
	fields["updated_at"] = time.Now()
	result := r.db.Model(&model.DramaCast{}).Where("id = ? AND revision = ? AND image_status IN ?", id, revision, allowed).Updates(fields)
	return result.RowsAffected == 1, result.Error
}
