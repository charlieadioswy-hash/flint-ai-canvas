package app

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"gorm.io/gorm"

	"yingce/backend/internal/generation"
	"yingce/backend/internal/model"
	"yingce/backend/internal/protocol"
)

func outputMaskPNG(t *testing.T, picture image.Image) []byte {
	t.Helper()
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, picture); err != nil {
		t.Fatal(err)
	}
	return encoded.Bytes()
}

func outputMaskRow(colors ...color.NRGBA) *image.NRGBA {
	picture := image.NewNRGBA(image.Rect(0, 0, len(colors), 1))
	for x, pixel := range colors {
		picture.SetNRGBA(x, 0, pixel)
	}
	return picture
}

func TestCompositeOutputMaskRGBUnionAndTransparency(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 6, 1))
	for x := range 6 {
		source.SetNRGBA(x, 0, color.NRGBA{R: 200, G: 100, B: 50, A: 255})
	}
	mask := outputMaskRow(
		color.NRGBA{A: 255},
		color.NRGBA{R: 255, A: 255},
		color.NRGBA{G: 255, A: 255},
		color.NRGBA{B: 255, A: 255},
		color.NRGBA{R: 255, G: 255, B: 255},
		color.NRGBA{R: 255, G: 255, B: 255, A: 128},
	)
	result, err := compositeOutputMask(context.Background(), source, mask, "non-black", "stretch")
	if err != nil {
		t.Fatal(err)
	}
	want := []color.NRGBA{{A: 255}, {R: 200, G: 100, B: 50, A: 255}, {R: 200, G: 100, B: 50, A: 255}, {R: 200, G: 100, B: 50, A: 255}, {A: 255}, {R: 100, G: 50, B: 25, A: 255}}
	for x, pixel := range want {
		if got := result.NRGBAAt(x, 0); got != pixel {
			t.Fatalf("pixel %d = %+v, want %+v", x, got, pixel)
		}
	}
}

func TestCompositeOutputMaskLuminanceUsesAlphaOnce(t *testing.T) {
	source := outputMaskRow(color.NRGBA{R: 255, G: 255, B: 255, A: 255}, color.NRGBA{R: 255, G: 255, B: 255, A: 255}, color.NRGBA{R: 255, G: 255, B: 255, A: 128})
	mask := outputMaskRow(color.NRGBA{R: 128, G: 128, B: 128, A: 255}, color.NRGBA{R: 255, G: 255, B: 255, A: 128}, color.NRGBA{R: 255, G: 255, B: 255, A: 255})
	result, err := compositeOutputMask(context.Background(), source, mask, "luminance", "stretch")
	if err != nil {
		t.Fatal(err)
	}
	for x := range 3 {
		if got := result.NRGBAAt(x, 0); got != (color.NRGBA{R: 128, G: 128, B: 128, A: 255}) {
			t.Fatalf("pixel %d applied alpha incorrectly: %+v", x, got)
		}
	}
}

