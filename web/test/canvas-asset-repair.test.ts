import { beforeEach, describe, expect, test } from "bun:test";

import { collectCanvasMediaAssetIds, rebindInconsistentCanvasAssets, repairMissingCanvasAssets, repairMissingCanvasVideoPreviews } from "@/services/canvas-asset-repair";
import { ApiError } from "@/services/api/request";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { TimelineClip } from "@/types/timeline";
import { createDefaultModel3DState } from "@/lib/canvas/model3d";
import { canvasNodeToAsset } from "@/lib/canvas/canvas-node-asset";

test("场景换图后的旧画布保留资产历史图片引用，不创建重复素材", () => {
    const image: Asset = { id: "scene", kind: "image", category: "environment", title: "阁楼", coverUrl: "", tags: [], createdAt: "", updatedAt: "", metadata: { projectAssetImageHistory: ["resource:old-image"] }, data: { dataUrl: "/api/resources/new-image/file", storageKey: "resource:new-image", width: 800, height: 600, bytes: 100, mimeType: "image/png" } };
    useAssetStore.setState({ assets: [image] });
    const node = { ...videoNode("scene-node", "scene", "resource:old-image"), type: CanvasNodeType.Image };
    useCanvasStore.setState({ projects: [project("canvas", [node])] });
    expect(repairMissingCanvasAssets()).toEqual({ createdAssets: 0, updatedProjects: 0 });
    expect(useCanvasStore.getState().projects[0].nodes[0].metadata?.storageKey).toBe("resource:old-image");
    expect(useAssetStore.getState().assets).toHaveLength(1);
});

function videoAsset(id: string, storageKey?: string, url = ""): Asset {
    return {
        id,
        kind: "video",
        title: `素材 ${id}`,
        coverUrl: "",
        tags: [],
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        data: { url, ...(storageKey ? { storageKey } : {}), width: 1, height: 1, bytes: 1, mimeType: "video/mp4" },
    } as Asset;
}

function videoNode(id: string, assetId: string | undefined, storageKey: string): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Video,
        title: "镜头",
        position: { x: 0, y: 0 },
        width: 320,
        height: 240,
        metadata: { assetId, storageKey, content: "blob:http://localhost/preview" },
    };
}

function project(id: string, nodes: CanvasNodeData[], clips: TimelineClip[] = []): CanvasProject {
    return {
        id,
        title: `画布 ${id}`,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        nodes,
        connections: [],
        chatSessions: [],
        activeChatId: null,
        viewport: { x: 0, y: 0, k: 1 },
        ...(clips.length ? { timeline: { clips } } : {}),
    };
}

function timelineClip(assetId: string | undefined, storageKey: string): TimelineClip {
    return { id: "clip-1", kind: "video", directMedia: { id: "media-1", assetId, kind: "video", title: "片段", storageKey } } as TimelineClip;
}

beforeEach(() => {
    useCanvasStore.setState({ projects: [] });
    useAssetStore.setState({ assets: [] });
});

describe("repairMissingCanvasAssets 增量会话", () => {
    test("受管 3D 任务缺失素材时不另建随机身份替代服务端登记", () => {
        const state = createDefaultModel3DState("v3.1");
        state.result = { assetId: "managed-asset", resourceId: "model", storageKey: "resource:model", url: "/api/resources/model/file", format: "glb", fileName: "model.glb", bytes: 100, mimeType: "model/gltf-binary" };
        state.run = { taskId: "managed-task", requestId: "managed-request", sourceFingerprint: "managed", snapshot: state.draft, status: "succeeded" };
        const node = { ...videoNode("model-node", "managed-asset", "resource:model"), type: CanvasNodeType.Model3D, metadata: { storageKey: "resource:model", assetId: "managed-asset", model3d: state } };
        useCanvasStore.setState({ projects: [project("source", [node])] });
        expect(repairMissingCanvasAssets()).toEqual({ createdAssets: 0, updatedProjects: 0 });
        expect(rebindInconsistentCanvasAssets([])).toEqual({ createdAssets: 0, reboundNodes: 0, updatedProjects: 0 });
        expect(useAssetStore.getState().assets).toHaveLength(0);
    });

    test("节点声明不能掩盖素材库的真实绑定，错误配对会被重绑", () => {
        useAssetStore.setState({ assets: [videoAsset("asset-a", "resource:R1"), videoAsset("asset-c", "resource:R2")] });
        useCanvasStore.setState({ projects: [project("canvas-1", [videoNode("node-1", "asset-a", "resource:R2")])] });

        const result = repairMissingCanvasAssets(new Set(["canvas-1"]), true);

        expect(result.createdAssets).toBe(0);
        expect(useCanvasStore.getState().projects[0].nodes[0].metadata?.assetId).toBe("asset-c");
    });

    test("本地未加载的素材仍按节点声明接受，不会为远端素材分叉新建", () => {
        useCanvasStore.setState({ projects: [project("canvas-1", [videoNode("node-1", "remote-only", "resource:R9")])] });

        const result = repairMissingCanvasAssets(new Set(["canvas-1"]), true);

        expect(result.createdAssets).toBe(0);
        expect(useCanvasStore.getState().projects[0].nodes[0].metadata?.assetId).toBe("remote-only");
    });
});

