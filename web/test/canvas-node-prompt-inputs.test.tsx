import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

import * as generationContract from "../src/lib/canvas/generation-contract";
import * as resourceReferences from "../src/lib/canvas/canvas-resource-references";
import * as modelSelection from "../src/lib/model-selection";
import * as modelPricing from "../src/lib/model-pricing";
import * as modelCapabilities from "../src/lib/model-capabilities";
import * as configStore from "../src/stores/use-config-store";
import * as promptConfig from "../src/components/canvas/canvas-node-prompt-config";
import * as promptResize from "../src/components/canvas/canvas-node-prompt-resize";
import * as controlnet from "../src/lib/canvas/controlnet";
import { canvasThemes } from "../src/lib/canvas-theme";
import { buildNodeGenerationContext } from "../src/components/canvas/canvas-node-generation";
import * as projectGeneration from "../src/lib/canvas/canvas-project-generation";
import { buildVideoGenerationMetadata } from "../src/lib/canvas/canvas-project-generation";
import * as styleExecution from "../src/lib/canvas/canvas-style-execution";
import * as loraQuote from "../src/lib/canvas/liblib-lora-quote";
import { executeImageGeneration } from "../src/pages/canvas/canvas-image-generation-executor";
import { resolveVideoImageReferences } from "../src/services/api/video-reference-roles";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "../src/types/canvas";
import type { Asset } from "../src/stores/use-asset-store";
import type { LogicalModelQuote, ModelQuoteRequest } from "../src/services/api/logical-models";

// Run the real panel, configuration, capability and quote builders. Replace
// React/UI boundaries and the quote transport; no API or generation is invoked.
const build = await Bun.build({ entrypoints: [new URL("../src/components/canvas/canvas-node-prompt-panel.tsx", import.meta.url).pathname], target: "node", format: "cjs", external: ["*"] });
if (!build.success) throw new Error(build.logs.map(String).join("\n"));
const source = await build.outputs[0].text();
const quoteBuild = await Bun.build({ entrypoints: [new URL("../src/components/canvas/use-canvas-model-quote.ts", import.meta.url).pathname], target: "node", format: "cjs", external: ["*"] });
if (!quoteBuild.success) throw new Error(quoteBuild.logs.map(String).join("\n"));
const quoteSource = await quoteBuild.outputs[0].text();
type Element = { type: string; props: Record<string, any> };

function imageAsset(): Asset {
    return { id: "robot-asset", title: "QA-robot-front.png", kind: "image", category: "material", status: "confirmed", coverUrl: "", tags: [], createdAt: "", updatedAt: "", data: { dataUrl: "data:image/png;base64,AA==", storageKey: "resource:robot-image", mimeType: "image/png", width: 512, height: 512, bytes: 1 } };
}

function videoConfig() {
    const model = "minimax-hailuo-02";
    const capabilityConfig = modelCapabilities.defaultModelCapabilityConfig("newapi-channel-2", model);
    capabilityConfig.video!.operations = ["image_to_video"];
    capabilityConfig.video!.references.maxImages = 2;
    capabilityConfig.video!.resolutions = ["512P"];
    capabilityConfig.video!.defaultResolution = "512P";
    capabilityConfig.video!.duration = { selection: "enum", values: [6], default: 6 };
    const channel = configStore.createModelChannel({ id: "system-hailuo", name: "Hailuo 512", scope: "system", apiFormat: "openai", interfaceType: "newapi-channel-2", baseUrl: "/api/system-channel", apiKey: "system", models: [model], modelCosts: [{ model, capability: "video", protocol: "newapi-channel-2", billingMode: "per_second", unitPriceMicrocredits: 1_000_000, capabilityConfig }] });
    return { ...configStore.defaultConfig, channels: [channel], model: `${channel.id}::${model}`, videoModel: `${channel.id}::${model}`, videoModels: [`${channel.id}::${model}`], models: [`${channel.id}::${model}`], size: "16:9", vquality: "512P", videoSeconds: "6", taskWorkflowProvider: "model" as const };
}

