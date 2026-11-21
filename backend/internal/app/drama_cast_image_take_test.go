package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func TestDramaCastImageTakeAdoptionRejectsImageVersionBeforeGenerationResult(t *testing.T) {
	svc, fake := newDramaTestService(t)
	projectID := newDramaMaterialProject(t, svc, "生图结果使历史采用请求过期")
	cast := createDramaMaterial(t, svc, projectID, "character", "角色")
	project, p, err := svc.dramaForUser("usr-drama", projectID)
	if err != nil {
		t.Fatal(err)
	}
	cast.ImageStatus, cast.ImageTakeID = model.DramaMediaRunning, "previous-take"
	cast.ImageResourceID = fake.resource("usr-drama", "image", "image/png")
	if err := fake.db.Save(&cast).Error; err != nil {
		t.Fatal(err)
	}
	previousTake := model.DramaTake{ID: cast.ImageTakeID, ProjectID: projectID, OwnerID: cast.ID, Kind: "cast", ResourceID: cast.ImageResourceID, Version: 1}
	if err := fake.db.Create(&previousTake).Error; err != nil {
		t.Fatal(err)
	}
	newImage := fake.resourceSized("usr-drama", "image", "image/png", 768, 1024)
	taskResult, err := json.Marshal(map[string]any{"images": []map[string]string{{"resourceId": newImage}}})
	if err != nil {
		t.Fatal(err)
	}
	job := &model.DramaJob{Kind: model.DramaJobCastImage, CastID: cast.ID, PayloadJSON: encodeDramaRevision(cast.Revision)}
	run := &dramaRun{s: svc, project: project, production: p, settings: parseDramaSettings(p.SettingsJSON)}
	if err := run.applyCastImage(job, &model.Task{ID: "new-image", ResultJSON: string(taskResult), InputJSON: `{"metadata":{"assetRatio":"3:4"}}`}); err != nil {
		t.Fatal(err)
	}
	req := SetDramaCastImageRequest{TakeID: previousTake.ID, ExpectedCastRevision: &cast.Revision, ExpectedImageVersion: &cast.ImageVersion}
	if _, err := svc.SetDramaCastImage("usr-drama", projectID, cast.ID, req); !isAppErrorStatus(err, http.StatusConflict) {
		t.Fatalf("old revision overwrote a completed generation: %v", err)
	}
	current, err := svc.repo.DramaCast(projectID, cast.ID)
	if err != nil || current.ImageTakeID != "" || current.ImageResourceID != newImage || current.Revision != cast.Revision || current.ImageVersion != cast.ImageVersion+1 {
		t.Fatalf("new generation did not clear the previous take selection: cast=%+v err=%v", current, err)
	}
}

