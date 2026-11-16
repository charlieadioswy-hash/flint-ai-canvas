package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

type DramaStoryboardCreateRequest struct {
	ClientOperationID string               `json:"clientOperationId"`
	ShotIDs           []string             `json:"shotIds"`
	Rows              int                  `json:"rows"`
	Columns           int                  `json:"columns"`
	Config            DramaShotMediaConfig `json:"config"`
}

type DramaStoryboardActionRequest = DramaShotMediaActionRequest

type DramaStoryboardAdoptRequest struct {
	ExpectedRevision      *int64 `json:"expectedRevision"`
	ExpectedMediaRevision *int64 `json:"expectedMediaRevision"`
	CellID                string `json:"cellId"`
}

type DramaStoryboardCellView struct {
	model.DramaStoryboardCell
	MediaRevision int64 `json:"mediaRevision"`
	Current       bool  `json:"current"`
}

type DramaStoryboardView struct {
	model.DramaStoryboardBoard
	Config  DramaShotMediaConfig      `json:"config"`
	ShotIDs []string                  `json:"shotIds"`
	Cells   []DramaStoryboardCellView `json:"cells"`
	Error   string                    `json:"error,omitempty"`
}

type DramaStoryboardPreflight struct {
	BoardID            string `json:"boardId"`
	Revision           int64  `json:"revision"`
	BaseRevision       int64  `json:"baseRevision"`
	Ready              bool   `json:"ready"`
	Reason             string `json:"reason,omitempty"`
	Priced             bool   `json:"priced"`
	AmountMicrocredits int64  `json:"amountMicrocredits"`
	Estimated          bool   `json:"estimated"`
	ConfirmationToken  string `json:"confirmationToken"`
	ScopeHash          string `json:"scopeHash"`
}

type dramaStoryboardPlan struct {
	view    DramaStoryboardPreflight
	board   model.DramaStoryboardBoard
	config  DramaShotMediaConfig
	request CreateTaskRequest
}

func validDramaStoryboardGrid(rows, columns int) bool {
	return rows == 2 && (columns == 2 || columns == 3) || rows == 3 && columns == 3
}

func dramaStoryboardShotSnapshot(repo *repository.Repository, projectID string, ids []string) ([]model.DramaShot, string, error) {
	if len(ids) == 0 || len(ids) > 9 {
		return nil, "", BadAuthRequest("请选择 1–9 个真实镜头")
	}
	shots := make([]model.DramaShot, 0, len(ids))
	fingerprints := []any{}
	seen := map[string]bool{}
	for _, id := range ids {
		if strings.TrimSpace(id) == "" || seen[id] {
			return nil, "", BadAuthRequest("镜头不能为空或重复")
		}
		seen[id] = true
		shot, err := repo.DramaShot(projectID, id)
		if err != nil {
			return nil, "", err
		}
		if len(shots) > 0 && shot.EpisodeID != shots[0].EpisodeID {
			return nil, "", BadAuthRequest("宫格故事板只关联同一集的镜头")
		}
		shots = append(shots, *shot)
		fingerprints = append(fingerprints, []string{id, dramaShotScriptHash(*shot)})
	}
	return shots, dramaShotMediaDigest(fingerprints), nil
}

func dramaStoryboardPrompt(config DramaShotMediaConfig, shots []model.DramaShot, rows, columns int) string {
	var text strings.Builder
	fmt.Fprintf(&text, "生成一张 %d 行 %d 列的连贯短剧故事板，严格等分网格、无外边距、无文字水印。各格独立构图，保持人物身份、服装、道具与场景连续。按从左到右、从上到下顺序绘制，不增加镜头。\n", rows, columns)
	for index, shot := range shots {
		prompt := firstNonEmpty(shot.ImagePrompt, strings.TrimSpace(shot.Scene+" "+shot.Action+" "+shot.Dialogue))
		fmt.Fprintf(&text, "第 %d 格，对应镜头 %d：%s\n", index+1, shot.Position+1, prompt)
	}
	if empty := rows*columns - len(shots); empty > 0 {
		fmt.Fprintf(&text, "最后 %d 格留空白，不添加人物、动作或其他剧情。\n", empty)
	}
	if config.Prompt != "" {
		text.WriteString("补充要求：\n" + config.Prompt)
	}
	return text.String()
}

