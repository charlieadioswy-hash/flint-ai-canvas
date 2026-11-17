package app

import (
	"encoding/json"
	"errors"
	"strconv"
	"testing"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func TestDramaCastVoiceRestyleAndRevisionAreAtomic(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run("fail="+strconv.FormatBool(fail), func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			projectID := newDramaMaterialProject(t, svc, "声音影响与事务")
			cast := createDramaMaterial(t, svc, projectID, "character", "角色")
			cast.VoiceSampleResourceID = fake.resource("usr-drama", "audio", "audio/mpeg")
			if err := fake.db.Save(&cast).Error; err != nil {
				t.Fatal(err)
			}
			episode := model.DramaEpisode{ID: newID(), ProjectID: projectID, Number: 1, Stage: model.DramaEpisodeDone, FinalResourceID: "existing-final"}
			segment := model.DramaSegment{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, SegmentIndex: 0, PromptStatus: model.DramaMediaReady, VideoPromptOverride: "手写的视频提示词", VideoStatus: model.DramaMediaReady, VideoResourceID: "existing-video"}
			shot := model.DramaShot{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, CastIDsJSON: `["` + cast.ID + `"]`}
			for _, row := range []any{&episode, &segment, &shot} {
				if err := fake.db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			p, _ := svc.repo.DramaProduction(projectID)
			lateWrite := false
			if fail {
				if err := fake.db.Callback().Update().Before("gorm:update").Register("voice-late-write-failure", func(tx *gorm.DB) {
					fields, _ := tx.Statement.Dest.(map[string]any)
					if tx.Statement.Table == "drama_productions" && fields["updated_at"] != nil {
						lateWrite = true
						tx.AddError(errors.New("injected production revision failure"))
					}
				}); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = fake.db.Callback().Update().Remove("voice-late-write-failure") })
			}
			result, err := svc.SetDramaCastVoice("usr-drama", projectID, cast.ID, SetDramaCastVoiceRequest{RestyleSegments: true}, true)
			afterCast, _ := svc.repo.DramaCast(projectID, cast.ID)
			afterProduction, _ := svc.repo.DramaProduction(projectID)
			afterEpisode, _ := svc.repo.DramaEpisode(projectID, episode.ID)
			afterSegments, _ := svc.repo.DramaSegments(episode.ID)
			if fail {
				if err == nil || !lateWrite || afterCast.VoiceSampleResourceID != cast.VoiceSampleResourceID || afterProduction.Revision != p.Revision || afterEpisode.FinalStale || afterSegments[0].VideoStatus != model.DramaMediaReady || afterSegments[0].Revision != segment.Revision {
					t.Fatalf("late failure left partial voice/video changes: err=%v late=%v cast=%+v production=%+v episode=%+v segments=%+v", err, lateWrite, afterCast, afterProduction, afterEpisode, afterSegments)
				}
				return
			}
			if err != nil || result["affectedSegments"] != 1 || afterCast.VoiceSampleResourceID != "" || afterCast.Revision != cast.Revision || afterProduction.Revision != p.Revision+1 || !afterEpisode.FinalStale || afterEpisode.Stage != model.DramaEpisodeVideo || afterSegments[0].VideoStatus != model.DramaMediaStale || afterSegments[0].VideoResourceID != segment.VideoResourceID || afterSegments[0].VideoPromptOverride != segment.VideoPromptOverride {
				t.Fatalf("voice change did not preserve results and invalidate video: err=%v result=%+v cast=%+v episode=%+v segments=%+v", err, result, afterCast, afterEpisode, afterSegments)
			}
		})
	}
}

