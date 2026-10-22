import type { Object3D } from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";

import { loadModel3D, type Model3DSource } from "@/lib/canvas/model3d-preview";
import { disposePrevisObject3D } from "@/lib/canvas/previs/previs-resources";
import { model3DFileName, type Model3DExportFormat } from "@/lib/model3d-formats";

export type Model3DExport = { blob: Blob; fileName: string; mimeType: string };

/** OBJ/STL contain geometry; use the original file or GLB/GLTF to retain materials. */
export async function exportModel3DObject(model: Object3D, target: Model3DExportFormat, fileName?: string): Promise<Model3DExport> {
    model.updateMatrixWorld(true);
    let hasGeometry = false;
    model.traverse((object) => {
        const mesh = object as Object3D & { isMesh?: boolean; geometry?: { getAttribute(name: string): { count: number } | undefined } };
        if (mesh.isMesh && (mesh.geometry?.getAttribute("position")?.count || 0) >= 3) hasGeometry = true;
    });
    if (!hasGeometry) throw new Error("模型没有可导出的几何体");
    let blob: Blob;
    if (target === "obj") blob = new Blob([new OBJExporter().parse(model)], { type: "model/obj" });
    else if (target === "stl") {
        const data = new STLExporter().parse(model, { binary: true });
        blob = new Blob([new Uint8Array(data.buffer, data.byteOffset, data.byteLength)], { type: "model/stl" });
    } else {
        const data = await new GLTFExporter().parseAsync(model, { binary: target === "glb", animations: model.animations });
        blob = target === "glb" ? new Blob([data as ArrayBuffer], { type: "model/gltf-binary" }) : new Blob([JSON.stringify(data)], { type: "model/gltf+json" });
    }
    return { blob, fileName: model3DFileName(fileName, target), mimeType: blob.type };
}

export async function exportModel3D(source: Model3DSource, target: Model3DExportFormat, signal?: AbortSignal): Promise<Model3DExport> {
    const model = await loadModel3D(source, signal);
    try {
        signal?.throwIfAborted();
        const result = await exportModel3DObject(model, target, source.fileName);
        signal?.throwIfAborted();
        return result;
    } finally {
        disposePrevisObject3D(model);
    }
}
