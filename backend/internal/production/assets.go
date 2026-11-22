package production

import (
	"regexp"
	"sort"
	"strings"
)

// 角色、场景与道具参考图方案。参考图是后续每个镜头首帧的身份锚点，方案决定它的版式、
// 比例和约束提示词。模板在作品设置里保存为全文，用户看到的就是实际发送的内容。

const (
	AssetModeNone                        = "none"
	AssetModeCloseupTurnaround           = "closeup_turnaround"
	AssetModeCloseupFrontNoFace          = "closeup_front_no_face"
	AssetModeCloseupTurnaroundNoHead     = "closeup_turnaround_no_head"
	AssetModeCloseupFullbody             = "closeup_fullbody"
	AssetModeDualCloseupFrontBackNoHead  = "dual_closeup_front_back_no_head"
	AssetModeTripleCloseupFrontNoFace    = "triple_closeup_front_no_face"
	AssetModeTurnaroundTripleCloseup     = "turnaround_triple_closeup"
	AssetModeTurnaroundFiveAngleHalfbody = "turnaround_five_angle_halfbody"
	AssetModeHeadshotFullbody            = "headshot_fullbody"
	AssetModeCustom                      = "custom"
)

// 可用变量。保存时校验，未知变量直接拒绝，避免把 {{xxx}} 原样发给模型。
var (
	CharacterAssetVariables = []string{"{{角色名称}}", "{{角色设定}}", "{{项目画风}}", "{{画面规则}}"}
	SceneAssetVariables     = []string{"{{场景名称}}", "{{场景设定}}", "{{项目画风}}", "{{画面规则}}"}
	PropAssetVariables      = []string{"{{道具名称}}", "{{道具设定}}", "{{项目画风}}", "{{画面规则}}"}
)

// AssetImageRatio 是场景、道具与横版角色方案的默认画幅。
const AssetImageRatio = "16:9"

const AssetImageOutputContract = "本次仅生成一张完整图片；模板中的所有分区、视角和特写必须合成在这同一张图片内，不拆成多个生成任务或多张独立图片。"

const characterAssetBoardRules = `所有编号分区都是同一角色的重复视角，不是不同人物；各区保持同一身份、年龄、服装、发型、体型与配饰。必须画齐每个编号分区，不得把多个视角合并为一个人物立绘，也不得因角色身份只有一个而省略重复视角。
背景为统一干净中性浅色，光照一致；分区之间留少量干净间隔，不重叠。禁止文字、水印、编号标签、装饰边框、声纹波形、额外身份或新增道具；分区编号只用于说明布局，不画在图片上。`

func characterAssetBoardPrompt(name, layout string) string {
	return "【必须先满足的版式、数量与取景】\n" + layout + "\n" + AssetImageOutputContract + "\n" + characterAssetBoardRules + "\n【各分区共用的角色内容】\n角色" + name + "复合设定图。项目画风：{{项目画风}}。角色名称：{{角色名称}}。角色设定：{{角色设定}}。画面规则：{{画面规则}}\n角色内容只描述各区的外貌与服装，不得改变上述分区数量、布局、视角或取景尺度。"
}

// WithAssetImageOutputContract 同时约束模板和素材自定义提示词；预览保存后不重复追加。
func WithAssetImageOutputContract(prompt string) string {
	prompt = strings.TrimSpace(prompt)
	if strings.Contains(prompt, AssetImageOutputContract) {
		return prompt
	}
	return strings.TrimSpace(prompt + "\n" + AssetImageOutputContract)
}

type AssetScheme struct {
	Mode        string `json:"mode"`
	Name        string `json:"name"`
	Description string `json:"description"`
	// Ratio 是参考图期望画幅；实际像素由所选图片模型的档位决定。
	Ratio string `json:"ratio"`
	// FrameHint 告诉首帧模型参考图是什么版式，避免把设定板的排版带进镜头。
	FrameHint       string `json:"frameHint"`
	CharacterPrompt string `json:"characterPrompt"`
}

