import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type { Object3D, WebGLRenderer } from "three";
import { model3DFormat, type Model3DPreviewFormat } from "@/lib/model3d-formats";

export type ModelThumbnailSource = { storageKey?: string; url: string; fileName: string; mimeType: string };
export type ModelThumbnailFormat = Model3DPreviewFormat;

export function modelThumbnailFormat(source: ModelThumbnailSource): ModelThumbnailFormat | null {
    return model3DFormat(source);
}

export function modelThumbnailKey(source: ModelThumbnailSource, scope: string) {
    // Hash source addresses so signed URLs never become persistent cache keys.
    const identity = JSON.stringify(["model-thumbnail-v1", scope, source.storageKey || source.url, modelThumbnailFormat(source)]);
    return bytesToHex(sha256(new TextEncoder().encode(identity)));
}

export async function renderModelThumbnail(source: ModelThumbnailSource, signal: AbortSignal): Promise<Blob> {
    const format = modelThumbnailFormat(source);
    if (!format) throw new Error("模型格式不支持缩略图");
    const [THREE, loaders, resources] = await Promise.all([import("three"), import("@/lib/canvas/model3d-preview"), import("@/lib/canvas/previs/previs-resources")]);
    signal.throwIfAborted();
    let model: Object3D | undefined;
    let renderer: WebGLRenderer | undefined;
    try {
        model = await loaders.loadModel3D({ ...source, format }, signal);
        signal.throwIfAborted();
        model.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(model);
        const size = bounds.getSize(new THREE.Vector3());
        const maximum = Math.max(size.x, size.y, size.z);
        if (!Number.isFinite(maximum) || maximum <= 0) throw new Error("模型没有可预览的几何体");
        model.position.sub(bounds.getCenter(new THREE.Vector3()));
        const group = new THREE.Group();
        group.add(model);
        group.scale.setScalar(2.5 / maximum);
        const scene = new THREE.Scene();
        scene.add(group, new THREE.HemisphereLight(0xffffff, 0x666666, 2.5));
        const key = new THREE.DirectionalLight(0xffffff, 3);
        key.position.set(3, 5, 4);
        const fill = new THREE.DirectionalLight(0xffffff, 1.5);
        fill.position.set(-3, 1, -2);
        scene.add(key, fill);
        const camera = new THREE.PerspectiveCamera(40, 4 / 3, 0.01, 100);
        camera.position.set(2.7, 1.6, 3.2);
        camera.lookAt(0, 0, 0);
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        renderer.setSize(512, 384, false);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.render(scene, camera);
        const blob = await new Promise<Blob>((resolve, reject) => {
            renderer!.domElement.toBlob((image) => (image ? resolve(image) : reject(new Error("模型缩略图生成失败"))), "image/webp", 0.85);
        });
        signal.throwIfAborted();
        return blob;
    } finally {
        resources.disposePrevisObject3D(model);
        renderer?.dispose();
        renderer?.forceContextLoss();
    }
}
