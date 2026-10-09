package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"io"
	"strings"

	"yingce/backend/internal/generation"
	"yingce/backend/internal/model"
	"yingce/backend/internal/protocol"
)

func defaultLiblibControlNetCapability() *generation.ControlNetCapability {
	return &generation.ControlNetCapability{Supported: true, MaxUnits: 4, Preprocessors: []string{"canny"}}
}

func validateControlNetTask(profile *ImageCapabilityConfig, input canvasGenerationInput) error {
	if len(input.ControlNet) == 0 && input.OutputMask == nil {
		return nil
	}
	if input.Mode != "image" {
		return BadAuthRequest("结构控制和输出蒙版仅支持图片生成")
	}
	if len(input.ControlNet) > 0 {
		if profile == nil || profile.ControlNet == nil || !profile.ControlNet.Supported {
			return BadAuthRequest("当前模型未声明 ControlNet 能力，请选择支持结构控制的渠道模型")
		}
		capability := profile.ControlNet
		if len(input.ControlNet) > min(capability.MaxUnits, 4) {
			return BadAuthRequest("控制单元数量超过模型支持上限")
		}
		seen := map[string]bool{}
		for i, unit := range input.ControlNet {
			if strings.TrimSpace(unit.ID) == "" || seen[unit.ID] {
				return BadAuthRequest("控制单元 ID 必须非空且唯一")
			}
			seen[unit.ID] = true
			if err := unit.Parameters.Validate(false); err != nil {
				return BadAuthRequest(err.Error())
			}
			if !containsCapabilityString(capability.Preprocessors, unit.Parameters.Preprocessor) {
				return BadAuthRequest("当前模型不支持所选预处理器")
			}
			if len(capability.Models) > 0 && !containsCapabilityString(capability.Models, unit.Parameters.Model) {
				return BadAuthRequest("控制模型不在当前渠道模型的兼容目录内")
			}
			if err := validateControlMedia(unit.Image); err != nil {
				return BadAuthRequest(fmt.Sprintf("控制图 %d：%s", i+1, err))
			}
			if unit.Mask != nil {
				if err := validateControlMedia(*unit.Mask); err != nil {
					return err
				}
				if unit.Image.Width != unit.Mask.Width || unit.Image.Height != unit.Mask.Height {
					return BadAuthRequest("控制区域蒙版必须与对应控制图同尺寸")
				}
			}
		}
	}
	if mask := input.OutputMask; mask != nil {
		if mask.ResizeMode != "stretch" {
			return BadAuthRequest("输出蒙版须明确使用完整画幅缩放")
		}
		if mask.Mode != "luminance" && mask.Mode != "non-black" {
			return BadAuthRequest("输出蒙版模式无效")
		}
		if err := validateControlMedia(mask.Image); err != nil {
			return err
		}
		for _, unit := range input.ControlNet {
			if unit.Parameters.ResizeMode != "stretch" {
				return BadAuthRequest("使用输出蒙版时请选择直接缩放，避免控制图与输出范围错位")
			}
			if int64(unit.Image.Width)*int64(mask.Image.Height) != int64(unit.Image.Height)*int64(mask.Image.Width) {
				return BadAuthRequest("控制图与输出蒙版必须使用相同画幅比例")
			}
		}
	}
	return nil
}

func validateControlMedia(media generation.Media) error {
	if !strings.HasPrefix(media.StorageKey, "resource:") || strings.TrimSpace(strings.TrimPrefix(media.StorageKey, "resource:")) == "" {
		return BadAuthRequest("控制图和蒙版必须先上传为持久图片资源")
	}
	if media.Width < 1 || media.Height < 1 || media.Width > 4096 || media.Height > 4096 || media.Bytes < 1 || media.Bytes > 10<<20 {
		return BadAuthRequest("控制图和蒙版宽高须为 1–4096 且文件不超过 10 MB")
	}
	return nil
}

