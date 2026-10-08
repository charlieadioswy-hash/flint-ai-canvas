import { describe, expect, mock, spyOn, test } from "bun:test";

import { buildNodeGenerationContext } from "../src/components/canvas/canvas-node-generation";
import { applyNodeConfigPatch } from "../src/lib/canvas/canvas-project-domain";
import { isolateCopiedNodeMetadata } from "../src/lib/canvas/canvas-node-copy";
import { defaultControlNetBinding, resolveCanvasControlNetInputs, setControlNetReference, structureControlNodeMetadata, validateControlNetBindings } from "../src/lib/canvas/controlnet";
import { generationSpecMetadata, readNodeGenerationSpec, validateGenerationSpec } from "../src/lib/canvas/generation-contract";
import type { GenerationSpec } from "../src/lib/canvas/generation-contract.generated";
import { defaultImageCapabilityConfig } from "../src/lib/model-capabilities";
import { modelCompatibilityError } from "../src/lib/model-selection";
import { prepareBackendGenerationTask } from "../src/services/api/generation-task";
import * as resourceAPI from "../src/services/api/resources";
import { retryStructureControlTask } from "../src/services/controlnet-task-retry";
import type { CreateTaskInput, GenerationTask } from "../src/services/api/task-center";
import * as generationProject from "../src/lib/canvas/canvas-project-generation";
import { executeImageGeneration } from "../src/pages/canvas/canvas-image-generation-executor";
import { createModelChannel, defaultConfig, encodeChannelModel } from "../src/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function image(id: string): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { storageKey: `resource:${id}`, naturalWidth: 1258, naturalHeight: 710 } };
}

function recipe(): GenerationSpec {
    const unit = defaultControlNetBinding("unit-1");
    unit.imageBindingId = "control-source";
    unit.maskBindingId = "control-region";
    unit.parameters.model = "control-model";
    unit.parameters.resizeMode = "stretch";
    return {
        version: 1, mode: "image", prompt: "a panda in a corner display", options: { controlNet: [unit], outputMask: { bindingId: "output-region", mode: "non-black", resizeMode: "stretch" } },
        referenceBindings: [
            { id: "control-source", nodeId: "screen", mediaType: "image", role: "control-image", order: 0, resolution: "latest" },
            { id: "control-region", nodeId: "region", mediaType: "image", role: "control-mask", order: 1, resolution: "latest" },
            { id: "output-region", nodeId: "output", mediaType: "image", role: "output-mask", order: 2, resolution: "latest" },
        ], textInputMode: "append-sources",
    };
}

function controlledNode(spec = recipe()): CanvasNodeData { return { ...image("target"), metadata: { structureControl: true, ...generationSpecMetadata(spec) } }; }

function config(supported = true) {
    const channel = createModelChannel({ id: "controls", name: "Control provider", baseUrl: "https://provider.example", apiKey: "test-key", interfaceType: "control-test", models: ["base-model"], modelCosts: [{ model: "base-model", capability: "image", protocol: "control-test", billingMode: "fixed_request", unitPriceMicrocredits: 1, capabilityConfig: { version: 1, image: { ...defaultImageCapabilityConfig(), controlNet: { supported, maxUnits: 4, preprocessors: ["canny"] } } } }] });
    const model = encodeChannelModel(channel.id, "base-model");
    return { ...defaultConfig, channels: [channel], model, imageModel: model };
}