func (s *Service) CreateDramaStoryboard(userID, projectID string, req DramaStoryboardCreateRequest) (DramaStoryboardView, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return DramaStoryboardView{}, err
	}
	if req.ClientOperationID == "" {
		return DramaStoryboardView{}, BadAuthRequest("请提供故事板创建标识")
	}
	if !validDramaStoryboardGrid(req.Rows, req.Columns) || len(req.ShotIDs) > req.Rows*req.Columns {
		return DramaStoryboardView{}, BadAuthRequest("请选择 2×2、2×3 或 3×3 宫格，镜头数不能超过格数")
	}
	submission, err := newTaskSubmission(userID, req.ClientOperationID, "drama_storyboard_board", []any{projectID, req})
	if err != nil {
		return DramaStoryboardView{}, err
	}
	if existing, err := s.repo.DramaStoryboard(projectID, submission.ID); err == nil {
		if existing.RequestHash != submission.Hash {
			return DramaStoryboardView{}, dramaGuideConflict("同一创建标识的故事板内容不同")
		}
		return s.DramaStoryboard(userID, projectID, existing.ID)
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return DramaStoryboardView{}, err
	}
	config, err := s.normalizeDramaShotMediaConfig(s.repo, userID, projectID, "image", req.Config)
	if err != nil {
		return DramaStoryboardView{}, err
	}
	err = s.repo.Transaction(func(repo *repository.Repository) error {
		if _, err := repo.DramaProductionForUpdate(projectID); err != nil {
			return err
		}
		if err := repo.LockDramaCastImageReferences(userID, config.ReferenceResourceIDs); err != nil {
			return BadAuthRequest("故事板参考图已变化，请重新选择")
		}
		config, err = s.normalizeDramaShotMediaConfig(repo, userID, projectID, "image", config)
		if err != nil {
			return err
		}
		shots, hash, err := dramaStoryboardShotSnapshot(repo, projectID, req.ShotIDs)
		if err != nil {
			return err
		}
		config.Prompt = dramaStoryboardPrompt(config, shots, req.Rows, req.Columns)
		config, err = s.normalizeDramaShotMediaConfig(repo, userID, projectID, "image", config)
		if err != nil {
			return err
		}
		configJSON, _ := json.Marshal(config)
		idsJSON, _ := json.Marshal(req.ShotIDs)
		row := model.DramaStoryboardBoard{ID: submission.ID, ProjectID: projectID, UserID: userID, EpisodeID: shots[0].EpisodeID, Rows: req.Rows, Columns: req.Columns, Revision: 1, ConfigJSON: string(configJSON), ShotIDsJSON: string(idsJSON), ScriptHash: hash, RequestHash: submission.Hash, Status: "draft", CreatedAt: time.Now(), UpdatedAt: time.Now()}
		return repo.CreateDramaStoryboard(&row)
	})
	if err != nil {
		if existing, lookupErr := s.repo.DramaStoryboard(projectID, submission.ID); lookupErr == nil && existing.RequestHash == submission.Hash {
			return s.DramaStoryboard(userID, projectID, existing.ID)
		}
		return DramaStoryboardView{}, err
	}
	return s.DramaStoryboard(userID, projectID, submission.ID)
}

func (s *Service) dramaStoryboardScope(userID, projectID, boardID string) (*model.DramaStoryboardBoard, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return nil, err
	}
	board, err := s.repo.DramaStoryboard(projectID, boardID)
	if err == nil && board.UserID != userID {
		return nil, NotFound("故事板不存在")
	}
	return board, err
}

func decodeDramaStoryboard(board model.DramaStoryboardBoard) (DramaShotMediaConfig, []string, error) {
	var config DramaShotMediaConfig
	var ids []string
	if json.Unmarshal([]byte(board.ConfigJSON), &config) != nil || json.Unmarshal([]byte(board.ShotIDsJSON), &ids) != nil || !validDramaStoryboardGrid(board.Rows, board.Columns) || len(ids) == 0 || len(ids) > board.Rows*board.Columns {
		return config, nil, errors.New("故事板配置或镜头关联损坏")
	}
	return config, ids, nil
}

func (s *Service) DramaStoryboard(userID, projectID, boardID string) (DramaStoryboardView, error) {
	board, err := s.dramaStoryboardScope(userID, projectID, boardID)
	if err != nil {
		return DramaStoryboardView{}, err
	}
	config, ids, err := decodeDramaStoryboard(*board)
	if err != nil {
		return DramaStoryboardView{}, err
	}
	view := DramaStoryboardView{DramaStoryboardBoard: *board, Config: config, ShotIDs: ids, Cells: []DramaStoryboardCellView{}}
	if board.TaskID != "" {
		task, err := s.repo.TaskForUser(userID, board.TaskID)
		if err != nil {
			return view, err
		}
		if task.Status == model.TaskStatusSucceeded && board.ResourceID == "" {
			if _, err := s.RegisterDramaStoryboardTaskOutput(*task); err != nil {
				return view, err
			}
			board, err = s.repo.DramaStoryboard(projectID, boardID)
			if err != nil {
				return view, err
			}
			view.DramaStoryboardBoard = *board
		}
		if task.Status != model.TaskStatusSucceeded {
			view.Status, view.Error = string(task.Status), task.Error
		}
	}
	if _, hash, scriptErr := dramaStoryboardShotSnapshot(s.repo, projectID, ids); scriptErr != nil || hash != board.ScriptHash {
		view.Status, view.Error = "stale", "镜头原稿已变化，请使用当前镜头创建新的故事板"
	}
	cells, err := s.repo.DramaStoryboardCells(projectID, boardID)
	if err != nil {
		return view, err
	}
	for _, cell := range cells {
		item := DramaStoryboardCellView{DramaStoryboardCell: cell}
		if cell.ShotID != "" {
			media, err := s.repo.DramaShotMedia(projectID, cell.ShotID, "image")
			if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return view, err
			}
			if media != nil {
				item.MediaRevision, item.Current = media.Revision, media.ResourceID == cell.ResourceID
			}
		}
		view.Cells = append(view.Cells, item)
	}
	return view, nil
}

