package app

import (
	"testing"

	"yingce/backend/internal/model"
)

func adoptedDramaShotVideos(t *testing.T, svc *Service, fake *fakeDramaBackend, projectID, episodeID string) ([]model.DramaShot, []model.DramaShotMedia, []model.DramaTake) {
	t.Helper()
	shots, err := svc.repo.DramaShots(episodeID)
	if err != nil || len(shots) < 2 {
		t.Fatalf("need several ordered shots: %+v %v", shots, err)
	}
	rows := make([]model.DramaShotMedia, len(shots))
	takes := make([]model.DramaTake, len(shots))
	// Insertion order must not become playback order.
	for i := len(shots) - 1; i >= 0; i-- {
		resourceID := fake.resource("usr-drama", "video", "video/mp4")
		duration := int64(2157 + i*1131)
		resourceDuration := duration
		if i == 1 {
			resourceDuration = 0 // A persisted take duration can fill older resource metadata.
		}
		if err := fake.db.Model(&model.Resource{}).Where("id = ?", resourceID).Update("duration_ms", resourceDuration).Error; err != nil {
			t.Fatal(err)
		}
		takes[i] = model.DramaTake{ID: newID(), ProjectID: projectID, OwnerID: shots[i].ID, Kind: "shot_video", Version: 1, ResourceID: resourceID, DurationMs: duration}
		rows[i] = model.DramaShotMedia{ID: newID(), ProjectID: projectID, EpisodeID: episodeID, ShotID: shots[i].ID, Kind: "video", Revision: 1, ConfigJSON: "{}", CurrentTakeID: takes[i].ID, ResourceID: resourceID, Status: model.DramaMediaReady, ScriptHash: dramaShotScriptHash(shots[i])}
		for _, value := range []any{&takes[i], &rows[i]} {
			if err := fake.db.Create(value).Error; err != nil {
				t.Fatal(err)
			}
		}
	}
	return shots, rows, takes
}

func TestRenderDramaEpisodeUsesWholeShotOrderAndActualDurations(t *testing.T) {
	svc, fake, projectID, episode := readyDramaEpisodeForRender(t)
	shots, rows, takes := adoptedDramaShotVideos(t, svc, fake, projectID, episode.ID)
	readiness, err := svc.DramaWorkflowReadiness("usr-drama", projectID)
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, ready := range readiness.Episodes {
		if ready.EpisodeID == episode.ID {
			found = true
			if ready.RenderSource != "shots" || ready.RenderVideoCount != len(shots) || ready.RenderReadyVideos != len(shots) || !ready.CanRender {
				t.Fatalf("shot readiness = %+v", ready)
			}
		}
	}
	if !found {
		t.Fatal("episode readiness missing")
	}
	if _, err := svc.RenderDramaEpisode("usr-drama", projectID, episode.ID, RenderDramaEpisodeRequest{ExpectedRevision: &episode.Revision}); err != nil {
		t.Fatal(err)
	}
	if len(fake.renders) != 1 {
		t.Fatalf("want one real render submission, got %d", len(fake.renders))
	}
	timeline := fake.renders[0]
	if len(timeline.Clips) != len(shots) {
		t.Fatalf("clips = %+v", timeline.Clips)
	}
	var total int64
	for i, clip := range timeline.Clips {
		if clip.ID != "shot-"+shots[i].ID || clip.DirectMedia == nil || clip.DirectMedia.ID != rows[i].ResourceID || clip.StartMs != total || clip.DurationMs != takes[i].DurationMs || clip.SourceDurationMs != takes[i].DurationMs {
			t.Fatalf("shot %d assembled wrong source/order/duration: %+v", i, clip)
		}
		total += takes[i].DurationMs
	}
	if timeline.DurationMs != total {
		t.Fatalf("timeline duration = %d, want %d", timeline.DurationMs, total)
	}
	runDramaTicks(t, svc, projectID, 8)
	current, _ := svc.repo.DramaEpisode(projectID, episode.ID)
	if current.Stage != model.DramaEpisodeDone || current.DurationMs != total || current.FinalResourceID == "" || fake.byKind["video"]+fake.byKind["image"] != 0 {
		t.Fatalf("shot render did not complete independently: %+v calls=%v", current, fake.byKind)
	}
}

