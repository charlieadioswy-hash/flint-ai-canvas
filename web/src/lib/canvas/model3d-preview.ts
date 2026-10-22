import { LoadingManager, Mesh, MeshStandardMaterial, type Object3D } from "three";
import { FBXLoader, GLTFLoader, MeshoptDecoder, OBJLoader, STLLoader } from "three-stdlib";

import type { Model3DPreviewFormat } from "@/lib/model3d-formats";
import { disposePrevisObject3D } from "@/lib/canvas/previs/previs-resources";

export type Model3DSource = { storageKey?: string; url: string; format: Model3DPreviewFormat; fileName?: string };
export const MODEL3D_MAX_BYTES = 128 * 1024 * 1024;
const EXTERNAL_DEPENDENCY_ERROR = "模型包含外部依赖，请使用内嵌贴图和几何数据的完整模型文件。";

function inlineModelURL(url: string) {
    return /^data:(?:application\/(?:octet-stream|gltf-buffer)|image\/(?:png|jpeg|jpg|webp|gif|bmp|tiff|tga|avif))(?:;[^,]*)?,/i.test(url);
}

function validateGLTFDependencies(data: ArrayBuffer | string) {
    let json: string;
    if (typeof data === "string") json = data;
    else {
        const view = new DataView(data);
        if (data.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== data.byteLength || view.getUint32(16, true) !== 0x4e4f534a) throw new Error("GLB 文件格式无效");
        const jsonLength = view.getUint32(12, true);
        if (!jsonLength || jsonLength > data.byteLength - 20) throw new Error("GLB 文件格式无效");
        json = new TextDecoder().decode(new Uint8Array(data, 20, jsonLength)).replace(/\u0000+$/, "");
    }
    const document = JSON.parse(json) as { buffers?: Array<{ uri?: string }>; images?: Array<{ uri?: string }> };
    for (const item of [...(document.buffers || []), ...(document.images || [])]) {
        if (item.uri !== undefined && !inlineModelURL(item.uri)) throw new Error(EXTERNAL_DEPENDENCY_ERROR);
    }
}

function safeModelManager() {
    const manager = new LoadingManager();
    const objectURLs = new Set<string>();
    let pending = 0;
    let parsing = true;
    let failed = false;
    let resolve!: () => void;
    const settled = new Promise<void>((done) => {
        resolve = done;
    });
    const finish = () => {
        if (!parsing && pending === 0) resolve();
    };
    const itemStart = manager.itemStart.bind(manager);
    const itemEnd = manager.itemEnd.bind(manager);
    const itemError = manager.itemError.bind(manager);
    manager.itemStart = (url) => {
        pending++;
        itemStart(url);
    };
    manager.itemEnd = (url) => {
        pending--;
        itemEnd(url);
        finish();
    };
    manager.itemError = (url) => {
        failed = true;
        itemError(url);
    };
    manager.setURLModifier((url) => {
        // Only loader-created embedded images may use blob URLs. Document URIs
        // are checked before parsing; relative paths and network URLs never load.
        if (url.startsWith("blob:")) {
            objectURLs.add(url);
            return url;
        }
        if (inlineModelURL(url)) return url;
        throw new Error(EXTERNAL_DEPENDENCY_ERROR);
    });
    return {
        manager,
        async complete() {
            parsing = false;
            finish();
            await settled;
            if (failed) throw new Error("模型内嵌贴图加载失败");
        },
        dispose() {
            objectURLs.forEach((url) => URL.revokeObjectURL(url));
        },
    };
}

export function createModel3DGLTFLoader(manager?: LoadingManager) {
    // Tripo's geometry compression uses EXT_meshopt_compression.
    return new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder());
}

export function createModel3DFBXLoader(manager?: LoadingManager) {
    return new FBXLoader(manager);
}

/** Parse a self-contained file without allowing model-controlled network requests. */
export async function parseModel3D(data: ArrayBuffer, format: Model3DPreviewFormat, signal?: AbortSignal): Promise<Object3D> {
    signal?.throwIfAborted();
    if (!data.byteLength || data.byteLength > MODEL3D_MAX_BYTES) throw new Error("模型文件为空或超过 128 MB");
    const safe = safeModelManager();
    let model: Object3D | undefined;
    try {
        if (format === "glb" || format === "gltf") {
            const input = format === "gltf" ? new TextDecoder().decode(data) : data;
            validateGLTFDependencies(input);
            const gltf = await createModel3DGLTFLoader(safe.manager).parseAsync(input, "");
            model = gltf.scene;
            model.animations = gltf.animations;
        } else if (format === "fbx") model = createModel3DFBXLoader(safe.manager).parse(data, "");
        else if (format === "obj") {
            const input = new TextDecoder().decode(data);
            if (/^\s*(?:mtllib|usemap)\s+\S/im.test(input)) throw new Error(EXTERNAL_DEPENDENCY_ERROR);
            model = new OBJLoader(safe.manager).parse(input);
        } else {
            const geometry = new STLLoader(safe.manager).parse(data);
            model = new Mesh(geometry, new MeshStandardMaterial({ vertexColors: Boolean(geometry.getAttribute("color")) }));
        }
        await safe.complete();
        signal?.throwIfAborted();
        return model;
    } catch (error) {
        disposePrevisObject3D(model);
        throw error;
    } finally {
        safe.dispose();
    }
}

export async function readModel3DSource(source: Model3DSource, signal?: AbortSignal): Promise<ArrayBuffer> {
    signal?.throwIfAborted();
    let url = source.url;
    let credentials: RequestCredentials = "same-origin";
    if (source.storageKey) {
        const resources = await import("@/services/api/resources");
        if (resources.resourceIdFromStorageKey(source.storageKey)) {
            const access = await resources.getResourceAccess(source.storageKey, "browser-process");
            url = resources.resolveResourceAccessURL(access.url);
            credentials = access.delivery === "platform-local" || access.delivery === "platform-proxy" ? "include" : "omit";
        } else {
            const { getMediaBlob } = await import("@/services/file-storage");
            const blob = await getMediaBlob(source.storageKey);
            signal?.throwIfAborted();
            if (blob) {
                if (blob.size > MODEL3D_MAX_BYTES) throw new Error("模型文件超过 128 MB");
                return blob.arrayBuffer();
            }
        }
    }
    signal?.throwIfAborted();
    if (!url) throw new Error("模型资源暂时不可用");
    const response = await fetch(url, { credentials, signal });
    if (!response.ok) throw new Error("模型读取失败");
    if (Number(response.headers.get("content-length")) > MODEL3D_MAX_BYTES) {
        await response.body?.cancel();
        throw new Error("模型文件超过 128 MB");
    }
    if (!response.body) return response.arrayBuffer();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            signal?.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MODEL3D_MAX_BYTES) throw new Error("模型文件超过 128 MB");
            chunks.push(value);
        }
        signal?.throwIfAborted();
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes.buffer;
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }
}

export async function loadModel3D(source: Model3DSource, signal?: AbortSignal) {
    return parseModel3D(await readModel3DSource(source, signal), source.format, signal);
}