func TestDramaCastVoiceChangesPreservePendingImage(t *testing.T) {
	for _, status := range []string{model.DramaMediaQueued, model.DramaMediaRunning} {
		for _, clear := range []bool{false, true} {
			t.Run(status+"/clear="+strconv.FormatBool(clear), func(t *testing.T) {
				svc, fake := newDramaTestService(t)
				projectID := newDramaMaterialProject(t, svc, "声音与图片独立更新")
				cast := createDramaMaterial(t, svc, projectID, "character", "角色")
				project, p, err := svc.dramaForUser("usr-drama", projectID)
				if err != nil {
					t.Fatal(err)
				}
				cast.ImageStatus = status
				cast.VoiceSampleResourceID = fake.resource("usr-drama", "audio", "audio/mpeg")
				cast.ImageResourceID = fake.resourceSized("usr-drama", "image", "image/png", 768, 1024)
				if err := fake.db.Save(&cast).Error; err != nil {
					t.Fatal(err)
				}
				job := model.DramaJob{ID: newID(), ProjectID: projectID, Kind: model.DramaJobCastImage, CastID: cast.ID, Status: status, PayloadJSON: encodeDramaRevision(cast.Revision)}
				if err := fake.db.Create(&job).Error; err != nil {
					t.Fatal(err)
				}
				sample := fake.resource("usr-drama", "audio", "audio/mpeg")
				if _, err := svc.SetDramaCastVoice("usr-drama", projectID, cast.ID, SetDramaCastVoiceRequest{SampleResourceID: sample}, clear); err != nil {
					t.Fatal(err)
				}
				afterVoice, _ := svc.repo.DramaCast(projectID, cast.ID)
				afterProduction, _ := svc.repo.DramaProduction(projectID)
				var storedJob model.DramaJob
				if err := fake.db.First(&storedJob, "id = ?", job.ID).Error; err != nil {
					t.Fatal(err)
				}
				if afterVoice.Revision != cast.Revision || afterVoice.ImageStatus != status || afterVoice.ImageResourceID != cast.ImageResourceID || storedJob.Status != status || afterProduction.Revision != p.Revision+1 {
					t.Fatalf("voice edit changed pending image or failed to advance production: cast=%+v job=%+v production=%+v", afterVoice, storedJob, afterProduction)
				}
				if (clear && afterVoice.VoiceSampleResourceID != "") || (!clear && afterVoice.VoiceSampleResourceID != sample) {
					t.Fatalf("voice edit not stored: %+v", afterVoice)
				}
				resourceID := fake.resourceSized("usr-drama", "image", "image/png", 768, 1024)
				result, _ := json.Marshal(map[string]any{"images": []any{map[string]any{"resourceId": resourceID}}})
				run := &dramaRun{s: svc, project: project, production: p, settings: parseDramaSettings(p.SettingsJSON)}
				if err := run.applyCastImage(&job, &model.Task{ID: newID(), ResultJSON: string(result), InputJSON: `{"metadata":{"assetRatio":"3:4"}}`}); err != nil {
					t.Fatal(err)
				}
				afterImage, _ := svc.repo.DramaCast(projectID, cast.ID)
				takes, _ := svc.repo.DramaTakes(projectID, cast.ID, "cast", 100)
				if afterImage.ImageResourceID != resourceID || afterImage.ImageStatus != model.DramaMediaReady || len(takes) != 1 || afterImage.VoiceSampleResourceID != afterVoice.VoiceSampleResourceID {
					t.Fatalf("paid image was not adopted or overwrote voice: cast=%+v takes=%+v", afterImage, takes)
				}
			})
		}
	}
}

