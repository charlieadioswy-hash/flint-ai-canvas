package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func (s *Service) PreflightDramaCastView(userID, projectID, castID, viewID string, req DramaCastViewActionRequest) (DramaCastViewPreflight, error) {
	if err := s.dramaCastViewScope(userID, projectID, castID); err != nil {
		return DramaCastViewPreflight{}, err
	}
	plan, err := s.prepareDramaCastView(s.repo, userID, projectID, castID, viewID, req)
	return plan.view, dramaCastViewError(err)
}

func (s *Service) QuoteDramaCastViewDraft(userID, projectID, castID, viewID string, req DramaCastViewSaveRequest) (DramaCastViewPreflight, error) {
	if err := s.dramaCastViewScope(userID, projectID, castID); err != nil {
		return DramaCastViewPreflight{}, err
	}
	if req.ExpectedRevision == nil || req.ExpectedCastRevision == nil || req.ViewRevision == nil {
		return DramaCastViewPreflight{}, BadAuthRequest("请提供作品、资产和视图版本")
	}
	plan, err := s.prepareDramaCastViewWithDraft(s.repo, userID, projectID, castID, viewID, DramaCastViewActionRequest{EpisodeID: req.EpisodeID, ExpectedRevision: req.ExpectedRevision, ViewRevision: req.ViewRevision}, &req.Config, req.ExpectedCastRevision)
	plan.view.ConfirmationToken = ""
	return plan.view, dramaCastViewError(err)
}

func (s *Service) prepareDramaCastView(repo *repository.Repository, userID, projectID, castID, viewID string, req DramaCastViewActionRequest) (dramaCastViewPlan, error) {
	return s.prepareDramaCastViewWithDraft(repo, userID, projectID, castID, viewID, req, nil, nil)
}

