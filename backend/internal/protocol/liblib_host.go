package protocol

// Only this shipped provider may delegate to the Liblib host engine. Uploaded
// plugins are separately forbidden from requesting host execution by the installer.
func IsLiblibHostManifest(manifest Manifest) bool {
	return manifest.Metadata.ID == LiblibImageProtocolID && manifest.Runtime.Backend == "host:"+LiblibImageProtocolID &&
		len(manifest.Contributes.Providers) == 1 && manifest.Contributes.Providers[0].ID == LiblibImageProtocolID && manifest.Contributes.Providers[0].SupportsControlNet
}

func UsesProtocolTaskHost(info Metadata) bool {
	return info.Execution == "declarative" || (info.ID == LiblibImageProtocolID && info.Execution == "host:"+LiblibImageProtocolID && info.SupportsControlNet)
}
