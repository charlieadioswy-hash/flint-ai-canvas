package app

import (
	"encoding/json"
	"strings"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

const dramaDefinedCharacter = "1. 秦子文\n\n年龄：26岁\n\n性格：冷静谨慎，务实有主见\n\n背景：父母出事后，秦子文承担起照顾弟弟的责任，放弃原本的保研机会，工作供弟弟读书。刚买下市中心的房子，小区便整体穿越倒了森林。面对生存压力，他带弟弟寻找物资，意外觉醒“每日结算”系统，开始利用奖励建设家园，争取让兄弟俩安稳活下去。"

func dramaCharacterDefinitionTask(t *testing.T, definition string, sourceChapter int) *model.Task {
	t.Helper()
	bible, err := json.Marshal(map[string]any{
		"characters": []map[string]any{
			{"name": "秦子文", "age": "26岁", "description": "模型改写的富家公子", "appearance": "银发、黑色风衣", "voice": "磁性低沉", "sourceDefinition": definition, "sourceChapterIndex": sourceChapter},
			{"name": "秦子明", "description": "秦子文的弟弟", "appearance": "蓝色校服"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := json.Marshal(map[string]any{"mode": "text", "text": string(bible)})
	if err != nil {
		t.Fatal(err)
	}
	return &model.Task{ResultJSON: string(result)}
}

func TestDramaBiblePreservesDefinedCharacterAndExtractsOthers(t *testing.T) {
	svc, _ := newDramaTestService(t)
	// 长说明也不能被旧的 1000 字存储或 60 字分镜摘要截断。
	definition := dramaDefinedCharacter + "\n补充经历：" + strings.Repeat("秦子文带弟弟寻找物资。", 100) + "保留结尾原句。"
	draft := createGuidedDrama(t, svc, DramaChapterInput{Title: "人物与第一集", Text: definition + "\n\n第一集\n秦子明穿着蓝色校服来到哥哥身边。"})
	assets := confirmGuide(t, svc, draft)
	row, err := svc.repo.DramaProduction(draft.Project.ID)
	if err != nil {
		t.Fatal(err)
	}
	run := &dramaRun{s: svc, project: &draft.Project, production: row, settings: assets.Production.Settings}
	if err := run.applyBible(dramaCharacterDefinitionTask(t, definition, 1)); err != nil {
		t.Fatal(err)
	}
	casts, err := svc.repo.DramaCasts(draft.Project.ID)
	if err != nil || len(casts) != 2 {
		t.Fatalf("expected source-defined and extracted characters: %+v, %v", casts, err)
	}
	byName := map[string]model.DramaCast{}
	for _, cast := range casts {
		byName[cast.Name] = cast
	}
	defined, extracted := byName["秦子文"], byName["秦子明"]
	if defined.Description != definition || defined.Appearance != "26岁" || strings.Contains(defined.VoiceInstructions, "磁性") {
		t.Fatalf("explicit definition must replace rewriting and invented fields: %+v", defined)
	}
	if extracted.Description != "秦子文的弟弟" || extracted.Appearance != "蓝色校服" {
		t.Fatalf("ordinary source extraction must remain available: %+v", extracted)
	}
	run.casts = casts
	summary := run.castSummary("character", 30)
	if !strings.Contains(summary, definition) || !strings.Contains(summary, "蓝色校服") {
		t.Fatalf("later script context must receive full character definitions: %s", summary)
	}
	current := guideSummary(t, svc, draft.Project.ID)
	name := "秦子文（哥哥）"
	updated, err := svc.UpdateDramaCast("usr-drama", draft.Project.ID, defined.ID, UpdateDramaCastRequest{
		ExpectedRevision: &current.Production.Revision, Name: &name,
		Description: &defined.Description, Appearance: &defined.Appearance, VoiceInstructions: &defined.VoiceInstructions,
	})
	if err != nil || updated.Description != definition || updated.Name != name {
		t.Fatalf("editing a name must not truncate an unchanged source definition: %+v, %v", updated, err)
	}
	casts, err = svc.repo.DramaCasts(draft.Project.ID)
	if err != nil {
		t.Fatal(err)
	}
	// 无需改动数据库结构，既有资产也不能被后续 Bible 结果自动改写。
	if err := run.applyBible(dramaCharacterDefinitionTask(t, definition, 1)); err != nil {
		t.Fatal(err)
	}
	again, err := svc.repo.DramaCasts(draft.Project.ID)
	if err != nil || len(again) != 2 || again[0].ID != casts[0].ID || again[0].Description != casts[0].Description {
		t.Fatalf("reapplying bible must preserve saved assets: %+v, %v", again, err)
	}
}

func TestDramaBibleRejectsRewrittenDefinitionBeforeSaving(t *testing.T) {
	svc, _ := newDramaTestService(t)
	draft := createGuidedDrama(t, svc, DramaChapterInput{Title: "人物设定", Text: dramaDefinedCharacter})
	assets := confirmGuide(t, svc, draft)
	row, err := svc.repo.DramaProduction(draft.Project.ID)
	if err != nil {
		t.Fatal(err)
	}
	run := &dramaRun{s: svc, project: &draft.Project, production: row, settings: assets.Production.Settings}
	err = run.applyBible(dramaCharacterDefinitionTask(t, strings.ReplaceAll(dramaDefinedCharacter, "26岁", "30岁"), 1))
	if err == nil {
		t.Fatal("rewritten source quote must be rejected")
	}
	casts, loadErr := svc.repo.DramaCasts(draft.Project.ID)
	if loadErr != nil || len(casts) != 0 {
		t.Fatalf("invalid definition must not partially save assets: %+v, %v", casts, loadErr)
	}
}

func TestParseBibleSourceDefinitionRequiresChapterEvidence(t *testing.T) {
	text := `{"characters":[{"name":"秦子文","sourceDefinition":"秦子文：26岁，冷静谨慎。","sourceChapterIndex":"2"}]}`
	definition := "秦子文：26岁，冷静谨慎。"
	bible, err := production.ParseBible(text, production.Chapter{Index: 2, Text: definition})
	if err != nil || bible.Characters[0].Description != definition {
		t.Fatalf("model JSON source reference must restore the document: %+v, %v", bible, err)
	}
	if _, err := production.ParseBible(text, production.Chapter{Index: 1, Text: definition}); err == nil {
		t.Fatal("a quote from a different chapter must be rejected")
	}
}
