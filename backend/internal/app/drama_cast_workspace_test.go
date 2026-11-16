package app

import (
	"errors"
	"testing"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func TestDramaCastWorkspaceSavesBothGroupsWithoutGenerating(t *testing.T) {
	for _, kind := range []string{"character", "scene", "prop", "look"} {
		t.Run(kind, func(t *testing.T) {
			svc, fake, projectID, _ := dramaStudioFixture(t)
			cast := model.DramaCast{ID: newID(), ProjectID: projectID, Kind: kind, Name: "旧名称", Appearance: "旧外观", ImageStatus: model.DramaMediaDraft}
			if kind == "look" {
				cast.Kind, cast.ParentID, cast.LookName = "character", "base-character", "旧造型"
			}
			if err := svc.repo.CreateDramaCasts([]model.DramaCast{cast}); err != nil {
				t.Fatal(err)
			}
			current, _ := svc.repo.DramaCast(projectID, cast.ID)
			p, _ := svc.repo.DramaProduction(projectID)
			name, appearance, prompt := "新名称", "新的服装与环境", "新的完整图片提示词"
			options := &DramaCastImageOptions{Ratio: "1:1", Resolution: "2k"}
			beforeImages := fake.byKind["image"]
			var saved model.DramaCast
			if kind == "look" {
				result, err := svc.UpdateDramaCastLook("usr-drama", projectID, cast.ID, DramaCastLookRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &current.Revision, ImageOptions: options, LookName: name, Appearance: appearance, ImagePrompt: &prompt})
				if err != nil {
					t.Fatal(err)
				}
				saved = result["look"].(model.DramaCast)
				if saved.LookName != name {
					t.Fatal("look name not saved")
				}
			} else {
				var err error
				saved, err = svc.UpdateDramaCast("usr-drama", projectID, cast.ID, UpdateDramaCastRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &current.Revision, ImageOptions: options, Name: &name, Appearance: &appearance, ImagePrompt: &prompt})
				if err != nil {
					t.Fatal(err)
				}
				if saved.Name != name {
					t.Fatal("name not saved")
				}
			}
			parsed, err := parseDramaCastImageOptions(saved.ImageOptionsJSON)
			if err != nil || parsed.Ratio != "1:1" || saved.Appearance != appearance || saved.ImagePrompt != prompt || saved.Revision != current.Revision+1 {
				t.Fatalf("incomplete unified save: %+v %v", saved, err)
			}
			after, _ := svc.repo.DramaProduction(projectID)
			if after.Revision != p.Revision+1 || fake.byKind["image"] != beforeImages || saved.ImageStatus != model.DramaMediaDraft {
				t.Fatal("save generated media or changed revisions twice")
			}
		})
	}
}

func TestDramaCastWorkspaceInvalidOptionsAndBothRevisionConflictsKeepAllFields(t *testing.T) {
	svc, fake, projectID, _ := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	cast := casts[0]
	p, _ := svc.repo.DramaProduction(projectID)
	name := "不应保存的名称"
	foreign := fake.resource("other-user", "image", "image/png")
	wrong := cast.Revision + 1
	wrongProject := p.Revision + 1
	for _, req := range []UpdateDramaCastRequest{
		{ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, Name: &name, ImageOptions: &DramaCastImageOptions{Ratio: "7:19"}},
		{ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, Name: &name, ImageOptions: &DramaCastImageOptions{SubjectReferenceIDs: []string{foreign}}},
		{ExpectedRevision: &p.Revision, ExpectedCastRevision: &wrong, Name: &name, ImageOptions: &DramaCastImageOptions{Ratio: "1:1"}},
		{ExpectedRevision: &wrongProject, ExpectedCastRevision: &cast.Revision, Name: &name, ImageOptions: &DramaCastImageOptions{Ratio: "1:1"}},
		{Name: &name, ImageOptions: &DramaCastImageOptions{Ratio: "1:1"}},
	} {
		if _, err := svc.UpdateDramaCast("usr-drama", projectID, cast.ID, req); err == nil {
			t.Fatal("invalid unified save accepted")
		}
		current, _ := svc.repo.DramaCast(projectID, cast.ID)
		after, _ := svc.repo.DramaProduction(projectID)
		if current.Name != cast.Name || current.ImageOptionsJSON != cast.ImageOptionsJSON || current.Revision != cast.Revision || after.Revision != p.Revision {
			t.Fatal("failed validation partially saved fields")
		}
	}
}

