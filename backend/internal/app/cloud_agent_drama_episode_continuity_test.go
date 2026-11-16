package app

import (
	"encoding/json"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func TestCloudAgentDramaAdoptPreviewUsesEpisodeContinuity(t *testing.T) {
	for _, tc := range []struct {
		name, projectMode, episodeMode string
		cascade                        bool
	}{
		{"episode tail frame overrides parallel project", DramaContinuityParallel, DramaContinuityTailFrame, true},
		{"episode parallel overrides tail frame project", DramaContinuityTailFrame, DramaContinuityParallel, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			projectID := newDramaMaterialProject(t, svc, "adoption review")
			p, err := svc.repo.DramaProduction(projectID)
			if err != nil {
				t.Fatal(err)
			}
			settings := parseDramaSettings(p.SettingsJSON)
			settings.VideoContinuity = tc.projectMode
			if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"settings_json": encodeDramaSettings(settings)}); err != nil {
				t.Fatal(err)
			}
			settings.VideoContinuity = tc.episodeMode
			episode := model.DramaEpisode{ID: "adopt-episode", ProjectID: projectID, Number: 1, Stage: model.DramaEpisodeVideo, Revision: 1, SettingsJSON: encodeDramaSettings(settings)}
			segments := []model.DramaSegment{
				{ID: "adopt-first", ProjectID: projectID, EpisodeID: episode.ID, SegmentIndex: 0, Revision: 1, VideoStatus: model.DramaMediaReady, VideoResourceID: "old-first"},
				{ID: "adopt-later", ProjectID: projectID, EpisodeID: episode.ID, SegmentIndex: 1, Revision: 1, VideoStatus: model.DramaMediaReady, VideoResourceID: "old-later"},
			}
			resourceID := fake.resource("usr-drama", "video", "video/mp4")
			payload, _ := json.Marshal(map[string]any{"id": "adopt-canvas", "nodes": []any{map[string]any{"id": "video-node", "type": "video", "metadata": map[string]any{"storageKey": "resource:" + resourceID}}}, "connections": []any{}})
			canvas := model.CanvasProject{ID: "adopt-canvas", UserID: "usr-drama", ProjectID: projectID, PayloadJSON: string(payload)}
			for _, row := range []any{&episode, &segments, &canvas} {
				if err := fake.db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			call := cloudAgentCall{ID: "adopt-episode-video"}
			call.Function.Name = "drama_adopt_canvas_media"
			call.Function.Arguments = `{"nodeId":"video-node","episodeId":"adopt-episode","segmentIndex":0,"cascade":true}`
			preview, err := cloudAgentPreviewDramaAdopt(svc.repo, "usr-drama", canvas.ID, call)
			if err != nil {
				t.Fatal(err)
			}
			details := strings.Join(preview.Items[0].Details, " ")
			if strings.Contains(details, "按实际用量计费") != tc.cascade || strings.Contains(details, "后续段保持不变") == tc.cascade {
				t.Fatalf("preview does not describe episode continuity: %s", details)
			}
			value, err := applyCloudAgentDramaAdopt(svc.repo, "usr-drama", canvas.ID, call, RuntimePolicySetting{})
			if err != nil {
				t.Fatal(err)
			}
			receipt := value.(map[string]any)
			wantRequeued, wantStatus := int64(0), model.DramaMediaReady
			if tc.cascade {
				wantRequeued, wantStatus = 1, model.DramaMediaQueued
			}
			if receipt["requeued"] != wantRequeued {
				t.Fatalf("execution disagrees with preview: %+v", receipt)
			}
			later, err := svc.repo.DramaSegment(projectID, segments[1].ID)
			if err != nil || later.VideoStatus != wantStatus {
				t.Fatalf("later segment status disagrees with preview: %+v %v", later, err)
			}
			if len(fake.requests) != 0 {
				t.Fatal("approval execution submitted a model request instead of only enqueueing")
			}
		})
	}
}
