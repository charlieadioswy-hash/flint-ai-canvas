package app

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

const dramaAssetExtractionScope = "asset_extraction"

// ExtractDramaAssetsRequest 只查漏指定类型与来源；不会覆盖已有资产文字或生成图片。
type ExtractDramaAssetsRequest struct {
	ExpectedRevision int64    `json:"expectedRevision"`
	Kind             string   `json:"kind"`
	EpisodeIDs       []string `json:"episodeIds,omitempty"`
	ChapterIDs       []string `json:"chapterIds,omitempty"`
}

type ExtractDramaAssetsResult struct {
	Job      DramaJobView `json:"job"`
	Revision int64        `json:"revision"`
}

type dramaAssetExtractionPayload struct {
	Scope            string   `json:"scope"`
	AssetKind        string   `json:"assetKind"`
	SourceChapterIDs []string `json:"sourceChapterIds"`
	SourceEpisodeIDs []string `json:"sourceEpisodeIds,omitempty"`
}

func dramaAssetExtraction(job *model.DramaJob) (*dramaAssetExtractionPayload, error) {
	if job == nil || job.Kind != model.DramaJobBible || strings.TrimSpace(job.PayloadJSON) == "" {
		return nil, nil
	}
	var payload dramaAssetExtractionPayload
	if err := json.Unmarshal([]byte(job.PayloadJSON), &payload); err != nil {
		return nil, fmt.Errorf("资产提取范围无法读取：%w", err)
	}
	if payload.Scope == "" && payload.AssetKind == "" {
		return nil, nil
	}
	if payload.Scope != dramaAssetExtractionScope || !validDramaCastKind(payload.AssetKind) || len(payload.SourceChapterIDs) == 0 {
		return nil, BadAuthRequest("资产提取类型或来源范围无效")
	}
	return &payload, nil
}

func (s *Service) ExtractDramaAssets(userID, projectID string, req ExtractDramaAssetsRequest) (ExtractDramaAssetsResult, error) {
	project, _, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return ExtractDramaAssetsResult{}, err
	}
	if !validDramaCastKind(req.Kind) {
		return ExtractDramaAssetsResult{}, BadAuthRequest("资产类型必须为角色、场景或道具")
	}
	if req.EpisodeIDs != nil && req.ChapterIDs != nil {
		return ExtractDramaAssetsResult{}, BadAuthRequest("请选择按集或按章节提取，不要同时提交两种范围")
	}
	if req.EpisodeIDs != nil && len(req.EpisodeIDs) == 0 || req.ChapterIDs != nil && len(req.ChapterIDs) == 0 {
		return ExtractDramaAssetsResult{}, BadAuthRequest("请至少选择一集或一个章节")
	}
	var job model.DramaJob
	err = s.withDramaTextEdit(project.ID, &req.ExpectedRevision, false, func(tx *repository.Repository) error {
		current, err := tx.DramaProduction(project.ID)
		if err != nil {
			return err
		}
		if current.GuideStep != "" && current.GuideStep != model.DramaGuideAssets && current.GuideStep != model.DramaGuideStory && current.GuideStep != model.DramaGuideCompleted {
			return dramaGuideConflict("请先确认制作方案，再增量提取资产")
		}
		if current.Stage == model.DramaStageBible {
			return dramaGuideConflict("请先完成首次资产提取，再按类型重新查漏")
		}
		// 已完成引导也与其他文字操作互斥；不能靠进入制作台绕过运行中的任务。
		active, err := tx.DramaTextJobsActive(project.ID)
		if err != nil {
			return err
		}
		if active {
			return dramaGuideConflict("文字任务正在进行，请完成后再增量提取")
		}
		payload, label, err := dramaAssetExtractionSource(tx, project.ID, req)
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		now := time.Now()
		job = model.DramaJob{ID: newID(), ProjectID: project.ID, Kind: model.DramaJobBible, Status: model.DramaJobQueued, Priority: dramaPriorityBible, Label: label, PayloadJSON: string(encoded), CreatedAt: now, UpdatedAt: now}
		return tx.CreateDramaJobs([]model.DramaJob{job})
	})
	if err != nil {
		return ExtractDramaAssetsResult{}, err
	}
	s.wakeDramaScheduler()
	return ExtractDramaAssetsResult{Job: dramaJobView(job), Revision: req.ExpectedRevision + 1}, nil
}

