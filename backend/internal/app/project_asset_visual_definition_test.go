package app

import (
	"encoding/json"
	"reflect"
	"testing"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

func TestCreateProjectVisualVersionKeepsDefinition(t *testing.T) {
	for _, category := range []model.AssetCategory{model.AssetCategoryProp, model.AssetCategoryEnvironment} {
		for _, empty := range []string{"", " \n", "{}"} {
			t.Run(string(category)+"/"+empty, func(t *testing.T) {
				svc, _, projectID, asset := seedProjectVisualAsset(t, category)
				original, err := svc.repo.AssetVersion(asset.PrimaryVersionID)
				if err != nil {
					t.Fatal(err)
				}
				version, err := svc.CreateProjectAssetVersion("user-1", projectID, asset.ID, CreateAssetVersionRequest{DefinitionJSON: empty})
				if err != nil {
					t.Fatal(err)
				}
				if version.Version != 2 || version.DefinitionJSON != original.DefinitionJSON {
					t.Fatalf("empty version request lost the visual definition: %+v", version)
				}
				bound, err := svc.BindProjectAssetImage("user-1", projectID, asset.ID, BindProjectAssetImageRequest{ResourceID: "image-1", ExpectedVersionID: version.ID})
				if err != nil {
					t.Fatal(err)
				}
				if bound.Visual == nil || bound.Visual.Status != "ready" || bound.Visual.Definition["prompt"] != "古代铜印特写" {
					t.Fatalf("generated asset lost its regeneration prompt: %+v", bound)
				}
			})
		}
	}
}

func TestLegacyProjectVisualDefinitionSurvivesReadVersionAndBinding(t *testing.T) {
	for _, category := range []model.AssetCategory{model.AssetCategoryProp, model.AssetCategoryEnvironment} {
		for _, operation := range []string{"version", "bind", "task"} {
			t.Run(string(category)+"/"+operation, func(t *testing.T) {
				svc, db, projectID, asset := seedProjectVisualAsset(t, category)
				current := seedLegacyProjectVisualVersions(t, db, asset, "{}", " { } ")
				original, err := svc.repo.AssetVersion(asset.PrimaryVersionID)
				if err != nil {
					t.Fatal(err)
				}
				before, err := svc.repo.AssetForUser("user-1", asset.ID)
				if err != nil {
					t.Fatal(err)
				}
				projectBefore, err := svc.repo.ProjectForUser("user-1", projectID)
				if err != nil {
					t.Fatal(err)
				}
				versionsBefore, err := svc.repo.AssetVersions(asset.ID)
				if err != nil {
					t.Fatal(err)
				}
				assets, err := svc.ProjectAssets("user-1", projectID)
				if err != nil || len(assets) != 1 {
					t.Fatalf("list assets: %+v %v", assets, err)
				}
				if assets[0].PrimaryVersionID != current.ID || assets[0].VersionCount != 3 || assets[0].Visual == nil || assets[0].Visual.Definition["prompt"] != "古代铜印特写" {
					t.Fatalf("legacy text asset must expose its historical prompt for image generation: %+v", assets[0])
				}
				// A failed image attempt must leave both the legacy versions and the asset intact.
				if _, err := svc.BindProjectAssetImage("user-1", projectID, asset.ID, BindProjectAssetImageRequest{ResourceID: "pending-image", ExpectedVersionID: current.ID}); err == nil {
					t.Fatal("pending image accepted")
				}
				after, _ := svc.repo.AssetForUser("user-1", asset.ID)
				projectAfter, _ := svc.repo.ProjectForUser("user-1", projectID)
				versionsAfter, _ := svc.repo.AssetVersions(asset.ID)
				if !reflect.DeepEqual(before, after) || !reflect.DeepEqual(projectBefore, projectAfter) || !reflect.DeepEqual(versionsBefore, versionsAfter) {
					t.Fatal("reading the recovered definition or rejecting a failed image changed persisted state")
				}
				switch operation {
				case "version":
					_, err = svc.CreateProjectAssetVersion("user-1", projectID, asset.ID, CreateAssetVersionRequest{})
				case "bind":
					_, err = svc.BindProjectAssetImage("user-1", projectID, asset.ID, BindProjectAssetImageRequest{ResourceID: "image-1", ExpectedVersionID: current.ID})
				case "task":
					input, marshalErr := json.Marshal(map[string]any{"metadata": map[string]any{"operation": "project_asset_image", "projectAssetId": asset.ID, "projectAssetVersionId": current.ID}})
					if marshalErr != nil {
						t.Fatal(marshalErr)
					}
					result := map[string]interface{}{"images": []map[string]string{{"resourceId": "image-1"}}}
					var applied bool
					applied, err = svc.finalizeProjectAssetImageTask(model.Task{ID: "legacy-image-task", UserID: "user-1", ProjectID: projectID, InputJSON: string(input)}, result)
					if err == nil && (!applied || result["projectAssetImageStatus"] != "bound") {
						t.Fatalf("task did not bind the generated image: %v %+v", applied, result)
					}
				}
				if err != nil {
					t.Fatal(err)
				}
				updated, err := svc.repo.AssetForUser("user-1", asset.ID)
				if err != nil {
					t.Fatal(err)
				}
				version, err := svc.repo.AssetVersion(updated.PrimaryVersionID)
				if err != nil || version.Version != 4 || version.DefinitionJSON != original.DefinitionJSON {
					t.Fatalf("new version must persist the recovered definition: %+v %v", version, err)
				}
				if operation != "version" {
					reps, err := svc.repo.AssetRepresentations(version.ID)
					if err != nil || len(reps) != 1 || reps[0].ResourceID != "image-1" {
						t.Fatalf("generated image was not attached to the new version: %+v %v", reps, err)
					}
				}
			})
		}
	}
}

func TestProjectVisualDefinitionRecoveryRespectsDefinitionBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name        string
		definitions []string
		wantPrompt  string
	}{
		{"current-replacement", []string{`{"prompt":"新设定"}`}, "新设定"},
		{"latest-replacement-before-empty", []string{`{"prompt":"新设定"}`, "{}"}, "新设定"},
		{"description-only-barrier", []string{`{"description":"用户重新设定，尚无提示词"}`, "{}"}, ""},
		{"empty-prompt-barrier", []string{`{"prompt":" "}`, "{}"}, ""},
		{"non-string-prompt-barrier", []string{`{"prompt":123}`, "{}"}, ""},
		{"null-barrier", []string{"null", "{}"}, ""},
		{"invalid-history-barrier", []string{"invalid", "{}"}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, db, projectID, asset := seedProjectVisualAsset(t, model.AssetCategoryProp)
			seedLegacyProjectVisualVersions(t, db, asset, tc.definitions...)
			assets, err := svc.ProjectAssets("user-1", projectID)
			if err != nil || len(assets) != 1 {
				t.Fatalf("list assets: %+v %v", assets, err)
			}
			if tc.wantPrompt == "" {
				if assets[0].Visual != nil {
					t.Fatalf("recovery crossed an explicit definition: %+v", assets[0].Visual)
				}
			} else if assets[0].Visual == nil || assets[0].Visual.Definition["prompt"] != tc.wantPrompt {
				t.Fatalf("wrong effective definition: %+v", assets[0].Visual)
			}
		})
	}
}