describe("canvas structure control contract and resource roles", () => {
    test("a blank dedicated image recipe is editable but cannot be submitted", () => {
        const node = { ...image("target"), metadata: structureControlNodeMetadata() };
        expect(readNodeGenerationSpec(node)?.options.controlNet).toHaveLength(1);
        expect(() => resolveCanvasControlNetInputs(node, [])).toThrow("控制模型");
    });

    test("the real config patch path preserves new bindings and logical model selection", () => {
        const spec = recipe(); spec.modelSelection = { kind: "logical", logicalModelId: "logical-1" };
        const original = controlledNode({ ...spec, referenceBindings: [], options: { controlNet: [defaultControlNetBinding("unit-1")] } });
        let bound = setControlNetReference(readNodeGenerationSpec(original)!, "control-source", "control-image", { nodeId: "screen" });
        bound = { ...bound, options: { controlNet: [{ ...bound.options.controlNet![0], imageBindingId: "control-source" }] } };
        const next = applyNodeConfigPatch(original, generationSpecMetadata(bound));
        expect(next.metadata?.generationSpec?.referenceBindings[0]?.nodeId).toBe("screen");
        expect(next.metadata?.generationSpec?.modelSelection).toEqual(spec.modelSelection);
        expect(original.metadata?.generationSpec?.referenceBindings).toHaveLength(0);
        expect(Array.isArray(next.metadata?.controlNet)).toBe(true);
    });

    test("control images and each mask stay separate from ordinary reference images", () => {
        const target = controlledNode();
        const sources = [image("screen"), image("region"), image("output"), image("reference")];
        const connections = sources.map((source) => ({ id: source.id, fromNodeId: source.id, toNodeId: target.id }));
        const context = buildNodeGenerationContext(target.id, [target, ...sources], connections, "one coherent scene", []);
        expect(context.referenceImages.map((reference) => reference.id)).toEqual(["reference"]);
        const controls = resolveCanvasControlNetInputs(target, sources);
        expect(controls.controlNet[0].image.storageKey).toBe("resource:screen");
        expect(controls.controlNet[0].mask?.storageKey).toBe("resource:region");
        expect(controls.outputMask?.image.storageKey).toBe("resource:output");
        expect(controls.outputMask?.resizeMode).toBe("stretch");
    });

    test("copying a group remaps control sources without sharing mutable parameters", () => {
        const source = controlledNode();
        const copy = isolateCopiedNodeMetadata(source, new Map([["screen", "screen-copy"], ["output", "output-copy"]]));
        expect(copy.generationSpec?.referenceBindings.map((binding) => binding.nodeId)).toEqual(["screen-copy", "region", "output-copy"]);
        copy.generationSpec!.options.controlNet![0].parameters.strength = 1.5;
        expect(source.metadata?.generationSpec?.options.controlNet?.[0].parameters.strength).toBe(0.6);
    });

    test("an explicitly dual-role image remains an ordinary img2img reference", () => {
        const spec = recipe();
        spec.referenceBindings.push({ id: "edit-source", nodeId: "screen", mediaType: "image", role: "reference", order: 3, resolution: "latest" });
        const target = controlledNode(spec);
        const context = buildNodeGenerationContext(target.id, [target, image("screen")], [{ id: "screen-target", fromNodeId: "screen", toNodeId: target.id }], "edit the scene", []);
        expect(context.referenceImages.map((reference) => reference.id)).toEqual(["screen"]);
    });

    test("model switching clears provider model identifiers and options while keeping masks", () => {
        const node = controlledNode(); node.metadata!.model = "old-model"; node.metadata!.providerOptions = { old: { steps: 20 } };
        const next = applyNodeConfigPatch(node, { model: "new-model" });
        expect(next.metadata?.generationSpec?.options.controlNet?.[0].parameters.model).toBe("");
        expect(next.metadata?.generationSpec?.options.outputMask?.bindingId).toBe("output-region");
        expect(next.metadata?.providerOptions).toBeUndefined();
    });

    test("rejects wrong binding roles, invalid Canny thresholds and excess units", () => {
        const wrong = recipe(); wrong.referenceBindings[0].role = "reference";
        expect(() => validateGenerationSpec(wrong)).toThrow("匹配");
        const low = defaultControlNetBinding("low"); low.parameters.canny!.lowThreshold = 0;
        expect(() => validateControlNetBindings([low])).toThrow("低阈值");
        const missing = defaultControlNetBinding("missing"); delete missing.parameters.canny;
        expect(() => validateControlNetBindings([missing])).toThrow("Canny 预处理");
        expect(() => validateControlNetBindings(Array.from({ length: 5 }, (_, index) => defaultControlNetBinding(String(index))))).toThrow("4");
    });

    test("filters by declared capability rather than provider name", () => {
        expect(modelCompatibilityError(config(), config().model, { capability: "image", controlNetUnits: 1 })).toBe("");
        expect(modelCompatibilityError(config(false), config(false).model, { capability: "image", controlNetUnits: 1 })).toContain("不支持结构控制");
    });

    test("does not admit logical routes without a provider template configuration surface", () => {
        const routed = config();
        routed.channels[0].modelCosts![0].logicalModelId = "logical-route";
        expect(modelCompatibilityError(routed, routed.model, { capability: "image", controlNetUnits: 1 })).toContain("具体渠道");
        const projected = config();
        projected.channels[0].modelCosts![0].logicalCapabilitySpec = { capability: "image", inputs: { control_image: { min: 0, max: 4 } }, options: {} };
        expect(modelCompatibilityError(projected, projected.model, { capability: "image", controlNetUnits: 1 })).toContain("具体渠道");
        const managed = config(); managed.channels[0].id = "managed"; managed.model = "managed::base-model";
        expect(modelCompatibilityError(managed, managed.model, { capability: "image", controlNetUnits: 1 })).toContain("具体渠道");
    });

    test("Liblib protocol defaults use pixel sizes and declare only verified image abilities", () => {
        const profile = defaultImageCapabilityConfig("liblib-image");
        expect(profile.size.default).toBe("1024x1024");
        expect(profile.size.values).toEqual(["1024x1024", "1344x768", "768x1344"]);
        expect(profile.references.maxImages).toBe(1);
        expect(profile.references.maxImageBytes).toBe(10 * 1024 * 1024);
        expect(profile.references.maskSupported).toBe(false);
        expect(profile.transparentBackground.supported).toBe(false);
        expect(profile.maxOutputs).toBe(4);
        expect(profile.controlNet).toEqual({ supported: true, maxUnits: 4, preprocessors: ["canny"] });
    });
});

