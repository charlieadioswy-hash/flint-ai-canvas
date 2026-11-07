package repository

import (
	"encoding/json"
	"time"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type DramaCastDeleteReferences struct {
	Looks       int64
	Shots       int64
	Segments    int64
	CanvasIDs   []string
	Jobs        []model.DramaJob
	ActiveTasks int64
}

// Called inside the guide edit transaction; job row locks serialize task binding.
func (r *Repository) DramaCastDeleteReferences(userID, projectID, castID string) (DramaCastDeleteReferences, error) {
	var refs DramaCastDeleteReferences
	if err := r.db.Model(&model.DramaCast{}).Where("project_id = ? AND parent_id = ?", projectID, castID).Count(&refs.Looks).Error; err != nil {
		return refs, err
	}
	pattern := "%\"" + castID + "\"%"
	if err := r.db.Model(&model.DramaShot{}).
		Where("project_id = ? AND (scene_cast_id = ? OR cast_ids_json LIKE ? OR prop_ids_json LIKE ? OR look_cast_ids_json LIKE ?)", projectID, castID, pattern, pattern, pattern).
		Count(&refs.Shots).Error; err != nil {
		return refs, err
	}
	if err := r.db.Model(&model.DramaSegment{}).Where("project_id = ? AND (reference_cast_ids_json LIKE ? OR audio_cast_ids_json LIKE ?)", projectID, pattern, pattern).Count(&refs.Segments).Error; err != nil {
		return refs, err
	}
	var canvases []model.CanvasProject
	if err := r.db.Select("id", "payload_json").Where("user_id = ? AND payload_json LIKE ?", userID, "%"+castID+"%").Find(&canvases).Error; err != nil {
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
			if ref.ProjectID == projectID && ref.Kind == "cast" && ref.ID == castID {
				refs.CanvasIDs = append(refs.CanvasIDs, canvas.ID)
				break
			}
		}
	}
	if err := r.db.Clauses(clause.Locking{Strength: "UPDATE"}).Where("project_id = ? AND cast_id = ?", projectID, castID).Find(&refs.Jobs).Error; err != nil {
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

func (r *Repository) PreserveDramaCastImage(cast model.DramaCast, takeID string) error {
	if cast.ImageResourceID == "" {
		return nil
	}
	var count int64
	if err := r.db.Model(&model.DramaTake{}).Where("project_id = ? AND owner_id = ? AND kind = ? AND resource_id = ?", cast.ProjectID, cast.ID, "cast", cast.ImageResourceID).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	return r.CreateDramaTake(&model.DramaTake{ID: takeID, ProjectID: cast.ProjectID, OwnerID: cast.ID, Kind: "cast", ResourceID: cast.ImageResourceID})
}

// Only the catalog row is deleted. Media, takes, and submitted task history remain.
func (r *Repository) DeleteDramaCastCatalog(projectID, castID string) error {
	if err := r.db.Model(&model.DramaJob{}).Where("project_id = ? AND cast_id = ? AND status = ? AND COALESCE(task_id, '') = ''", projectID, castID, model.DramaJobQueued).
		Updates(map[string]any{"status": model.DramaJobCanceled, "updated_at": time.Now()}).Error; err != nil {
		return err
	}
	result := r.db.Where("project_id = ? AND id = ?", projectID, castID).Delete(&model.DramaCast{})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	return nil
}
