package app

import "yingce/backend/internal/production"

// 绘图配置属于作品共享主体，不随单集风格覆盖复制。
type DramaDrawingConfiguration struct {
	Assets production.AssetSettings `json:"assets"`
	Models DramaDrawingModels       `json:"models"`
}

type DramaDrawingModels struct {
	Image          DramaModelChoice `json:"image"`
	CharacterImage DramaModelChoice `json:"characterImage"`
	SceneImage     DramaModelChoice `json:"sceneImage"`
}

func dramaDrawingConfiguration(settings DramaSettings) DramaDrawingConfiguration {
	return DramaDrawingConfiguration{Assets: settings.Assets, Models: DramaDrawingModels{
		Image: settings.Models.Image, CharacterImage: settings.Models.CharacterImage, SceneImage: settings.Models.SceneImage,
	}}
}

func applyDramaDrawingConfiguration(settings DramaSettings, drawing *DramaDrawingConfiguration) DramaSettings {
	if drawing == nil {
		return settings
	}
	settings.Assets = drawing.Assets
	settings.Models.Image = drawing.Models.Image
	settings.Models.CharacterImage = drawing.Models.CharacterImage
	settings.Models.SceneImage = drawing.Models.SceneImage
	return settings
}

func (s *Service) validateDramaDrawingConfiguration(userID string, settings DramaSettings, drawing *DramaDrawingConfiguration) (*DramaDrawingConfiguration, error) {
	if drawing == nil {
		return nil, nil
	}
	next := *drawing
	next.Assets = next.Assets.Normalized()
	if issue := production.ValidateAssetPrompts(next.Assets); issue != "" {
		return nil, BadAuthRequest(issue)
	}
	// 默认图片模型必须可用；角色和场景为空表示沿用它。
	if err := s.requireDramaModelOption(userID, "image", drawing.Models.Image); err != nil {
		return nil, err
	}
	for _, choice := range []DramaModelChoice{drawing.Models.CharacterImage, drawing.Models.SceneImage} {
		if !choice.Empty() {
			if err := s.requireDramaModelOption(userID, "image", choice); err != nil {
				return nil, err
			}
		}
	}
	settings = applyDramaDrawingConfiguration(settings, &next)
	if err := s.validateDramaImageSettings(settings.Models, settings.Assets); err != nil {
		return nil, err
	}
	return &next, nil
}
