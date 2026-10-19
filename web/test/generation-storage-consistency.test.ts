import { expect, test } from "bun:test";

type Scenario =
    | "image-cleanup"
    | "scope-cleanup-switch"
    | "scope-cleanup-late-canvas-reference"
    | "video-commit-race"
    | "audio-commit-race"
    | "canvas-batch-commit-race"
    | "canvas-multi-output"
    | "canvas-copy-generation"
    | "http-registered-generation"
    | "http-generation-mismatch"
    | "http-creation-generation"
    | "http-creation-generation-mismatch"
    | "http-creation-generation-missing"
    | "http-generation-missing"
    | "canvas-mask-batch"
    | "canvas-asset-preparation";

test("HTTP 创作消息复用已登记图片并持久化，并发重放不新建素材或生成任务", async () => {
    type Message = import("../src/pages/create/creation-types").CreationMessage;
    const result = await runScenario<{ rejection: string; applied: number; message: Message; restored: Array<{ title: string; messages: Message[] }>; assets: unknown[]; requests: string[] }>("http-creation-generation");
    expect(result.rejection).toBe("");
    expect(result.applied).toBe(1);
    expect(result.message).toMatchObject({ status: "done", error: undefined, resultStorageKeys: ["resource:http-image"], generationEffectKeys: ["attach-message:task-http-recovery:http-message:0"] });
    expect(result.restored[0]).toMatchObject({ title: "保留标题", messages: [{ status: "done", resultStorageKeys: ["resource:http-image"], generationEffectKeys: ["attach-message:task-http-recovery:http-message:0"] }] });
    expect(result.restored[0]?.messages[0]?.resultUrls).toBeUndefined();
    expect(result.assets).toHaveLength(1);
    expect(result.requests.some((request) => request.startsWith("put:") || request.startsWith("patch:") || request.includes("/tasks"))).toBe(false);
});

test("HTTP 创作回填拒绝不匹配或未登记的素材，不能无锁创建或完成消息", async () => {
    for (const variant of ["mismatch", "missing"] as const) {
        const result = await runScenario<{ rejection: string; applied: number; message: { status: string }; requests: string[] }>(`http-creation-generation-${variant}`);
        expect(result.rejection).toContain(variant === "mismatch" ? "生成素材与任务资源不一致" : "跨页面生成副作用互斥");
        expect(result.applied).toBe(0);
        expect(result.message.status).toBe("error");
        expect(result.requests.some((request) => request.startsWith("put:") || request.startsWith("patch:") || request.includes("/tasks"))).toBe(false);
    }
});

test("内网 HTTP 从原任务恢复已登记图片，缺少 Web Lock 和 Web Crypto 仍复用素材并保存", async () => {
    type Node = import("../src/types/canvas").CanvasNodeData;
    type Asset = import("../src/stores/use-asset-store").Asset;
    const result = await runScenario<{ needsRecovery: boolean; lockError: string; materializedId: string; projectedId: string; saved: Node; restored: Node; replayed: Node; assets: Asset[]; requests: string[] }>("http-registered-generation");
    const assetId = "generation_e8a36a9adf905e4dfd72cd164c1f5b412e6464d00dc490e3d988121db742e6e4";
    expect(result.needsRecovery).toBe(true);
    expect(result.lockError).toContain("跨页面生成副作用互斥");
    expect(result.materializedId).toBe(assetId);
    expect(result.projectedId).toBe(assetId);
    for (const node of [result.saved, result.restored, result.replayed])
        expect(node).toMatchObject({ id: "front", title: "用户改名", position: { x: 700, y: 100 }, metadata: { assetId, storageKey: "resource:http-image", status: "success", taskId: "task-http-recovery" } });
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({ id: assetId, title: "用户已修改标题", tags: ["精选"] });
    expect(result.requests.filter((request) => request.startsWith("put:/assets/"))).toEqual([]);
    expect(result.requests.some((request) => request.startsWith("patch:/canvas-projects/") && request.endsWith("/operations"))).toBe(true);
    expect(result.requests.some((request) => request.startsWith("put:/canvas-projects/"))).toBe(false);
    expect(result.requests.some((request) => request.includes("/tasks"))).toBe(false);
});

