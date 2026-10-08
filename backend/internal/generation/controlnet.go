package generation

import "infinite-canvas/backend/internal/protocol"

type ControlNetParameters = protocol.ControlNetParameters
type CannyParameters = protocol.CannyParameters

type ControlNetUnit struct {
	ID         string               `json:"id"`
	Image      Media                `json:"image"`
	Mask       *Media               `json:"mask,omitempty"`
	Parameters ControlNetParameters `json:"parameters"`
}

// OutputMask is applied by the host after generation, independently of guidance
// and inpainting masks. non-black treats RGB screen regions as one binary area.
type OutputMask struct {
	Image      Media  `json:"image"`
	Mode       string `json:"mode" enum:"luminance,non-black"`
	ResizeMode string `json:"resizeMode" enum:"stretch"`
}

type ControlNetCapability struct {
	Supported     bool     `json:"supported"`
	MaxUnits      int      `json:"maxUnits"`
	Preprocessors []string `json:"preprocessors"`
	Models        []string `json:"models,omitempty"`
}
