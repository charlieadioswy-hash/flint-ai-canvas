package app

import (
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/platform"
)

func TestDramaCastImportGuidedAssetsKeepsStageAndAdvancesRevision(t *testing.T) {
	for _, step := range []string{model.DramaGuideAssets, model.DramaGuideStory} {
		t.Run(step, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			svc.coordinator = platform.NewCoordinatorWithRedis(nil, t.Name())
			source := newDramaMaterialProject(t, svc, "资产来源")
			scene := createDramaMaterial(t, svc, source, "scene", "办公室")
			scene.ImageResourceID, scene.ImageStatus = fake.resource("usr-drama", "image", "image/png"), model.DramaMediaReady
			if err := fake.db.Save(&scene).Error; err != nil {
				t.Fatal(err)
			}
			prop := createDramaMaterial(t, svc, source, "prop", "怀表")
			target := createGuidedDrama(t, svc, DramaChapterInput{Title: "第一章", Text: "办公室里有一块怀表"}).Project.ID
			if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", target).Update("guide_step", step).Error; err != nil {
				t.Fatal(err)
			}
			before, _ := svc.repo.DramaProduction(target)
			sourceBefore, _ := svc.repo.DramaProduction(source)
			result, err := svc.ImportDramaCast("usr-drama", target, ImportDramaCastRequest{SourceProjectID: source, CastIDs: []string{scene.ID, prop.ID}})
			if err != nil || result.Imported != 2 || result.Skipped != 0 || len(result.Cast) != 2 {
				t.Fatalf("guided import failed: %+v %v", result, err)
			}
			after, _ := svc.repo.DramaProduction(target)
			if after.Revision != before.Revision+1 || after.GuideStep != step || after.Stage != before.Stage || after.Status != before.Status {
				t.Fatalf("import changed guide state or lost its revision: before=%+v after=%+v", before, after)
			}
			copied := result.Cast[0]
			if copied.Kind != "scene" || copied.SourceCastID != scene.ID || copied.ImageResourceID != scene.ImageResourceID || copied.Appearance != scene.Appearance || !copied.Locked || copied.ImageStatus != model.DramaMediaReady {
				t.Fatalf("scene definition or image was lost: %+v", copied)
			}
			if result.Cast[1].Kind != "prop" || result.Cast[1].SourceCastID != prop.ID || result.Cast[1].ImageStatus != model.DramaMediaDraft {
				t.Fatalf("prop draft was not copied independently: %+v", result.Cast[1])
			}
			takes, err := svc.repo.DramaTakes(target, copied.ID, "cast", 100)
			if err != nil || len(takes) != 1 || takes[0].ResourceID != scene.ImageResourceID {
				t.Fatalf("image history not copied atomically: %+v %v", takes, err)
			}
			sourceAfter, _ := svc.repo.DramaProduction(source)
			savedScene, _ := svc.repo.DramaCast(source, scene.ID)
			if sourceAfter.Revision != sourceBefore.Revision || savedScene.ImageResourceID != scene.ImageResourceID || savedScene.Name != scene.Name {
				t.Fatal("import changed the source project")
			}
			jobs, err := svc.repo.RecentDramaJobs(target, 100)
			if err != nil || len(jobs) != 0 || len(fake.requests) != 0 {
				t.Fatalf("import unexpectedly queued or generated content: %+v %v", jobs, err)
			}
			name := "过期的修改"
			_, err = svc.UpdateDramaCast("usr-drama", target, copied.ID, UpdateDramaCastRequest{ExpectedRevision: &before.Revision, Name: &name})
			requireGuideConflict(t, err)
		})
	}
}

func TestDramaCastImportGuidedAssetsRejectsActiveTextJobs(t *testing.T) {
	for _, step := range []string{model.DramaGuideAssets, model.DramaGuideStory} {
		for _, status := range []string{model.DramaJobQueued, model.DramaJobRunning} {
			t.Run(step+"/"+status, func(t *testing.T) {
				svc, fake := newDramaTestService(t)
				svc.coordinator = platform.NewCoordinatorWithRedis(nil, t.Name())
				source := newDramaMaterialProject(t, svc, "资产来源")
				prop := createDramaMaterial(t, svc, source, "prop", "怀表")
				target := createGuidedDrama(t, svc, DramaChapterInput{Title: "第一章", Text: "正文"}).Project.ID
				if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", target).Update("guide_step", step).Error; err != nil {
					t.Fatal(err)
				}
				if err := fake.db.Create(&model.DramaJob{ID: newID(), ProjectID: target, Kind: model.DramaJobScript, Status: status}).Error; err != nil {
					t.Fatal(err)
				}
				before, _ := svc.repo.DramaProduction(target)
				_, err := svc.ImportDramaCast("usr-drama", target, ImportDramaCastRequest{SourceProjectID: source, CastIDs: []string{prop.ID}})
				requireGuideConflict(t, err)
				after, _ := svc.repo.DramaProduction(target)
				casts, err := svc.repo.DramaCasts(target)
				if err != nil || after.Revision != before.Revision || after.GuideStep != step || len(casts) != 0 {
					t.Fatalf("busy import changed target: %+v %+v %v", after, casts, err)
				}
			})
		}
	}
}

func TestDramaCastImportGuidedBusyImageRollsBackEarlierWrites(t *testing.T) {
	svc, fake := newDramaTestService(t)
	svc.coordinator = platform.NewCoordinatorWithRedis(nil, t.Name())
	source := newDramaMaterialProject(t, svc, "资产来源")
	scene := createDramaMaterial(t, svc, source, "scene", "办公室")
	prop := createDramaMaterial(t, svc, source, "prop", "怀表")
	prop.ImageResourceID, prop.ImageStatus = fake.resource("usr-drama", "image", "image/png"), model.DramaMediaReady
	if err := fake.db.Save(&prop).Error; err != nil {
		t.Fatal(err)
	}
	target := newDramaMaterialProject(t, svc, "首次资产")
	busyScene := createDramaMaterial(t, svc, target, "scene", scene.Name)
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", target).Update("guide_step", model.DramaGuideAssets).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(&busyScene).Update("image_status", model.DramaMediaRunning).Error; err != nil {
		t.Fatal(err)
	}
	before, _ := svc.repo.DramaProduction(target)
	_, err := svc.ImportDramaCast("usr-drama", target, ImportDramaCastRequest{SourceProjectID: source, CastIDs: []string{prop.ID, scene.ID}, MatchByName: true})
	requireGuideConflict(t, err)
	after, _ := svc.repo.DramaProduction(target)
	casts, err := svc.repo.DramaCasts(target)
	if err != nil || len(casts) != 1 || casts[0].ID != busyScene.ID || casts[0].SourceCastID != "" || after.Revision != before.Revision {
		t.Fatalf("failed batch left imported assets or revision: %+v %+v %v", after, casts, err)
	}
	var takes int64
	if err := fake.db.Model(&model.DramaTake{}).Where("project_id = ?", target).Count(&takes).Error; err != nil || takes != 0 {
		t.Fatalf("failed batch left image history: %d %v", takes, err)
	}
}
