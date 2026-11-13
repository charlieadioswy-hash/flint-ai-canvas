package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"io"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

const dramaStoryboardMaxBytes int64 = 64 << 20

func (s *Service) readyDramaStoryboard(repo *repository.Repository, userID string, board *model.DramaStoryboardBoard) ([]string, error) {
	_, ids, err := decodeDramaStoryboard(*board)
	if err != nil {
		return nil, err
	}
	if _, hash, err := dramaStoryboardShotSnapshot(repo, board.ProjectID, ids); err != nil || hash != board.ScriptHash {
		return nil, dramaGuideConflict("镜头原稿已变化，请创建新的故事板")
	}
	task, err := repo.TaskForUser(userID, board.TaskID)
	if err != nil {
		return nil, err
	}
	var input struct {
		Metadata struct {
			Source  string `json:"source"`
			BoardID string `json:"dramaStoryboardBoardId"`
		} `json:"metadata"`
	}
	if json.Unmarshal([]byte(task.InputJSON), &input) != nil || input.Metadata.Source != "drama_storyboard_board" || input.Metadata.BoardID != board.ID || task.ProjectID != board.ProjectID || task.Type != "canvas_image" || task.Status != model.TaskStatusSucceeded || board.ResourceID == "" || dramaTaskResource(task) != board.ResourceID {
		return nil, BadAuthRequest("故事板原图尚未生成完成、已取消或任务归属不符")
	}
	resource, err := repo.ResourceForUser(userID, board.ResourceID)
	if err != nil || resource.Status != model.ResourceStatusReady || resource.Kind != "image" {
		return nil, BadAuthRequest("故事板原图不可用")
	}
	return ids, nil
}

