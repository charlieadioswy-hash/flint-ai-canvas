package model3d

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"testing"
)

func TestTripoProcessingContract(t *testing.T) {
	on := true
	cases := []struct {
		p    Processing
		path string
		body map[string]any
	}{
		{Processing{Operation: "segment", SourceTaskID: "local", Model: "v2.0-20260430", Granularity: "detailed", SplitByConnectivity: &on}, "/mesh/segment", map[string]any{"model": "v2.0-20260430", "segmentation_granularity": "detailed", "split_by_connectivity": true}},
		{Processing{Operation: "complete", SourceTaskID: "local", CompletionMode: "quick_cap", PartNames: []string{"tripo_part_1"}}, "/mesh/complete", map[string]any{"model": "v1.0-20250506", "completion_mode": "quick_cap", "part_names": []any{"tripo_part_1"}}},
		{Processing{Operation: "rig_check", SourceTaskID: "local"}, "/animations/rig-check", map[string]any{}},
		{Processing{Operation: "rig", SourceTaskID: "local", Model: "v3.0-20260909", RigType: "biped", Spec: "unity", OutFormat: "fbx"}, "/animations/rig", map[string]any{"model": "v3.0-20260909", "rig_type": "biped", "spec": "unity", "out_format": "fbx"}},
		{Processing{Operation: "animate", SourceTaskID: "local", RigType: "biped", Animation: "preset:walk", AnimateInPlace: &on, OutFormat: "glb"}, "/animations/retarget", map[string]any{"animation": "preset:walk", "animate_in_place": true, "export_with_geometry": true, "out_format": "glb"}},
	}
	for _, tc := range cases {
		t.Run(tc.p.Operation, func(t *testing.T) {
			calls := 0
			provider := &tripoProvider{client: &http.Client{Transport: tripoRoundTrip(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Method != "POST" || r.URL.Path != "/v3"+tc.path {
					t.Fatalf("wrong endpoint: %s %s", r.Method, r.URL.Path)
				}
				var got map[string]any
				if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
					t.Fatal(err)
				}
				tc.body["input"] = "opaque-upstream-id"
				if !reflect.DeepEqual(got, tc.body) {
					t.Fatalf("payload=%v want=%v", got, tc.body)
				}
				return tripoResponse(200, `{"code":0,"data":{"task_id":"processing-task"}}`), nil
			})}}
			id, err := provider.Submit(context.Background(), Config{BaseURL: tripoTestBaseURL}, Request{Processing: &tc.p, SourceProviderTaskID: "opaque-upstream-id"}, nil)
			if err != nil || id != "processing-task" || calls != 1 {
				t.Fatalf("id=%s err=%v calls=%d", id, err, calls)
			}
		})
	}
}

func TestTripoRigCheckResultWithoutModel(t *testing.T) {
	for _, riggable := range []string{"true", "false"} {
		provider := &tripoProvider{client: &http.Client{Transport: tripoRoundTrip(func(*http.Request) (*http.Response, error) {
			return tripoResponse(200, `{"code":0,"data":{"status":"success","output":{"riggable":`+riggable+`,"rig_type":"biped"}}}`), nil
		})}}
		state, err := provider.Poll(context.Background(), Config{BaseURL: tripoTestBaseURL}, "check", false)
		if err != nil || state.RigCheck == nil || state.RigCheck.Riggable != (riggable == "true") || state.Artifact.URL != "" {
			t.Fatalf("check: %+v %v", state, err)
		}
	}
}

func TestProcessingInvalidCombinationsNeverReachProvider(t *testing.T) {
	for _, p := range []Processing{
		{Operation: "segment", SourceTaskID: "local", Model: "v1.0-20250506", Granularity: "detailed"},
		{Operation: "complete", SourceTaskID: "local", CompletionMode: "quick_cap", PartNames: []string{"a", "a"}},
		{Operation: "rig_check", SourceTaskID: "local", OutFormat: "glb"},
		{Operation: "rig", SourceTaskID: "local", Model: "v2.5-20260210", RigType: "biped", Spec: "unity", OutFormat: "glb"},
		{Operation: "rig", SourceTaskID: "local", Model: "v3.0-20260909", RigType: "quadruped", Spec: "mixamo", OutFormat: "glb"},
		{Operation: "animate", SourceTaskID: "local", RigType: "quadruped", Animation: "preset:run", OutFormat: "glb"},
		{Operation: "animate", SourceTaskID: "local", RigType: "biped", Animation: "preset:walk", OutFormat: "obj"},
	} {
		provider := &tripoProvider{client: &http.Client{Transport: tripoRoundTrip(func(*http.Request) (*http.Response, error) {
			t.Fatal("invalid processing reached network")
			return nil, io.EOF
		})}}
		if _, err := provider.Submit(context.Background(), Config{BaseURL: tripoTestBaseURL}, Request{Processing: &p, SourceProviderTaskID: "upstream"}, nil); err == nil {
			t.Fatalf("accepted %+v", p)
		}
	}
}

func TestSegmentPartsUseGLBNodeNames(t *testing.T) {
	data := testGLB(`{"asset":{"version":"2.0"},"nodes":[{"name":"Scene"},{"name":"tripo_part_0","mesh":0},{"name":"tripo_part_1","children":[3]},{"name":"mesh-child","mesh":1}]}`)
	if got := PartNames(data); !reflect.DeepEqual(got, []string{"tripo_part_0", "tripo_part_1"}) {
		t.Fatalf("parts=%v", got)
	}
	if PartNames([]byte("invalid")) != nil {
		t.Fatal("invalid file parsed")
	}
}
