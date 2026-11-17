package app

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

func TestDramaAssetExtractionMergesEpisodeMembershipAcrossKindsAndExistingAssets(t *testing.T) {
	svc, fake, source := newDramaExtractionSource(t, model.DramaGuideAssets, model.DramaStatusPaused)
	connection, err := fake.db.DB()
	if err != nil {
		t.Fatal(err)
	}
	connection.SetMaxOpenConns(1)
	projectID, episodeID := source.Project.ID, source.Episodes[1].ID
	for _, cast := range []model.DramaCast{
		{ID: "kept", ProjectID: projectID, Kind: "prop", Name: "手工关联的道具"},
		{ID: "existing-character", ProjectID: projectID, Kind: "character", Name: "炎帝", AliasesJSON: `["萧炎"]`, Description: "手工角色说明"},
		{ID: "existing-scene", ProjectID: projectID, Kind: "scene", Name: "萧家大厅", Description: "手工场景说明"},
		{ID: "existing-prop", ProjectID: projectID, Kind: "prop", Name: "退婚书", Description: "手工道具说明"},
	} {
		if err := fake.db.Create(&cast).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", episodeID).UpdateColumn("asset_ids_json", `["kept"]`).Error; err != nil {
		t.Fatal(err)
	}
	before, _ := svc.repo.DramaEpisode(projectID, episodeID)
	for _, kind := range []string{"character", "scene", "prop"} {
		if _, err := svc.ExtractDramaAssets("usr-drama", projectID, ExtractDramaAssetsRequest{ExpectedRevision: source.Production.Revision, Kind: kind, EpisodeIDs: []string{episodeID}}); err != nil {
			t.Fatal(err)
		}
	}
	runDramaTicks(t, svc, projectID, 1)
	jobs, _ := svc.repo.DramaAssetExtractionJobs(projectID, model.DramaJobRunning)
	if len(jobs) != 3 {
		t.Fatalf("three type jobs must run: %+v", jobs)
	}
	p, _ := svc.repo.DramaProduction(projectID)
	project, _ := svc.repo.ProjectForUser("usr-drama", projectID)
	outcomes := make(chan error, len(jobs))
	for _, job := range jobs {
		task, err := svc.repo.Task(job.TaskID)
		if err != nil {
			t.Fatal(err)
		}
		go func() {
			run := &dramaRun{s: svc, production: p, project: project, settings: parseDramaSettings(p.SettingsJSON)}
			outcomes <- run.applyBibleJob(&job, task)
		}()
	}
	var applyErr error
	for range jobs {
		if err := <-outcomes; err != nil {
			applyErr = err
		}
	}
	if applyErr != nil {
		t.Fatal(applyErr)
	}
	// 回收任务时重放已保存结果也不能增加重复关联。
	runDramaTicks(t, svc, projectID, 1)
	after, _ := svc.repo.DramaEpisode(projectID, episodeID)
	ids := decodeStringList(after.AssetIDsJSON)
	seen := map[string]bool{}
	for _, id := range ids {
		seen[id] = true
	}
	if len(ids) != 5 || !seen["kept"] || !seen["existing-character"] || !seen["existing-scene"] || !seen["existing-prop"] || after.Revision != before.Revision {
		t.Fatalf("all kinds and existing matches must persist without replacing previous membership: %+v", after)
	}
	casts, _ := svc.repo.DramaCasts(projectID)
	if len(casts) != 5 {
		t.Fatalf("existing names and aliases must resolve to existing assets: %+v", casts)
	}
	for _, cast := range casts {
		if !seen[cast.ID] {
			t.Fatalf("new extracted asset is not linked: %+v", cast)
		}
	}
	other, _ := svc.repo.DramaEpisode(projectID, source.Episodes[0].ID)
	p, _ = svc.repo.DramaProduction(projectID)
	if other.AssetIDsJSON != "" || p.Revision != source.Production.Revision {
		t.Fatalf("membership must stay with the selected episode without changing inputs: other=%+v production=%+v", other, p)
	}
	detail, err := svc.DramaEpisodeDetail("usr-drama", projectID, episodeID)
	if err != nil || detail.Episode.AssetIDsJSON != after.AssetIDsJSON {
		t.Fatalf("episode detail must expose persisted membership: %+v %v", detail, err)
	}
}

