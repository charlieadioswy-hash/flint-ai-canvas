import { expect, test } from "bun:test";
import { bindCanvasNodeAsset, canvasNodeToAsset, findCanvasNodeAsset, requiresMaterializedCanvasAsset } from "@/lib/canvas/canvas-node-asset";
import { remapImportedCanvasNode } from "@/lib/canvas/canvas-import";
import { createDefaultModel3DState } from "@/lib/canvas/model3d";
import type { Model3DPreviewFormat } from "@/lib/model3d-formats";
import type { Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function modelNode(format: Model3DPreviewFormat = "glb"): CanvasNodeData {
    const mimeType = { glb: "model/gltf-binary", gltf: "model/gltf+json", fbx: "application/octet-stream", obj: "model/obj", stl: "model/stl" }[format];
    const state = createDefaultModel3DState("v3.1");
    state.draft.prompt = "a toy";
    return {
        id: "model-node", type: CanvasNodeType.Model3D, title: `toy.${format}`,
        position: { x: 0, y: 0 }, width: 520, height: 420,
        metadata: { content: "/api/resources/copied/file", storageKey: "resource:copied", bytes: 156528, mimeType, model3d: state },
    };
}

test("imported model resources become ordinary model assets in every supported preview format", () => {
    for (const format of ["glb", "gltf", "fbx", "obj", "stl"] as const) {
        const node = modelNode(format);
        const asset = canvasNodeToAsset(node, { canvasId: "copy", source: "canvas-upload" });
        expect(asset?.kind).toBe("model");
        expect(asset?.data).toMatchObject({ storageKey: "resource:copied", bytes: 156528, mimeType: node.metadata!.mimeType, fileName: `toy.${format}` });
        expect(asset?.metadata).toMatchObject({ canvasId: "copy", nodeId: node.id, resourceKey: "resource:copied" });
        expect(asset?.metadata?.taskId).toBeUndefined();
    }
});

test("a copied model asset cannot reuse the source asset for a different resource", () => {
    const node = modelNode();
    const original = { ...canvasNodeToAsset({ ...node, metadata: { ...node.metadata, storageKey: "resource:original" } }, { canvasId: "source", source: "canvas-upload" }), id: "source-asset", createdAt: "", updatedAt: "" } as Asset;
    expect(original.kind).toBe("model");
    expect(findCanvasNodeAsset([original], { ...node, metadata: { ...node.metadata, assetId: original.id } }, "copy")).toBeUndefined();
    expect(canvasNodeToAsset({ ...node, metadata: { model3d: createDefaultModel3DState() } }, { canvasId: "copy", source: "canvas-upload" })).toBeNull();
});

test("ZIP remaps the preview result and reference inputs while detaching all historical task identities", () => {
    const node = modelNode();
    const state = node.metadata!.model3d!;
    state.draft.image = { storageKey: "resource:old-input", resourceId: "old-input", url: "/api/resources/old-input/file" };
    state.draft.views.front = { ...state.draft.image };
    state.result = { assetId: "source-asset", storageKey: "resource:old-result", resourceId: "old-result", url: "/api/resources/old-result/file", format: "glb", fileName: "toy.glb", mimeType: "model/gltf-binary", bytes: 156528 };
    state.run = { taskId: "old-task", requestId: "old-request", sourceFingerprint: "fingerprint", snapshot: structuredClone(state.draft), status: "succeeded", canRetryStorage: false };
    node.metadata = { ...node.metadata, assetId: "source-asset", storageKey: "resource:old-result", content: state.result.url, taskId: "old-task", generationEffectKeys: ["old-effect"] };
    const original = structuredClone(node);
    const imported = remapImportedCanvasNode(node, new Map([
        ["resource:old-result", { storageKey: "resource:new-result", url: "/api/resources/new-result/file" }],
        ["resource:old-input", { storageKey: "resource:new-input", url: "/api/resources/new-input/file" }],
    ]));
    expect(requiresMaterializedCanvasAsset(node)).toBe(true);
    expect(requiresMaterializedCanvasAsset(imported)).toBe(false);
    expect(imported.metadata?.assetId).toBeUndefined();
    expect(imported.metadata?.model3d?.run).toBeUndefined();
    const saved = JSON.parse(JSON.stringify(bindCanvasNodeAsset(imported, "copied-asset"))) as CanvasNodeData;
    expect(saved.metadata).toMatchObject({ assetId: "copied-asset", storageKey: "resource:new-result", content: "/api/resources/new-result/file" });
    expect(saved.metadata?.model3d?.result).toMatchObject({ assetId: "copied-asset", resourceId: "new-result", storageKey: "resource:new-result", url: "/api/resources/new-result/file" });
    expect(saved.metadata?.model3d?.draft.image?.resourceId).toBe("new-input");
    expect(saved.metadata?.model3d?.draft.views.front?.storageKey).toBe("resource:new-input");
    for (const oldIdentity of ["source-asset", "old-task", "old-request", "old-result", "old-input", "old-effect"]) expect(JSON.stringify(saved)).not.toContain(oldIdentity);
    expect(node).toEqual(original);
});

test("an archive without embedded media preserves shared files but registers independent model ownership", () => {
    const source = modelNode("obj");
    source.metadata!.assetId = "source-asset";
    const original = { ...canvasNodeToAsset(source, { canvasId: "source", source: "canvas-upload" }), id: "source-asset", createdAt: "", updatedAt: "" } as Asset;
    const before = structuredClone(original);
    const copied = remapImportedCanvasNode(source, new Map());
    expect(copied.metadata?.storageKey).toBe(source.metadata!.storageKey);
    expect(copied.metadata?.assetId).toBeUndefined();
    expect(findCanvasNodeAsset([original], copied, "copy")).toBeUndefined();
    expect(canvasNodeToAsset(copied, { canvasId: "copy", source: "canvas-upload" })?.metadata?.canvasId).toBe("copy");
    expect(original).toEqual(before);
});

test("unavailable blob model results cannot retain an active task or stale resource reference", () => {
    const source = modelNode();
    const state = source.metadata!.model3d!;
    state.result = { assetId: "old", storageKey: "blob:expired", resourceId: "old", url: "blob:expired", format: "glb", fileName: "toy.glb", mimeType: "model/gltf-binary", bytes: 10 };
    state.run = { requestId: "old", taskId: "old", sourceFingerprint: "old", snapshot: state.draft, status: "running" };
    const imported = remapImportedCanvasNode(source, new Map());
    expect(imported.metadata?.model3d?.result).toBeUndefined();
    expect(imported.metadata?.model3d?.run).toBeUndefined();
    expect(canvasNodeToAsset(imported, { canvasId: "copy", source: "canvas-upload" })).toBeNull();
});
