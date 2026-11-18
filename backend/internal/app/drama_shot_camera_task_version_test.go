package app

import (
	"encoding/json"
	"testing"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func TestDramaShotMediaCompletionKeepsCameraPromptVersion(t *testing.T) {
	const (
		body       = "人物走出房间。"
		legacyBody = body + "\n【运镜意图】拉镜头"
		legacyFull = legacyBody + "\n运镜要求：镜头跟随主体移动，维持主体位置和连贯运动方向"
	)
	for _, test := range []struct {
		name       string
		legacy     bool
		change     string
		wantActive bool
	}{
		{name: "saved before upgrade", legacy: true, wantActive: true},
		{name: "saved after upgrade", wantActive: true},
		{name: "legacy result after shot edit", legacy: true, change: "shot"},
		{name: "legacy result after configuration edit", legacy: true, change: "config"},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, db, saved := shotMediaFixture(t)
			if err := db.Model(&model.DramaShot{}).Where("id = ?", "real-shot").Update("camera", "跟").Error; err != nil {
				t.Fatal(err)
			}
			config := saved.Config
			config.Prompt = body
			if test.legacy {
				config.Prompt = legacyBody
			} else {
				config.CameraIntent = "拉镜头"
			}
			if _, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: config}); err != nil {
				t.Fatal(err)
			}
			task, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "video", shotMediaConfirmed(t, s, "camera-prompt-version"))
			if err != nil {
				t.Fatal(err)
			}
			stored, err := s.repo.Task(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			var input map[string]any
			if err := json.Unmarshal([]byte(stored.InputJSON), &input); err != nil {
				t.Fatal(err)
			}
			metadata := input["metadata"].(map[string]any)
			if metadata["dramaShotCameraPromptVersion"] != float64(dramaShotCameraPromptVersion) {
				t.Fatalf("new task lacks the compiler version: %v", metadata["dramaShotCameraPromptVersion"])
			}
			if test.legacy {
				// Restore the payload fingerprint recorded by the pre-upgrade compiler.
				delete(metadata, "dramaShotCameraPromptVersion")
				input["prompt"] = legacyFull
				metadata["dramaShotPromptHash"] = dramaShotMediaDigest(legacyFull)
				encoded, err := json.Marshal(input)
				if err != nil {
					t.Fatal(err)
				}
				if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"prompt": legacyFull, "input_json": string(encoded)}).Error; err != nil {
					t.Fatal(err)
				}
			}
			switch test.change {
			case "shot":
				if err := db.Model(&model.DramaShot{}).Where("id = ?", "real-shot").Update("action", "人物停在原地。").Error; err != nil {
					t.Fatal(err)
				}
			case "config":
				config.CameraIntent = "无运镜"
				encoded, err := json.Marshal(config)
				if err != nil {
					t.Fatal(err)
				}
				if err := db.Model(&model.DramaShotMedia{}).Where("id = ?", saved.ID).Updates(map[string]any{"config_json": string(encoded), "revision": gorm.Expr("revision + 1")}).Error; err != nil {
					t.Fatal(err)
				}
			}
			completeShotMedia(t, s, db, task.ID, "camera-version-result")
			media := mustShotMedia(t, s)
			if len(media.Takes) != 1 || media.Takes[0].ResourceID != "camera-version-result" || media.Takes[0].Current != test.wantActive || (media.ResourceID == "camera-version-result") != test.wantActive {
				t.Fatalf("want active %v, result = %+v", test.wantActive, media)
			}
		})
	}
}