const defaultScenePrompt = `{{项目画风}}。场景概念设定图：{{场景名称}}。{{场景设定}}。
横版宽景构图，无人物，空镜，构图完整，主体空间与出入口清晰，前中后景层次分明；光源方向明确，色调与时代服化道统一。
禁止文字、水印、边框。{{画面规则}}
` + AssetImageOutputContract

// defaultPropPrompt 是关键道具参考图默认模板：单件道具居中、无人物，供视频生成时保持道具外观一致。
const defaultPropPrompt = `{{项目画风}}。道具设定图：{{道具名称}}。{{道具设定}}。
横版构图，单件道具居中完整展示，四周留白，干净浅灰背景，柔和棚拍光，外形、材质、颜色与细节清晰；无人物、无手部。
禁止文字、水印、边框。{{画面规则}}`

var assetSchemes = []AssetScheme{
	{
		Mode: AssetModeNone, Name: "不使用", Ratio: AssetImageRatio,
		Description: "不套用复合设定板布局，按角色设定生成一张单幅图片。",
		FrameHint:   "参考图为单幅角色形象，只沿用角色身份、外貌与服装，不复制背景",
		CharacterPrompt: `{{项目画风}}。角色形象图：{{角色名称}}。{{角色设定}}。
单幅单人构图，不安排重复视角、分区、拼图或设定板；角色外貌与服装清晰，背景简洁，无文字、水印或额外人物。{{画面规则}}
` + AssetImageOutputContract,
	},
	{
		Mode: AssetModeCloseupTurnaround, Name: "单特写+三视图", Ratio: AssetImageRatio,
		Description: "左侧一张头肩特写，右侧正面、侧面、背面三张带头全身，同一张复合图。",
		FrameHint:   "参考图为左侧头肩特写加右侧带头三视图，脸部参考特写，服装体型参考全身，不复制排版",
		CharacterPrompt: characterAssetBoardPrompt("单特写+三视图", `16:9 横版左右布局，同一张图总共恰好 4 个独立分区：左侧约占 40%，右侧约占 60%；右侧横向等宽排列正面全身、右侧面全身、背面全身。
分区1：左侧整列，一张大幅正面头肩特写，头顶到肩胸上沿占满左区；脸部明显大于右侧全身图中的头部，不能缩成小头像。
分区2：右侧第一列，约占全图宽度 20%，一张正面全身。
分区3：右侧第二列，约占全图宽度 20%，一张右侧面全身。
分区4：右侧第三列，约占全图宽度 20%，一张背面全身。
右侧三视图均保留头部，站立中性姿势，从头顶到脚底完整入画，不裁头脚；全图恰好一个大特写加三个全身视角，左侧大特写不能省略，不能只生成三视图。`),
	},
	{
		Mode: AssetModeCloseupFrontNoFace, Name: "单特写+正面无面部", Ratio: AssetImageRatio,
		Description: "左侧头肩特写，右侧从衣领至鞋底的正面服装身体图，不绘制第二个头部。",
		FrameHint:   "参考图左侧为身份头肩特写，右侧为颈根以下正面服装身体，只沿用身份和服装，不复制排版",
		CharacterPrompt: characterAssetBoardPrompt("单特写+正面无面部", `16:9 横版双区，同一张图总共恰好 2 个独立分区：左侧约占 2/3，右侧约占 1/3。
分区1：左侧整列，一张大幅清晰正面头肩特写，头顶到肩胸上沿占满左区。
分区2：右侧整列，一张正面无面部身体图，从颈根或衣领以下至鞋底，完整展示服装和双脚。
“无面部”按服装身体裁切处理，整个头部不在右区内，不画空白脸、模糊脸或打码；全图只有左侧一张可见面孔，不得将双区合并成一张带头全身立绘。`),
	},
	{
		Mode: AssetModeCloseupTurnaroundNoHead, Name: "单特写+三视图无头部", Ratio: AssetImageRatio,
		Description: "左侧头肩特写，右侧正、侧、背三张颈根以下服装身体图。",
		FrameHint:   "参考图左侧锁定面部，右侧三张无头身体锁定服装体型，不复制排版",
		CharacterPrompt: characterAssetBoardPrompt("单特写+三视图无头部", `16:9 横版左右布局，同一张图总共恰好 4 个独立分区：左侧约占 40%，右侧约占 60%，等宽排列正面、右侧面、背面三张无头身体图。
分区1：左侧整列，一张大幅正面头肩特写，头顶到肩胸上沿占满左区，不能缩成小头像。
分区2：右侧第一列，约占全图宽度 20%，一张正面无头身体图。
分区3：右侧第二列，约占全图宽度 20%，一张右侧面无头身体图。
分区4：右侧第三列，约占全图宽度 20%，一张背面无头身体图。
右侧三张身体均从颈根或衣领以下开始至鞋底，完全不包含头部，不画空白脸、模糊脸或打码；全图只有左侧一张可见面孔。左侧大特写和右侧三张身体均不可省略。`),
	},
	{
		Mode: AssetModeCloseupFullbody, Name: "单特写+全身", Ratio: AssetImageRatio,
		Description: "左侧头肩特写，右侧一张保留头部与脚部的正面全身图。",
		FrameHint:   "参考图为左侧头肩特写加右侧完整全身，只沿用身份、服装与体型，不复制排版",
		CharacterPrompt: characterAssetBoardPrompt("单特写+全身", `16:9 横版双区，同一张图总共恰好 2 个独立分区：左侧约占 2/3，右侧约占 1/3。
分区1：左侧整列，一张大幅正面头肩特写，头顶到肩胸上沿占满左区，脸部明显大于右侧全身图中的头部。
分区2：右侧整列，一张中性站姿正面全身，身体接近右区全高，四周留少量空白。
右侧必须保留完整头部和双脚，从头顶到鞋底，不使用无头服装身体图；两区为同一角色，不得合并为一张全身立绘或省略左侧大特写。`),
	},
	{
		Mode: AssetModeDualCloseupFrontBackNoHead, Name: "双特写+正背面无头部", Ratio: "9:16",
		Description: "竖向四区，上排正面和侧面头肩特写，下排正面和背面无头服装身体图。",
		FrameHint:   "参考图上排两个特写锁定面部，下排正背无头身体锁定服装，不复制四区排版",
		CharacterPrompt: characterAssetBoardPrompt("双特写+正背面无头部", `9:16 竖版上下两行、每行两区，同一张图总共恰好 4 个独立分区；上行约占总高度 30%，下行约占总高度 70%，每行左右等宽。
分区1：左上，一张正面头肩特写，头顶到肩胸上沿占满本区。
分区2：右上，一张右侧面头肩特写，与左上特写等大。
分区3：左下，一张正面无头身体，从颈根或衣领以下至鞋底，服装和双脚完整入画。
分区4：右下，一张背面无头身体，与左下身体等大且上下对齐，完整展示后背服装至鞋底。
下行从左到右为正面无头身体、背面无头身体，均不包含头部，不画空白脸、模糊脸或打码；全图恰好两张头肩特写和两张服装身体图，不得改成横版、三视图或四张带头全身。`),
	},
	{
		Mode: AssetModeTripleCloseupFrontNoFace, Name: "面部三特写+正面无面部", Ratio: AssetImageRatio,
		Description: "左主头肩特写、中间正面无头服装身体、右侧三张小面部特写，共四张面孔。",
		FrameHint:   "参考图为主特写、正面服装身体及右侧三张面部细节，只沿用身份与服装，不复制排版",
		CharacterPrompt: characterAssetBoardPrompt("面部三特写+正面无面部", `16:9 横版三列，同一张图总共恰好 5 个独立分区：左列约占宽度 37%，中列约占 26%，右列约占 37%。
分区1：左列一张大幅正面头肩主特写，头顶到肩胸上沿占满左列，明显大于右列的小特写。
分区2：中列一张正面无面部身体，从颈根或衣领以下到鞋底，完整展示服装和双脚。
分区3：右列上半部，一张正脸小特写。
分区4：右列下半部左侧，一张左侧脸小特写。
分区5：右列下半部右侧，一张右侧脸小特写，与分区4等大；右下两张并排，不重叠。
右列恰好三张小面部特写，连同左列主特写全图共四张面孔；中列不包含头部，不使用空白脸、模糊脸或打码。左列大特写不可省略，不得简化成三张面部特写加一张身体。`),
	},
	{
		Mode: AssetModeTurnaroundTripleCloseup, Name: "三视图+脸部三特写", Ratio: AssetImageRatio,
		Description: "左侧正、侧、背三张带头全身，右侧正面及左右侧脸三张头肩特写。",
		FrameHint:   "参考图左侧带头三视图锁定服装体型，右侧三张头肩特写锁定面部，不复制排版",
		CharacterPrompt: characterAssetBoardPrompt("三视图+脸部三特写", `16:9 横版左右布局，同一张图总共恰好 6 个独立分区：左侧约占宽度 60%，右侧约占宽度 40%；左侧三列等宽，右侧分上下两行。
分区1：左侧第一列，一张正面全身，从头顶到鞋底完整入画。
分区2：左侧第二列，一张右侧面全身，与分区1等大。
分区3：左侧第三列，一张背面全身，与前两张全身图等大且头脚对齐。
分区4：右侧上半部，一张正面头肩特写，头脸明显大于左侧全身图中的头部。
分区5：右侧下半部左侧，一张左侧头肩特写。
分区6：右侧下半部右侧，一张右侧头肩特写，与分区5等大。
左侧三张均保留头部和双脚，右侧三张均取头顶到肩胸上沿；恰好三个完整全身视角加三个头肩特写。不要增加左侧主脸大特写或无头身体区，也不得只生成左侧三视图。`),
	},
	{
		Mode: AssetModeTurnaroundFiveAngleHalfbody, Name: "三视图+五角度半身照", Ratio: AssetImageRatio,
		Description: "左侧三张带头全身，右侧五张不同角度的肩胸半身像，上二下三。",
		FrameHint:   "参考图左侧三视图锁定服装体型，右侧五角度肩胸像锁定头脸，不复制排版",
		CharacterPrompt: characterAssetBoardPrompt("三视图+五角度半身照", `16:9 横版左右布局，同一张图总共恰好 8 个独立分区：左侧约占宽度 60%，右侧约占宽度 40%；左侧三列等宽，右侧按上行两张、下行三张排列，上下两行等高。
分区1：左侧第一列，一张正面全身，从头顶到鞋底完整入画。
分区2：左侧第二列，一张右侧面全身，与分区1等大。
分区3：左侧第三列，一张背面全身，与前两张全身图等大且头脚对齐。
分区4：右侧上行左格，一张正面肩胸半身像。
分区5：右侧上行右格，一张右侧面肩胸半身像，与分区4等大。
分区6：右侧下行左格，一张左侧三分之四肩胸半身像。
分区7：右侧下行中格，一张右侧三分之四肩胸半身像。
分区8：右侧下行右格，一张背面肩胸半身像，与分区6、分区7等大。
右侧五角度均保留完整头部及肩胸，取景到胸部，不画成五张全身；恰好三个全身视角加五个半身视角，不能省略右侧五角度或另加左侧大脸特写。`),
	},
	{
		Mode: AssetModeHeadshotFullbody, Name: "大头照+全身照", Ratio: AssetImageRatio,
		Description: "左侧仅头顶至下巴的独立大头照，无衣领肩膀；右侧正面无头服装身体。",
		FrameHint:   "参考图左侧独立头照锁定面部，右侧无头服装身体锁定穿着，不复制头身分离排版",
		CharacterPrompt: characterAssetBoardPrompt("大头照+全身照", `16:9 横版双区，同一张图总共恰好 2 个独立分区：左侧约占 2/3，右侧约占 1/3。
分区1：左侧整列，一张独立正面大头照，仅从头顶到下巴，不含肩膀、衣领或上半身；头脸占满左区，不能缩成小头像。
分区2：右侧整列，一张正面无头服装身体，从颈根或衣领以下至鞋底，完整展示服装和双脚，不画空白脸、模糊脸或打码。
全图仅左侧一张面孔；不要把左侧画成头肩特写，不要给右侧身体补画头部，也不得把两区合并成一张带头全身立绘。`),
	},
}

