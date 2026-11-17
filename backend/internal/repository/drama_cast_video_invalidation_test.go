package repository

import (
	"fmt"
	"testing"

	"yingce/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func dramaCastVideoInvalidationDB(t *testing.T) (*gorm.DB, *Repository) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.DramaProduction{}, &model.DramaEpisode{}, &model.DramaCast{}, &model.DramaShot{}, &model.DramaSegment{}, &model.DramaJob{}); err != nil {
		t.Fatal(err)
	}
	for _, row := range []any{
		&model.DramaProduction{ProjectID: "project", SettingsJSON: `{"videoContinuity":"parallel"}`},
		&model.DramaEpisode{ID: "episode", ProjectID: "project", Stage: model.DramaEpisodeVideo, Approved: true, Revision: 5},
		&model.DramaCast{ID: "cast", ProjectID: "project", Kind: "character", Name: "角色", Revision: 1},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	return db, &Repository{db: db}
}

func TestDramaCastUpdatesPreserveSegmentDrafts(t *testing.T) {
	for _, tc := range []struct {
		name, field, reference string
	}{
		{"character appearance", "appearance", "cast_ids_json"},
		{"look appearance", "appearance", "look_cast_ids_json"},
		{"scene description", "description", "scene_cast_id"},
		{"prop description", "description", "prop_ids_json"},
		{"character name", "name", "cast_ids_json"},
		{"character aliases", "aliases_json", "cast_ids_json"},
		{"voice instructions", "voice_instructions", "audio_cast_ids_json"},
		{"voice profile", "voice_profile_id", "audio_cast_ids_json"},
		{"voice sample", "voice_sample_resource_id", "audio_cast_ids_json"},
		{"manual image reference", "appearance", "reference_cast_ids_json"},
	} {
		for _, promptStatus := range []string{model.DramaMediaReady, model.DramaMediaRunning} {
			t.Run(tc.name+"/"+promptStatus, func(t *testing.T) {
				db, repo := dramaCastVideoInvalidationDB(t)
				segment := model.DramaSegment{ID: "segment", ProjectID: "project", EpisodeID: "episode", SegmentIndex: 1, Revision: 7, PromptStatus: promptStatus, VideoPrompt: "原剧情动作与台词", VideoPromptOverride: "用户改写的段稿", VideoStatus: model.DramaMediaReady, VideoResourceID: "paid-video", TailFrameResourceID: "old-tail"}
				shot := model.DramaShot{ID: "shot", ProjectID: "project", EpisodeID: "episode", SegmentIndex: 1}
				switch tc.reference {
				case "reference_cast_ids_json":
					segment.ReferenceCastIDsJSON = `["cast"]`
				case "audio_cast_ids_json":
					segment.AudioCastIDsJSON = `["cast"]`
				case "scene_cast_id":
					shot.SceneCastID = "cast"
				case "cast_ids_json":
					shot.CastIDsJSON = `["cast"]`
				case "look_cast_ids_json":
					shot.LookCastIDsJSON = `["cast"]`
				case "prop_ids_json":
					shot.PropIDsJSON = `["cast"]`
				}
				unrelated := model.DramaSegment{ID: "unrelated", ProjectID: "project", EpisodeID: "episode", SegmentIndex: 2, Revision: 3, PromptStatus: model.DramaMediaReady, VideoStatus: model.DramaMediaReady}
				foreign := model.DramaSegment{ID: "foreign", ProjectID: "other-project", EpisodeID: "other-episode", SegmentIndex: 1, Revision: 9, PromptStatus: model.DramaMediaReady, VideoStatus: model.DramaMediaReady}
				foreignShot := model.DramaShot{ID: "foreign-shot", ProjectID: "other-project", EpisodeID: "other-episode", SegmentIndex: 1, CastIDsJSON: `["cast"]`}
				for _, row := range []any{&segment, &shot, &unrelated, &foreign, &foreignShot} {
					if err := db.Create(row).Error; err != nil {
						t.Fatal(err)
					}
				}
				if err := repo.UpdateDramaCastFields("cast", map[string]any{tc.field: "新的资产设定"}); err != nil {
					t.Fatal(err)
				}
				after, err := repo.DramaSegment("project", segment.ID)
				if err != nil {
					t.Fatal(err)
				}
				if after.PromptStatus != promptStatus || after.VideoPrompt != segment.VideoPrompt || after.VideoPromptOverride != segment.VideoPromptOverride || after.Revision != segment.Revision {
					t.Fatalf("asset update changed draft: before=%+v after=%+v", segment, after)
				}
				if after.VideoStatus != model.DramaMediaStale || after.VideoResourceID != segment.VideoResourceID || after.TailFrameResourceID != segment.TailFrameResourceID {
					t.Fatalf("paid video was not retained as stale: %+v", after)
				}
				if after.VideoRevision != segment.VideoRevision+1 {
					t.Fatalf("video input version did not change: %d", after.VideoRevision)
				}
				adopted, err := repo.UpdateDramaSegmentVideoRevision(segment.ID, segment.Revision, segment.VideoRevision, map[string]any{"video_status": model.DramaMediaReady, "video_resource_id": "late-video"})
				if err != nil || adopted {
					t.Fatalf("old video inputs were adopted: applied=%v err=%v", adopted, err)
				}
				for _, before := range []model.DramaSegment{unrelated, foreign} {
					var untouched model.DramaSegment
					if err := db.First(&untouched, "id = ?", before.ID).Error; err != nil {
						t.Fatal(err)
					}
					if untouched.VideoStatus != before.VideoStatus || untouched.Revision != before.Revision {
						t.Fatalf("unrelated segment changed: %+v", untouched)
					}
				}
				applied, err := repo.UpdateDramaSegmentRevision(segment.ID, segment.Revision, map[string]any{"video_prompt": "在途撰写结果", "prompt_status": model.DramaMediaReady})
				if err != nil || !applied {
					t.Fatalf("in-flight prompt rejected after asset update: applied=%v err=%v", applied, err)
				}
			})
		}
	}
}

