package app

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"
)

type DramaCastImageOptions struct {
	Model               DramaModelChoice `json:"model"`
	Ratio               string           `json:"ratio"`
	Resolution          string           `json:"resolution"`
	SubjectReferenceIDs []string         `json:"subjectReferenceIds"`
	StyleReferenceIDs   []string         `json:"styleReferenceIds"`
}

type UpdateDramaCastImageOptionsRequest struct {
	ExpectedRevision     *int64                `json:"expectedRevision"`
	ExpectedCastRevision *int64                `json:"expectedCastRevision"`
	Options              DramaCastImageOptions `json:"options"`
}

type dramaCastImagePlan struct {
	Choice    DramaModelChoice
	Ratio     string
	Request   dramaImageRequest
	Intent    ModelRequestIntent
	Options   DramaCastImageOptions
	Resources []model.Resource
}

func parseDramaCastImageOptions(value string) (DramaCastImageOptions, error) {
	options := DramaCastImageOptions{}
	if value != "" {
		if err := json.Unmarshal([]byte(value), &options); err != nil {
			return options, BadAuthRequest("资产图片配置损坏，请重新保存配置")
		}
	}
	return options, nil
}

// 保存、单图/补图预检与 worker 共用相同的有效参数和参考顺序。
func (s *Service) dramaCastImagePlanFor(repo *repository.Repository, userID string, settings DramaSettings, cast model.DramaCast) (dramaCastImagePlan, error) {
	opts, err := parseDramaCastImageOptions(cast.ImageOptionsJSON)
	plan := dramaCastImagePlan{Options: opts}
	if err != nil {
		return plan, err
	}
	if opts.Model.LogicalModelID != "" && (opts.Model.ChannelID != "" || opts.Model.ModelKey != "") || opts.Model.LogicalModelID == "" && (opts.Model.ChannelID == "") != (opts.Model.ModelKey == "") {
		return plan, BadAuthRequest("请选择完整且唯一的资产图片模型")
	}
	plan.Choice = opts.Model
	if plan.Choice.Empty() {
		plan.Choice = settings.Models.imageFor(cast.Kind)
	}
	plan.Ratio = opts.Ratio
	if plan.Ratio == "" {
		plan.Ratio = production.AssetImageRatio
		if cast.Kind == "character" {
			plan.Ratio = settings.Assets.CharacterRatio
		}
	}
	if !slices.Contains(dramaAssetRatios, plan.Ratio) {
		return plan, BadAuthRequest("资产图片画幅无效")
	}
	tier := opts.Resolution
	if tier == "" {
		tier = settings.Assets.ResolutionFor(cast.Kind)
	}
	if tier != "" && !slices.Contains(DramaImageTiers, tier) {
		return plan, BadAuthRequest("资产图片分辨率无效")
	}
	plan.Request = s.dramaImageRequestFor(plan.Choice, plan.Ratio, tier)
	if plan.Request.Issue != "" {
		return plan, BadAuthRequest(plan.Request.Issue)
	}
	ids := append(append([]string{}, opts.SubjectReferenceIDs...), opts.StyleReferenceIDs...)
	if len(ids) > 8 {
		return plan, BadAuthRequest("主体和风格参考合计最多 8 张")
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if strings.TrimSpace(id) == "" || seen[id] {
			return plan, BadAuthRequest("参考图片不能为空或在两组中重复")
		}
		seen[id] = true
		resource, err := repo.ResourceForUser(userID, id)
		if err != nil {
			return plan, BadAuthRequest("参考图片不存在或无权使用")
		}
		if resource.Status != model.ResourceStatusReady || resource.Kind != "image" || !strings.HasPrefix(resource.MimeType, "image/") {
			return plan, BadAuthRequest("参考图片尚未就绪或不是图片")
		}
		plan.Resources = append(plan.Resources, *resource)
	}
	count := len(ids)
	if cast.ParentID != "" {
		count++
	}
	operation := "text_to_image"
	if count > 0 {
		operation = "image_to_image"
	}
	options := map[string]any{}
	plan.Request.apply(options)
	plan.Intent = ModelRequestIntent{Capability: "image", Operation: operation, Options: options, Inputs: map[string]int{"image": count}}
	if spec, _, ok := s.dramaImageSpec(plan.Choice); ok {
		if match := MatchCapability(spec, plan.Intent); !match.Matched {
			return plan, BadAuthRequest("资产图片配置与模型能力不匹配：" + strings.Join(match.Reasons, "；"))
		}
	}
	return plan, nil
}

