package contract

import (
	"fmt"

	"yingce/backend/internal/protocol"
)

type ControlNetBinding struct {
	ID             string                        `json:"id"`
	ImageBindingID string                        `json:"imageBindingId"`
	MaskBindingID  string                        `json:"maskBindingId,omitempty"`
	Parameters     protocol.ControlNetParameters `json:"parameters"`
}

type OutputMaskBinding struct {
	BindingID  string `json:"bindingId"`
	Mode       string `json:"mode" enum:"luminance,non-black"`
	ResizeMode string `json:"resizeMode" enum:"stretch"`
}

// Drafts may omit a source/model. Referenced bindings must already be valid;
// task admission validates the fully resolved media and model capability.
func (s GenerationSpec) validateControlBindings() error {
	bindings := make(map[string]ReferenceBinding, len(s.ReferenceBindings))
	for _, binding := range s.ReferenceBindings {
		bindings[binding.ID] = binding
	}
	check := func(id, role string) error {
		if id == "" {
			return nil
		}
		binding, ok := bindings[id]
		if !ok || binding.Role != role || binding.MediaType != "image" {
			return invalid("options.controlNet", "控制图和蒙版必须关联正确的图片引用角色")
		}
		return nil
	}
	if s.Options.ControlNet != nil {
		if len(*s.Options.ControlNet) > 4 {
			return invalid("options.controlNet", "最多配置四组结构控制")
		}
		seen := map[string]bool{}
		for i, unit := range *s.Options.ControlNet {
			if unit.ID == "" || seen[unit.ID] {
				return invalid("options.controlNet", "控制单元 ID 必须非空且唯一")
			}
			seen[unit.ID] = true
			if err := unit.Parameters.Validate(true); err != nil {
				return invalid(fmt.Sprintf("options.controlNet[%d]", i), err.Error())
			}
			if err := check(unit.ImageBindingID, "control-image"); err != nil {
				return err
			}
			if err := check(unit.MaskBindingID, "control-mask"); err != nil {
				return err
			}
		}
	}
	if mask := s.Options.OutputMask; mask != nil {
		if mask.ResizeMode != "stretch" {
			return invalid("options.outputMask.resizeMode", "输出蒙版须明确使用完整画幅缩放")
		}
		if mask.Mode != "luminance" && mask.Mode != "non-black" {
			return invalid("options.outputMask.mode", "未知输出蒙版模式")
		}
		if err := check(mask.BindingID, "output-mask"); err != nil {
			return err
		}
	}
	return nil
}
