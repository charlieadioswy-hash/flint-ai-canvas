package app

import "strings"

func wangsuImageCapability(protocolID, modelName string, fallback *ImageCapabilityConfig) *ImageCapabilityConfig {
	switch protocolID {
	case "wangsu-images", "wangsu-openai-images", "wangsu-gemini-image", "wangsu-chat-image":
	default:
		return fallback
	}
	name := strings.ToLower(strings.TrimSpace(modelName))
	image := *fallback
	image.References.MaxImages = 0
	image.References.MaskSupported = false
	image.Size = ImageSizeConfig{Parameter: "size", Values: []string{"1024x1024", "1536x1024", "1024x1536"}, Default: "1024x1024", AllowCustom: true}
	image.Quality = ImageQualityConfig{Default: "auto"}
	image.TransparentBackground = VideoBooleanConfig{}
	image.ResponseFormat = ParameterSupport{Supported: true}
	image.OutputFormat = ParameterSupport{}
	image.MaxOutputs = 1
	if protocolID == "wangsu-gemini-image" || (protocolID == "wangsu-chat-image" && name != "qwen-image-edit") {
		image.References.MaxImages = fallback.References.MaxImages
		image.Size = ImageSizeConfig{Parameter: "aspect_ratio", Values: []string{"1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"}, Default: "1:1"}
		image.Quality = ImageQualityConfig{Supported: true, Values: []string{"1k", "2k", "4k"}, Default: "1k"}
		image.ResponseFormat.Supported = false
	} else if protocolID == "wangsu-chat-image" {
		image.References.MaxImages = 1
		image.Size = ImageSizeConfig{Parameter: "none", Default: "auto"}
		image.ResponseFormat.Supported = false
	} else if strings.HasPrefix(name, "gpt-image-") {
		image.References.MaxImages = 1
		image.References.MaskSupported = true
		image.Quality = ImageQualityConfig{Supported: true, Values: []string{"auto", "low", "high"}, Default: "auto"}
		if strings.HasPrefix(name, "gpt-image-2.5-") {
			image.Quality.Values = []string{"auto", "low", "medium", "high", "xhigh", "max"}
		}
		image.TransparentBackground.Supported = true
		image.OutputFormat.Supported = true
		image.MaxOutputs = 10
	}
	return &image
}

func wangsuVideoCapability(protocolID, modelName string, fallback *VideoCapabilityConfig) *VideoCapabilityConfig {
	if protocolID != "wangsu-videos" && protocolID != "wangsu-openai-videos" {
		return fallback
	}
	name := strings.ToLower(strings.TrimSpace(modelName))
	video := *fallback
	video.References = VideoReferenceConfig{PromptMaxChars: DefaultVideoPromptMaxChars, MaxImages: 1, MaxImageBytes: 30 * 1024 * 1024}
	// The shared gateway API does not document every model's optional size and
	// ratio fields. Leave them omitted until a model contract supplies them.
	video.Duration = VideoDurationConfig{Selection: "enum", Values: []int{5}, Default: 5}
	video.Ratios, video.Resolutions = []string{}, []string{}
	video.DefaultRatio, video.DefaultResolution = "", ""
	video.GenerateAudio, video.Watermark = VideoBooleanConfig{}, VideoBooleanConfig{}
	video.Operations = []string{"text_to_video", "image_to_video"}
	video.DefaultOperation = "text_to_video"
	if protocolID == "wangsu-openai-videos" {
		video.Duration = VideoDurationConfig{Selection: "enum", Values: []int{4, 8, 12}, Default: 4}
		video.Ratios = []string{"16:9", "9:16"}
		video.DefaultRatio = "16:9"
		video.Resolutions = []string{"720p"}
		video.DefaultResolution = "720p"
	} else if name == "minimax-hailuo-02" || name == "minimax-hailuo-2.3" {
		video.References.PromptMaxChars = 2000
		video.References.MaxImageBytes = 20 * 1024 * 1024
		if name == "minimax-hailuo-02" {
			video.References.MaxImages = 2
		}
		video.Duration = VideoDurationConfig{Selection: "enum", Values: []int{6, 10}, Default: 6}
		video.Resolutions = []string{"768P", "1080P"}
		if name == "minimax-hailuo-02" {
			video.Resolutions = []string{"512P", "768P", "1080P"}
		}
		video.DefaultResolution = "768P"
	} else if strings.HasPrefix(name, "doubao-seedance-2-") {
		v25 := strings.HasPrefix(name, "doubao-seedance-2-5-")
		video.References.MaxImages = 9
		video.References.MaxImageBytes = 10 * 1024 * 1024
		// The 2.0 gateway documents video references without a count. Expose one
		// by default until the administrator configures a larger verified limit.
		video.References.MaxVideos = 1
		video.References.MaxAudios = 3
		video.References.MaxAudioBytes = 15 * 1024 * 1024
		video.References.MaxAudioDuration = 15
		video.Duration = VideoDurationConfig{Selection: "range", Min: 4, Max: 15, Step: 1, Default: 5}
		video.Resolutions = []string{"480p", "720p", "4k"}
		if v25 {
			video.References.MaxVideos = 3
			video.References.MaxVideoBytes = 50 * 1024 * 1024
			video.References.MaxVideoDuration = 15
			video.Duration.Max = 30
			video.Resolutions = []string{"480p", "720p", "1080p"}
		}
		video.Ratios = []string{"16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"}
		video.DefaultRatio, video.DefaultResolution = "16:9", "720p"
		video.GenerateAudio = VideoBooleanConfig{Supported: true, Default: true}
		video.Operations = append(video.Operations, "reference_to_video", "audio_to_video")
	} else if name == "veo-3.1-generate-001" || name == "veo-3.1-fast-generate-001" {
		video.References.MaxImages = 3
		video.Duration = VideoDurationConfig{Selection: "enum", Values: []int{4, 6, 8}, Default: 8}
		video.Ratios = []string{"16:9", "9:16"}
		video.DefaultRatio = "16:9"
		video.Resolutions = []string{"720p", "1080p", "4k"}
		video.DefaultResolution = "720p"
		video.GenerateAudio = VideoBooleanConfig{Supported: true, Default: true}
		video.Operations = append(video.Operations, "reference_to_video")
	}
	return &video
}

