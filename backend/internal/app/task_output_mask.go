package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"

	"yingce/backend/internal/generation"
	"yingce/backend/internal/model"
)

// Compressed image size does not bound decoder memory. Both the source and the
// mask are checked before Decode, including when restoring an expired result.
const outputMaskMaxPixels int64 = 32 << 20
const outputMaskMaxBytes int64 = 64 << 20

func (s *Service) taskOutputMask(task *model.Task) (*generation.OutputMask, error) {
	if strings.TrimSpace(task.InputJSON) == "" {
		return nil, nil
	}
	raw, err := s.decryptTaskInputJSON(task.InputJSON)
	if err != nil {
		return nil, err
	}
	var input struct {
		OutputMask *generation.OutputMask `json:"outputMask"`
	}
	if err := json.Unmarshal([]byte(raw), &input); err != nil {
		return nil, err
	}
	return input.OutputMask, nil
}

func (s *Service) readOutputMask(userID string, mask *generation.OutputMask) ([]byte, error) {
	if mask.Mode != "luminance" && mask.Mode != "non-black" {
		return nil, errors.New("输出蒙版模式无效")
	}
	if mask.ResizeMode != "stretch" {
		return nil, errors.New("输出蒙版必须明确使用整幅拉伸")
	}
	media := mask.Image
	if strings.HasPrefix(media.StorageKey, "resource:") {
		resource, body, err := s.OpenResource(userID, strings.TrimPrefix(media.StorageKey, "resource:"))
		if err != nil {
			return nil, fmt.Errorf("读取输出蒙版失败：%w", err)
		}
		defer body.Close()
		if resource.Kind != "image" || !strings.HasPrefix(resource.MimeType, "image/") || resource.Size > outputMaskMaxBytes {
			return nil, errors.New("输出蒙版必须是大小不超过 64 MiB 的图片")
		}
		data, err := io.ReadAll(io.LimitReader(body, outputMaskMaxBytes+1))
		if err != nil {
			return nil, err
		}
		if int64(len(data)) > outputMaskMaxBytes {
			return nil, errors.New("输出蒙版文件超过读取上限")
		}
		return data, nil
	}
	// A mutable remote URL is not a recoverable mask snapshot. The task admission
	// path must persist it as an owned resource before submitting generation.
	return nil, errors.New("输出蒙版必须使用已上传资源")
}

func decodeOutputMaskImage(reader io.ReadSeeker, byteLimit int64) (image.Image, error) {
	size, err := reader.Seek(0, io.SeekEnd)
	if err != nil {
		return nil, err
	}
	if size <= 0 || size > byteLimit {
		return nil, errors.New("蒙版合成图片为空或超过文件大小限制")
	}
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	config, format, err := image.DecodeConfig(reader)
	if err != nil {
		return nil, fmt.Errorf("蒙版合成图片无法解码：%w", err)
	}
	if format != "png" && format != "jpeg" && format != "webp" {
		return nil, errors.New("蒙版合成仅支持 PNG、JPEG 和 WebP 图片")
	}
	if config.Width <= 0 || config.Height <= 0 || int64(config.Width) > outputMaskMaxPixels/int64(config.Height) {
		return nil, errors.New("蒙版合成图片尺寸超过 32 M 像素限制")
	}
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	decoded, _, err := image.Decode(io.LimitReader(reader, byteLimit))
	if err != nil {
		return nil, fmt.Errorf("蒙版合成图片无法解码：%w", err)
	}
	if decoded.Bounds().Dx() != config.Width || decoded.Bounds().Dy() != config.Height {
		return nil, errors.New("蒙版合成图片尺寸不一致")
	}
	return decoded, nil
}

func compositeOutputMask(ctx context.Context, source, mask image.Image, mode, resizeMode string) (*image.NRGBA, error) {
	if mode != "luminance" && mode != "non-black" {
		return nil, errors.New("输出蒙版模式无效")
	}
	if resizeMode != "stretch" {
		return nil, errors.New("输出蒙版必须明确使用整幅拉伸")
	}
	sb, maskBounds := source.Bounds(), mask.Bounds()
	w, h, mw, mh := sb.Dx(), sb.Dy(), maskBounds.Dx(), maskBounds.Dy()
	if w <= 0 || h <= 0 || mw <= 0 || mh <= 0 || int64(w) > outputMaskMaxPixels/int64(h) || int64(mw) > outputMaskMaxPixels/int64(mh) {
		return nil, errors.New("蒙版合成图片尺寸无效")
	}
	result := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		// Nearest-neighbour full-frame mapping keeps binary boundaries binary and
		// avoids cropping or feathering pixels outside the declared region.
		my := maskBounds.Min.Y + y*mh/h
		for x := 0; x < w; x++ {
			mr, mg, mb, ma := mask.At(maskBounds.Min.X+x*mw/w, my).RGBA()
			coverage := uint64(0)
			if mode == "non-black" {
				if mr != 0 || mg != 0 || mb != 0 {
					coverage = uint64(ma)
				}
			} else {
				// RGBA channels are premultiplied: hidden RGB in transparent mask
				// pixels cannot open a region, and partial alpha is applied once.
				coverage = (299*uint64(mr) + 587*uint64(mg) + 114*uint64(mb) + 500) / 1000
			}
			r, g, b, _ := source.At(sb.Min.X+x, sb.Min.Y+y).RGBA()
			channel := func(value uint32) uint8 {
				return uint8((uint64(value)*coverage + 65535*257/2) / (65535 * 257))
			}
			result.SetNRGBA(x, y, color.NRGBA{R: channel(r), G: channel(g), B: channel(b), A: 255})
		}
	}
	return result, nil
}

func (s *Service) stageOutputMaskedImage(ctx context.Context, sourcePath string, maskData []byte, mode, resizeMode string) (name string, err error) {
	info, err := os.Lstat(sourcePath)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("待合成图片不是普通文件")
	}
	sourceFile, err := os.Open(sourcePath)
	if err != nil {
		return "", err
	}
	defer sourceFile.Close()
	policy, err := s.RuntimePolicy()
	if err != nil {
		return "", err
	}
	limit := min(megabytes(policy.Resource.GeneratedFileMB), outputMaskMaxBytes)
	source, err := decodeOutputMaskImage(sourceFile, limit)
	if err != nil {
		return "", err
	}
	mask, err := decodeOutputMaskImage(bytes.NewReader(maskData), outputMaskMaxBytes)
	if err != nil {
		return "", err
	}
	result, err := compositeOutputMask(ctx, source, mask, mode, resizeMode)
	if err != nil {
		return "", err
	}
	file, err := s.newMediaTemp(limit)
	if err != nil {
		return "", err
	}
	defer func() {
		_ = file.Close()
		if err != nil {
			_ = os.Remove(file.Name())
		}
	}()
	writer := &outputMaskLimitedWriter{writer: file, remaining: limit}
	if err = png.Encode(writer, result); err != nil {
		return "", err
	}
	if err = file.Truncate(limit - writer.remaining); err != nil {
		return "", err
	}
	if err = file.Sync(); err != nil {
		return "", err
	}
	if err = file.Close(); err != nil {
		return "", err
	}
	return filepath.Base(file.Name()), nil
}

type outputMaskLimitedWriter struct {
	writer    io.Writer
	remaining int64
}

func (w *outputMaskLimitedWriter) Write(data []byte) (int, error) {
	if int64(len(data)) > w.remaining {
		return 0, errors.New("蒙版合成后的 PNG 超过生成文件大小限制")
	}
	n, err := w.writer.Write(data)
	w.remaining -= int64(n)
	return n, err
}
