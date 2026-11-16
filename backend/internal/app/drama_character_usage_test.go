package app

import (
	"reflect"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaAssetUsageReadsScenesAndPropsByTheirActualShotFields(t *testing.T) {
	for _, kind := range []string{"scene", "prop"} {
		t.Run(kind, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			summary := createGuidedDrama(t, svc, DramaChapterInput{Title: "原文", Text: "旧物在旧宅出现；这里只是文字提及。"})
			projectID := summary.Project.ID
			cast := model.DramaCast{ID: "usage-asset", ProjectID: projectID, Kind: kind, Name: "旧物", Description: "旧宅中的旧物"}
			if err := fake.db.Create(&cast).Error; err != nil {
				t.Fatal(err)
			}
			empty, err := svc.DramaCharacterUsage("usr-drama", projectID, cast.ID)
			if err != nil || empty.HasStory || empty.Appearances == nil || len(empty.Appearances) != 0 || empty.ImageReferences == nil || len(empty.ImageReferences) != 0 || empty.AudioReferences == nil || len(empty.AudioReferences) != 0 {
				t.Fatalf("prose cannot imply appearances or references: %+v %v", empty, err)
			}
			episodes := []model.DramaEpisode{{ID: "usage-later", ProjectID: projectID, Number: 3, Title: "重逢"}, {ID: "usage-earlier", ProjectID: projectID, Number: 2, Title: "初见"}}
			if err := fake.db.Create(&episodes).Error; err != nil {
				t.Fatal(err)
			}
			shots := []model.DramaShot{
				{ID: "later-visible", ProjectID: projectID, EpisodeID: episodes[0].ID, Position: 3, SegmentIndex: 2},
				{ID: "earlier-visible", ProjectID: projectID, EpisodeID: episodes[1].ID, Position: 1, SegmentIndex: 0},
				{ID: "wrong-type-fields", ProjectID: projectID, EpisodeID: episodes[0].ID, Position: 4, SceneCastID: cast.ID, CastIDsJSON: encodeStringList([]string{cast.ID}), LookCastIDsJSON: encodeStringList([]string{cast.ID}), PropIDsJSON: encodeStringList([]string{cast.ID})},
				{ID: "name-only", ProjectID: projectID, EpisodeID: episodes[0].ID, Position: 5, Scene: cast.Name, Speaker: cast.Name, Dialogue: cast.Name, Action: cast.Name},
				{ID: "similar-id", ProjectID: projectID, EpisodeID: episodes[0].ID, Position: 6, SceneCastID: cast.ID + "-other", PropIDsJSON: encodeStringList([]string{cast.ID + "-other"})},
				{ID: "other-project", ProjectID: "other-project", EpisodeID: episodes[0].ID, Position: 7, SceneCastID: cast.ID, PropIDsJSON: encodeStringList([]string{cast.ID})},
			}
			for index := range 2 {
				if kind == "scene" {
					shots[index].SceneCastID = cast.ID
				} else {
					shots[index].PropIDsJSON = encodeStringList([]string{cast.ID, cast.ID})
				}
			}
			if kind == "scene" {
				shots[2].SceneCastID = "another-scene"
			} else {
				shots[2].PropIDsJSON = "[]"
			}
			if err := fake.db.Create(&shots).Error; err != nil {
				t.Fatal(err)
			}
			segments := []model.DramaSegment{
				{ID: "image-reference", ProjectID: projectID, EpisodeID: episodes[0].ID, SegmentIndex: 2, ReferenceCastIDsJSON: encodeStringList([]string{cast.ID, cast.ID})},
				{ID: "unrelated-reference", ProjectID: projectID, EpisodeID: episodes[0].ID, SegmentIndex: 3, ReferenceCastIDsJSON: encodeStringList([]string{cast.ID + "-other"}), AudioCastIDsJSON: `["other-character"]`},
			}
			if err := fake.db.Create(&segments).Error; err != nil {
				t.Fatal(err)
			}
			usage, err := svc.DramaCharacterUsage("usr-drama", projectID, cast.ID)
			wantAppearances := []DramaCharacterAppearance{
				{EpisodeID: episodes[1].ID, EpisodeNumber: 2, EpisodeTitle: "初见", ShotID: "earlier-visible", Position: 1, SegmentIndex: 0},
				{EpisodeID: episodes[0].ID, EpisodeNumber: 3, EpisodeTitle: "重逢", ShotID: "later-visible", Position: 3, SegmentIndex: 2},
			}
			wantImages := []DramaCharacterSegmentReference{{EpisodeID: episodes[0].ID, EpisodeNumber: 3, SegmentID: "image-reference", SegmentIndex: 2}}
			if err != nil || !usage.HasStory || !reflect.DeepEqual(usage.Appearances, wantAppearances) || !reflect.DeepEqual(usage.ImageReferences, wantImages) || len(usage.AudioReferences) != 0 {
				t.Fatalf("usage must use only exact IDs in the kind's actual fields: %+v %v", usage, err)
			}
			unused := model.DramaCast{ID: "unused", ProjectID: projectID, Kind: kind, Name: cast.Name}
			if err := fake.db.Create(&unused).Error; err != nil {
				t.Fatal(err)
			}
			unseen, err := svc.DramaCharacterUsage("usr-drama", projectID, unused.ID)
			if err != nil || !unseen.HasStory || len(unseen.Appearances) != 0 || len(unseen.ImageReferences) != 0 || len(unseen.AudioReferences) != 0 {
				t.Fatalf("same-name assets must not share appearances: %+v %v", unseen, err)
			}
			current, err := svc.repo.DramaProduction(projectID)
			if err != nil || current.Revision != summary.Production.Revision || current.GuideStep != summary.Production.GuideStep || len(fake.requests) != 0 {
				t.Fatalf("usage must not change the workflow or dispatch tasks: %+v %v", current, err)
			}
		})
	}
}

