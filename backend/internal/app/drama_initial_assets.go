package app

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"
)

type dramaInitialAssetsPayload struct {
	InitialAssets      bool     `json:"initialAssets"`
	SourceChapterIDs   []string `json:"sourceChapterIds"`
	SourceEpisodeIDs   []string `json:"sourceEpisodeIds,omitempty"`
	ReferenceChapterID string   `json:"referenceChapterId,omitempty"`
}

func dramaInitialAssets(job *model.DramaJob) (*dramaInitialAssetsPayload, error) {
	if job == nil || job.Kind != model.DramaJobBible || strings.TrimSpace(job.PayloadJSON) == "" {
		return nil, nil
	}
	var payload dramaInitialAssetsPayload
	if err := json.Unmarshal([]byte(job.PayloadJSON), &payload); err != nil {
		return nil, fmt.Errorf("首次资产提取范围无法读取：%w", err)
	}
	if !payload.InitialAssets {
		return nil, nil
	}
	if len(payload.SourceChapterIDs) == 0 || len(payload.SourceEpisodeIDs) > 1 {
		return nil, BadAuthRequest("首次资产提取来源范围无效")
	}
	seen := map[string]bool{}
	for _, id := range payload.SourceChapterIDs {
		if id == "" || id != strings.TrimSpace(id) || seen[id] {
			return nil, BadAuthRequest("首次资产提取来源范围无效")
		}
		seen[id] = true
	}
	for _, id := range payload.SourceEpisodeIDs {
		if id == "" || id != strings.TrimSpace(id) {
			return nil, BadAuthRequest("首次资产提取剧集范围无效")
		}
	}
	if id := payload.ReferenceChapterID; id != strings.TrimSpace(id) || seen[id] {
		return nil, BadAuthRequest("首次资产提取参考资料范围无效")
	}
	return &payload, nil
}

func enqueueDramaInitialAssets(tx *repository.Repository, projectID string, chapters []model.ProjectUnit, episodes []model.DramaEpisode, selectedNumber int) error {
	payload := dramaInitialAssetsPayload{InitialAssets: true}
	label := "首次资产提取：当前原文"
	if len(episodes) > 0 {
		selected := episodes[0]
		if selectedNumber > 0 {
			found := false
			for _, episode := range episodes {
				if episode.Number == selectedNumber {
					selected, found = episode, true
					break
				}
			}
			if !found {
				return BadAuthRequest("所选集已不在当前分集方案中，请重新选择剧集")
			}
		}
		payload.SourceChapterIDs = decodeStringList(selected.ChapterIDsJSON)
		payload.SourceEpisodeIDs = []string{selected.ID}
		label = fmt.Sprintf("首次资产提取：第 %d 集", selected.Number)
	} else {
		if selectedNumber > 0 {
			return BadAuthRequest("当前分集方案尚无所选剧集，请重新选择制作范围")
		}
		if len(chapters) == 0 {
			return BadAuthRequest("没有可提取的原文")
		}
		payload.SourceChapterIDs = []string{chapters[0].ID}
	}
	reference, err := tx.DramaSourceReference(projectID)
	if err != nil {
		return err
	}
	if reference != nil {
		payload.ReferenceChapterID = reference.ID
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	now := time.Now()
	return tx.CreateDramaJobs([]model.DramaJob{{ID: newID(), ProjectID: projectID, Kind: model.DramaJobBible, Status: model.DramaJobQueued, Priority: dramaPriorityBible, Label: label, PayloadJSON: string(encoded), CreatedAt: now, UpdatedAt: now}})
}

type dramaBibleSource struct {
	chapters   []production.Chapter
	reference  *production.Chapter
	extraction *dramaAssetExtractionPayload
	initial    *dramaInitialAssetsPayload
}

// A persisted source snapshot is shared by submission and paid-result recovery.
// Older jobs without that snapshot keep their original whole-work source.
func (r *dramaRun) loadBibleSource(job *model.DramaJob) (dramaBibleSource, error) {
	source := dramaBibleSource{}
	var err error
	source.extraction, err = dramaAssetExtraction(job)
	if err != nil {
		return source, err
	}
	source.initial, err = dramaInitialAssets(job)
	if err != nil {
		return source, err
	}
	var ids []string
	var referenceID string
	if source.extraction != nil {
		if source.initial != nil {
			return source, BadAuthRequest("资产提取范围不能同时指定首次和增量任务")
		}
		ids = source.extraction.SourceChapterIDs
		referenceID = source.extraction.ReferenceChapterID
	} else if source.initial != nil {
		ids = source.initial.SourceChapterIDs
		referenceID = source.initial.ReferenceChapterID
		for _, episodeID := range source.initial.SourceEpisodeIDs {
			episode, err := r.s.repo.DramaEpisode(r.project.ID, episodeID)
			if err != nil {
				return source, err
			}
			chapterIDs := decodeStringList(episode.ChapterIDsJSON)
			if len(chapterIDs) != len(ids) {
				return source, BadAuthRequest("首次资产提取来源正文已变化，请刷新后重试")
			}
			linked := make(map[string]bool, len(chapterIDs))
			for _, id := range chapterIDs {
				linked[id] = true
			}
			for _, id := range ids {
				if !linked[id] {
					return source, BadAuthRequest("首次资产提取来源正文已变化，请刷新后重试")
				}
			}
		}
	}
	source.chapters, err = r.loadChapters(ids)
	if err != nil {
		return source, err
	}
	if ids != nil && len(source.chapters) != len(ids) {
		return source, BadAuthRequest("资产提取来源正文已变化，请刷新后重试")
	}
	if referenceID == "" && ids != nil {
		return source, nil
	}
	reference, err := r.s.repo.DramaSourceReference(r.project.ID)
	if err != nil {
		return source, err
	}
	if referenceID != "" && (reference == nil || reference.ID != referenceID) {
		return source, BadAuthRequest("资产提取参考资料已变化，请刷新后重试")
	}
	if reference != nil {
		source.reference = &production.Chapter{ID: reference.ID, Title: reference.Title, Text: reference.SourceText, IsReference: true}
	}
	return source, nil
}
