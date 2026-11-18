package repository

import "yingce/backend/internal/model"

type DramaEpisodeShotCoverage struct {
	EpisodeID       string
	ShotCount       int
	CoveredSegments int64
	UnassignedShots int64
}

func (r *Repository) DramaProjectShotCoverage(projectID string) ([]DramaEpisodeShotCoverage, error) {
	var rows []DramaEpisodeShotCoverage
	err := r.db.Model(&model.DramaShot{}).
		Select(`drama_shots.episode_id, COUNT(*) AS shot_count, COUNT(DISTINCT drama_segments.id) AS covered_segments,
		SUM(CASE WHEN drama_segments.id IS NULL OR drama_shots.segment_index < 0 THEN 1 ELSE 0 END) AS unassigned_shots`).
		Joins("LEFT JOIN drama_segments ON drama_segments.project_id = drama_shots.project_id AND drama_segments.episode_id = drama_shots.episode_id AND drama_segments.segment_index = drama_shots.segment_index").
		Where("drama_shots.project_id = ?", projectID).Group("drama_shots.episode_id").Scan(&rows).Error
	return rows, err
}

func (r *Repository) DramaProjectRenderableSegmentCounts(projectID, userID string) (map[string]int64, error) {
	var rows []struct {
		EpisodeID string
		Total     int64
	}
	err := r.db.Model(&model.DramaSegment{}).Select("drama_segments.episode_id, COUNT(*) AS total").
		Joins("JOIN resources ON resources.id = drama_segments.video_resource_id AND resources.user_id = ?", userID).
		Where("drama_segments.project_id = ? AND drama_segments.video_status = ? AND drama_segments.video_seconds > 0", projectID, model.DramaMediaReady).
		Where("resources.status = ? AND resources.kind = ? AND resources.mime_type LIKE ?", model.ResourceStatusReady, "video", "video/%").
		Group("drama_segments.episode_id").Scan(&rows).Error
	counts := make(map[string]int64, len(rows))
	for _, row := range rows {
		counts[row.EpisodeID] = row.Total
	}
	return counts, err
}

type DramaEpisodeAdoptedShot struct {
	model.DramaShot        `gorm:"embedded"`
	AdoptedVideoScriptHash string
}

// Include invalid adopted slots: even one adopted shot selects the shot-video source.
func (r *Repository) DramaProjectAdoptedShots(projectID, userID string) ([]DramaEpisodeAdoptedShot, error) {
	var rows []DramaEpisodeAdoptedShot
	err := r.db.Model(&model.DramaShot{}).Select(`drama_shots.*,
		CASE WHEN slots.status = ? AND takes.id IS NOT NULL AND resources.id IS NOT NULL
		 AND (resources.duration_ms > 0 OR takes.duration_ms > 0) THEN slots.script_hash ELSE '' END AS adopted_video_script_hash`, model.DramaMediaReady).
		Joins(`JOIN drama_shot_media AS slots ON slots.project_id = drama_shots.project_id AND slots.episode_id = drama_shots.episode_id
		 AND slots.shot_id = drama_shots.id AND slots.kind = ? AND (slots.resource_id <> '' OR slots.current_take_id <> '')`, "video").
		Joins(`LEFT JOIN drama_takes AS takes ON takes.id = slots.current_take_id AND takes.project_id = slots.project_id
		 AND takes.owner_id = slots.shot_id AND takes.kind = ? AND takes.resource_id = slots.resource_id`, "shot_video").
		Joins(`LEFT JOIN resources ON resources.id = slots.resource_id AND resources.user_id = ?
		 AND resources.status = ? AND resources.kind = ? AND resources.mime_type LIKE ?`, userID, model.ResourceStatusReady, "video", "video/%").
		Where("drama_shots.project_id = ?", projectID).Scan(&rows).Error
	return rows, err
}

func (r *Repository) DramaProjectAssetExtractionEvidence(projectID string) ([]model.DramaJob, error) {
	var rows []model.DramaJob
	err := r.db.Model(&model.DramaJob{}).Select("kind", "status", "payload_json", "created_at").
		Where("project_id = ? AND kind = ? AND status = ?", projectID, model.DramaJobBible, model.DramaJobSucceeded).Find(&rows).Error
	return rows, err
}

func (r *Repository) DramaProjectSuccessfulScriptEpisodes(projectID string) (map[string]bool, error) {
	var ids []string
	err := r.db.Model(&model.DramaJob{}).Where("project_id = ? AND kind = ? AND status = ? AND episode_id <> ''", projectID, model.DramaJobScript, model.DramaJobSucceeded).
		Distinct("episode_id").Pluck("episode_id", &ids).Error
	result := make(map[string]bool, len(ids))
	for _, id := range ids {
		result[id] = true
	}
	return result, err
}

func (r *Repository) DramaProjectAvailableFinalVideos(projectID, userID string) (map[string]string, error) {
	var rows []struct {
		EpisodeID  string
		ResourceID string
	}
	err := r.db.Model(&model.DramaEpisode{}).Select("drama_episodes.id AS episode_id, resources.id AS resource_id").
		Joins("JOIN resources ON resources.id = drama_episodes.final_resource_id AND resources.user_id = ?", userID).
		Where("drama_episodes.project_id = ? AND resources.status = ? AND resources.kind = ? AND resources.mime_type LIKE ?", projectID, model.ResourceStatusReady, "video", "video/%").
		Scan(&rows).Error
	result := make(map[string]string, len(rows))
	for _, row := range rows {
		result[row.EpisodeID] = row.ResourceID
	}
	return result, err
}
