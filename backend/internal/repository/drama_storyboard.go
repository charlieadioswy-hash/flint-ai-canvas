package repository

import (
	"encoding/json"
	"errors"
	"time"

	"yingce/backend/internal/model"
)

var ErrDramaStoryboardChanged = errors.New("宫格故事板已变化，请刷新后重试")

func (r *Repository) DramaStoryboard(projectID, boardID string) (*model.DramaStoryboardBoard, error) {
	var row model.DramaStoryboardBoard
	if err := r.db.Where("id = ? AND project_id = ?", boardID, projectID).First(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *Repository) DramaStoryboards(projectID, episodeID string) ([]model.DramaStoryboardBoard, error) {
	var rows []model.DramaStoryboardBoard
	err := r.db.Where("project_id = ? AND episode_id = ?", projectID, episodeID).Order("created_at DESC, id DESC").Limit(30).Find(&rows).Error
	return rows, err
}

func (r *Repository) CreateDramaStoryboard(row *model.DramaStoryboardBoard) error {
	return r.db.Create(row).Error
}

func (r *Repository) BindDramaStoryboardTask(board *model.DramaStoryboardBoard, taskID string, expected int64) error {
	result := r.db.Model(&model.DramaStoryboardBoard{}).Where("id = ? AND project_id = ? AND revision = ? AND task_id = ''", board.ID, board.ProjectID, expected).
		Updates(map[string]any{"task_id": taskID, "revision": expected + 1, "status": "queued", "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDramaStoryboardChanged
	}
	return nil
}

func (r *Repository) CompleteDramaStoryboard(board *model.DramaStoryboardBoard, resource *model.Resource) error {
	if board.ResourceID != "" {
		if board.ResourceID == resource.ID {
			return nil
		}
		return ErrDramaStoryboardChanged
	}
	result := r.db.Model(&model.DramaStoryboardBoard{}).Where("id = ? AND task_id = ? AND revision = ? AND resource_id = ''", board.ID, board.TaskID, board.Revision).
		Updates(map[string]any{"resource_id": resource.ID, "source_width": resource.Width, "source_height": resource.Height, "revision": board.Revision + 1, "status": "image_ready", "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDramaStoryboardChanged
	}
	return nil
}

func (r *Repository) DramaStoryboardCells(projectID, boardID string) ([]model.DramaStoryboardCell, error) {
	var cells []model.DramaStoryboardCell
	err := r.db.Where("project_id = ? AND board_id = ?", projectID, boardID).Order("\"index\" ASC").Find(&cells).Error
	return cells, err
}

func (r *Repository) SaveDramaStoryboardCells(board *model.DramaStoryboardBoard, cells []model.DramaStoryboardCell, width, height int) error {
	if err := r.db.Create(&cells).Error; err != nil {
		return err
	}
	result := r.db.Model(&model.DramaStoryboardBoard{}).Where("id = ? AND revision = ? AND resource_id = ?", board.ID, board.Revision, board.ResourceID).
		Updates(map[string]any{"revision": board.Revision + 1, "status": "split", "source_width": width, "source_height": height, "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDramaStoryboardChanged
	}
	return nil
}

func (r *Repository) DramaStoryboardCellTake(projectID, shotID, taskID, resourceID string) (*model.DramaTake, error) {
	var take model.DramaTake
	err := r.db.Where("project_id = ? AND owner_id = ? AND kind = ? AND task_id = ? AND resource_id = ?", projectID, shotID, "shot_image", taskID, resourceID).First(&take).Error
	return &take, err
}

func (r *Repository) DeleteDramaStoryboardForProject(projectID string) error {
	if err := r.db.Where("project_id = ?", projectID).Delete(&model.DramaStoryboardCell{}).Error; err != nil {
		return err
	}
	return r.db.Where("project_id = ?", projectID).Delete(&model.DramaStoryboardBoard{}).Error
}

func (r *Repository) DramaStoryboardResourceReferences(userID string, resourceIDs []string) ([]ResourceDirectReference, error) {
	if len(resourceIDs) == 0 {
		return []ResourceDirectReference{}, nil
	}
	wanted := map[string]bool{}
	for _, id := range resourceIDs {
		wanted[id] = true
	}
	var boards []model.DramaStoryboardBoard
	if err := r.db.Where("user_id = ?", userID).Find(&boards).Error; err != nil {
		return nil, err
	}
	refs := []ResourceDirectReference{}
	for _, board := range boards {
		var config struct {
			ReferenceResourceIDs []string `json:"referenceResourceIds"`
		}
		if err := json.Unmarshal([]byte(board.ConfigJSON), &config); err != nil {
			return nil, err
		}
		ids := append(config.ReferenceResourceIDs, board.ResourceID)
		for _, id := range ids {
			if wanted[id] {
				refs = append(refs, ResourceDirectReference{Kind: DramaResourceReferenceKind, ID: board.ID, ResourceID: id, Title: "宫格故事板原图与参考图"})
			}
		}
	}
	var cells []model.DramaStoryboardCell
	err := r.db.Where("resource_id IN ? AND board_id IN (?)", resourceIDs, r.db.Model(&model.DramaStoryboardBoard{}).Select("id").Where("user_id = ?", userID)).Find(&cells).Error
	if err != nil {
		return nil, err
	}
	for _, cell := range cells {
		refs = append(refs, ResourceDirectReference{Kind: DramaResourceReferenceKind, ID: cell.ID, ResourceID: cell.ResourceID, Title: "宫格故事板真实裁片"})
	}
	return refs, nil
}