func TestRenderDramaEpisodeNeverFallsBackFromIncompleteShotSelection(t *testing.T) {
	for _, issue := range []string{"missing-slot", "missing-resource-marker", "missing-take-marker", "stale", "script-changed", "missing-resource", "foreign-resource", "wrong-mime", "missing-take", "foreign-take", "different-take-resource", "missing-duration"} {
		t.Run(issue, func(t *testing.T) {
			svc, fake, projectID, episode := readyDramaEpisodeForRender(t)
			_, rows, takes := adoptedDramaShotVideos(t, svc, fake, projectID, episode.ID)
			row := rows[len(rows)-1]
			fields := map[string]any{}
			switch issue {
			case "missing-slot":
				if err := fake.db.Delete(&model.DramaShotMedia{}, "id = ?", row.ID).Error; err != nil {
					t.Fatal(err)
				}
			case "missing-resource-marker":
				fields["resource_id"] = ""
			case "missing-take-marker":
				fields["current_take_id"] = ""
			case "stale":
				fields["status"] = model.DramaMediaStale
			case "script-changed":
				fields["script_hash"] = "old-script"
			case "missing-resource":
				if err := fake.db.Delete(&model.Resource{}, "id = ?", row.ResourceID).Error; err != nil {
					t.Fatal(err)
				}
			case "foreign-resource":
				if err := fake.db.Model(&model.Resource{}).Where("id = ?", row.ResourceID).Update("user_id", "other-user").Error; err != nil {
					t.Fatal(err)
				}
			case "wrong-mime":
				if err := fake.db.Model(&model.Resource{}).Where("id = ?", row.ResourceID).Update("mime_type", "image/png").Error; err != nil {
					t.Fatal(err)
				}
			case "missing-take":
				fields["current_take_id"] = "missing-take"
			case "foreign-take":
				if err := fake.db.Model(&model.DramaTake{}).Where("id = ?", row.CurrentTakeID).Update("project_id", "other-project").Error; err != nil {
					t.Fatal(err)
				}
			case "different-take-resource":
				fields["current_take_id"] = takes[0].ID
			case "missing-duration":
				if err := fake.db.Model(&model.Resource{}).Where("id = ?", row.ResourceID).Update("duration_ms", 0).Error; err != nil {
					t.Fatal(err)
				}
				if err := fake.db.Model(&model.DramaTake{}).Where("id = ?", row.CurrentTakeID).Update("duration_ms", 0).Error; err != nil {
					t.Fatal(err)
				}
			}
			if len(fields) > 0 {
				if err := fake.db.Model(&model.DramaShotMedia{}).Where("id = ?", row.ID).Updates(fields).Error; err != nil {
					t.Fatal(err)
				}
			}
			view, err := dramaEpisodeVideoTimeline(svc.repo, "usr-drama", projectID, episode.ID, "9:16")
			if err == nil || view.Source != "shots" || view.Ready >= view.Total {
				t.Fatalf("must report incomplete shot selection despite ready old segments: %+v %v", view, err)
			}
			if _, err := svc.RenderDramaEpisode("usr-drama", projectID, episode.ID, RenderDramaEpisodeRequest{ExpectedRevision: &episode.Revision}); err == nil || fake.byKind["render"] != 0 {
				t.Fatalf("invalid shots fell back to old segment videos: %v calls=%v", err, fake.byKind)
			}
		})
	}
}

func TestDramaShotAdoptionInvalidatesAlreadySubmittedRender(t *testing.T) {
	svc, fake, projectID, episode := readyDramaEpisodeForRender(t)
	_, rows, _ := adoptedDramaShotVideos(t, svc, fake, projectID, episode.ID)
	oldFinal := fake.resource("usr-drama", "video", "video/mp4")
	if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", episode.ID).Update("final_resource_id", oldFinal).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RenderDramaEpisode("usr-drama", projectID, episode.ID, RenderDramaEpisodeRequest{ExpectedRevision: &episode.Revision}); err != nil {
		t.Fatal(err)
	}
	row := rows[0]
	resourceID := fake.resource("usr-drama", "video", "video/mp4")
	take := model.DramaTake{ID: newID(), ProjectID: projectID, OwnerID: row.ShotID, Kind: "shot_video", Version: 2, ResourceID: resourceID, DurationMs: 4321}
	if err := fake.db.Create(&take).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AdoptDramaShotMedia("usr-drama", projectID, row.ShotID, "video", DramaShotMediaAdoptRequest{ExpectedRevision: &row.Revision, TakeID: take.ID}); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, projectID, 8)
	current, _ := svc.repo.DramaEpisode(projectID, episode.ID)
	if current.Revision != episode.Revision+1 || current.Stage != model.DramaEpisodeReview || current.FinalResourceID != oldFinal || !current.FinalStale || !current.VideoRequestsOnly {
		t.Fatalf("old render replaced new selection or adoption failed to invalidate: %+v", current)
	}
	finals, err := svc.repo.DramaTakes(projectID, episode.ID, "final", 50)
	if err != nil || len(finals) == 0 || finals[0].ResourceID == oldFinal {
		t.Fatalf("paid/submitted old result must remain in history: %+v %v", finals, err)
	}
	if _, err := svc.RenderDramaEpisode("usr-drama", projectID, episode.ID, RenderDramaEpisodeRequest{ExpectedRevision: &current.Revision}); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, projectID, 8)
	current, _ = svc.repo.DramaEpisode(projectID, episode.ID)
	if current.FinalResourceID == oldFinal || current.FinalStale || current.Stage != model.DramaEpisodeDone || fake.byKind["render"] != 2 {
		t.Fatalf("new adopted timeline did not render: %+v calls=%v", current, fake.byKind)
	}
}
