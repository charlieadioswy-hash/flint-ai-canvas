package app

import (
	"errors"
	"fmt"

	"gorm.io/gorm"
	"yingce/backend/internal/jianying"
	"yingce/backend/internal/model"
)

// Standalone audio is exported as separate files; the episode renderer and
// Jianying video timeline continue to use the sound embedded in each video.
func (s *Service) packDramaShotAudio(userID, folder string, shot model.DramaShot, req DramaAssetPackageRequest, archive *DramaArchive) (string, string, error) {
	row, err := s.repo.DramaShotMedia(shot.ProjectID, shot.ID, "audio")
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return "", "", nil
	}
	if err != nil {
		return "", "", err
	}
	if row.CurrentTakeID == "" || row.ResourceID == "" {
		return "", "", nil
	}
	take, err := s.repo.DramaShotMediaTake(shot.ProjectID, shot.ID, "audio", row.CurrentTakeID)
	if err != nil {
		return "", "", err
	}
	if take.ResourceID != row.ResourceID {
		return "", "", BadAuthRequest("已采用镜头音频与历史版本不一致，请重新采用")
	}
	text, path := "", ""
	if req.Prompts {
		text = take.Prompt
	}
	if req.Media {
		resource := s.dramaExportResource(userID, row.ResourceID, "audio")
		if resource == nil {
			return "", "", BadAuthRequest("已采用的镜头音频不可读取，请重新选择后导出")
		}
		path = fmt.Sprintf("%s/镜头音频/%03d-%s%s", folder, shot.Position+1, jianying.SafeName(shot.Speaker, "镜头", 40), dramaResourceExtension(resource, ".mp3"))
		if err := archive.addResource(path, resource); err != nil {
			return "", "", err
		}
	}
	return path, text, nil
}
