package model3d

import (
	"errors"
	"reflect"
	"strings"
)

// Processing refers to an owned application task, never a client-supplied upstream ID.
type Processing struct {
	Operation           string   `json:"operation"`
	SourceTaskID        string   `json:"sourceTaskId"`
	Model               string   `json:"model,omitempty"`
	Granularity         string   `json:"granularity,omitempty"`
	SplitByConnectivity *bool    `json:"splitByConnectivity,omitempty"`
	CompletionMode      string   `json:"completionMode,omitempty"`
	PartNames           []string `json:"partNames,omitempty"`
	RigType             string   `json:"rigType,omitempty"`
	Spec                string   `json:"spec,omitempty"`
	OutFormat           string   `json:"outFormat,omitempty"`
	Animation           string   `json:"animation,omitempty"`
	AnimateInPlace      *bool    `json:"animateInPlace,omitempty"`
}

type RigCheck struct {
	Riggable bool   `json:"riggable"`
	RigType  string `json:"rigType"`
}

func ProcessingLabel(operation string) string {
	switch operation {
	case "segment":
		return "部件拆分"
	case "complete":
		return "部件补全"
	case "rig_check":
		return "绑骨检查"
	case "rig":
		return "自动绑骨"
	case "animate":
		return "生成动画"
	default:
		return "3D 模型生成"
	}
}

func RigTypes() []string {
	return []string{"biped", "quadruped", "hexapod", "octopod", "avian", "serpentine", "aquatic", "others"}
}

// The v2.5 and v3.0 rigs share these documented presets. Avian/others have no published preset.
func AnimationPresets(rigType string) []string {
	switch rigType {
	case "biped":
		return []string{"preset:idle", "preset:walk", "preset:run", "preset:dive", "preset:climb", "preset:jump", "preset:slash", "preset:shoot", "preset:hurt", "preset:fall", "preset:turn"}
	case "quadruped", "hexapod", "octopod":
		return []string{"preset:" + rigType + ":walk"}
	case "serpentine", "aquatic":
		return []string{"preset:" + rigType + ":march"}
	default:
		return nil
	}
}

func ValidateProcessing(p Processing) error {
	if strings.TrimSpace(p.SourceTaskID) == "" || len(p.SourceTaskID) > 96 {
		return errors.New("请选择来源任务")
	}
	allowed := Processing{Operation: p.Operation, SourceTaskID: p.SourceTaskID}
	switch p.Operation {
	case "segment":
		if !Contains([]string{"v1.0-20250506", "v2.0-20260430"}, p.Model) {
			return errors.New("拆分模型版本无效")
		}
		allowed.Model = p.Model
		if p.Model == "v2.0-20260430" {
			if !Contains([]string{"simple", "balanced", "detailed"}, p.Granularity) {
				return errors.New("请选择拆分粒度")
			}
			allowed.Granularity, allowed.SplitByConnectivity = p.Granularity, p.SplitByConnectivity
		}
	case "complete":
		if !Contains([]string{"ai_completion", "quick_cap"}, p.CompletionMode) || len(p.PartNames) > 256 {
			return errors.New("补全方式或部件数量无效")
		}
		seen := map[string]bool{}
		for _, name := range p.PartNames {
			if strings.TrimSpace(name) == "" || len(name) > 256 || strings.ContainsAny(name, "\r\n\x00") || seen[name] {
				return errors.New("补全部件名称无效或重复")
			}
			seen[name] = true
		}
		allowed.CompletionMode, allowed.PartNames = p.CompletionMode, p.PartNames
	case "rig_check":
	case "rig":
		if !Contains([]string{"v2.5-20260210", "v3.0-20260909"}, p.Model) || !Contains(RigTypes(), p.RigType) {
			return errors.New("绑骨模型或骨架类型无效")
		}
		if p.Model != "v3.0-20260909" && (p.RigType == "others" || (p.Spec != "" && p.Spec != "tripo" && p.Spec != "mixamo")) {
			return errors.New("此骨架类型或命名规范需要绑骨 v3.0")
		}
		if p.RigType == "biped" {
			if !Contains([]string{"tripo", "mixamo", "actorcore", "unity", "unreal", "vrm"}, p.Spec) {
				return errors.New("请选择人形骨架命名规范")
			}
		} else if p.Spec != "" {
			return errors.New("非人形绑骨不接受人形命名规范")
		}
		allowed.Model, allowed.RigType, allowed.Spec, allowed.OutFormat = p.Model, p.RigType, p.Spec, p.OutFormat
	case "animate":
		if !Contains(AnimationPresets(p.RigType), p.Animation) {
			return errors.New("该骨架类型不支持所选预设动画")
		}
		allowed.RigType, allowed.Animation, allowed.AnimateInPlace, allowed.OutFormat = p.RigType, p.Animation, p.AnimateInPlace, p.OutFormat
	default:
		return errors.New("3D 处理操作无效")
	}
	if (p.Operation == "rig" || p.Operation == "animate") && !Contains([]string{"glb", "fbx"}, p.OutFormat) {
		return errors.New("绑骨与动画输出须为 GLB 或 FBX")
	}
	if !reflect.DeepEqual(p, allowed) {
		return errors.New("请求包含不适用于当前 3D 操作的参数")
	}
	return nil
}

func processingPayload(p Processing, upstream string) (string, map[string]any, error) {
	if err := ValidateProcessing(p); err != nil {
		return "", nil, err
	}
	if strings.TrimSpace(upstream) == "" || len(upstream) > 160 {
		return "", nil, errors.New("缺少有效的来源模型任务")
	}
	value := map[string]any{"input": upstream}
	switch p.Operation {
	case "segment":
		value["model"] = p.Model
		if p.Granularity != "" {
			value["segmentation_granularity"] = p.Granularity
		}
		if p.SplitByConnectivity != nil {
			value["split_by_connectivity"] = *p.SplitByConnectivity
		}
		return "/mesh/segment", value, nil
	case "complete":
		value["model"], value["completion_mode"] = "v1.0-20250506", p.CompletionMode
		if len(p.PartNames) > 0 {
			value["part_names"] = p.PartNames
		}
		return "/mesh/complete", value, nil
	case "rig_check":
		return "/animations/rig-check", value, nil
	case "rig":
		value["model"], value["rig_type"], value["out_format"] = p.Model, p.RigType, p.OutFormat
		if p.Spec != "" {
			value["spec"] = p.Spec
		}
		return "/animations/rig", value, nil
	default:
		value["animation"], value["out_format"], value["export_with_geometry"] = p.Animation, p.OutFormat, true
		if p.AnimateInPlace != nil {
			value["animate_in_place"] = *p.AnimateInPlace
		}
		return "/animations/retarget", value, nil
	}
}