describe("structure control task preparation and frozen retry", () => {
    test.each(["both", "control only", "output mask only"] as const)("actual canvas submission preserves %s", async (variant) => {
        const resolved = resolveCanvasControlNetInputs(controlledNode(), [image("screen"), image("region"), image("output")]);
        const controlNet = variant === "output mask only" ? undefined : resolved.controlNet;
        const outputMask = variant === "control only" ? undefined : resolved.outputMask;
        const submitted: CreateTaskInput[] = [];
        const queued: GenerationTask = {
            id: "controlled-task", type: "canvas_image", status: "queued", prompt: "panda", attempts: 0,
            createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z",
        };
        const createTask = mock(async (input: CreateTaskInput) => {
            submitted.push(JSON.parse(JSON.stringify(input)) as CreateTaskInput);
            return queued;
        });
        const waitTask = mock(async () => ({ ...queued, status: "succeeded" as const, resultJson: JSON.stringify({ mode: "image", images: [{ storageKey: "resource:result" }] }) }));
        const onTaskCreated = mock(() => {});
        const result = await generationProject.runBackendCanvasGenerationTask({
            projectId: "project", nodeId: "target", mode: "image", prompt: "panda", config: config(Boolean(controlNet)),
            controlNet, outputMask, onTaskCreated,
        }, { createTask, waitTask, createId: () => "request-id" });

        expect(createTask).toHaveBeenCalledTimes(1);
        expect(submitted[0].input?.referenceImages).toEqual([]);
        if (controlNet) expect(submitted[0].input?.controlNet).toMatchObject(controlNet);
        else expect(submitted[0].input?.controlNet).toBeUndefined();
        if (outputMask) expect(submitted[0].input?.outputMask).toMatchObject(outputMask);
        else expect(submitted[0].input?.outputMask).toBeUndefined();
        expect(onTaskCreated).toHaveBeenCalledWith(queued);
        expect(waitTask).toHaveBeenCalledTimes(1);
        expect(result.images).toEqual([{ storageKey: "resource:result" }]);
    });

    test("actual canvas submission rejects unsupported control models before creating a task", async () => {
        const resolved = resolveCanvasControlNetInputs(controlledNode(), [image("screen"), image("region"), image("output")]);
        const createTask = mock(async () => { throw new Error("unexpected task creation"); });
        const waitTask = mock(async () => { throw new Error("unexpected task polling"); });
        await expect(generationProject.runBackendCanvasGenerationTask({
            projectId: "project", nodeId: "target", mode: "image", prompt: "panda", config: config(false), ...resolved,
        }, { createTask, waitTask, createId: () => "request-id" })).rejects.toThrow("不支持结构控制");
        expect(createTask).not.toHaveBeenCalled();
        expect(waitTask).not.toHaveBeenCalled();
    });

    test("serializes resource references for control images and output masks without normal image edits", async () => {
        const resolved = resolveCanvasControlNetInputs(controlledNode(), [image("screen"), image("region"), image("output")]);
        const task = await prepareBackendGenerationTask({ mode: "image", prompt: "panda", config: config(), ...resolved });
        expect(task.input?.referenceImages).toEqual([]);
        expect((task.input?.controlNet as typeof resolved.controlNet)[0].image.storageKey).toBe("resource:screen");
        expect((task.input?.outputMask as typeof resolved.outputMask)?.mode).toBe("non-black");
    });

    test("imports a public control image once and freezes it as an owned resource", async () => {
        const imported = spyOn(resourceAPI, "importResourceFromUrl").mockResolvedValue({ id: "frozen-image", kind: "image", mimeType: "image/png" } as Awaited<ReturnType<typeof resourceAPI.importResourceFromUrl>>);
        try {
            const source = { id: "source", name: "screen.png", type: "image/png", dataUrl: "https://cdn.example/screen.png" };
            const unit = defaultControlNetBinding("unit"); unit.parameters.model = "control-model";
            const task = await prepareBackendGenerationTask({ mode: "image", prompt: "panda", config: config(), controlNet: [{ id: unit.id, image: source, parameters: unit.parameters }], outputMask: { image: source, mode: "non-black", resizeMode: "stretch" } });
            expect(imported).toHaveBeenCalledTimes(1);
            expect((task.input?.controlNet as Array<{ image: { storageKey: string; url?: string } }>)[0].image.storageKey).toBe("resource:frozen-image");
            expect((task.input?.controlNet as Array<{ image: { storageKey: string; url?: string } }>)[0].image.url).toBeUndefined();
        } finally { imported.mockRestore(); }
    });

    test("failure retry requeues the original frozen task even when canvas source nodes are gone", async () => {
        const input = { controlNet: [{ id: "unit", image: { storageKey: "resource:old-image" }, parameters: defaultControlNetBinding("unit").parameters }], outputMask: { image: { storageKey: "resource:old-mask" }, mode: "non-black", resizeMode: "stretch" } };
        const original = { id: "old-task", status: "failed", inputJson: JSON.stringify(input) } as GenerationTask;
        const queued = { ...original, status: "queued" } as GenerationTask;
        const completed = { ...queued, status: "succeeded" } as GenerationTask;
        const updates: GenerationTask[] = [];
        const retriedIds: string[] = [];
        const result = await retryStructureControlTask(original, { onTaskUpdate: (task) => updates.push(task) }, { retryTask: async (id) => { retriedIds.push(id); return queued; }, waitTask: async (id, options) => { expect(id).toBe("old-task"); expect(options?.initialTask?.inputJson).toBe(original.inputJson); return completed; } });
        expect(retriedIds).toEqual(["old-task"]);
        expect(updates[0].inputJson).toContain("resource:old-mask");
        expect(result).toBe(completed);
    });

    test("new image versions and batch children retain the complete structural recipe", async () => {
        const source = controlledNode();
        source.metadata!.content = "data:image/png;base64,AA==";
        source.metadata!.providerOptions = { "control-test": { templateUuid: "configured-template", steps: 20 } };
        let nodes = [source, image("screen"), image("region"), image("output")];
        let connections = nodes.slice(1).map((node) => ({ id: node.id, fromNodeId: node.id, toNodeId: source.id }));
        const inputs: Array<Parameters<typeof generationProject.runCanvasGenerationTaskToConsumer>[0]> = [];
        const run = spyOn(generationProject, "runCanvasGenerationTaskToConsumer").mockImplementation(async (input) => { inputs.push(input); return { mode: "image", images: [] }; });
        try {
            await executeImageGeneration({
                nodeId: source.id, sourceNode: source, canvasNodes: nodes, canvasConnections: connections,
                prompt: "panda", effectivePrompt: "panda", generationConfig: { ...config(), count: "2" },
                generationContext: { prompt: "panda", referenceImages: [], referenceVideos: [], referenceAudios: [], characterReferences: [], resolvedCharacterVersions: [], resolvedCharacterVoices: [], textCount: 0, imageCount: 0, videoCount: 0, audioCount: 0 },
                controller: new AbortController(), projectId: "", editingTextNode: false, styleMetadata: {}, skillMetadata: { skillIds: [], skillVersions: [], skillFiles: [] },
                setNodes: (value) => { nodes = typeof value === "function" ? value(nodes) : value; },
                setConnections: (value) => { connections = typeof value === "function" ? value(connections) : value; },
                setSelectedNodeIds: () => {}, setSelectedConnectionId: () => {}, setDialogNodeId: () => {},
                startGenerationRequest: () => new AbortController(), finishGenerationRequest: () => {}, bindGenerationTask: () => {}, applyGenerationTaskResult: async () => {},
                showError: (message) => { throw new Error(message); }, registerPendingNodeIds: () => {},
            });
            const outputs = nodes.filter((node) => node.id !== source.id && node.type === "image" && (node.metadata?.isBatchRoot || node.metadata?.batchRootId));
            expect(outputs).toHaveLength(3);
            for (const output of outputs) {
                expect(output.metadata?.generationSpec?.options.controlNet?.[0].parameters.model).toBe("control-model");
                expect(output.metadata?.generationSpec?.options.outputMask?.bindingId).toBe("output-region");
                expect(output.metadata?.providerOptions?.["control-test"]?.steps).toBe(20);
            }
            expect(inputs).toHaveLength(2);
            expect(inputs[0].controlNet?.[0].image.storageKey).toBe("resource:screen");
        } finally { run.mockRestore(); }
    });
});
