import { afterEach, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import * as generationProject from "../src/lib/canvas/canvas-project-generation";
import { failedImageBatchChildren, imageGenerationTargetsForSource, reconcileImageBatchRoot, reconcileImageGenerationNodes } from "../src/lib/canvas/canvas-image-batch-retry";
import { canvasTaskBindingStatus } from "../src/lib/canvas/canvas-task-state";
import { defaultImageCapabilityConfig } from "../src/lib/model-capabilities";
import { apiClient } from "../src/services/api/request";
import { queryGenerationTask, waitForGenerationTask, type GenerationTask } from "../src/services/api/task-center";
import { CanvasGenerationDurableAckError } from "../src/services/canvas-generation-consumer";
import { createModelChannel, defaultConfig, encodeChannelModel } from "../src/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import type { CanvasGenerationExecution } from "../src/pages/canvas/canvas-generation-executor-types";
import { recoverCanvasGenerationTaskNode } from "../src/pages/canvas/use-canvas-generation";

const build = await Bun.build({
    entrypoints: [new URL("../src/pages/canvas/canvas-image-generation-executor.ts", import.meta.url).pathname],
    target: "node",
    format: "cjs",
    external: ["*"],
});
if (!build.success) throw new Error(build.logs.map(String).join("\n"));
const executorSource = await build.outputs[0].text();
const require = createRequire(import.meta.url);
const originalAdapter = apiClient.defaults.adapter;
const originalWindow = globalThis.window;

afterEach(() => {
    apiClient.defaults.adapter = originalAdapter;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

type Outcome = "succeeded" | "queued-disconnected" | "running-disconnected" | "failed" | "cancelled" | "submission-failed" | "ack-after-result" | "ack-before-result";

async function harness(outcomes: Outcome[], sourceType: CanvasNodeData["type"] = CanvasNodeType.Text) {
    Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), { setTimeout, clearTimeout, localStorage: { getItem: () => null } }) });
    const channel = createModelChannel({
        id: "fixture",
        name: "fixture",
        baseUrl: "https://provider.example",
        apiKey: "fixture",
        interfaceType: "openai-images",
        models: ["image-model"],
        modelCosts: [{ model: "image-model", capability: "image", protocol: "openai-images", billingMode: "fixed_request", unitPriceMicrocredits: 1, capabilityConfig: { version: 1, image: defaultImageCapabilityConfig() } }],
    });
    const model = encodeChannelModel(channel.id, "image-model");
    const source: CanvasNodeData = { id: "source", type: sourceType, title: "source", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: {} };
    let nodes = [source];
    let connections: CanvasGenerationExecution["canvasConnections"] = [];
    const tasks: GenerationTask[] = [];
    const submittedNodeIds: string[] = [];
    const messages: string[] = [];
    const queries = new Map<string, number>();
    const setNodes: CanvasGenerationExecution["setNodes"] = (value) => {
        nodes = typeof value === "function" ? value(nodes) : value;
    };
    const bindTask = (nodeId: string, task: GenerationTask) =>
        setNodes((current) => current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...generationProject.generationTaskMetadata(task), status: canvasTaskBindingStatus(node, task) } } : node)));
    const applyResult = async (nodeId: string, task: GenerationTask) => {
        const index = Number(task.id.slice("task-".length));
        const outcome = outcomes[index];
        const diagnostic = "结果已生成，应用结果失败：Network Error";
        setNodes((current) =>
            current.map((node) =>
                node.id === nodeId
                    ? {
                          ...node,
                          metadata: {
                              ...node.metadata,
                              ...(outcome === "ack-before-result" ? { status: "error" as const } : { status: "success" as const, content: `/result/${task.id}.png`, storageKey: `resource:${task.id}`, assetId: `asset:${task.id}` }),
                              ...(outcome.startsWith("ack-") ? { resourceReloadAvailable: true, errorDetails: diagnostic } : { resourceReloadAvailable: undefined, errorDetails: undefined }),
                          },
                      }
                    : node,
            ),
        );
        if (outcome.startsWith("ack-")) throw new CanvasGenerationDurableAckError(new Error("Network Error"));
    };
    apiClient.defaults.adapter = async (config) => {
        const id = String(config.url).split("/").at(-1)!;
        const task = tasks.find((item) => item.id === id)!;
        if (!task) throw new Error(`Unexpected request: ${config.url}`);
        queries.set(id, (queries.get(id) || 0) + 1);
        const index = Number(task.id.slice("task-".length));
        if (outcomes[index].endsWith("disconnected")) throw new Error("Network Error");
        const completed = { ...task, status: outcomes[index] === "failed" || outcomes[index] === "cancelled" ? outcomes[index] : "succeeded", error: outcomes[index] === "failed" ? "模型拒绝生成" : undefined } as GenerationTask;
        return { config, status: 200, statusText: "", headers: {}, data: { code: 0, data: completed, msg: "ok" } };
    };
    const module = { exports: {} as { executeImageGeneration: (input: CanvasGenerationExecution) => Promise<void> } };
    runInNewContext(executorSource, {
        module,
        exports: module.exports,
        console,
        structuredClone,
        require(name: string) {
            if (name === "@/lib/canvas/canvas-project-generation")
                return {
                    ...generationProject,
                    runCanvasGenerationTaskToConsumer: (input: Parameters<typeof generationProject.runCanvasGenerationTaskToConsumer>[0], dependencies: Parameters<typeof generationProject.runCanvasGenerationTaskToConsumer>[1]) =>
                        generationProject.runCanvasGenerationTaskToConsumer(input, {
                            ...dependencies,
                            runTask: async (options) => {
                                const index = submittedNodeIds.length;
                                submittedNodeIds.push(options.nodeId);
                                if (outcomes[index] === "submission-failed") throw new Error("提交失败");
                                const task: GenerationTask = { id: `task-${index}`, type: "canvas_image", status: outcomes[index] === "running-disconnected" ? "running" : "queued", prompt: "fixture", attempts: 1, createdAt: "", updatedAt: "" };
                                tasks.push(task);
                                options.onTaskCreated?.(task);
                                await waitForGenerationTask(task.id, { initialTask: task, intervalMs: 1, timeoutMs: 1000, onTaskUpdate: options.onTaskCreated });
                                return { mode: "image", images: [{ dataUrl: `/result/${task.id}.png`, storageKey: `resource:${task.id}` }] };
                            },
                        }),
                };
            return require(name.startsWith("@/") ? new URL(`../src/${name.slice(2)}`, import.meta.url).pathname : name);
        },
    });
    await module.exports.executeImageGeneration({
        nodeId: source.id,
        sourceNode: source,
        canvasNodes: nodes,
        canvasConnections: connections,
        prompt: "fixture",
        effectivePrompt: "fixture",
        generationConfig: { ...defaultConfig, channels: [channel], model, imageModel: model, count: String(outcomes.length) },
        generationContext: {
            prompt: "fixture",
            referenceImages: [],
            referenceVideos: [],
            referenceAudios: [],
            characterReferences: [],
            resolvedCharacterVersions: [],
            resolvedCharacterVoices: [],
            textCount: 0,
            imageCount: 0,
            videoCount: 0,
            audioCount: 0,
        },
        controller: new AbortController(),
        projectId: "",
        editingTextNode: false,
        styleMetadata: {},
        skillMetadata: { skillIds: [], skillVersions: [], skillFiles: [] },
        setNodes,
        setConnections: (value) => {
            connections = typeof value === "function" ? value(connections) : value;
        },
        setSelectedNodeIds() {},
        setSelectedConnectionId() {},
        setDialogNodeId() {},
        startGenerationRequest: () => new AbortController(),
        finishGenerationRequest() {},
        registerPendingNodeIds() {},
        bindGenerationTask: bindTask,
        applyGenerationTaskResult: applyResult,
        showError: (message) => messages.push(message),
    });
    const root = () => nodes.find((node) => node.metadata?.isBatchRoot) || nodes.find((node) => node.id === submittedNodeIds[0])!;
    return {
        root,
        messages,
        queries,
        submittedNodeIds,
        tasks,
        node: (index: number) => nodes.find((node) => node.id === submittedNodeIds[index])!,
        source: () => nodes.find((node) => node.id === source.id)!,
        failed: () => failedImageBatchChildren(root(), nodes),
        replaceConnections: (value: typeof connections) => {
            connections = value;
        },
        async recover(index: number, outcome: Outcome = "succeeded") {
            const task = tasks.find((item) => item.id === `task-${index}`)!;
            outcomes[index] = outcome;
            const completed =
                outcome === "failed" || outcome === "cancelled"
                    ? await queryGenerationTask(task.id)
                    : await waitForGenerationTask(task.id, { initialTask: task, intervalMs: 1, timeoutMs: 1000, onTaskUpdate: (task) => bindTask(submittedNodeIds[index], task) });
            bindTask(submittedNodeIds[index], completed);
            await recoverCanvasGenerationTaskNode({
                projectId: "fixture",
                node: nodes.find((node) => node.id === submittedNodeIds[index])!,
                completed,
                continuationOnly: false,
                nodesRef: {
                    get current() {
                        return nodes;
                    },
                    set current(value) {
                        nodes = value;
                    },
                },
                setNodes,
                applyGenerationTaskResult: applyResult,
                signal: new AbortController().signal,
            });
            setNodes((current) => current.map((node) => reconcileImageBatchRoot(node, current)));
        },
    };
}

