package app

import (
	"slices"
	"strings"
)

// The display resolution can describe a tier encoded by a pixel size, a legacy
// quality setting, or an independent imageResolution parameter.
type dramaStoryboardImageChoice struct {
	aspectRatio     string
	resolution      string
	size            string
	imageResolution string
	quality         string
}

func dramaStoryboardImageSpecifications(choices []dramaStoryboardImageChoice) []DramaImageSpecification {
	var specifications []DramaImageSpecification
	indices := map[string]int{}
	for _, choice := range choices {
		index, exists := indices[choice.aspectRatio]
		if !exists {
			index = len(specifications)
			indices[choice.aspectRatio] = index
			specifications = append(specifications, DramaImageSpecification{AspectRatio: choice.aspectRatio})
		}
		if !slices.Contains(specifications[index].Resolutions, choice.resolution) {
			specifications[index].Resolutions = append(specifications[index].Resolutions, choice.resolution)
		}
	}
	return specifications
}

func (s *Service) storyboardImageCatalogChoices(access *userGroupAccess, model DramaModelChoice, spec CapabilitySpec, defaults map[string]any) []dramaStoryboardImageChoice {
	choices := dramaStoryboardImageChoices(spec, defaults)
	if model.LogicalModelID == "" {
		return choices
	}
	snapshot, err := s.routeCatalogSnapshot()
	if err != nil {
		return nil
	}
	cached, exists := snapshot.Models[model.LogicalModelID]
	if !exists {
		return nil
	}
	return slices.DeleteFunc(choices, func(choice dramaStoryboardImageChoice) bool {
		options := choice.providerOptions(cached.ProductSpec)
		intent := ModelRequestIntent{Capability: "image", Operation: "text_to_image", Options: options}
		if _, _, err := s.logicalModelRoutesForIntent(access, cached, intent); err == nil {
			return false
		}
		// The same picker supports selecting a model before attaching a reference.
		intent.Operation = "image_to_image"
		intent.Inputs = map[string]int{"image": 1}
		_, _, err := s.logicalModelRoutesForIntent(access, cached, intent)
		return err != nil
	})
}

func (c dramaStoryboardImageChoice) providerOptions(spec CapabilitySpec) map[string]any {
	options := make(map[string]any, 4)
	if c.size != "" {
		options["size"] = c.size
	}
	if c.imageResolution != "" {
		options["imageResolution"] = c.imageResolution
	}
	if c.quality != "" {
		options["quality"] = c.quality
	}
	if _, supportsCount := spec.Options["count"]; supportsCount {
		options["count"] = "1"
	}
	return options
}

func dramaStoryboardImageChoices(spec CapabilitySpec, defaults map[string]any) []dramaStoryboardImageChoice {
	sizeOptions, sizeDeclared := spec.Options["size"]
	resolutionOptions, resolutionDeclared := spec.Options["imageResolution"]
	qualityOptions := spec.Options["quality"]
	var choices []dramaStoryboardImageChoice
	if sizeDeclared && spec.ImageSize != nil && len(spec.ImageSize.Presets) > 0 {
		for _, preset := range spec.ImageSize.Presets {
			choice := dramaStoryboardImageChoice{aspectRatio: preset.Ratio, resolution: preset.Tier, size: preset.Ratio}
			if spec.ImageSize.Parameter == "size" {
				choice.size = preset.Size
			}
			if !matchOptionConstraint("size", sizeOptions, choice.size) {
				continue
			}
			switch {
			case resolutionDeclared:
				if !matchOptionConstraint("imageResolution", resolutionOptions, preset.Tier) {
					continue
				}
				choice.imageResolution = dramaDeclaredOptionValue(resolutionOptions, preset.Tier)
				choice.resolution = choice.imageResolution
			case spec.ImageSize.Parameter == "size":
				choice.resolution = firstNonEmpty(preset.Tier, preset.Size)
			case preset.Tier != "" && matchOptionConstraint("quality", qualityOptions, preset.Tier):
				choice.quality = dramaDeclaredOptionValue(qualityOptions, preset.Tier)
			default:
				choice.resolution = ""
			}
			choices = append(choices, choice)
		}
	} else {
		if spec.ImageSize != nil && isWildcardOptionConstraint(sizeOptions) {
			sizeOptions.Values = append([]any(nil), sizeOptions.Values...)
			for _, value := range spec.ImageSize.declaredValues {
				if !slices.Contains(sizeOptions.Values, any(value)) {
					sizeOptions.Values = append(sizeOptions.Values, value)
				}
			}
		}
		choices = dramaStoryboardDeclaredImageChoices(sizeOptions, resolutionOptions)
	}
	// Keep the declared default on the first row if the project ratio is unavailable.
	if defaultSize := stringValue(defaults["size"]); defaultSize != "" {
		if index := slices.IndexFunc(choices, func(choice dramaStoryboardImageChoice) bool { return choice.size == defaultSize }); index > 0 {
			choice := choices[index]
			copy(choices[1:index+1], choices[:index])
			choices[0] = choice
		}
	}
	return choices
}

func dramaStoryboardDeclaredImageChoices(sizes, resolutions OptionConstraint) []dramaStoryboardImageChoice {
	var tiers []string
	for _, value := range resolutions.Values {
		if tier := stringValue(value); tier != "" && tier != "*" && !strings.EqualFold(tier, "auto") && !strings.EqualFold(tier, "any") {
			tiers = append(tiers, tier)
		}
	}
	var choices []dramaStoryboardImageChoice
	for _, value := range sizes.Values {
		size := stringValue(value)
		if ratio := normalizeImageAspectRatio(size); ratio != "" {
			choices = append(choices, dramaStoryboardImageChoice{aspectRatio: ratio, size: size})
		}
	}
	if len(choices) == 0 {
		choices = []dramaStoryboardImageChoice{{}}
	}
	if len(tiers) == 0 {
		for i := range choices {
			if strings.Contains(choices[i].size, "x") {
				choices[i].resolution = choices[i].size
			}
		}
		return choices
	}
	var combinations []dramaStoryboardImageChoice
	for _, choice := range choices {
		for _, tier := range tiers {
			choice.resolution, choice.imageResolution = tier, tier
			combinations = append(combinations, choice)
		}
	}
	return combinations
}