// AssetSchemes 返回内置方案（含默认提示词），供创建页与设置页展示。
func AssetSchemes() []AssetScheme {
	result := make([]AssetScheme, len(assetSchemes))
	copy(result, assetSchemes)
	return result
}

func DefaultScenePrompt() string { return defaultScenePrompt }

type SceneAssetScheme struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Prompt      string `json:"prompt"`
}

// 选择模板后仍保存完整 ScenePrompt，不新增另一套执行参数。
func SceneAssetSchemes() []SceneAssetScheme {
	return []SceneAssetScheme{
		{ID: "wide", Name: "空间全景", Description: "单幅空镜，展示空间、出入口与光源。", Prompt: defaultScenePrompt},
		{ID: "fourview", Name: "场景四宫格", Description: "同一空间四个视角，保持结构、陈设与光照一致。", Prompt: `{{项目画风}}。场景四宫格设定图：{{场景名称}}。{{场景设定}}。
横版画面按 2×2 等分为四格，依次展示同一场景的入口全景、反向全景、左侧空间和右侧空间。
四格必须是同一时间、同一地点；建筑结构、门窗、家具、物件位置与光源方向保持一致，不添加原设定以外的新空间。
各格均为空镜，无人物，无文字、水印、装饰边框。{{画面规则}}
` + AssetImageOutputContract},
	}
}
func DefaultPropPrompt() string { return defaultPropPrompt }

