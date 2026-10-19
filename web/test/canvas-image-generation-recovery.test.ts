import { afterEach, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { applyMaterializedGenerationTaskResultToNodes, generationTaskOutputsApplied } from "../src/lib/canvas/canvas-generation-task-sync";
import { applyGenerationConsumerEffect } from "../src/services/generation-consumer-dedupe";
import { attachNodeEffectKey, createGenerationTaskMaterializer } from "../src/services/generation-task-materializer";
import * as assetSync from "../src/services/project-asset-sync";
import { useAssetStore, withAssetStorePersistenceSuppressed, type ImageAsset } from "../src/stores/use-asset-store";
import type { GenerationTask } from "../src/services/api/task-center";
import type { CanvasNodeData } from "../src/types/canvas";
import type { useCanvasGeneration } from "../src/pages/canvas/use-canvas-generation";

const build = await Bun.build({ entrypoints: [new URL("../src/pages/canvas/use-canvas-generation.ts", import.meta.url).pathname], target: "node", format: "cjs", external: ["*"] });
if (!build.success) throw new Error(build.logs.map(String).join("\n"));
const hookSource = await build.outputs[0].text();
const require = createRequire(import.meta.url);
const initialAssets = useAssetStore.getState().assets;
afterEach(() => withAssetStorePersistenceSuppressed(() => useAssetStore.setState({ assets: initialAssets })));

async function recoveryHarness() {
    const asset: ImageAsset = {
        id: "asset",
        kind: "image",
        title: "image",
        coverUrl: "/image.png",
        tags: [],
        createdAt: "",
        updatedAt: "",
        data: { dataUrl: "/image.png", storageKey: "resource:image", width: 640, height: 480, bytes: 10, mimeType: "image/png" },
    };
    withAssetStorePersistenceSuppressed(() => useAssetStore.setState({ assets: [asset] }));
    const task: GenerationTask = {
        id: "task",
        projectId: "fixture",
        type: "canvas_image",
        status: "succeeded",
        prompt: "fixture",
        attempts: 1,
        createdAt: "",
        updatedAt: "",
        resultJson: JSON.stringify({ mode: "image", images: [{ dataUrl: "/image.png", storageKey: "resource:image" }] }),
        outputs: [{ outputIndex: 0, mediaType: "image", providerArtifactRef: "resource:image", materializedAssetId: asset.id }],
    };
    const effectKey = attachNodeEffectKey(task.id, "image", 0);
    const image: CanvasNodeData = {
        id: "image",
        type: "image",
        title: "image",
        position: { x: 0, y: 0 },
        width: 320,
        height: 240,
        metadata: applyGenerationConsumerEffect(
            {
                taskId: task.id,
                taskStatus: "succeeded",
                status: "success",
                generationType: "generation",
                generationOutputCount: 1,
                content: "/image.png",
                storageKey: "resource:image",
                assetId: asset.id,
                resourceReloadAvailable: true,
                errorDetails: "结果已生成，应用结果失败：Network Error",
                taskStage: "结果已生成，等待恢复同步",
            },
            effectKey,
            (value) => value,
        ).value,
    };
    const source: CanvasNodeData = { ...image, id: "source", type: "config", metadata: { status: "loading", imageGenerationRootId: image.id, errorDetails: "结果待同步" } };
    const nodesRef = { current: [source, image] };
    const claims: string[] = [];
    let consumerCalls = 0;
    let failConfirmation = false;
    let beforeStateUpdate: (() => void) | undefined;
    const materializer = createGenerationTaskMaterializer({
        effects: {
            async claim(key) {
                claims.push(key);
                if (failConfirmation) throw new Error("Network Error");
                return { status: "completed", result: {} };
            },
            async renew() {
                throw new Error("completed effects must not be renewed");
            },
            async complete() {
                throw new Error("completed effects must not be written again");
            },
            async release() {
                throw new Error("completed effects must not be released");
            },
        },
        async materializeOutput() {
            throw new Error("registered output must not be materialized again");
        },
    });
    const module = { exports: {} as { useCanvasGeneration: typeof useCanvasGeneration } };
    runInNewContext(hookSource, {
        module,
        exports: module.exports,
        console,
        Error,
        DOMException,
        AbortController,
        AbortSignal,
        require(name: string) {
            if (name === "react") return { useCallback: (fn: unknown) => fn, useRef: (current: unknown) => ({ current }), useState: (current: unknown) => [current, () => undefined], useEffect() {} };
            if (name === "antd") return { App: { useApp: () => ({ message: { warning() {} } }) } };
            if (name === "@tanstack/react-query") return { useQueryClient: () => ({ invalidateQueries() {} }) };
            if (name === "@/services/project-asset-sync")
                return {
                    ...assetSync,
                    consumeGenerationTaskNode: (task: GenerationTask, nodeId: string, index: number, consumer: Parameters<typeof assetSync.consumeGenerationTaskNode>[3], dependencies: Parameters<typeof assetSync.consumeGenerationTaskNode>[4]) =>
                        assetSync.consumeGenerationTaskNode(
                            task,
                            nodeId,
                            index,
                            (input) => {
                                consumerCalls += 1;
                                return consumer(input);
                            },
                            { ...dependencies, materialize: materializer.materialize, attachNode: materializer.attachNode },
                        ),
                };
            if (name.startsWith("./")) return require(new URL(`../src/pages/canvas/${name}`, import.meta.url).pathname);
            return require(name.startsWith("@/") ? new URL(`../src/${name.slice(2)}`, import.meta.url).pathname : name);
        },
    });
    const api = module.exports.useCanvasGeneration({
        projectId: "fixture",
        projectLoaded: false,
        nodes: nodesRef.current,
        nodesRef,
        setNodes: (value) => {
            const mutate = beforeStateUpdate;
            beforeStateUpdate = undefined;
            mutate?.();
            nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value;
        },
    });
    expect(generationTaskOutputsApplied(image, task, nodesRef.current)).toBe(true);
    const replay = await applyMaterializedGenerationTaskResultToNodes(nodesRef.current, task, task.outputs![0], effectKey, image.id);
    expect(replay.node).toBe(image);
    return {
        task,
        effectKey,
        claims,
        nodesRef,
        get consumerCalls() {
            return consumerCalls;
        },
        node: () => nodesRef.current.find((node) => node.id === image.id)!,
        source: () => nodesRef.current.find((node) => node.id === source.id)!,
        recover: () => api.applyGenerationTaskResult(image.id, task),
        failConfirmation: (value: boolean) => {
            failConfirmation = value;
        },
        replaceTaskAtCommit: () => {
            beforeStateUpdate = () => {
                nodesRef.current = nodesRef.current.map((node) =>
                    node.id === image.id ? { ...node, metadata: { ...node.metadata, taskId: "new-task", taskStatus: "running", status: "loading", resourceReloadAvailable: true, errorDetails: "新任务诊断" } } : node,
                );
            };
        },
        startNewBatch: () => {
            const next: CanvasNodeData = { ...image, id: "new-image", metadata: { status: "loading", taskId: "new-task", taskStatus: "running", generationType: "generation" } };
            nodesRef.current = [...nodesRef.current.map((node) => (node.id === source.id ? { ...node, metadata: { ...node.metadata, imageGenerationRootId: next.id, status: "loading", errorDetails: "新一批待同步" } } : node)), next];
        },
    };
}

test("confirmed completed effects clear recovery diagnostics without reapplying an already delivered image", async () => {
    const h = await recoveryHarness();
    await h.recover();
    expect(h.claims).toEqual([h.effectKey]);
    expect(h.consumerCalls).toBe(0);
    expect(h.node().metadata).toMatchObject({ status: "success", content: "/image.png", resourceReloadAvailable: undefined, errorDetails: undefined, taskStage: undefined });
    expect(h.source().metadata).toMatchObject({ status: "success", errorDetails: undefined });
});

test("failed confirmation retains the delivered image until the same completed effect is confirmed", async () => {
    const h = await recoveryHarness();
    h.failConfirmation(true);
    await expect(h.recover()).rejects.toThrow("Network Error");
    expect(h.node().metadata).toMatchObject({ status: "success", content: "/image.png", resourceReloadAvailable: true });
    expect(h.source().metadata?.status).toBe("loading");
    h.failConfirmation(false);
    await h.recover();
    expect(h.consumerCalls).toBe(0);
    expect(h.node().metadata?.resourceReloadAvailable).toBeUndefined();
    expect(h.source().metadata?.status).toBe("success");
});

test("an old task confirmation cannot clear a replacement task's diagnostics", async () => {
    const h = await recoveryHarness();
    h.replaceTaskAtCommit();
    await h.recover();
    expect(h.node().metadata).toMatchObject({ taskId: "new-task", taskStatus: "running", status: "loading", resourceReloadAvailable: true, errorDetails: "新任务诊断" });
    expect(h.source().metadata?.status).toBe("loading");
});

test("confirming an old batch cannot finish a newer generation from the same config source", async () => {
    const h = await recoveryHarness();
    h.startNewBatch();
    await h.recover();
    expect(h.node().metadata?.resourceReloadAvailable).toBeUndefined();
    expect(h.source().metadata).toMatchObject({ imageGenerationRootId: "new-image", status: "loading", errorDetails: "新一批待同步" });
});
