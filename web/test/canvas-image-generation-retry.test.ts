import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import * as generationProject from "../src/lib/canvas/canvas-project-generation";
import * as configStore from "../src/stores/use-config-store";
import { canvasTaskBindingStatus } from "../src/lib/canvas/canvas-task-state";
import { restoreUnsubmittedImageBatchChild } from "../src/lib/canvas/canvas-image-batch-retry";
import { defaultImageCapabilityConfig } from "../src/lib/model-capabilities";
import { CanvasGenerationDurableAckError } from "../src/services/canvas-generation-consumer";
import type { GenerationTask } from "../src/services/api/task-center";
import type { CanvasNodeData } from "../src/types/canvas";

const build = await Bun.build({
    entrypoints: [new URL("../src/pages/canvas/use-canvas-generation-retry.ts", import.meta.url).pathname],
    target: "node",
    format: "cjs",
    external: ["*"],
});
if (!build.success) throw new Error(build.logs.map(String).join("\n"));
const source = await build.outputs[0].text();
const require = createRequire(import.meta.url);

async function retryOriginal(status: GenerationTask["status"], options: { disconnect?: boolean; newDisconnect?: boolean; ackFailure?: "before" | "after"; terminalStatus?: "failed" | "cancelled" } = {}) {
    const channel = configStore.createModelChannel({
        id: "fixture",
        name: "fixture",
        baseUrl: "https://provider.example",
        apiKey: "fixture",
        interfaceType: "openai-images",
        models: ["image-model"],
        modelCosts: [{ model: "image-model", capability: "image", protocol: "openai-images", billingMode: "fixed_request", unitPriceMicrocredits: 1, capabilityConfig: { version: 1, image: defaultImageCapabilityConfig() } }],
    });
    const model = configStore.encodeChannelModel(channel.id, "image-model");
    const config = { ...configStore.defaultConfig, channels: [channel], model, imageModel: model };
    const node: CanvasNodeData = {
        id: "image",
        type: "image",
        title: "fixture",
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        metadata: { status: "error", errorDetails: "网络异常。", taskId: "original-task", taskStatus: status, generationType: "generation", model, prompt: "fixture" },
    };
    const nodesRef = { current: [node] };
    const task: GenerationTask = { id: "original-task", status, type: "canvas_image", prompt: "fixture", attempts: 1, createdAt: "", updatedAt: "" };
    const waited: string[] = [];
    const consumed: string[] = [];
    const submitted: string[] = [];
    const queried: string[] = [];
    const messages: string[] = [];
    const setNodes = (value: CanvasNodeData[] | ((current: CanvasNodeData[]) => CanvasNodeData[])) => {
        nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value;
    };
    const bind = (id: string, next: GenerationTask) =>
        setNodes((current) => current.map((item) => (item.id === id ? { ...item, metadata: { ...item.metadata, ...generationProject.generationTaskMetadata(next), status: canvasTaskBindingStatus(item, next) } } : item)));
    const consume = async (id: string, next: GenerationTask) => {
        consumed.push(next.id);
        setNodes((current) =>
            current.map((item) =>
                item.id === id
                    ? {
                          ...item,
                          metadata: {
                              ...item.metadata,
                              status: options.ackFailure === "before" ? "error" : "success",
                              content: options.ackFailure === "before" ? undefined : `/result/${next.id}`,
                              errorDetails: options.ackFailure ? "结果已生成，应用结果失败：Network Error" : undefined,
                          },
                      }
                    : item,
            ),
        );
        if (options.ackFailure) throw new CanvasGenerationDurableAckError(new Error("Network Error"));
    };
    const api = {
        queryGenerationTask: async (id: string) => {
            queried.push(id);
            return task;
        },
        waitForGenerationTask: async (id: string, waitOptions: { onTaskUpdate?: (task: GenerationTask) => void }) => {
            waited.push(id);
            if (options.disconnect) throw new Error("Network Error");
            const completed = { ...task, status: options.terminalStatus || ("succeeded" as const) };
            waitOptions.onTaskUpdate?.(completed);
            if (completed.status === "failed" || completed.status === "cancelled") throw new Error("模型任务已失败或取消");
            return completed;
        },
    };
    const module = { exports: {} as { useCanvasGenerationRetry: (options: unknown) => (node: CanvasNodeData) => Promise<void> } };
    runInNewContext(source, {
        module,
        exports: module.exports,
        console,
        Error,
        DOMException,
        AbortController,
        structuredClone,
        require(name: string) {
            if (name === "react") return { useCallback: (fn: unknown) => fn };
            if (name === "antd") return { App: { useApp: () => ({ message: { error: (text: string) => messages.push(text), warning: (text: string) => messages.push(text), info: (text: string) => messages.push(text) } }) } };
            if (name === "@/services/api/task-center") return api;
            if (name === "@/stores/use-config-store") return { ...configStore, useEffectiveConfig: () => config, useConfigStore: (selector: (state: unknown) => unknown) => selector({ isAiConfigReady: () => true }) };
            if (name === "@/lib/canvas/canvas-project-generation")
                return {
                    ...generationProject,
                    runCanvasGenerationTaskToConsumer: async (input: { nodeId: string }, dependencies: { bindTask: (task: GenerationTask) => void; consumeTask: (task: GenerationTask) => Promise<void> }) => {
                        submitted.push(input.nodeId);
                        const next = { ...task, id: "new-paid-task", status: options.newDisconnect ? ("running" as const) : ("succeeded" as const) };
                        dependencies.bindTask(next);
                        if (options.newDisconnect) throw new Error("Network Error");
                        await dependencies.consumeTask(next);
                    },
                };
            return require(name.startsWith("@/") ? new URL(`../src/${name.slice(2)}`, import.meta.url).pathname : name);
        },
    });
    const retry = module.exports.useCanvasGenerationRetry({
        projectId: "fixture",
        addedSkills: [],
        assets: [],
        nodesRef,
        connectionsRef: { current: [] },
        setNodes,
        setRunningNodeId() {},
        startGenerationRequest: () => new AbortController(),
        finishGenerationRequest() {},
        bindGenerationTask: bind,
        applyGenerationTaskResult: consume,
    });
    await retry(node);
    return { node: nodesRef.current[0], original: node, waited, consumed, submitted, queried, messages };
}