function imageConfig(logical = false, count = "4") {
    const config = videoConfig();
    const model = "liblib-image-model";
    const image = { ...modelCapabilities.defaultImageCapabilityConfig("liblib-image"), maxOutputs: 4 };
    const channel = configStore.createModelChannel({ id: "image-channel", name: "Image", scope: "system", interfaceType: "liblib-image", baseUrl: "/api/system-channel", apiKey: "system", models: [model], modelCosts: [{ model, capability: "image", protocol: "liblib-image", billingMode: "fixed_request", unitPriceMicrocredits: 250_000, ...(logical ? { logicalModelId: "logical-image" } : {}), capabilityConfig: { version: 1, image } }] });
    return { ...config, channels: [channel], model: `${channel.id}::${model}`, imageModel: `${channel.id}::${model}`, models: [`${channel.id}::${model}`], imageModels: [`${channel.id}::${model}`], count };
}

function descendants(value: any): Element[] {
    if (Array.isArray(value)) return value.flatMap(descendants);
    if (!value || typeof value !== "object" || !value.props) return [];
    return [value, ...descendants(value.props.children)];
}

function harness(library: Asset[], prompt = "让 @[asset:robot-asset] 转身", connected = false, config = videoConfig()) {
    const imageMode = config.channels[0].modelCosts?.[0].capability === "image";
    let target: CanvasNodeData = { id: "target", type: imageMode ? CanvasNodeType.Image : CanvasNodeType.Video, title: "Generation", position: { x: 0, y: 0 }, width: 400, height: 300, metadata: { prompt, composerContent: prompt, model: config.model, vquality: "512P", seconds: "6", ...(imageMode ? { count: Number(config.count) } : {}) } };
    const image: CanvasNodeData = { id: "connected-image", type: CanvasNodeType.Image, title: "Robot", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { assetId: "robot-asset", content: "data:image/png;base64,AA==", storageKey: "resource:robot-image" } };
    const connections: CanvasConnection[] = connected ? [{ id: "edge", fromNodeId: image.id, toNodeId: target.id }] : [];
    const nodes = () => connected ? [image, target] : [target];
    const resolutions: { nodeId: string; prompt: string }[] = [];
    const resolveContext = (nodeId: string, text: string) => {
        resolutions.push({ nodeId, prompt: text });
        return buildNodeGenerationContext(nodeId, nodes(), connections, text, library, true);
    };
    let resolveGenerationContext = resolveContext;
    let persistPromptChanges = true;
    let tree: Element;
    let cursor = 0;
    let dirty = false;
    const cells: any[] = [];
    let effects: (() => void)[] = [];
    let quoteRequest: ReturnType<typeof modelPricing.modelQuoteRequest>;
    const quoteCalls: Array<{ request: ModelQuoteRequest; signal?: AbortSignal; resolve(value: { quote: LogicalModelQuote }): void; reject(error: Error): void }> = [];
    const patches: Partial<CanvasNodeMetadata>[] = [];
    const noop = () => {};
    const changed = (before: unknown[] | undefined, next: unknown[] | undefined) => !before || !next || before.length !== next.length || before.some((value, index) => !Object.is(value, next[index]));
    const hooks = {
        useState(initial: any) {
            const index = cursor++;
            if (!(index in cells)) cells[index] = typeof initial === "function" ? initial() : initial;
            return [cells[index], (next: any) => {
                const value = typeof next === "function" ? next(cells[index]) : next;
                if (!Object.is(value, cells[index])) { cells[index] = value; dirty = true; }
            }];
        },
        useRef(initial: any) { const index = cursor++; return cells[index] ||= { current: initial }; },
        useMemo(factory: () => any, deps: unknown[]) {
            const index = cursor++;
            if (!cells[index] || changed(cells[index].deps, deps)) cells[index] = { deps, value: factory() };
            return cells[index].value;
        },
        useEffect(effect: () => void, deps: unknown[]) {
            const index = cursor++;
            if (!cells[index] || changed(cells[index].deps, deps)) {
                const cleanup = cells[index]?.cleanup;
                cells[index] = { deps };
                effects.push(() => { cleanup?.(); cells[index].cleanup = effect(); });
            }
        },
    };
    const quoteModule = { exports: {} as { useCanvasModelQuote: typeof import("../src/components/canvas/use-canvas-model-quote").useCanvasModelQuote } };
    runInNewContext(quoteSource, { module: quoteModule, exports: quoteModule.exports, AbortController, require: (name: string) => name === "react" ? hooks : {
        quoteModel: (request: ModelQuoteRequest, signal?: AbortSignal) => new Promise<{ quote: LogicalModelQuote }>((resolve, reject) => quoteCalls.push({ request, signal, resolve, reject })),
    } });
    const jsx = (type: string, props: Record<string, any>) => ({ type, props });
    const ui = new Proxy({}, { get: (_, name) => String(name) });
    const themeName = Object.keys(canvasThemes)[0];
    const modules: Record<string, any> = {
        react: { ...hooks, createElement: (type: string, props: any, ...children: any[]) => jsx(type, { ...props, children }), Fragment: "Fragment" },
        "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
        "react/jsx-dev-runtime": { jsxDEV: jsx, Fragment: "Fragment" },
        "@/stores/use-config-store": { ...configStore, useEffectiveConfig: () => config },
        "@/stores/use-asset-store": { useAssetStore: (selector: (state: { assets: Asset[] }) => unknown) => selector({ assets: library }) },
        "@/stores/use-user-store": { useUserStore: (selector: (state: unknown) => unknown) => selector({ features: { creditsEnabled: true } }) },
        "@/stores/use-plugin-store": { usePluginStore: (selector: (state: unknown) => unknown) => selector({ installations: [], pluginStates: {} }) },
        "@/stores/canvas/use-canvas-theme-store": { useActiveTheme: () => themeName },
        "@/stores/canvas/use-canvas-store": { useCanvasStore: () => undefined },
        "@/lib/canvas-theme": { canvasThemes },
        "@/lib/canvas/generation-contract": generationContract,
        "@/lib/canvas/canvas-resource-references": resourceReferences,
        "@/lib/canvas/controlnet": controlnet,
        "@/lib/canvas/canvas-project-generation": projectGeneration,
        "@/lib/canvas/canvas-style-execution": styleExecution,
        "@/lib/canvas/liblib-lora-quote": loraQuote,
        "@/lib/model-selection": modelSelection,
        "@/lib/model-capabilities": modelCapabilities,
        "@/lib/model-pricing": modelPricing,
        "@/constant/credits": { CreditSymbol: "CreditSymbol", requestCreditCost: modelPricing.requestCreditCost },
        "@/types/canvas": { CanvasNodeType },
        "./canvas-node-prompt-config": promptConfig,
        "./canvas-node-prompt-resize": promptResize,
        "./canvas-node-prompt-references": { ConnectedReferenceShelf: "ConnectedReferenceShelf", ReferenceToolsPopover: "ReferenceToolsPopover", referenceShelfHeading: () => "已连接素材" },
        "./use-resolved-canvas-resource-references": { useResolvedCanvasResourceReferences: (references: unknown) => references },
        "./use-canvas-model-quote": { useCanvasModelQuote: (request: typeof quoteRequest, enabled: boolean, taskCount?: number) => { quoteRequest = request; return quoteModule.exports.useCanvasModelQuote(request, enabled, taskCount); } },
        "@/lib/plugins/builtin/prompt-optimizer": { PROMPT_OPTIMIZER_PLUGIN_ID: "prompt-optimizer" },
    };
    const module = { exports: {} as { CanvasNodePromptPanel: (props: Record<string, any>) => Element } };
    runInNewContext(source, { module, exports: module.exports, require: (name: string) => modules[name] || ui, window: { innerWidth: 1440, innerHeight: 900 } });
    const onConfigChange = (_nodeId: string, patch: Partial<CanvasNodeMetadata>) => {
        patches.push(patch);
        target = { ...target, metadata: { ...target.metadata, ...patch } };
        dirty = true;
    };
    function render() {
        let renders = 0;
        do {
            if (++renders > 10) throw new Error("Panel did not settle after metadata normalization");
            cursor = 0;
            dirty = false;
            effects = [];
            tree = module.exports.CanvasNodePromptPanel({ projectId: "canvas", node: target, isRunning: false, mentionReferences: resourceReferences.buildCanvasNodeMentionReferenceMap(nodes(), connections).get(target.id), resolveGenerationContext, onPromptChange: (_nodeId: string, value: string) => {
                if (persistPromptChanges) target = { ...target, metadata: { ...target.metadata, prompt: value, composerContent: value } };
                dirty = true;
            }, onConfigChange, onGenerate: noop });
            effects.forEach((effect) => effect());
        } while (dirty);
    }
    render();
    const find = (type: string) => {
        const element = descendants(tree).find((item) => item.type === type);
        if (!element) throw new Error(`Missing ${type}`);
        return element;
    };
    return {
        patches,
        resolutions,
        quoteCalls,
        config,
        get node() { return target; },
        get quote() { return quoteRequest!; },
        context() { return resolveGenerationContext(target.id, target.metadata?.composerContent || ""); },
        requirements() { return find("ModelPicker").props.requirements as modelSelection.ModelRequirements; },
        generationConfig() { return find("ModelPicker").props.config as configStore.AiConfig; },
        compatibility() { const picker = find("ModelPicker").props; return modelSelection.modelCompatibilityError(picker.config, picker.value, picker.requirements); },
        frameOptions() { return descendants(tree).find((item) => item.type === "CanvasVideoPromptTools")?.props.frameOptions || []; },
        prompt() { return find("CanvasResourceMentionTextarea").props.value; },
        submitButton() { return descendants(tree).find((item) => item.type === "Button" && String(item.props.className).includes("canvas-node-composer-submit"))!.props; },
        changeCount(count: number) { find("CanvasImageCountControl").props.onChange(count); render(); },
        async resolveQuote(index: number, quote: LogicalModelQuote) { quoteCalls[index].resolve({ quote }); await Promise.resolve(); await Promise.resolve(); render(); },
        deferPromptPersistence() { persistPromptChanges = false; },
        switchNode(next: CanvasNodeData) { target = next; render(); },
        replaceAssets(next: Asset[]) { library = next; resolveGenerationContext = (nodeId, text) => resolveContext(nodeId, text); render(); },
        chooseFrames(patch: Partial<CanvasNodeMetadata>) { find("CanvasVideoPromptTools").props.onMetadataChange(patch); render(); },
        edit(value: string) { find("CanvasResourceMentionTextarea").props.onChange(value); render(); },
    };
}

