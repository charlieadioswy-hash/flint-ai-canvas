import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import type { AiConfig } from "../src/stores/use-config-store";
import type { CreateTaskInput, GenerationTask } from "../src/services/api/task-center";

// Module and store spies stay in a child process, including when the whole suite runs.
if (process.env.IRREGULAR_SCREEN_GENERATION_TEST_CHILD !== "1") {
    test("irregular screen generation preserves submission and recovery contracts", async () => {
        const child = Bun.spawn([process.execPath, "test", import.meta.path], {
            cwd: new URL("..", import.meta.url).pathname,
            env: { ...process.env, IRREGULAR_SCREEN_GENERATION_TEST_CHILD: "1" },
            stdout: "pipe", stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    }, 30_000);
} else {
    const [{ useCanvasStore }, { useAssetStore }, sync, { http, ApiError }, configModule, domain, model, capabilities] = await Promise.all([
        import("../src/stores/canvas/use-canvas-store"),
        import("../src/stores/use-asset-store"),
        import("../src/services/user-data-sync"),
        import("../src/services/api/request"),
        import("../src/stores/use-config-store"),
        import("../src/lib/canvas/irregular-screen-domain"),
        import("../src/lib/canvas/irregular-screen-model"),
        import("../src/lib/model-capabilities"),
    ]);
    const localValues = new Map<string, string>();
    Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), {
        localStorage: { getItem: (key: string) => localValues.get(key) ?? null, setItem: (key: string, value: string) => localValues.set(key, value), removeItem: (key: string) => localValues.delete(key) },
        location: { pathname: "/screen-creation" },
    }) });

    let project: CanvasProject;
    let config: AiConfig;
    let nodeId: string;
    let submitted: CreateTaskInput[];
    let saved: CanvasProject[];
    let postError: Error | undefined;
    let saveErrorAt: number | undefined;
    let polledTask: GenerationTask;
    const canvasState = useCanvasStore.getState();
    const assetState = useAssetStore.getState();
    spyOn(useCanvasStore, "getState").mockImplementation(() => ({
        ...canvasState,
        projects: [project],
        openProject: (id) => id === project.id ? project : undefined,
        updateProject: (id, changes) => { if (id === project.id) project = { ...project, ...changes }; },
    }));
    spyOn(useAssetStore, "getState").mockImplementation(() => ({ ...assetState, assets: [] }));
    spyOn(sync, "saveRemoteUserDataNow").mockImplementation(async () => {
        saved.push(structuredClone(project));
        if (saved.length === saveErrorAt) throw new Error("canvas save failed");
    });
    spyOn(http, "post").mockImplementation(async (url, input) => {
        if (url !== "/tasks") throw new Error(`Unexpected POST ${url}`);
        submitted.push(structuredClone(input as CreateTaskInput));
        if (postError) throw postError;
        const metadata = submitted.at(-1)!.input!.metadata as { clientOperationId: string; nodeId: string };
        return { ...task("queued"), clientOperationId: metadata.clientOperationId, clientContext: { nodeId: metadata.nodeId } } as never;
    });
    spyOn(http, "get").mockImplementation(async (url) => {
        if (url !== "/tasks/screen-task") throw new Error(`Unexpected GET ${url}`);
        return polledTask as never;
    });
    const { submitScreenGeneration, recoverScreenGeneration } = await import("../src/services/irregular-screen-generation");

    function task(status: GenerationTask["status"]): GenerationTask {
        return { id: "screen-task", projectId: "screen-canvas", type: "canvas_image", status, stage: status, prompt: "A colorful landscape", attempts: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
    }

    function setup(contentReference = false) {
        const channelId = "screen-channel";
        const modelKey = "0ea388c7eb854be3ba3c6f65aac6bfd3";
        const modelName = configModule.encodeChannelModel(channelId, modelKey);
        const profile = capabilities.defaultImageCapabilityConfig("liblib-image");
        const channel = configModule.createModelChannel({
            id: channelId, name: "Screen", scope: "system", apiKey: "system", baseUrl: "https://provider.example", interfaceType: "liblib-image", models: [modelKey],
            modelCosts: [{ model: modelKey, protocol: "liblib-image", capability: "image", available: true, billingMode: "fixed_request", unitPriceMicrocredits: 1,
                defaultOptions: { family: "sd", controlNetModel: "b6806516962f4e1599a93ac4483c3d23", textToImageTemplateUuid: "e10adc3949ba59abbe56e057f20f883e", imageToImageTemplateUuid: "9c7d531dc75f476aa833b3d452b8f7ad" },
                capabilityConfig: { version: 1, image: { ...profile, controlNet: { supported: true, maxUnits: 1, preprocessors: ["canny"], models: ["b6806516962f4e1599a93ac4483c3d23"] } } },
            }],
        });
        config = { ...configModule.defaultConfig, channels: [channel], model: modelName, imageModel: modelName, size: "1024x1024", count: "1" };
        const settings = model.screenDefaultSettings(config, modelName);
        const template = domain.buildIrregularScreenTemplate({
            controlImage: { storageKey: "resource:control", width: 1024, height: 1024 },
            outputMask: { storageKey: "resource:mask", width: 1024, height: 1024 },
            contentReference: contentReference ? { storageKey: "resource:content", width: 1024, height: 1024 } : undefined,
            prompt: "A colorful landscape", modelSelection: { kind: "channel", channelId, modelKey },
            size: "1024x1024", maskMode: "color", controlParameters: model.screenControlParameters(settings),
            providerOptions: model.screenProviderOptions(config, modelName, settings, contentReference),
        });
        nodeId = template.generationNodeId;
        project = { id: "screen-canvas", title: "Screen", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...template };
    }

    function node() { return project.nodes.find((item) => item.id === nodeId)!; }
    function assertRetryable() {
        expect(node().metadata?.status).toBe("error");
        expect(node().metadata?.taskId).toBeUndefined();
        expect(node().metadata?.taskClientOperationId).toBeUndefined();
        expect(node().metadata?.taskStage).toBeUndefined();
    }

    beforeEach(() => {
        submitted = [];
        saved = [];
        postError = undefined;
        saveErrorAt = undefined;
        polledTask = task("queued");
        setup();
    });

    describe("real generation preparation", () => {
        for (const withContent of [false, true]) test(`keeps control/mask separate and chooses ${withContent ? "img2img" : "txt2img"} defaults`, async () => {
            setup(withContent);
            await submitScreenGeneration(project, config);
            expect(submitted).toHaveLength(1);
            const input = submitted[0].input!;
            expect(input.referenceImages).toMatchObject(withContent ? [{ storageKey: "resource:content" }] : []);
            expect(input.referenceImages).toHaveLength(Number(withContent));
            expect(input.controlNet).toMatchObject([{ image: { storageKey: "resource:control" }, parameters: { model: "b6806516962f4e1599a93ac4483c3d23", preprocessor: "canny" } }]);
            expect(input.outputMask).toMatchObject({ image: { storageKey: "resource:mask" }, mode: "luminance", resizeMode: "stretch" });
            expect(input.metadata).toMatchObject({ nodeId, providerOptions: { "liblib-image": { family: "sd", templateUuid: withContent ? "9c7d531dc75f476aa833b3d452b8f7ad" : "e10adc3949ba59abbe56e057f20f883e" } } });
            expect(node().metadata?.taskId).toBe("screen-task");
        });

        test("rejects unexpected ordinary canvas input before persisting pending state", async () => {
            const extra = { ...project.nodes[0], id: "extra-content" };
            project.nodes.push(extra);
            project.connections.push({ id: "extra-connection", fromNodeId: extra.id, toNodeId: nodeId });
            await expect(submitScreenGeneration(project, config)).rejects.toThrow("其他内容参考输入");
            expect(submitted).toHaveLength(0);
            expect(saved).toHaveLength(0);
            expect(node().metadata?.status).not.toBe("loading");
        });

        test("regeneration retains the previous result without inheriting its persistence stamp", async () => {
            const previous = node();
            const effectKeys = [`attach:previous-task:node:${nodeId}:0`];
            previous.metadata = {
                ...previous.metadata,
                status: "success", taskId: "previous-task", taskStatus: "succeeded",
                content: "/previous.png", storageKey: "resource:previous-result", assetId: "previous-asset",
                generationEffectKeys: effectKeys,
            };

            await submitScreenGeneration(project, config);

            const retained = saved[0].nodes.find((item) => item.id !== nodeId && item.metadata?.taskId === "previous-task");
            expect(retained).toBeDefined();
            expect(retained?.metadata).toMatchObject({ status: "success", content: "/previous.png", storageKey: "resource:previous-result", assetId: "previous-asset" });
            expect(retained?.metadata?.generationEffectKeys).toBeUndefined();
            expect(previous.metadata.generationEffectKeys).toEqual(effectKeys);
            expect(node().metadata?.generationEffectKeys).toEqual(effectKeys);
            expect(node().metadata?.taskId).toBe("screen-task");
        });
    });

    describe("submission failure identity", () => {
        for (const failure of ["save", "validation", 422, 429] as const) test(`regeneration preserves the previous result after ${failure} rejection and retry`, async () => {
            node().metadata = {
                ...node().metadata,
                status: "success", taskId: "previous-task", taskStatus: "succeeded",
                content: "/previous.png", storageKey: "resource:previous-result", assetId: "previous-asset",
                generationEffectKeys: [`attach:previous-task:node:${nodeId}:0`],
            };
            if (failure === "save") saveErrorAt = 1;
            else if (failure === "validation") config.channels[0].modelCosts![0].capabilityConfig!.image!.controlNet!.supported = false;
            else postError = new ApiError("generation rejected", { status: failure });

            await expect(submitScreenGeneration(project, config)).rejects.toThrow();
            assertRetryable();
            expect(submitted).toHaveLength(typeof failure === "number" ? 1 : 0);

            // Reopen the saved scene, then retry: the completed image must remain
            // independently addressable while the generation node is reused.
            project = structuredClone(saved.at(-1)!);
            const previousResults = project.nodes.filter((item) => item.metadata?.taskId === "previous-task");
            expect(previousResults).toHaveLength(1);
            const previousResult = previousResults[0];
            expect(previousResult.id).not.toBe(nodeId);
            expect(previousResult.metadata).toMatchObject({ status: "success", content: "/previous.png", storageKey: "resource:previous-result", assetId: "previous-asset" });
            expect(previousResult.metadata?.generationEffectKeys).toBeUndefined();

            saveErrorAt = undefined;
            postError = undefined;
            config.channels[0].modelCosts![0].capabilityConfig!.image!.controlNet!.supported = true;
            await submitScreenGeneration(project, config);
            expect(node().metadata?.taskId).toBe("screen-task");
            expect(saved.at(-1)!.nodes.filter((item) => item.metadata?.taskId === "previous-task")).toEqual([previousResult]);
        });

        test("a save failure before dispatch restores retryable state", async () => {
            saveErrorAt = 1;
            await expect(submitScreenGeneration(project, config)).rejects.toThrow("canvas save failed");
            expect(submitted).toHaveLength(0);
            assertRetryable();
            expect(saved.at(-1)!.nodes.find((item) => item.id === nodeId)?.metadata?.status).toBe("error");
        });

        test("local provider capability validation after pending save restores retryable state", async () => {
            config.channels[0].modelCosts![0].capabilityConfig!.image!.controlNet!.supported = false;
            await expect(submitScreenGeneration(project, config)).rejects.toThrow();
            expect(submitted).toHaveLength(0);
            expect(saved).toHaveLength(2);
            assertRetryable();
        });

        test("an explicit HTTP rejection restores retryable state and allows resubmission", async () => {
            postError = new ApiError("invalid model", { status: 422, reason: "model_capability_not_supported" });
            await expect(submitScreenGeneration(project, config)).rejects.toThrow("invalid model");
            expect(submitted).toHaveLength(1);
            assertRetryable();
            postError = undefined;
            await submitScreenGeneration(project, config);
            expect(submitted).toHaveLength(2);
            expect(node().metadata?.taskId).toBe("screen-task");
        });

        test("unknown transport outcome retains operation identity and blocks duplicate dispatch", async () => {
            postError = new ApiError("connection reset", { retryable: true });
            await expect(submitScreenGeneration(project, config)).rejects.toThrow("connection reset");
            const operationId = (submitted[0].input!.metadata as { clientOperationId: string }).clientOperationId;
            expect(operationId).not.toBe("");
            expect(node().metadata).toMatchObject({ status: "loading", taskStage: "submission_unconfirmed", taskClientOperationId: operationId });
            expect(node().metadata?.taskId).toBeUndefined();
            await expect(submitScreenGeneration(project, config)).rejects.toThrow("当前任务尚未完成");
            expect(submitted).toHaveLength(1);
        });

        test("save failure after acceptance retains the accepted task identity", async () => {
            saveErrorAt = 2;
            await expect(submitScreenGeneration(project, config)).rejects.toThrow("canvas save failed");
            expect(submitted).toHaveLength(1);
            expect(node().metadata).toMatchObject({ status: "loading", taskId: "screen-task", taskStatus: "queued" });
            expect(node().metadata?.taskStage).not.toBe("submission_unconfirmed");
            await expect(submitScreenGeneration(project, config)).rejects.toThrow("当前任务尚未完成");
            expect(submitted).toHaveLength(1);
        });
    });

    test("real task polling persists failed terminal state before throwing", async () => {
        await submitScreenGeneration(project, config);
        polledTask = { ...task("failed"), error: "provider failed" };
        const updates: GenerationTask[] = [];
        await expect(recoverScreenGeneration(project.id, new AbortController().signal, (value) => updates.push(value))).rejects.toThrow("provider failed");
        expect(updates.map((value) => value.status)).toEqual(["failed"]);
        expect(node().metadata).toMatchObject({ status: "error", taskId: "screen-task", taskStatus: "failed", errorDetails: "provider failed" });
        expect(saved.at(-1)!.nodes.find((item) => item.id === nodeId)?.metadata?.status).toBe("error");
    });
}
