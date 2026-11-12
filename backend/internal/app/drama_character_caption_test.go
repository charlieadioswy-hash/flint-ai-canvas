package app

import (
	"encoding/json"
	"strings"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

const dramaCharacterCaption = "（人物字幕：陆承明　小说黄毛）"
const dramaCaptionAppearance = "头发染得金黄，穿着一身廉价运动外套"
const dramaCaptionDescription = "穿越进小说里的炮灰男配"
const dramaCaptionVoice = "语气义正辞严"
const dramaCaptionScript = "床的另一侧站着一个年轻男人，头发染得金黄，穿着一身廉价运动外套。\n" + dramaCharacterCaption + "\n陆承明是穿越进小说里的炮灰男配，别名黄毛。陆承明语气义正辞严。"

func dramaCaptionBibleTask(t *testing.T) *model.Task {
	t.Helper()
	body, err := json.Marshal(production.Bible{
		VisualRules: "当代都市服化道",
		Characters: []production.BibleCharacter{{
			Name: "陆承明", Aliases: []string{"黄毛"}, Gender: "男",
			Description: dramaCaptionDescription, Appearance: dramaCaptionAppearance, Voice: dramaCaptionVoice,
			SourceDefinition: dramaCharacterCaption, SourceChapterIndex: 1,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := json.Marshal(map[string]string{"mode": "text", "text": string(body)})
	if err != nil {
		t.Fatal(err)
	}
	return &model.Task{ResultJSON: string(result)}
}

func TestDramaBibleCharacterCaptionKeepsExtractedFieldsAndImagePrompt(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc, DramaChapterInput{Title: "第一集", Text: dramaCaptionScript})
	assets := confirmGuide(t, svc, draft)
	row, err := svc.repo.DramaProduction(draft.Project.ID)
	if err != nil {
		t.Fatal(err)
	}
	run := &dramaRun{s: svc, project: &draft.Project, production: row, settings: assets.Production.Settings}
	if err := run.applyBible(dramaCaptionBibleTask(t)); err != nil {
		t.Fatal(err)
	}
	casts, err := svc.repo.DramaCasts(draft.Project.ID)
	if err != nil || len(casts) != 1 {
		t.Fatalf("expected one extracted character: %+v, %v", casts, err)
	}
	cast := casts[0]
	if cast.Description != dramaCaptionDescription || cast.Appearance != "男，"+dramaCaptionAppearance || cast.VoiceInstructions != "男，"+dramaCaptionVoice || cast.AliasesJSON != `["黄毛"]` {
		t.Fatalf("character caption must not erase extracted text fields: %+v", cast)
	}
	// 全局规则不含人物外观，实际参考图提示词必须从已保存的资产读取。
	prompt := buildDramaCastImagePrompt(run.settings, run.meta, cast)
	if !strings.Contains(prompt, cast.Appearance) || strings.Contains(prompt, dramaCharacterCaption) {
		t.Fatalf("image prompt must use saved appearance instead of the caption: %s", prompt)
	}
	run.casts = casts
	if summary := run.castSummary("character", 30); !strings.Contains(summary, dramaCaptionDescription) || !strings.Contains(summary, dramaCaptionAppearance) {
		t.Fatalf("later script context must receive extracted fields: %s", summary)
	}
	if len(fake.requests) != 0 {
		t.Fatalf("applying text extraction must not submit media: %+v", fake.requests)
	}
}

func TestDramaBibleCharacterCaptionDoesNotOverwriteManualAsset(t *testing.T) {
	svc, _ := newDramaTestService(t)
	draft := createGuidedDrama(t, svc, DramaChapterInput{Title: "第一集", Text: dramaCaptionScript})
	assets := confirmGuide(t, svc, draft)
	manual, err := svc.CreateDramaCast("usr-drama", draft.Project.ID, CreateDramaCastRequest{
		ExpectedRevision: &assets.Production.Revision, Kind: "character", Name: "陆承明",
		Description: "用户确认的人物说明", Appearance: "用户确认的服装", VoiceInstructions: "用户确认的声线",
		ImagePrompt: "用户确认的完整图片提示词",
	})
	if err != nil {
		t.Fatal(err)
	}
	row, err := svc.repo.DramaProduction(draft.Project.ID)
	if err != nil {
		t.Fatal(err)
	}
	run := &dramaRun{s: svc, project: &draft.Project, production: row, settings: assets.Production.Settings}
	if err := run.applyBible(dramaCaptionBibleTask(t)); err != nil {
		t.Fatal(err)
	}
	casts, err := svc.repo.DramaCasts(draft.Project.ID)
	if err != nil || len(casts) != 1 {
		t.Fatalf("re-extraction must reuse the existing asset: %+v, %v", casts, err)
	}
	got := casts[0]
	if got.ID != manual.ID || got.Description != manual.Description || got.Appearance != manual.Appearance || got.VoiceInstructions != manual.VoiceInstructions || got.ImagePrompt != manual.ImagePrompt || got.Revision != manual.Revision {
		t.Fatalf("caption fallback must preserve manual asset changes: before=%+v after=%+v", manual, got)
	}
}