test.each([false, true])("canvas image quote totals independent tasks without double-counting logical=%s", async (logical) => {
    const h = harness([], "画一只熊猫", false, imageConfig(logical));
    expect(h.quote.intent.options.count).toBe(1);
    expect(h.quote.logicalModelID).toBe(logical ? "logical-image" : undefined);
    expect(h.submitButton().disabled).toBe(true);
    const singleQuote: LogicalModelQuote = { logicalModelId: logical ? "logical-image" : "", billingMode: "fixed_request", quantity: 1, amountMicrocredits: 250_000, estimated: false };
    await h.resolveQuote(0, singleQuote);
    expect(h.submitButton()["aria-label"]).toBe("消耗 1 积分，生成");
    expect(h.submitButton().title).toBe("本次消耗 1 积分");
    expect(h.submitButton().disabled).toBe(false);

    const submitted: string[] = [];
    let nodes = [h.node];
    let connections: CanvasConnection[] = [];
    const controller = new AbortController();
    const noop = () => {};
    await executeImageGeneration({
        nodeId: h.node.id, sourceNode: h.node, canvasNodes: nodes, canvasConnections: connections,
        prompt: h.prompt(), effectivePrompt: h.prompt(), generationConfig: h.generationConfig(), generationContext: h.context(),
        controller, projectId: "", editingTextNode: false, styleMetadata: {}, skillMetadata: {},
        setNodes: (update) => { nodes = typeof update === "function" ? update(nodes) : update; },
        setConnections: (update) => { connections = typeof update === "function" ? update(connections) : update; },
        setSelectedNodeIds: noop, setSelectedConnectionId: noop, setDialogNodeId: noop,
        startGenerationRequest: () => controller, finishGenerationRequest: noop, registerPendingNodeIds: noop,
        showError: (message) => { throw new Error(message); }, bindGenerationTask: noop, applyGenerationTaskResult: async () => {},
    }, async (options) => {
        submitted.push(options.config.count);
        options.onTaskCreated?.({ id: `quoted-task-${submitted.length}`, type: "canvas_image", status: "succeeded", prompt: h.prompt(), attempts: 1, createdAt: "", updatedAt: "" });
        return { mode: "image", images: [] };
    });
    expect(submitted).toEqual(["1", "1", "1", "1"]);

    h.changeCount(2);
    expect(h.quote.intent.options.count).toBe(1);
    expect(h.quoteCalls[0].signal?.aborted).toBe(true);
    expect(h.submitButton().disabled).toBe(true);
    expect(h.submitButton()["aria-label"]).toBe("正在确认费用");
    await h.resolveQuote(1, singleQuote);
    expect(h.submitButton()["aria-label"]).toBe("消耗 0.5 积分，生成");
    expect(h.submitButton().title).toBe("本次消耗 0.5 积分");
});