func TestDramaCastImageTakeAdoptionMarksExactVersion(t *testing.T) {
	svc, fake := newDramaTestService(t)
	projectID := newDramaMaterialProject(t, svc, "采用历史参考图")
	cast := createDramaMaterial(t, svc, projectID, "character", "角色")
	cast.ImageResourceID = fake.resource("usr-drama", "image", "image/png")
	cast.ImageStatus, cast.ImageVersion, cast.Locked = model.DramaMediaReady, 51, true
	if err := fake.db.Save(&cast).Error; err != nil {
		t.Fatal(err)
	}
	history := make([]model.DramaTake, 0, dramaTakeListLimit+1)
	for i := 1; i <= dramaTakeListLimit+1; i++ {
		history = append(history, model.DramaTake{ID: fmt.Sprint("take-", i), ProjectID: projectID, OwnerID: cast.ID, Kind: "cast", Version: i, ResourceID: cast.ImageResourceID})
	}
	if err := fake.db.Create(&history).Error; err != nil {
		t.Fatal(err)
	}
	implicit := SetDramaCastImageRequest{TakeID: history[len(history)-1].ID, ExpectedCastRevision: &cast.Revision, ExpectedImageVersion: &cast.ImageVersion}
	same, err := svc.SetDramaCastImage("usr-drama", projectID, cast.ID, implicit)
	if err != nil || same["unchanged"] != true {
		t.Fatalf("adopting the implicit current record: result=%+v err=%v", same, err)
	}
	if current := same["cast"].(*model.DramaCast); current.ImageVersion != cast.ImageVersion || current.Revision != cast.Revision || current.ImageTakeID != "" {
		t.Fatalf("adopting the implicit current record modified the cast: %+v", current)
	}
	req := SetDramaCastImageRequest{TakeID: history[0].ID, ExpectedCastRevision: &cast.Revision, ExpectedImageVersion: &cast.ImageVersion, RestyleSegments: true}
	result, err := svc.SetDramaCastImage("usr-drama", projectID, cast.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	adopted := result["cast"].(*model.DramaCast)
	if adopted.ImageTakeID != req.TakeID || adopted.ImageResourceID != cast.ImageResourceID || adopted.ImageVersion != cast.ImageVersion+1 || adopted.Revision != cast.Revision+1 || !adopted.Locked || result["affectedSegments"] != 0 {
		t.Fatalf("unexpected adoption: cast=%+v result=%+v", adopted, result)
	}
	result, err = svc.SetDramaCastImage("usr-drama", projectID, cast.ID, req)
	if err != nil || result["unchanged"] != true || result["cast"].(*model.DramaCast).Revision != adopted.Revision {
		t.Fatalf("retry must preserve the adopted revision: result=%+v err=%v", result, err)
	}
	result, err = svc.DramaTakes("usr-drama", projectID, cast.ID, "cast", "")
	if err != nil {
		t.Fatal(err)
	}
	takes := result["takes"].([]DramaTakeView)
	if len(takes) != len(history) {
		t.Fatalf("adopted version must appear beyond the normal history limit: %d", len(takes))
	}
	for _, take := range takes {
		if take.Current != (take.ID == req.TakeID) {
			t.Fatalf("incorrect current marker: %+v", take)
		}
	}
	var count int64
	if err := fake.db.Model(&model.DramaTake{}).Where("owner_id = ?", cast.ID).Count(&count).Error; err != nil || count != int64(len(history)) {
		t.Fatalf("adoption created or removed history: count=%d err=%v", count, err)
	}
	replacement := fake.resource("usr-drama", "image", "image/png")
	result, err = svc.SetDramaCastImage("usr-drama", projectID, cast.ID, SetDramaCastImageRequest{ResourceID: replacement})
	if err != nil {
		t.Fatal(err)
	}
	if updated := result["cast"].(*model.DramaCast); updated.ImageTakeID != "" || updated.ImageResourceID != replacement {
		t.Fatalf("upload retained the superseded take pointer: %+v", updated)
	}
}

func TestDramaCastImageTakeAdoptionGuideAndLegacyImage(t *testing.T) {
	svc, fake := newDramaTestService(t)
	projectID := newDramaMaterialProject(t, svc, "引导内采用历史图")
	cast := createDramaMaterial(t, svc, projectID, "scene", "场景")
	cast.ImageResourceID = fake.resource("usr-drama", "image", "image/png")
	cast.ImageStatus = model.DramaMediaReady
	if err := fake.db.Save(&cast).Error; err != nil {
		t.Fatal(err)
	}
	take := model.DramaTake{ID: newID(), ProjectID: projectID, OwnerID: cast.ID, Kind: "cast", ResourceID: fake.resource("usr-drama", "image", "image/png"), Version: 1}
	if err := fake.db.Create(&take).Error; err != nil {
		t.Fatal(err)
	}
	req := SetDramaCastImageRequest{TakeID: take.ID, ExpectedCastRevision: &cast.Revision, ExpectedImageVersion: &cast.ImageVersion}
	for _, step := range []string{model.DramaGuideConfiguring, model.DramaGuideAssets, model.DramaGuideStory} {
		if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"guide_step": step, "status": model.DramaStatusPaused}); err != nil {
			t.Fatal(err)
		}
		result, err := svc.SetDramaCastImage("usr-drama", projectID, cast.ID, req)
		if step == model.DramaGuideConfiguring {
			if !isAppErrorStatus(err, http.StatusConflict) {
				t.Fatalf("configuring accepted adoption: %v", err)
			}
			continue
		}
		if err != nil || result["cast"].(*model.DramaCast).ImageTakeID != req.TakeID {
			t.Fatalf("%s adoption: result=%+v err=%v", step, result, err)
		}
		production, err := svc.repo.DramaProduction(projectID)
		if err != nil || production.GuideStep != step || production.Status != model.DramaStatusPaused {
			t.Fatalf("%s advanced production: %+v err=%v", step, production, err)
		}
		preserved, err := svc.repo.LatestDramaResourceTake(projectID, cast.ID, "cast", cast.ImageResourceID)
		if err != nil {
			t.Fatal(err)
		}
		adopted := result["cast"].(*model.DramaCast)
		req = SetDramaCastImageRequest{TakeID: preserved.ID, ExpectedCastRevision: &adopted.Revision, ExpectedImageVersion: &adopted.ImageVersion}
	}
}