test("nine images keep a disconnected running task pending without adding it to failed-image retries", async () => {
    const h = await harness([...Array<Outcome>(8).fill("succeeded"), "running-disconnected"]);
    expect(h.queries.get("task-8")).toBe(5);
    expect(h.node(8).metadata).toMatchObject({ status: "loading", taskId: "task-8", taskStatus: "running" });
    expect(h.node(8).metadata?.errorDetails).toContain("同步");
    expect(h.root().metadata?.batchFailedCount).toBe(0);
    expect(h.failed()).toHaveLength(0);
    expect(h.messages.join(" ")).toContain("同步");
    expect(h.messages.join(" ")).not.toContain("图片生成失败");
    await h.recover(8);
    expect(h.tasks).toHaveLength(9);
    expect(h.submittedNodeIds).toHaveLength(9);
    expect(h.node(8).metadata).toMatchObject({ status: "success", taskId: "task-8", taskStatus: "succeeded" });
    expect(h.node(8).metadata?.errorDetails).toBeUndefined();
    expect(h.root().metadata?.batchFailedCount).toBe(0);
});

test("all disconnected tasks leave the batch and source config pending", async () => {
    const h = await harness(["queued-disconnected", "running-disconnected"], CanvasNodeType.Config);
    expect(h.source().metadata?.imageGenerationRootId).toBe(h.root().id);
    expect(h.root().metadata?.status).toBe("loading");
    expect(h.source().metadata?.status).toBe("loading");
    expect(h.root().metadata?.batchFailedCount).toBe(0);
    expect(h.failed()).toHaveLength(0);
    expect(h.messages.join(" ")).not.toContain("全部图片生成失败");
    await h.recover(0);
    expect(h.source().metadata?.status).toBe("loading");
    await h.recover(1);
    expect(h.source().metadata).toMatchObject({ status: "success", errorDetails: undefined });
});