func TestDramaCastWorkspaceLateWriteFailureRollsBackBothGroups(t *testing.T) {
	svc, fake, projectID, _ := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	cast := casts[0]
	p, _ := svc.repo.DramaProduction(projectID)
	name := "事务中途的新名称"
	if err := fake.db.Callback().Update().Before("gorm:update").Register("workspace-production-failure", func(tx *gorm.DB) {
		if tx.Statement.Table == "drama_productions" {
			tx.AddError(errors.New("injected final revision failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = fake.db.Callback().Update().Remove("workspace-production-failure") })
	if _, err := svc.UpdateDramaCast("usr-drama", projectID, cast.ID, UpdateDramaCastRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, Name: &name, ImageOptions: &DramaCastImageOptions{Ratio: "1:1"}}); err == nil {
		t.Fatal("late write failure ignored")
	}
	current, _ := svc.repo.DramaCast(projectID, cast.ID)
	after, _ := svc.repo.DramaProduction(projectID)
	if current.Name != cast.Name || current.ImageOptionsJSON != cast.ImageOptionsJSON || current.Revision != cast.Revision || after.Revision != p.Revision {
		t.Fatal("late failure left partial settings or revision")
	}
}

func TestDramaCastWorkspaceOptionsOnlyDoesNotInvalidateTextPrompts(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	cast := casts[0]
	p, _ := svc.repo.DramaProduction(projectID)
	if err := fake.db.Model(&model.DramaSegment{}).Where("episode_id = ?", detail.Episode.ID).Update("prompt_status", model.DramaMediaReady).Error; err != nil {
		t.Fatal(err)
	}
	before, _ := svc.repo.DramaSegments(detail.Episode.ID)
	if _, err := svc.UpdateDramaCast("usr-drama", projectID, cast.ID, UpdateDramaCastRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, Name: &cast.Name, Appearance: &cast.Appearance, ImageOptions: &DramaCastImageOptions{Ratio: "1:1"}}); err != nil {
		t.Fatal(err)
	}
	after, _ := svc.repo.DramaSegments(detail.Episode.ID)
	for index := range before {
		if after[index].PromptStatus != before[index].PromptStatus || after[index].Revision != before[index].Revision {
			t.Fatal("image options-only save invalidated text prompts")
		}
	}
}

func TestDramaCastWorkspaceOnlyActualTextChangesRewindGuide(t *testing.T) {
	svc, fake, projectID, _ := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	cast := casts[0]
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("guide_step", model.DramaGuideStory).Error; err != nil {
		t.Fatal(err)
	}
	p, _ := svc.repo.DramaProduction(projectID)
	options := &DramaCastImageOptions{Ratio: "1:1"}
	updated, err := svc.UpdateDramaCast("usr-drama", projectID, cast.ID, UpdateDramaCastRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, Name: &cast.Name, Appearance: &cast.Appearance, ImagePrompt: &cast.ImagePrompt, ImageOptions: options})
	if err != nil {
		t.Fatal(err)
	}
	after, _ := svc.repo.DramaProduction(projectID)
	if after.GuideStep != model.DramaGuideStory {
		t.Fatal("image-only change rewound guide despite equal text fields")
	}
	name := cast.Name + "新版本"
	if _, err := svc.UpdateDramaCast("usr-drama", projectID, cast.ID, UpdateDramaCastRequest{ExpectedRevision: &after.Revision, ExpectedCastRevision: &updated.Revision, Name: &name, ImageOptions: options}); err != nil {
		t.Fatal(err)
	}
	rewound, _ := svc.repo.DramaProduction(projectID)
	if rewound.GuideStep != model.DramaGuideAssets {
		t.Fatal("actual text change did not rewind guide")
	}
}
