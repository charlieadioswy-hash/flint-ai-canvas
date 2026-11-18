package app

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"
)

type dramaSegmentReferenceLabels map[string][]dramaSegmentPromptLabel

type dramaSegmentPromptLabel struct {
	Identity string `json:"identity"`
	Label    string `json:"label"`
	Name     string `json:"name"`
}

var (
	dramaSegmentNumberedReference = regexp.MustCompile(`@?参考图[ \t]*([0-9]+)`)
	dramaSegmentCastToken         = regexp.MustCompile(`@\[(?:segment-cast):([^\]\r\n]+)\]`)
	dramaSegmentWrappedCastToken  = regexp.MustCompile(`（@\[(?:segment-cast):[^\]\r\n]+\]）|\(@\[(?:segment-cast):[^\]\r\n]+\]\)|@\[(?:segment-cast):[^\]\r\n]+\]`)
)

func dramaSegmentReferenceIdentity(ref DramaSegmentReference) string {
	if ref.CastID != "" {
		return "cast:" + ref.CastID
	}
	return "resource:" + ref.ResourceID
}

func dramaSegmentPromptLabels(refs []DramaSegmentReference) []dramaSegmentPromptLabel {
	labels := make([]dramaSegmentPromptLabel, 0, len(refs))
	for _, ref := range refs {
		labels = append(labels, dramaSegmentPromptLabel{Identity: dramaSegmentReferenceIdentity(ref), Label: ref.Label, Name: ref.Name})
	}
	return labels
}

func dramaSegmentOverrideLabelKey(prompt string) string {
	return "override:" + dramaShotMediaDigest(prompt)
}

func dramaSegmentAuthoredLabels(segment model.DramaSegment, prompt string, fallback []dramaSegmentPromptLabel, override bool) []dramaSegmentPromptLabel {
	var snapshot dramaSegmentReferenceLabels
	if json.Unmarshal([]byte(segment.ReferenceLabelsJSON), &snapshot) == nil {
		if override {
			if authored, exists := snapshot[dramaSegmentOverrideLabelKey(prompt)]; exists {
				return authored
			}
		}
		if authored, exists := snapshot[dramaShotMediaDigest(prompt)]; exists {
			return authored
		}
	}
	return fallback
}

func dramaSegmentStoredLabels(segment model.DramaSegment, refs []dramaSegmentPromptLabel) dramaSegmentReferenceLabels {
	result := dramaSegmentReferenceLabels{}
	if prompt := strings.TrimSpace(segment.VideoPrompt); dramaSegmentPromptHasReferences(prompt) {
		result[dramaShotMediaDigest(prompt)] = dramaSegmentAuthoredLabels(segment, prompt, refs, false)
	}
	if prompt := strings.TrimSpace(segment.VideoPromptOverride); dramaSegmentPromptHasReferences(prompt) {
		result[dramaSegmentOverrideLabelKey(prompt)] = dramaSegmentAuthoredLabels(segment, prompt, refs, true)
	}
	return result
}

func dramaSegmentPromptHasReferences(prompt string) bool {
	return dramaSegmentNumberedReference.MatchString(prompt) || dramaSegmentCastToken.MatchString(prompt)
}

// The editor saves against current attachment numbering, even when the new
// text matches a previous model or manual draft byte for byte.
func dramaSegmentOverrideLabels(tx *repository.Repository, projectID, episodeID string, index int, prompt string) (string, error) {
	rows, err := tx.DramaSegments(episodeID)
	if err != nil {
		return "", err
	}
	var stored model.DramaSegment
	for _, row := range rows {
		if row.SegmentIndex == index {
			stored = row
			break
		}
	}
	shots, err := tx.DramaShots(episodeID)
	if err != nil {
		return "", err
	}
	casts, err := tx.DramaCasts(projectID)
	if err != nil {
		return "", err
	}
	byID := make(map[string]model.DramaCast, len(casts))
	for _, cast := range casts {
		byID[cast.ID] = cast
	}
	for _, draft := range buildDramaSegmentDrafts(DramaSettings{}, dramaBibleMeta{}, shots, byID, rows) {
		if draft.view.Index != index {
			continue
		}
		refs := dramaSegmentPromptLabels(draft.view.Request.References)
		stored.VideoPromptOverride = ""
		snapshot := dramaSegmentStoredLabels(stored, refs)
		if dramaSegmentPromptHasReferences(prompt) {
			snapshot[dramaSegmentOverrideLabelKey(prompt)] = refs
		}
		if len(snapshot) == 0 {
			return "", nil
		}
		encoded, err := json.Marshal(snapshot)
		return string(encoded), err
	}
	return "", nil
}

