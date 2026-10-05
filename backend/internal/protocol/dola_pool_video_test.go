package protocol

import (
	"context"
	"reflect"
	"testing"
)

func TestOfficialDolaPoolVideoProfile(t *testing.T) {
	adapter := officialPackageAdapter(t, "dola-pool.yingce-plugin", "dola-pool")
	request := GenerationRequest{
		Capability:  CapabilityVideo,
		Model:       "seedance-2.5",
		Prompt:      "A cat chasing butterflies in a meadow",
		Duration:    30,
		AspectRatio: "720x1280",
		Images:      []MediaReference{{URL: "https://assets.example/character.png", Kind: "image"}},
	}

	create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	if create.Method != "POST" || create.Path != "/v1/videos/generations" || create.ContentType != "application/json" {
		t.Fatalf("Dola-pool create = %#v", create)
	}
	body := manifestTestBody(t, create)
	if body["model"] != request.Model || body["prompt"] != request.Prompt || body["duration"] != float64(30) {
		t.Fatalf("Dola-pool create body = %#v", body)
	}
	if body["ratio"] != request.AspectRatio || body["size"] != request.AspectRatio {
		t.Fatalf("Dola-pool frame fields = %#v", body)
	}
	images, _ := body["reference_images"].([]any)
	if len(images) != 1 || images[0] != request.Images[0].URL {
		t.Fatalf("Dola-pool reference_images = %#v", images)
	}

	created, err := adapter.ParseCreate(context.Background(), []byte(`{"id":"video-task-1","status":"queued"}`))
	if err != nil {
		t.Fatal(err)
	}
	if created.TaskID != "video-task-1" || created.Status != StatusPending {
		t.Fatalf("Dola-pool create result = %#v", created)
	}
	poll, err := adapter.BuildPoll(context.Background(), PollContext{TaskID: created.TaskID})
	if err != nil {
		t.Fatal(err)
	}
	if poll.Method != "GET" || poll.Path != "/v1/videos/video-task-1" {
		t.Fatalf("Dola-pool poll = %#v", poll)
	}
	state, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: created.TaskID}, []byte(`{"id":"video-task-1","status":"completed","video_url":"https://dolasd.xyz/videos/result.mp4"}`))
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != StatusSucceeded || state.Result == nil || len(state.Result.Videos) != 1 || state.Result.Videos[0].URL != "https://dolasd.xyz/videos/result.mp4" {
		t.Fatalf("Dola-pool poll result = %#v", state)
	}

	resultAdapter, ok := adapter.(ResultAdapter)
	if !ok {
		t.Fatal("Dola-pool adapter does not expose binary result download")
	}
	result, err := resultAdapter.BuildResult(context.Background(), PollContext{TaskID: created.TaskID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Method != "GET" || result.Path != "/v1/videos/video-task-1/content" || result.Headers["Accept"] != "video/mp4" {
		t.Fatalf("Dola-pool result download = %#v", result)
	}
}

func TestOfficialDolaPoolRequiresExplicitDuration(t *testing.T) {
	adapter := officialPackageAdapter(t, "dola-pool.yingce-plugin", "dola-pool")
	for _, optionKey := range []string{"none", "body", "extra_body"} {
		t.Run(optionKey, func(t *testing.T) {
			request := GenerationRequest{
				Model:  "seedance-2.5",
				Prompt: "A cat chasing butterflies in a meadow",
			}
			if optionKey != "none" {
				request.ProviderOptions = map[string]map[string]any{"dola-pool": {optionKey: map[string]any{"duration": 30}}}
			}
			_, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request})
			if err == nil {
				t.Fatal("Dola-pool accepted a request without an explicit duration")
			}
		})
	}
}

func TestOfficialDolaPoolProviderOptionsCannotChangeAdmittedRequest(t *testing.T) {
	adapter := officialPackageAdapter(t, "dola-pool.yingce-plugin", "dola-pool")
	for _, optionKey := range []string{"body", "extra_body"} {
		for _, withReferences := range []bool{false, true} {
			name := optionKey + "/text-to-video"
			if withReferences {
				name = optionKey + "/reference-to-video"
			}
			t.Run(name, func(t *testing.T) {
				request := GenerationRequest{
					Capability: CapabilityVideo,
					Model:      "seedance-2.5",
					Prompt:     "A cat chasing butterflies in a meadow",
					Duration:   5,
				}
				if withReferences {
					request.AspectRatio = "720x1280"
					request.Images = []MediaReference{{URL: "https://assets.example/character.png", Kind: "image"}}
				}
				baseline, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request})
				if err != nil {
					t.Fatal(err)
				}
				request.ProviderOptions = map[string]map[string]any{"dola-pool": {optionKey: map[string]any{
					"model":            "seedance-2.0",
					"prompt":           "Unadmitted prompt",
					"duration":         30,
					"seconds":          30,
					"duration_seconds": 30,
					"ratio":            "1:1",
					"size":             "1024x1024",
					"resolution":       "1080p",
					"quality":          "high",
					"generate_audio":   true,
					"watermark":        true,
					"reference_images": []any{"https://assets.example/unadmitted.png"},
					"image_url":        "https://assets.example/unadmitted.png",
					"image":            "https://assets.example/unadmitted.png",
					"input_image":      "https://assets.example/unadmitted.png",
					"input_images":     []any{"https://assets.example/unadmitted.png"},
					"reference_videos": []any{"https://assets.example/unadmitted.mp4"},
					"reference_audios": []any{"https://assets.example/unadmitted.mp3"},
					"content":          []any{map[string]any{"type": "image_url", "image_url": "https://assets.example/unadmitted.png"}},
					"mode":             "video-to-video",
					"operation":        "extend",
					"count":            8,
					"n":                8,
					"unknown_option":   "must not be forwarded",
				}}}
				create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request})
				if err != nil {
					t.Fatal(err)
				}
				if got, want := manifestTestBody(t, create), manifestTestBody(t, baseline); !reflect.DeepEqual(got, want) {
					t.Fatalf("Dola-pool %s changed admitted fields: got %#v, want %#v", optionKey, got, want)
				}
			})
		}
	}
}