func (s *Service) readDramaStoryboardImage(userID, resourceID string) (image.Image, error) {
	resource, body, err := s.OpenResource(userID, resourceID)
	if err != nil {
		return nil, err
	}
	defer body.Close()
	if resource.Kind != "image" || resource.Status != model.ResourceStatusReady || resource.Size <= 0 || resource.Size > dramaStoryboardMaxBytes {
		return nil, BadAuthRequest("故事板图片必须为不超过 64 MiB 的就绪图片")
	}
	data, err := io.ReadAll(io.LimitReader(body, dramaStoryboardMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) == 0 || int64(len(data)) > dramaStoryboardMaxBytes {
		return nil, BadAuthRequest("故事板图片为空或超过 64 MiB")
	}
	decoded, err := decodeOutputMaskImage(bytes.NewReader(data), dramaStoryboardMaxBytes)
	if err != nil {
		return nil, BadAuthRequest("故事板图片无法解码或超过 32 M 像素，请使用有效的 PNG、JPEG 或 WebP 图片")
	}
	return decoded, nil
}

// Integer division assigns every source pixel exactly once, including images
// whose dimensions are not divisible by the grid's row or column counts.
func dramaStoryboardCellRects(width, height, rows, columns int) ([]image.Rectangle, error) {
	if !validDramaStoryboardGrid(rows, columns) || width < columns || height < rows {
		return nil, BadAuthRequest("原图尺寸不足以按所选宫格裁切")
	}
	result := make([]image.Rectangle, 0, rows*columns)
	for row := 0; row < rows; row++ {
		for column := 0; column < columns; column++ {
			result = append(result, image.Rect(column*width/columns, row*height/rows, (column+1)*width/columns, (row+1)*height/rows))
		}
	}
	return result, nil
}

func (s *Service) SplitDramaStoryboard(ctx context.Context, userID, projectID, boardID string, req DramaStoryboardActionRequest) (DramaStoryboardView, error) {
	board, err := s.dramaStoryboardScope(userID, projectID, boardID)
	if err != nil {
		return DramaStoryboardView{}, err
	}
	if req.ExpectedRevision == nil {
		return DramaStoryboardView{}, BadAuthRequest("请提供故事板版本")
	}
	ids, err := s.readyDramaStoryboard(s.repo, userID, board)
	if err != nil {
		return DramaStoryboardView{}, err
	}
	if board.Status == "split" {
		return s.DramaStoryboard(userID, projectID, boardID)
	}
	if board.Revision != *req.ExpectedRevision {
		return DramaStoryboardView{}, dramaStoryboardError(repository.ErrDramaStoryboardChanged)
	}
	if err := ctx.Err(); err != nil {
		return DramaStoryboardView{}, err
	}
	decoded, err := s.readDramaStoryboardImage(userID, board.ResourceID)
	if err != nil {
		return DramaStoryboardView{}, err
	}
	bounds := decoded.Bounds()
	rects, err := dramaStoryboardCellRects(bounds.Dx(), bounds.Dy(), board.Rows, board.Columns)
	if err != nil {
		return DramaStoryboardView{}, err
	}
	cells := make([]model.DramaStoryboardCell, 0, len(rects))
	resourceIDs := []string{board.ResourceID}
	for index, rect := range rects {
		if err := ctx.Err(); err != nil {
			return DramaStoryboardView{}, err
		}
		picture := image.NewNRGBA(image.Rect(0, 0, rect.Dx(), rect.Dy()))
		draw.Draw(picture, picture.Bounds(), decoded, rect.Min.Add(bounds.Min), draw.Src)
		var output bytes.Buffer
		if err := png.Encode(&output, picture); err != nil {
			return DramaStoryboardView{}, err
		}
		identity := fmt.Sprintf("drama-storyboard-cell:v1:%s:%s:%d:%d:%d:%d:%d", board.ID, board.ResourceID, index, rect.Min.X, rect.Min.Y, rect.Dx(), rect.Dy())
		resource, err := s.UploadResourceFile(userID, fmt.Sprintf("storyboard-%s-%d.png", board.ID, index+1), int64(output.Len()), "image", rect.Dx(), rect.Dy(), 0, bytes.NewReader(output.Bytes()), identity)
		if err != nil {
			return DramaStoryboardView{}, err
		}
		if resource.Status != model.ResourceStatusReady || resource.Kind != "image" || resource.MimeType != "image/png" || resource.Width != rect.Dx() || resource.Height != rect.Dy() {
			return DramaStoryboardView{}, errors.New("故事板裁片未保存为尺寸相符的真实 PNG 图片")
		}
		shotID := ""
		if index < len(ids) {
			shotID = ids[index]
		}
		cellID := dramaShotMediaDigest([]any{board.ID, board.ResourceID, index})[:32]
		cells = append(cells, model.DramaStoryboardCell{ID: cellID, ProjectID: projectID, BoardID: board.ID, Index: index, Row: index / board.Columns, Column: index % board.Columns, ShotID: shotID, ParentResourceID: board.ResourceID, ResourceID: resource.ID, X: rect.Min.X, Y: rect.Min.Y, Width: rect.Dx(), Height: rect.Dy(), CreatedAt: time.Now()})
		resourceIDs = append(resourceIDs, resource.ID)
	}
	err = s.repo.Transaction(func(repo *repository.Repository) error {
		if _, err := repo.DramaProductionForUpdate(projectID); err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := repo.LockDramaCastImageReferences(userID, resourceIDs); err != nil {
			return BadAuthRequest("故事板原图或裁片已变化，请重新裁切")
		}
		fresh, err := repo.DramaStoryboard(projectID, boardID)
		if err != nil {
			return err
		}
		if _, err := s.readyDramaStoryboard(repo, userID, fresh); err != nil {
			return err
		}
		if fresh.Status == "split" && fresh.ResourceID == board.ResourceID {
			return nil
		}
		if fresh.Revision != board.Revision || fresh.ResourceID != board.ResourceID {
			return repository.ErrDramaStoryboardChanged
		}
		for _, cell := range cells {
			resource, err := repo.ResourceForUser(userID, cell.ResourceID)
			if err != nil || resource.Status != model.ResourceStatusReady || resource.MimeType != "image/png" || resource.Width != cell.Width || resource.Height != cell.Height {
				return BadAuthRequest("故事板裁片已变化，请重新裁切")
			}
		}
		return repo.SaveDramaStoryboardCells(fresh, cells, bounds.Dx(), bounds.Dy())
	})
	if err != nil {
		return DramaStoryboardView{}, dramaStoryboardError(err)
	}
	return s.DramaStoryboard(userID, projectID, boardID)
}

func (s *Service) AdoptDramaStoryboardCell(userID, projectID, boardID string, req DramaStoryboardAdoptRequest) (DramaShotMediaView, error) {
	board, err := s.dramaStoryboardScope(userID, projectID, boardID)
	if err != nil {
		return DramaShotMediaView{}, err
	}
	if req.ExpectedRevision == nil || req.ExpectedMediaRevision == nil || req.CellID == "" {
		return DramaShotMediaView{}, BadAuthRequest("请选择裁片并提供故事板和镜头媒体版本")
	}
	if _, err := s.readyDramaStoryboard(s.repo, userID, board); err != nil {
		return DramaShotMediaView{}, err
	}
	cells, err := s.repo.DramaStoryboardCells(projectID, boardID)
	if err != nil {
		return DramaShotMediaView{}, err
	}
	var selected *model.DramaStoryboardCell
	for _, cell := range cells {
		if cell.ID == req.CellID {
			copy := cell
			selected = &copy
		}
	}
	if selected == nil || selected.ShotID == "" || selected.ParentResourceID != board.ResourceID {
		return DramaShotMediaView{}, BadAuthRequest("该裁片未关联真实镜头或不属于当前原图")
	}
	decoded, err := s.readDramaStoryboardImage(userID, selected.ResourceID)
	if err != nil || decoded.Bounds().Dx() != selected.Width || decoded.Bounds().Dy() != selected.Height {
		return DramaShotMediaView{}, BadAuthRequest("故事板裁片损坏或尺寸不符，不能采用")
	}
	err = s.repo.Transaction(func(repo *repository.Repository) error {
		p, err := repo.DramaProductionForUpdate(projectID)
		if err != nil {
			return err
		}
		if err := repo.LockDramaCastImageReferences(userID, []string{board.ResourceID, selected.ResourceID}); err != nil {
			return BadAuthRequest("故事板原图或裁片已变化")
		}
		fresh, err := repo.DramaStoryboard(projectID, boardID)
		if err != nil {
			return err
		}
		if fresh.Revision != *req.ExpectedRevision || fresh.Status != "split" || fresh.ResourceID != selected.ParentResourceID {
			return repository.ErrDramaStoryboardChanged
		}
		if _, err := s.readyDramaStoryboard(repo, userID, fresh); err != nil {
			return err
		}
		resource, err := repo.ResourceForUser(userID, selected.ResourceID)
		if err != nil || resource.Status != model.ResourceStatusReady || resource.Kind != "image" || resource.MimeType != "image/png" || resource.Width != selected.Width || resource.Height != selected.Height {
			return BadAuthRequest("故事板裁片已变化，不能采用")
		}
		shot, err := repo.DramaShot(projectID, selected.ShotID)
		if err != nil {
			return err
		}
		media, config, err := s.loadDramaShotMedia(repo, *shot, *p, "image")
		if err != nil {
			return err
		}
		if media.ResourceID == selected.ResourceID {
			return nil
		}
		if media.Revision != *req.ExpectedMediaRevision {
			return repository.ErrDramaShotMediaChanged
		}
		if media.ID == "" {
			configJSON, _ := json.Marshal(config)
			media.ID, media.ConfigJSON, media.Revision, media.CreatedAt, media.UpdatedAt = newID(), string(configJSON), 1, time.Now(), time.Now()
			if err := repo.SaveDramaShotMediaConfig(&media, 0); err != nil {
				return err
			}
		}
		take, err := repo.DramaStoryboardCellTake(projectID, selected.ShotID, fresh.TaskID, selected.ResourceID)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			take = &model.DramaTake{ID: newID(), ProjectID: projectID, OwnerID: selected.ShotID, Kind: "shot_image", TaskID: fresh.TaskID, ResourceID: selected.ResourceID, Prompt: shot.ImagePrompt, CreatedAt: time.Now()}
			if err := repo.CreateDramaTake(take); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		media.ScriptHash = dramaShotScriptHash(*shot)
		return repo.AdoptDramaShotMediaTake(&media, take, media.Revision)
	})
	if err != nil {
		return DramaShotMediaView{}, dramaShotMediaError(dramaStoryboardError(err))
	}
	return s.DramaShotMedia(userID, projectID, selected.ShotID, "image")
}
