package app

import (
	"encoding/json"
	"testing"

	"yingce/backend/internal/model"
)

func TestCloudAgentDramaMediaProposalTargetsCurrentObjectWithoutEnqueue(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc)
	projectID := draft.Project.ID
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("guide_step", model.DramaGuideCompleted).Error; err != nil {
		t.Fatal(err)
	}
	for _, row := range []any{
		&model.DramaCast{ID: "cast-current", ProjectID: projectID, Revision: 3, Kind: "character", Name: "主角"},
		&model.DramaCast{ID: "cast-new", ProjectID: projectID, Kind: "prop", Name: "尚未生成"},
		&model.DramaCast{ID: "cast-foreign", ProjectID: "other-project", Revision: 3, Kind: "character", Name: "其他作品"},
		&model.DramaSegment{ID: "segment-current", ProjectID: projectID, EpisodeID: "episode-current", SegmentIndex: 0, Revision: 4},
		&model.DramaSegment{ID: "segment-foreign", ProjectID: "other-project", EpisodeID: "episode-other", Revision: 4},
	} {
		if err := fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	state := &cloudAgentRuntime{Request: CloudAgentRequest{DramaProjectID: projectID}}
	contextCall := cloudAgentCall{ID: "read"}
	contextCall.Function.Arguments = `{}`
	context, err := cloudAgentHandleDramaGetContext(svc.repo, "usr-drama", state, contextCall, svc)
	if err != nil {
		t.Fatal(err)
	}
	castViews := context.(map[string]any)["casts"].([]map[string]any)
	seenInitial := false
	for _, cast := range castViews {
		if cast["id"] == "cast-new" {
			seenInitial = cast["revision"] == int64(0)
		}
	}
	if !seenInitial {
		t.Fatal("current context omitted the real initial asset version")
	}
	propose := func(userID, target string, revision int64, changes map[string]any) error {
		body, err := json.Marshal(cloudAgentDramaProposal{Kind: "media", TargetID: target, BaseRevision: revision, Changes: changes})
		if err != nil {
			t.Fatal(err)
		}
		call := cloudAgentCall{ID: "media"}
		call.Function.Arguments = string(body)
		_, err = cloudAgentHandleDramaProposeChanges(svc.repo, userID, state, call, svc)
		return err
	}
	for _, action := range []string{"segment_video", "segment_prompt", "segment_reprocess"} {
		if err := propose("usr-drama", "segment-current", draft.Production.Revision, map[string]any{"action": action, "episodeId": "episode-current", "targetRevision": 4}); err != nil {
			t.Fatalf("%s: %v", action, err)
		}
	}
	if err := propose("usr-drama", "cast-current", draft.Production.Revision, map[string]any{"action": "cast_image", "targetRevision": 3}); err != nil {
		t.Fatal(err)
	}
	if err := propose("usr-drama", "cast-new", draft.Production.Revision, map[string]any{"action": "cast_image", "targetRevision": 0}); err != nil {
		t.Fatalf("initial asset revision zero rejected: %v", err)
	}
	for _, tc := range []struct {
		name, user, target string
		revision           int64
		changes            map[string]any
	}{
		{"stale production", "usr-drama", "segment-current", draft.Production.Revision + 1, map[string]any{"action": "segment_video", "episodeId": "episode-current", "targetRevision": 4}},
		{"stale target", "usr-drama", "segment-current", draft.Production.Revision, map[string]any{"action": "segment_video", "episodeId": "episode-current", "targetRevision": 3}},
		{"wrong episode", "usr-drama", "segment-current", draft.Production.Revision, map[string]any{"action": "segment_video", "episodeId": "episode-other", "targetRevision": 4}},
		{"missing episode", "usr-drama", "segment-current", draft.Production.Revision, map[string]any{"action": "segment_video", "targetRevision": 4}},
		{"foreign target", "usr-drama", "segment-foreign", draft.Production.Revision, map[string]any{"action": "segment_video", "episodeId": "episode-other", "targetRevision": 4}},
		{"foreign cast", "usr-drama", "cast-foreign", draft.Production.Revision, map[string]any{"action": "cast_image", "targetRevision": 3}},
		{"foreign user", "other-user", "cast-current", draft.Production.Revision, map[string]any{"action": "cast_image", "targetRevision": 3}},
		{"invalid action", "usr-drama", "cast-current", draft.Production.Revision, map[string]any{"action": "release_all", "targetRevision": 3}},
		{"no target version", "usr-drama", "cast-current", draft.Production.Revision, map[string]any{"action": "cast_image"}},
		{"fraction target version", "usr-drama", "cast-current", draft.Production.Revision, map[string]any{"action": "cast_image", "targetRevision": 3.5}},
		{"arbitrary scope", "usr-drama", "cast-current", draft.Production.Revision, map[string]any{"action": "cast_image", "targetRevision": 3, "castIds": []string{"cast-foreign"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := propose(tc.user, tc.target, tc.revision, tc.changes); err == nil {
				t.Fatal("invalid media proposal accepted")
			}
		})
	}
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("guide_step", model.DramaGuideStory).Error; err != nil {
		t.Fatal(err)
	}
	if err := propose("usr-drama", "cast-current", draft.Production.Revision, map[string]any{"action": "cast_image", "targetRevision": 3}); err == nil {
		t.Fatal("guide proposed media before completing text")
	}
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("guide_step", "").Error; err != nil {
		t.Fatal(err)
	}
	if err := propose("usr-drama", "cast-new", draft.Production.Revision, map[string]any{"action": "cast_image", "targetRevision": 0}); err != nil {
		t.Fatalf("legacy production rejected media proposal: %v", err)
	}
	if len(fake.requests) != 0 {
		t.Fatal("proposal submitted generation")
	}
	var jobs int64
	if err := fake.db.Model(&model.DramaJob{}).Where("project_id = ?", projectID).Count(&jobs).Error; err != nil || jobs != 0 {
		t.Fatalf("proposal enqueued jobs: %d %v", jobs, err)
	}
}
