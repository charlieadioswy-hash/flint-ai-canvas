package protocol

import (
	"fmt"
	"math"
	"strings"
)

// ControlNetParameters describes spatial guidance without a provider wire format.
// Model is an identifier in the selected provider's compatible model catalogue.
type ControlNetParameters struct {
	Preprocessor string           `json:"preprocessor"`
	Model        string           `json:"model"`
	Strength     float64          `json:"strength"`
	Start        float64          `json:"start"`
	End          float64          `json:"end"`
	PixelPerfect bool             `json:"pixelPerfect"`
	ControlMode  string           `json:"controlMode" enum:"balanced,prompt,control"`
	ResizeMode   string           `json:"resizeMode" enum:"stretch,crop,fill"`
	Canny        *CannyParameters `json:"canny,omitempty"`
}

type CannyParameters struct {
	Resolution    int `json:"resolution"`
	LowThreshold  int `json:"lowThreshold"`
	HighThreshold int `json:"highThreshold"`
}

type ControlNetUnit struct {
	ID         string               `json:"id"`
	Image      MediaReference       `json:"image"`
	Mask       *MediaReference      `json:"mask,omitempty"`
	Parameters ControlNetParameters `json:"parameters"`
}

func (p ControlNetParameters) Validate(draft bool) error {
	if strings.TrimSpace(p.Preprocessor) == "" || (!draft && strings.TrimSpace(p.Model) == "") {
		return fmt.Errorf("ControlNet 必须配置预处理器和控制模型")
	}
	if !finiteRange(p.Strength, 0, 2) || !finiteRange(p.Start, 0, 1) || !finiteRange(p.End, 0, 1) || p.Start > p.End {
		return fmt.Errorf("ControlNet 权重须为 0–2，起止比例须为 0–1 且起点不晚于终点")
	}
	if p.ControlMode != "balanced" && p.ControlMode != "prompt" && p.ControlMode != "control" {
		return fmt.Errorf("未知 ControlNet 控制偏好")
	}
	if p.ResizeMode != "stretch" && p.ResizeMode != "crop" && p.ResizeMode != "fill" {
		return fmt.Errorf("未知 ControlNet 缩放方式")
	}
	if p.Preprocessor == "canny" {
		c := p.Canny
		if c == nil || c.Resolution < 64 || c.Resolution > 2048 || c.LowThreshold < 1 || c.HighThreshold > 255 || c.LowThreshold > c.HighThreshold {
			return fmt.Errorf("Canny 分辨率须为 64–2048，阈值须为 1–255 且低阈值不大于高阈值")
		}
	}
	return nil
}

func finiteRange(value, low, high float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= low && value <= high
}