func TestCompositeOutputMaskExplicitFullFrameStretch(t *testing.T) {
	source := image.NewNRGBA(image.Rect(10, 20, 14, 24))
	for y := 20; y < 24; y++ {
		for x := 10; x < 14; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: 255, A: 255})
		}
	}
	mask := image.NewNRGBA(image.Rect(5, 5, 7, 6))
	mask.SetNRGBA(5, 5, color.NRGBA{R: 255, G: 255, B: 255, A: 255})
	result, err := compositeOutputMask(context.Background(), source, mask, "luminance", "stretch")
	if err != nil {
		t.Fatal(err)
	}
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			want := color.NRGBA{A: 255}
			if x < 2 {
				want.R = 255
			}
			if got := result.NRGBAAt(x, y); got != want {
				t.Fatalf("(%d,%d) = %+v, want %+v", x, y, got, want)
			}
		}
	}
	for _, resizeMode := range []string{"", "crop", "fill"} {
		if _, err := compositeOutputMask(context.Background(), source, mask, "luminance", resizeMode); err == nil {
			t.Fatalf("implicit or unsupported mapping %q accepted", resizeMode)
		}
	}
	if _, err := compositeOutputMask(context.Background(), source, mask, "unknown", "stretch"); err == nil {
		t.Fatal("unknown mask mode accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := compositeOutputMask(ctx, source, mask, "luminance", "stretch"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
}

func TestDecodeOutputMaskImageLimitsBeforeAllocation(t *testing.T) {
	pngData := outputMaskPNG(t, outputMaskRow(color.NRGBA{A: 255}))
	if _, err := decodeOutputMaskImage(bytes.NewReader(pngData), int64(len(pngData)-1)); err == nil {
		t.Fatal("encoded byte limit ignored")
	}
	oversized := append([]byte(nil), pngData...)
	binary.BigEndian.PutUint32(oversized[16:20], 65535)
	binary.BigEndian.PutUint32(oversized[20:24], 65535)
	binary.BigEndian.PutUint32(oversized[29:33], crc32.ChecksumIEEE(oversized[12:29]))
	if _, err := decodeOutputMaskImage(bytes.NewReader(oversized), outputMaskMaxBytes); err == nil || !strings.Contains(err.Error(), "像素限制") {
		t.Fatalf("pixel bomb was not rejected before decode: %v", err)
	}
	var gifData bytes.Buffer
	if err := gif.Encode(&gifData, outputMaskRow(color.NRGBA{A: 255}), nil); err != nil {
		t.Fatal(err)
	}
	for _, data := range [][]byte{nil, []byte("not an image"), pngData[:len(pngData)-15], gifData.Bytes()} {
		if _, err := decodeOutputMaskImage(bytes.NewReader(data), outputMaskMaxBytes); err == nil {
			t.Fatal("invalid, truncated or unsupported image accepted")
		}
	}
	var output bytes.Buffer
	writer := &outputMaskLimitedWriter{writer: &output, remaining: 2}
	if _, err := writer.Write([]byte("abc")); err == nil || output.Len() != 0 {
		t.Fatal("output byte limit did not reject entire overflowing write")
	}
}

func seedTaskOutputMask(t *testing.T, s *Service, db *gorm.DB, task *model.Task, mask image.Image, mode string) *model.Resource {
	t.Helper()
	data := outputMaskPNG(t, mask)
	resource, _, err := s.storeResource(task.UserID, "image", "mask.png", "image/png", int64(len(data)), mask.Bounds().Dx(), mask.Bounds().Dy(), 0, bytes.NewReader(data), nil, true)
	if err != nil {
		t.Fatal(err)
	}
	var input canvasGenerationInput
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	input.OutputMask = &generation.OutputMask{Image: generation.Media{StorageKey: "resource:" + resource.ID}, Mode: mode, ResizeMode: "stretch"}
	encoded, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	task.InputJSON = string(encoded)
	if err := db.Model(task).Update("input_json", task.InputJSON).Error; err != nil {
		t.Fatal(err)
	}
	return resource
}

func TestReadOutputMaskRequiresOwnedImmutableResource(t *testing.T) {
	s, db := newMediaRecoveryTestService(t)
	task := seedMediaTask(t, db, providerConfig{})
	picture := outputMaskRow(color.NRGBA{R: 255, A: 255})
	resource := seedTaskOutputMask(t, s, db, task, picture, "non-black")
	mask := &generation.OutputMask{Mode: "non-black", ResizeMode: "stretch", Image: generation.Media{StorageKey: "resource:" + resource.ID, DataURL: "data:image/png;base64,spoofed"}}
	data, err := s.readOutputMask(task.UserID, mask)
	if err != nil || !bytes.Equal(data, outputMaskPNG(t, picture)) {
		t.Fatalf("owned resource was replaced by inline content: %v", err)
	}
	if _, err := s.readOutputMask("other-user", mask); err == nil {
		t.Fatal("foreign mask resource accepted")
	}
	for _, media := range []generation.Media{{URL: "https://example.com/mutable.png"}, {DataURL: dataURL("image/png", data)}} {
		mask.Image = media
		if _, err := s.readOutputMask(task.UserID, mask); err == nil {
			t.Fatal("unowned mask accepted")
		}
	}
}

func TestOutputMaskRecoveryPersistsPNGAndDoesNotCompound(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, expireStagedResult := range []bool{false, true} {
		t.Run(map[bool]string{false: "staged PNG", true: "redownload original"}[expireStagedResult], func(t *testing.T) {
			s, db := newMediaRecoveryTestService(t)
			source := outputMaskPNG(t, outputMaskRow(color.NRGBA{R: 255, G: 255, B: 255, A: 255}, color.NRGBA{R: 255, A: 255}))
			var downloads atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				downloads.Add(1)
				w.Header().Set("Content-Type", "image/png")
				_, _ = w.Write(source)
			}))
			defer server.Close()
			task := seedMediaTask(t, db, providerConfig{BaseURL: server.URL})
			seedTaskOutputMask(t, s, db, task, outputMaskRow(color.NRGBA{R: 128, G: 128, B: 128, A: 255}, color.NRGBA{A: 255}), "luminance")
			seedOSSEnabled(t, db, task.UserID, "http://127.0.0.1:1")
			temp, err := s.stageInlineMedia(source)
			if err != nil {
				t.Fatal(err)
			}
			checkpoint := &mediaCheckpoint{Mode: "image", StartedAt: time.Now(), Items: []mediaCheckpointItem{{TempName: temp, MIMEType: "image/png", Reference: protocol.MediaReference{URL: server.URL + "/image"}}}}
			_, failure := s.materializeTaskMedia(context.Background(), task, providerConfig{}, checkpoint)
			var delivery *mediaRecoveryError
			if !errors.As(failure, &delivery) || delivery.stage != "upload" {
				t.Fatalf("expected upload failure after masking, got %v", failure)
			}
			saved, err := s.decodeMediaCheckpoint(task)
			if err != nil || !saved.Items[0].OutputMaskApplied || saved.Items[0].TempName == temp || saved.Items[0].MIMEType != "image/png" {
				t.Fatalf("masked PNG was not checkpointed: %+v, %v", saved, err)
			}
			if _, err := os.Stat(s.mediaTempPath(temp)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("unmasked source retained after successful checkpoint")
			}
			resource, err := s.resourceForUploadKey(task.UserID, mediaUploadKey(task.ID, 0))
			if err != nil || resource == nil {
				t.Fatalf("missing failed upload identity: %v", err)
			}
			resource.Provider, resource.ObjectKey = "local", "recovered/masked.png"
			if err := s.repo.SaveResource(resource); err != nil {
				t.Fatal(err)
			}
			if expireStagedResult {
				if err := os.Remove(s.mediaTempPath(saved.Items[0].TempName)); err != nil {
					t.Fatal(err)
				}
			}
			reloaded, err := s.repo.Task(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.resumeTaskMedia(context.Background(), reloaded); err != nil {
				t.Fatal(err)
			}
			ready, body, err := s.OpenResource(task.UserID, resource.ID)
			if err != nil {
				t.Fatal(err)
			}
			defer body.Close()
			data, err := io.ReadAll(body)
			if err != nil {
				t.Fatal(err)
			}
			decoded, format, err := image.Decode(bytes.NewReader(data))
			if err != nil || format != "png" || ready.MimeType != "image/png" || ready.Width != 2 || ready.Height != 1 {
				t.Fatalf("final resource metadata differs: %+v, %s, %v", ready, format, err)
			}
			if got := color.NRGBAModel.Convert(decoded.At(0, 0)); got != (color.NRGBA{R: 128, G: 128, B: 128, A: 255}) {
				t.Fatalf("restore compounded feather: %+v", got)
			}
			if got := color.NRGBAModel.Convert(decoded.At(1, 0)); got != (color.NRGBA{A: 255}) {
				t.Fatalf("outside mask leaked pixels: %+v", got)
			}
			if got := downloads.Load(); got != map[bool]int32{false: 0, true: 1}[expireStagedResult] {
				t.Fatalf("unexpected downloads: %d", got)
			}
			if _, err := s.resumeTaskMedia(context.Background(), reloaded); err != nil {
				t.Fatal("already materialized result should be idempotent", err)
			}
		})
	}
}