for (const status of ["queued", "running", "succeeded"] as const) {
    test(`retrying an old erroneous ${status} image reuses the original task without another paid request`, async () => {
        const h = await retryOriginal(status);
        expect(h.queried).toEqual(["original-task"]);
        expect(h.submitted).toEqual([]);
        expect(h.consumed).toEqual(["original-task"]);
        expect(h.node.metadata).toMatchObject({ status: "success", taskId: "original-task" });
        expect(h.waited).toEqual(status === "succeeded" ? [] : ["original-task"]);
    });
}

test("a repeated synchronization interruption keeps the existing task pending", async () => {
    const h = await retryOriginal("running", { disconnect: true });
    expect(h.submitted).toEqual([]);
    expect(h.node.metadata).toMatchObject({ status: "loading", taskId: "original-task", taskStatus: "running" });
    expect(h.node.metadata?.errorDetails).toContain("同步");
    expect(h.consumed).toEqual([]);
    expect(restoreUnsubmittedImageBatchChild(h.node, h.original).metadata?.status).toBe("loading");
});

for (const phase of ["before", "after"] as const) {
    test(`recovering a successful task retains its identity when durable acknowledgement fails ${phase} applying its result`, async () => {
        const h = await retryOriginal("succeeded", { ackFailure: phase });
        expect(h.submitted).toEqual([]);
        expect(h.node.metadata).toMatchObject({ status: phase === "before" ? "loading" : "success", taskId: "original-task", resourceReloadAvailable: true });
        expect(h.node.metadata?.errorDetails).toContain("结果已生成");
        if (phase === "after") expect(h.node.metadata?.content).toBe("/result/original-task");
    });
}

for (const status of ["failed", "cancelled"] as const) {
    test(`a resumed running task that becomes ${status} stays a real failure without another submission`, async () => {
        const h = await retryOriginal("running", { terminalStatus: status });
        expect(h.submitted).toEqual([]);
        expect(h.consumed).toEqual([]);
        expect(h.node.metadata).toMatchObject({ status: "error", taskStatus: status, taskId: "original-task" });
    });
}

test("a new retry whose submitted task disconnects remains pending for the same recovery path", async () => {
    const h = await retryOriginal("failed", { newDisconnect: true });
    expect(h.submitted).toEqual(["image"]);
    expect(h.node.metadata).toMatchObject({ status: "loading", taskId: "new-paid-task", taskStatus: "running" });
    expect(restoreUnsubmittedImageBatchChild(h.node, h.original).metadata?.status).toBe("loading");
});

for (const status of ["failed", "cancelled"] as const) {
    test(`confirmed ${status} tasks still permit a new generation request`, async () => {
        const h = await retryOriginal(status);
        expect(h.submitted).toEqual(["image"]);
        expect(h.consumed).toEqual(["new-paid-task"]);
    });
}