func validateWangsuVideoTask(profile *VideoCapabilityConfig, input canvasGenerationInput) error {
	if input.Config.InterfaceType != "wangsu-videos" && input.Config.InterfaceType != "wangsu-openai-videos" {
		return nil
	}
	name := strings.ToLower(strings.TrimSpace(firstNonEmpty(input.Config.ProviderModelKey, input.Config.Model)))
	startID, endID := metadataString(input.Metadata, "videoStartFrameNodeId"), metadataString(input.Metadata, "videoEndFrameNodeId")
	operation := firstNonEmpty(metadataString(input.Metadata, "videoEditOperation"), metadataString(input.Metadata, "videoOperation"))
	if input.Config.InterfaceType == "wangsu-openai-videos" {
		if endID != "" || len(input.ReferenceImages) > 1 || len(input.ReferenceVideos) > 0 || len(input.ReferenceAudios) > 0 || operation == "reference_to_video" {
			return BadAuthRequest("Wangsu OpenAI 原生视频仅支持一张首帧图片，不支持尾帧或多模态参考")
		}
		return nil
	}
	resolution := input.Config.VQuality
	if isAutomaticVideoResolution(resolution) {
		resolution = profile.DefaultResolution
	}
	if (name == "minimax-hailuo-02" || name == "minimax-hailuo-2.3") && strings.TrimSpace(input.Config.VideoSeconds) == "10" && normalizeResolution(resolution) != "768p" {
		return BadAuthRequest("MiniMax Hailuo 的 10 秒视频仅支持 768P；其他分辨率请选择 6 秒")
	}
	if name == "veo-3.1-generate-001" || name == "veo-3.1-fast-generate-001" {
		if endID != "" && startID == "" {
			return BadAuthRequest("Veo 尾帧必须与首帧一起提供")
		}
		hasFrames := startID != "" || endID != ""
		hasReferences := len(input.ReferenceImages) > 0 && (!hasFrames || operation == "reference_to_video")
		for _, image := range input.ReferenceImages {
			if hasFrames && image.ID != startID && image.ID != endID {
				hasReferences = true
			}
		}
		if hasFrames && hasReferences {
			return BadAuthRequest("Veo 参考图片不能与首尾帧同时使用")
		}
		if hasReferences {
			ratio := firstNonEmpty(input.Config.Size, profile.DefaultRatio)
			if len(input.ReferenceImages) > 3 || strings.TrimSpace(input.Config.VideoSeconds) != "8" || ratio != "16:9" {
				return BadAuthRequest("Veo 参考图片生成最多支持 3 张图片，且必须选择 16:9、8 秒")
			}
		}
	}
	return nil
}