test("canvas quote totals use the normalized model output limit", async () => {
    const h = harness([], "画一只熊猫", false, imageConfig(false, "99"));
    expect(h.generationConfig().count).toBe("4");
    await h.resolveQuote(0, { logicalModelId: "", billingMode: "fixed_request", quantity: 1, amountMicrocredits: 250_000, estimated: false });
    expect(h.submitButton()["aria-label"]).toBe("消耗 1 积分，生成");
});

test("an unconnected asset mention drives the real panel capability, quote and provider first-frame identity", () => {
    const h = harness([imageAsset()], "让 @[asset:robot-asset] 转身，保持 @[asset:robot-asset] 一致");
    expect(h.requirements().input?.imageCount).toBe(1);
    expect(h.compatibility()).toBe("");
    expect(h.quote.intent.inputs.image).toBe(1);
    expect(h.quote.intent.operation).toBe("image_to_video");
    expect(h.frameOptions().map((item: any) => item.nodeId)).toEqual(["robot-asset"]);
    h.chooseFrames({ videoStartFrameNodeId: h.frameOptions()[0].nodeId });
    const context = h.context();
    const metadata = buildVideoGenerationMetadata(h.node, context);
    expect(metadata.videoStartFrameNodeId).toBe("robot-asset");
    expect(resolveVideoImageReferences(context.referenceImages, metadata).map(({ image, role }) => ({ id: image.id, role }))).toEqual([{ id: "robot-asset", role: "first_frame" }]);
});

