package app

import (
	"reflect"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaSourceAssetIDs(t *testing.T) {
	tests := []struct {
		name     string
		chapters []model.ProjectUnit
		casts    []model.DramaCast
		want     []string
	}{
		{
			name:     "longest names suppress contained props but retain independent mentions",
			chapters: []model.ProjectUnit{{SourceText: "奖励：简易陷阱制作图纸（残页）。他拿起水果刀。"}, {SourceText: "另一日，他做好简易陷阱。"}},
			casts: []model.DramaCast{
				{ID: "trap", Kind: "prop", Name: "简易陷阱"},
				{ID: "knife", Kind: "prop", Name: "刀"},
				{ID: "blueprint", Kind: "prop", Name: "简易陷阱制作图纸(残页)"},
				{ID: "fruit-knife", Kind: "prop", Name: "水果刀"},
			},
			want: []string{"trap", "blueprint", "fruit-knife"},
		},
		{
			name:     "blueprint mention alone does not imply a built trap",
			chapters: []model.ProjectUnit{{SourceText: "你获得简易陷阱制作图纸（残页）。"}},
			casts: []model.DramaCast{
				{ID: "trap", Kind: "prop", Name: "简易陷阱"},
				{ID: "blueprint", Kind: "prop", Name: "简易陷阱制作图纸(残页)"},
			},
			want: []string{"blueprint"},
		},
		{
			name:     "asset kinds do not suppress each other",
			chapters: []model.ProjectUnit{{SourceText: "秦家卧室，桌上摆着卧室钥匙。"}},
			casts: []model.DramaCast{
				{ID: "family", Kind: "character", Name: "秦家"},
				{ID: "room", Kind: "scene", Name: "秦家卧室"},
				{ID: "key", Kind: "prop", Name: "卧室钥匙"},
				{ID: "room-prop", Kind: "prop", Name: "秦家卧室"},
			},
			want: []string{"family", "room", "key", "room-prop"},
		},
		{
			name:     "ambiguous names and aliases are not assigned",
			chapters: []model.ProjectUnit{{SourceText: "老王来到客厅，打开简易陷阱图纸。"}},
			casts: []model.DramaCast{
				{ID: "wang-one", Kind: "character", Name: "王明", AliasesJSON: `["老王"]`},
				{ID: "wang-two", Kind: "character", Name: "老王"},
				{ID: "room-one", Kind: "scene", Name: "客厅"},
				{ID: "room-two", Kind: "scene", Name: "客厅"},
				{ID: "trap", Kind: "prop", Name: "简易陷阱"},
				{ID: "blueprint-one", Kind: "prop", Name: "简易陷阱图纸"},
				{ID: "blueprint-two", Kind: "prop", Name: "简易陷阱图纸"},
			},
			want: []string{},
		},
		{
			name:     "unambiguous evidence remains usable for asset with ambiguous alias",
			chapters: []model.ProjectUnit{{SourceText: "王明和老王来到大厅。"}},
			casts: []model.DramaCast{
				{ID: "wang-one", Kind: "character", Name: "王明", AliasesJSON: `["老王","王明"]`},
				{ID: "wang-two", Kind: "character", Name: "王强", AliasesJSON: `["老王"]`},
				{ID: "hall", Kind: "scene", Name: "萧家大厅", AliasesJSON: `["大厅"," 大厅 "]`},
			},
			want: []string{"wang-one", "hall"},
		},
		{
			name:     "case parentheses and whitespace normalize without removing punctuation",
			chapters: []model.ProjectUnit{{SourceText: "ALICE\t  SMITH走进大厅，拿着图纸（残页）。秦，子文与秦 子武在门外。"}},
			casts: []model.DramaCast{
				{ID: "alice", Kind: "character", Name: "Alice Smith"},
				{ID: "paper", Kind: "prop", Name: "图纸(残页)"},
				{ID: "qin-one", Kind: "character", Name: "秦子文"},
				{ID: "qin-two", Kind: "character", Name: "秦子武"},
			},
			want: []string{"alice", "paper"},
		},
		{
			name:     "latin names require word boundaries",
			chapters: []model.ProjectUnit{{SourceText: "Anna与Agent01到场。Ann不在；agent0没有来。"}},
			casts: []model.DramaCast{
				{ID: "ann", Kind: "character", Name: "Ann"},
				{ID: "anna", Kind: "character", Name: "Anna"},
				{ID: "agent", Kind: "character", Name: "Agent0"},
				{ID: "short", Kind: "character", Name: "Age"},
			},
			want: []string{"ann", "anna", "agent"},
		},
		{
			name: "only source text is evidence and chapter boundaries cannot make names",
			chapters: []model.ProjectUnit{
				{Title: "秦子文", SourceText: "秦子"},
				{Title: "大厅", SourceText: "文在房间"},
			},
			casts: []model.DramaCast{
				{ID: "qin", Kind: "character", Name: "秦子文"},
				{ID: "hall", Kind: "scene", Name: "大厅"},
			},
			want: []string{},
		},
		{
			name:     "looks and generation provenance cannot establish association",
			chapters: []model.ProjectUnit{{SourceText: "秦子文走进大厅。"}},
			casts: []model.DramaCast{
				{ID: "base", Kind: "character", Name: "秦子文", AliasesJSON: "invalid json"},
				{ID: "look", Kind: "character", ParentID: "base", Name: "秦子文", LookFromChapter: 1, LookToChapter: 1},
				{ID: "unrelated", Kind: "prop", Name: "打火石", ImageEpisodeID: "episode"},
				{ID: "unknown", Kind: "look", Name: "大厅"},
				{ID: "", Kind: "scene", Name: "大厅"},
				{ID: "empty", Kind: "scene", Name: " \t", AliasesJSON: `["", " "]`},
			},
			want: []string{"base"},
		},
		{
			name:     "empty source returns no assets",
			chapters: []model.ProjectUnit{{Title: "秦子文", SourceText: " \n\t"}},
			casts:    []model.DramaCast{{ID: "qin", Kind: "character", Name: "秦子文", ImageEpisodeID: "episode"}},
			want:     []string{},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := dramaSourceAssetIDs(tt.chapters, tt.casts); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("source assets: got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestDramaEpisodeDetailRecoversOnlyLinkedSourceAssetIDsWithoutWrites(t *testing.T) {
	svc, fake, source := newDramaExtractionSource(t, model.DramaGuideAssets, model.DramaStatusPaused)
	projectID := source.Project.ID
	casts := []model.DramaCast{
		{ID: "source-first-character", ProjectID: projectID, Kind: "character", Name: "萧炎", Position: 1},
		{ID: "source-second-character", ProjectID: projectID, Kind: "character", Name: "纳兰嫣然", Position: 2},
		{ID: "source-second-hall", ProjectID: projectID, Kind: "scene", Name: "大厅", Position: 3},
		{ID: "source-reserved", ProjectID: projectID, Kind: "prop", Name: "预留丙", Position: 4},
		{ID: "source-look", ProjectID: projectID, Kind: "character", ParentID: "source-second-character", Name: "纳兰嫣然", Position: 5},
		{ID: "source-foreign", ProjectID: "other-project", Kind: "prop", Name: "纳兰嫣然", Position: 6},
	}
	if err := fake.db.Create(&casts).Error; err != nil {
		t.Fatal(err)
	}
	for index, want := range [][]string{{"source-first-character"}, {"source-second-character", "source-second-hall"}} {
		episodeID := source.Episodes[index].ID
		for attempt := range 2 {
			detail, err := svc.DramaEpisodeDetail("usr-drama", projectID, episodeID)
			if err != nil {
				t.Fatal(err)
			}
			if len(detail.Shots) != 0 || !reflect.DeepEqual(detail.SourceAssetIDs, want) {
				t.Fatalf("episode %d refresh %d: source assets must be scoped without shots: %+v", index+1, attempt, detail)
			}
			stored, err := svc.repo.DramaEpisode(projectID, episodeID)
			if err != nil {
				t.Fatal(err)
			}
			if stored.AssetIDsJSON != "" || detail.Episode.AssetIDsJSON != "" {
				t.Fatalf("source recovery must not persist inferred membership: stored=%q returned=%q", stored.AssetIDsJSON, detail.Episode.AssetIDsJSON)
			}
		}
	}
	if len(fake.requests) != 0 {
		t.Fatalf("source recovery must not invoke a model: %+v", fake.requests)
	}
}
