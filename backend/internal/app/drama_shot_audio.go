package app

import (
	"strings"
	"unicode/utf8"

	"yingce/backend/internal/model"
)

func normalizeDramaShotAudioConfig(config DramaShotMediaConfig) (DramaShotMediaConfig, error) {
	config.Prompt, config.AudioVoice, config.AudioInstructions = strings.TrimSpace(config.Prompt), strings.TrimSpace(config.AudioVoice), strings.TrimSpace(config.AudioInstructions)
	if config.Operation != "audio" {
		return config, BadAuthRequest("独立镜头音频需要使用文字转语音模式")
	}
	if config.Prompt == "" {
		return config, BadAuthRequest("镜头朗读文本不能为空")
	}
	if utf8.RuneCountInString(config.Prompt) > 1000 {
		return config, BadAuthRequest("镜头朗读文本不超过 1000 字")
	}
	if config.AudioVoice == "" {
		return config, BadAuthRequest("请选择模型音色")
	}
	if len(config.AudioVoice) > 160 {
		return config, BadAuthRequest("音色标识不超过 160 字节")
	}
	if utf8.RuneCountInString(config.AudioInstructions) > 4000 {
		return config, BadAuthRequest("音频演绎要求不超过 4000 字")
	}
	if len(config.ReferenceResourceIDs) > 0 || config.FirstFrameResourceID != "" || config.LastFrameResourceID != "" || config.AspectRatio != "" || config.Resolution != "" || config.Seconds != 0 || config.GenerateAudio {
		return config, BadAuthRequest("独立语音不能携带图片、首尾帧或视频规格")
	}
	return config, nil
}

func dramaShotAudioInput(shot model.DramaShot, config DramaShotMediaConfig) map[string]any {
	providerConfig := map[string]any{"audioVoice": config.AudioVoice, "audioFormat": "mp3", "audioSpeed": "1", "audioInstructions": config.AudioInstructions}
	if config.Model.ChannelID != "" {
		providerConfig["channelId"], providerConfig["model"], providerConfig["channelModelKey"] = config.Model.ChannelID, config.Model.ModelKey, config.Model.ModelKey
	}
	return map[string]any{"mode": "audio", "prompt": config.Prompt, "config": providerConfig, "metadata": map[string]any{"source": "drama_shot_media", "domainProjectId": shot.ProjectID, "episodeId": shot.EpisodeID, "dramaShotId": shot.ID}}
}
