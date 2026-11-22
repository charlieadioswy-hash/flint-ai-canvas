package app

import (
	"fmt"
	"strings"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

type dramaEpisodeVideos struct {
	Source   string
	Total    int
	Ready    int
	Timeline renderProject
}

// 一旦选用了逐镜视频，成片就按完整镜头顺序读取；缺镜时不能静默混入旧段视频。
func dramaEpisodeVideoTimeline(repo *repository.Repository, userID, projectID, episodeID, aspect string) (dramaEpisodeVideos, error) {
	view := dramaEpisodeVideos{Source: "segments"}
	shots, err := repo.DramaShots(episodeID)
	if err != nil {
		return view, err
	}
	rows, err := repo.DramaEpisodeShotMedia(projectID, episodeID, "video")
	if err != nil {
		return view, err
	}
	byShot := make(map[string]model.DramaShotMedia, len(rows))
	for _, row := range rows {
		byShot[row.ShotID] = row
	}
	for _, shot := range shots {
		if shot.ProjectID != projectID {
			return view, fmt.Errorf("镜头不属于当前短剧，请重新载入分镜")
		}
		if row := byShot[shot.ID]; row.ResourceID != "" || row.CurrentTakeID != "" {
			view.Source = "shots"
		}
	}
	if view.Source == "segments" {
		segments, err := repo.DramaSegments(episodeID)
		if err != nil {
			return view, err
		}
		view.Total = len(segments)
		durations, err := dramaSegmentSourceDurations(repo, userID, segments, false)
		if err != nil {
			return view, err
		}
		for _, segment := range segments {
			if segment.VideoStatus == model.DramaMediaReady && segment.VideoResourceID != "" &&
				(durations[segment.VideoResourceID] > 0 || segment.VideoSeconds > 0) {
				view.Ready++
			}
		}
		view.Timeline, _, err = buildDramaTimeline(segments, aspect, durations, false)
		if err != nil {
			return view, err
		}
		byIndex := make(map[int]bool, len(segments))
		for _, segment := range segments {
			byIndex[segment.SegmentIndex] = true
		}
		for _, shot := range shots {
			if !byIndex[shot.SegmentIndex] {
				return view, fmt.Errorf("第 %d 段尚未就绪，请完成全部段视频后再合成", shot.SegmentIndex+1)
			}
		}
		return view, nil
	}
	view.Total = len(shots)
	width, height := dramaRenderSize(aspect)
	visible := true
	view.Timeline = renderProject{Version: 2, Width: width, Height: height, Tracks: []renderTrack{{ID: "video", Kind: "video", Visible: &visible}}}
	var firstError error
	for index, shot := range shots {
		row := byShot[shot.ID]
		problem := ""
		if row.ResourceID == "" || row.CurrentTakeID == "" {
			problem = "尚未选用视频"
		} else if row.Status != model.DramaMediaReady || row.ScriptHash != dramaShotScriptHash(shot) {
			problem = "视频需要更新或仍在生成"
		}
		var duration int64
		if problem == "" {
			take, err := repo.DramaShotMediaTake(projectID, shot.ID, "video", row.CurrentTakeID)
			resource, resourceErr := repo.ResourceForUser(userID, row.ResourceID)
			if err != nil || resourceErr != nil || take.ResourceID != row.ResourceID || resource.Status != model.ResourceStatusReady || resource.Kind != "video" || !strings.HasPrefix(resource.MimeType, "video/") {
				problem = "选用的视频资源不可用"
			} else {
				duration = resource.DurationMs
				if duration <= 0 {
					duration = take.DurationMs
				}
				if duration <= 0 {
					problem = "视频缺少有效时长"
				}
			}
		}
		if problem != "" {
			if firstError == nil {
				firstError = fmt.Errorf("第 %d 镜%s，请回到漫剧分镜处理", index+1, problem)
			}
			continue
		}
		view.Ready++
		clip := renderClip{ID: "shot-" + shot.ID, Kind: "video", TrackID: "video", StartMs: view.Timeline.DurationMs, DurationMs: duration, SourceDurationMs: duration, Volume: 1}
		clip.DirectMedia = &struct {
			ID         string `json:"id"`
			Kind       string `json:"kind"`
			StorageKey string `json:"storageKey"`
		}{row.ResourceID, "video", "resource:" + row.ResourceID}
		view.Timeline.Clips = append(view.Timeline.Clips, clip)
		view.Timeline.DurationMs += duration
	}
	return view, firstError
}
