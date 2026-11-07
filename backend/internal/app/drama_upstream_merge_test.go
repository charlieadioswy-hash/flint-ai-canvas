package app

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaDraftSaveCannotReplaceGuideState(t *testing.T) {
	for _, test := range []struct {
		name   string
		step   string
		guided bool
	}{
		{name: "existing-guide", step: model.DramaGuideConfiguring},
		{name: "convert-traditional-draft", guided: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newDramaGuideRevisionFixture(t, test.step)
			projectID := fixture.summary.Project.ID
			_, err := fixture.svc.SaveDramaDraft("usr-drama", projectID, CreateDramaRequest{
				Name: "替换草稿", Guided: test.guided, Brief: "替换创作简述", Settings: fixture.summary.Production.Settings,
				Chapters: []DramaChapterInput{{Title: "替换章节", Text: "替换正文"}},
			})
			if err == nil {
				t.Fatal("traditional draft endpoint must not replace or create guide state")
			}
			stored, err := fixture.svc.repo.DramaProduction(projectID)
			if err != nil || stored.GuideStep != test.step || stored.Revision != fixture.summary.Production.Revision || stored.CreativeBrief != fixture.summary.Production.CreativeBrief {
				t.Fatalf("draft save changed guide state: %+v %v", stored, err)
			}
			chapters, err := fixture.svc.repo.DramaChapters(projectID)
			if err != nil || len(chapters) != 1 || chapters[0].SourceText != "原正文" {
				t.Fatalf("draft save replaced existing source: %+v %v", chapters, err)
			}
		})
	}
}

func TestDramaGuideSegmentReferenceEditsUseSharedRevision(t *testing.T) {
	for _, stale := range []bool{true, false} {
		name := "current"
		if stale {
			name = "stale"
		}
		t.Run(name, func(t *testing.T) {
			fixture := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
			projectID := fixture.summary.Project.ID
			original := map[string]any{
				"reference_cast_ids_json": `["original-cast"]`,
				"reference_images_json":   `[{"resourceId":"original-image","name":"原参考图"}]`,
				"audio_cast_ids_json":     `["original-audio"]`,
			}
			if err := fixture.fake.db.Model(&model.DramaSegment{}).Where("id = ?", fixture.segment.ID).Updates(original).Error; err != nil {
				t.Fatal(err)
			}
			revision := fixture.summary.Production.Revision
			expected := revision
			if stale {
				expected--
			}
			images := []model.DramaReferenceImage{}
			prompt := "新的段提示词"
			err := fixture.svc.UpdateDramaSegment("usr-drama", projectID, fixture.shot.EpisodeID, 0, UpdateDramaSegmentRequest{
				ExpectedRevision: &expected, AutoReferences: true, ReferenceImages: &images, AutoAudioReferences: true, VideoPromptOverride: &prompt,
			})
			if stale {
				requireGuideConflict(t, err)
			} else if err != nil {
				t.Fatal(err)
			}
			segments, err := fixture.svc.repo.DramaSegments(fixture.shot.EpisodeID)
			if err != nil || len(segments) != 1 {
				t.Fatalf("load segment: %+v %v", segments, err)
			}
			stored := segments[0]
			if stale {
				if stored.ReferenceCastIDsJSON != original["reference_cast_ids_json"] || stored.ReferenceImagesJSON != original["reference_images_json"] || stored.AudioCastIDsJSON != original["audio_cast_ids_json"] || stored.VideoPromptOverride != fixture.segment.VideoPromptOverride {
					t.Fatalf("stale edit partially changed references or prompt: %+v", stored)
				}
			} else {
				if stored.ReferenceCastIDsJSON != "" || stored.ReferenceImagesJSON != "[]" || stored.AudioCastIDsJSON != "" || stored.VideoPromptOverride != prompt {
					t.Fatalf("accepted edit did not save all fields: %+v", stored)
				}
				revision++
			}
			production, err := fixture.svc.repo.DramaProduction(projectID)
			if err != nil || production.Revision != revision {
				t.Fatalf("reference edit revision: %+v %v", production, err)
			}
		})
	}
}
