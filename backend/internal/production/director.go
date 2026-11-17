package production

import (
	"fmt"
	"strings"
)

func (s StoryboardSettings) ValidateDirector() error {
	switch s.GenerationMode {
	case "", "reference_video", "grid_image", "smart_director", "storyboard":
	default:
		return fmt.Errorf("不支持的分镜生成模式")
	}
	if s.TargetShotCount < 0 || s.TargetShotCount > MaxScriptShots {
		return fmt.Errorf("镜头数需为 1 到 %d，0 表示自动估算", MaxScriptShots)
	}
	switch s.ShotCountMode {
	case "", ShotCountSmart:
	case ShotCountFixed:
		if s.TargetShotCount == 0 {
			return fmt.Errorf("固定镜头数需为 1 到 %d", MaxScriptShots)
		}
	default:
		return fmt.Errorf("不支持的镜头数量模式")
	}
	switch s.DirectorTemplate {
	case "", "smart_drama", "storyboard_detail":
		return nil
	}
	return fmt.Errorf("不支持的分镜模板")
}

func DirectorTemplateRule(template string) string {
	switch template {
	case "smart_drama":
		return "智能导演·剧集版：按剧情节拍建立空间关系，建立镜头、人物动作、正反打与反应镜头连贯衔接；镜头运动有明确叙事动机，遵守轴线与视线方向，不为凑镜头添加剧情或改写原台词。"
	case "storyboard_detail":
		return "手绘故事板·详细分镜版：逐镜说明景别、构图、人物站位、视线、动作起止与运镜；每张起幅可独立绘制且跨镜人物、场景与道具连续。不在图像提示词中要求印刷字幕、镜号或说明文字。"
	}
	return ""
}

// Presets describe an upstream prompt instruction; providers do not guarantee
// physically exact camera trajectories.
func CameraPresetRule(camera string) string {
	switch strings.TrimSpace(camera) {
	case "无运镜", "固定":
		return "固定机位，保持镜头稳定，用人物动作推动画面"
	case "推镜头", "推":
		return "镜头沿视轴平稳推近主体，逐渐突出表情或细节"
	case "拉镜头", "拉":
		return "镜头沿视轴平稳后拉，逐步揭示主体与周围空间"
	case "摇镜头", "摇":
		return "机位固定，镜头水平或垂直转向主体，保持空间关系连续"
	case "移镜头", "移":
		return "镜头横向平移，前后景形成自然视差"
	case "跟镜头", "跟":
		return "镜头跟随主体移动，维持主体位置和连贯运动方向"
	case "环绕镜头", "环绕":
		return "镜头围绕主体平滑移动，以环境视差呈现空间关系"
	case "升镜头":
		return "镜头平稳升高，逐渐揭示更大范围的场景"
	case "航拍镜头":
		return "高空俯拍，镜头平稳飞行，呈现场景规模与空间布局"
	case "手持镜头":
		return "轻微自然手持运动，跟随主体，保持画面清晰可读"
	case "荷兰角镜头":
		return "保持倾斜地平线的荷兰角构图，以画面倾斜表达不安"
	case "希区柯克镜头":
		return "使用推拉变焦效果：主体画面大小尽量稳定，背景透视发生变化"
	case "POV镜头":
		return "从人物眼睛位置呈现第一人称主观视角，运动与视线一致"
	case "FPV镜头":
		return "第一人称飞行视角，连续穿行于空间，保持清晰路径与方向"
	}
	return ""
}
