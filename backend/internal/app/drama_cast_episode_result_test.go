package app

import (
	"encoding/json"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

func TestDramaCastImageResultUsesSubmittedOrEpisodeRatio(t *testing.T) {
	for _, tc := range []struct {
		name, episodeRatio, overrideRatio, snapshotRatio string
		width, height                                    int
		wantFailure                                      bool
	}{
		{name: "episode fallback", episodeRatio: "16:9", width: 1920, height: 1080},
		{name: "snapshot before settings change", episodeRatio: "1:1", overrideRatio: "3:4", snapshotRatio: "16:9", width: 1920, height: 1080},
		{name: "explicit cast override", episodeRatio: "16:9", overrideRatio: "1:1", width: 1024, height: 1024},
		{name: "reject incorrect output", episodeRatio: "3:4", snapshotRatio: "16:9", width: 768, height: 1024, wantFailure: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			projectID := newDramaMaterialProject(t, svc, "图片回写画幅")
			cast := createDramaMaterial(t, svc, projectID, "character", "角色")
			project, p, err := svc.dramaForUser("usr-drama", projectID)
			if err != nil {
				t.Fatal(err)
			}
			defaults := parseDramaSettings(p.SettingsJSON)
			defaults.Assets = production.AssetSettings{Mode: "custom", CharacterRatio: "3:4"}
			settings := defaults
			settings.Assets.CharacterRatio = tc.episodeRatio
			episode := model.DramaEpisode{ID: newID(), ProjectID: projectID, Number: 1, Stage: model.DramaEpisodeQueued, SettingsJSON: encodeDramaSettings(settings), Revision: 1}
			if err := fake.db.Create(&episode).Error; err != nil {
				t.Fatal(err)
			}
			cast.ImageStatus, cast.ImageEpisodeID = model.DramaMediaRunning, episode.ID
			options, _ := json.Marshal(DramaCastImageOptions{Ratio: tc.overrideRatio})
			cast.ImageOptionsJSON = string(options)
			if err := fake.db.Save(&cast).Error; err != nil {
				t.Fatal(err)
			}
			resourceID := fake.resourceSized("usr-drama", "image", "image/png", tc.width, tc.height)
			result, _ := json.Marshal(map[string]any{"images": []any{map[string]any{"resourceId": resourceID}}})
			input, _ := json.Marshal(map[string]any{"metadata": map[string]any{"assetRatio": tc.snapshotRatio}})
			task := &model.Task{ID: newID(), ResultJSON: string(result), InputJSON: string(input)}
			job := &model.DramaJob{Kind: model.DramaJobCastImage, CastID: cast.ID, EpisodeID: episode.ID, PayloadJSON: encodeDramaRevision(cast.Revision)}
			run := &dramaRun{s: svc, project: project, production: p, settings: defaults}
			err = run.applyCastImage(job, task)
			if tc.wantFailure != (err != nil) {
				t.Fatalf("ratio validation: wantFailure=%v, err=%v", tc.wantFailure, err)
			}
			after, err := svc.repo.DramaCast(projectID, cast.ID)
			if err != nil {
				t.Fatal(err)
			}
			if !tc.wantFailure && (after.ImageResourceID != resourceID || after.ImageStatus != model.DramaMediaReady) {
				t.Fatalf("correct result was not adopted: %+v", after)
			}
			if tc.wantFailure && after.ImageResourceID != "" {
				t.Fatal("incorrect result became current")
			}
			takes, err := svc.repo.DramaTakes(projectID, cast.ID, "cast", 100)
			if err != nil || len(takes) != 1 || takes[0].ResourceID != resourceID {
				t.Fatalf("paid result must stay in history: %+v, %v", takes, err)
			}
		})
	}
}

func TestDramaCastRegeneratePreservesActiveEpisodeRequest(t *testing.T) {
	for _, status := range []string{model.DramaJobQueued, model.DramaJobRunning} {
		t.Run(status, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			projectID := newDramaMaterialProject(t, svc, "保留排队来源")
			cast := createDramaMaterial(t, svc, projectID, "character", "角色")
			episodes := []model.DramaEpisode{
				{ID: newID(), ProjectID: projectID, Number: 1, Stage: model.DramaEpisodeQueued, Revision: 1},
				{ID: newID(), ProjectID: projectID, Number: 2, Stage: model.DramaEpisodeQueued, Revision: 1},
			}
			if err := fake.db.Create(&episodes).Error; err != nil {
				t.Fatal(err)
			}
			cast.ImageStatus, cast.ImageEpisodeID = status, episodes[0].ID
			if err := fake.db.Save(&cast).Error; err != nil {
				t.Fatal(err)
			}
			job := model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: episodes[0].ID, CastID: cast.ID, Kind: model.DramaJobCastImage, Status: status, PayloadJSON: encodeDramaRevision(cast.Revision)}
			if err := fake.db.Create(&job).Error; err != nil {
				t.Fatal(err)
			}
			if _, err := svc.RegenerateDramaCast("usr-drama", projectID, cast.ID, true, episodes[1].ID); !isAppErrorStatus(err, 409) {
				t.Fatalf("active request must reject cross-episode regeneration: %v", err)
			}
			after, _ := svc.repo.DramaCast(projectID, cast.ID)
			jobs, err := svc.repo.DramaJobsByStatus(projectID, status)
			if err != nil || len(jobs) != 1 || jobs[0].EpisodeID != episodes[0].ID || jobs[0].PayloadJSON != job.PayloadJSON || after.Revision != cast.Revision || after.ImageEpisodeID != episodes[0].ID || after.ImageStatus != cast.ImageStatus {
				t.Fatalf("rejected request changed existing work: cast=%+v jobs=%+v err=%v", after, jobs, err)
			}
			if len(fake.requests) != 0 {
				t.Fatal("rejected request called a model")
			}
		})
	}
}

func TestDramaCastDispatchSkipsMismatchedEpisodeContext(t *testing.T) {
	svc, fake := newDramaTestService(t)
	projectID := newDramaMaterialProject(t, svc, "拒绝旧作业来源")
	cast := createDramaMaterial(t, svc, projectID, "character", "角色")
	cast.ImageStatus, cast.ImageEpisodeID = model.DramaMediaQueued, "new-episode"
	if err := fake.db.Save(&cast).Error; err != nil {
		t.Fatal(err)
	}
	project, p, _ := svc.dramaForUser("usr-drama", projectID)
	run := &dramaRun{s: svc, project: project, production: p, settings: parseDramaSettings(p.SettingsJSON)}
	job := &model.DramaJob{Kind: model.DramaJobCastImage, CastID: cast.ID, EpisodeID: "old-episode", PayloadJSON: encodeDramaRevision(cast.Revision - 1)}
	task, skip, err := run.submit(job)
	if err != nil || !skip || task != nil || len(fake.requests) != 0 || job.PayloadJSON != encodeDramaRevision(cast.Revision-1) {
		t.Fatalf("old context must not bind current revision or call a model: task=%+v skip=%v err=%v", task, skip, err)
	}
}
