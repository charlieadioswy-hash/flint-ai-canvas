package app

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime"
	"mime/multipart"
	"testing"
)

func TestLiblibCannyBlackBackgroundPreservesVisibleColorsAndOpaqueBytes(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	source.SetNRGBA(0, 0, color.NRGBA{R: 255, G: 91, B: 37, A: 0})
	source.SetNRGBA(1, 0, color.NRGBA{R: 255, A: 255})
	source.SetNRGBA(0, 1, color.NRGBA{G: 255, A: 255})
	source.SetNRGBA(1, 1, color.NRGBA{B: 255, A: 128})
	raw := outputMaskPNG(t, source)
	original := append([]byte(nil), raw...)
	converted, changed, err := liblibCannyImagePNG(raw)
	if err != nil || !changed || !bytes.Equal(raw, original) {
		t.Fatalf("control conversion failed or modified the input bytes: changed=%v err=%v", changed, err)
	}
	result, err := png.Decode(bytes.NewReader(converted))
	if err != nil || result.Bounds() != source.Bounds() {
		t.Fatalf("control geometry changed: %v", err)
	}
	for index, want := range []color.NRGBA{{A: 255}, {R: 255, A: 255}, {G: 255, A: 255}, {B: 128, A: 255}} {
		if got := color.NRGBAModel.Convert(result.At(index%2, index/2)).(color.NRGBA); got != want {
			t.Fatalf("pixel %d = %+v, want %+v", index, got, want)
		}
	}
	opaque := outputMaskPNG(t, outputMaskRow(color.NRGBA{R: 13, G: 61, B: 155, A: 255}))
	unchanged, changed, err := liblibCannyImagePNG(opaque)
	if err != nil || changed || !bytes.Equal(unchanged, opaque) {
		t.Fatalf("opaque input must retain its original encoding: changed=%v err=%v", changed, err)
	}

	// A transparent 16-bit PNG must retain the precision of opaque RGB pixels.
	deep := image.NewNRGBA64(image.Rect(0, 0, 2, 1))
	want := color.NRGBA64{R: 12345, G: 23456, B: 34567, A: 0xffff}
	deep.SetNRGBA64(1, 0, want)
	converted, changed, err = liblibCannyImagePNG(outputMaskPNG(t, deep))
	if err != nil || !changed {
		t.Fatalf("16-bit conversion failed: %v", err)
	}
	result, err = png.Decode(bytes.NewReader(converted))
	if err != nil || color.NRGBA64Model.Convert(result.At(1, 0)).(color.NRGBA64) != want {
		t.Fatalf("16-bit opaque color changed: %v", err)
	}
}

func TestLiblibInpaintMaskKeepsCanvasTransparencyAndScreenLuminanceDistinct(t *testing.T) {
	for _, test := range []struct {
		name, mode string
		pixels     []color.NRGBA
		want       []uint8
	}{
		{"canvas alpha default", "", []color.NRGBA{{R: 255, G: 255, B: 255, A: 255}, {R: 255, G: 255, B: 255, A: 0}, {A: 128}}, []uint8{0, 255, 127}},
		{"explicit alpha", "alpha", []color.NRGBA{{A: 255}, {R: 255, A: 0}}, []uint8{0, 255}},
		{"screen luminance", "luminance", []color.NRGBA{{A: 255}, {R: 255, G: 255, B: 255, A: 255}, {R: 128, G: 128, B: 128, A: 255}, {R: 255, G: 255, B: 255, A: 0}}, []uint8{0, 255, 128, 0}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var encoded bytes.Buffer
			if err := png.Encode(&encoded, outputMaskRow(test.pixels...)); err != nil {
				t.Fatal(err)
			}
			converted, err := liblibInpaintMaskPNG(encoded.Bytes(), test.mode)
			if err != nil {
				t.Fatal(err)
			}
			result, format, err := image.Decode(bytes.NewReader(converted))
			if err != nil || format != "png" || result.Bounds().Dx() != len(test.want) || result.Bounds().Dy() != 1 {
				t.Fatalf("mask dimensions or format changed: format=%q err=%v", format, err)
			}
			for x, want := range test.want {
				r, g, b, a := result.At(x, 0).RGBA()
				if r>>8 != uint32(want) || g != r || b != r || a != 0xffff {
					t.Fatalf("pixel %d = (%d,%d,%d,%d), want opaque gray %d", x, r, g, b, a, want)
				}
			}
		})
	}
	var opaque bytes.Buffer
	_ = png.Encode(&opaque, outputMaskRow(color.NRGBA{R: 255, G: 255, B: 255, A: 255}))
	if _, err := liblibInpaintMaskPNG(opaque.Bytes(), "alpha"); err == nil {
		t.Fatal("opaque alpha mask with no selected area accepted")
	}
	if _, err := liblibInpaintMaskPNG(opaque.Bytes(), "guess"); err == nil {
		t.Fatal("unknown mask interpretation accepted")
	}
}

func TestLiblibOSSFormUsesV4CredentialsAndFileLast(t *testing.T) {
	for _, mediaType := range []string{"image/png", "image/jpeg"} {
		t.Run(mediaType, func(t *testing.T) {
			s := liblibUploadSignature{Key: "inputs/picture.png", Policy: "temporary-policy", Date: "20260101T000000Z", Credential: "temporary-credential", Version: "OSS4-HMAC-SHA256", Signature: "temporary-signature"}
			data, contentType, err := liblibUploadMultipart(s, "picture.png", []byte("image-bytes"), mediaType)
			if err != nil {
				t.Fatal(err)
			}
			_, params, err := mime.ParseMediaType(contentType)
			if err != nil {
				t.Fatal(err)
			}
			reader := multipart.NewReader(bytes.NewReader(data), params["boundary"])
			fields := map[string]string{}
			last := ""
			for {
				part, err := reader.NextPart()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Fatal(err)
				}
				value, _ := io.ReadAll(part)
				fields[part.FormName()] = string(value)
				last = part.FormName()
				if last == "file" && part.Header.Get("Content-Type") != mediaType {
					t.Fatalf("file Content-Type = %q, want %q", part.Header.Get("Content-Type"), mediaType)
				}
				if last == "file" && part.Header.Get("Content-Disposition") != `form-data; name="file"; filename="picture.png"` {
					t.Fatalf("OSS requires quoted disposition parameters: %q", part.Header.Get("Content-Disposition"))
				}
			}
			if last != "file" || fields["file"] != "image-bytes" || fields["x-oss-signature"] != s.Signature || fields["x-oss-credential"] != s.Credential || fields["policy"] != s.Policy {
				t.Fatalf("invalid OSS form: %+v", fields)
			}
			for _, forbidden := range []string{"AccessKey", "SecretKey", "Signature", "Authorization"} {
				if _, ok := fields[forbidden]; ok {
					t.Fatalf("channel credential sent to OSS: %s", forbidden)
				}
			}
		})
	}
}