test("HTTP 恢复拒绝资源不匹配的登记身份，缺失素材也不能绕过跨页互斥新建", async () => {
    const mismatch = await runScenario<{ rejection: string; boundAssetId?: string; requests: string[] }>("http-generation-mismatch");
    expect(mismatch.rejection).toContain("生成素材与任务资源不一致");
    expect(mismatch.boundAssetId).toBeUndefined();
    const missing = await runScenario<{ rejection: string; boundAssetId?: string; requests: string[] }>("http-generation-missing");
    expect(missing.rejection).toContain("跨页面生成副作用互斥");
    expect(missing.boundAssetId).toBeUndefined();
    for (const result of [mismatch, missing]) expect(result.requests.some((request) => request.startsWith("put:") || request.startsWith("patch:") || request.includes("/tasks"))).toBe(false);
});

test("局部重绘并发完成时根节点复用主图资源和素材，重载后保持完整绑定", async () => {
    type Node = import("../src/types/canvas").CanvasNodeData;
    const result = await runScenario<{ live: Node[]; restored: Node[] }>("canvas-mask-batch");
    for (const nodes of [result.live, result.restored]) {
        const root = nodes.find((node) => node.id === "mask-root")!;
        const primary = nodes.find((node) => node.id === root.metadata?.primaryImageId)!;
        expect(root.metadata).toMatchObject({ status: "success", assetId: primary.metadata!.assetId, storageKey: primary.metadata!.storageKey, batchFailedCount: 3 });
        expect(root.position).toEqual({ x: -400, y: 0 });
        expect(root.width).toBe(primary.width);
        expect(root.height).toBe(primary.height);
        expect(root.width / root.height).toBeCloseTo(640 / 360);
        expect(nodes.find((node) => node.id === "node-1")?.position).toEqual({ x: 400, y: 0 });
        expect(nodes.find((node) => node.id === "node-0")).toMatchObject({ title: "用户改名", position: { x: 700, y: 500 }, metadata: { assetId: "asset-0" } });
        expect(nodes.find((node) => node.id === "node-1")?.metadata?.assetId).toBe("asset-1");
    }
});

test("派生结果等待素材持久化且不提前发布，原始结果缺绑定及取消均阻止交付", async () => {
    type Node = import("../src/types/canvas").CanvasNodeData;
    const result = await runScenario<{
        resolvedBeforePersistence: boolean;
        nodesBeforePersistence: Node[];
        prepared: Node;
        persisted: string;
        countBeforeReuse: number;
        countAfterReuse: number;
        reusedSameNode: boolean;
        missingBindingError: boolean;
        aborted: boolean;
        finalAssetCount: number;
    }>("canvas-asset-preparation");
    expect(result.resolvedBeforePersistence).toBe(false);
    expect(result.nodesBeforePersistence[0].metadata).toEqual({ status: "loading" });
    expect(result.prepared.metadata?.assetId).toBeTruthy();
    expect(result.persisted).toContain(result.prepared.metadata!.assetId!);
    expect(result.persisted).toContain("resource:derived");
    expect(result.reusedSameNode).toBe(true);
    expect(result.countBeforeReuse).toBe(1);
    expect(result.countAfterReuse).toBe(1);
    expect(result.finalAssetCount).toBe(1);
    expect(result.missingBindingError).toBe(true);
    expect(result.aborted).toBe(true);
});

test("一次任务四图经真实消费链路堆叠并保存，刷新和重放保留四个独立资源", async () => {
    type Node = import("../src/types/canvas").CanvasNodeData;
    const result = await runScenario<{ edited: boolean; live: Node[]; restored: Node[]; replayed: Node[] }>("canvas-multi-output");
    expect(result.edited).toBe(true);
    for (const nodes of [result.live, result.restored, result.replayed]) {
        expect(nodes).toHaveLength(9);
        const root = nodes.find((node) => node.id === "node-0")!;
        expect(root).toMatchObject({ title: "用户改名", position: { x: 700, y: 500 }, metadata: { isBatchRoot: true, imageBatchExpanded: false, generationOutputCount: 4, assetId: "asset-0" } });
        expect(root.metadata?.batchChildIds).toHaveLength(4);
        const children = nodes.filter((node) => node.metadata?.batchRootId === root.id);
        expect(children).toHaveLength(4);
        expect(children.map((node) => node.metadata?.storageKey)).toEqual([0, 1, 2, 3].map((index) => `resource:image-${index}`));
        expect(children.map((node) => node.metadata?.assetId)).toEqual([0, 1, 2, 3].map((index) => `asset-${index}`));
        expect(children.map((node) => node.metadata?.naturalWidth)).toEqual([640, 641, 642, 643]);
        expect(nodes.filter((node) => node.metadata?.status === "error")).toHaveLength(3);
    }
});
type ScenarioResponse<T> = { ok: true; result: T } | { ok: false; error: string };

