package app

import (
	"testing"
	"time"

	"yingce/backend/internal/model"
)

func TestDramaProjectTextRetryRecoversCurrentWritingWithoutMedia(t *testing.T) {
	fixture := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
	episode, _, script := seedDramaScriptRetry(t, fixture, `{"shots":[{"scene":"原场景","action":"少年推门","durationSeconds":3}]}`, "结果处理失败：database is locked")
	projectID := episode.ProjectID
	if err := fixture.svc.repo.UpdateDramaSegmentFields(fixture.segment.ID, map[string]any{"prompt_status": model.DramaMediaFailed, "prompt_error": "文字失败", "video_status": model.DramaMediaFailed, "video_error": "视频失败"}); err != nil {
		t.Fatal(err)
	}
	if err := fixture.svc.repo.UpdateDramaCastFields(fixture.cast.ID, map[string]any{"image_status": model.DramaMediaFailed}); err != nil {
		t.Fatal(err)
	}
	prompt := model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, ShotID: fixture.segment.ID, Kind: model.DramaJobSegmentPrompt, Status: model.DramaJobFailed, PayloadJSON: encodeDramaRevision(fixture.segment.Revision), Error: "文字失败"}
	video := model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, ShotID: fixture.segment.ID, Kind: model.DramaJobSegmentVideo, Status: model.DramaJobFailed, Error: "视频失败"}
	queued := model.DramaJob{ID: newID(), ProjectID: projectID, CastID: fixture.cast.ID, Kind: model.DramaJobCastImage, Status: model.DramaJobQueued, Error: "已授权图片"}
	for _, row := range []any{&prompt, &video, &queued} {
		if err := fixture.fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fixture.svc.RetryDramaProjectText("other-user", projectID); err == nil {
		t.Fatal("project text recovery must enforce ownership")
	}
	result, err := fixture.svc.RetryDramaProjectText("usr-drama", projectID)
	if err != nil || result["jobs"] != 2 {
		t.Fatalf("recover script and prompt: %+v %v", result, err)
	}
	storedScript, _ := fixture.svc.repo.DramaJob(projectID, script.ID)
	if storedScript.Status != model.DramaJobRunning || storedScript.TaskID != script.TaskID {
		t.Fatalf("a paid usable script must be replayed: %+v", storedScript)
	}
	segment, _ := fixture.svc.repo.DramaSegment(projectID, fixture.segment.ID)
	cast, _ := fixture.svc.repo.DramaCast(projectID, fixture.cast.ID)
	storedVideo, _ := fixture.svc.repo.DramaJob(projectID, video.ID)
	storedQueued, _ := fixture.svc.repo.DramaJob(projectID, queued.ID)
	p, _ := fixture.svc.repo.DramaProduction(projectID)
	if segment.PromptStatus != "" || segment.VideoStatus != model.DramaMediaFailed || segment.VideoError != "视频失败" || cast.ImageStatus != model.DramaMediaFailed || storedVideo.Status != model.DramaJobFailed || storedQueued.Status != model.DramaJobQueued || !p.MediaRequestsOnly {
		t.Fatalf("only failed writing may reopen; media authorization must be preserved: %+v %+v %+v %+v %+v", segment, cast, storedVideo, storedQueued, p)
	}
	again, err := fixture.svc.RetryDramaProjectText("usr-drama", projectID)
	if err != nil || again["jobs"] != 0 {
		t.Fatalf("repeated recovery must not duplicate work: %+v %v", again, err)
	}
}

