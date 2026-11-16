package repository

import (
	"encoding/json"
	"testing"

	"yingce/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestDramaEpisodeContinuityControlsDownstreamInvalidation(t *testing.T) {
	for _, tc := range []struct {
		name, projectMode, episodeMode string
		cascade                        bool
	}{
		{"episode tail frame overrides parallel project", "parallel", "tail_frame", true},
		{"episode parallel overrides tail frame project", "tail_frame", "parallel", false},
		{"missing episode settings keeps parallel project", "parallel", "", false},
		{"missing episode settings keeps tail frame project", "tail_frame", "", true},
	} {
		for _, action := range []string{"save prompt", "request video"} {
			t.Run(tc.name+"/"+action, func(t *testing.T) {
				db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{})
				if err != nil {
					t.Fatal(err)
				}
				sqlDB, err := db.DB()
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = sqlDB.Close() })
				if err := db.AutoMigrate(&model.DramaProduction{}, &model.DramaEpisode{}, &model.DramaSegment{}, &model.DramaJob{}); err != nil {
					t.Fatal(err)
				}
				settingsJSON := func(mode string) string {
					raw, _ := json.Marshal(map[string]string{"videoContinuity": mode})
					return string(raw)
				}
				p := model.DramaProduction{ProjectID: "project", SettingsJSON: settingsJSON(tc.projectMode)}
				episode := model.DramaEpisode{ID: "episode", ProjectID: p.ProjectID, Stage: model.DramaEpisodeVideo, Revision: 1}
				if tc.episodeMode != "" {
					episode.SettingsJSON = settingsJSON(tc.episodeMode)
				}
				segments := []model.DramaSegment{
					{ID: "edited", ProjectID: p.ProjectID, EpisodeID: episode.ID, SegmentIndex: 0, Revision: 1, PromptStatus: model.DramaMediaReady, VideoStatus: model.DramaMediaReady, VideoResourceID: "old-first"},
					{ID: "later-ready", ProjectID: p.ProjectID, EpisodeID: episode.ID, SegmentIndex: 1, Revision: 4, VideoStatus: model.DramaMediaReady, VideoResourceID: "old-later"},
					{ID: "later-running", ProjectID: p.ProjectID, EpisodeID: episode.ID, SegmentIndex: 2, Revision: 8, VideoStatus: model.DramaMediaRunning},
				}
				job := model.DramaJob{ID: "later-queued", ProjectID: p.ProjectID, EpisodeID: episode.ID, ShotID: segments[1].ID, Kind: model.DramaJobSegmentVideo, Status: model.DramaJobQueued}
				for _, row := range []any{&p, &episode, &segments, &job} {
					if err := db.Create(row).Error; err != nil {
						t.Fatal(err)
					}
				}
				repo := &Repository{db: db}
				if action == "save prompt" {
					segments[0].VideoPromptOverride = "updated prompt"
					err = repo.SaveDramaSegmentOverride(segments[0])
				} else {
					err = repo.RequestDramaSegmentVideoExact(p.ProjectID, segments[0].ID, segments[0].Revision, nil, tc.cascade)
				}
				if err != nil {
					t.Fatal(err)
				}
				for _, before := range segments[1:] {
					var after model.DramaSegment
					if err := db.First(&after, "id = ?", before.ID).Error; err != nil {
						t.Fatal(err)
					}
					wantStatus, wantRevision := before.VideoStatus, before.Revision
					if tc.cascade {
						wantStatus, wantRevision = model.DramaMediaStale, before.Revision+1
					}
					if after.VideoStatus != wantStatus || after.Revision != wantRevision || after.VideoResourceID != before.VideoResourceID {
						t.Fatalf("downstream segment %s: got status=%s revision=%d resource=%s; want %s/%d/%s", after.ID, after.VideoStatus, after.Revision, after.VideoResourceID, wantStatus, wantRevision, before.VideoResourceID)
					}
					if before.VideoStatus == model.DramaMediaRunning {
						adopted, err := repo.UpdateDramaSegmentRevision(before.ID, before.Revision, map[string]any{"video_resource_id": "late-result"})
						if err != nil || adopted == tc.cascade {
							t.Fatalf("late result adoption=%v, cascade=%v, err=%v", adopted, tc.cascade, err)
						}
					}
				}
				if action == "save prompt" {
					if err := db.First(&job, "id = ?", job.ID).Error; err != nil {
						t.Fatal(err)
					}
					want := model.DramaJobQueued
					if tc.cascade {
						want = model.DramaJobCanceled
					}
					if job.Status != want {
						t.Fatalf("unrelated queued job status=%s, want %s", job.Status, want)
					}
				}
			})
		}
	}
}