func TestDramaCastImageTakeAdoptionUsesSegmentImageBindings(t *testing.T) {
	svc, fake := newDramaTestService(t)
	projectID := newDramaMaterialProject(t, svc, "主图的视频引用")
	cast := createDramaMaterial(t, svc, projectID, "character", "角色")
	look := model.DramaCast{ID: newID(), ProjectID: projectID, Kind: "character", ParentID: cast.ID, Name: cast.Name, LookName: "便装"}
	take := model.DramaTake{ID: newID(), ProjectID: projectID, OwnerID: cast.ID, Kind: "cast", ResourceID: fake.resource("usr-drama", "image", "image/png"), Version: 1}
	episode := model.DramaEpisode{ID: newID(), ProjectID: projectID, Number: 1, Stage: model.DramaEpisodeDone, FinalResourceID: "final", SettingsJSON: `{"videoContinuity":"parallel"}`}
	for _, row := range []any{&look, &take, &episode} {
		if err := fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	ids := encodeStringList([]string{cast.ID})
	tests := []struct {
		name, status, shotCast, shotLook, image, audio string
		wantStale                                      bool
	}{
		{"audio only", model.DramaMediaReady, "", "", "", ids, false},
		{"explicit empty overrides appearance", model.DramaMediaRunning, ids, "", "[]", ids, false},
		{"alternate look", model.DramaMediaReady, ids, encodeStringList([]string{look.ID}), "", "", false},
		{"explicit cast", model.DramaMediaRunning, "", "", ids, "", true},
		{"visible cast", model.DramaMediaReady, ids, "", "", "", true},
	}
	for i, test := range tests {
		shot := model.DramaShot{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, SegmentIndex: i, Position: i, CastIDsJSON: test.shotCast, LookCastIDsJSON: test.shotLook}
		row := model.DramaSegment{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, SegmentIndex: i, VideoStatus: test.status, ReferenceCastIDsJSON: test.image, AudioCastIDsJSON: test.audio}
		for _, record := range []any{&shot, &row} {
			if err := fake.db.Create(record).Error; err != nil {
				t.Fatal(err)
			}
		}
	}
	result, err := svc.SetDramaCastImage("usr-drama", projectID, cast.ID, SetDramaCastImageRequest{TakeID: take.ID, ExpectedCastRevision: &cast.Revision, ExpectedImageVersion: &cast.ImageVersion, RestyleSegments: true})
	if err != nil || result["affectedSegments"] != 2 {
		t.Fatalf("image binding impact: result=%+v err=%v", result, err)
	}
	rows, err := svc.repo.DramaSegments(episode.ID)
	if err != nil || len(rows) != len(tests) {
		t.Fatalf("reading segments: %v", err)
	}
	for i, row := range rows {
		test := tests[i]
		wantStatus := test.status
		var wantRevision int64
		if test.wantStale {
			wantStatus, wantRevision = model.DramaMediaStale, 1
		}
		if row.VideoStatus != wantStatus || row.VideoRevision != wantRevision {
			t.Errorf("%s: got status=%s revision=%d", test.name, row.VideoStatus, row.VideoRevision)
		}
	}
}

func TestDramaCastImageTakeAdoptionRequeuesExplicitVideo(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	segment := detail.Segments[0]
	if len(segment.Request.References) == 0 {
		t.Fatal("fixture has no segment reference")
	}
	cast, err := svc.repo.DramaCast(projectID, segment.Request.References[0].CastID)
	if err != nil {
		t.Fatal(err)
	}
	take := model.DramaTake{ID: newID(), ProjectID: projectID, Kind: "cast", OwnerID: cast.ID, ResourceID: fake.resource("usr-drama", "image", "image/png"), Version: 1}
	if err := fake.db.Create(&take).Error; err != nil {
		t.Fatal(err)
	}
	quote, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_video", TargetID: segment.ID, EpisodeID: detail.Episode.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(quote)); err != nil {
		t.Fatal(err)
	}
	queued := model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: detail.Episode.ID, ShotID: segment.ID, Kind: model.DramaJobSegmentVideo, Status: model.DramaJobQueued}
	if err := fake.db.Create(&queued).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetDramaCastImage("usr-drama", projectID, cast.ID, SetDramaCastImageRequest{TakeID: take.ID, ExpectedCastRevision: &cast.Revision, ExpectedImageVersion: &cast.ImageVersion}); err != nil {
		t.Fatal(err)
	}
	job, err := svc.repo.DramaJob(projectID, queued.ID)
	if err != nil || job.Status != model.DramaJobCanceled {
		t.Fatalf("old queued job not discarded: %+v err=%v", job, err)
	}
	runDramaTicks(t, svc, projectID, 10)
	current, err := svc.repo.DramaSegment(projectID, segment.ID)
	if err != nil || current.VideoStatus != model.DramaMediaReady || fake.byKind["video"] != 1 {
		t.Fatalf("explicit request not fulfilled once: %+v videos=%d err=%v", current, fake.byKind["video"], err)
	}
	for _, request := range fake.requests {
		if request.Type == "canvas_video" {
			images, _ := request.Input["referenceImages"].([]any)
			for _, image := range images {
				if image.(map[string]any)["storageKey"] == "resource:"+take.ResourceID {
					return
				}
			}
		}
	}
	t.Fatal("regenerated job did not submit the adopted image")
}

