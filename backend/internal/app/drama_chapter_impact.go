package app

import (
	"yingce/backend/internal/model"
)

// DramaChapterImpactEpisode is one episode that cites the source chapter.
type DramaChapterImpactEpisode struct {
	ID     string `json:"id"`
	Number int    `json:"number"`
	Title  string `json:"title"`
	Stage  string `json:"stage"`
}

// DramaChapterImpact lists episodes that cite a source chapter. Saving the chapter does not rewrite them.
type DramaChapterImpact struct {
	ChapterID string                      `json:"chapterId"`
	Revision  int64                       `json:"revision"`
	Episodes  []DramaChapterImpactEpisode `json:"episodes"`
	Message   string                      `json:"message"`
}

// DramaChapterImpact returns episodes whose chapter list cites this source chapter.
func (s *Service) DramaChapterImpact(userID, projectID, chapterID string) (DramaChapterImpact, error) {
	project, p, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return DramaChapterImpact{}, err
	}
	unit, err := s.repo.ProjectUnit(project.ID, chapterID)
	if err != nil {
		return DramaChapterImpact{}, err
	}
	if unit.Kind != model.ProjectUnitKindChapter {
		return DramaChapterImpact{}, BadAuthRequest("只能查看原文章节的影响范围")
	}
	episodes, err := s.repo.DramaEpisodes(project.ID)
	if err != nil {
		return DramaChapterImpact{}, err
	}
	result := DramaChapterImpact{
		ChapterID: unit.ID,
		Revision:  p.Revision,
		Episodes:  make([]DramaChapterImpactEpisode, 0),
		Message:   "只保存正文不会自动重写已有分镜，请另行确认重新改编受影响剧集",
	}
	for _, episode := range episodes {
		cited := false
		for _, id := range decodeStringList(episode.ChapterIDsJSON) {
			if id == unit.ID {
				cited = true
				break
			}
		}
		if !cited {
			continue
		}
		result.Episodes = append(result.Episodes, DramaChapterImpactEpisode{
			ID: episode.ID, Number: episode.Number, Title: episode.Title, Stage: episode.Stage,
		})
	}
	return result, nil
}
