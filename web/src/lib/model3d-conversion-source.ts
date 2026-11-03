import type { Model3DSource } from "@/lib/canvas/model3d-preview";
import { model3DFileName } from "@/lib/model3d-formats";

export function hasCompressedModel3DGeometry(data: ArrayBuffer, format: "glb" | "gltf") {
    let json: Uint8Array;
    if (format === "gltf") json = new Uint8Array(data);
    else {
        const header = new DataView(data);
        if (data.byteLength < 20 || header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== data.byteLength || header.getUint32(16, true) !== 0x4e4f534a) throw new Error("GLB 文件格式无效");
        const length = header.getUint32(12, true);
        if (!length || length > data.byteLength - 20) throw new Error("GLB 文件格式无效");
        json = new Uint8Array(data, 20, length);
    }
    const document = JSON.parse(new TextDecoder().decode(json).replace(/\u0000+$/, "")) as { extensionsUsed?: string[]; extensionsRequired?: string[] };
    return [...(document.extensionsUsed || []), ...(document.extensionsRequired || [])].some((extension) => extension === "EXT_meshopt_compression" || extension === "KHR_draco_mesh_compression");
}

/** Blender receives a decoded derivative; the original resource is never replaced. */
export async function prepareModel3DConversionSource(source: Model3DSource, resourceId: string | undefined, signal?: AbortSignal) {
    let data: ArrayBuffer | undefined;
    if (source.format === "glb" || source.format === "gltf" || !resourceId) {
        const { readModel3DSource } = await import("@/lib/canvas/model3d-preview");
        data = await readModel3DSource(source, signal);
    }
    if ((source.format === "glb" || source.format === "gltf") && data && hasCompressedModel3DGeometry(data, source.format)) {
        const { parseModel3D } = await import("@/lib/canvas/model3d-preview");
        const { exportModel3DObject } = await import("@/lib/model3d-export");
        const { disposePrevisObject3D } = await import("@/lib/canvas/previs/previs-resources");
        const model = await parseModel3D(data, source.format, signal);
        try {
            signal?.throwIfAborted();
            const decoded = await exportModel3DObject(model, "glb", source.fileName);
            signal?.throwIfAborted();
            return { sourceFormat: "glb" as const, fileName: decoded.fileName, file: decoded.blob };
        } finally {
            disposePrevisObject3D(model);
        }
    }
    signal?.throwIfAborted();
    return { resourceId, sourceFormat: source.format, fileName: source.fileName || model3DFileName(undefined, source.format), file: resourceId ? undefined : new Blob([data!]) };
}
