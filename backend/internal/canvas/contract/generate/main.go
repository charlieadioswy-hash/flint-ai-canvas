package main

import (
	"os"
	"path/filepath"

	"yingce/backend/internal/canvas/contract"
	"yingce/backend/internal/protocol"
)

func main() {
	path := filepath.Join("..", "..", "..", "..", "web", "src", "lib", "canvas", "generation-contract.generated.ts")
	if err := os.WriteFile(path, []byte(contract.TypeScriptDeclaration()), 0644); err != nil {
		panic(err)
	}
	catalogPath := filepath.Join("..", "..", "..", "..", "web", "src", "lib", "canvas", "controlnet-catalog.generated.ts")
	if err := os.WriteFile(catalogPath, []byte(protocol.ControlNetCatalogTypeScript()), 0644); err != nil {
		panic(err)
	}
	pluginCatalogPath := filepath.Join("..", "..", "..", "..", "plugin-packages", "liblib-image", "docs", "controlnet-catalog.json")
	if err := os.WriteFile(pluginCatalogPath, protocol.ControlNetCatalogDocument(), 0644); err != nil {
		panic(err)
	}
}