func (s *Service) prepareDramaCastViewWithDraft(repo *repository.Repository, userID, projectID, castID, viewID string, req DramaCastViewActionRequest, draft *DramaCastViewConfig, expectedCastRevision *int64) (dramaCastViewPlan, error) {
	req.EpisodeID = strings.TrimSpace(req.EpisodeID)
	plan := dramaCastViewPlan{}
	row := &model.DramaCastView{ProjectID: projectID, CastID: castID}
	if viewID != "" {
		stored, err := repo.DramaCastView(projectID, castID, viewID)
		if err != nil {
			return plan, err
		}
		row = stored
	} else if draft == nil {
		return plan, BadAuthRequest("请先保存视图配置")
	}
	if draft != nil {
		config, err := normalizeDramaCastViewConfig(*draft)
		if err != nil {
			return plan, err
		}
		encoded, _ := json.Marshal(config)
		row.ConfigJSON = string(encoded)
	}
	cast, err := repo.DramaCast(projectID, castID)
	if err != nil {
		return plan, err
	}
	p, err := repo.DramaProduction(projectID)
	if err != nil {
		return plan, err
	}
	plan.row, plan.cast, plan.view.Revision, plan.view.ViewRevision = *row, *cast, p.Revision, row.Revision
	plan.sourceHash, err = dramaCastViewContextSource(repo, *cast, req.EpisodeID)
	if err != nil {
		return plan, err
	}
	if req.ExpectedRevision != nil && *req.ExpectedRevision != p.Revision || req.ViewRevision != nil && *req.ViewRevision != row.Revision || expectedCastRevision != nil && *expectedCastRevision != cast.Revision {
		return plan, repository.ErrDramaCastViewChanged
	}
	block := func(reason string) (dramaCastViewPlan, error) { plan.view.Reason = reason; return plan, nil }
	if viewID == "" {
		rows, err := repo.DramaCastViews(projectID, castID)
		if err != nil {
			return plan, err
		}
		if len(rows) >= 24 {
			return block("每项资产最多 24 个独立视图")
		}
	}
	if dramaGuideActive(p) && p.GuideStep != model.DramaGuideAssets && p.GuideStep != model.DramaGuideStory {
		return block("请先确认基础配置并提取资产文字")
	}
	if err := s.requireDramaCastViewIdle(repo, userID, *row); err != nil {
		return block(err.Error())
	}
	if !dramaCastHasImageDefinition(*cast) {
		return block("请先补充主体描述或图片提示词，不根据名称猜测形象")
	}
	var config DramaCastViewConfig
	if err := json.Unmarshal([]byte(row.ConfigJSON), &config); err != nil {
		return plan, BadAuthRequest("视图配置损坏")
	}
	settings, err := dramaCastContextSettings(repo, p, req.EpisodeID)
	if err != nil {
		return plan, err
	}
	meta := parseDramaBibleMeta(p.BibleJSON)
	defaults := parseDramaSettings(p.SettingsJSON)
	if settings.StyleName != defaults.StyleName || settings.StylePrompt != defaults.StylePrompt {
		meta.VisualRules = "保持本集视觉风格统一"
	}
	source := *cast
	if source.ImagePrompt == "" {
		source.ImagePrompt = buildDramaCastImagePrompt(settings, meta, *cast)
	}
	compiled, err := dramaCastViewImageCast(source, config)
	if err != nil {
		return block(err.Error())
	}
	if cast.ImageStatus == model.DramaMediaReady && cast.ImageResourceID != "" {
		opts, err := parseDramaCastImageOptions(compiled.ImageOptionsJSON)
		if err != nil {
			return plan, err
		}
		seen := false
		for _, id := range append(append([]string{}, opts.SubjectReferenceIDs...), opts.StyleReferenceIDs...) {
			if id == cast.ImageResourceID {
				seen = true
			}
		}
		if !seen {
			opts.SubjectReferenceIDs = append([]string{cast.ImageResourceID}, opts.SubjectReferenceIDs...)
		}
		encoded, _ := json.Marshal(opts)
		compiled.ImageOptionsJSON = string(encoded)
	}
	image, err := s.dramaCastImagePlanFor(repo, userID, settings, compiled)
	if err != nil {
		return block(err.Error())
	}
	providerConfig := map[string]any{"count": "1"}
	image.Request.apply(providerConfig)
	if image.Choice.ChannelID != "" {
		providerConfig["channelId"], providerConfig["model"], providerConfig["channelModelKey"] = image.Choice.ChannelID, image.Choice.ModelKey, image.Choice.ModelKey
	}
	refs := []any{}
	appendReference := func(resource model.Resource) {
		plan.resourceIDs = append(plan.resourceIDs, resource.ID)
		refs = append(refs, map[string]any{"id": resource.ID, "name": fmt.Sprintf("参考图%d", len(refs)+1), "storageKey": "resource:" + resource.ID, "mimeType": resource.MimeType, "type": resource.MimeType, "bytes": resource.Size, "width": resource.Width, "height": resource.Height, "role": "reference_image"})
	}
	if cast.ParentID != "" {
		parent, err := repo.DramaCast(projectID, cast.ParentID)
		if err != nil {
			return plan, err
		}
		resource, err := repo.ResourceForUser(userID, parent.ImageResourceID)
		if err != nil || parent.ImageStatus != model.DramaMediaReady || resource.Kind != "image" || resource.Status != model.ResourceStatusReady {
			return block("请先生成角色本体图片")
		}
		appendReference(*resource)
	}
	for _, resource := range image.Resources {
		appendReference(resource)
	}
	prompt := buildDramaCastImagePrompt(settings, meta, compiled)
	input := map[string]any{"mode": "image", "prompt": prompt, "config": providerConfig, "referenceImages": refs, "metadata": map[string]any{"source": "drama_cast_view", "domainProjectId": projectID, "dramaCastId": castID, "dramaCastViewId": viewID, "dramaEpisodeId": req.EpisodeID}}
	encoded, _ := json.Marshal(input)
	var requestInput map[string]any
	_ = json.Unmarshal(encoded, &requestInput)
	frontend, err := s.FeatureEnabled(FeatureFrontendModels)
	if err != nil {
		return plan, err
	}
	_, resolved, err := s.resolveTaskModelSelection(userID, input, image.Choice.LogicalModelID, "canvas_image", image.Intent.Operation, frontend)
	if err != nil {
		return block(err.Error())
	}
	if err := s.ValidateTaskCapability(resolved); err != nil {
		return block(err.Error())
	}
	intent := ModelRequestIntentFromTaskInput(resolved, "canvas_image", image.Intent.Operation)
	var quote *LogicalModelQuote
	if image.Choice.LogicalModelID != "" {
		quote, err = s.QuoteLogicalModel(userID, image.Choice.LogicalModelID, intent)
	} else {
		quote, err = s.QuoteChannelModel(userID, ChannelModelQuoteRequest{ChannelID: image.Choice.ChannelID, ModelKey: image.Choice.ModelKey, Intent: intent})
	}
	if err != nil || quote == nil {
		return block("当前视图参数无法取得有效报价")
	}
	plan.view.AmountMicrocredits, plan.view.Priced, plan.view.Estimated = quote.AmountMicrocredits, true, quote.Estimated
	account, err := repo.CreditAccount(userID)
	if err != nil {
		return plan, err
	}
	if account.AvailableMicrocredits < quote.AmountMicrocredits {
		return block("积分不足")
	}
	if p.BudgetMicrocredits > 0 {
		totals, err := s.dramaBillingTotals(p)
		if err != nil {
			return plan, err
		}
		if totals.ChargedMicrocredits()+totals.HeldMicrocredits()+quote.AmountMicrocredits > p.BudgetMicrocredits {
			return block("剩余制作预算不足")
		}
	}
	plan.view.Ready = true
	plan.view.ScopeHash = dramaCastViewDigest([]any{projectID, castID, req.EpisodeID, plan.sourceHash, image.Choice, image.Options, prompt, plan.resourceIDs, intent})
	plan.view.ConfirmationToken = dramaCastViewDigest([]any{projectID, cast, row, p.Revision, p.GuideStep, req.EpisodeID, plan.sourceHash, image.Options, prompt, plan.resourceIDs, intent, quote})
	plan.request = CreateTaskRequest{ProjectID: projectID, Type: "canvas_image", Operation: image.Intent.Operation, Prompt: prompt, LogicalModelID: image.Choice.LogicalModelID, Model: image.Choice.ModelKey, Input: requestInput}
	return plan, nil
}

