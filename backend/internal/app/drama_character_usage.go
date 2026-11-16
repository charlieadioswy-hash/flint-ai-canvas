package app

import "slices"

type DramaCharacterAppearance struct {
	EpisodeID     string `json:"episodeId"`
	EpisodeNumber int    `json:"episodeNumber"`
	EpisodeTitle  string `json:"episodeTitle"`
	ShotID        string `json:"shotId"`
	Position      int    `json:"position"`
	SegmentIndex  int    `json:"segmentIndex"`
}

type DramaCharacterSegmentReference struct {
	EpisodeID     string `json:"episodeId"`
	EpisodeNumber int    `json:"episodeNumber"`
	SegmentID     string `json:"segmentId"`
	SegmentIndex  int    `json:"segmentIndex"`
}

type DramaCharacterUsage struct {
	HasStory        bool                             `json:"hasStory"`
	Appearances     []DramaCharacterAppearance       `json:"appearances"`
	AudioReferences []DramaCharacterSegmentReference `json:"audioReferences"`
	ImageReferences []DramaCharacterSegmentReference `json:"imageReferences"`
}

// 出镜只依据镜头中相应类型的资产 ID；段参考图及音频引用独立列出，不按正文提及推断出镜。
func (s *Service) DramaCharacterUsage(userID, projectID, castID string) (DramaCharacterUsage, error) {
	result := DramaCharacterUsage{Appearances: []DramaCharacterAppearance{}, AudioReferences: []DramaCharacterSegmentReference{}, ImageReferences: []DramaCharacterSegmentReference{}}
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return result, err
	}
	cast, err := s.repo.DramaCast(projectID, castID)
	if err != nil {
		return result, dramaLookupError(err)
	}
	if cast.ParentID != "" || !validDramaCastKind(cast.Kind) {
		return result, BadAuthRequest("此操作只支持基础角色、场景或道具，请从所属基础资产进入")
	}
	casts, err := s.repo.DramaCasts(projectID)
	if err != nil {
		return result, err
	}
	ids := []string{cast.ID}
	for _, row := range casts {
		if cast.Kind == "character" && row.ParentID == cast.ID && row.Kind == "character" {
			ids = append(ids, row.ID)
		}
	}
	contains := func(raw string) bool {
		for _, id := range decodeStringList(raw) {
			if slices.Contains(ids, id) {
				return true
			}
		}
		return false
	}
	shots, err := s.repo.DramaCharacterUsageShots(projectID)
	if err != nil {
		return result, err
	}
	result.HasStory = len(shots) > 0
	episodes, err := s.repo.DramaEpisodes(projectID)
	if err != nil {
		return result, err
	}
	for _, episode := range episodes {
		for _, shot := range shots {
			visible := false
			switch cast.Kind {
			case "character":
				visible = contains(shot.CastIDsJSON) || contains(shot.LookCastIDsJSON)
			case "scene":
				visible = shot.SceneCastID == cast.ID
			case "prop":
				visible = contains(shot.PropIDsJSON)
			}
			if shot.EpisodeID == episode.ID && visible {
				result.Appearances = append(result.Appearances, DramaCharacterAppearance{EpisodeID: episode.ID, EpisodeNumber: episode.Number, EpisodeTitle: episode.Title, ShotID: shot.ID, Position: shot.Position, SegmentIndex: shot.SegmentIndex})
			}
		}
		segments, err := s.repo.DramaSegments(episode.ID)
		if err != nil {
			return result, err
		}
		for _, segment := range segments {
			reference := DramaCharacterSegmentReference{EpisodeID: episode.ID, EpisodeNumber: episode.Number, SegmentID: segment.ID, SegmentIndex: segment.SegmentIndex}
			if contains(segment.AudioCastIDsJSON) {
				result.AudioReferences = append(result.AudioReferences, reference)
			}
			if contains(segment.ReferenceCastIDsJSON) {
				result.ImageReferences = append(result.ImageReferences, reference)
			}
		}
	}
	return result, nil
}
