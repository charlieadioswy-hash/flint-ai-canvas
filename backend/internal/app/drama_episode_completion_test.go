package app

import (
	"encoding/json"
	"testing"

	"yingce/backend/internal/model"
)

func episodeCompletionRow(t *testing.T, svc *Service, projectID, episodeID string) DramaEpisodeRow {
	t.Helper()
	summary, err := svc.DramaSummary("usr-drama", projectID)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range summary.Episodes {
		if row.ID == episodeID {
			return row
		}
	}
	t.Fatalf("episode %s missing from summary", episodeID)
	return DramaEpisodeRow{}
}

func TestDramaEpisodeCompletionDistinguishesSuccessfulEmptyExtraction(t *testing.T) {
	svc, fake := newDramaTestService(t)
	summary := createGuidedDrama(t, svc,
		DramaChapterInput{Title: "第一章", Text: "窗外天亮。"},
		DramaChapterInput{Title: "第二章", Text: "夕阳西下。"},
	)
	projectID := summary.Project.ID
	episodes, err := svc.repo.DramaEpisodes(projectID)
	if err != nil || len(episodes) != 2 {
		t.Fatalf("episodes = %+v: %v", episodes, err)
	}
	first, second := episodes[0], episodes[1]
	firstChapters, secondChapters := decodeStringList(first.ChapterIDsJSON), decodeStringList(second.ChapterIDsJSON)
	manual := model.DramaCast{ID: newID(), ProjectID: projectID, Kind: "prop", Name: "手工添加的书"}
	if err := fake.db.Create(&manual).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(&second).UpdateColumn("asset_ids_json", `["`+manual.ID+`"]`).Error; err != nil {
		t.Fatal(err)
	}
	if row := episodeCompletionRow(t, svc, projectID, second.ID); row.AssetsReady {
		t.Fatalf("manual association marked extraction complete: %+v", row)
	}
	addJob := func(status string, payload any) *model.DramaJob {
		t.Helper()
		encoded, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		job := &model.DramaJob{ID: newID(), ProjectID: projectID, Status: status, Kind: model.DramaJobBible, PayloadJSON: string(encoded)}
		if err := fake.db.Create(job).Error; err != nil {
			t.Fatal(err)
		}
		return job
	}
	addJob(model.DramaJobSucceeded, dramaInitialAssetsPayload{InitialAssets: true, SourceChapterIDs: firstChapters, SourceEpisodeIDs: []string{first.ID}})
	if row := episodeCompletionRow(t, svc, projectID, first.ID); !row.AssetsReady || row.StoryboardReady || row.VideoReady {
		t.Fatalf("successful empty initial extraction = %+v", row)
	}
	if row := episodeCompletionRow(t, svc, projectID, second.ID); row.AssetsReady {
		t.Fatalf("another episode's success was counted: %+v", row)
	}
	for _, kind := range []string{"character", "scene"} {
		addJob(model.DramaJobSucceeded, dramaAssetExtractionPayload{Scope: dramaAssetExtractionScope, AssetKind: kind, SourceChapterIDs: secondChapters, SourceEpisodeIDs: []string{second.ID}})
	}
	addJob(model.DramaJobSucceeded, dramaAssetExtractionPayload{Scope: dramaAssetExtractionScope, AssetKind: "prop", SourceChapterIDs: firstChapters, SourceEpisodeIDs: []string{second.ID}})
	prop := addJob(model.DramaJobFailed, dramaAssetExtractionPayload{Scope: dramaAssetExtractionScope, AssetKind: "prop", SourceChapterIDs: secondChapters, SourceEpisodeIDs: []string{second.ID}})
	if row := episodeCompletionRow(t, svc, projectID, second.ID); row.AssetsReady {
		t.Fatalf("partial or failed extraction marked complete: %+v", row)
	}
	if err := fake.db.Model(prop).Update("status", model.DramaJobSucceeded).Error; err != nil {
		t.Fatal(err)
	}
	if row := episodeCompletionRow(t, svc, projectID, second.ID); !row.AssetsReady || row.StoryboardReady || row.VideoReady {
		t.Fatalf("all scoped extractions succeeded with zero assets: %+v", row)
	}
}