func TestDramaCastImageConfigurationDoesNotInvalidateVideo(t *testing.T) {
	for _, field := range []string{"image_prompt", "image_options_json", "image_style_id", "image_style_name", "image_style_prompt"} {
		t.Run(field, func(t *testing.T) {
			db, repo := dramaCastVideoInvalidationDB(t)
			segment := model.DramaSegment{ID: "segment", ProjectID: "project", EpisodeID: "episode", Revision: 7, PromptStatus: model.DramaMediaReady, VideoPrompt: "段稿", VideoStatus: model.DramaMediaReady}
			shot := model.DramaShot{ID: "shot", ProjectID: "project", EpisodeID: "episode", CastIDsJSON: `["cast"]`}
			for _, row := range []any{&segment, &shot} {
				if err := db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := repo.UpdateDramaCastFields("cast", map[string]any{field: "新图片配置"}); err != nil {
				t.Fatal(err)
			}
			after, err := repo.DramaSegment("project", segment.ID)
			if err != nil {
				t.Fatal(err)
			}
			if after.VideoStatus != segment.VideoStatus || after.PromptStatus != segment.PromptStatus || after.Revision != segment.Revision {
				t.Fatalf("image configuration invalidated video or draft: %+v", after)
			}
		})
	}
}

func TestDramaCastVideoInvalidationPreservesJobsAndContinuity(t *testing.T) {
	for _, tc := range []struct {
		name, projectMode, episodeMode string
		cascade                        bool
	}{
		{"episode tail frame", "parallel", "tail_frame", true},
		{"episode parallel", "tail_frame", "parallel", false},
		{"project tail frame", "tail_frame", "", true},
		{"project parallel", "parallel", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, repo := dramaCastVideoInvalidationDB(t)
			if err := db.Model(&model.DramaProduction{}).Where("project_id = ?", "project").Update("settings_json", fmt.Sprintf(`{"videoContinuity":%q}`, tc.projectMode)).Error; err != nil {
				t.Fatal(err)
			}
			fields := map[string]any{"stage": model.DramaEpisodeDone, "final_resource_id": "paid-final"}
			if tc.episodeMode != "" {
				fields["settings_json"] = fmt.Sprintf(`{"videoContinuity":%q}`, tc.episodeMode)
			}
			if err := db.Model(&model.DramaEpisode{}).Where("id = ?", "episode").Updates(fields).Error; err != nil {
				t.Fatal(err)
			}
			segments := []model.DramaSegment{}
			jobs := []model.DramaJob{}
			for index, videoStatus := range []string{model.DramaMediaReady, model.DramaMediaRunning, model.DramaMediaQueued, ""} {
				id := fmt.Sprintf("segment-%d", index)
				segments = append(segments, model.DramaSegment{ID: id, ProjectID: "project", EpisodeID: "episode", SegmentIndex: index, Revision: int64(index + 4), PromptStatus: model.DramaMediaRunning, VideoPrompt: "原段稿", VideoPromptOverride: "手写段稿", VideoStatus: videoStatus, VideoResourceID: "paid-" + id})
				for _, kind := range []string{model.DramaJobSegmentPrompt, model.DramaJobSegmentVideo} {
					for _, status := range []string{model.DramaJobQueued, model.DramaJobRunning} {
						jobs = append(jobs, model.DramaJob{ID: id + "-" + kind + "-" + status, ProjectID: "project", EpisodeID: "episode", ShotID: id, Kind: kind, Status: status, TaskID: "paid-task"})
					}
				}
			}
			jobs = append(jobs, model.DramaJob{ID: "queued-render", ProjectID: "project", EpisodeID: "episode", Kind: model.DramaJobRender, Status: model.DramaJobQueued}, model.DramaJob{ID: "running-render", ProjectID: "project", EpisodeID: "episode", Kind: model.DramaJobRender, Status: model.DramaJobRunning, TaskID: "paid-render"})
			shot := model.DramaShot{ID: "shot", ProjectID: "project", EpisodeID: "episode", CastIDsJSON: `["cast"]`}
			for _, row := range []any{&segments, &jobs, &shot} {
				if err := db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := repo.UpdateDramaCastFields("cast", map[string]any{"appearance": "新外观"}); err != nil {
				t.Fatal(err)
			}
			for _, before := range segments {
				after, err := repo.DramaSegment("project", before.ID)
				if err != nil {
					t.Fatal(err)
				}
				wantVideo := before.VideoStatus
				if (before.SegmentIndex == 0 || tc.cascade) && (wantVideo == model.DramaMediaReady || wantVideo == model.DramaMediaRunning) {
					wantVideo = model.DramaMediaStale
				}
				wantVideoRevision := before.VideoRevision
				if before.SegmentIndex == 0 || tc.cascade {
					wantVideoRevision++
				}
				if after.VideoStatus != wantVideo || after.PromptStatus != before.PromptStatus || after.Revision != before.Revision || after.VideoPromptOverride != before.VideoPromptOverride || after.VideoResourceID != before.VideoResourceID || after.VideoRevision != wantVideoRevision {
					t.Fatalf("unexpected segment invalidation: before=%+v after=%+v want video=%s", before, after, wantVideo)
				}
			}
			for _, before := range jobs {
				var after model.DramaJob
				if err := db.First(&after, "id = ?", before.ID).Error; err != nil {
					t.Fatal(err)
				}
				want := before.Status
				if before.Status == model.DramaJobQueued && (before.Kind == model.DramaJobRender || before.Kind == model.DramaJobSegmentVideo && (before.ShotID == segments[0].ID || tc.cascade)) {
					want = model.DramaJobCanceled
				}
				if after.Status != want || after.TaskID != before.TaskID {
					t.Fatalf("job %s status=%s task=%s; want %s/%s", after.ID, after.Status, after.TaskID, want, before.TaskID)
				}
			}
			var episode model.DramaEpisode
			if err := db.First(&episode, "id = ?", "episode").Error; err != nil {
				t.Fatal(err)
			}
			if !episode.Approved || !episode.FinalStale || episode.FinalResourceID != "paid-final" || episode.Stage != model.DramaEpisodeVideo || episode.Revision != 6 {
				t.Fatalf("episode did not preserve approval and invalidate final only: %+v", episode)
			}
		})
	}
}

func TestDramaCastChangesWithoutVideoPreservePromptWork(t *testing.T) {
	db, repo := dramaCastVideoInvalidationDB(t)
	segment := model.DramaSegment{ID: "segment", ProjectID: "project", EpisodeID: "episode", Revision: 7, PromptStatus: model.DramaMediaRunning, VideoPrompt: "原段稿", VideoPromptOverride: "手写段稿"}
	shot := model.DramaShot{ID: "shot", ProjectID: "project", EpisodeID: "episode", CastIDsJSON: `["cast"]`}
	job := model.DramaJob{ID: "prompt-job", ProjectID: "project", EpisodeID: "episode", ShotID: segment.ID, Kind: model.DramaJobSegmentPrompt, Status: model.DramaJobRunning, TaskID: "text-task"}
	for _, row := range []any{&segment, &shot, &job} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Model(&model.DramaEpisode{}).Where("id = ?", "episode").Update("stage", model.DramaEpisodePrompts).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.UpdateDramaCastFields("cast", map[string]any{"appearance": "新外观"}); err != nil {
		t.Fatal(err)
	}
	after, err := repo.DramaSegment("project", segment.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.PromptStatus != segment.PromptStatus || after.VideoPromptOverride != segment.VideoPromptOverride || after.Revision != segment.Revision || after.VideoStatus != "" || after.VideoRevision != 1 {
		t.Fatalf("asset edit changed prompt work or requested video: %+v", after)
	}
	var episode model.DramaEpisode
	if err := db.First(&episode, "id = ?", "episode").Error; err != nil {
		t.Fatal(err)
	}
	if episode.Stage != model.DramaEpisodePrompts || episode.Revision != 5 || episode.FinalStale || !episode.Approved {
		t.Fatalf("asset edit changed prompt workflow: %+v", episode)
	}
	if err := db.First(&job, "id = ?", job.ID).Error; err != nil {
		t.Fatal(err)
	}
	if job.Status != model.DramaJobRunning {
		t.Fatalf("asset edit canceled prompt job: %+v", job)
	}
}

func TestDramaCastVoiceInvalidatesVideoWithoutCancelingImage(t *testing.T) {
	db, repo := dramaCastVideoInvalidationDB(t)
	if err := db.Model(&model.DramaCast{}).Where("id = ?", "cast").Update("image_status", model.DramaMediaRunning).Error; err != nil {
		t.Fatal(err)
	}
	segment := model.DramaSegment{ID: "segment", ProjectID: "project", EpisodeID: "episode", Revision: 7, PromptStatus: model.DramaMediaRunning, VideoStatus: model.DramaMediaRunning, AudioCastIDsJSON: `["cast"]`}
	shot := model.DramaShot{ID: "shot", ProjectID: "project", EpisodeID: "episode"}
	imageJob := model.DramaJob{ID: "image-job", ProjectID: "project", CastID: "cast", Kind: model.DramaJobCastImage, Status: model.DramaJobQueued}
	for _, row := range []any{&segment, &shot, &imageJob} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := repo.UpdateDramaCastVoice("project", "cast", "voice-profile", "voice-sample"); err != nil {
		t.Fatal(err)
	}
	var cast model.DramaCast
	if err := db.First(&cast, "id = ?", "cast").Error; err != nil {
		t.Fatal(err)
	}
	if cast.Revision != 1 || cast.ImageStatus != model.DramaMediaRunning || cast.VoiceProfileID != "voice-profile" || cast.VoiceSampleResourceID != "voice-sample" {
		t.Fatalf("voice update affected image generation: %+v", cast)
	}
	if err := db.First(&imageJob, "id = ?", imageJob.ID).Error; err != nil {
		t.Fatal(err)
	}
	if imageJob.Status != model.DramaJobQueued {
		t.Fatalf("voice update canceled image job: %+v", imageJob)
	}
	after, err := repo.DramaSegment("project", segment.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.PromptStatus != segment.PromptStatus || after.Revision != segment.Revision || after.VideoStatus != model.DramaMediaStale || after.VideoRevision != 1 {
		t.Fatalf("voice update affected prompt instead of video: %+v", after)
	}
	if err := repo.UpdateDramaCastVoice("project", "cast", "voice-profile", "voice-sample"); err != nil {
		t.Fatal(err)
	}
	after, err = repo.DramaSegment("project", segment.ID)
	if err != nil || after.VideoRevision != 1 {
		t.Fatalf("unchanged voice updated video inputs: segment=%+v err=%v", after, err)
	}
}

func TestDramaCastRenameRetainsPreviousNamesAsAliases(t *testing.T) {
	db, repo := dramaCastVideoInvalidationDB(t)
	if err := db.Model(&model.DramaCast{}).Where("id = ?", "cast").Update("aliases_json", `["阿明","角色","阿明"]`).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.UpdateDramaCastFields("cast", map[string]any{"name": "新名字"}); err != nil {
		t.Fatal(err)
	}
	var cast model.DramaCast
	if err := db.First(&cast, "id = ?", "cast").Error; err != nil {
		t.Fatal(err)
	}
	if cast.AliasesJSON != `["阿明","角色"]` {
		t.Fatalf("previous name or aliases lost: %s", cast.AliasesJSON)
	}
}

func TestDramaCastImageUpdateRejectsOldVideoAndTailButNotPrompt(t *testing.T) {
	db, repo := dramaCastVideoInvalidationDB(t)
	segment := model.DramaSegment{ID: "segment", ProjectID: "project", EpisodeID: "episode", Revision: 7, VideoRevision: 3, PromptStatus: model.DramaMediaRunning, VideoStatus: model.DramaMediaRunning, VideoResourceID: "paid-video"}
	if err := db.Create(&segment).Error; err != nil {
		t.Fatal(err)
	}
	marked, err := repo.MarkDramaSegmentVideoStale("episode", 0)
	if err != nil || !marked {
		t.Fatalf("mark video stale: marked=%v err=%v", marked, err)
	}
	adopted, err := repo.UpdateDramaSegmentVideoRevision(segment.ID, segment.Revision, segment.VideoRevision, map[string]any{"video_status": model.DramaMediaReady})
	if err != nil || adopted {
		t.Fatalf("stale video applied: adopted=%v err=%v", adopted, err)
	}
	adopted, err = repo.SetDramaSegmentTail(segment.ID, segment.Revision, segment.VideoRevision, segment.VideoResourceID, "late-tail")
	if err != nil || adopted {
		t.Fatalf("stale tail applied: adopted=%v err=%v", adopted, err)
	}
	adopted, err = repo.UpdateDramaSegmentRevision(segment.ID, segment.Revision, map[string]any{"prompt_status": model.DramaMediaReady, "video_prompt": "在途段稿"})
	if err != nil || !adopted {
		t.Fatalf("in-flight prompt rejected: adopted=%v err=%v", adopted, err)
	}
	adopted, err = repo.UpdateDramaSegmentVideoRevision(segment.ID, segment.Revision, segment.VideoRevision+1, map[string]any{"video_status": model.DramaMediaReady, "video_resource_id": "new-video"})
	if err != nil || !adopted {
		t.Fatalf("current video rejected: adopted=%v err=%v", adopted, err)
	}
	adopted, err = repo.SetDramaSegmentTail(segment.ID, segment.Revision, segment.VideoRevision+1, "new-video", "new-tail")
	if err != nil || !adopted {
		t.Fatalf("current tail rejected: adopted=%v err=%v", adopted, err)
	}
}

func TestDramaCastCurrentImageWritesAdvanceVideoInputs(t *testing.T) {
	for _, writer := range []string{"fields", "revision", "image revision", "status"} {
		for _, videoStatus := range []string{model.DramaMediaReady, model.DramaMediaRunning, model.DramaMediaFailed, model.DramaMediaStale} {
			t.Run(writer+"/"+videoStatus, func(t *testing.T) {
				db, repo := dramaCastVideoInvalidationDB(t)
				if err := db.Model(&model.DramaCast{}).Where("id = ?", "cast").Updates(map[string]any{"image_resource_id": "old-image", "image_status": model.DramaMediaReady}).Error; err != nil {
					t.Fatal(err)
				}
				segment := model.DramaSegment{ID: "segment", ProjectID: "project", EpisodeID: "episode", Revision: 7, PromptStatus: model.DramaMediaRunning, VideoStatus: videoStatus, VideoResourceID: "paid-video"}
				shot := model.DramaShot{ID: "shot", ProjectID: "project", EpisodeID: "episode", CastIDsJSON: `["cast"]`}
				render := model.DramaJob{ID: "render", ProjectID: "project", EpisodeID: "episode", Kind: model.DramaJobRender, Status: model.DramaJobQueued}
				for _, row := range []any{&segment, &shot, &render} {
					if err := db.Create(row).Error; err != nil {
						t.Fatal(err)
					}
				}
				write := func(resourceID string) (bool, error) {
					fields := map[string]any{"image_resource_id": resourceID, "image_status": model.DramaMediaReady}
					switch writer {
					case "fields":
						return true, repo.UpdateDramaCastFields("cast", fields)
					case "revision":
						return repo.UpdateDramaCastRevision("cast", 1, fields)
					case "image revision":
						return repo.UpdateDramaCastImageRevision("cast", 1, []string{model.DramaMediaReady}, fields)
					default:
						return repo.UpdateDramaCastIf("cast", []string{model.DramaMediaReady}, fields)
					}
				}
				applied, err := write("new-image")
				if err != nil || !applied {
					t.Fatalf("write image: applied=%v err=%v", applied, err)
				}
				after, err := repo.DramaSegment("project", segment.ID)
				if err != nil {
					t.Fatal(err)
				}
				wantStatus := videoStatus
				if videoStatus == model.DramaMediaRunning {
					wantStatus = model.DramaMediaStale
				}
				if after.VideoRevision != 1 || after.Revision != segment.Revision || after.PromptStatus != segment.PromptStatus || after.VideoStatus != wantStatus || after.VideoResourceID != segment.VideoResourceID {
					t.Fatalf("image input update changed draft or completed video: %+v", after)
				}
				applied, err = repo.UpdateDramaSegmentVideoRevision(segment.ID, segment.Revision, 0, map[string]any{"video_status": model.DramaMediaReady, "video_resource_id": "late-video"})
				if err != nil || applied {
					t.Fatalf("old image video adopted: applied=%v err=%v", applied, err)
				}
				if err := db.First(&render, "id = ?", render.ID).Error; err != nil {
					t.Fatal(err)
				}
				if videoStatus != model.DramaMediaRunning && render.Status != model.DramaJobQueued {
					t.Fatalf("image update canceled render of retained videos: %+v", render)
				}
				if _, err := write("new-image"); err != nil {
					t.Fatal(err)
				}
				after, err = repo.DramaSegment("project", segment.ID)
				if err != nil || after.VideoRevision != 1 {
					t.Fatalf("same image changed video inputs: segment=%+v err=%v", after, err)
				}
			})
		}
	}
}

func TestDramaCastCurrentImageBecomingReadyAdvancesVideoInputs(t *testing.T) {
	db, repo := dramaCastVideoInvalidationDB(t)
	if err := db.Model(&model.DramaCast{}).Where("id = ?", "cast").Updates(map[string]any{"image_resource_id": "existing-image", "image_status": model.DramaMediaRunning}).Error; err != nil {
		t.Fatal(err)
	}
	segment := model.DramaSegment{ID: "segment", ProjectID: "project", EpisodeID: "episode", Revision: 7, PromptStatus: model.DramaMediaReady, VideoStatus: model.DramaMediaRunning}
	shot := model.DramaShot{ID: "shot", ProjectID: "project", EpisodeID: "episode", CastIDsJSON: `["cast"]`}
	for _, row := range []any{&segment, &shot} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	applied, err := repo.UpdateDramaCastImageRevision("cast", 2, []string{model.DramaMediaRunning}, map[string]any{"image_status": model.DramaMediaReady})
	if err != nil || applied {
		t.Fatalf("outdated image revision applied: applied=%v err=%v", applied, err)
	}
	after, err := repo.DramaSegment("project", segment.ID)
	if err != nil || after.VideoRevision != 0 {
		t.Fatalf("rejected image changed video inputs: segment=%+v err=%v", after, err)
	}
	applied, err = repo.UpdateDramaCastImageRevision("cast", 1, []string{model.DramaMediaRunning}, map[string]any{"image_status": model.DramaMediaReady})
	if err != nil || !applied {
		t.Fatalf("ready image not applied: applied=%v err=%v", applied, err)
	}
	after, err = repo.DramaSegment("project", segment.ID)
	if err != nil || after.VideoRevision != 1 || after.VideoStatus != model.DramaMediaStale || after.PromptStatus != model.DramaMediaReady || after.Revision != segment.Revision {
		t.Fatalf("image readiness did not invalidate only video inputs: segment=%+v err=%v", after, err)
	}
}

func TestDramaCastVideoInvalidationFindsParentLookAndSpeakerReferences(t *testing.T) {
	for _, reference := range []string{"look shot", "manual look", "speaker alias"} {
		t.Run(reference, func(t *testing.T) {
			db, repo := dramaCastVideoInvalidationDB(t)
			if err := db.Model(&model.DramaCast{}).Where("id = ?", "cast").Update("aliases_json", `["阿明"]`).Error; err != nil {
				t.Fatal(err)
			}
			look := model.DramaCast{ID: "look", ProjectID: "project", Kind: "character", ParentID: "cast", Name: "角色", LookName: "便装"}
			segment := model.DramaSegment{ID: "segment", ProjectID: "project", EpisodeID: "episode", Revision: 7, PromptStatus: model.DramaMediaReady, VideoStatus: model.DramaMediaRunning}
			shot := model.DramaShot{ID: "shot", ProjectID: "project", EpisodeID: "episode"}
			switch reference {
			case "look shot":
				shot.LookCastIDsJSON = `["look"]`
			case "manual look":
				segment.ReferenceCastIDsJSON = `["look"]`
			case "speaker alias":
				shot.Speaker, shot.Dialogue = " 阿·明 ", "画外台词"
			}
			for _, row := range []any{&look, &segment, &shot} {
				if err := db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := repo.UpdateDramaCastVoice("project", "cast", "new-voice", "new-sample"); err != nil {
				t.Fatal(err)
			}
			after, err := repo.DramaSegment("project", segment.ID)
			if err != nil || after.VideoRevision != 1 || after.VideoStatus != model.DramaMediaStale || after.Revision != segment.Revision || after.PromptStatus != segment.PromptStatus {
				t.Fatalf("inherited/speaker asset update missed video: segment=%+v err=%v", after, err)
			}
		})
	}
}

func TestDramaSegmentVideoReprocessingRequiresCurrentInputVersions(t *testing.T) {
	for _, action := range []string{"reopen", "retry"} {
		for _, tc := range []struct {
			name, payload string
			revision      int64
			videoRevision int64
			want          bool
		}{
			{"current", `{"revision":7,"videoRevision":3}`, 7, 3, true},
			{"changed draft", `{"revision":7,"videoRevision":3}`, 8, 3, false},
			{"changed asset", `{"revision":7,"videoRevision":3}`, 7, 4, false},
			{"legacy current", `{"revision":7}`, 7, 0, true},
			{"legacy changed asset", `{"revision":7}`, 7, 1, false},
			{"unreadable payload", `broken`, 7, 3, false},
		} {
			t.Run(action+"/"+tc.name, func(t *testing.T) {
				db, repo := dramaCastVideoInvalidationDB(t)
				if err := db.AutoMigrate(&model.Task{}); err != nil {
					t.Fatal(err)
				}
				segment := model.DramaSegment{ID: "segment", ProjectID: "project", EpisodeID: "episode", Revision: tc.revision, VideoRevision: tc.videoRevision, PromptStatus: model.DramaMediaReady, VideoStatus: model.DramaMediaFailed, VideoResourceID: "paid-video"}
				job := model.DramaJob{ID: "video-job", ProjectID: "project", EpisodeID: "episode", ShotID: segment.ID, Kind: model.DramaJobSegmentVideo, Status: model.DramaJobFailed, TaskID: "paid-task", PayloadJSON: tc.payload}
				task := model.Task{ID: "paid-task", Status: model.TaskStatusSucceeded}
				for _, row := range []any{&segment, &job, &task} {
					if err := db.Create(row).Error; err != nil {
						t.Fatal(err)
					}
				}
				if action == "reopen" {
					applied, err := repo.ReopenDramaSegmentVideoJob(job.ID, segment.ID)
					if err != nil || applied != tc.want {
						t.Fatalf("reopen applied=%v want=%v err=%v", applied, tc.want, err)
					}
				} else if err := repo.RetryDramaResultJobs("project"); err != nil {
					t.Fatal(err)
				}
				if err := db.First(&job, "id = ?", job.ID).Error; err != nil {
					t.Fatal(err)
				}
				wantJob := model.DramaJobFailed
				if tc.want {
					wantJob = model.DramaJobRunning
				}
				if job.Status != wantJob {
					t.Fatalf("replay status=%s want=%s", job.Status, wantJob)
				}
				after, err := repo.DramaSegment("project", segment.ID)
				if err != nil {
					t.Fatal(err)
				}
				wantSlot := model.DramaMediaFailed
				if action == "reopen" && tc.want {
					wantSlot = model.DramaMediaRunning
				}
				if after.VideoStatus != wantSlot || after.VideoResourceID != segment.VideoResourceID || after.PromptStatus != segment.PromptStatus {
					t.Fatalf("replay changed unrelated slot or left running: %+v", after)
				}
			})
		}
	}
}
