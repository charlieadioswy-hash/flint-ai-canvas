package app

import (
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaAudioSelectionSurvivesPreviewFailure(t *testing.T) {
	for _, failure := range []string{"duration", "unavailable-model"} {
		for _, automatic := range []bool{false, true} {
			mode := "manual"
			if automatic {
				mode = "auto"
			}
			t.Run(failure+"/"+mode, func(t *testing.T) {
				f := newDramaGuideRevisionFixture(t, model.DramaGuideCompleted)
				projectID, episodeID := f.summary.Project.ID, f.shot.EpisodeID
				video := dramaVideoFixture()
				video.References.MaxAudios = 2
				setDramaVideoCapability(t, f.svc, f.fake, video)
				sample := f.fake.resource("usr-drama", "audio", "audio/wav")
				if err := f.fake.db.Model(&model.DramaCast{}).Where("id = ?", f.cast.ID).Update("voice_sample_resource_id", sample).Error; err != nil {
					t.Fatal(err)
				}
				second := model.DramaCast{ID: newID(), ProjectID: projectID, Kind: "character", Name: "另一角色", VoiceSampleResourceID: sample}
				if err := f.fake.db.Create(&second).Error; err != nil {
					t.Fatal(err)
				}
				speaker, dialogue, seconds := f.cast.Name, "保留原本的音色", 8.0
				if _, err := f.svc.UpdateDramaShot("usr-drama", projectID, f.shot.ID, UpdateDramaShotRequest{Speaker: &speaker, Dialogue: &dialogue, DurationSeconds: &seconds}); err != nil {
					t.Fatal(err)
				}
				if !automatic {
					selected := []string{f.cast.ID}
					if err := f.svc.UpdateDramaSegment("usr-drama", projectID, episodeID, 0, UpdateDramaSegmentRequest{AudioCastIDs: &selected}); err != nil {
						t.Fatal(err)
					}
				}
				if failure == "duration" {
					video.Duration.Values = []int{5}
					setDramaVideoCapability(t, f.svc, f.fake, video)
				} else if err := f.fake.db.Model(&model.ChannelModel{}).Where("id = ?", "drama-video").Update("enabled", false).Error; err != nil {
					t.Fatal(err)
				}
				detail, err := f.svc.DramaEpisodeDetail("usr-drama", projectID, episodeID)
				if err != nil {
					t.Fatal(err)
				}
				segment := detail.Segments[0]
				request := segment.Request
				if request.Warning == "" || (failure == "duration" && !strings.Contains(request.Warning, "时长上限")) {
					t.Fatalf("expected failed preview: %+v", request)
				}
				if segment.AudioReferenceMode != map[bool]string{false: "custom", true: "auto"}[automatic] || len(request.AudioReferences) != 1 {
					t.Fatalf("failed preview lost audio selection: %+v", segment)
				}
				voice := request.AudioReferences[0]
				if voice.CastID != f.cast.ID || voice.ResourceID != sample || voice.Sent || voice.Label != "" || !strings.Contains(voice.Note, request.Warning) {
					t.Fatalf("selected voice must remain visible and unsent: %+v", voice)
				}
				if failure == "unavailable-model" {
					// 清空选择不依赖模型能力，模型下线也能关闭原来的声音。
					empty := []string{}
					if err := f.svc.UpdateDramaSegment("usr-drama", projectID, episodeID, 0, UpdateDramaSegmentRequest{AudioCastIDs: &empty}); err != nil {
						t.Fatal(err)
					}
					detail, err = f.svc.DramaEpisodeDetail("usr-drama", projectID, episodeID)
					if err != nil || len(detail.Segments[0].Request.AudioReferences) != 0 || detail.Segments[0].AudioReferenceMode != "custom" {
						t.Fatalf("explicit empty selection must remain empty during preview failure: %+v %v", detail, err)
					}
					return
				}
				// 与参考面板一样在详情返回的完整选择上追加，不能因预演错误覆盖掉原音色。
				selected := []string{}
				for _, voice := range request.AudioReferences {
					selected = append(selected, voice.CastID)
				}
				selected = append(selected, second.ID)
				if err := f.svc.UpdateDramaSegment("usr-drama", projectID, episodeID, 0, UpdateDramaSegmentRequest{AudioCastIDs: &selected}); err != nil {
					t.Fatal(err)
				}
				stored, err := f.svc.repo.DramaSegments(episodeID)
				if err != nil || len(stored) != 1 || stored[0].AudioCastIDsJSON != encodeStringList([]string{f.cast.ID, second.ID}) {
					t.Fatalf("adding another voice must retain the original selection: %+v %v", stored, err)
				}
				if len(f.fake.requests) != 0 {
					t.Fatal("preview and audio edits must not submit generation tasks")
				}
			})
		}
	}
}

func TestDramaAudioSelectionCanBeClearedWhenModelStopsSupportingAudio(t *testing.T) {
	f := newDramaGuideRevisionFixture(t, model.DramaGuideCompleted)
	video := dramaVideoFixture()
	video.References.MaxAudios = 1
	setDramaVideoCapability(t, f.svc, f.fake, video)
	sample := f.fake.resource("usr-drama", "audio", "audio/wav")
	if err := f.fake.db.Model(&model.DramaCast{}).Where("id = ?", f.cast.ID).Update("voice_sample_resource_id", sample).Error; err != nil {
		t.Fatal(err)
	}
	selected := []string{f.cast.ID}
	if err := f.svc.UpdateDramaSegment("usr-drama", f.summary.Project.ID, f.shot.EpisodeID, 0, UpdateDramaSegmentRequest{AudioCastIDs: &selected}); err != nil {
		t.Fatal(err)
	}
	video.References.MaxAudios = 0
	setDramaVideoCapability(t, f.svc, f.fake, video)
	detail, err := f.svc.DramaEpisodeDetail("usr-drama", f.summary.Project.ID, f.shot.EpisodeID)
	if err != nil {
		t.Fatal(err)
	}
	request := detail.Segments[0].Request
	if request.ModelMaxAudios != 0 || len(request.AudioReferences) != 1 || request.AudioReferences[0].Sent || !strings.Contains(request.AudioReferences[0].Note, "不支持参考音频") {
		t.Fatalf("unsupported voices must remain selected and removable: %+v", request)
	}
	empty := []string{}
	if err := f.svc.UpdateDramaSegment("usr-drama", f.summary.Project.ID, f.shot.EpisodeID, 0, UpdateDramaSegmentRequest{AudioCastIDs: &empty}); err != nil {
		t.Fatal(err)
	}
	detail, err = f.svc.DramaEpisodeDetail("usr-drama", f.summary.Project.ID, f.shot.EpisodeID)
	if err != nil || len(detail.Segments[0].Request.AudioReferences) != 0 {
		t.Fatalf("cleared selection must stay empty: %+v %v", detail, err)
	}
}