func TestDramaCastImageTakeAdoptionTailFrameImpact(t *testing.T) {
	for _, restyle := range []bool{false, true} {
		t.Run(fmt.Sprintf("restyle-%t", restyle), func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			projectID := newDramaMaterialProject(t, svc, "尾帧续接")
			cast := createDramaMaterial(t, svc, projectID, "prop", "道具")
			take := model.DramaTake{ID: newID(), ProjectID: projectID, Kind: "cast", OwnerID: cast.ID, ResourceID: fake.resource("usr-drama", "image", "image/png"), Version: 1}
			episode := model.DramaEpisode{ID: newID(), ProjectID: projectID, Number: 1, Stage: model.DramaEpisodeVideo, SettingsJSON: `{"videoContinuity":"tail_frame"}`}
			if err := fake.db.Create(&take).Error; err != nil {
				t.Fatal(err)
			}
			if err := fake.db.Create(&episode).Error; err != nil {
				t.Fatal(err)
			}
			first := model.DramaSegment{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, ReferenceCastIDsJSON: encodeStringList([]string{cast.ID}), VideoStatus: model.DramaMediaReady, VideoResourceID: "ready-video", TailFrameResourceID: "existing-tail"}
			next := model.DramaSegment{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, SegmentIndex: 1, VideoStatus: model.DramaMediaRunning}
			if err := fake.db.Create(&[]model.DramaSegment{first, next}).Error; err != nil {
				t.Fatal(err)
			}
			result, err := svc.SetDramaCastImage("usr-drama", projectID, cast.ID, SetDramaCastImageRequest{TakeID: take.ID, ExpectedCastRevision: &cast.Revision, ExpectedImageVersion: &cast.ImageVersion, RestyleSegments: restyle})
			if err != nil {
				t.Fatal(err)
			}
			rows, err := svc.repo.DramaSegments(episode.ID)
			if err != nil || len(rows) != 2 {
				t.Fatalf("reading segments: %v", err)
			}
			if restyle {
				if result["affectedSegments"] != 2 || rows[0].VideoStatus != model.DramaMediaStale || rows[1].VideoStatus != model.DramaMediaStale || rows[1].VideoRevision != 1 {
					t.Fatalf("tail-frame dependency not marked once: result=%+v segments=%+v", result, rows)
				}
			} else if result["affectedSegments"] != 0 || rows[0].VideoStatus != model.DramaMediaReady || rows[1].VideoStatus != model.DramaMediaRunning || rows[1].VideoRevision != 0 {
				t.Fatalf("unchanged tail discarded its downstream video: result=%+v segments=%+v", result, rows)
			}
		})
	}
}

