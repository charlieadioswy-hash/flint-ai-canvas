package protocol

import (
	"context"
	"fmt"
	"testing"
)

func TestDeclaredProgressScaleAndMissingValues(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		mapping    *ManifestProgress
		want       int
		present    bool
	}{
		{"no declaration", `{"progress":72}`, nil, 0, false},
		{"fraction", `{"task":{"percent":0.42}}`, &ManifestProgress{Path: "task.percent", Scale: 1}, 42, true},
		{"fraction boundary", `{"progress":1}`, &ManifestProgress{Path: "progress", Scale: 1}, 100, true},
		{"percent boundary", `{"progress":1}`, &ManifestProgress{Path: "progress", Scale: 100}, 1, true},
		{"fractional percent", `{"progress":0.42}`, &ManifestProgress{Path: "progress", Scale: 100}, 0, true},
		{"string percent", `{"progress":"30%"}`, &ManifestProgress{Path: "progress", Scale: 100}, 30, true},
		{"zero", `{"progress":0}`, &ManifestProgress{Path: "progress", Scale: 100}, 0, true},
		{"missing", `{"data":{"progress":45}}`, &ManifestProgress{Path: "progress", Scale: 100}, 0, false},
		{"null", `{"progress":null}`, &ManifestProgress{Path: "progress", Scale: 100}, 0, false},
		{"boolean", `{"progress":true}`, &ManifestProgress{Path: "progress", Scale: 100}, 0, false},
		{"negative", `{"progress":-1}`, &ManifestProgress{Path: "progress", Scale: 100}, 0, false},
		{"above max", `{"progress":101}`, &ManifestProgress{Path: "progress", Scale: 100}, 0, false},
		{"NaN", `{"progress":"NaN"}`, &ManifestProgress{Path: "progress", Scale: 100}, 0, false},
		{"Inf", `{"progress":"Inf"}`, &ManifestProgress{Path: "progress", Scale: 100}, 0, false},
		{"percent not fraction", `{"progress":"30%"}`, &ManifestProgress{Path: "progress", Scale: 1}, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload, err := decodeObject([]byte(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			got := responseProgress(payload, tc.mapping)
			if (got != nil) != tc.present || (got != nil && *got != tc.want) {
				t.Fatalf("progress=%v want %d present=%v", got, tc.want, tc.present)
			}
		})
	}
}

func TestCustomPluginProgressDeclaration(t *testing.T) {
	for _, tc := range []struct {
		mapping string
		valid   bool
	}{
		{`{"path":"task.percent","scale":100}`, true},
		{`{"path":"task.fraction","scale":1}`, true},
		{`{"path":"","scale":100}`, false},
		{`{"path":"progress","scale":10}`, false},
		{`{"path":"progress"}`, false},
	} {
		manifest := []byte(fmt.Sprintf(`{"apiVersion":"yingce.plugin/v2","id":"custom-progress","version":"1.0.0","name":"Progress","author":"Test","documentation":"Test","contributes":{"providers":[{"id":"custom-progress","label":"Progress","capabilities":["video"],"scopes":["canvas"],"create":{"method":"POST","path":"/tasks"},"poll":{"method":"GET","path":"/tasks/{{taskId}}"},"response":{"statusPaths":["status"],"progress":%s}}]}}`, tc.mapping))
		adapter, err := LoadManifest(manifest)
		if (err == nil) != tc.valid {
			t.Fatalf("mapping=%s err=%v", tc.mapping, err)
		}
		if err == nil {
			got, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "task"}, []byte(`{"status":"processing","task":{"percent":25,"fraction":0.25}}`))
			if err != nil || got.Progress == nil || *got.Progress != 25 {
				t.Fatalf("custom progress=%+v err=%v", got, err)
			}
		}
	}
}