func TestProjectVisualDefinitionRecoveryIgnoresFutureForeignAndOtherCategories(t *testing.T) {
	for _, category := range []model.AssetCategory{model.AssetCategoryProp, model.AssetCategoryOther} {
		t.Run(string(category), func(t *testing.T) {
			svc, db, projectID, asset := seedProjectVisualAsset(t, model.AssetCategoryProp)
			if err := db.Model(&model.AssetVersion{}).Where("id = ?", asset.PrimaryVersionID).Update("definition_json", "{}").Error; err != nil {
				t.Fatal(err)
			}
			current := seedLegacyProjectVisualVersions(t, db, asset, "{}")
			for _, version := range []model.AssetVersion{
				{ID: "future-version", AssetID: asset.ID, Version: current.Version + 1, DefinitionJSON: `{"prompt":"未来设定"}`},
				{ID: "foreign-version", AssetID: "another-asset", Version: 1, DefinitionJSON: `{"prompt":"其他资产设定"}`},
			} {
				if err := db.Create(&version).Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := db.Model(&model.Asset{}).Where("id = ?", asset.ID).Update("category", category).Error; err != nil {
				t.Fatal(err)
			}
			assets, err := svc.ProjectAssets("user-1", projectID)
			if err != nil || len(assets) != 1 || assets[0].Visual != nil {
				t.Fatalf("unrelated definition was exposed: %+v %v", assets, err)
			}
			version, err := svc.CreateProjectAssetVersion("user-1", projectID, asset.ID, CreateAssetVersionRequest{})
			if err != nil || version.DefinitionJSON != "{}" {
				t.Fatalf("unrelated definition was copied: %+v %v", version, err)
			}
		})
	}
}

func TestCreateProjectVisualVersionHonorsExplicitReplacement(t *testing.T) {
	svc, db, projectID, asset := seedProjectVisualAsset(t, model.AssetCategoryProp)
	seedLegacyProjectVisualVersions(t, db, asset, "{}")
	for _, definition := range []string{`{"prompt":"银印"}`, `{"description":"用户重新编辑"}`} {
		version, err := svc.CreateProjectAssetVersion("user-1", projectID, asset.ID, CreateAssetVersionRequest{DefinitionJSON: definition})
		if err != nil || version.DefinitionJSON != definition {
			t.Fatalf("explicit replacement was changed: %+v %v", version, err)
		}
		next, err := svc.CreateProjectAssetVersion("user-1", projectID, asset.ID, CreateAssetVersionRequest{})
		if err != nil || next.DefinitionJSON != definition {
			t.Fatalf("empty request discarded the latest explicit definition: %+v %v", next, err)
		}
	}
}

func TestCreateProjectVisualVersionRecoveryRejectsInvalidWrites(t *testing.T) {
	for _, tc := range []struct{ name, userID, projectID, definition string }{
		{"foreign-user", "user-2", "project-1", ""},
		{"unlinked-project", "user-1", "other-project", ""},
		{"invalid-definition", "user-1", "project-1", "invalid"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, db, projectID, asset := seedProjectVisualAsset(t, model.AssetCategoryProp)
			current := seedLegacyProjectVisualVersions(t, db, asset, "{}")
			if err := db.Create(&model.Project{ID: "other-project", UserID: "user-1", Name: "无关联项目", Status: model.ProjectStatusActive}).Error; err != nil {
				t.Fatal(err)
			}
			before, err := svc.repo.ProjectForUser("user-1", projectID)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := svc.CreateProjectAssetVersion(tc.userID, tc.projectID, asset.ID, CreateAssetVersionRequest{DefinitionJSON: tc.definition}); err == nil {
				t.Fatal("invalid version creation accepted")
			}
			versions, err := svc.repo.AssetVersions(asset.ID)
			if err != nil || len(versions) != 2 || versions[0].DefinitionJSON != "{}" {
				t.Fatalf("failed write changed versions: %+v %v", versions, err)
			}
			after, err := svc.repo.AssetForUser("user-1", asset.ID)
			if err != nil || after.PrimaryVersionID != current.ID {
				t.Fatalf("failed write moved primary version: %+v %v", after, err)
			}
			project, err := svc.repo.ProjectForUser("user-1", projectID)
			if err != nil || project.Revision != before.Revision {
				t.Fatalf("failed write changed project revision: %+v %v", project, err)
			}
		})
	}
}