test("connected and asset identities use exactly the submission resolver's counts and frame roles", () => {
    const h = harness([imageAsset()], "让 @[asset:robot-asset] 与 @[asset:robot-asset] 保持一致", true);
    const context = h.context();
    expect(h.requirements().input?.imageCount).toBe(context.imageCount);
    expect(h.quote.intent.inputs.image).toBe(context.imageCount);
    expect(h.frameOptions().map((item: any) => item.nodeId)).toEqual(context.referenceImages.map((image) => image.id));
    expect(context.referenceImages.map((image) => image.id)).toEqual(["connected-image", "robot-asset"]);
    h.chooseFrames({ videoStartFrameNodeId: "robot-asset", videoEndFrameNodeId: "connected-image" });
    expect(resolveVideoImageReferences(context.referenceImages, buildVideoGenerationMetadata(h.node, context)).map(({ role }) => role)).toEqual(["last_frame", "first_frame"]);
    h.edit("让机器人转身");
    expect(h.node.metadata?.videoStartFrameNodeId).toBeUndefined();
    expect(h.node.metadata?.videoEndFrameNodeId).toBe("connected-image");
    expect(h.requirements().input?.imageCount).toBe(1);
    expect(h.frameOptions().map((item: any) => item.nodeId)).toEqual(["connected-image"]);
});

