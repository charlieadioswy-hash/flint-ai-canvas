import { expect, test } from "bun:test";
import {
    applyModel3DTask,
    createConnectedModel3DState,
    createDefaultModel3DState,
    model3DDownloadName,
    model3DFaceRange,
    model3DImageBinding,
    model3DInputError,
    model3DParameterError,
    model3DParametersForModel,
    model3DSourceFingerprint,
    normalizeModel3DParameters,
} from "@/lib/canvas/model3d";
import { isolateCopiedNodeMetadata } from "@/lib/canvas/canvas-node-copy";
import { canvasConnectionError } from "@/lib/canvas/canvas-connection-policy";
import { getConstrainedNodePanelPosition } from "@/components/canvas/canvas-workspace-overlays";
import { getNodeDefinition, getNodeGenerationMode } from "@/lib/canvas/node-registry";
import { getNodeSpec } from "@/constant/canvas";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { Model3DCapabilities, Model3DTaskView } from "@/services/api/model3d";
import type { AiConfig } from "@/stores/use-config-store";

const capabilities: Model3DCapabilities = {
    available: true,
    providerName: "Tripo",
    policyRevision: 1,
    activeConfigVersion: 1,
    defaultModel: "h3.1",
    modelVersions: [
        { id: "h3.1", label: "H3.1", supportsAdvanced: true, maxFacesStandard: 100000, maxFacesDetailed: 500000 },
        { id: "h2.5", label: "H2.5", supportsAdvanced: false, maxFacesStandard: 100000, maxFacesDetailed: 100000 },
    ],
    modes: ["text", "image", "multiview"],
    inputLimits: { maxBytes: 10000000, mimeTypes: ["image/png", "image/jpeg"], minViews: 2, maxViews: 4, requiredView: "front" },
};
const image = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, width: 320, height: 240, position: { x: 0, y: 0 }, metadata: { storageKey: `resource:${id}`, content: `/api/resources/${id}/file` } });
const makeNode = (): CanvasNodeData => ({ id: "model", type: CanvasNodeType.Model3D, title: "3D", width: 520, height: 420, position: { x: 380, y: 160 }, metadata: { model3d: createDefaultModel3DState("h3.1") } });

test("3D node is registered with its own input contract and no generic generation mode", () => {
    const node = makeNode();
    expect(getNodeDefinition(node.type)?.acceptsInputKind).toEqual(["text", "image"]);
    expect(getNodeGenerationMode(node)).toBeNull();
    expect(getNodeSpec(node.type)?.title).toBe("3D 模型");
});

test("multiview requires explicit front and distinct views, independent of connection order", () => {
    const draft = createDefaultModel3DState("h3.1").draft;
    draft.mode = "multiview";
    const nodes = [image("left"), image("front")];
    expect(model3DInputError(draft, nodes, nodes, capabilities)).toContain("正面");
    draft.views.left = model3DImageBinding(nodes[0]);
    expect(model3DInputError(draft, nodes, nodes, capabilities)).toContain("正面");
    draft.views.front = model3DImageBinding(nodes[1]);
    expect(model3DInputError(draft, nodes, nodes, capabilities)).toBe("");
    expect(model3DSourceFingerprint(draft, nodes)).toBe(model3DSourceFingerprint(draft, [...nodes].reverse()));
    draft.views.back = model3DImageBinding(nodes[1]);
    expect(model3DInputError(draft, nodes, nodes, capabilities)).toContain("同一张");
});

test("bound image replacement invalidates result identity and removed input cannot be submitted", () => {
    const draft = createDefaultModel3DState("h3.1").draft;
    const source = image("source");
    draft.mode = "image";
    draft.image = model3DImageBinding(source);
    const before = model3DSourceFingerprint(draft, [source]);
    source.metadata!.storageKey = "resource:new-original";
    expect(model3DSourceFingerprint(draft, [source])).not.toBe(before);
    expect(model3DInputError(draft, [], [], capabilities)).toContain("参考图片");
});

test("connection modes reject incompatible sources and connected quick-create binds only a single image", () => {
    const target = makeNode();
    const source = image("front");
    const candidate = { fromNodeId: source.id, toNodeId: target.id };
    expect(canvasConnectionError({} as AiConfig, [target, source], [], candidate)).toContain("文本模式");
    target.metadata!.model3d = createConnectedModel3DState([source]);
    expect(canvasConnectionError({} as AiConfig, [target, source], [], candidate)).toBe("");
    expect(target.metadata!.model3d.draft.image?.sourceNodeId).toBe(source.id);
    const multiple = createConnectedModel3DState([source, image("left")]);
    expect(multiple.draft.mode).toBe("multiview");
    expect(multiple.draft.views).toEqual({});
});