func (s *Service) UpdateDramaCastImageOptions(userID, projectID, castID string, req UpdateDramaCastImageOptionsRequest) (model.DramaCast, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return model.DramaCast{}, err
	}
	if req.ExpectedRevision == nil || req.ExpectedCastRevision == nil {
		return model.DramaCast{}, BadAuthRequest("请提供当前作品和资产版本")
	}
	options := req.Options
	options.Ratio = strings.TrimSpace(options.Ratio)
	options.Resolution = strings.ToLower(strings.TrimSpace(options.Resolution))
	encoded, _ := json.Marshal(options)
	if err := s.withDramaTextEdit(projectID, req.ExpectedRevision, false, func(tx *repository.Repository) error {
		p, err := tx.DramaProduction(projectID)
		if err != nil {
			return err
		}
		cast, err := tx.DramaCast(projectID, castID)
		if err != nil {
			return dramaLookupError(err)
		}
		if cast.Revision != *req.ExpectedCastRevision {
			return dramaGuideConflict("资产配置已改变，请刷新后重新编辑")
		}
		if mediaBusyStatus(cast.ImageStatus) {
			return dramaGuideConflict("资产图片正在生成或排队，请完成后再改配置")
		}
		jobs, err := tx.DramaJobsByStatus(projectID, model.DramaJobQueued, model.DramaJobRunning)
		if err != nil {
			return err
		}
		for _, job := range jobs {
			if job.Kind == model.DramaJobCastImage && job.CastID == castID {
				return dramaGuideConflict("资产图片任务正在进行，请完成后再改配置")
			}
		}
		ids := append(append([]string{}, options.SubjectReferenceIDs...), options.StyleReferenceIDs...)
		if err := tx.LockDramaCastImageReferences(userID, ids); err != nil {
			return BadAuthRequest("参考图片已变化或无权使用，请重新选择")
		}
		cast.ImageOptionsJSON = string(encoded)
		plan, err := s.dramaCastImagePlanFor(tx, userID, parseDramaSettings(p.SettingsJSON), *cast)
		if err != nil {
			return err
		}
		if s.dramaTaskHook == nil {
			if err := s.requireDramaModelOption(userID, "image", plan.Choice); err != nil {
				return err
			}
		}
		return tx.UpdateDramaCastFields(castID, map[string]any{"image_options_json": string(encoded)})
	}); err != nil {
		return model.DramaCast{}, err
	}
	cast, err := s.repo.DramaCast(projectID, castID)
	if err != nil {
		return model.DramaCast{}, err
	}
	return *cast, nil
}

func dramaCastReferenceInstructions(cast model.DramaCast) string {
	opts, err := parseDramaCastImageOptions(cast.ImageOptionsJSON)
	if err != nil {
		return ""
	}
	offset := 1
	if cast.ParentID != "" {
		offset++
	}
	lines := []string{}
	for i := range opts.SubjectReferenceIDs {
		lines = append(lines, fmt.Sprintf("参考图%d用于主体身份、外形与结构一致性，内容以本资产设定为准。", offset+i))
	}
	offset += len(opts.SubjectReferenceIDs)
	for i := range opts.StyleReferenceIDs {
		lines = append(lines, fmt.Sprintf("参考图%d仅参考画风、材质、光照与色彩，不引入图中的人物或物体。", offset+i))
	}
	return strings.Join(lines, "\n")
}