func assetScheme(mode string) (AssetScheme, bool) {
	for _, scheme := range assetSchemes {
		if scheme.Mode == mode {
			return scheme, true
		}
	}
	return AssetScheme{}, false
}

// AssetSettings 是作品的参考图方案。Source* 只记录提示词来源（例如从某个技能导入），不参与执行。
type AssetSettings struct {
	Mode            string `json:"mode"`
	CharacterPrompt string `json:"characterPrompt"`
	ScenePrompt     string `json:"scenePrompt"`
	PropPrompt      string `json:"propPrompt"`
	CharacterRatio  string `json:"characterRatio"`
	// Resolution / PropResolution / SceneResolution 是角色、道具、场景参考图的分辨率档位（1k / 1.5k / 2k / 4k），
	// 空串按该类参考图所用图片模型的默认档位。
	Resolution      string `json:"resolution,omitempty"`
	PropResolution  string `json:"propResolution,omitempty"`
	SceneResolution string `json:"sceneResolution,omitempty"`
	SourceSkillID   string `json:"sourceSkillId,omitempty"`
	SourceSkillName string `json:"sourceSkillName,omitempty"`
	SourcePath      string `json:"sourcePath,omitempty"`
}

const assetPromptLimit = 4000

func (a AssetSettings) Normalized() AssetSettings {
	scheme, known := assetScheme(a.Mode)
	if !known && a.Mode != AssetModeCustom {
		if strings.TrimSpace(a.CharacterPrompt) != "" {
			a.Mode = AssetModeCustom
		} else {
			a.Mode = AssetModeCloseupTurnaround
			scheme, _ = assetScheme(AssetModeCloseupTurnaround)
		}
	}
	a.CharacterPrompt = truncateRunes(strings.TrimSpace(a.CharacterPrompt), assetPromptLimit)
	a.ScenePrompt = truncateRunes(strings.TrimSpace(a.ScenePrompt), assetPromptLimit)
	a.PropPrompt = truncateRunes(strings.TrimSpace(a.PropPrompt), assetPromptLimit)
	if a.CharacterPrompt == "" {
		if a.Mode == AssetModeCustom {
			a.Mode = AssetModeCloseupTurnaround
			scheme, _ = assetScheme(AssetModeCloseupTurnaround)
		}
		a.CharacterPrompt = scheme.CharacterPrompt
	}
	if a.ScenePrompt == "" {
		a.ScenePrompt = defaultScenePrompt
	}
	if a.PropPrompt == "" {
		a.PropPrompt = defaultPropPrompt
	}
	switch a.CharacterRatio {
	case "3:4", "9:16", "1:1", "16:9", "4:3":
	default:
		a.CharacterRatio = firstNonEmpty(scheme.Ratio, AssetImageRatio)
	}
	if a.Mode != AssetModeCustom {
		a.CharacterRatio = scheme.Ratio
	}
	a.Resolution = normalizedAssetTier(a.Resolution)
	a.PropResolution = normalizedAssetTier(a.PropResolution)
	a.SceneResolution = normalizedAssetTier(a.SceneResolution)
	a.SourceSkillID = truncateRunes(strings.TrimSpace(a.SourceSkillID), 64)
	a.SourceSkillName = truncateRunes(strings.TrimSpace(a.SourceSkillName), 120)
	a.SourcePath = truncateRunes(strings.TrimSpace(a.SourcePath), 240)
	return a
}