test("H2.5 drops version-specific options without losing common parameters", () => {
    const normalized = model3DParametersForModel({ model: "h2.5", texture: true, pbr: true, faceLimit: 20000, modelSeed: 100, geometryQuality: "detailed", quad: true, compress: "geometry", exportUv: false, exportOrientation: "-y" }, capabilities);
    expect(normalized.faceLimit).toBe(20000);
    expect(normalized.modelSeed).toBe(100);
    expect(normalized.exportUv).toBe(false);
    expect(normalized.exportOrientation).toBe("-y");
    expect(normalized).not.toHaveProperty("quad");
    expect(normalized).not.toHaveProperty("geometryQuality");
});

test("mode changes remove inapplicable parameters including explicit false image autofix", () => {
    const original = { model: "h3.1", texture: true, pbr: true, negativePrompt: "noise", imageSeed: 5, enableImageAutofix: false, textureAlignment: "original_image" as const, orientation: "align_image" as const };
    const text = normalizeModel3DParameters("text", original, capabilities);
    expect(text.negativePrompt).toBe("noise");
    expect(text.imageSeed).toBe(5);
    expect(text).not.toHaveProperty("enableImageAutofix");
    expect(text).not.toHaveProperty("textureAlignment");
    expect(text).not.toHaveProperty("orientation");
    const single = normalizeModel3DParameters("image", original, capabilities);
    expect(single.enableImageAutofix).toBe(false);
    expect(single.textureAlignment).toBe("original_image");
    expect(single).not.toHaveProperty("negativePrompt");
    expect(single).not.toHaveProperty("imageSeed");
    const multi = normalizeModel3DParameters("multiview", original, capabilities);
    expect(multi).not.toHaveProperty("enableImageAutofix");
    expect(multi).not.toHaveProperty("negativePrompt");
    expect(multi).not.toHaveProperty("imageSeed");
    expect(original.enableImageAutofix).toBe(false);
    expect(original.negativePrompt).toBe("noise");
});

test("disabling texture removes all prohibited texture options without changing geometry", () => {
    const normalized = normalizeModel3DParameters(
        "image",
        { model: "h3.1", texture: false, pbr: true, textureQuality: "detailed", textureVersion: "v3.0-20250812", textureSeed: 10, textureAlignment: "original_image", orientation: "align_image", geometryQuality: "detailed", modelSeed: 20, delight: true },
        capabilities,
    );
    expect(normalized).toEqual({ model: "h3.1", texture: false, pbr: false, geometryQuality: "detailed", modelSeed: 20 });
});

test("delight remains explicit only for enabled texture 3.5 and clearing it restores provider default", () => {
    const base = { model: "h3.1", texture: true, pbr: true, delight: false };
    expect(normalizeModel3DParameters("text", { ...base, textureVersion: "v3.5-20260815" }, capabilities).delight).toBe(false);
    for (const textureVersion of [undefined, "v2.5-20250123", "v3.0-20250812"]) expect(normalizeModel3DParameters("text", { ...base, textureVersion }, capabilities)).not.toHaveProperty("delight");
    expect(normalizeModel3DParameters("text", { ...base, texture: false, textureVersion: "v3.5-20260815" }, capabilities)).not.toHaveProperty("delight");
    const fresh = normalizeModel3DParameters("text", { ...createDefaultModel3DState("h3.1").draft.parameters, textureVersion: "v3.5-20260815" }, capabilities);
    expect(fresh).not.toHaveProperty("delight");
    expect(fresh).not.toHaveProperty("exportUv");
});