func TestDramaCastImageTakeAdoptionRejectsInvalidOrBusyRequests(t *testing.T) {
	svc, fake := newDramaTestService(t)
	projectID := newDramaMaterialProject(t, svc, "采用历史图校验")
	cast := createDramaMaterial(t, svc, projectID, "scene", "场景")
	resourceID := fake.resource("usr-drama", "image", "image/png")
	takes := []model.DramaTake{
		{ID: "valid", ProjectID: projectID, OwnerID: cast.ID, Kind: "cast", ResourceID: resourceID},
		{ID: "other-project", ProjectID: "other-project", OwnerID: cast.ID, Kind: "cast", ResourceID: resourceID},
		{ID: "other-cast", ProjectID: projectID, OwnerID: "other-cast", Kind: "cast", ResourceID: resourceID},
		{ID: "other-kind", ProjectID: projectID, OwnerID: cast.ID, Kind: "video", ResourceID: resourceID},
		{ID: "other-user", ProjectID: projectID, OwnerID: cast.ID, Kind: "cast", ResourceID: fake.resource("other-user", "image", "image/png")},
		{ID: "invalid-media", ProjectID: projectID, OwnerID: cast.ID, Kind: "cast", ResourceID: fake.resource("usr-drama", "video", "video/mp4")},
	}
	if err := fake.db.Create(&takes).Error; err != nil {
		t.Fatal(err)
	}
	stale := cast.Revision - 1
	for _, test := range []struct {
		request SetDramaCastImageRequest
		status  int
	}{
		{SetDramaCastImageRequest{TakeID: "valid"}, http.StatusBadRequest},
		{SetDramaCastImageRequest{TakeID: "valid", ExpectedCastRevision: &cast.Revision}, http.StatusBadRequest},
		{SetDramaCastImageRequest{TakeID: "valid", ExpectedCastRevision: &cast.Revision, ExpectedImageVersion: &cast.ImageVersion, ResourceID: resourceID}, http.StatusBadRequest},
		{SetDramaCastImageRequest{TakeID: "other-project", ExpectedCastRevision: &cast.Revision, ExpectedImageVersion: &cast.ImageVersion}, http.StatusNotFound},
		{SetDramaCastImageRequest{TakeID: "other-cast", ExpectedCastRevision: &cast.Revision, ExpectedImageVersion: &cast.ImageVersion}, http.StatusNotFound},
		{SetDramaCastImageRequest{TakeID: "other-kind", ExpectedCastRevision: &cast.Revision, ExpectedImageVersion: &cast.ImageVersion}, http.StatusNotFound},
		{SetDramaCastImageRequest{TakeID: "other-user", ExpectedCastRevision: &cast.Revision, ExpectedImageVersion: &cast.ImageVersion}, http.StatusBadRequest},
		{SetDramaCastImageRequest{TakeID: "invalid-media", ExpectedCastRevision: &cast.Revision, ExpectedImageVersion: &cast.ImageVersion}, http.StatusBadRequest},
		{SetDramaCastImageRequest{TakeID: "valid", ExpectedCastRevision: &stale, ExpectedImageVersion: &cast.ImageVersion}, http.StatusConflict},
	} {
		_, err := svc.SetDramaCastImage("usr-drama", projectID, cast.ID, test.request)
		if !isAppErrorStatus(err, test.status) {
			t.Fatalf("request=%+v expected HTTP %d, got %v", test.request, test.status, err)
		}
	}
	req := SetDramaCastImageRequest{TakeID: "valid", ExpectedCastRevision: &cast.Revision, ExpectedImageVersion: &cast.ImageVersion}
	if err := fake.db.Model(&cast).Update("image_status", model.DramaMediaQueued).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetDramaCastImage("usr-drama", projectID, cast.ID, req); !isAppErrorStatus(err, http.StatusConflict) {
		t.Fatalf("accepted queued image slot: %v", err)
	}
	if err := fake.db.Model(&cast).Update("image_status", model.DramaMediaReady).Error; err != nil {
		t.Fatal(err)
	}
	imageJob := model.DramaJob{ID: "running-image", ProjectID: projectID, CastID: cast.ID, Kind: model.DramaJobCastImage, Status: model.DramaJobRunning}
	if err := fake.db.Create(&imageJob).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetDramaCastImage("usr-drama", projectID, cast.ID, req); !isAppErrorStatus(err, http.StatusConflict) {
		t.Fatalf("accepted running image job: %v", err)
	}
	current, err := svc.repo.DramaCast(projectID, cast.ID)
	if err != nil || current.Revision != cast.Revision || current.ImageTakeID != "" || current.ImageResourceID != "" {
		t.Fatalf("rejected requests modified the asset: cast=%+v err=%v", current, err)
	}
}

