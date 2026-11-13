package app

import (
	"encoding/json"
	"strings"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/platform"
	"yingce/backend/internal/production"
)

func characterRevision(value int64) *int64 { return &value }

func characterLibraryFixture(t *testing.T) (*Service, *fakeDramaBackend, DramaSummary, CharacterAssetSummary) {
	t.Helper()
	svc, fake := newDramaTestService(t)
	svc.coordinator = platform.NewCoordinatorWithRedis(nil, t.Name())
	summary := createGuidedDrama(t, svc, DramaChapterInput{Title: "第一章", Text: "秦子文回到家中。"})
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", summary.Project.ID).Updates(map[string]any{"guide_step": model.DramaGuideAssets, "stage": model.DramaStageProduce}).Error; err != nil {
		t.Fatal(err)
	}
	imageID, audioID := fake.resource("usr-drama", "image", "image/png"), fake.resource("usr-drama", "audio", "audio/wav")
	card, err := svc.CreateCharacter("usr-drama", CreateCharacterRequest{Name: "秦子文", Definition: map[string]any{"sourceDefinition": "年龄：26岁\n性格：冷静谨慎\n背景：父母出事后照顾弟弟。", "age": "26岁", "appearance": "白衬衫", "role": "哥哥", "aliases": []string{"子文"}, "extra": map[string]any{"symbol": "钥匙", "large": json.Number("9007199254740993")}}, ImageResourceID: imageID, AudioResourceID: audioID, Instructions: "低沉冷静"})
	if err != nil {
		t.Fatal(err)
	}
	return svc, fake, guideSummary(t, svc, summary.Project.ID), card
}

func TestDramaCharacterLibraryImportPreservesDefinitionsAndMedia(t *testing.T) {
	svc, fake, summary, library := characterLibraryFixture(t)
	projectID := summary.Project.ID
	req := ImportDramaCharacterLibraryRequest{ExpectedRevision: characterRevision(summary.Production.Revision), LibraryAssetID: library.Asset.ID, LibraryVersionID: library.Character.VersionID, RepresentationID: library.Character.Representations[0].ID, IncludeVoice: true}
	cast, err := svc.ImportDramaCharacterLibrary("usr-drama", projectID, req)
	if err != nil {
		t.Fatal(err)
	}
	if cast.Description != library.Character.Definition["sourceDefinition"] || cast.Appearance != "白衬衫" || cast.ImageStatus != model.DramaMediaReady || !cast.Locked || cast.ImageResourceID == "" || cast.VoiceProfileID == "" || cast.VoiceSampleResourceID == "" || cast.VoiceInstructions != "低沉冷静" {
		t.Fatalf("full library import lost fields: %+v", cast)
	}
	if cast.LibraryAssetID != library.Asset.ID || cast.LibraryVersionID != library.Character.VersionID || !strings.Contains(cast.DefinitionJSON, "9007199254740993") || !strings.Contains(cast.DefinitionJSON, "钥匙") {
		t.Fatalf("unknown definition or provenance lost: %s", cast.DefinitionJSON)
	}
	if _, err := svc.ImportDramaCharacterLibrary("usr-drama", projectID, req); err == nil {
		t.Fatal("stale project revision must fail")
	}
	var jobs int64
	if err := fake.db.Model(&model.DramaJob{}).Where("project_id = ?", projectID).Count(&jobs).Error; err != nil || jobs != 0 || len(fake.requests) != 0 {
		t.Fatalf("import dispatched work: jobs=%d requests=%d err=%v", jobs, len(fake.requests), err)
	}
	current := guideSummary(t, svc, projectID)
	newCard, err := svc.SaveDramaCharacterLibrary("usr-drama", projectID, cast.ID, SaveDramaCharacterLibraryRequest{ExpectedRevision: characterRevision(current.Production.Revision), ExpectedCastRevision: characterRevision(cast.Revision), Name: "秦子文 · 本剧"})
	if err != nil {
		t.Fatal(err)
	}
	if newCard.Asset.ID == library.Asset.ID || newCard.Character.Version != 1 || len(newCard.Character.Representations) != 1 || newCard.Character.Voice == nil || newCard.Character.Definition["sourceDefinition"] != library.Character.Definition["sourceDefinition"] {
		t.Fatalf("save-as-new lost actual current media/definition: %+v", newCard)
	}
	version, err := svc.repo.AssetVersion(newCard.Character.VersionID)
	if err != nil || !strings.Contains(version.DefinitionJSON, "9007199254740993") {
		t.Fatalf("unknown number changed: %+v %v", version, err)
	}
	after := guideSummary(t, svc, projectID)
	if after.Production.Revision != current.Production.Revision {
		t.Fatal("save-as-new must not mutate source project")
	}
	original, _ := svc.Character("usr-drama", library.Asset.ID)
	if original.Character.VersionID != library.Character.VersionID || original.Asset.Title != library.Asset.Title {
		t.Fatal("source library changed")
	}
}