func normalizedAssetTier(value string) string {
	switch value = strings.ToLower(strings.TrimSpace(value)); value {
	case "1k", "1.5k", "2k", "4k":
		return value
	}
	return ""
}

// ResolutionFor 是某类参考图（character / prop / scene）的分辨率档位，空串按模型默认。
func (a AssetSettings) ResolutionFor(kind string) string {
	switch kind {
	case "prop":
		return a.PropResolution
	case "scene":
		return a.SceneResolution
	}
	return a.Resolution
}

// FrameHint 返回首帧提示词里对参考图版式的说明。
func (a AssetSettings) FrameHint() string {
	if scheme, ok := assetScheme(a.Mode); ok {
		return scheme.FrameHint
	}
	return "人物外貌严格参考对应参考图，不要复制参考图的排版与文字"
}

var assetPlaceholderPattern = regexp.MustCompile(`\{\{[^{}]+\}\}`)

// 作品的画风与画面规则写的是成片（视频）的画幅，竖屏作品常带“9:16 竖屏构图”；设定图有自己的画幅
// （场景、道具固定 16:9，角色按方案）。这两段文字带进设定图提示词前先去掉画幅与横竖构图要求，
// 再由 WithAssetRatio 写明设定图自己的画幅。角色、道具、场景设定和方案模板不经过这里，原样保留。
//
// 比例只认常见画幅写法，并要求两侧不是数字，“12:30 的暖光”这类时间不会被删。
const frameRatioToken = `\b(?:9\s*[:：]\s*16|16\s*[:：]\s*9|3\s*[:：]\s*4|4\s*[:：]\s*3|1\s*[:：]\s*1|21\s*[:：]\s*9|9\s*[:：]\s*21|2\s*[:：]\s*3|3\s*[:：]\s*2|4\s*[:：]\s*5|5\s*[:：]\s*4)\b`