func TestDramaAssetExtractionLinksOnlyReturnedCharacterLooks(t *testing.T) {
	for _, ambiguous := range []bool{false, true} {
		t.Run(map[bool]string{false: "unique-existing-look", true: "ambiguous-existing-look"}[ambiguous], func(t *testing.T) {
			svc, fake, source := newDramaExtractionSource(t, model.DramaGuideAssets, model.DramaStatusPaused)
			projectID, episodeID := source.Project.ID, source.Episodes[0].ID
			casts := []model.DramaCast{
				{ID: "hero", ProjectID: projectID, Kind: "character", Name: "萧炎"},
				{ID: "night", ProjectID: projectID, Kind: "character", ParentID: "hero", Name: "萧炎", LookName: "夜行装", Appearance: "黑衣"},
				{ID: "unrequested", ProjectID: projectID, Kind: "character", ParentID: "hero", Name: "萧炎", LookName: "常服", Appearance: "蓝衣"},
			}
			if ambiguous {
				casts = append(casts, model.DramaCast{ID: "second-night", ProjectID: projectID, Kind: "character", ParentID: "hero", Name: "萧炎", LookName: " 夜行装 ", Appearance: "另一套黑衣"})
			}
			if err := fake.db.Create(&casts).Error; err != nil {
				t.Fatal(err)
			}
			chapters, _ := svc.repo.DramaChapters(projectID)
			payload, _ := json.Marshal(dramaAssetExtractionPayload{Scope: dramaAssetExtractionScope, AssetKind: "character", SourceChapterIDs: []string{chapters[0].ID}, SourceEpisodeIDs: []string{episodeID}})
			raw, _ := json.Marshal(map[string]string{"text": `{"characters":[{"name":"萧炎","looks":[{"name":"夜行装","appearance":"黑衣"},{"name":"礼服","appearance":"红礼服"}]}]}`})
			job := &model.DramaJob{Kind: model.DramaJobBible, PayloadJSON: string(payload)}
			task := &model.Task{ResultJSON: string(raw)}
			project, _ := svc.repo.ProjectForUser("usr-drama", projectID)
			run := &dramaRun{s: svc, project: project}
			for i := 0; i < 2; i++ {
				if err := run.applyBibleJob(job, task); err != nil {
					t.Fatal(err)
				}
			}
			episode, _ := svc.repo.DramaEpisode(projectID, episodeID)
			ids := decodeStringList(episode.AssetIDsJSON)
			seen := map[string]bool{}
			for _, id := range ids {
				seen[id] = true
			}
			if !seen["hero"] || seen["unrequested"] || seen["night"] == ambiguous || seen["second-night"] {
				t.Fatalf("only returned and unambiguous looks may belong to the episode: %v", ids)
			}
			all, _ := svc.repo.DramaCasts(projectID)
			var newLooks int
			for _, cast := range all {
				if cast.ParentID == "hero" && cast.LookName == "礼服" {
					newLooks++
					if !seen[cast.ID] {
						t.Fatalf("new returned look is missing its episode association: %+v", cast)
					}
				}
			}
			if newLooks != 1 || len(ids) != map[bool]int{false: 3, true: 2}[ambiguous] {
				t.Fatalf("replaying extraction must not duplicate or expand look membership: ids=%v looks=%+v", ids, all)
			}
		})
	}
}

func TestDramaAssetExtractionDoesNotRecreateDeletedEpisode(t *testing.T) {
	svc, fake, source := newDramaExtractionSource(t, model.DramaGuideAssets, model.DramaStatusPaused)
	episodeID := source.Episodes[1].ID
	if _, err := svc.ExtractDramaAssets("usr-drama", source.Project.ID, ExtractDramaAssetsRequest{ExpectedRevision: source.Production.Revision, Kind: "scene", EpisodeIDs: []string{episodeID}}); err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Delete(&model.DramaEpisode{}, "id = ?", episodeID).Error; err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, source.Project.ID, 2)
	episodes, _ := svc.repo.DramaEpisodes(source.Project.ID)
	if len(episodes) != len(source.Episodes)-1 {
		t.Fatalf("finishing extraction must not recreate a removed episode: %+v", episodes)
	}
	for _, episode := range episodes {
		if episode.AssetIDsJSON != "" {
			t.Fatalf("deleted episode's result must not be reassigned: %+v", episode)
		}
	}
}