test("random seeds accept signed safe integers and reject fractional or unrepresentable values", () => {
    const base = { model: "h3.1", texture: true, pbr: true };
    for (const key of ["modelSeed", "imageSeed", "textureSeed"] as const) {
        for (const value of [-1, Number.MIN_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER]) expect(model3DParameterError("text", { ...base, [key]: value }, capabilities)).toBe("");
        for (const value of [-1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) expect(model3DParameterError("text", { ...base, [key]: value }, capabilities)).toContain("整数");
    }
});

test("face limits match ordinary, detailed, quad and low-poly backend ranges", () => {
    const base = { model: "h3.1", texture: true, pbr: true };
    for (const [options, minimum, maximum] of [
        [{}, 1, 100000],
        [{ geometryQuality: "detailed" }, 1, 500000],
        [{ quad: true }, 1, 150000],
        [{ smartLowPoly: true }, 500, 20000],
        [{ quad: true, smartLowPoly: true }, 500, 10000],
    ] as const) {
        const parameters = { ...base, ...options };
        expect(model3DFaceRange(parameters, capabilities)).toEqual({ min: minimum, max: maximum });
        for (const faceLimit of [minimum, maximum]) expect(model3DParameterError("text", { ...parameters, faceLimit }, capabilities)).toBe("");
        for (const faceLimit of [minimum - 1, maximum + 1, minimum + 0.5]) expect(model3DParameterError("text", { ...parameters, faceLimit }, capabilities)).toContain("面数");
    }
    const draft = createDefaultModel3DState("h3.1").draft;
    draft.prompt = "truck";
    draft.parameters = { ...base, faceLimit: 30000, smartLowPoly: true };
    expect(model3DInputError(draft, [], [], capabilities)).toContain("20,000");
    draft.parameters = { ...draft.parameters, model: "h2.5" };
    expect(model3DInputError(draft, [], [], capabilities)).toBe("");
});

test("text and texture version limits are checked before admission", () => {
    const draft = createDefaultModel3DState("h3.1").draft;
    draft.prompt = "🎬".repeat(1024);
    expect(model3DInputError(draft, [], [], capabilities)).toBe("");
    const source = { ...image("prompt"), type: CanvasNodeType.Text, metadata: { content: "more" } };
    expect(model3DInputError(draft, [source], [source], capabilities)).toContain("1024");
    draft.prompt = "truck";
    draft.parameters.negativePrompt = "字".repeat(256);
    expect(model3DInputError(draft, [], [], capabilities)).toContain("255");
    expect(model3DParameterError("text", { model: "h3.1", texture: true, pbr: true, textureQuality: "fast", textureVersion: "v3.0-20250812" }, capabilities)).toContain("快速贴图");
    expect(model3DParameterError("text", { model: "h3.1", texture: true, pbr: true, textureQuality: "fast", textureVersion: "v3.5-20260815" }, capabilities)).toBe("");
});

test("task materialization rejects mismatched canvas, node, fingerprint and newer task", () => {
    const node = makeNode();
    const state = node.metadata!.model3d!;
    state.run = { requestId: "request", taskId: "task", sourceFingerprint: "fingerprint", status: "running", snapshot: structuredClone(state.draft) };
    const task: Model3DTaskView = {
        id: "task",
        status: "succeeded",
        stage: "completed",
        mode: "text",
        sourceFingerprint: "fingerprint",
        clientContext: { canvasId: "canvas", nodeId: "model" },
        submissionOutcome: "submitted",
        canRetryStorage: false,
        createdAt: "",
        updatedAt: "",
        result: { assetId: "asset", resourceId: "result", storageKey: "resource:result", url: "/api/resources/result/file", fileName: "model.fbx", format: "fbx", mimeType: "application/octet-stream", bytes: 100 },
    };
    expect(applyModel3DTask(node, task, "other")).toBe(node);
    expect(applyModel3DTask(node, { ...task, sourceFingerprint: "other" }, "canvas")).toBe(node);
    expect(applyModel3DTask(node, { ...task, id: "other" }, "canvas")).toBe(node);
    const completed = applyModel3DTask(node, task, "canvas");
    expect(completed.metadata?.model3dFormat).toBe("fbx");
    expect(completed.metadata?.storageKey).toBe("resource:result");
    expect(completed.metadata?.model3d?.resultFingerprint).toBe("fingerprint");
});

test("copy isolates task state and remaps explicitly bound inputs", () => {
    const node = makeNode();
    const state = node.metadata!.model3d!;
    state.draft.image = model3DImageBinding(image("source"));
    state.run = { requestId: "request", taskId: "task", sourceFingerprint: "fp", status: "running", snapshot: structuredClone(state.draft) };
    const copy = isolateCopiedNodeMetadata(node, new Map([["source", "copied-source"]]));
    expect(copy.model3d?.run).toBeUndefined();
    expect(copy.model3d?.draft.image?.sourceNodeId).toBe("copied-source");
    expect(state.draft.image?.sourceNodeId).toBe("source");
});

test("download uses actual model extension and removes unsafe filename characters", () => {
    expect(model3DDownloadName({ format: "fbx", fileName: "truck.glb" })).toBe("truck.fbx");
    expect(model3DDownloadName({ format: "glb", fileName: "a/b:c" })).toBe("a_b_c.glb");
});

test("3D parameter panel stays inside viewport with a reachable footer on small screens", () => {
    const node = makeNode();
    for (const size of [
        { width: 1280, height: 720 },
        { width: 900, height: 600 },
        { width: 390, height: 680 },
    ]) {
        const width = Math.min(420, size.width - 24);
        const height = Math.min(548, size.height - 84);
        const position = getConstrainedNodePanelPosition(node, { x: 0, y: 0, k: 1 }, size, width, height);
        expect(position.left).toBeGreaterThanOrEqual(12);
        expect(position.left + width).toBeLessThanOrEqual(size.width - 12);
        expect(position.top).toBeGreaterThanOrEqual(68);
        expect(position.top + height).toBeLessThanOrEqual(size.height - 12);
    }
});