func (s *Service) DramaStoryboards(userID, projectID, episodeID string) ([]DramaStoryboardView, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return nil, err
	}
	if _, err := s.repo.DramaEpisode(projectID, episodeID); err != nil {
		return nil, err
	}
	rows, err := s.repo.DramaStoryboards(projectID, episodeID)
	if err != nil {
		return nil, err
	}
	views := make([]DramaStoryboardView, 0, len(rows))
	for _, row := range rows {
		view, err := s.DramaStoryboard(userID, projectID, row.ID)
		if err != nil {
			return nil, err
		}
		views = append(views, view)
	}
	return views, nil
}

func (s *Service) PreflightDramaStoryboard(userID, projectID, boardID string, req DramaStoryboardActionRequest) (DramaStoryboardPreflight, error) {
	if _, err := s.dramaStoryboardScope(userID, projectID, boardID); err != nil {
		return DramaStoryboardPreflight{}, err
	}
	plan, err := s.prepareDramaStoryboard(s.repo, userID, projectID, boardID, req)
	return plan.view, dramaStoryboardError(err)
}

func (s *Service) prepareDramaStoryboard(repo *repository.Repository, userID, projectID, boardID string, req DramaStoryboardActionRequest) (dramaStoryboardPlan, error) {
	board, err := repo.DramaStoryboard(projectID, boardID)
	if err != nil {
		return dramaStoryboardPlan{}, err
	}
	return s.prepareDramaStoryboardBoard(repo, userID, projectID, *board, req)
}

// QuoteDramaStoryboard evaluates a new board without creating history rows or tasks.
func (s *Service) QuoteDramaStoryboard(userID, projectID string, req DramaStoryboardCreateRequest) (DramaStoryboardPreflight, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return DramaStoryboardPreflight{}, err
	}
	if !validDramaStoryboardGrid(req.Rows, req.Columns) || len(req.ShotIDs) > req.Rows*req.Columns {
		return DramaStoryboardPreflight{}, BadAuthRequest("请选择 2×2、2×3 或 3×3 宫格，镜头数不能超过格数")
	}
	config, err := s.normalizeDramaShotMediaConfig(s.repo, userID, projectID, "image", req.Config)
	if err != nil {
		return DramaStoryboardPreflight{}, err
	}
	shots, hash, err := dramaStoryboardShotSnapshot(s.repo, projectID, req.ShotIDs)
	if err != nil {
		return DramaStoryboardPreflight{}, err
	}
	config.Prompt = dramaStoryboardPrompt(config, shots, req.Rows, req.Columns)
	configJSON, _ := json.Marshal(config)
	idsJSON, _ := json.Marshal(req.ShotIDs)
	board := model.DramaStoryboardBoard{ProjectID: projectID, UserID: userID, EpisodeID: shots[0].EpisodeID, Rows: req.Rows, Columns: req.Columns, ConfigJSON: string(configJSON), ShotIDsJSON: string(idsJSON), ScriptHash: hash}
	plan, err := s.prepareDramaStoryboardBoard(s.repo, userID, projectID, board, DramaStoryboardActionRequest{})
	plan.view.ConfirmationToken = ""
	return plan.view, dramaStoryboardError(err)
}