func TestProjectVisualDefinitionDoesNotRecoverOtherCategories(t *testing.T) {
	svc, db, projectID, asset := seedProjectVisualAsset(t, model.AssetCategoryProp)
	seedLegacyProjectVisualVersions(t, db, asset, "{}")
	if err := db.Model(&model.Asset{}).Where("id = ?", asset.ID).Update("category", model.AssetCategoryOther).Error; err != nil {
		t.Fatal(err)
	}
	assets, err := svc.ProjectAssets("user-1", projectID)
	if err != nil || len(assets) != 1 || assets[0].Visual != nil {
		t.Fatalf("nonvisual asset received a visual definition: %+v %v", assets, err)
	}
	version, err := svc.CreateProjectAssetVersion("user-1", projectID, asset.ID, CreateAssetVersionRequest{})
	if err != nil || version.DefinitionJSON != "{}" {
		t.Fatalf("nonvisual asset inherited a visual definition: %+v %v", version, err)
	}
}

// The pre-image-generation flow stored visual candidates as text and created empty versions.
func seedLegacyProjectVisualVersions(t *testing.T, db *gorm.DB, asset ProjectAssetSummary, definitions ...string) model.AssetVersion {
	t.Helper()
	var current model.AssetVersion
	for index, definition := range definitions {
		current = model.AssetVersion{ID: newID(), AssetID: asset.ID, Version: index + 2, Status: model.AssetVersionStatusDraft, DefinitionJSON: definition}
		if err := db.Create(&current).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Model(&model.Asset{}).Where("id = ?", asset.ID).Updates(map[string]any{
		"kind": "text", "primary_version_id": current.ID, "status": model.AssetVersionStatusDraft,
		"payload_json": `{"kind":"text","title":"铜印","data":{"content":""}}`,
	}).Error; err != nil {
		t.Fatal(err)
	}
	return current
}
