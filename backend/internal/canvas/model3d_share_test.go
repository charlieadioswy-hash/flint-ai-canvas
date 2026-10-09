package canvas

import (
	"encoding/json"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func TestModel3DSharingProjectsOnlyPlatformResult(t *testing.T) {
	project := &model.CanvasProject{ID: "3d", PayloadJSON: `{"nodes":[{"id":"node","type":"model3d","metadata":{"storageKey":"resource:result","content":"https://private.invalid/model.glb","model3dFormat":"glb","model3d":{"draft":{"prompt":"private prompt","views":{"front":"private-ref"}},"run":{"requestId":"private-request"}}}}]}`}
	public, resources, err := publicCanvasProject(project, "share")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(public)
	if !resources["result"] || !strings.Contains(string(data), `"model3dFormat":"glb"`) || !strings.Contains(string(data), "/resources/result/file") {
		t.Fatalf("result missing: %s", data)
	}
	if strings.Contains(string(data), "private") || strings.Contains(string(data), `"model3d":`) {
		t.Fatalf("private state leaked: %s", data)
	}
	project.PayloadJSON = `{"nodes":[{"id":"node","type":"model3d","metadata":{"content":"https://tracker.invalid/model","model3dFormat":"invalid"}}]}`
	public, _, err = publicCanvasProject(project, "share")
	if err != nil {
		t.Fatal(err)
	}
	data, _ = json.Marshal(public)
	if strings.Contains(string(data), "tracker") || strings.Contains(string(data), "invalid") {
		t.Fatalf("unsafe format/url shared: %s", data)
	}
}
