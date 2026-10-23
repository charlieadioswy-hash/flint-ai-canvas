package protocol

import (
	"fmt"
	"math"
	"strings"
)

// ControlNetParameters describes spatial guidance without a provider wire format.
// Model is an identifier in the selected provider's compatible model catalogue.
type ControlNetParameters struct {
	ControlType         string             `json:"controlType,omitempty"`
	Preprocessor        string             `json:"preprocessor"`
	Model               string             `json:"model"`
	Strength            float64            `json:"strength"`
	Start               float64            `json:"start"`
	End                 float64            `json:"end"`
	PixelPerfect        bool               `json:"pixelPerfect"`
	ControlMode         string             `json:"controlMode" enum:"balanced,prompt,control"`
	ResizeMode          string             `json:"resizeMode" enum:"stretch,crop,fill"`
	Canny               *CannyParameters   `json:"canny,omitempty"`
	ProcessorParameters map[string]float64 `json:"processorParameters,omitempty"`
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
	if strings.TrimSpace(p.Preprocessor) == "" || (!draft && strings.TrimSpace(p.Model) == "" && p.ResolvedControlType() != "reference") {
		return fmt.Errorf("ControlNet 必须配置预处理器和控制模型")
	}
	processor, known := ControlNetPreprocessor(p.Preprocessor)
	if !known {
		return fmt.Errorf("未知 ControlNet 预处理器")
	}
	controlType, err := GetControlNetType(p.Preprocessor, p.ControlType)
	if err != nil {
		return err
	}
	if !draft && controlType == "none" {
		return fmt.Errorf("关闭预处理或反色时必须明确选择 Control Type")
	}
	if !draft {
		for _, definition := range ControlNetTypes() {
			if definition.ID == controlType && !definition.Supported {
				return fmt.Errorf("%s", definition.Description)
			}
		}
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
		if len(p.ProcessorParameters) != 0 {
			return fmt.Errorf("Canny 参数不能与其他预处理器参数混用")
		}
		c := p.Canny
		if c == nil || c.Resolution < 64 || c.Resolution > 2048 || c.LowThreshold < 1 || c.HighThreshold > 255 || c.LowThreshold > c.HighThreshold {
			return fmt.Errorf("Canny 分辨率须为 64–2048，阈值须为 1–255 且低阈值不大于高阈值")
		}
		return nil
	}
	if p.Canny != nil {
		return fmt.Errorf("当前预处理器不能携带 Canny 参数")
	}
	if len(p.ProcessorParameters) != len(processor.Parameters) {
		return fmt.Errorf("预处理器参数缺失或包含不适用的参数")
	}
	for _, parameter := range processor.Parameters {
		value, present := p.ProcessorParameters[parameter.Name]
		if !present || !finiteRange(value, parameter.Min, parameter.Max) || parameter.Type == "integer" && math.Trunc(value) != value {
			return fmt.Errorf("预处理器参数 %s 须为 %g–%g 范围内的%s", parameter.Label, parameter.Min, parameter.Max, map[string]string{"integer": "整数", "number": "数值"}[parameter.Type])
		}
	}
	return nil
}

func finiteRange(value, low, high float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= low && value <= high
}
