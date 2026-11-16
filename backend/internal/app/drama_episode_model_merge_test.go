package app

import "testing"

func TestDramaInitialSettingsMergeKeepsModelChoicesAtomic(t *testing.T) {
	channelDefault := DramaModelChoice{ChannelID: "channel-a", ModelKey: "original", Label: "Original", PriceLabel: "1"}
	channelNext := DramaModelChoice{ChannelID: "channel-b", ModelKey: "new-default", Label: "New default", PriceLabel: "2"}
	logicalDefault := DramaModelChoice{LogicalModelID: "logical-default", Label: "Logical default", PriceLabel: "3"}
	logicalNext := DramaModelChoice{LogicalModelID: "logical-next", Label: "Logical next", PriceLabel: "4"}
	for _, tt := range []struct {
		name                    string
		previous, current, next DramaModelChoice
		want                    DramaModelChoice
	}{
		{
			name:     "local model in same channel",
			previous: channelDefault,
			current:  DramaModelChoice{ChannelID: "channel-a", ModelKey: "episode-model", Label: "Episode", PriceLabel: "5"},
			next:     channelNext,
			want:     DramaModelChoice{ChannelID: "channel-a", ModelKey: "episode-model", Label: "Episode", PriceLabel: "5"},
		},
		{
			name:     "local logical model when default switches to channel",
			previous: logicalDefault,
			current:  DramaModelChoice{LogicalModelID: "logical-episode", Label: "Episode", PriceLabel: "5"},
			next:     channelNext,
			want:     DramaModelChoice{LogicalModelID: "logical-episode", Label: "Episode", PriceLabel: "5"},
		},
		{
			name:     "local channel model when default switches to logical",
			previous: channelDefault,
			current:  DramaModelChoice{ChannelID: "channel-a", ModelKey: "episode-model", Label: "Episode", PriceLabel: "5"},
			next:     logicalNext,
			want:     DramaModelChoice{ChannelID: "channel-a", ModelKey: "episode-model", Label: "Episode", PriceLabel: "5"},
		},
		{
			name:     "unchanged channel choice follows logical default",
			previous: channelDefault, current: channelDefault, next: logicalNext, want: logicalNext,
		},
		{
			name:     "unchanged logical choice follows channel default",
			previous: logicalDefault, current: logicalDefault, next: channelNext, want: channelNext,
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			previous := DramaSettings{Models: DramaModels{Image: tt.previous}}
			previous.Storyboard.TargetShotCount = 8
			previous.Storyboard.Pacing = "balanced"
			current := previous
			current.Models.Image = tt.current
			current.Storyboard.TargetShotCount = 12
			next := previous
			next.Models.Image = tt.next
			next.Storyboard.TargetShotCount = 16
			next.Storyboard.Pacing = "fast"

			got := mergeDramaInitialSettings(current, previous, next)
			if got.Models.Image != tt.want {
				t.Fatalf("model choice was mixed: got %+v, want %+v", got.Models.Image, tt.want)
			}
			if got.Storyboard.TargetShotCount != 12 || got.Storyboard.Pacing != "fast" {
				t.Fatalf("ordinary nested settings must still merge per field: %+v", got.Storyboard)
			}
		})
	}
}
