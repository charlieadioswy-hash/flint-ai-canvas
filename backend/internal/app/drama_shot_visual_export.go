package app

import (
	"errors"
	"fmt"
	"strings"

	"gorm.io/gorm"
	"yingce/backend/internal/jianying"
	"yingce/backend/internal/model"
)

// Keep the adopted take's prompt separate from the current script prompt: an
// edited script may intentionally retain an older selected image or video.
func (s *Service) packDramaShotVisual(userID, folder string, shot model.DramaShot, kind string, req DramaAssetPackageRequest, archive *DramaArchive) (string, string, error) {
	row, err := s.repo.DramaShotMedia(shot.ProjectID, shot.ID, kind)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return "", "", nil
	}
	if err != nil {
		return "", "", err
	}
	if row.CurrentTakeID == "" && row.ResourceID == "" {
		return "", "", nil
	}
	label, extension := "图片", ".png"
	if kind == "video" {
		label, extension = "视频", ".mp4"
	}
	take, err := s.repo.DramaShotMediaTake(shot.ProjectID, shot.ID, kind, row.CurrentTakeID)
	if err != nil || row.ResourceID == "" || take.ResourceID != row.ResourceID {
		return "", "", BadAuthRequest("已采用镜头" + label + "与历史版本不一致，请重新采用")
	}
	prompt, path := "", ""
	if req.Prompts {
		prompt = take.Prompt
	}
	if req.Media {
		resource := s.dramaExportResource(userID, row.ResourceID, kind)
		if resource == nil || resource.Kind != kind || !strings.HasPrefix(resource.MimeType, kind+"/") {
			return "", "", BadAuthRequest("已采用的镜头" + label + "不可读取，请重新选择后导出")
		}
		path = fmt.Sprintf("%s/镜头%s/%03d-%s%s", folder, label, shot.Position+1, jianying.SafeName(shot.Scene, "镜头", 40), dramaResourceExtension(resource, extension))
		if err := archive.addResource(path, resource); err != nil {
			return "", "", err
		}
		archive.entries[len(archive.entries)-1].expectedSize = resource.Size
	}
	return path, prompt, nil
}