// Resolve resource facts before routing/charging and discard caller-supplied URLs
// and inline bytes so they cannot replace an owned resource during execution.
func (s *Service) prepareControlNetTaskInput(userID string, raw map[string]any) error {
	if raw["controlNet"] == nil && raw["outputMask"] == nil {
		return nil
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return BadAuthRequest("结构控制输入无效")
	}
	var input canvasGenerationInput
	if err := json.Unmarshal(data, &input); err != nil {
		return BadAuthRequest("结构控制输入无效")
	}
	if input.Mode != "image" {
		return BadAuthRequest("结构控制和输出蒙版仅支持图片生成")
	}
	if len(input.ControlNet) > 4 {
		return BadAuthRequest("最多配置四组结构控制")
	}
	resolve := func(media *generation.Media) error {
		if !strings.HasPrefix(media.StorageKey, "resource:") {
			return BadAuthRequest("请先上传控制图和蒙版")
		}
		id := strings.TrimPrefix(media.StorageKey, "resource:")
		resource, err := s.repo.ResourceForUser(userID, id)
		if err != nil || resource.Status != model.ResourceStatusReady || !strings.HasPrefix(resource.MimeType, "image/") {
			return BadAuthRequest("控制图或蒙版资源不存在、不可访问或未就绪")
		}
		_, body, err := s.OpenResource(userID, id)
		if err != nil {
			return err
		}
		data, readErr := io.ReadAll(io.LimitReader(body, (10<<20)+1))
		body.Close()
		if readErr != nil {
			return readErr
		}
		if err := inspectControlImage(data, media); err != nil {
			return err
		}
		media.URL, media.DataURL = "", ""
		return validateControlMedia(*media)
	}
	for i := range input.ControlNet {
		if err := resolve(&input.ControlNet[i].Image); err != nil {
			return err
		}
		if input.ControlNet[i].Mask != nil {
			if err := resolve(input.ControlNet[i].Mask); err != nil {
				return err
			}
		}
	}
	if input.OutputMask != nil {
		if err := resolve(&input.OutputMask.Image); err != nil {
			return err
		}
	}
	// Keep the normalized JSON representation used by model routing and task persistence.
	data, err = json.Marshal(input.ControlNet)
	if err != nil {
		return err
	}
	var controls any
	if err := json.Unmarshal(data, &controls); err != nil {
		return err
	}
	raw["controlNet"] = controls
	if input.OutputMask != nil {
		data, err = json.Marshal(input.OutputMask)
		if err != nil {
			return err
		}
		var mask any
		if err := json.Unmarshal(data, &mask); err != nil {
			return err
		}
		raw["outputMask"] = mask
	}
	return nil
}

// Upload dimensions are client metadata. Decode owned bytes before charging so
// malformed images and misaligned masks do not fail only after upstream work.
func inspectControlImage(data []byte, media *generation.Media) error {
	if len(data) == 0 || len(data) > 10<<20 {
		return BadAuthRequest("控制图和蒙版必须为非空且不超过 10 MB 的图片")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "png" && format != "jpeg") {
		return BadAuthRequest("控制图和蒙版仅支持有效 PNG 或 JPEG 图片")
	}
	if config.Width < 1 || config.Height < 1 || config.Width > 4096 || config.Height > 4096 {
		return BadAuthRequest("控制图和蒙版宽高须为 1–4096")
	}
	if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
		return BadAuthRequest("控制图或蒙版图片内容损坏")
	}
	media.Width, media.Height, media.Bytes = config.Width, config.Height, int64(len(data))
	media.MimeType = "image/" + format
	return nil
}

func validateControlledImageExecutor(ctx context.Context, input canvasGenerationInput) error {
	if len(input.ControlNet) == 0 && input.OutputMask == nil {
		return nil
	}
	if input.Mode != "image" || isWorkflowProviderInterface(input.Config.InterfaceType) {
		return BadAuthRequest("当前生成流程不支持结构控制或输出蒙版")
	}
	adapter, ok := protocolAdapterForContext(ctx, input.Config.InterfaceType)
	if !ok || (len(input.ControlNet) > 0 && !adapter.Metadata().SupportsControlNet) {
		return BadAuthRequest("当前渠道协议未实现 ControlNet")
	}
	if !protocol.UsesProtocolTaskHost(adapter.Metadata()) {
		return BadAuthRequest("当前渠道尚未接入输出蒙版保存流程")
	}
	return nil
}

func (s *Service) hydrateControlNetMedia(userID string, input *canvasGenerationInput) error {
	for i := range input.ControlNet {
		hydrate := func(media *generation.Media) error {
			value := providerMedia(*media)
			if err := s.hydrateProviderMedia(userID, &value, providerMediaHydrationPolicy{imageOnly: true, maxBytes: 10 << 20}); err != nil {
				return err
			}
			*media = generation.Media(value)
			_, data, err := decodeProviderDataURL(value.DataURL)
			if err != nil {
				return err
			}
			if err := inspectControlImage(data, media); err != nil {
				return err
			}
			return nil
		}
		if err := hydrate(&input.ControlNet[i].Image); err != nil {
			return err
		}
		if input.ControlNet[i].Mask != nil {
			if err := hydrate(input.ControlNet[i].Mask); err != nil {
				return err
			}
		}
	}
	return nil
}
