package model

// DramaCharacterDefinition 保留完整人物定义；库来源只作溯源，后续编辑不会回写角色库。
type DramaCharacterDefinition struct {
	DefinitionJSON   string `json:"definitionJson,omitempty" gorm:"type:text"`
	LibraryAssetID   string `json:"libraryAssetId,omitempty" gorm:"size:36"`
	LibraryVersionID string `json:"libraryVersionId,omitempty" gorm:"size:36"`
}
