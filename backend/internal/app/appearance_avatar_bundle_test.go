package app

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func agentAvatarBundleTestZIP(t *testing.T, manifest string, files map[string][]byte) []byte {
	t.Helper()
	var data bytes.Buffer
	w := zip.NewWriter(&data)
	if manifest != "" {
		file, err := w.Create("avatar.json")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write([]byte(manifest)); err != nil {
			t.Fatal(err)
		}
	}
	for name, content := range files {
		file, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func agentAvatarTestMP4() []byte {
	return []byte{0, 0, 0, 16, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 0, 0}
}

func TestAgentAvatarBundleArchiveValidation(t *testing.T) {
	validManifest := `{"version":1,"width":480,"height":432,"clips":{"idle":"idle.mp4","wave":"wave.mp4"}}`
	validFiles := map[string][]byte{"idle.mp4": agentAvatarTestMP4(), "wave.mp4": agentAvatarTestMP4()}
	data := agentAvatarBundleTestZIP(t, validManifest, validFiles)
	manifest, err := validateAgentAvatarBundleArchive(bytes.NewReader(data), int64(len(data)))
	if err != nil || manifest.Width != 480 || manifest.Height != 432 || len(manifest.Clips) != 2 {
		t.Fatalf("valid bundle rejected: manifest=%+v err=%v", manifest, err)
	}

	tests := []struct {
		name     string
		manifest string
		files    map[string][]byte
	}{
		{"missing manifest", "", validFiles},
		{"unsupported version", `{"version":2,"width":480,"height":432,"clips":{"idle":"idle.mp4"}}`, map[string][]byte{"idle.mp4": agentAvatarTestMP4()}},
		{"path traversal", `{"version":1,"width":480,"height":432,"clips":{"idle":"../idle.mp4"}}`, map[string][]byte{"../idle.mp4": agentAvatarTestMP4()}},
		{"missing clip", `{"version":1,"width":480,"height":432,"clips":{"idle":"idle.mp4"}}`, nil},
		{"invalid mp4", `{"version":1,"width":480,"height":432,"clips":{"idle":"idle.mp4"}}`, map[string][]byte{"idle.mp4": []byte("not an mp4 file")}},
		{"unreferenced file", `{"version":1,"width":480,"height":432,"clips":{"idle":"idle.mp4"}}`, map[string][]byte{"idle.mp4": agentAvatarTestMP4(), "extra.mp4": agentAvatarTestMP4()}},
		{"unsupported file", `{"version":1,"width":480,"height":432,"clips":{"idle":"idle.mp4"}}`, map[string][]byte{"idle.mp4": agentAvatarTestMP4(), "readme.txt": []byte("not allowed")}},
		{"invalid dimensions", `{"version":1,"width":0,"height":432,"clips":{"idle":"idle.mp4"}}`, map[string][]byte{"idle.mp4": agentAvatarTestMP4()}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data := agentAvatarBundleTestZIP(t, test.manifest, test.files)
			if _, err := validateAgentAvatarBundleArchive(bytes.NewReader(data), int64(len(data))); err == nil {
				t.Fatal("invalid bundle accepted")
			}
		})
	}
}

func TestAgentAvatarBundleFilenameContract(t *testing.T) {
	tests := []struct {
		name     string
		file     string
		accepted bool
	}{
		{"ASCII", "idle.mp4", true},
		{"space", "idle loop.mp4", true},
		{"Chinese", "待机.mp4", true},
		{"emoji and uppercase extension", "动画 🎬.MP4", true},
		{"leading space", " leading space.mp4", true},
		{"extension only", ".mp4", true},
		{"dots in filename", "idle..loop.mp4", true},
		{"Unicode separator", "idle\u2028loop.mp4", true},
		{"ASCII at 128 bytes", strings.Repeat("a", 124) + ".mp4", true},
		{"ASCII at 129 bytes", strings.Repeat("a", 125) + ".mp4", false},
		{"Chinese at 128 bytes", strings.Repeat("待", 41) + "x.mp4", true},
		{"Chinese at 129 bytes", strings.Repeat("待", 41) + "xx.mp4", false},
		{"emoji at 128 bytes", strings.Repeat("🎬", 31) + ".mp4", true},
		{"emoji at 129 bytes", strings.Repeat("🎬", 31) + "x.mp4", false},
		{"empty", "", false},
		{"missing extension", "idle", false},
		{"other format", "idle.webm", false},
		{"trailing space", "idle.mp4 ", false},
		{"traversal", "../idle.mp4", false},
		{"relative path", "./idle.mp4", false},
		{"absolute path", "/idle.mp4", false},
		{"directory", "clips/idle.mp4", false},
		{"backslash", "clips\\idle.mp4", false},
		{"colon", "drive:idle.mp4", false},
		{"percent encoding", "idle%20loop.mp4", false},
		{"query delimiter", "idle?loop.mp4", false},
		{"fragment delimiter", "idle#loop.mp4", false},
		{"NUL", "idle\x00loop.mp4", false},
		{"newline", "idle\nloop.mp4", false},
		{"DEL", "idle\x7floop.mp4", false},
		{"C1 control", "idle\u0085loop.mp4", false},
		{"last C1 control", "idle\u009floop.mp4", false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data, err := json.Marshal(AgentAvatarBundleManifest{Version: 1, Width: 480, Height: 432, Clips: map[string]string{"idle": test.file}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := parseAgentAvatarManifest(data); (err == nil) != test.accepted {
				t.Fatalf("filename %q: accepted=%t, error=%v", test.file, test.accepted, err)
			}
			if test.accepted {
				archive := agentAvatarBundleTestZIP(t, string(data), map[string][]byte{test.file: agentAvatarTestMP4()})
				if _, err := validateAgentAvatarBundleArchive(bytes.NewReader(archive), int64(len(archive))); err != nil {
					t.Fatalf("supported filename %q rejected on upload: %v", test.file, err)
				}
			}
		})
	}
}

func TestDefaultCanvasAppearanceUsesBuiltInAvatarBundle(t *testing.T) {
	value := defaultCanvasAppearance()
	if value.AvatarType != "bundle" || value.AvatarBundleResourceID != "" {
		t.Fatalf("default canvas appearance = %+v, want built-in avatar bundle", value)
	}
	wantStates := map[string]string{
		"idle": "idle", "queued": "sleep_loop", "running": "working_loop", "waiting_approval": "think",
		"completed": "wave", "failed": "wipe_sweat", "cancelled": "lie_down", "rejected": "think",
	}
	if !reflect.DeepEqual(value.AvatarClipStates, wantStates) {
		t.Fatalf("default clip mapping = %#v", value.AvatarClipStates)
	}
	if _, err := normalizeCanvasAppearance(value); err != nil {
		t.Fatalf("default bundle rejected: %v", err)
	}
	invalid := value
	invalid.AvatarClipStates = map[string]string{"unrecognized": "idle"}
	if _, err := normalizeCanvasAppearance(invalid); err == nil {
		t.Fatal("unknown state accepted")
	}
}

func TestAgentAvatarBundleUploadEnableAndReferenceProtection(t *testing.T) {
	svc, _, _, admin := newAppearanceTestService(t)
	data := agentAvatarBundleTestZIP(t, `{"version":1,"width":480,"height":432,"clips":{"idle":"idle.mp4","wave":"wave.mp4"}}`, map[string][]byte{
		"idle.mp4": agentAvatarTestMP4(),
		"wave.mp4": agentAvatarTestMP4(),
	})
	imported, err := svc.UploadAgentAvatarBundle(admin, multipartFileHeader(t, "avatar.zip", "application/zip", data))
	if err != nil {
		t.Fatal(err)
	}
	resource, err := svc.repo.Resource(imported.ResourceID)
	if err != nil || resource.Kind != agentAvatarBundleResourceKind || resource.Provider != "local" {
		t.Fatalf("resource=%+v err=%v", resource, err)
	}
	if _, _, err := svc.AgentAvatarBundleAsset(nil, imported.ResourceID, "avatar.json"); err == nil {
		t.Fatal("unpublished bundle is publicly accessible")
	}

	appearance, err := svc.AdminAppearance(admin)
	if err != nil {
		t.Fatal(err)
	}
	appearance.Canvas.AvatarType = "bundle"
	appearance.Canvas.AvatarBundleResourceID = imported.ResourceID
	appearance.Canvas.AvatarClipStates = map[string]string{
		"idle": "idle", "running": "idle", "waiting_approval": "idle", "completed": "wave", "failed": "idle",
	}
	other := &model.User{ID: "other-avatar-admin", Role: model.UserRoleAdmin, Status: model.UserStatusActive}
	if _, err := svc.UpdateAppearance(other, appearance.AppearanceSetting); err == nil {
		t.Fatal("another administrator enabled an unowned bundle")
	}
	invalid := appearance.AppearanceSetting
	invalid.Canvas.AvatarClipStates = map[string]string{"running": "missing"}
	if _, err := svc.UpdateAppearance(admin, invalid); err == nil {
		t.Fatal("missing clip mapping was saved")
	}
	if _, err := svc.UpdateAppearance(admin, appearance.AppearanceSetting); err != nil {
		t.Fatal(err)
	}
	video, mimeType, err := svc.AgentAvatarBundleAsset(nil, imported.ResourceID, "idle.mp4")
	if err != nil || mimeType != "video/mp4" || !bytes.Equal(video, agentAvatarTestMP4()) {
		t.Fatalf("public clip response mime=%q bytes=%d err=%v", mimeType, len(video), err)
	}
	if _, _, err := svc.AgentAvatarBundleAsset(nil, imported.ResourceID, "../avatar.json"); err == nil {
		t.Fatal("traversal file request accepted")
	}
	if len(svc.appearanceResourceReferences([]string{imported.ResourceID})[imported.ResourceID]) == 0 {
		t.Fatal("active avatar bundle lost deletion protection")
	}

	appearance.Canvas.AvatarBundleResourceID = ""
	if _, err := svc.UpdateAppearance(admin, appearance.AppearanceSetting); err != nil {
		t.Fatal(err)
	}
	if len(svc.appearanceResourceReferences([]string{imported.ResourceID})[imported.ResourceID]) != 0 {
		t.Fatal("detached avatar bundle remains referenced")
	}
	if _, _, err := svc.AgentAvatarBundleAsset(nil, imported.ResourceID, "idle.mp4"); err == nil {
		t.Fatal("detached bundle remains publicly accessible")
	}
}
