package model3d

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"strings"
)

func ValidateFile(data []byte, format string) error {
	if format == "fbx" {
		if len(data) < 27 || (!bytes.HasPrefix(data, []byte("Kaydara FBX Binary  \x00\x1a\x00")) && !bytes.HasPrefix(bytes.TrimSpace(data), []byte("; FBX"))) {
			return errors.New("invalid FBX")
		}
		return nil
	}
	if format != "glb" || len(data) < 20 || string(data[:4]) != "glTF" || binary.LittleEndian.Uint32(data[4:8]) != 2 || int(binary.LittleEndian.Uint32(data[8:12])) != len(data) {
		return errors.New("invalid GLB")
	}
	jsonLength := int(binary.LittleEndian.Uint32(data[12:16]))
	if jsonLength <= 0 || jsonLength > len(data)-20 || binary.LittleEndian.Uint32(data[16:20]) != 0x4e4f534a {
		return errors.New("invalid GLB JSON chunk")
	}
	var document struct {
		Asset struct {
			Version string `json:"version"`
		} `json:"asset"`
		Buffers []struct {
			URI string `json:"uri"`
		} `json:"buffers"`
		Images []struct {
			URI string `json:"uri"`
		} `json:"images"`
	}
	if json.Unmarshal(bytes.TrimRight(data[20:20+jsonLength], " \x00"), &document) != nil || document.Asset.Version != "2.0" {
		return errors.New("invalid glTF document")
	}
	for _, buffer := range document.Buffers {
		if buffer.URI != "" && !strings.HasPrefix(buffer.URI, "data:") {
			return errors.New("external GLB buffer")
		}
	}
	for _, image := range document.Images {
		if image.URI != "" && !strings.HasPrefix(image.URI, "data:image/") {
			return errors.New("external GLB image")
		}
	}
	return nil
}

func FileType(format string) (string, string) {
	if format == "fbx" {
		return "model.fbx", "application/octet-stream"
	}
	return "model.glb", "model/gltf-binary"
}

// Part names come from the saved GLB, not arbitrary names entered by the client.
func PartNames(data []byte) []string {
	if ValidateFile(data, "glb") != nil {
		return nil
	}
	length := int(binary.LittleEndian.Uint32(data[12:16]))
	var document struct {
		Nodes []struct {
			Name string `json:"name"`
			Mesh *int   `json:"mesh"`
		} `json:"nodes"`
	}
	if json.Unmarshal(bytes.TrimRight(data[20:20+length], " \x00"), &document) != nil {
		return nil
	}
	named, meshes := []string{}, []string{}
	seen := map[string]bool{}
	for _, node := range document.Nodes {
		if strings.TrimSpace(node.Name) == "" || len(node.Name) > 256 || strings.ContainsAny(node.Name, "\r\n\x00") || seen[node.Name] {
			continue
		}
		seen[node.Name] = true
		if strings.HasPrefix(node.Name, "tripo_part_") {
			named = append(named, node.Name)
		}
		if node.Mesh != nil {
			meshes = append(meshes, node.Name)
		}
	}
	if len(named) > 0 {
		return named
	}
	return meshes
}