test("pending tasks that recover to actual terminal failures update both the source and batch failure count", async () => {
    const h = await harness(["running-disconnected", "running-disconnected"], CanvasNodeType.Config);
    await h.recover(0, "failed");
    expect(h.root().metadata).toMatchObject({ status: "loading", batchFailedCount: 1 });
    expect(h.source().metadata?.status).toBe("loading");
    await h.recover(1, "cancelled");
    expect(h.root().metadata).toMatchObject({ status: "error", batchFailedCount: 2 });
    expect(h.source().metadata).toMatchObject({ status: "error", errorDetails: "模型拒绝生成" });
    expect(h.failed()).toHaveLength(2);
    expect(h.submittedNodeIds).toHaveLength(2);
});

test("config acknowledgement recovery finishes only when the original result is durably applied", async () => {
    const h = await harness(["ack-after-result"], CanvasNodeType.Config);
    expect(h.source().metadata?.status).toBe("loading");
    await h.recover(0, "ack-before-result");
    expect(h.node(0).metadata).toMatchObject({ status: "loading", taskStatus: "succeeded", resourceReloadAvailable: true });
    expect(h.source().metadata?.status).toBe("loading");
    await h.recover(0);
    expect(h.source().metadata).toMatchObject({ status: "success", errorDetails: undefined });
    expect(h.submittedNodeIds).toHaveLength(1);
});

test("config recovery uses its recorded output identity and leaves legacy sources unassigned", () => {
    const fixture = (id: string, metadata: CanvasNodeData["metadata"], type: CanvasNodeData["type"] = CanvasNodeType.Image): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 320, height: 240, metadata });
    const source = fixture("source", { status: "loading", errorDetails: "待同步", imageGenerationRootId: "latest" }, CanvasNodeType.Config);
    const old = fixture("old", { status: "error", generationType: "generation", isBatchRoot: true, batchChildIds: ["old-child"] });
    const oldChild = fixture("old-child", { status: "error", batchRootId: "old", errorDetails: "旧任务失败" });
    const latest = fixture("latest", { status: "loading", generationType: "generation", isBatchRoot: true, batchChildIds: ["latest-child", "old-child"] });
    const child = fixture("latest-child", { status: "loading", batchRootId: "latest", taskStatus: "running" });
    let nodes = [source, old, oldChild, latest, child];
    expect(imageGenerationTargetsForSource(source, nodes).map((node) => node.id)).toEqual([child.id]);
    expect(reconcileImageGenerationNodes(nodes)[0].metadata?.status).toBe("loading");
    nodes = nodes.map((node) => (node.id === child.id ? { ...node, metadata: { ...node.metadata, status: "success", taskStatus: "succeeded", content: "/latest.png" } } : node));
    expect(reconcileImageGenerationNodes(nodes)[0].metadata).toMatchObject({ status: "success", errorDetails: undefined });
    const legacy = { ...source, metadata: { ...source.metadata, imageGenerationRootId: undefined } };
    expect(imageGenerationTargetsForSource(legacy, nodes)).toEqual([]);
    expect(reconcileImageGenerationNodes([legacy, ...nodes.slice(1)])[0]).toEqual(legacy);
    expect(
        imageGenerationTargetsForSource(
            source,
            nodes.filter((node) => node.id !== latest.id),
        ),
    ).toEqual([]);
});

