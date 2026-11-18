package app

import (
	"slices"
	"strings"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

type dramaEpisodeCompletion struct {
	assetsReady, storyboardReady, videoReady bool
}

type dramaEpisodeExtractionEvidence struct {
	initialSucceeded bool
	kinds            map[string]bool
}

func matchingDramaExtractionChapters(episode model.DramaEpisode, sourceIDs []string) bool {
	current := decodeStringList(episode.ChapterIDsJSON)
	if len(current) == 0 || len(current) != len(sourceIDs) {
		return false
	}
	slices.Sort(current)
	source := slices.Clone(sourceIDs)
	slices.Sort(source)
	return slices.Equal(current, source)
}

func dramaEpisodeExtractionByID(episodes []model.DramaEpisode, chapters []model.ProjectUnit, jobs []model.DramaJob) map[string]dramaEpisodeExtractionEvidence {
	byID := make(map[string]model.DramaEpisode, len(episodes))
	for _, episode := range episodes {
		byID[episode.ID] = episode
	}
	result := make(map[string]dramaEpisodeExtractionEvidence, len(episodes))
	apply := func(episodeID string, chapters []string, kind string) {
		episode, exists := byID[episodeID]
		if !exists || !matchingDramaExtractionChapters(episode, chapters) {
			return
		}
		evidence := result[episodeID]
		if kind == "" {
			evidence.initialSucceeded = true
		} else {
			if evidence.kinds == nil {
				evidence.kinds = map[string]bool{}
			}
			evidence.kinds[kind] = true
		}
		result[episodeID] = evidence
	}
	var legacySourceCutoff time.Time
	for i := range jobs {
		job := &jobs[i]
		if job.Status != model.DramaJobSucceeded {
			continue
		}
		if strings.TrimSpace(job.PayloadJSON) == "" {
			// Legacy jobs extracted the whole production source. Their original creation time stays unchanged on retries.
			if job.CreatedAt.After(legacySourceCutoff) {
				legacySourceCutoff = job.CreatedAt
			}
			continue
		}
		if initial, err := dramaInitialAssets(job); err == nil && initial != nil {
			if len(initial.SourceEpisodeIDs) == 1 {
				apply(initial.SourceEpisodeIDs[0], initial.SourceChapterIDs, "")
			} else {
				// A plan-based project can extract its initial source before an episode exists.
				for _, episode := range episodes {
					apply(episode.ID, initial.SourceChapterIDs, "")
				}
			}
			continue
		}
		if scoped, err := dramaAssetExtraction(job); err == nil && scoped != nil && len(scoped.SourceEpisodeIDs) == 1 {
			apply(scoped.SourceEpisodeIDs[0], scoped.SourceChapterIDs, scoped.AssetKind)
		}
	}
	if !legacySourceCutoff.IsZero() {
		covered := make(map[string]model.ProjectUnit, len(chapters))
		for _, chapter := range chapters {
			if !chapter.CreatedAt.IsZero() && !chapter.CreatedAt.After(legacySourceCutoff) && chapter.Status != model.ProjectUnitStatusReserved && chapter.Status != model.ProjectUnitStatusRemoved {
				covered[chapter.ID] = chapter
			}
		}
		for _, episode := range episodes {
			ids := decodeStringList(episode.ChapterIDsJSON)
			if len(ids) == 0 || slices.ContainsFunc(ids, func(id string) bool {
				chapter, ok := covered[id]
				// For a later/planned episode, a later chapter update might be activation of formerly reserved source.
				return !ok || episode.CreatedAt.After(legacySourceCutoff) && chapter.UpdatedAt.After(legacySourceCutoff)
			}) {
				continue
			}
			evidence := result[episode.ID]
			evidence.initialSucceeded = true
			result[episode.ID] = evidence
		}
	}
	return result
}

func dramaEpisodeStageIncludesStoryboard(stage string) bool {
	switch stage {
	case model.DramaEpisodeDraft, model.DramaEpisodeQueued, model.DramaEpisodeScript:
		return false
	default:
		return true
	}
}

func (s *Service) dramaEpisodeCompletions(projectID, userID string, episodes []model.DramaEpisode, chapters []model.ProjectUnit, segmentStats map[string]repository.DramaSegmentStat) (map[string]dramaEpisodeCompletion, error) {
	result := make(map[string]dramaEpisodeCompletion, len(episodes))
	if len(episodes) == 0 {
		return result, nil
	}
	jobs, err := s.repo.DramaProjectAssetExtractionEvidence(projectID)
	if err != nil {
		return nil, err
	}
	assets := dramaEpisodeExtractionByID(episodes, chapters, jobs)
	scriptHistory, err := s.repo.DramaProjectSuccessfulScriptEpisodes(projectID)
	if err != nil {
		return nil, err
	}
	finals, err := s.repo.DramaProjectAvailableFinalVideos(projectID, userID)
	if err != nil {
		return nil, err
	}
	coverage, err := s.repo.DramaProjectShotCoverage(projectID)
	if err != nil {
		return nil, err
	}
	storyboards := make(map[string]repository.DramaEpisodeShotCoverage, len(coverage))
	for _, row := range coverage {
		storyboards[row.EpisodeID] = row
	}
	segmentVideos, err := s.repo.DramaProjectRenderableSegmentCounts(projectID, userID)
	if err != nil {
		return nil, err
	}
	adoptedShots, err := s.repo.DramaProjectAdoptedShots(projectID, userID)
	if err != nil {
		return nil, err
	}
	readyShotVideos := map[string]int{}
	for _, row := range adoptedShots {
		ready := readyShotVideos[row.EpisodeID]
		if row.AdoptedVideoScriptHash != "" && row.AdoptedVideoScriptHash == dramaShotScriptHash(row.DramaShot) {
			ready++
		}
		readyShotVideos[row.EpisodeID] = ready
	}
	for _, episode := range episodes {
		coverage, totalSegments := storyboards[episode.ID], segmentStats[episode.ID].Total
		storyboardReady := dramaEpisodeStageIncludesStoryboard(episode.Stage) && episode.ShotCount > 0 && coverage.ShotCount == episode.ShotCount && totalSegments > 0 && coverage.CoveredSegments == totalSegments && coverage.UnassignedShots == 0
		assetWork := assets[episode.ID]
		finalAvailable := episode.FinalResourceID != "" && finals[episode.ID] == episode.FinalResourceID
		// Historical results still prove the episode reached production when recompiling clears the current storyboard.
		assetsReady := storyboardReady || scriptHistory[episode.ID] || finalAvailable || assetWork.initialSucceeded || len(assetWork.kinds) == 3
		readyVideos, shotSource := readyShotVideos[episode.ID]
		videosComplete := !shotSource && totalSegments > 0 && segmentVideos[episode.ID] == totalSegments || shotSource && readyVideos == episode.ShotCount
		videoReady := finalAvailable && !episode.FinalStale || storyboardReady && videosComplete
		result[episode.ID] = dramaEpisodeCompletion{assetsReady: assetsReady, storyboardReady: storyboardReady, videoReady: videoReady}
	}
	return result, nil
}