func TestDramaProjectTextRetryRestoresOnlyLatestProjectSlot(t *testing.T) {
	for _, kind := range []string{model.DramaJobBible, model.DramaJobPlan} {
		t.Run(kind, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			summary := createTestDramaWithMedia(t, svc, DramaReviewAuto, DramaMediaAuto)
			stage := model.DramaStageBible
			if kind == model.DramaJobPlan {
				stage = model.DramaStageProduce
			}
			if err := svc.repo.UpdateDramaProduction(summary.Project.ID, map[string]any{"status": model.DramaStatusPaused, "stage": stage, "plan_done": false}); err != nil {
				t.Fatal(err)
			}
			old := model.DramaJob{ID: newID(), ProjectID: summary.Project.ID, Kind: kind, Status: model.DramaJobFailed, Error: "历史失败", PayloadJSON: `{"start":0,"end":1}`, CreatedAt: time.Now().Add(-time.Hour)}
			current := old
			current.ID, current.CreatedAt, current.Error = newID(), time.Now(), "本次失败"
			media := model.DramaJob{ID: newID(), ProjectID: summary.Project.ID, Kind: model.DramaJobCastImage, Status: model.DramaJobFailed, Error: "图片失败"}
			scoped := model.DramaJob{ID: newID(), ProjectID: summary.Project.ID, Kind: model.DramaJobBible, Status: model.DramaJobFailed, PayloadJSON: `{"scope":"asset_extraction","assetKind":"character","sourceChapterIds":["removed-chapter"]}`, Error: "来源范围已失效"}
			for _, row := range []any{&old, &current, &media, &scoped} {
				if err := fake.db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			result, err := svc.RetryDramaProjectText("usr-drama", summary.Project.ID)
			if err != nil || result["jobs"] != 1 {
				t.Fatalf("recover latest %s: %+v %v", kind, result, err)
			}
			after, _ := svc.repo.DramaJob(summary.Project.ID, current.ID)
			history, _ := svc.repo.DramaJob(summary.Project.ID, old.ID)
			unchangedMedia, _ := svc.repo.DramaJob(summary.Project.ID, media.ID)
			unchangedScoped, _ := svc.repo.DramaJob(summary.Project.ID, scoped.ID)
			p, _ := svc.repo.DramaProduction(summary.Project.ID)
			if after.Status != model.DramaJobQueued || history.Status != model.DramaJobFailed || unchangedMedia.Status != model.DramaJobFailed || unchangedScoped.Status != model.DramaJobFailed || p.Status != model.DramaStatusRunning || !p.MediaRequestsOnly {
				t.Fatalf("wrong retry scope: %+v %+v %+v %+v %+v", after, history, unchangedMedia, unchangedScoped, p)
			}
			again, err := svc.RetryDramaProjectText("usr-drama", summary.Project.ID)
			if err != nil || again["jobs"] != 0 {
				t.Fatalf("duplicate project slot retry: %+v %v", again, err)
			}
		})
	}
}

func TestDramaProjectTextRetryResumesWithoutImplicitMedia(t *testing.T) {
	for _, status := range []string{model.DramaStatusPaused, model.DramaStatusCompleted} {
		t.Run(status, func(t *testing.T) {
			fixture := newDramaGuideRevisionFixture(t, model.DramaGuideCompleted)
			episode, _, script := seedDramaScriptRetry(t, fixture, `{"shots":[{"scene":"原场景","action":"少年推门","durationSeconds":3}]}`, "结果处理失败：database is locked")
			p, _ := fixture.svc.repo.DramaProduction(episode.ProjectID)
			settings := parseDramaSettings(p.SettingsJSON)
			settings.MediaMode, settings.ReviewMode = DramaMediaAuto, DramaReviewAuto
			if err := fixture.svc.repo.UpdateDramaProduction(episode.ProjectID, map[string]any{"status": status, "settings_json": encodeDramaSettings(settings)}); err != nil {
				t.Fatal(err)
			}
			if applied, err := fixture.svc.repo.UpdateDramaEpisodeIfRevision(episode.ID, episode.Revision, map[string]any{"media_released": true}); err != nil || !applied {
				t.Fatalf("seed earlier video release: %v", err)
			}
			if err := fixture.svc.repo.UpdateDramaCastFields(fixture.cast.ID, map[string]any{"image_status": model.DramaMediaFailed}); err != nil {
				t.Fatal(err)
			}
			result, err := fixture.svc.RetryDramaProjectText("usr-drama", episode.ProjectID)
			if err != nil || result["jobs"] != 1 {
				t.Fatalf("recover paused/completed writing: %+v %v", result, err)
			}
			runDramaTicks(t, fixture.svc, episode.ProjectID, 8)
			saved, _ := fixture.svc.repo.DramaJob(episode.ProjectID, script.ID)
			current, _ := fixture.svc.repo.DramaEpisode(episode.ProjectID, episode.ID)
			segments, _ := fixture.svc.repo.DramaSegments(episode.ID)
			if saved.Status != model.DramaJobSucceeded || !current.VideoRequestsOnly || !current.MediaReleased || fixture.fake.byKind["image"]+fixture.fake.byKind["video"]+fixture.fake.byKind["render"] != 0 {
				t.Fatalf("writing recovery must not reopen earlier media release: %+v %+v calls=%v", saved, current, fixture.fake.byKind)
			}
			if len(segments) == 0 || !dramaPromptReady(segments[0]) {
				t.Fatalf("writing must actually progress after recovery: %+v calls=%v", segments, fixture.fake.byKind)
			}
		})
	}
}