func captureDramaSegmentReferenceEdit(tx *repository.Repository, projectID, episodeID string, index int, fields map[string]any) (bool, error) {
	castIDs, hasCastIDs := fields["reference_cast_ids_json"]
	imageIDs, hasImages := fields["reference_images_json"]
	if !hasCastIDs && !hasImages {
		return false, nil
	}
	rows, err := tx.DramaSegments(episodeID)
	if err != nil {
		return false, err
	}
	for _, row := range rows {
		if row.SegmentIndex != index {
			continue
		}
		if !(hasCastIDs && castIDs != row.ReferenceCastIDsJSON || hasImages && imageIDs != row.ReferenceImagesJSON) {
			return false, nil
		}
		shots, err := tx.DramaShots(episodeID)
		if err != nil {
			return false, err
		}
		casts, err := tx.DramaCasts(projectID)
		if err != nil {
			return false, err
		}
		byID := make(map[string]model.DramaCast, len(casts))
		for _, cast := range casts {
			byID[cast.ID] = cast
		}
		for _, draft := range buildDramaSegmentDrafts(DramaSettings{}, dramaBibleMeta{}, shots, byID, rows) {
			if draft.view.Index != index {
				continue
			}
			refs := dramaSegmentPromptLabels(draft.view.Request.References)
			snapshot := dramaSegmentStoredLabels(row, refs)
			if len(snapshot) > 0 {
				encoded, err := json.Marshal(snapshot)
				if err != nil {
					return false, err
				}
				fields["reference_labels_json"] = string(encoded)
			}
			audio, hasAudio := fields["audio_cast_ids_json"]
			prompt := strings.TrimSpace(row.VideoPrompt)
			known := dramaSegmentAuthoredLabels(row, prompt, refs, false)
			return row.PromptStatus == model.DramaMediaReady && prompt != "" && (!hasAudio || audio == row.AudioCastIDsJSON) && len(production.UnknownReferenceTokens(prompt, len(known))) == 0, nil
		}
	}
	return false, nil
}

func dramaSegmentPromptLabelKey(raw string) string {
	number, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(raw, "@"), "参考图")))
	if err != nil || number < 1 {
		return raw
	}
	return "参考图" + strconv.Itoa(number)
}

func replaceDramaSegmentPromptMatches(text string, pattern *regexp.Regexp, replace func(before, match, after string) string) string {
	matches := pattern.FindAllStringIndex(text, -1)
	if len(matches) == 0 {
		return text
	}
	var result strings.Builder
	start := 0
	for _, match := range matches {
		result.WriteString(text[start:match[0]])
		result.WriteString(replace(text[:match[0]], text[match[0]:match[1]], text[match[1]:]))
		start = match[1]
	}
	result.WriteString(text[start:])
	return result.String()
}

func dramaSegmentNameBesideReference(before, after, name string) bool {
	if name == "" {
		return false
	}
	before = strings.TrimRight(strings.TrimSpace(before), "（( ")
	after = strings.TrimLeft(strings.TrimSpace(after), "）) ")
	return strings.HasSuffix(before, name) || strings.HasPrefix(after, name)
}

// The editor keeps prose readable and binds subject references to identities.
// Unbound uploads retain their existing numbered notation.
func dramaSegmentEditorPrompt(raw string, authored []dramaSegmentPromptLabel) string {
	byLabel := make(map[string]dramaSegmentPromptLabel, len(authored))
	for _, ref := range authored {
		byLabel[dramaSegmentPromptLabelKey(ref.Label)] = ref
	}
	return replaceDramaSegmentPromptMatches(raw, dramaSegmentNumberedReference, func(before, match, after string) string {
		ref := byLabel[dramaSegmentPromptLabelKey(match)]
		castID := strings.TrimPrefix(ref.Identity, "cast:")
		if castID == ref.Identity || castID == "" {
			return dramaSegmentPromptLabelKey(match)
		}
		token := "@[segment-cast:" + castID + "]"
		if dramaSegmentNameBesideReference(before, after, ref.Name) {
			return token
		}
		return ref.Name + token
	})
}