var (
	// “画幅 9:16”“画面比例为 9:16”“9:16 竖屏构图”“16:9画幅比例”
	frameRatioDirective = regexp.MustCompile(`(?:(?:画幅|画面|比例|宽高比|尺寸)+\s*(?:为|是|采用|[:：])?\s*)?` + frameRatioToken + `(?:\s*(?:横屏|横版|竖屏|竖版|横向|竖向|横|竖))?(?:构图|画面|画幅|比例|拍摄|格式|视频)*`)
	// “竖屏构图”“竖屏”“横版画面”“竖向构图”“竖构图”
	frameOrientationDirective = regexp.MustCompile(`(?:横屏|横版|竖屏|竖版)(?:构图|画面|画幅|比例|拍摄|格式|视频)*|(?:横向|竖向|横|竖)(?:构图|画幅)+`)
	frameSeparatorRun         = regexp.MustCompile(`[，,、；;。]+(?:\s*[，,、；;。]+)*`)
)

// StripFrameDirectives 去掉画风或画面规则里关于成片画幅、横竖构图的要求，其余描述保留。
func StripFrameDirectives(text string) string {
	text = frameRatioDirective.ReplaceAllString(text, "")
	text = frameOrientationDirective.ReplaceAllString(text, "")
	// 删除后相邻的标点合成一个，保留语气最重的那个。
	text = frameSeparatorRun.ReplaceAllStringFunc(text, func(run string) string {
		switch {
		case strings.Contains(run, "。"):
			return "。"
		case strings.ContainsAny(run, "；;"):
			return "；"
		default:
			return "，"
		}
	})
	text = strings.TrimLeft(strings.TrimSpace(text), "，,、；;。")
	return strings.TrimSpace(strings.TrimRight(text, "，,、；;"))
}