func TestDramaLookUsesRenamedParentWithoutChangingManualPrompts(t *testing.T) {
	svc, fake := newDramaTestService(t)
	projectID := newDramaMaterialProject(t, svc, "角色身份继承")
	cast := createDramaMaterial(t, svc, projectID, "character", "旧姓名")
	created, err := svc.AddDramaCastLook("usr-drama", projectID, cast.ID, DramaCastLookRequest{LookName: "晚宴", Appearance: "黑色礼服"})
	if err != nil {
		t.Fatal(err)
	}
	look := created["look"].(model.DramaCast)
	manual := "手写提示词：旧姓名站在窗边，保留我的内容。"
	episode := model.DramaEpisode{ID: newID(), ProjectID: projectID, Number: 1, Stage: model.DramaEpisodeVideo}
	segment := model.DramaSegment{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, SegmentIndex: 0, PromptStatus: model.DramaMediaReady, VideoPromptOverride: manual, VideoStatus: model.DramaMediaReady}
	shot := model.DramaShot{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, CastIDsJSON: `["` + cast.ID + `"]`, LookCastIDsJSON: `["` + look.ID + `"]`, DurationMs: 5000}
	for _, row := range []any{&episode, &segment, &shot} {
		if err := fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := fake.db.Model(&model.DramaCast{}).Where("id = ?", look.ID).Update("image_prompt", manual).Error; err != nil {
		t.Fatal(err)
	}
	p, _ := svc.repo.DramaProduction(projectID)
	name := "新姓名"
	if _, err := svc.UpdateDramaCast("usr-drama", projectID, cast.ID, UpdateDramaCastRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, Name: &name, ImageOptions: &DramaCastImageOptions{Ratio: "3:4"}}); err != nil {
		t.Fatal(err)
	}
	after, err := svc.repo.DramaCast(projectID, look.ID)
	if err != nil || after.Name != name || after.ImagePrompt != manual || after.Revision != look.Revision {
		t.Fatalf("look must derive current identity without rewriting image settings: %+v %v", after, err)
	}
	assertLook := func(casts []model.DramaCast) {
		t.Helper()
		for _, item := range casts {
			if item.ID == look.ID {
				if item.Name != name {
					t.Fatalf("list retained old parent name: %+v", item)
				}
				return
			}
		}
		t.Fatal("look missing")
	}
	casts, err := svc.repo.DramaCasts(projectID)
	if err != nil {
		t.Fatal(err)
	}
	assertLook(casts)
	if err := svc.repo.Transaction(func(tx *repository.Repository) error {
		locked, err := tx.DramaCastForUpdate(projectID, look.ID)
		if err != nil || locked.Name != name {
			t.Fatalf("locked look retained old parent name: %+v %v", locked, err)
		}
		lockedCasts, err := tx.DramaCastsForUpdate(projectID)
		if err != nil {
			return err
		}
		assertLook(lockedCasts)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	segments, _ := svc.repo.DramaSegments(episode.ID)
	if len(segments) != 1 || segments[0].VideoPromptOverride != manual || segments[0].PromptStatus != model.DramaMediaStale || segments[0].VideoStatus != model.DramaMediaStale {
		t.Fatalf("identity edit must preserve manual text while invalidating generated context: %+v", segments)
	}
	// Automatic prompt compilation also handles an old copied name in a caller's snapshot.
	cast.Name = name
	byID := map[string]model.DramaCast{cast.ID: cast, look.ID: look}
	if ref := dramaShotSubjectReference(look, byID); ref.Name != name+"·晚宴" {
		t.Fatalf("single shot used stale look identity: %+v", ref)
	}
	drafts := buildDramaSegmentDrafts(parseDramaSettings(p.SettingsJSON), dramaBibleMeta{}, []model.DramaShot{shot}, byID, nil)
	if len(drafts) != 1 || len(drafts[0].input.References) != 1 || drafts[0].input.References[0].Name != name+"·晚宴" {
		t.Fatalf("segment used stale look identity: %+v", drafts)
	}
	parent, _ := svc.repo.DramaCast(projectID, cast.ID)
	p, _ = svc.repo.DramaProduction(projectID)
	aliases := []string{"新别名"}
	if _, err := svc.UpdateDramaCast("usr-drama", projectID, cast.ID, UpdateDramaCastRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &parent.Revision, Aliases: &aliases, ImageOptions: &DramaCastImageOptions{Ratio: "3:4"}}); err != nil {
		t.Fatal(err)
	}
	segments, _ = svc.repo.DramaSegments(episode.ID)
	if segments[0].VideoPromptOverride != manual {
		t.Fatal("alias-only edit removed manual prompt")
	}
}