func dramaSegmentEditorViewPrompt(segment model.DramaSegment, raw string, current []DramaSegmentReference, override bool) string {
	authored := dramaSegmentAuthoredLabels(segment, raw, dramaSegmentPromptLabels(current), override)
	labels := map[string]string{}
	for _, ref := range current {
		labels[dramaSegmentReferenceIdentity(ref)] = ref.Label
	}
	return dramaSegmentRemapUploadReferences(dramaSegmentEditorPrompt(raw, authored), authored, labels)
}

func dramaSegmentRemapUploadReferences(prompt string, authored []dramaSegmentPromptLabel, labels map[string]string) string {
	previous := map[string]dramaSegmentPromptLabel{}
	for _, ref := range authored {
		if strings.HasPrefix(ref.Identity, "resource:") {
			previous[dramaSegmentPromptLabelKey(ref.Label)] = ref
		}
	}
	return production.ReplaceReferenceTokens(prompt, func(label string) string {
		ref, found := previous[label]
		if !found {
			return label
		}
		if replacement := labels[ref.Identity]; replacement != "" {
			return replacement
		}
		if ref.Name != "" {
			return production.ReplaceReferenceTokens(ref.Name, func(string) string { return "参考素材" })
		}
		return "原参考素材"
	})
}

func dramaSegmentPromptSubjects(casts map[string]model.DramaCast, drafts ...string) []DramaSegmentReference {
	var refs []DramaSegmentReference
	seen := map[string]bool{}
	for _, draft := range drafts {
		for _, token := range dramaSegmentCastToken.FindAllStringSubmatch(draft, -1) {
			id := token[1]
			if cast, exists := casts[id]; exists && !seen[id] {
				seen[id] = true
				refs = append(refs, DramaSegmentReference{CastID: id, Kind: cast.Kind, Name: dramaShotSubjectReference(cast, casts).Name, ResourceID: cast.ImageResourceID})
			}
		}
	}
	return refs
}

func dramaSegmentAuthoringReferences(settings DramaSettings, meta dramaBibleMeta, draft dramaSegmentDraft, casts map[string]model.DramaCast) []DramaSegmentReference {
	refs := append([]DramaSegmentReference{}, draft.view.Request.References...)
	if draft.view.ReferenceMode != "custom" {
		return refs
	}
	seen := map[string]bool{}
	for _, ref := range refs {
		seen[ref.CastID] = true
	}
	automatic := buildDramaSegmentDrafts(settings, meta, draft.shots, casts, nil)[0]
	for _, ref := range automatic.view.Request.References {
		if ref.CastID == "" || seen[ref.CastID] {
			continue
		}
		seen[ref.CastID] = true
		ref.Label = "参考图" + strconv.Itoa(len(refs)+1)
		refs = append(refs, ref)
	}
	return refs
}

func dramaSegmentEditorSubjects(casts map[string]model.DramaCast, authoring []DramaSegmentReference, drafts ...string) []DramaSegmentReference {
	refs := dramaSegmentPromptSubjects(casts, drafts...)
	seen := map[string]bool{}
	for _, ref := range refs {
		seen[ref.CastID] = true
	}
	for _, ref := range authoring {
		if cast, exists := casts[ref.CastID]; exists && !seen[ref.CastID] {
			seen[ref.CastID] = true
			refs = append(refs, DramaSegmentReference{CastID: ref.CastID, Kind: ref.Kind, Name: ref.Name, ResourceID: cast.ImageResourceID})
		}
	}
	return refs
}

func removeDeletedDramaSegmentCastTokens(prompt string, casts map[string]model.DramaCast) string {
	return dramaSegmentWrappedCastToken.ReplaceAllStringFunc(prompt, func(match string) string {
		if _, exists := casts[dramaSegmentCastToken.FindStringSubmatch(match)[1]]; exists {
			return match
		}
		return ""
	})
}

