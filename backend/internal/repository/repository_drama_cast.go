package repository

import (
	"encoding/json"
	"time"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type DramaCastDeleteReferences struct {
	CanvasIDs   []string
	Jobs        []model.DramaJob
	ActiveTasks int64
}

// Called inside the guide edit transaction; job row locks serialize task binding.
func (r *Repository) DramaCastDeleteReferences(userID, projectID string, castIDs []string) (DramaCastDeleteReferences, error) {
	var refs DramaCastDeleteReferences
	ids := map[string]bool{}
	for _, id := range castIDs {
		ids[id] = true
	}
	var canvases []model.CanvasProject
	if err := r.db.Select("id", "payload_json").Where("user_id = ? AND payload_json LIKE ?", userID, "%\"dramaRef\"%").Find(&canvases).Error; err != nil {
		return refs, err
	}
	for _, canvas := range canvases {
		var payload struct {
			Nodes []struct {
				Metadata struct {
					DramaRef struct {
						ProjectID string `json:"projectId"`
						Kind      string `json:"kind"`
						ID        string `json:"id"`
					} `json:"dramaRef"`
				} `json:"metadata"`
			} `json:"nodes"`
		}
		if err := json.Unmarshal([]byte(canvas.PayloadJSON), &payload); err != nil {
			return refs, err
		}
		for _, node := range payload.Nodes {
			ref := node.Metadata.DramaRef
			if ref.ProjectID == projectID && ref.Kind == "cast" && ids[ref.ID] {
				refs.CanvasIDs = append(refs.CanvasIDs, canvas.ID)
				break
			}
		}
	}
	if err := r.db.Clauses(clause.Locking{Strength: "UPDATE"}).Where("project_id = ? AND cast_id IN ?", projectID, castIDs).Find(&refs.Jobs).Error; err != nil {
		return refs, err
	}
	taskIDs := []string{}
	for _, job := range refs.Jobs {
		if job.TaskID != "" {
			taskIDs = append(taskIDs, job.TaskID)
		}
		var attempts []struct {
			TaskID string `json:"taskId"`
		}
		if job.AttemptsJSON != "" {
			if err := json.Unmarshal([]byte(job.AttemptsJSON), &attempts); err != nil {
				return refs, err
			}
		}
		for _, attempt := range attempts {
			if attempt.TaskID != "" {
				taskIDs = append(taskIDs, attempt.TaskID)
			}
		}
	}
	if len(taskIDs) > 0 {
		if err := r.db.Model(&model.Task{}).Where("user_id = ? AND id IN ? AND status IN ?", userID, taskIDs, []model.TaskStatus{model.TaskStatusQueued, model.TaskStatusRunning}).Count(&refs.ActiveTasks).Error; err != nil {
			return refs, err
		}
	}
	return refs, nil
}

// DetachDramaCastReferences is called under the production lock before deleting catalog rows.
func (r *Repository) DetachDramaCastReferences(projectID string, removed map[string]bool, promptLabels map[string]string) error {
	var episodes []model.DramaEpisode
	if err := r.db.Select("id", "asset_ids_json").Where("project_id = ? AND asset_ids_json <> ''", projectID).Find(&episodes).Error; err != nil {
		return err
	}
	for _, episode := range episodes {
		if kept, changed := removeDramaCastIDs(episode.AssetIDsJSON, removed); changed {
			if err := r.db.Model(&model.DramaEpisode{}).Where("id = ? AND project_id = ?", episode.ID, projectID).UpdateColumn("asset_ids_json", kept).Error; err != nil {
				return err
			}
		}
	}
	var shots []model.DramaShot
	if err := r.db.Select("id", "scene_cast_id", "cast_ids_json", "look_cast_ids_json", "prop_ids_json").Where("project_id = ?", projectID).Find(&shots).Error; err != nil {
		return err
	}
	for _, shot := range shots {
		fields := map[string]any{}
		if removed[shot.SceneCastID] {
			fields["scene_cast_id"] = ""
		}
		for column, raw := range map[string]string{"cast_ids_json": shot.CastIDsJSON, "look_cast_ids_json": shot.LookCastIDsJSON, "prop_ids_json": shot.PropIDsJSON} {
			if kept, changed := removeDramaCastIDs(raw, removed); changed {
				fields[column] = kept
			}
		}
		if len(fields) > 0 {
			if err := r.db.Model(&model.DramaShot{}).Where("id = ? AND project_id = ?", shot.ID, projectID).Updates(fields).Error; err != nil {
				return err
			}
		}
	}
	var segments []model.DramaSegment
	if err := r.db.Select("id", "reference_cast_ids_json", "audio_cast_ids_json").Where("project_id = ?", projectID).Find(&segments).Error; err != nil {
		return err
	}
	for _, segment := range segments {
		fields := map[string]any{}
		for column, raw := range map[string]string{"reference_cast_ids_json": segment.ReferenceCastIDsJSON, "audio_cast_ids_json": segment.AudioCastIDsJSON} {
			if kept, changed := removeDramaCastIDs(raw, removed); changed {
				fields[column] = kept
			}
		}
		labels, referencedInShot := promptLabels[segment.ID]
		if labels != "" {
			fields["reference_labels_json"] = labels
		}
		if len(fields) > 0 || referencedInShot {
			fields["video_revision"] = gorm.Expr("video_revision + 1")
			fields["video_status"] = gorm.Expr("CASE WHEN video_status = ? THEN ? ELSE video_status END", model.DramaMediaRunning, model.DramaMediaStale)
			if err := r.db.Model(&model.DramaSegment{}).Where("id = ? AND project_id = ?", segment.ID, projectID).Updates(fields).Error; err != nil {
				return err
			}
		}
	}
	return r.detachDramaShotMediaSubjects(projectID, removed)
}

func removeDramaCastIDs(raw string, removed map[string]bool) (string, bool) {
	ids := decodeDramaIDs(raw)
	kept := make([]string, 0, len(ids))
	for _, id := range ids {
		if !removed[id] {
			kept = append(kept, id)
		}
	}
	if len(ids) == len(kept) {
		return raw, false
	}
	result, _ := json.Marshal(kept)
	return string(result), true
}

func (r *Repository) dramaShotMediaWithSubjects(projectID string) ([]model.DramaShotMedia, error) {
	var media []model.DramaShotMedia
	err := r.db.Select("id", "shot_id", "config_json").Where("project_id = ? AND config_json LIKE ?", projectID, "%\"referenceSubjects\"%").Find(&media).Error
	return media, err
}

type DramaCastMediaReferences struct {
	Shots    map[string]bool
	Bindings map[string]map[string]string
}

func (r *Repository) DramaCastMediaReferences(projectID string, subjectIDs map[string]bool) (DramaCastMediaReferences, error) {
	media, err := r.dramaShotMediaWithSubjects(projectID)
	if err != nil {
		return DramaCastMediaReferences{}, err
	}
	refs := DramaCastMediaReferences{Shots: map[string]bool{}, Bindings: map[string]map[string]string{}}
	for _, row := range media {
		var config struct {
			ReferenceSubjects map[string]string `json:"referenceSubjects"`
		}
		if err := json.Unmarshal([]byte(row.ConfigJSON), &config); err != nil {
			return DramaCastMediaReferences{}, err
		}
		for resourceID, castID := range config.ReferenceSubjects {
			if subjectIDs[castID] {
				refs.Shots[row.ShotID] = true
				if refs.Bindings[row.ID] == nil {
					refs.Bindings[row.ID] = map[string]string{}
				}
				refs.Bindings[row.ID][resourceID] = castID
			}
		}
	}
	return refs, nil
}

func (r *Repository) detachDramaShotMediaSubjects(projectID string, removed map[string]bool) error {
	media, err := r.dramaShotMediaWithSubjects(projectID)
	if err != nil {
		return err
	}
	for _, row := range media {
		var config map[string]json.RawMessage
		if err := json.Unmarshal([]byte(row.ConfigJSON), &config); err != nil {
			return err
		}
		if len(config["referenceSubjects"]) == 0 {
			continue
		}
		var subjects map[string]string
		if err := json.Unmarshal(config["referenceSubjects"], &subjects); err != nil {
			return err
		}
		before := len(subjects)
		for resourceID, castID := range subjects {
			if removed[castID] {
				delete(subjects, resourceID)
			}
		}
		if len(subjects) == before {
			continue
		}
		if len(subjects) == 0 {
			delete(config, "referenceSubjects")
		} else {
			config["referenceSubjects"], _ = json.Marshal(subjects)
		}
		encoded, err := json.Marshal(config)
		if err != nil {
			return err
		}
		if err := r.db.Model(&model.DramaShotMedia{}).Where("id = ? AND project_id = ?", row.ID, projectID).Updates(map[string]any{"config_json": string(encoded), "revision": gorm.Expr("revision + 1")}).Error; err != nil {
			return err
		}
	}
	return nil
}

// Only catalog rows are deleted. Media, takes, and submitted task history remain.
func (r *Repository) DeleteDramaCastCatalog(projectID string, castIDs []string) error {
	if err := r.db.Model(&model.DramaJob{}).Where("project_id = ? AND cast_id IN ? AND status = ? AND COALESCE(task_id, '') = ''", projectID, castIDs, model.DramaJobQueued).
		Updates(map[string]any{"status": model.DramaJobCanceled, "updated_at": time.Now()}).Error; err != nil {
		return err
	}
	result := r.db.Where("project_id = ? AND id IN ?", projectID, castIDs).Delete(&model.DramaCast{})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != int64(len(castIDs)) {
		return gorm.ErrRecordNotFound
	}
	return nil
}