func TestOfficialPackageProgressContracts(t *testing.T) {
	for _, tc := range []struct {
		pkg, id, body string
		status        Status
		want          int
	}{
		{"openai-videos", "newapi", `{"id":"task","status":"queued","progress":0}`, StatusPending, 0},
		{"novita-video", "novita-video", `{"task":{"status":"TASK_STATUS_PROCESSING","progress_percent":42}}`, StatusProcessing, 42},
		{"runway-image", "runway-image", `{"status":"RUNNING","progress":0.4}`, StatusProcessing, 40},
		{"runway-video", "runway-video", `{"status":"THROTTLED","progress":0}`, StatusPending, 0},
		{"kacang-midjourney", "kacang-midjourney-special", `{"status":"processing","progress":"30%"}`, StatusProcessing, 30},
		{"kacang-midjourney", "kacang-midjourney-v7", `{"status":"processing","progress":"30%"}`, StatusProcessing, 30},
		{"kacang-midjourney", "kacang-midjourney", `{"status":"processing","progress":"30%"}`, StatusProcessing, 30},
	} {
		t.Run(tc.id, func(t *testing.T) {
			adapter := officialPackageAdapter(t, tc.pkg+".yingce-plugin", tc.id)
			result, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "task"}, []byte(tc.body))
			if err != nil || result.Status != tc.status || result.Progress == nil || *result.Progress != tc.want {
				t.Fatalf("result=%+v err=%v", result, err)
			}
			missing, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "task"}, []byte(`{"status":"processing"}`))
			if err != nil || missing.Progress != nil {
				t.Fatalf("missing field became a percentage: %+v %v", missing, err)
			}
		})
	}
	for _, tc := range []struct {
		adapter Adapter
		body    string
		want    int
	}{
		{openAIVideosAdapter(), `{"status":"processing","progress":37}`, 37},
		{novitaVideosAdapter(), `{"task":{"status":"TASK_STATUS_PROCESSING","progress_percent":46}}`, 46},
	} {
		result, err := tc.adapter.ParsePoll(context.Background(), PollContext{TaskID: "task"}, []byte(tc.body))
		if err != nil || result.Progress == nil || *result.Progress != tc.want {
			t.Fatalf("native result=%+v err=%v", result, err)
		}
	}
	adapter := newAPIVideosAdapter()
	result, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "task"}, []byte(`{"status":"processing","progress":75}`))
	if err != nil || result.Progress != nil {
		t.Fatalf("undeclared progress accepted: %+v %v", result, err)
	}
}

func TestDocumentedProgressProvidersDeliverResultsAndFailures(t *testing.T) {
	for _, tc := range []struct {
		pkg, id, success, failed string
		kind                     Capability
	}{
		{"novita-video", "novita-video", `{"task":{"status":"TASK_STATUS_SUCCEED","progress_percent":100},"videos":[{"video_url":"https://example.com/result.mp4"}]}`, `{"task":{"status":"TASK_STATUS_FAILED","reason":"invalid input"}}`, CapabilityVideo},
		{"runway-image", "runway-image", `{"status":"SUCCEEDED","output":["https://example.com/result.png"]}`, `{"status":"FAILED","failure":"invalid input"}`, CapabilityImage},
		{"runway-video", "runway-video", `{"status":"SUCCEEDED","output":["https://example.com/result.mp4"]}`, `{"status":"FAILED","failure":"invalid input"}`, CapabilityVideo},
	} {
		t.Run(tc.id, func(t *testing.T) {
			adapter := officialPackageAdapter(t, tc.pkg+".yingce-plugin", tc.id)
			result, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "task"}, []byte(tc.success))
			if err != nil || result.Status != StatusSucceeded || result.Result == nil {
				t.Fatalf("success=%+v err=%v", result, err)
			}
			if (tc.kind == CapabilityImage && len(result.Result.Images) != 1) || (tc.kind == CapabilityVideo && len(result.Result.Videos) != 1) {
				t.Fatalf("missing media result: %+v", result.Result)
			}
			failure, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "task"}, []byte(tc.failed))
			if err != nil || failure.Status != StatusFailed || failure.Message != "invalid input" {
				t.Fatalf("failure=%+v err=%v", failure, err)
			}
		})
	}
}