func TestDramaAssetUsageProtectsOwnershipAndBaseAssetBoundary(t *testing.T) {
	svc, fake := newDramaTestService(t)
	summary := createGuidedDrama(t, svc)
	projectID := summary.Project.ID
	for _, cast := range []model.DramaCast{
		{ID: "character-base", ProjectID: projectID, Kind: "character", Name: "角色"},
		{ID: "scene-base", ProjectID: projectID, Kind: "scene", Name: "场景"},
		{ID: "prop-base", ProjectID: projectID, Kind: "prop", Name: "道具"},
		{ID: "character-look", ProjectID: projectID, Kind: "character", ParentID: "character-base", Name: "角色造型"},
		{ID: "invalid-kind", ProjectID: projectID, Kind: "environment", Name: "无效类型"},
		{ID: "foreign-cast", ProjectID: "foreign-project", Kind: "scene", Name: "其他作品场景"},
	} {
		if err := fake.db.Create(&cast).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"character-base", "scene-base", "prop-base"} {
		if _, err := svc.DramaCharacterUsage("usr-drama", projectID, id); err != nil {
			t.Fatalf("base asset must support usage reads: %s %v", id, err)
		}
		if _, err := svc.DramaCharacterUsage("other-user", projectID, id); err == nil {
			t.Fatalf("another account must not read asset usage: %s", id)
		}
	}
	for _, id := range []string{"character-look", "invalid-kind"} {
		if _, err := svc.DramaCharacterUsage("usr-drama", projectID, id); !isAppErrorStatus(err, 400) {
			t.Fatalf("non-base asset should be rejected: %s %v", id, err)
		}
	}
	for _, id := range []string{"foreign-cast", "missing-cast"} {
		if _, err := svc.DramaCharacterUsage("usr-drama", projectID, id); !isAppErrorStatus(err, 404) {
			t.Fatalf("asset lookup must stay in the current project: %s %v", id, err)
		}
	}
}