func TestDramaEpisodeCompletionKeepsAssetsDuringStoryboardReplacement(t *testing.T) {
	svc, fake, projectID, episode := readyDramaEpisodeForRender(t)
	other := model.DramaEpisode{ID: newID(), ProjectID: projectID, Number: 99, Stage: model.DramaEpisodeScript}
	if err := fake.db.Create(&other).Error; err != nil {
		t.Fatal(err)
	}
	failed := model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: other.ID, Kind: model.DramaJobScript, Status: model.DramaJobFailed}
	if err := fake.db.Create(&failed).Error; err != nil {
		t.Fatal(err)
	}
	if err := resetDramaEpisodeStoryboard(svc.repo, &episode); err != nil {
		t.Fatal(err)
	}
	if row := episodeCompletionRow(t, svc, projectID, episode.ID); !row.AssetsReady || row.StoryboardReady || row.VideoReady {
		t.Fatalf("previous successful arrangement must retain asset completion on replacement: %+v", row)
	}
	if row := episodeCompletionRow(t, svc, projectID, other.ID); row.AssetsReady || row.StoryboardReady || row.VideoReady {
		t.Fatalf("failed arrangement or another episode's success counted as completion: %+v", row)
	}
}

func TestDramaEpisodeCompletionFollowsCurrentVideoSource(t *testing.T) {
	svc, fake, projectID, episode := readyDramaEpisodeForRender(t)
	read := func() DramaEpisodeRow { return episodeCompletionRow(t, svc, projectID, episode.ID) }
	if row := read(); !row.AssetsReady || !row.StoryboardReady || !row.VideoReady {
		t.Fatalf("saved storyboard and ready segment videos = %+v", row)
	}
	shots, rows, _ := adoptedDramaShotVideos(t, svc, fake, projectID, episode.ID)
	if row := read(); !row.VideoReady {
		t.Fatalf("complete adopted shot source = %+v", row)
	}
	if err := fake.db.Model(&model.DramaShot{}).Where("id = ?", shots[0].ID).Update("action", "画面已修改").Error; err != nil {
		t.Fatal(err)
	}
	if row := read(); row.VideoReady || !row.StoryboardReady {
		t.Fatalf("stale chosen shot must not fall back to ready segment videos: %+v", row)
	}
	if err := fake.db.Delete(&rows[0]).Error; err != nil {
		t.Fatal(err)
	}
	if row := read(); row.VideoReady {
		t.Fatalf("incomplete adopted shot source = %+v", row)
	}
	pending := fake.resource("usr-drama", "video", "video/mp4")
	if err := fake.db.Model(&model.Resource{}).Where("id = ?", pending).UpdateColumn("status", model.ResourceStatusPending).Error; err != nil {
		t.Fatal(err)
	}
	for _, final := range []string{"missing-resource", pending, fake.resource("other-user", "video", "video/mp4"), fake.resource("usr-drama", "image", "image/png")} {
		if err := fake.db.Model(&episode).Updates(map[string]any{"final_resource_id": final, "final_stale": false}).Error; err != nil {
			t.Fatal(err)
		}
		if row := read(); row.VideoReady {
			t.Fatalf("unavailable final %s marked video complete: %+v", final, row)
		}
	}
	final := fake.resource("usr-drama", "video", "video/mp4")
	if err := fake.db.Model(&episode).Updates(map[string]any{"final_resource_id": final, "final_stale": false}).Error; err != nil {
		t.Fatal(err)
	}
	if row := read(); !row.VideoReady {
		t.Fatalf("non-stale final is complete: %+v", row)
	}
	if err := fake.db.Model(&episode).UpdateColumn("final_stale", true).Error; err != nil {
		t.Fatal(err)
	}
	if row := read(); row.VideoReady {
		t.Fatalf("stale final marked video complete: %+v", row)
	}
}
