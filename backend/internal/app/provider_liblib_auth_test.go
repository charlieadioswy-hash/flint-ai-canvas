package app

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"net/http"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

func TestLiblibSignatureUsesActualPathAndFreshNonce(t *testing.T) {
	req, _ := http.NewRequest(http.MethodPost, "https://openapi.example/api/generate/webui/status?keep=yes&Signature=stale", strings.NewReader(`{"generateUuid":"task"}`))
	if err := signProtocolLiblibAt(req, "test-access", "test-secret", 1725458584000, "test-nonce"); err != nil {
		t.Fatal(err)
	}
	mac := hmac.New(sha1.New, []byte("test-secret"))
	_, _ = mac.Write([]byte("/api/generate/webui/status&1725458584000&test-nonce"))
	q := req.URL.Query()
	if q.Get("Signature") != base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) || strings.Contains(q.Get("Signature"), "=") {
		t.Fatalf("invalid signature: %q", q.Get("Signature"))
	}
	if q.Get("AccessKey") != "test-access" || q.Get("Timestamp") != "1725458584000" || q.Get("SignatureNonce") != "test-nonce" || q.Get("keep") != "yes" {
		t.Fatal("signed query lost required fields")
	}
	if strings.Contains(req.URL.String(), "test-secret") {
		t.Fatal("SecretKey leaked into URL")
	}
	old := q.Get("Signature")
	if err := signProtocolLiblibAt(req, "test-access", "test-secret", 1725458584000, "next-nonce"); err != nil {
		t.Fatal(err)
	}
	if req.URL.Query().Get("Signature") == old {
		t.Fatal("signature not refreshed")
	}
}

func TestLiblibAuthRequiresBothCredentials(t *testing.T) {
	req, _ := http.NewRequest(http.MethodPost, "https://example.com/api/generate/upload/signature", nil)
	auth := protocol.ManifestAuth{Type: "liblib-hmac-sha1", Field: "apiKey", SecretField: "secretKey"}
	if err := applyProtocolAuth(req, providerConfig{APIKey: "ak"}, auth); err == nil {
		t.Fatal("missing secret accepted")
	}
	if err := applyProtocolAuth(req, providerConfig{APIKey: "ak", SecretKey: "sk"}, auth); err != nil {
		t.Fatal(err)
	}
	if req.URL.Query().Get("Signature") == "" || req.URL.Query().Get("SignatureNonce") == "" {
		t.Fatal("auth driver did not sign")
	}
}

func TestLiblibChannelModelRequiresServerCredentials(t *testing.T) {
	request := ChannelModelRequest{ModelKey: "liblib", Capability: "image", Protocol: protocol.LiblibImageProtocolID}
	if _, _, _, _, err := normalizeChannelModelContractWithRegistry(protocol.Builtins(), &model.ModelChannel{APIKey: "access"}, request); err == nil {
		t.Fatal("Liblib model saved without SecretKey")
	}
	if _, _, _, _, err := normalizeChannelModelContractWithRegistry(protocol.Builtins(), &model.ModelChannel{APIKey: "access", SecretKey: "secret"}, request); err != nil {
		t.Fatal(err)
	}
}

func TestLiblibAuxiliaryRequestsHaveNoGenerationCost(t *testing.T) {
	for _, kind := range []string{"poll", "upload", "upload-signature"} {
		if providerRequestIsBillable(http.MethodPost, kind) {
			t.Fatalf("%s incorrectly billed", kind)
		}
		log := &model.ApiCallLog{RequestKind: kind, MediaCount: 4, InputTokens: 1000, OutputTokens: 1000, VideoSeconds: 30}
		(&Service{}).estimateCallCost(log)
		if log.EstimatedCostMicros != 0 || !log.CostAvailable {
			t.Fatalf("%s estimated again: %+v", kind, log)
		}
	}
	if !providerRequestIsBillable(http.MethodPost, "create") {
		t.Fatal("create classification changed")
	}
}