func TestDramaCastImageTakeAdoptionRestylesReferencedSegmentsAtomically(t *testing.T) {
	for _, mode := range []string{"keep-video", "restyle", "write-failure"} {
		t.Run(mode, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			projectID := newDramaMaterialProject(t, svc, "参考图影响视频")
			cast := createDramaMaterial(t, svc, projectID, "character", "角色")
			cast.ImageResourceID = fake.resource("usr-drama", "image", "image/png")
			cast.ImageStatus = model.DramaMediaReady
			if err := fake.db.Save(&cast).Error; err != nil {
				t.Fatal(err)
			}
			if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"status": model.DramaStatusCompleted}); err != nil {
				t.Fatal(err)
			}
			take := model.DramaTake{ID: "historical-image", ProjectID: projectID, OwnerID: cast.ID, Kind: "cast", ResourceID: fake.resource("usr-drama", "image", "image/png")}
			episode := model.DramaEpisode{ID: newID(), ProjectID: projectID, Number: 1, Stage: model.DramaEpisodeDone, FinalResourceID: "existing-final"}
			segment := model.DramaSegment{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, SegmentIndex: 0, PromptStatus: model.DramaMediaReady, VideoPromptOverride: "用户保存的视频提示词", VideoStatus: model.DramaMediaReady, VideoResourceID: "existing-video"}
			shot := model.DramaShot{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, CastIDsJSON: `["` + cast.ID + `"]`}
			for _, row := range []any{&take, &episode, &segment, &shot} {
				if err := fake.db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			writeFailure := errors.New("injected final production update failure")
			if mode == "write-failure" {
				if err := fake.db.Callback().Update().Before("gorm:update").Register("adoption-failure", func(tx *gorm.DB) {
					if tx.Statement.Table == "drama_productions" {
						tx.AddError(writeFailure)
					}
				}); err != nil {
					t.Fatal(err)
				}
			}
			req := SetDramaCastImageRequest{TakeID: take.ID, ExpectedCastRevision: &cast.Revision, ExpectedImageVersion: &cast.ImageVersion, RestyleSegments: mode != "keep-video"}
			result, adoptErr := svc.SetDramaCastImage("usr-drama", projectID, cast.ID, req)
			current, err := svc.repo.DramaCast(projectID, cast.ID)
			if err != nil {
				t.Fatal(err)
			}
			currentEpisode, err := svc.repo.DramaEpisode(projectID, episode.ID)
			if err != nil {
				t.Fatal(err)
			}
			currentSegment, err := svc.repo.DramaSegment(projectID, segment.ID)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "write-failure" {
				if !errors.Is(adoptErr, writeFailure) || current.ImageResourceID != cast.ImageResourceID || current.ImageTakeID != "" || current.Revision != cast.Revision || currentEpisode.FinalStale || currentSegment.VideoStatus != model.DramaMediaReady {
					t.Fatalf("failed adoption left partial updates: cast=%+v episode=%+v segment=%+v err=%v", current, currentEpisode, currentSegment, adoptErr)
				}
				return
			}
			if adoptErr != nil || current.ImageTakeID != take.ID || current.ImageResourceID != take.ResourceID || current.Locked || currentSegment.VideoResourceID != segment.VideoResourceID || currentSegment.VideoPromptOverride != segment.VideoPromptOverride {
				t.Fatalf("unexpected adoption: cast=%+v segment=%+v err=%v", current, currentSegment, adoptErr)
			}
			if req.RestyleSegments {
				if result["affectedSegments"] != 1 || !currentEpisode.FinalStale || currentEpisode.Stage != model.DramaEpisodeVideo || currentSegment.VideoStatus != model.DramaMediaStale {
					t.Fatalf("referenced video was not marked for update: episode=%+v segment=%+v result=%+v", currentEpisode, currentSegment, result)
				}
			} else if result["affectedSegments"] != 0 || currentEpisode.FinalStale || currentSegment.VideoStatus != model.DramaMediaReady {
				t.Fatalf("adoption changed existing video: episode=%+v segment=%+v result=%+v", currentEpisode, currentSegment, result)
			}
		})
	}
}
