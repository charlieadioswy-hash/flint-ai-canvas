export type Model3DPreviewFormat = "glb" | "gltf" | "fbx" | "obj" | "stl";
export type Model3DExportFormat = Exclude<Model3DPreviewFormat, "fbx">;

export type Model3DFormatSource = { format?: string; fileName?: string; mimeType?: string; url?: string };

const MODEL_FORMATS = new Set<Model3DPreviewFormat>(["glb", "gltf", "fbx", "obj", "stl"]);
const MIME_FORMATS: Record<string, Model3DPreviewFormat> = {
    "model/gltf-binary": "glb",
    "model/gltf+json": "gltf",
    "model/obj": "obj",
    "model/stl": "stl",
    "application/sla": "stl",
    "application/vnd.ms-pki.stl": "stl",
    "application/vnd.autodesk.fbx": "fbx",
};

export function model3DFormat(source: Model3DFormatSource): Model3DPreviewFormat | null {
    const declared = source.format?.toLowerCase() as Model3DPreviewFormat | undefined;
    if (declared && MODEL_FORMATS.has(declared)) return declared;
    const extension = source.fileName?.match(/\.(glb|gltf|fbx|obj|stl)$/i)?.[1]?.toLowerCase();
    if (extension) return extension as Model3DPreviewFormat;
    const mimeFormat = MIME_FORMATS[source.mimeType?.split(";")[0].trim().toLowerCase() || ""];
    if (mimeFormat) return mimeFormat;
    const urlExtension = source.url
        ?.split(/[?#]/, 1)[0]
        .match(/\.(glb|gltf|fbx|obj|stl)$/i)?.[1]
        ?.toLowerCase();
    return (urlExtension as Model3DPreviewFormat | undefined) || null;
}

export function model3DFileName(fileName: string | undefined, format: Model3DPreviewFormat) {
    const base =
        (fileName || "model")
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
            .replace(/\.(glb|gltf|fbx|obj|stl)$/i, "")
            .trim() || "model";
    return `${base}.${format}`;
}
