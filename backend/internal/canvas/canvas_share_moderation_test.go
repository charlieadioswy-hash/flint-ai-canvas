package canvas

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"yingce/backend/internal/model"
)

func moderationShareNode() map[string]any {
	return map[string]any{
		"id": "node-1", "type": "image", "title": "镜头", "position": map[string]any{"x": 0, "y": 0}, "width": 640, "height": 480,
		"metadata": map[string]any{
			"content": "https://private.example/image?signature=secret", "storageKey": "resource:resource_123",
			"sharedImageModeration": map[string]any{"forged": "must not be copied"},
			"imageModeration": map[string]any{
				"sourceIdentity": "resource:resource_123", "providerConfig": "secret",
				"report": map[string]any{
					"resourceId": "resource_123", "checkId": "private-check", "contentVersion": "private-version", "reused": true,
					"status": "partial", "overallRisk": "high", "isCurrent": true,
					"riskTags": []any{map[string]any{"code": "violence", "label": "暴力风险", "level": "high", "raw": map[string]any{"apiKey": "secret"}}},
					"summary":  "检测到内容风险，部分检测未完成", "createdAt": "2026-10-01T00:00:00Z", "completedAt": "2026-10-01T00:00:10Z",
					"providerId": "private-provider", "requestId": "private-request", "diagnostics": map[string]any{"url": "secret"},
				},
			},
		},
	}
}

func serializeModerationShare(t *testing.T, node map[string]any) (map[string]any, map[string]bool) {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"id": "project-1", "title": "公开画布", "nodes": []any{node}})
	if err != nil {
		t.Fatal(err)
	}
	project, resources, err := publicCanvasProject(&model.CanvasProject{PayloadJSON: string(payload)}, "share-token")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(PublicCanvasShare{Project: project})
	if err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatal(err)
	}
	return response, resources
}

func sharedModerationMetadata(response map[string]any) map[string]any {
	return response["project"].(map[string]any)["nodes"].([]any)[0].(map[string]any)["metadata"].(map[string]any)
}

func TestPublicCanvasModerationResponseContract(t *testing.T) {
	actual, resources := serializeModerationShare(t, moderationShareNode())
	data, err := os.ReadFile("testdata/image-moderation-share.json")
	if err != nil {
		t.Fatal(err)
	}
	var expected map[string]any
	if err := json.Unmarshal(data, &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("public response differs from the frontend contract fixture:\n%#v", actual)
	}
	if !reflect.DeepEqual(resources, map[string]bool{"resource_123": true}) {
		t.Fatalf("unexpected allowed resources: %#v", resources)
	}
}

func TestPublicCanvasModerationRejectsUnboundOrInvalidReports(t *testing.T) {
	for _, name := range []string{"changed image", "different report resource", "unmanaged image", "missing storage key", "invalid status", "invalid risk", "invalid tag", "nested summary", "missing report", "non-image"} {
		t.Run(name, func(t *testing.T) {
			node := moderationShareNode()
			metadata := node["metadata"].(map[string]any)
			state := metadata["imageModeration"].(map[string]any)
			report := state["report"].(map[string]any)
			switch name {
			case "changed image":
				metadata["storageKey"] = "resource:replacement"
			case "different report resource":
				report["resourceId"] = "private_resource"
			case "unmanaged image":
				delete(metadata, "storageKey")
			case "missing storage key":
				delete(metadata, "storageKey")
				metadata["content"] = "/api/resources/resource_123/file"
			case "invalid status":
				report["status"] = "unexpected"
			case "invalid risk":
				report["overallRisk"] = "unexpected"
			case "invalid tag":
				report["riskTags"] = []any{map[string]any{"level": "unexpected"}}
			case "nested summary":
				report["summary"] = map[string]any{"apiKey": "secret"}
			case "missing report":
				delete(metadata, "imageModeration")
			case "non-image":
				node["type"] = "video"
			}
			response, resources := serializeModerationShare(t, node)
			if _, ok := sharedModerationMetadata(response)["sharedImageModeration"]; ok {
				t.Fatal("unbound or invalid report was published")
			}
			if resources["private_resource"] || (name == "changed image" && resources["resource_123"]) || (name == "unmanaged image" && len(resources) != 0) {
				t.Fatalf("report authorized an unrelated resource: %#v", resources)
			}
		})
	}
}

func TestPublicCanvasModerationPreservesSnapshotState(t *testing.T) {
	for _, status := range []string{"queued", "running", "completed", "partial", "failed"} {
		t.Run(status, func(t *testing.T) {
			node := moderationShareNode()
			report := node["metadata"].(map[string]any)["imageModeration"].(map[string]any)["report"].(map[string]any)
			report["status"], report["isCurrent"], report["riskTags"] = status, false, nil
			response, _ := serializeModerationShare(t, node)
			public := sharedModerationMetadata(response)["sharedImageModeration"].(map[string]any)["report"].(map[string]any)
			if public["status"] != status || public["isCurrent"] != false || public["overallRisk"] != "high" || len(public["riskTags"].([]any)) != 0 {
				t.Fatalf("snapshot state changed: %#v", public)
			}
		})
	}
}
