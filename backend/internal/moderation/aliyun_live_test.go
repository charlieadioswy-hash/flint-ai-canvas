package moderation

import (
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// This opt-in probe is excluded from ordinary test runs. Its transport permits
// at most one paid request; credentials stay in memory and never enter logs.
func TestAliyunLiveSingleCall(t *testing.T) {
	if os.Getenv("CANVAS_IMAGE_MODERATION_LIVE_TEST") != "1" {
		t.Skip("live detection requires an explicit opt-in")
	}
	credentialFile := os.Getenv("CANVAS_IMAGE_MODERATION_CREDENTIALS_CSV")
	if credentialFile == "" {
		t.Fatal("missing credentials CSV path")
	}
	file, err := os.Open(credentialFile)
	if err != nil {
		t.Fatal("credentials CSV cannot be opened")
	}
	defer file.Close()
	rows, err := csv.NewReader(io.LimitReader(file, 32<<10)).ReadAll()
	if err != nil || len(rows) != 2 || len(rows[0]) != len(rows[1]) {
		t.Fatal("credentials CSV must contain exactly one key pair")
	}
	config := testConfig()
	config.Services = []string{"aigcCheck"}
	config.AccessKeyID, config.AccessKeySecret = "", ""
	for i, header := range rows[0] {
		switch strings.TrimSpace(strings.TrimPrefix(header, "\uFEFF")) {
		case "AccessKey ID":
			config.AccessKeyID = strings.TrimSpace(rows[1][i])
		case "AccessKey Secret":
			config.AccessKeySecret = strings.TrimSpace(rows[1][i])
		}
	}
	p := newAliyunProvider()
	if err := p.Validate(config); err != nil {
		t.Fatal("credentials CSV contains an invalid key pair")
	}
	var paid atomic.Int32
	base := p.httpClient.Transport
	p.httpClient.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if sdkAction(req) == "ImageModeration" && !paid.CompareAndSwap(0, 1) {
			return nil, errors.New("single-call live probe forbids repeated paid requests")
		}
		return base.RoundTrip(req)
	})
	defer func() { t.Logf("ImageModeration requests sent: %d (hard limit: 1)", paid.Load()) }()
	img := image.NewRGBA(image.Rect(0, 0, 256, 256))
	for y := 0; y < 256; y++ {
		for x := 0; x < 256; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 120, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, img); err != nil {
		t.Fatal("cannot encode probe image")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	result, err := p.Detect(ctx, config, Image{Data: encoded.Bytes(), Name: "probe.png", ContentType: "image/png"}, "aigcCheck")
	if err != nil {
		t.Fatal(err)
	}
	if paid.Load() != 1 || riskOrder(result.RiskLevel) < 0 {
		t.Fatal("live detection did not return a valid normalized result")
	}
	t.Logf("normalized risk: %s", result.RiskLevel)
}
