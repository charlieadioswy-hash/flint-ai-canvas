package generation

// LoRACapability is the administrator-maintained compatibility catalogue. Task
// provider options select IDs and weights, never supply compatibility metadata.
type LoRACapability struct {
	Supported   bool              `json:"supported"`
	MaxNetworks int               `json:"maxNetworks"`
	BaseModel   string            `json:"baseModel"`
	Models      []LoRAModelConfig `json:"models"`
}

type LoRAModelConfig struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	BaseModel     string   `json:"baseModel"`
	TriggerWords  []string `json:"triggerWords,omitempty"`
	SourceURL     string   `json:"sourceUrl,omitempty"`
	DefaultWeight *float64 `json:"defaultWeight,omitempty"`
}