// Preserve the numbering that the stored prompt was written against. A later
// deletion must not reinterpret that prompt against already shifted numbers.
func captureDramaCastDeletionLabels(tx *repository.Repository, projectID string, casts []model.DramaCast, removed map[string]bool) (map[string]string, error) {
	labels := map[string]string{}
	castByID := make(map[string]model.DramaCast, len(casts))
	for _, cast := range casts {
		castByID[cast.ID] = cast
	}
	episodes, err := tx.DramaEpisodes(projectID)
	if err != nil {
		return nil, err
	}
	for _, episode := range episodes {
		shots, err := tx.DramaShots(episode.ID)
		if err != nil {
			return nil, err
		}
		if len(shots) == 0 {
			continue
		}
		segments, err := tx.DramaSegments(episode.ID)
		if err != nil {
			return nil, err
		}
		byIndex := make(map[int]model.DramaSegment, len(segments))
		for _, segment := range segments {
			byIndex[segment.SegmentIndex] = segment
		}
		for _, shot := range shots {
			segment, exists := byIndex[shot.SegmentIndex]
			if !exists {
				continue
			}
			for _, id := range append(dramaShotCastIDs(shot), decodeStringList(shot.LookCastIDsJSON)...) {
				if removed[id] {
					labels[segment.ID] = ""
					break
				}
			}
		}
		for _, draft := range buildDramaSegmentDrafts(DramaSettings{}, dramaBibleMeta{}, shots, castByID, segments) {
			segment, exists := byIndex[draft.view.Index]
			if !exists {
				continue
			}
			affected := false
			for _, ref := range draft.view.Request.References {
				affected = affected || removed[ref.CastID]
			}
			if affected {
				labels[segment.ID] = ""
				snapshot := dramaSegmentStoredLabels(segment, dramaSegmentPromptLabels(draft.view.Request.References))
				if len(snapshot) == 0 {
					continue
				}
				encoded, err := json.Marshal(snapshot)
				if err != nil {
					return nil, err
				}
				labels[segment.ID] = string(encoded)
			}
		}
	}
	return labels, nil
}

// Resolve against the destination attachment order. Entries without a label
// supply names for subjects that are mentioned but have no attached image.
func resolveDramaSegmentPromptForReferences(segment model.DramaSegment, authoredFallback, actual []DramaSegmentReference) string {
	prompt := firstNonEmpty(segment.VideoPromptOverride, segment.VideoPrompt)
	authored := dramaSegmentAuthoredLabels(segment, prompt, dramaSegmentPromptLabels(authoredFallback), strings.TrimSpace(segment.VideoPromptOverride) != "")
	prompt = dramaSegmentEditorPrompt(prompt, authored)
	currentLabels := map[string]string{}
	names := map[string]string{}
	for _, ref := range actual {
		key := dramaSegmentReferenceIdentity(ref)
		if currentLabels[key] == "" {
			currentLabels[key] = ref.Label
		}
		names[key] = ref.Name
	}
	for _, ref := range authored {
		if names[ref.Identity] == "" {
			names[ref.Identity] = ref.Name
		}
	}
	prompt = dramaSegmentRemapUploadReferences(prompt, authored, currentLabels)
	return replaceDramaSegmentPromptMatches(prompt, dramaSegmentWrappedCastToken, func(before, match, after string) string {
		id := "cast:" + dramaSegmentCastToken.FindStringSubmatch(match)[1]
		name := names[id]
		label := currentLabels[id]
		wrapped := strings.HasPrefix(match, "（") || strings.HasPrefix(match, "(")
		nearName := dramaSegmentNameBesideReference(before, after, name)
		if label == "" {
			if nearName || name == "" && (strings.TrimSpace(before) != "" || strings.TrimSpace(after) != "") {
				return ""
			}
			return firstNonEmpty(name, "原参考素材")
		}
		if wrapped {
			return strings.Replace(match, dramaSegmentCastToken.FindString(match), label, 1)
		}
		if nearName {
			return "（" + label + "）"
		}
		return label
	})
}

func dramaSegmentRequestPrompt(segment model.DramaSegment, request DramaSegmentRequest) string {
	if request.ResolvedPrompt != nil {
		return *request.ResolvedPrompt
	}
	return firstNonEmpty(segment.VideoPromptOverride, segment.VideoPrompt)
}
