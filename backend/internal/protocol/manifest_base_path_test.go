package protocol

import (
	"context"
	"strings"
	"testing"
)

func TestManifestBasePath(t *testing.T) {
	manifest := `{"apiVersion":"yingce.plugin/v1","id":"base-path","version":"1.0.0","name":"Base Path","author":"Test","documentation":"# Test","contributes":{"providers":[{"id":"base-path","label":"Base Path","capabilities":["text"],"scopes":["canvas"],"create":{"method":"POST","path":"/chat/completions","basePath":true},"response":{}}]}}`
	adapter, err := LoadManifest([]byte(manifest))
	if err != nil {
		t.Fatal(err)
	}
	spec, err := adapter.BuildCreate(context.Background(), RequestContext{BaseURL: "https://example.com/v2/llm"})
	if err != nil || !spec.BasePath || spec.OriginPath || spec.Path != "/chat/completions" {
		t.Fatalf("spec = %#v, err = %v", spec, err)
	}
	if _, err := LoadManifest([]byte(strings.Replace(manifest, `"basePath":true`, `"basePath":true,"originPath":true`, 1))); err == nil {
		t.Fatal("conflicting manifest path modes were accepted")
	}
	for _, spec := range []RequestSpec{
		{Method: "POST", Path: "/messages", BasePath: true, OriginPath: true},
		{Method: "POST", Path: "https://other.example/messages", BasePath: true},
		{Method: "POST", Path: "//other.example/messages", BasePath: true},
	} {
		if err := spec.Validate(); err == nil {
			t.Fatalf("invalid base path spec accepted: %#v", spec)
		}
	}
}

func TestWangsuBaseProtocolPreservesUnrelatedIDs(t *testing.T) {
	for _, id := range []string{"chat-completion", "custom-chat", "wangsu-unknown"} {
		if got := WangsuBaseProtocol(id); got != id {
			t.Fatalf("protocol %q was changed to %q", id, got)
		}
	}
}