func TestOutputMaskCheckpointFailureKeepsOriginal(t *testing.T) {
	s, db := newMediaRecoveryTestService(t)
	task := seedMediaTask(t, db, providerConfig{})
	seedTaskOutputMask(t, s, db, task, outputMaskRow(color.NRGBA{R: 128, G: 128, B: 128, A: 255}), "luminance")
	source := outputMaskPNG(t, outputMaskRow(color.NRGBA{R: 255, A: 255}))
	temp, err := s.stageInlineMedia(source)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint := &mediaCheckpoint{Mode: "image", StartedAt: time.Now(), Items: []mediaCheckpointItem{{TempName: temp, MIMEType: "image/png"}}}
	if err := s.saveMediaCheckpoint(task, checkpoint, "download"); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`CREATE TRIGGER reject_mask_checkpoint BEFORE UPDATE OF media_recovery_json ON tasks WHEN OLD.media_stage = 'output_mask' AND NEW.media_stage = 'output_mask' BEGIN SELECT RAISE(ABORT, 'injected checkpoint failure'); END`).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.materializeTaskMedia(context.Background(), task, providerConfig{}, checkpoint); err == nil {
		t.Fatal("checkpoint failure was ignored")
	}
	if checkpoint.Items[0].OutputMaskApplied || checkpoint.Items[0].TempName != temp {
		t.Fatal("failed checkpoint changed in-memory source identity")
	}
	data, err := os.ReadFile(s.mediaTempPath(temp))
	if err != nil || !bytes.Equal(data, source) {
		t.Fatalf("unmasked source lost after checkpoint failure: %v", err)
	}
	if err := db.Exec(`DROP TRIGGER reject_mask_checkpoint`).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.resumeTaskMedia(context.Background(), task); err != nil {
		t.Fatal("retry should start from intact original", err)
	}
}