test("deleting output edges or reconnecting a successful sibling cannot finish the pending batch early", async () => {
    const h = await harness(["succeeded", "running-disconnected"], CanvasNodeType.Config);
    h.replaceConnections([{ id: "manual-edge", fromNodeId: h.source().id, toNodeId: h.node(0).id }]);
    await h.recover(0);
    expect(h.source().metadata).toMatchObject({ status: "loading", imageGenerationRootId: h.root().id });
    h.replaceConnections([]);
    await h.recover(1);
    expect(h.source().metadata).toMatchObject({ status: "success", imageGenerationRootId: h.root().id });
});

test("single image polling interruption preserves the existing task and pending status", async () => {
    const h = await harness(["queued-disconnected"]);
    expect(h.node(0).metadata).toMatchObject({ status: "loading", taskStatus: "queued", taskId: "task-0" });
    expect(h.node(0).metadata?.errorDetails).toContain("同步");
});

test("durable acknowledgement failure preserves the applied image and its recovery diagnostic", async () => {
    const h = await harness(["succeeded", "ack-after-result"]);
    expect(h.node(1).metadata).toMatchObject({ status: "success", taskStatus: "succeeded", content: "/result/task-1.png", storageKey: "resource:task-1", resourceReloadAvailable: true, errorDetails: "结果已生成，应用结果失败：Network Error" });
    expect(h.root().metadata?.batchFailedCount).toBe(0);
    expect(h.failed()).toHaveLength(0);
    expect(h.messages.join(" ")).not.toContain("图片生成失败");
});

test("single image completion preserves its successful result when acknowledgement fails", async () => {
    const h = await harness(["ack-after-result"]);
    expect(h.root().metadata).toMatchObject({ status: "success", taskId: "task-0", content: "/result/task-0.png", errorDetails: "结果已生成，应用结果失败：Network Error" });
    expect(h.messages.join(" ")).toContain("待同步");
});

test("successful tasks awaiting result delivery remain recoverable without a paid retry", async () => {
    const h = await harness(["ack-before-result", "ack-before-result"]);
    expect(h.node(0).metadata).toMatchObject({ status: "loading", taskId: "task-0", taskStatus: "succeeded", resourceReloadAvailable: true });
    expect(h.node(0).metadata?.errorDetails).toContain("结果已生成");
    expect(h.root().metadata?.status).toBe("loading");
    expect(h.root().metadata?.batchFailedCount).toBe(0);
    expect(h.failed()).toHaveLength(0);
    await h.recover(0);
    expect(h.submittedNodeIds).toHaveLength(2);
    expect(h.node(0).metadata).toMatchObject({ status: "success", taskId: "task-0" });
});

test("real terminal and submission failures remain individually retryable alongside successful images", async () => {
    const h = await harness(["succeeded", "failed", "cancelled", "submission-failed"]);
    expect(h.node(0).metadata).toMatchObject({ status: "success", content: "/result/task-0.png" });
    expect(h.node(1).metadata).toMatchObject({ status: "error", taskStatus: "failed" });
    expect(h.node(2).metadata).toMatchObject({ status: "error", taskStatus: "cancelled" });
    expect(h.node(3).metadata).toMatchObject({ status: "error", errorDetails: "提交失败" });
    expect(h.root().metadata?.batchFailedCount).toBe(3);
    expect(h.failed()).toHaveLength(3);
    expect(h.messages).toContain("部分图片生成失败");
});

test("an actually failed task alongside a pending task must not be reported as all images failed", async () => {
    const h = await harness(["failed", "running-disconnected"], CanvasNodeType.Config);
    expect(h.root().metadata).toMatchObject({ status: "loading", batchFailedCount: 1 });
    expect(h.failed()).toHaveLength(1);
    expect(h.messages.join(" ")).not.toContain("全部图片生成失败");
    await h.recover(1);
    expect(h.root().metadata).toMatchObject({ status: "success", batchFailedCount: 1 });
    expect(h.source().metadata).toMatchObject({ status: "success", errorDetails: "部分图片生成失败" });
    expect(h.failed()).toHaveLength(1);
});

test("a batch whose every item really failed still reports all images failed", async () => {
    const h = await harness(["submission-failed", "failed", "cancelled"]);
    expect(h.root().metadata).toMatchObject({ status: "error", batchFailedCount: 3 });
    expect(h.failed()).toHaveLength(3);
    expect(h.messages).toEqual(["全部图片生成失败"]);
});