func dramaAssetExtractionSource(tx *repository.Repository, projectID string, req ExtractDramaAssetsRequest) (dramaAssetExtractionPayload, string, error) {
	payload := dramaAssetExtractionPayload{Scope: dramaAssetExtractionScope, AssetKind: req.Kind, SourceChapterIDs: []string{}}
	chapters, err := tx.DramaChapters(projectID)
	if err != nil {
		return payload, "", err
	}
	allowed := make(map[string]bool, len(chapters))
	for _, chapter := range chapters {
		allowed[chapter.ID] = true
	}
	selected := map[string]bool{}
	var episodeNumbers []string
	if req.EpisodeIDs != nil {
		seen := map[string]bool{}
		for _, id := range req.EpisodeIDs {
			if id != strings.TrimSpace(id) || id == "" || seen[id] {
				return payload, "", BadAuthRequest("剧集范围包含空白或重复项")
			}
			seen[id] = true
			episode, err := tx.DramaEpisode(projectID, id)
			if err != nil {
				return payload, "", dramaLookupError(err)
			}
			ids := decodeStringList(episode.ChapterIDsJSON)
			if len(ids) == 0 {
				return payload, "", BadAuthRequest("所选剧集没有可提取的来源正文")
			}
			for _, chapterID := range ids {
				if !allowed[chapterID] {
					return payload, "", BadAuthRequest("所选剧集包含未加入制作的章节")
				}
				selected[chapterID] = true
			}
			payload.SourceEpisodeIDs = append(payload.SourceEpisodeIDs, id)
			episodeNumbers = append(episodeNumbers, fmt.Sprintf("%d", episode.Number))
		}
	} else if req.ChapterIDs != nil {
		for _, id := range req.ChapterIDs {
			if !allowed[id] || selected[id] {
				return payload, "", BadAuthRequest("章节范围包含重复、无权限或未加入制作的章节")
			}
			selected[id] = true
		}
	} else {
		selected = allowed
	}
	for _, chapter := range chapters {
		if selected[chapter.ID] {
			payload.SourceChapterIDs = append(payload.SourceChapterIDs, chapter.ID)
		}
	}
	if len(payload.SourceChapterIDs) == 0 {
		return payload, "", BadAuthRequest("没有可提取的制作正文")
	}
	label := map[string]string{"character": "角色", "scene": "场景", "prop": "道具"}[req.Kind] + "增量提取 / 重新查漏："
	if len(episodeNumbers) > 0 {
		label += "第 " + strings.Join(episodeNumbers, "、") + " 集"
	} else {
		label += fmt.Sprintf("%d 个制作章节", len(payload.SourceChapterIDs))
	}
	return payload, truncateRunes(label, 200), nil
}

// 独立查漏只派发显式请求的 Bible 作业，保持制作暂停状态，也不规划后续分镜或媒体。
func (r *dramaRun) tickAssetExtraction() (bool, error) {
	jobs, err := r.s.repo.DramaAssetExtractionJobs(r.project.ID, model.DramaJobQueued, model.DramaJobRunning)
	if err != nil || len(jobs) == 0 {
		return false, err
	}
	status, pauseReason := r.production.Status, r.production.PauseReason
	if err := r.syncJobs(); err != nil {
		return true, err
	}
	queued, err := r.s.repo.DramaAssetExtractionJobs(r.project.ID, model.DramaJobQueued)
	if err != nil {
		return true, err
	}
	if err := r.dispatchJobs(queued); err != nil {
		return true, err
	}
	// 独立查漏用相同预算准入，但预算不足不能把已完成的作品改成“暂停”。队列单独显示预算等待原因。
	r.production.Status, r.production.PauseReason = status, pauseReason
	return true, r.s.repo.SaveDramaProductionProgress(r.production, status, false)
}
