package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
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
	AllChapters      bool     `json:"allChapters,omitempty"`
	EpisodeIDs       []string `json:"episodeIds,omitempty"`
	ChapterIDs       []string `json:"chapterIds,omitempty"`
}

type ExtractDramaAssetsResult struct {
	Job      DramaJobView `json:"job"`
	Revision int64        `json:"revision"`
}

type dramaAssetExtractionPayload struct {
	Scope              string   `json:"scope"`
	AssetKind          string   `json:"assetKind"`
	SourceChapterIDs   []string `json:"sourceChapterIds"`
	SourceEpisodeIDs   []string `json:"sourceEpisodeIds,omitempty"`
	ReferenceChapterID string   `json:"referenceChapterId,omitempty"`
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
	if id := payload.ReferenceChapterID; id != "" && (id != strings.TrimSpace(id) || len(payload.SourceEpisodeIDs) != 0 || slices.Contains(payload.SourceChapterIDs, id)) {
		return nil, BadAuthRequest("资产查漏参考资料范围无效")
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
	if req.AllChapters && (req.EpisodeIDs != nil || req.ChapterIDs != nil) {
		return ExtractDramaAssetsResult{}, BadAuthRequest("提取全部原文时不能同时指定剧集或章节范围")
	}
	if req.EpisodeIDs != nil && req.ChapterIDs != nil {
		return ExtractDramaAssetsResult{}, BadAuthRequest("请选择按集或按章节提取，不要同时提交两种范围")
	}
	if req.EpisodeIDs != nil && len(req.EpisodeIDs) == 0 || req.ChapterIDs != nil && len(req.ChapterIDs) == 0 {
		return ExtractDramaAssetsResult{}, BadAuthRequest("请至少选择一集或一个章节")
	}
	var job model.DramaJob
	err = dramaGuideError(s.repo.Transaction(func(tx *repository.Repository) error {
		current, err := tx.DramaProductionForUpdate(project.ID)
		if err != nil {
			return err
		}
		if current.Revision != req.ExpectedRevision {
			return repository.ErrDramaGuideChanged
		}
		if current.GuideStep != "" && current.GuideStep != model.DramaGuideAssets && current.GuideStep != model.DramaGuideStory && current.GuideStep != model.DramaGuideCompleted {
			return dramaGuideConflict("请先确认制作方案，再增量提取资产")
		}
		if current.Stage == model.DramaStageBible {
			return dramaGuideConflict("请先完成首次资产提取，再按类型重新查漏")
		}
		// 各类查漏只添加对应资产，可同时进行；正文、编排等其他文字任务仍与查漏互斥。
		active, err := tx.DramaJobsByStatus(project.ID, model.DramaJobQueued, model.DramaJobRunning)
		if err != nil {
			return err
		}
		for _, activeJob := range active {
			switch activeJob.Kind {
			case model.DramaJobBible:
				scope, err := dramaAssetExtraction(&activeJob)
				if err != nil {
					return err
				}
				if scope != nil {
					if scope.AssetKind == req.Kind {
						return dramaGuideConflict("该类型资产正在提取，请等待当前任务完成")
					}
					continue
				}
			case model.DramaJobPlan, model.DramaJobScript, model.DramaJobSegmentPrompt:
			default:
				continue
			}
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
	}))
	if err != nil {
		return ExtractDramaAssetsResult{}, err
	}
	s.wakeDramaScheduler()
	// 查漏入队不改变正文或制作配置，不递增共用版本，允许其他种类沿用当前页面版本入队。
	return ExtractDramaAssetsResult{Job: dramaJobView(job), Revision: req.ExpectedRevision}, nil
}

func dramaAssetExtractionSource(tx *repository.Repository, projectID string, req ExtractDramaAssetsRequest) (dramaAssetExtractionPayload, string, error) {
	payload := dramaAssetExtractionPayload{Scope: dramaAssetExtractionScope, AssetKind: req.Kind, SourceChapterIDs: []string{}}
	var chapters []model.ProjectUnit
	var err error
	if req.AllChapters {
		chapters, err = tx.DramaGuideSourceChapters(projectID)
	} else {
		chapters, err = tx.DramaChapters(projectID)
	}
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
		if req.AllChapters {
			return payload, "", BadAuthRequest("没有可提取的原文")
		}
		return payload, "", BadAuthRequest("没有可提取的制作正文")
	}
	label := map[string]string{"character": "角色", "scene": "场景", "prop": "道具"}[req.Kind] + "增量提取 / 重新查漏："
	if req.AllChapters {
		reference, err := tx.DramaSourceReference(projectID)
		if err != nil {
			return payload, "", err
		}
		if reference == nil {
			label += fmt.Sprintf("全部原文（%d 章）", len(payload.SourceChapterIDs))
		} else {
			payload.ReferenceChapterID = reference.ID
			label += fmt.Sprintf("全部原文（%d 章和作品参考资料）", len(payload.SourceChapterIDs))
		}
	} else if len(episodeNumbers) > 0 {
		label += "第 " + strings.Join(episodeNumbers, "、") + " 集"
	} else {
		label += fmt.Sprintf("%d 个制作章节", len(payload.SourceChapterIDs))
	}
	return payload, truncateRunes(label, 200), nil
}

// 独立查漏保持原有制作状态。仅剩预算等待的查漏时，已获准的媒体可继续派发。
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
	if status == model.DramaStatusRunning && r.production.Status == status {
		pending, err := r.s.repo.DramaAssetExtractionJobs(r.project.ID, model.DramaJobQueued, model.DramaJobRunning)
		if err != nil {
			return true, err
		}
		if dramaExtractionWaitingForBudget(pending) {
			if err := r.loadCasts(); err != nil {
				return true, err
			}
			if err := r.planCastImages(false); err != nil {
				return true, err
			}
			if err := r.persistPlannedJobs(true); errors.Is(err, repository.ErrDramaGuideChanged) {
				return true, r.saveProgress(status, false)
			} else if err != nil {
				return true, err
			}
			queued, err := r.queuedJobsForGuide()
			if err != nil {
				return true, err
			}
			media := queued[:0]
			for _, job := range queued {
				if dramaDispatchPool(job.Kind) != dramaPoolText {
					media = append(media, job)
				}
			}
			if err := r.dispatchJobs(media); err != nil {
				return true, err
			}
		}
	}
	return true, r.saveProgress(status, r.production.Status != status || r.production.PauseReason != pauseReason)
}

func dramaExtractionWaitingForBudget(jobs []model.DramaJob) bool {
	for _, job := range jobs {
		if job.Status != model.DramaJobQueued || job.Error != dramaBudgetPauseReason {
			return false
		}
	}
	return len(jobs) > 0
}