test("已生成图片的副本在普通保存和新生成结果持久化后仍保留，原节点不受影响", async () => {
    type Node = import("../src/types/canvas").CanvasNodeData;
    const result = await runScenario<{ beforeGeneration: Node[]; restored: Node[] }>("canvas-copy-generation");
    expect(result.beforeGeneration.map((node) => node.id)).toEqual(["source", "copy"]);
    expect(result.beforeGeneration.find((node) => node.id === "copy")?.metadata?.generationEffectKeys).toBeUndefined();
    expect(result.restored.map((node) => node.id)).toEqual(["source", "copy"]);
    expect(result.restored.find((node) => node.id === "source")?.metadata).toMatchObject({ content: "original-image", generationEffectKeys: ["attach-node:old-task:source:0"] });
    expect(result.restored.find((node) => node.id === "copy")?.metadata).toMatchObject({ content: "new-image", status: "success", generationEffectKeys: ["attach-node:new-task:copy:0"] });
    expect(result.restored.find((node) => node.id === "copy")).toMatchObject({ title: "Latest user title", position: { x: 700, y: 500 } });
});

test("并发生成结果经真实持久化消费链路及重新读取后保留成功、失败和用户编辑", async () => {
    type Node = import("../src/types/canvas").CanvasNodeData;
    const result = await runScenario<{ edited: boolean; live: Node[]; restored: Node[] }>("canvas-batch-commit-race");
    expect(result.edited).toBe(true);
    for (const nodes of [result.live, result.restored]) {
        expect(nodes).toHaveLength(6);
        expect(nodes.filter((node) => node.metadata?.status === "success")).toHaveLength(2);
        expect(nodes.filter((node) => node.metadata?.status === "error")).toHaveLength(3);
        expect(nodes.find((node) => node.id === "node-0")).toMatchObject({ title: "用户改名", position: { x: 700, y: 500 }, metadata: { assetId: "asset-0" } });
        expect(nodes.find((node) => node.id === "node-1")?.metadata?.assetId).toBe("asset-1");
    }
});

function runScenario<T>(scenario: Scenario): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const worker = new Worker(new URL("./helpers/generation-storage-consistency.worker.ts", import.meta.url).href, { type: "module" });
        const finish = () => {
            worker.terminate();
        };
        worker.onmessage = (event: MessageEvent<ScenarioResponse<T>>) => {
            finish();
            if (event.data.ok) resolve(event.data.result);
            else reject(new Error(event.data.error));
        };
        worker.onerror = (event) => {
            finish();
            reject(event.error ?? new Error(event.message));
        };
        worker.postMessage(scenario);
    });
}

test("generation image cleanup removes unused generation-image blobs and preserves referenced ones", async () => {
    const result = await runScenario<{ usedPresent: boolean; unusedPresent: boolean }>("image-cleanup");
    expect(result.usedPresent).toBe(true);
    expect(result.unusedPresent).toBe(false);
});

test("delayed cleanup keeps account-A Canvas-only image references after switching the active account", async () => {
    const result = await runScenario<{ referencedPresent: boolean; unusedPresent: boolean; otherScopePresent: boolean }>("scope-cleanup-switch");
    expect(result.referencedPresent).toBe(true);
    expect(result.unusedPresent).toBe(false);
    expect(result.otherScopePresent).toBe(true);
});

test("delayed cleanup preserves a same-scope Canvas-only reference added after cleanup was queued", async () => {
    const result = await runScenario<{ referencedPresent: boolean; unusedPresent: boolean }>("scope-cleanup-late-canvas-reference");
    expect(result.referencedPresent).toBe(true);
    expect(result.unusedPresent).toBe(false);
});

test("generation video and audio materialization cannot race cleanup into a catalog row whose blob is missing", async () => {
    for (const mediaType of ["video", "audio"] as const) {
        const result = await runScenario<{ kind?: string; storageKey?: string; blobPresent: boolean; generationAssetCount: number }>(`${mediaType}-commit-race`);
        expect(result.kind).toBe(mediaType);
        expect(result.storageKey).toMatch(new RegExp(`^generation-${mediaType}:generation-media-commit-race-${mediaType}:`));
        expect(result.blobPresent).toBe(true);
        expect(result.generationAssetCount).toBe(1);
    }
});