func (s *Service) ExecuteDramaCastView(userID, projectID, castID, viewID string, req DramaCastViewActionRequest) (*model.Task, error) {
	if err := s.dramaCastViewScope(userID, projectID, castID); err != nil {
		return nil, err
	}
	if req.ExpectedRevision == nil || req.ViewRevision == nil || req.ConfirmationToken == "" || req.ClientOperationID == "" {
		return nil, BadAuthRequest("请先预检并确认本视图生成")
	}
	submission, err := newTaskSubmission(userID, req.ClientOperationID, "drama_cast_view", []any{projectID, castID, viewID, req})
	if err != nil {
		return nil, err
	}
	if task, err := s.replayDramaCastViewTask(userID, submission); task != nil || err != nil {
		return task, err
	}
	plan, err := s.prepareDramaCastView(s.repo, userID, projectID, castID, viewID, req)
	if err != nil {
		return nil, dramaCastViewError(err)
	}
	if !plan.view.Ready || plan.view.ConfirmationToken != req.ConfirmationToken {
		return nil, dramaGuideConflict("视图内容、引用或报价已改变，请重新预检")
	}
	meta := plan.request.Input["metadata"].(map[string]any)
	meta["dramaCastViewRevision"], meta["dramaCastViewSourceHash"], meta["dramaCastViewRequestHash"] = plan.row.Revision+1, plan.sourceHash, submission.Hash
	prepare := &creationTaskPreparation{}
	plan.request.creationPrepare, plan.request.admission = prepare, &taskAdmission{ID: submission.ID, MaxCharge: plan.view.AmountMicrocredits}
	task, err := s.CreateTask(userID, plan.request)
	if err != nil {
		return nil, err
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		return nil, err
	}
	if err := s.protectTaskSecrets(input); err != nil {
		return nil, err
	}
	encoded, _ := json.Marshal(input)
	task.InputJSON = string(encoded)
	if prepare.Order != nil {
		task.BillingOrderID = prepare.Order.ID
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	take := model.DramaTake{ID: newID(), ProjectID: projectID, OwnerID: viewID, Kind: "cast_view", TaskID: task.ID, Prompt: task.Prompt, CreatedAt: time.Now()}
	s.storageMu.Lock()
	err = s.repo.Transaction(func(repo *repository.Repository) error {
		if _, err := repo.DramaProductionForUpdate(projectID); err != nil {
			return err
		}
		if err := repo.LockDramaCastImageReferences(userID, plan.resourceIDs); err != nil {
			return err
		}
		fresh, err := s.prepareDramaCastView(repo, userID, projectID, castID, viewID, req)
		if err != nil {
			return err
		}
		if !fresh.view.Ready || fresh.view.ConfirmationToken != req.ConfirmationToken {
			return repository.ErrDramaCastViewChanged
		}
		if err := createTaskWithStorageQuotaRepository(repo, task, prepare.Order, policy); err != nil {
			return err
		}
		fresh.row.SourceHash = fresh.sourceHash
		return repo.BindDramaCastViewTask(&fresh.row, &take)
	})
	s.storageMu.Unlock()
	if err != nil {
		if task, replayErr := s.replayDramaCastViewTask(userID, submission); task != nil || replayErr != nil {
			return task, replayErr
		}
		return nil, dramaCastViewError(err)
	}
	s.recordActivity(userID, "task", 1)
	s.wakeTaskDispatcher()
	return taskForOutput(*task), nil
}

func (s *Service) replayDramaCastViewTask(userID string, submission *taskSubmission) (*model.Task, error) {
	task, err := s.repo.TaskForUser(userID, submission.ID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var input struct {
		Metadata struct {
			Source string `json:"source"`
			Hash   string `json:"dramaCastViewRequestHash"`
		} `json:"metadata"`
	}
	if json.Unmarshal([]byte(task.InputJSON), &input) != nil || input.Metadata.Source != "drama_cast_view" || input.Metadata.Hash != submission.Hash {
		return nil, dramaGuideConflict("相同提交标识的视图内容不同")
	}
	return taskForOutput(*task), nil
}