func TestDramaAssetExtractionMultipleEpisodesDoesNotAssignUnionToEachEpisode(t *testing.T) {
	svc, _, source := newDramaExtractionSource(t, model.DramaGuideAssets, model.DramaStatusPaused)
	if _, err := svc.ExtractDramaAssets("usr-drama", source.Project.ID, ExtractDramaAssetsRequest{ExpectedRevision: source.Production.Revision, Kind: "character", EpisodeIDs: []string{source.Episodes[0].ID, source.Episodes[1].ID}}); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, source.Project.ID, 2)
	episodes, _ := svc.repo.DramaEpisodes(source.Project.ID)
	for _, episode := range episodes {
		if episode.AssetIDsJSON != "" {
			t.Fatalf("a merged multi-episode result has no authoritative per-asset episode origin: %+v", episode)
		}
	}
}

func TestDramaAssetExtractionRollsBackNewAssetsWhenMembershipWriteFails(t *testing.T) {
	svc, fake, source := newDramaExtractionSource(t, model.DramaGuideAssets, model.DramaStatusPaused)
	if err := fake.db.Callback().Update().Before("gorm:update").Register("reject_episode_membership", func(tx *gorm.DB) {
		fields, ok := tx.Statement.Dest.(map[string]any)
		if _, found := fields["asset_ids_json"]; ok && found && tx.Statement.Table == "drama_episodes" {
			tx.AddError(errors.New("membership write failed"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = fake.db.Callback().Update().Remove("reject_episode_membership") })
	result, err := svc.ExtractDramaAssets("usr-drama", source.Project.ID, ExtractDramaAssetsRequest{ExpectedRevision: source.Production.Revision, Kind: "scene", EpisodeIDs: []string{source.Episodes[0].ID}})
	if err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, source.Project.ID, 2)
	job, _ := svc.repo.DramaJob(source.Project.ID, result.Job.ID)
	casts, _ := svc.repo.DramaCasts(source.Project.ID)
	if job.Status != model.DramaJobFailed || len(casts) != 0 {
		t.Fatalf("asset creation and membership must commit atomically: job=%+v casts=%+v", job, casts)
	}
}

func TestDramaCastCreatePersistsSelectedEpisodeMembership(t *testing.T) {
	svc, fake, source := newDramaExtractionSource(t, model.DramaGuideAssets, model.DramaStatusPaused)
	projectID, episodeID := source.Project.ID, source.Episodes[0].ID
	before, _ := svc.repo.DramaEpisode(projectID, episodeID)
	cast, err := svc.CreateDramaCast("usr-drama", projectID, CreateDramaCastRequest{ExpectedRevision: &source.Production.Revision, EpisodeID: episodeID, Kind: "scene", Name: "新增场景"})
	if err != nil {
		t.Fatal(err)
	}
	after, _ := svc.repo.DramaEpisode(projectID, episodeID)
	if !reflect.DeepEqual(decodeStringList(after.AssetIDsJSON), []string{cast.ID}) || after.Revision != before.Revision {
		t.Fatalf("manual creation must retain its selected episode after reload: %+v", after)
	}
	other, _ := svc.repo.DramaEpisode(projectID, source.Episodes[1].ID)
	if other.AssetIDsJSON != "" {
		t.Fatalf("manual creation must not affect another episode: %+v", other)
	}
	p, _ := svc.repo.DramaProduction(projectID)
	if err := fake.db.Create(&model.DramaEpisode{ID: "foreign-episode", ProjectID: "foreign-project", Number: 1}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateDramaCast("usr-drama", projectID, CreateDramaCastRequest{ExpectedRevision: &p.Revision, EpisodeID: "foreign-episode", Kind: "prop", Name: "非法所属集"}); err == nil {
		t.Fatal("manual creation must validate episode ownership")
	}
	casts, _ := svc.repo.DramaCasts(projectID)
	if len(casts) != 1 {
		t.Fatalf("failed membership validation must roll back asset creation: %+v", casts)
	}
	if _, err := svc.CreateDramaCast("usr-drama", projectID, CreateDramaCastRequest{ExpectedRevision: &p.Revision, Kind: "prop", Name: "作品共享道具"}); err != nil {
		t.Fatal(err)
	}
	after, _ = svc.repo.DramaEpisode(projectID, episodeID)
	if !reflect.DeepEqual(decodeStringList(after.AssetIDsJSON), []string{cast.ID}) {
		t.Fatalf("creation without an episode must remain a shared asset: %+v", after)
	}
}

func TestDramaCastImportPersistsSelectedEpisodeMembershipIncludingSkippedLooks(t *testing.T) {
	svc, fake, target := newDramaExtractionSource(t, model.DramaGuideAssets, model.DramaStatusPaused)
	sourceID := newDramaMaterialProject(t, svc, "资产来源")
	base := createDramaMaterial(t, svc, sourceID, "character", "导入角色")
	lookResult, err := svc.AddDramaCastLook("usr-drama", sourceID, base.ID, DramaCastLookRequest{LookName: "夜行装", Appearance: "黑衣"})
	if err != nil {
		t.Fatal(err)
	}
	look := lookResult["look"].(model.DramaCast)
	prop := createDramaMaterial(t, svc, sourceID, "prop", "导入道具")
	req := ImportDramaCastRequest{SourceProjectID: sourceID, CastIDs: []string{base.ID, prop.ID}}
	shared, err := svc.ImportDramaCast("usr-drama", target.Project.ID, req)
	if err != nil || len(shared.Cast) != 3 {
		t.Fatalf("shared import failed: %+v %v", shared, err)
	}
	for _, episode := range target.Episodes {
		row, _ := svc.repo.DramaEpisode(target.Project.ID, episode.ID)
		if row.AssetIDsJSON != "" {
			t.Fatalf("omitted episode must remain a shared import: %+v", row)
		}
	}
	req.EpisodeID = target.Episodes[0].ID
	result, err := svc.ImportDramaCast("usr-drama", target.Project.ID, req)
	if err != nil || result.Imported != 0 || result.Skipped != 3 {
		t.Fatalf("existing imported assets must still associate to selected episode: %+v %v", result, err)
	}
	episode, _ := svc.repo.DramaEpisode(target.Project.ID, req.EpisodeID)
	ids := decodeStringList(episode.AssetIDsJSON)
	seen := map[string]bool{}
	for _, id := range ids {
		seen[id] = true
	}
	for _, cast := range result.Cast {
		if !seen[cast.ID] || cast.SourceCastID == "" {
			t.Fatalf("every returned asset including looks must be linked: ids=%v cast=%+v", ids, cast)
		}
	}
	if len(ids) != 3 || result.Cast[2].SourceCastID != look.ID {
		t.Fatalf("expected base, prop and returned look membership: ids=%v result=%+v", ids, result)
	}
	other, _ := svc.repo.DramaEpisode(target.Project.ID, target.Episodes[1].ID)
	if other.AssetIDsJSON != "" {
		t.Fatalf("another episode must not acquire imported membership: %+v", other)
	}
	if _, err := svc.ImportDramaCast("usr-drama", target.Project.ID, req); err != nil {
		t.Fatal(err)
	}
	episode, _ = svc.repo.DramaEpisode(target.Project.ID, req.EpisodeID)
	if !reflect.DeepEqual(decodeStringList(episode.AssetIDsJSON), ids) {
		t.Fatal("repeated import must not duplicate membership")
	}
	if err := fake.db.Create(&model.DramaEpisode{ID: "foreign-import-episode", ProjectID: sourceID, Number: 99}).Error; err != nil {
		t.Fatal(err)
	}
	fresh := createDramaMaterial(t, svc, sourceID, "scene", "不能导入的场景")
	before, _ := svc.repo.DramaProduction(target.Project.ID)
	if _, err := svc.ImportDramaCast("usr-drama", target.Project.ID, ImportDramaCastRequest{EpisodeID: "foreign-import-episode", SourceProjectID: sourceID, CastIDs: []string{fresh.ID}}); err == nil {
		t.Fatal("foreign episode import must fail")
	}
	casts, _ := svc.repo.DramaCasts(target.Project.ID)
	after, _ := svc.repo.DramaProduction(target.Project.ID)
	if len(casts) != 3 || before.Revision != after.Revision {
		t.Fatalf("invalid episode must roll back imported assets and revision: casts=%+v before=%+v after=%+v", casts, before, after)
	}
}

func TestDramaCharacterLibraryImportPersistsOnlySelectedEpisodeMembership(t *testing.T) {
	svc, fake, summary, library := characterLibraryFixture(t)
	projectID := summary.Project.ID
	episodes := []model.DramaEpisode{{ID: "library-episode-1", ProjectID: projectID, Number: 98}, {ID: "library-episode-2", ProjectID: projectID, Number: 99}}
	if err := fake.db.Create(&episodes).Error; err != nil {
		t.Fatal(err)
	}
	req := ImportDramaCharacterLibraryRequest{ExpectedRevision: characterRevision(summary.Production.Revision), LibraryAssetID: library.Asset.ID, LibraryVersionID: library.Character.VersionID}
	shared, err := svc.ImportDramaCharacterLibrary("usr-drama", projectID, req)
	if err != nil {
		t.Fatal(err)
	}
	for _, episode := range episodes {
		row, _ := svc.repo.DramaEpisode(projectID, episode.ID)
		if row.AssetIDsJSON != "" {
			t.Fatalf("omitted episode must remain a shared library import: %+v", row)
		}
	}
	p, _ := svc.repo.DramaProduction(projectID)
	req.EpisodeID, req.ExpectedRevision = episodes[0].ID, characterRevision(p.Revision)
	req.TargetCastID, req.ExpectedCastRevision = shared.ID, characterRevision(shared.Revision)
	linked, err := svc.ImportDramaCharacterLibrary("usr-drama", projectID, req)
	if err != nil || linked.ID != shared.ID {
		t.Fatalf("import onto existing target failed: %+v %v", linked, err)
	}
	first, _ := svc.repo.DramaEpisode(projectID, episodes[0].ID)
	second, _ := svc.repo.DramaEpisode(projectID, episodes[1].ID)
	if !reflect.DeepEqual(decodeStringList(first.AssetIDsJSON), []string{linked.ID}) || second.AssetIDsJSON != "" {
		t.Fatalf("existing imported character must only belong to selected episode: first=%+v second=%+v", first, second)
	}
	p, _ = svc.repo.DramaProduction(projectID)
	req.EpisodeID, req.ExpectedRevision = episodes[1].ID, characterRevision(p.Revision)
	req.TargetCastID, req.ExpectedCastRevision = "", nil
	secondLibrary, err := svc.CreateCharacter("usr-drama", CreateCharacterRequest{Name: "第二个库角色", Definition: map[string]any{"appearance": "黑色外套"}})
	if err != nil {
		t.Fatal(err)
	}
	req.LibraryAssetID, req.LibraryVersionID = secondLibrary.Asset.ID, secondLibrary.Character.VersionID
	created, err := svc.ImportDramaCharacterLibrary("usr-drama", projectID, req)
	if err != nil {
		t.Fatal(err)
	}
	second, _ = svc.repo.DramaEpisode(projectID, episodes[1].ID)
	if !reflect.DeepEqual(decodeStringList(second.AssetIDsJSON), []string{created.ID}) {
		t.Fatalf("new library import must retain selected episode: %+v", second)
	}
	if err := fake.db.Create(&model.DramaEpisode{ID: "foreign-library-episode", ProjectID: "foreign-project", Number: 1}).Error; err != nil {
		t.Fatal(err)
	}
	p, _ = svc.repo.DramaProduction(projectID)
	req.EpisodeID, req.ExpectedRevision = "foreign-library-episode", characterRevision(p.Revision)
	if _, err := svc.ImportDramaCharacterLibrary("usr-drama", projectID, req); err == nil {
		t.Fatal("library import must reject a foreign episode")
	}
	casts, _ := svc.repo.DramaCasts(projectID)
	after, _ := svc.repo.DramaProduction(projectID)
	if len(casts) != 2 || p.Revision != after.Revision {
		t.Fatalf("invalid library episode must roll back import and revision: casts=%+v before=%+v after=%+v", casts, p, after)
	}
}

func TestDramaCastLookCreatePersistsOnlySelectedEpisodeMembership(t *testing.T) {
	for _, scenario := range []string{"episode", "shared", "foreign_episode", "stale_revision", "membership_write_failure"} {
		t.Run(scenario, func(t *testing.T) {
			svc, fake, source := newDramaExtractionSource(t, model.DramaGuideCompleted, model.DramaStatusPaused)
			projectID, episodeID := source.Project.ID, source.Episodes[0].ID
			base, err := svc.CreateDramaCast("usr-drama", projectID, CreateDramaCastRequest{ExpectedRevision: &source.Production.Revision, Kind: "character", Name: "新增造型的角色"})
			if err != nil {
				t.Fatal(err)
			}
			if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", episodeID).UpdateColumn("asset_ids_json", encodeStringList([]string{base.ID})).Error; err != nil {
				t.Fatal(err)
			}
			before, _ := svc.repo.DramaEpisode(projectID, episodeID)
			p, _ := svc.repo.DramaProduction(projectID)
			req := DramaCastLookRequest{EpisodeID: episodeID, ExpectedRevision: &p.Revision, LookName: "夜行装", Appearance: "深色外套"}
			switch scenario {
			case "shared":
				req.EpisodeID, req.ExpectedRevision = "", nil
			case "foreign_episode":
				foreign := model.DramaEpisode{ID: "foreign-look-episode", ProjectID: "foreign-project", Number: 1}
				if err := fake.db.Create(&foreign).Error; err != nil {
					t.Fatal(err)
				}
				req.EpisodeID = foreign.ID
			case "stale_revision":
				stale := p.Revision - 1
				req.ExpectedRevision = &stale
			case "membership_write_failure":
				if err := fake.db.Callback().Update().Before("gorm:update").Register("reject_look_membership", func(tx *gorm.DB) {
					fields, ok := tx.Statement.Dest.(map[string]any)
					if _, found := fields["asset_ids_json"]; ok && found && tx.Statement.Table == "drama_episodes" {
						tx.AddError(errors.New("membership write failed"))
					}
				}); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = fake.db.Callback().Update().Remove("reject_look_membership") })
			}
			result, err := svc.AddDramaCastLook("usr-drama", projectID, base.ID, req)
			shouldFail := scenario != "episode" && scenario != "shared"
			if (err != nil) != shouldFail {
				t.Fatalf("add look failure=%t, want %t: %v", err != nil, shouldFail, err)
			}
			casts, _ := svc.repo.DramaCasts(projectID)
			after, _ := svc.repo.DramaEpisode(projectID, episodeID)
			afterProduction, _ := svc.repo.DramaProduction(projectID)
			wantIDs := []string{base.ID}
			if shouldFail {
				if len(casts) != 1 || p.Revision != afterProduction.Revision {
					t.Fatalf("rejected look must roll back creation and revision: casts=%+v production=%+v", casts, afterProduction)
				}
			} else {
				look := result["look"].(model.DramaCast)
				if len(casts) != 2 || look.ParentID != base.ID || look.ImageStatus != model.DramaMediaDraft || look.ImageResourceID != "" {
					t.Fatalf("saving a look must only create its draft: %+v", result)
				}
				if scenario == "episode" {
					wantIDs = append(wantIDs, look.ID)
				}
			}
			if !reflect.DeepEqual(decodeStringList(after.AssetIDsJSON), wantIDs) || before.Revision != after.Revision {
				t.Fatalf("look membership must merge without changing episode content: %+v", after)
			}
			other, _ := svc.repo.DramaEpisode(projectID, source.Episodes[1].ID)
			if other.AssetIDsJSON != "" {
				t.Fatalf("look must not be associated with another episode: %+v", other)
			}
			detail, err := svc.DramaEpisodeDetail("usr-drama", projectID, episodeID)
			if err != nil || !reflect.DeepEqual(decodeStringList(detail.Episode.AssetIDsJSON), wantIDs) {
				t.Fatalf("reloaded episode must retain look membership: %+v %v", detail, err)
			}
			if len(fake.requests) != 0 {
				t.Fatalf("adding a look must not submit model tasks: %+v", fake.requests)
			}
		})
	}
}