func (s *Service) prepareDramaStoryboardBoard(repo *repository.Repository, userID, projectID string, board model.DramaStoryboardBoard, req DramaStoryboardActionRequest) (dramaStoryboardPlan, error) {
	plan := dramaStoryboardPlan{view: DramaStoryboardPreflight{BoardID: board.ID}}
	p, err := repo.DramaProduction(projectID)
	if err != nil {
		return plan, err
	}
	config, ids, err := decodeDramaStoryboard(board)
	if err != nil {
		return plan, err
	}
	plan.board, plan.config = board, config
	plan.view.Revision, plan.view.BaseRevision = board.Revision, p.Revision
	if req.ExpectedRevision != nil && *req.ExpectedRevision != board.Revision || req.BaseRevision != nil && *req.BaseRevision != p.Revision {
		return plan, repository.ErrDramaStoryboardChanged
	}
	blocked := func(reason string) (dramaStoryboardPlan, error) { plan.view.Reason = reason; return plan, nil }
	if board.TaskID != "" {
		return blocked("该故事板已经提交过，请新建一次生成以保留历史")
	}
	if dramaGuideActive(p) && p.GuideStep != model.DramaGuideStory {
		return blocked("请先完成资产与分镜文字确认")
	}
	if _, hash, err := dramaStoryboardShotSnapshot(repo, projectID, ids); err != nil || hash != board.ScriptHash {
		return blocked("镜头原稿已变化，请创建新的故事板")
	}
	config, err = s.normalizeDramaShotMediaConfig(repo, userID, projectID, "image", config)
	if err != nil || config.Model.Empty() || config.Prompt == "" {
		return blocked("故事板模型、提示词或参考图不可用")
	}
	providerConfig := map[string]any{"size": config.AspectRatio, "imageResolution": config.Resolution, "count": "1"}
	if config.Model.ChannelID != "" {
		providerConfig["channelId"], providerConfig["model"], providerConfig["channelModelKey"] = config.Model.ChannelID, config.Model.ModelKey, config.Model.ModelKey
	}
	refs := []any{}
	for _, id := range config.ReferenceResourceIDs {
		resource, err := repo.ResourceForUser(userID, id)
		if err != nil {
			return plan, err
		}
		refs = append(refs, map[string]any{"id": id, "storageKey": "resource:" + id, "mimeType": resource.MimeType, "width": resource.Width, "height": resource.Height, "bytes": resource.Size})
	}
	input := map[string]any{"mode": "image", "prompt": config.Prompt, "config": providerConfig, "referenceImages": refs, "metadata": map[string]any{"source": "drama_storyboard_board", "domainProjectId": projectID, "episodeId": board.EpisodeID, "dramaStoryboardBoardId": board.ID}}
	encoded, _ := json.Marshal(input)
	var unresolved map[string]any
	_ = json.Unmarshal(encoded, &unresolved)
	frontendEnabled, err := s.FeatureEnabled(FeatureFrontendModels)
	if err != nil {
		return plan, err
	}
	_, input, err = s.resolveTaskModelSelection(userID, input, config.Model.LogicalModelID, "canvas_image", config.Operation, frontendEnabled)
	if err != nil {
		return blocked(err.Error())
	}
	if err := s.ValidateTaskCapability(input); err != nil {
		return blocked(err.Error())
	}
	intent := ModelRequestIntentFromTaskInput(input, "canvas_image", config.Operation)
	var quote *LogicalModelQuote
	if config.Model.LogicalModelID != "" {
		quote, err = s.QuoteLogicalModel(userID, config.Model.LogicalModelID, intent)
	} else {
		quote, err = s.QuoteChannelModel(userID, ChannelModelQuoteRequest{ChannelID: config.Model.ChannelID, ModelKey: config.Model.ModelKey, Intent: intent})
	}
	if err != nil || quote == nil {
		return blocked("故事板参数无法取得有效报价")
	}
	plan.view.Priced, plan.view.AmountMicrocredits, plan.view.Estimated = true, quote.AmountMicrocredits, quote.Estimated
	if p.BudgetMicrocredits > 0 {
		totals, err := repo.DramaBillingTotals(userID, []string{projectID})
		if err != nil {
			return plan, err
		}
		if totals[projectID].ChargedMicrocredits()+totals[projectID].HeldMicrocredits()+quote.AmountMicrocredits > p.BudgetMicrocredits {
			return blocked("剩余制作预算不足")
		}
	}
	plan.view.Ready = true
	plan.view.ScopeHash = dramaShotMediaDigest([]any{projectID, board.EpisodeID, board.Rows, board.Columns, ids, board.ScriptHash, config, p.Revision, p.GuideStep, intent})
	plan.view.ConfirmationToken = dramaShotMediaDigest([]any{board, config, p.Revision, p.GuideStep, quote, intent})
	plan.request = CreateTaskRequest{ProjectID: projectID, Type: "canvas_image", Operation: config.Operation, Prompt: config.Prompt, LogicalModelID: config.Model.LogicalModelID, Model: config.Model.ModelKey, Input: unresolved}
	return plan, nil
}

func dramaStoryboardError(err error) error {
	if errors.Is(err, repository.ErrDramaStoryboardChanged) {
		return dramaGuideConflict(err.Error())
	}
	return err
}

func taskHasDramaStoryboardOrigin(raw string) bool {
	var input struct {
		Metadata struct {
			Source string `json:"source"`
		} `json:"metadata"`
	}
	return json.Unmarshal([]byte(raw), &input) == nil && input.Metadata.Source == "drama_storyboard_board"
}