describe("rebindInconsistentCanvasAssets 强制对齐", () => {
    test("修复导入模型的错误配对时只创建新素材，并同步内部结果供刷新和预览使用", () => {
        const node = { ...videoNode("model-node", "original-asset", "resource:copy"), type: CanvasNodeType.Model3D };
        const state = createDefaultModel3DState("v3.1");
        state.result = { assetId: "original-asset", resourceId: "original", storageKey: "resource:original", url: "/api/resources/original/file", format: "glb", fileName: "model.glb", bytes: 100, mimeType: "model/gltf-binary" };
        state.run = { taskId: "original-task", requestId: "original-request", sourceFingerprint: "original", snapshot: state.draft, status: "succeeded" };
        node.metadata = { ...node.metadata, content: "/api/resources/copy/file", mimeType: "model/gltf-binary", bytes: 100, model3d: state };
        const original = { ...canvasNodeToAsset({ ...node, metadata: { ...node.metadata, storageKey: "resource:original", content: state.result.url } }, { canvasId: "source", source: "canvas-generation" }), id: "original-asset", createdAt: "", updatedAt: "" } as Asset;
        const before = structuredClone(original);
        useAssetStore.setState({ assets: [original] });
        useCanvasStore.setState({ projects: [project("copy", [node])] });
        expect(collectCanvasMediaAssetIds(useCanvasStore.getState().projects)).toEqual(new Set(["original-asset"]));
        expect(rebindInconsistentCanvasAssets([original])).toEqual({ reboundNodes: 1, createdAssets: 1, updatedProjects: 1 });
        const repaired = JSON.parse(JSON.stringify(useCanvasStore.getState().projects[0].nodes[0])) as CanvasNodeData;
        const asset = useAssetStore.getState().assets.find((item) => item.id === repaired.metadata?.assetId)!;
        expect(asset.kind).toBe("model");
        expect(asset.data).toMatchObject({ storageKey: "resource:copy" });
        expect(repaired.metadata?.model3d?.result).toMatchObject({ assetId: asset.id, resourceId: "copy", storageKey: "resource:copy", url: "/api/resources/copy/file" });
        expect(repaired.metadata?.model3d?.run).toBeUndefined();
        expect(useAssetStore.getState().assets.find((item) => item.id === original.id)).toEqual(before);
        expect(repairMissingCanvasAssets()).toEqual({ createdAssets: 0, updatedProjects: 0 });
    });

    test("声明的素材引用了其他资源时重绑到引用同一资源的素材", () => {
        useCanvasStore.setState({ projects: [project("canvas-1", [videoNode("node-1", "asset-a", "resource:R2")])] });

        const result = rebindInconsistentCanvasAssets([videoAsset("asset-a", "resource:R1"), videoAsset("asset-c", "resource:R2")]);

        expect(result).toMatchObject({ reboundNodes: 1, createdAssets: 0, updatedProjects: 1 });
        expect(useCanvasStore.getState().projects[0].nodes[0].metadata?.assetId).toBe("asset-c");
    });

    test("没有素材引用节点资源时按节点新建素材并重绑", () => {
        useCanvasStore.setState({ projects: [project("canvas-1", [videoNode("node-1", "asset-a", "resource:R2")])] });

        const result = rebindInconsistentCanvasAssets([videoAsset("asset-a", "resource:R1")]);

        expect(result.reboundNodes).toBe(1);
        expect(result.createdAssets).toBe(1);
        const reboundId = useCanvasStore.getState().projects[0].nodes[0].metadata?.assetId;
        const created = useAssetStore.getState().assets.find((asset) => asset.id === reboundId);
        expect(created?.kind).toBe("video");
        expect(created && "storageKey" in created.data ? created.data.storageKey : undefined).toBe("resource:R2");
    });

    test("时间线 directMedia 与节点走同一套绑定校验", () => {
        useCanvasStore.setState({ projects: [project("canvas-1", [], [timelineClip("asset-a", "resource:R2")])] });

        const result = rebindInconsistentCanvasAssets([videoAsset("asset-a", "resource:R1"), videoAsset("asset-c", "resource:R2")]);

        expect(result.reboundNodes).toBe(1);
        expect(useCanvasStore.getState().projects[0].timeline?.clips[0].directMedia?.assetId).toBe("asset-c");
    });

    test("素材以资源文件 URL 引用时与 resource: 前缀归一化匹配", () => {
        useCanvasStore.setState({ projects: [project("canvas-1", [videoNode("node-1", "asset-a", "resource:R2")])] });

        const result = rebindInconsistentCanvasAssets([videoAsset("asset-a", undefined, "/api/resources/R2/file")]);

        expect(result.reboundNodes).toBe(0);
        expect(useCanvasStore.getState().projects[0].nodes[0].metadata?.assetId).toBe("asset-a");
    });

    test("绑定的素材记录缺失（远端已删）时也按节点重建", () => {
        useCanvasStore.setState({ projects: [project("canvas-1", [videoNode("node-1", "deleted-asset", "resource:R2")])] });

        const result = rebindInconsistentCanvasAssets([]);

        expect(result.reboundNodes).toBe(1);
        expect(result.createdAssets).toBe(1);
        expect(useCanvasStore.getState().projects[0].nodes[0].metadata?.assetId).not.toBe("deleted-asset");
    });
});