test("removing the only asset token clears stale asset frames and disables an image-only 512 model", () => {
    const h = harness([imageAsset()]);
    h.chooseFrames({ videoStartFrameNodeId: "robot-asset", videoEndFrameNodeId: "robot-asset" });
    h.edit("只有文字的转身视频");
    expect(h.node.metadata?.videoStartFrameNodeId).toBeUndefined();
    expect(h.node.metadata?.videoEndFrameNodeId).toBeUndefined();
    expect(h.requirements().input?.imageCount).toBe(0);
    expect(h.quote.intent.inputs.image).toBe(0);
    expect(h.quote.intent.operation).toBe("text_to_video");
    expect(h.compatibility()).toContain("不支持文生视频");
    expect(h.frameOptions()).toEqual([]);
    expect(h.context().referenceImages).toEqual([]);
    expect(buildVideoGenerationMetadata(h.node, h.context()).videoStartFrameNodeId).toBeUndefined();
});

test("switching panel node props isolates the prompt draft before resolving or clearing frame metadata", () => {
    const second = { ...imageAsset(), id: "second-asset", title: "Second.png" };
    const h = harness([imageAsset(), second]);
    h.deferPromptPersistence();
    const localPrompt = "本地编辑 @[asset:robot-asset]";
    h.edit(localPrompt);
    expect(h.prompt()).toBe(localPrompt);
    const nextPrompt = "新的节点 @[asset:second-asset]";
    h.resolutions.length = 0;
    h.patches.length = 0;
    h.switchNode({ ...h.node, id: "second-video", metadata: { ...h.node.metadata, prompt: nextPrompt, composerContent: nextPrompt, videoStartFrameNodeId: second.id, videoEndFrameNodeId: second.id } });
    expect(h.resolutions).toEqual([{ nodeId: "second-video", prompt: nextPrompt }]);
    expect(h.prompt()).toBe(nextPrompt);
    expect(h.patches).toEqual([]);
    expect(h.node.metadata?.videoStartFrameNodeId).toBe(second.id);
    expect(h.node.metadata?.videoEndFrameNodeId).toBe(second.id);
    expect(h.frameOptions().map((item: any) => item.nodeId)).toEqual([second.id]);
    const editedPrompt = "继续编辑 @[asset:second-asset]";
    h.edit(editedPrompt);
    expect(h.prompt()).toBe(editedPrompt);
    expect(h.node.metadata?.composerContent).toBe(nextPrompt);
});

test("deleting an asset then removing its token clears stale frames while preserving a connected frame", () => {
    for (const connected of [false, true]) {
        const h = harness([imageAsset()], undefined, connected);
        h.chooseFrames({ videoStartFrameNodeId: "robot-asset", videoEndFrameNodeId: connected ? "connected-image" : "robot-asset" });
        h.replaceAssets([]);
        // A dangling mention is still reported by the submission resolver.
        expect(() => h.context()).toThrow();
        h.edit("素材已移除，继续生成");
        expect(h.node.metadata?.videoStartFrameNodeId).toBeUndefined();
        expect(h.node.metadata?.videoEndFrameNodeId).toBe(connected ? "connected-image" : undefined);
        expect(h.frameOptions().map((item: any) => item.nodeId)).toEqual(connected ? ["connected-image"] : []);
        expect(() => buildVideoGenerationMetadata(h.node, h.context())).not.toThrow();
    }
});

test("asset video/audio mentions use submission media counts while a text mention remains text", () => {
    const base = imageAsset();
    const library: Asset[] = [
        { ...base, id: "clip", kind: "video", data: { url: "https://example.test/clip.mp4", mimeType: "video/mp4", width: 512, height: 512, durationMs: 1000, bytes: 1 } },
        { ...base, id: "sound", kind: "audio", data: { url: "https://example.test/sound.mp3", mimeType: "audio/mpeg", durationMs: 1000, bytes: 1 } },
        { ...base, id: "note", kind: "text", data: { content: "保持机器人外形" } },
    ];
    const h = harness(library, "参考 @[asset:clip] @[asset:sound] @[asset:note]");
    expect(h.requirements().input).toMatchObject({ imageCount: 0, videoCount: 1, audioCount: 1 });
    expect(h.quote.intent.inputs).toEqual({ image: 0, video: 1, audio: 1 });
    expect(h.context().prompt).toContain("保持机器人外形");
    h.edit("参考 @[asset:note]");
    expect(h.requirements().input).toMatchObject({ imageCount: 0, videoCount: 0, audioCount: 0 });
    expect(h.frameOptions()).toEqual([]);
    expect(h.context().prompt).toContain("保持机器人外形");
});