func TestDramaCharacterLibraryExistingTextRequiresExplicitReplace(t *testing.T) {
	svc, _, summary, library := characterLibraryFixture(t)
	projectID := summary.Project.ID
	cast, err := svc.CreateDramaCast("usr-drama", projectID, CreateDramaCastRequest{ExpectedRevision: characterRevision(summary.Production.Revision), Kind: "character", Name: "剧本中的哥哥", Description: "作者的定义，不能改写", Appearance: "当前手写外观", VoiceInstructions: "当前声线"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.UpdateDramaCastFields(cast.ID, map[string]any{"definition_json": `{"sourceDefinition":"完整作者原文","age":"作者没写具体岁数","custom":{"keep":true}}`}); err != nil {
		t.Fatal(err)
	}
	row, _ := svc.repo.DramaCast(projectID, cast.ID)
	current := guideSummary(t, svc, projectID)
	req := ImportDramaCharacterLibraryRequest{ExpectedRevision: characterRevision(current.Production.Revision), LibraryAssetID: library.Asset.ID, LibraryVersionID: library.Character.VersionID, TargetCastID: cast.ID, ExpectedCastRevision: characterRevision(row.Revision), IncludeVoice: true}
	kept, err := svc.ImportDramaCharacterLibrary("usr-drama", projectID, req)
	if err != nil {
		t.Fatal(err)
	}
	definition, _ := parseDramaCharacterDefinition(kept.DefinitionJSON)
	if kept.Name != cast.Name || kept.Description != cast.Description || kept.Appearance != cast.Appearance || kept.VoiceInstructions != "当前声线" || definition["sourceDefinition"] != "完整作者原文" || definition["age"] != "作者没写具体岁数" || definition["custom"] == nil || definition["extra"] == nil {
		t.Fatalf("default import rewrote text: %+v %s", kept, kept.DefinitionJSON)
	}
	current = guideSummary(t, svc, projectID)
	req.ExpectedRevision, req.ExpectedCastRevision, req.ReplaceText = characterRevision(current.Production.Revision), characterRevision(kept.Revision), true
	replaced, err := svc.ImportDramaCharacterLibrary("usr-drama", projectID, req)
	if err != nil || replaced.Name != cast.Name || replaced.Description != library.Character.Definition["sourceDefinition"] || replaced.VoiceInstructions != "低沉冷静" {
		t.Fatalf("explicit replacement did not adopt exact library definition: %+v %v", replaced, err)
	}
	if !strings.Contains(replaced.DefinitionJSON, `"custom":{"keep":true}`) {
		t.Fatal("replacing known text must retain unknown target definition keys")
	}
}

func TestDramaCharacterLibraryRejectsStaleAndForeignReferences(t *testing.T) {
	for _, scenario := range []string{"library-version", "foreign-library", "foreign-image", "foreign-voice", "wrong-representation", "cast-version"} {
		t.Run(scenario, func(t *testing.T) {
			svc, fake, summary, library := characterLibraryFixture(t)
			cast, err := svc.CreateDramaCast("usr-drama", summary.Project.ID, CreateDramaCastRequest{ExpectedRevision: characterRevision(summary.Production.Revision), Kind: "character", Name: "目标"})
			if err != nil {
				t.Fatal(err)
			}
			summary = guideSummary(t, svc, summary.Project.ID)
			req := ImportDramaCharacterLibraryRequest{ExpectedRevision: characterRevision(summary.Production.Revision), LibraryAssetID: library.Asset.ID, LibraryVersionID: library.Character.VersionID, RepresentationID: library.Character.Representations[0].ID, IncludeVoice: true, TargetCastID: cast.ID, ExpectedCastRevision: characterRevision(cast.Revision)}
			switch scenario {
			case "library-version":
				req.LibraryVersionID = "old-version"
			case "foreign-library":
				fake.db.Model(&model.Asset{}).Where("id = ?", library.Asset.ID).Update("user_id", "other")
			case "foreign-image":
				fake.db.Model(&model.Resource{}).Where("id = ?", library.Character.Representations[0].ResourceID).Update("user_id", "other")
			case "foreign-voice":
				fake.db.Model(&model.VoiceProfile{}).Where("id = ?", library.Character.Voice.Profile.ID).Update("user_id", "other")
			case "wrong-representation":
				req.RepresentationID = "other-representation"
			case "cast-version":
				req.ExpectedCastRevision = characterRevision(cast.Revision + 1)
			}
			if _, err := svc.ImportDramaCharacterLibrary("usr-drama", summary.Project.ID, req); err == nil {
				t.Fatal("invalid library import accepted")
			}
			after, _ := svc.repo.DramaCast(summary.Project.ID, cast.ID)
			if after.Name != "目标" || after.ImageResourceID != "" || after.LibraryAssetID != "" || after.DefinitionJSON != "" || guideSummary(t, svc, summary.Project.ID).Production.Revision != summary.Production.Revision {
				t.Fatalf("rejected import was not atomic: %+v", after)
			}
		})
	}
}

func TestDramaCharacterLibraryDefaultDoesNotFillUnknownTraits(t *testing.T) {
	svc, _, summary, library := characterLibraryFixture(t)
	cast, err := svc.CreateDramaCast("usr-drama", summary.Project.ID, CreateDramaCastRequest{ExpectedRevision: characterRevision(summary.Production.Revision), Kind: "character", Name: "文档中的哥哥", Description: "年龄：27岁，其他未写。"})
	if err != nil {
		t.Fatal(err)
	}
	current := guideSummary(t, svc, summary.Project.ID)
	imported, err := svc.ImportDramaCharacterLibrary("usr-drama", summary.Project.ID, ImportDramaCharacterLibraryRequest{ExpectedRevision: characterRevision(current.Production.Revision), LibraryAssetID: library.Asset.ID, LibraryVersionID: library.Character.VersionID, TargetCastID: cast.ID, ExpectedCastRevision: characterRevision(cast.Revision)})
	if err != nil {
		t.Fatal(err)
	}
	definition, _ := parseDramaCharacterDefinition(imported.DefinitionJSON)
	if definition["age"] != nil || imported.Description != cast.Description || imported.VoiceInstructions != "" || imported.Appearance != "" || definition["sourceDefinition"] != nil || definition["extra"] == nil {
		t.Fatalf("default media import must not add conflicting known traits: %+v %s", imported, imported.DefinitionJSON)
	}
}

func TestDramaCharacterDefinitionPreservesUnknownAndOriginal(t *testing.T) {
	svc, _, summary, library := characterLibraryFixture(t)
	cast, err := svc.ImportDramaCharacterLibrary("usr-drama", summary.Project.ID, ImportDramaCharacterLibraryRequest{ExpectedRevision: characterRevision(summary.Production.Revision), LibraryAssetID: library.Asset.ID, LibraryVersionID: library.Character.VersionID})
	if err != nil {
		t.Fatal(err)
	}
	current := guideSummary(t, svc, summary.Project.ID)
	req := UpdateDramaCharacterDefinitionRequest{ExpectedRevision: characterRevision(current.Production.Revision), ExpectedCastRevision: characterRevision(cast.Revision), Fields: map[string]string{"age": "27岁", "personality": "用户改为直率", "role": "主角"}}
	updated, err := svc.UpdateDramaCharacterDefinition("usr-drama", summary.Project.ID, cast.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	definition, _ := parseDramaCharacterDefinition(updated.DefinitionJSON)
	if definition["age"] != "27岁" || definition["personality"] != "用户改为直率" || definition["sourceDefinition"] != library.Character.Definition["sourceDefinition"] || !strings.Contains(updated.DefinitionJSON, "9007199254740993") || updated.Role != "主角" {
		t.Fatalf("structured edit lost original or unknown keys: %s", updated.DefinitionJSON)
	}
	if _, err := svc.UpdateDramaCharacterDefinition("usr-drama", summary.Project.ID, cast.ID, req); err == nil {
		t.Fatal("stale definition edit accepted")
	}
	req.Fields = map[string]string{"sourceDefinition": "改写原文"}
	if _, err := svc.UpdateDramaCharacterDefinition("usr-drama", summary.Project.ID, cast.ID, req); err == nil {
		t.Fatal("source definition must be readonly")
	}
	extracted := dramaExtractedCharacterDefinition(production.BibleCharacter{Name: "哥哥", SourceDefinition: strings.Repeat("原文全文\n", 1000), Age: "模型推测26岁", Gender: "模型推测男"})
	extractedMap, _ := parseDramaCharacterDefinition(extracted.DefinitionJSON)
	if extractedMap["age"] != nil || extractedMap["gender"] != nil || extractedMap["sourceDefinition"] != strings.Repeat("原文全文\n", 1000) {
		t.Fatal("explicit author definition must not be guessed or truncated")
	}
}

func TestDramaCharacterUsageSeparatesAppearancesAndAudio(t *testing.T) {
	svc, fake, summary, library := characterLibraryFixture(t)
	cast, err := svc.ImportDramaCharacterLibrary("usr-drama", summary.Project.ID, ImportDramaCharacterLibraryRequest{ExpectedRevision: characterRevision(summary.Production.Revision), LibraryAssetID: library.Asset.ID, LibraryVersionID: library.Character.VersionID})
	if err != nil {
		t.Fatal(err)
	}
	usage, err := svc.DramaCharacterUsage("usr-drama", summary.Project.ID, cast.ID)
	if err != nil || usage.HasStory || len(usage.Appearances) != 0 {
		t.Fatalf("prose must not count as appearances: %+v %v", usage, err)
	}
	projectID := summary.Project.ID
	look := model.DramaCast{ID: "look", ProjectID: projectID, Kind: "character", ParentID: cast.ID, Name: cast.Name, LookName: "便服"}
	episode := model.DramaEpisode{ID: "episode", ProjectID: projectID, Number: 2, Title: "第二集"}
	if err := fake.db.Create(&look).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Create(&episode).Error; err != nil {
		t.Fatal(err)
	}
	shots := []model.DramaShot{{ID: "visible", ProjectID: projectID, EpisodeID: episode.ID, Position: 0, CastIDsJSON: encodeStringList([]string{cast.ID}), LookCastIDsJSON: `["look"]`}, {ID: "look-only", ProjectID: projectID, EpisodeID: episode.ID, Position: 1, LookCastIDsJSON: `["look"]`}, {ID: "dialogue-only", ProjectID: projectID, EpisodeID: episode.ID, Position: 2, Speaker: cast.Name}}
	if err := fake.db.Create(&shots).Error; err != nil {
		t.Fatal(err)
	}
	segments := []model.DramaSegment{{ID: "audio-only", ProjectID: projectID, EpisodeID: episode.ID, SegmentIndex: 0, AudioCastIDsJSON: encodeStringList([]string{cast.ID})}, {ID: "image-only", ProjectID: projectID, EpisodeID: episode.ID, SegmentIndex: 1, ReferenceCastIDsJSON: encodeStringList([]string{look.ID})}}
	if err := fake.db.Create(&segments).Error; err != nil {
		t.Fatal(err)
	}
	usage, err = svc.DramaCharacterUsage("usr-drama", projectID, cast.ID)
	if err != nil || !usage.HasStory || len(usage.Appearances) != 2 || len(usage.AudioReferences) != 1 || len(usage.ImageReferences) != 1 || usage.Appearances[0].ShotID != "visible" || usage.Appearances[1].ShotID != "look-only" {
		t.Fatalf("reference/audio was mislabeled as onscreen appearance: %+v %v", usage, err)
	}
}

func TestDramaCharacterLibraryRoundTripKeepsManualTextAndOriginal(t *testing.T) {
	svc, _, summary, library := characterLibraryFixture(t)
	cast, err := svc.ImportDramaCharacterLibrary("usr-drama", summary.Project.ID, ImportDramaCharacterLibraryRequest{ExpectedRevision: characterRevision(summary.Production.Revision), LibraryAssetID: library.Asset.ID, LibraryVersionID: library.Character.VersionID})
	if err != nil {
		t.Fatal(err)
	}
	manual := "用户明确改过的简介，不能被旧原文恢复"
	current := guideSummary(t, svc, summary.Project.ID)
	updated, err := svc.UpdateDramaCast("usr-drama", summary.Project.ID, cast.ID, UpdateDramaCastRequest{ExpectedRevision: characterRevision(current.Production.Revision), Description: &manual})
	if err != nil {
		t.Fatal(err)
	}
	current = guideSummary(t, svc, summary.Project.ID)
	exported, err := svc.SaveDramaCharacterLibrary("usr-drama", summary.Project.ID, cast.ID, SaveDramaCharacterLibraryRequest{ExpectedRevision: characterRevision(current.Production.Revision), ExpectedCastRevision: characterRevision(updated.Revision), Name: "手工编辑后"})
	if err != nil {
		t.Fatal(err)
	}
	imported, err := svc.ImportDramaCharacterLibrary("usr-drama", summary.Project.ID, ImportDramaCharacterLibraryRequest{ExpectedRevision: characterRevision(current.Production.Revision), LibraryAssetID: exported.Asset.ID, LibraryVersionID: exported.Character.VersionID})
	if err != nil {
		t.Fatal(err)
	}
	definition, _ := parseDramaCharacterDefinition(imported.DefinitionJSON)
	if imported.Description != manual || definition["sourceDefinition"] != library.Character.Definition["sourceDefinition"] {
		t.Fatalf("manual text or original changed after roundtrip: %+v %s", imported, imported.DefinitionJSON)
	}
}

func TestDramaCharacterStructuredFieldsReachActualPrompts(t *testing.T) {
	cast := model.DramaCast{Kind: "character", Name: "秦子文", Appearance: "普通青年", DramaCharacterDefinition: model.DramaCharacterDefinition{DefinitionJSON: `{"age":"26岁","clothing":"白衬衫","personality":"冷静谨慎","vendorSpecific":"不应该发到模型"}`}}
	prompt := buildDramaCastImagePrompt(DramaSettings{}, dramaBibleMeta{}, cast)
	if !strings.Contains(prompt, "年龄：26岁") || !strings.Contains(prompt, "服装：白衬衫") || strings.Contains(prompt, "vendorSpecific") || strings.Contains(prompt, "冷静谨慎") {
		t.Fatalf("default reference image prompt did not use only explicit visual fields: %s", prompt)
	}
	if narrative := dramaCharacterStructuredText(cast, false); !strings.Contains(narrative, "性格：冷静谨慎") || strings.Contains(narrative, "vendorSpecific") {
		t.Fatalf("narrative omitted explicit character fields: %s", narrative)
	}
	cast.ImagePrompt = "用户自定义完整提示词"
	custom := buildDramaCastImagePrompt(DramaSettings{}, dramaBibleMeta{}, cast)
	if !strings.Contains(custom, "用户自定义完整提示词") || strings.Contains(custom, "26岁") || strings.Contains(custom, "白衬衫") {
		t.Fatalf("structured fields must not override a full custom prompt: %s", custom)
	}
}

func TestDramaCharacterLibraryEditsKeepStoryStage(t *testing.T) {
	svc, fake, summary, library := characterLibraryFixture(t)
	projectID := summary.Project.ID
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("guide_step", model.DramaGuideStory).Error; err != nil {
		t.Fatal(err)
	}
	current := guideSummary(t, svc, projectID)
	cast, err := svc.ImportDramaCharacterLibrary("usr-drama", projectID, ImportDramaCharacterLibraryRequest{ExpectedRevision: characterRevision(current.Production.Revision), LibraryAssetID: library.Asset.ID, LibraryVersionID: library.Character.VersionID, RepresentationID: library.Character.Representations[0].ID, IncludeVoice: true})
	if err != nil {
		t.Fatal(err)
	}
	current = guideSummary(t, svc, projectID)
	if current.Production.GuideStep != model.DramaGuideStory {
		t.Fatalf("import rewound story stage: %s", current.Production.GuideStep)
	}
	if _, err := svc.UpdateDramaCharacterDefinition("usr-drama", projectID, cast.ID, UpdateDramaCharacterDefinitionRequest{ExpectedRevision: characterRevision(current.Production.Revision), ExpectedCastRevision: characterRevision(cast.Revision), Fields: map[string]string{"personality": "冷静"}}); err != nil {
		t.Fatal(err)
	}
	current = guideSummary(t, svc, projectID)
	if current.Production.GuideStep != model.DramaGuideStory || current.Production.Stage != model.DramaStageProduce {
		t.Fatalf("definition edit changed workflow stage: %+v", current.Production)
	}
	var jobs int64
	if err := fake.db.Model(&model.DramaJob{}).Where("project_id = ?", projectID).Count(&jobs).Error; err != nil || jobs != 0 || len(fake.requests) != 0 {
		t.Fatalf("edits dispatched work: jobs=%d requests=%d err=%v", jobs, len(fake.requests), err)
	}
}