// WithAssetRatio 在设定图提示词末尾写明本张设定图的画幅，与尺寸参数一致。
func WithAssetRatio(prompt, ratio string) string {
	prompt = strings.TrimSpace(prompt)
	ratio = strings.TrimSpace(ratio)
	if ratio == "" {
		return prompt
	}
	orientation := "，严格保持该宽高比"
	switch ratio {
	case "16:9", "4:3":
		orientation = "，横版，宽度大于高度"
	case "9:16", "3:4":
		orientation = "，竖版，高度大于宽度"
	case "1:1":
		orientation = "，方图，宽度与高度相等"
	}
	return strings.TrimSpace(prompt + "\n最终输出画幅必须为 " + ratio + orientation + "；不得改成其他比例。")
}

// ValidateAssetPrompts 拒绝未知变量；返回第一个问题的说明。
func ValidateAssetPrompts(a AssetSettings) string {
	check := func(label string, content string, allowed []string) string {
		known := map[string]bool{}
		for _, item := range allowed {
			known[item] = true
		}
		unknown := []string{}
		for _, placeholder := range assetPlaceholderPattern.FindAllString(content, -1) {
			if !known[placeholder] {
				unknown = append(unknown, placeholder)
			}
		}
		if len(unknown) == 0 {
			return ""
		}
		sort.Strings(unknown)
		return label + "包含不支持的变量：" + strings.Join(unknown, "、") + "；可用变量：" + strings.Join(allowed, "、")
	}
	if problem := check("角色参考图提示词", a.CharacterPrompt, CharacterAssetVariables); problem != "" {
		return problem
	}
	if problem := check("场景参考图提示词", a.ScenePrompt, SceneAssetVariables); problem != "" {
		return problem
	}
	return check("道具参考图提示词", a.PropPrompt, PropAssetVariables)
}

func renderAssetTemplate(template string, values map[string]string) string {
	rendered := template
	for key, value := range values {
		rendered = strings.ReplaceAll(rendered, "{{"+key+"}}", strings.TrimSpace(value))
	}
	// 变量为空时清掉残留的孤立句号，避免出现“。。”。
	rendered = strings.NewReplacer("。。", "。", "：。", "。").Replace(rendered)
	return strings.TrimSpace(rendered)
}