describe("collectCanvasMediaAssetIds", () => {
    test("只收集有资源身份的媒体节点与时间线片段声明", () => {
        const textNode: CanvasNodeData = { id: "node-text", type: CanvasNodeType.Text, title: "文本", position: { x: 0, y: 0 }, width: 200, height: 100, metadata: { content: "正文", assetId: "text-asset" } };
        const pendingNode = videoNode("node-pending", undefined, "resource:R3");
        const projects = [project("canvas-1", [videoNode("node-1", "asset-a", "resource:R1"), textNode, pendingNode], [timelineClip("asset-b", "resource:R2")])];

        expect(collectCanvasMediaAssetIds(projects)).toEqual(new Set(["asset-a", "asset-b"]));
    });
});

describe("repairMissingCanvasVideoPreviews", () => {
    test("only clears confirmed missing preview resources, not network failures", async () => {
        const node = { ...videoNode("node-1", "asset-1", "resource:video-1"), metadata: { ...videoNode("node-1", "asset-1", "resource:video-1").metadata, videoPreview: { storageKey: "resource:poster-1" } } };
        useCanvasStore.setState({ projects: [project("canvas-1", [node])] });

        await expect(repairMissingCanvasVideoPreviews(undefined, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
        expect(useCanvasStore.getState().projects[0].nodes[0].metadata?.videoPreview).toBeDefined();

        const result = await repairMissingCanvasVideoPreviews(undefined, async () => { throw new ApiError("missing", { status: 404 }); });
        expect(result).toEqual({ clearedPreviews: 1, updatedProjects: 1 });
        expect(useCanvasStore.getState().projects[0].nodes[0].metadata?.videoPreview).toBeUndefined();
    });

    test("preserves edits made while resource lookup is pending", async () => {
        const node = { ...videoNode("node-1", "asset-1", "resource:video-1"), metadata: { ...videoNode("node-1", "asset-1", "resource:video-1").metadata, videoPreview: { storageKey: "resource:poster-1" } } };
        useCanvasStore.setState({ projects: [project("canvas-1", [node])] });
        let rejectLookup!: (error: unknown) => void;
        const repair = repairMissingCanvasVideoPreviews(undefined, () => new Promise((_, reject) => { rejectLookup = reject; }));
        useCanvasStore.getState().updateProject("canvas-1", { title: "user edit" });
        rejectLookup(new ApiError("missing", { status: 404 }));
        await repair;
        expect(useCanvasStore.getState().projects[0].title).toBe("user edit");
        expect(useCanvasStore.getState().projects[0].nodes[0].metadata?.videoPreview).toBeUndefined();
    });
});
