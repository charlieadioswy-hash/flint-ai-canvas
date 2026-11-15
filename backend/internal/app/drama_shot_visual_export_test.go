package app

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaShotVisualAssetPackageStreamsOnlyAdoptedSelectedEpisodeMedia(t *testing.T) {
	s, db, _ := shotMediaFixture(t)
	if err := db.Model(&model.DramaEpisode{}).Where("id = ?", "episode").Update("number", 1).Error; err != nil {
		t.Fatal(err)
	}
	for _, value := range []any{
		&model.DramaEpisode{ID: "episode-two", ProjectID: "drama-project", Number: 2, Title: "第二集", Stage: model.DramaEpisodeDone},
		&model.DramaShot{ID: "second-shot", ProjectID: "drama-project", EpisodeID: "episode-two", Position: 0, Scene: "第二场", ImagePrompt: "当前剧本画面", VideoPrompt: "当前剧本运动", DurationMs: 2000},
	} {
		if err := db.Create(value).Error; err != nil {
			t.Fatal(err)
		}
	}
	type selectedMedia struct {
		episode, shot, kind, prompt, resourceID string
		data                                    []byte
	}
	var selected []selectedMedia
	for i, shotID := range []string{"real-shot", "second-shot"} {
		episodeID := "episode"
		if i == 1 {
			episodeID = "episode-two"
		}
		for _, kind := range []string{"image", "video"} {
			id := shotID + "-" + kind
			ext, mime := ".png", "image/png"
			if kind == "video" {
				ext, mime = ".mp4", "video/mp4"
			}
			data := []byte("selected-local-" + id)
			key := id + ext
			if err := os.MkdirAll(filepath.Join(s.dataDir, "resources"), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(s.dataDir, "resources", key), data, 0600); err != nil {
				t.Fatal(err)
			}
			resource := model.Resource{ID: id, UserID: "user", Provider: "local", ObjectKey: key, Kind: kind, MimeType: mime, Status: model.ResourceStatusReady, Size: int64(len(data)), DurationMs: 2345}
			prompt := "已采用版本提示词-" + id
			take := model.DramaTake{ID: id + "-take", ProjectID: "drama-project", OwnerID: shotID, Kind: "shot_" + kind, ResourceID: id, Prompt: prompt, Version: 1, DurationMs: resource.DurationMs}
			for _, value := range []any{&resource, &take} {
				if err := db.Create(value).Error; err != nil {
					t.Fatal(err)
				}
			}
			row, err := s.repo.DramaShotMedia("drama-project", shotID, kind)
			if err != nil {
				row = &model.DramaShotMedia{ID: newID(), ProjectID: "drama-project", EpisodeID: episodeID, ShotID: shotID, Kind: kind, Revision: 1, ConfigJSON: "{}", Status: "idle"}
				if err := db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			if _, err := s.AdoptDramaShotMedia("user", "drama-project", shotID, kind, DramaShotMediaAdoptRequest{ExpectedRevision: &row.Revision, TakeID: take.ID}); err != nil {
				t.Fatal(err)
			}
			selected = append(selected, selectedMedia{episodeID, shotID, kind, prompt, id, data})
			// A later completed history take is not part of the selected asset package.
			if err := db.Create(&model.DramaTake{ID: id + "-unadopted", ProjectID: "drama-project", OwnerID: shotID, Kind: "shot_" + kind, ResourceID: "unadopted-resource", Prompt: "未采用的提示词", Version: 2}).Error; err != nil {
				t.Fatal(err)
			}
		}
	}
	var lastArchive *DramaArchive
	for _, episodeIDs := range [][]string{{"episode"}, {"episode-two"}, {"episode-two", "episode"}} {
		archive, err := s.PrepareDramaAssetPackage("user", "drama-project", DramaAssetPackageRequest{EpisodeIDs: episodeIDs, Media: true, Prompts: true})
		if err != nil {
			t.Fatal(err)
		}
		lastArchive = archive
		var output bytes.Buffer
		if err := s.WriteDramaArchive(context.Background(), "user", archive, &output); err != nil {
			t.Fatal(err)
		}
		reader, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
		if err != nil {
			t.Fatal(err)
		}
		files := map[string][]byte{}
		var manifest dramaAssetManifest
		mediaFiles := 0
		for _, file := range reader.File {
			body, err := file.Open()
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(body)
			if closeErr := body.Close(); err != nil || closeErr != nil {
				t.Fatalf("read ZIP: %v %v", err, closeErr)
			}
			files[file.Name] = data
			if strings.Contains(file.Name, "/镜头图片/") || strings.Contains(file.Name, "/镜头视频/") {
				mediaFiles++
			}
			if strings.HasSuffix(file.Name, "/"+dramaAssetManifestFile) {
				if err := json.Unmarshal(data, &manifest); err != nil {
					t.Fatal(err)
				}
			}
		}
		if len(manifest.Episodes) != len(episodeIDs) || mediaFiles != 2*len(episodeIDs) {
			t.Fatalf("wrong episode/media scope: %+v, files=%d", manifest.Episodes, mediaFiles)
		}
		for _, episode := range manifest.Episodes {
			episodeID, shotID := "episode", "real-shot"
			if episode.Number == 2 {
				episodeID, shotID = "episode-two", "second-shot"
			}
			if !containsString(episodeIDs, episodeID) || len(episode.Shots) != 1 {
				t.Fatalf("unselected episode: %+v", episode)
			}
			shot := episode.Shots[0]
			for _, want := range selected {
				if want.shot != shotID {
					continue
				}
				path, prompt := shot.Image, shot.ImageTakePrompt
				if want.kind == "video" {
					path, prompt = shot.Video, shot.VideoTakePrompt
				}
				if path == "" || !bytes.Equal(files[path], want.data) || prompt != want.prompt {
					t.Fatalf("wrong adopted %s bytes or prompt: %+v", want.kind, shot)
				}
			}
			if episode.Number == 2 && (shot.ImagePrompt != "当前剧本画面" || shot.VideoPrompt != "当前剧本运动") {
				t.Fatalf("adopted prompts replaced script prompts: %+v", shot)
			}
		}
	}
	var foreign bytes.Buffer
	if err := s.WriteDramaArchive(context.Background(), "other", lastArchive, &foreign); err == nil {
		t.Fatal("foreign user downloaded selected visual resources")
	}
	if _, err := zip.NewReader(bytes.NewReader(foreign.Bytes()), int64(foreign.Len())); err == nil {
		t.Fatal("failed ownership check finalized a valid ZIP")
	}
	if err := db.Model(&model.Resource{}).Where("id = ?", selected[0].resourceID).Update("user_id", "other").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.PrepareDramaAssetPackage("user", "drama-project", DramaAssetPackageRequest{EpisodeIDs: []string{"episode"}, Media: true}); err == nil {
		t.Fatal("foreign adopted image was silently skipped or exported")
	}
}

func TestDramaShotVisualAssetPackageRejectsBrokenSelection(t *testing.T) {
	for _, issue := range []string{"missing-take", "wrong-owner", "different-resource", "wrong-mime", "resource-not-ready"} {
		t.Run(issue, func(t *testing.T) {
			s, db, view := shotMediaFixture(t)
			resource := model.Resource{ID: "selected-video", UserID: "user", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4"}
			take := model.DramaTake{ID: "selected-take", ProjectID: "drama-project", OwnerID: "real-shot", Kind: "shot_video", ResourceID: resource.ID}
			if issue == "wrong-owner" {
				take.OwnerID = "other-shot"
			}
			if issue == "different-resource" {
				take.ResourceID = "different-video"
			}
			if issue == "wrong-mime" {
				resource.MimeType = "image/png"
			}
			if issue == "resource-not-ready" {
				resource.Status = "failed"
			}
			if err := db.Create(&resource).Error; err != nil {
				t.Fatal(err)
			}
			if issue != "missing-take" {
				if err := db.Create(&take).Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := db.Model(&model.DramaShotMedia{}).Where("id = ?", view.ID).Updates(map[string]any{"resource_id": resource.ID, "current_take_id": take.ID, "status": "ready"}).Error; err != nil {
				t.Fatal(err)
			}
			if _, err := s.PrepareDramaAssetPackage("user", "drama-project", DramaAssetPackageRequest{EpisodeIDs: []string{"episode"}, Media: true}); err == nil {
				t.Fatal("broken adopted selection silently exported")
			}
		})
	}
}
