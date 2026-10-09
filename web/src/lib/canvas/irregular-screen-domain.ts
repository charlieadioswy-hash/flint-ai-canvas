import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { generationSpecMetadata, validateGenerationSpec } from "@/lib/canvas/generation-contract";
import { GENERATION_CONTRACT_VERSION, type ControlNetParameters, type GenerationSpec, type ModelSelection, type ReferenceBinding } from "@/lib/canvas/generation-contract.generated";
import type { IrregularScreenMaskMode } from "@/lib/canvas/irregular-screen-mask";
import type { ImageCapabilityConfig } from "@/lib/model-capabilities";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type Position } from "@/types/canvas";

export type IrregularScreenScene = {
    kind: "irregular-screen";
    version: 1;
    nodeIds: { controlImage: string; outputMask: string; contentReference?: string; generation: string };
    maskMode?: IrregularScreenMaskMode;
};

export type IrregularScreenImage = { storageKey: string; width: number; height: number; mimeType?: string; name?: string; bytes?: number; assetId?: string };
export type IrregularScreenOutputSize = { width: number; height: number; size: string; scaled: boolean; aspectRatioAdjusted: boolean };
export type IrregularScreenTemplateInput = {
    controlImage: IrregularScreenImage;
    outputMask: IrregularScreenImage;
    contentReference?: IrregularScreenImage;
    prompt: string;
    modelSelection?: ModelSelection;
    controlParameters: ControlNetParameters;
    size: string;
    quality?: string;
    providerOptions?: Record<string, Record<string, unknown>>;
    maskMode?: IrregularScreenMaskMode;
    existingProject?: Pick<CanvasProject, "nodes" | "connections" | "creationScene">;
};

export function isIrregularScreenScene(value: unknown): value is IrregularScreenScene {
    if (!value || typeof value !== "object") return false;
    const scene = value as Partial<IrregularScreenScene>;
    if (scene.kind !== "irregular-screen" || scene.version !== 1 || !scene.nodeIds || typeof scene.nodeIds !== "object") return false;
    const ids = [scene.nodeIds.controlImage, scene.nodeIds.outputMask, scene.nodeIds.generation, ...(scene.nodeIds.contentReference === undefined ? [] : [scene.nodeIds.contentReference])];
    return ids.every((id) => typeof id === "string" && id.trim()) && new Set(ids).size === ids.length;
}

function validDimensions({ width, height }: { width: number; height: number }) {
    return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0;
}

function pixelSize(value: string) {
    const match = /^(\d+)[x×](\d+)$/i.exec(value.trim());
    if (!match) return undefined;
    const result = { width: Number(match[1]), height: Number(match[2]) };
    return validDimensions(result) ? result : undefined;
}

function sameRatio(a: { width: number; height: number }, b: { width: number; height: number }) {
    return Math.abs((a.width * b.height) / (b.width * a.height) - 1) <= 0.005;
}

export function resolveIrregularScreenOutputSize(source: { width: number; height: number }, profile: ImageCapabilityConfig): IrregularScreenOutputSize {
    if (!validDimensions(source)) throw new Error("屏幕图片尺寸无效");
    if (profile.size.parameter === "none") throw new Error("当前模型不能指定输出尺寸，请选择支持原图比例的结构控制模型");
    const originalSize = `${source.width}x${source.height}`;
    const candidates = profile.size.values.flatMap((size) => {
        const dimensions = pixelSize(size);
        return dimensions && sameRatio(source, dimensions) ? [{ ...dimensions, size }] : [];
    });
    // Upload resolution describes the screen coordinates, not the default generation budget.
    const preferred = pixelSize(profile.size.default) || source;
    const preferredPixels = preferred.width * preferred.height;
    candidates.sort((a, b) => Math.abs(Math.log(a.width * a.height / preferredPixels)) - Math.abs(Math.log(b.width * b.height / preferredPixels)));
    const selected = candidates[0];
    if (!selected) {
        if (profile.size.parameter === "size" && profile.size.allowCustom) return { ...source, size: originalSize, scaled: false, aspectRatioAdjusted: false };
        throw new Error(`当前模型没有与 ${originalSize} 同比例的明确像素规格，请选择支持自定义尺寸的模型`);
    }
    return { ...selected, scaled: selected.width !== source.width || selected.height !== source.height, aspectRatioAdjusted: source.width * selected.height !== selected.width * source.height };
}

function requireImage(image: IrregularScreenImage, label: string) {
    if (!image.storageKey.trim() || !validDimensions(image)) throw new Error(`${label}缺少已保存的图片或有效尺寸`);
}

function imageMetadata(image: IrregularScreenImage): CanvasNodeMetadata {
    return { storageKey: image.storageKey, assetId: image.assetId, content: undefined, previewContent: undefined, naturalWidth: image.width, naturalHeight: image.height, mimeType: image.mimeType || "image/png", bytes: image.bytes };
}

function imageNode(existing: CanvasNodeData | undefined, title: string, position: Position, image: IrregularScreenImage): CanvasNodeData {
    const base = existing || createCanvasNode(CanvasNodeType.Image, position);
    const scale = 320 / Math.max(image.width, image.height);
    return { ...base, title: existing?.title || title, width: image.width * scale, height: image.height * scale, updatedAt: new Date().toISOString(), metadata: { ...base.metadata, ...imageMetadata(image) } };
}

export function buildIrregularScreenTemplate(input: IrregularScreenTemplateInput): {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    creationScene: IrregularScreenScene;
    generationNodeId: string;
} {
    requireImage(input.controlImage, "结构原图");
    requireImage(input.outputMask, "输出蒙版");
    if (input.contentReference) requireImage(input.contentReference, "内容参考图");
    if (input.controlImage.width !== input.outputMask.width || input.controlImage.height !== input.outputMask.height) throw new Error("结构原图和输出蒙版必须使用完全相同的像素尺寸与坐标");
    const output = pixelSize(input.size);
    if (!output || !sameRatio(input.controlImage, output)) throw new Error("输出尺寸必须与屏幕原图保持相同比例，不能拉伸或裁剪");
    if (input.controlParameters.resizeMode !== "stretch") throw new Error("异形屏结构控制必须使用一致的完整图片坐标");
    const existing = input.existingProject;
    const scene = isIrregularScreenScene(existing?.creationScene) ? existing.creationScene : undefined;
    const byId = new Map(existing?.nodes.map((node) => [node.id, node]));
    const owned = (id?: string) => { const node = id ? byId.get(id) : undefined; return node?.type === CanvasNodeType.Image ? node : undefined; };
    const control = imageNode(owned(scene?.nodeIds.controlImage), "屏幕结构原图", { x: 200, y: 200 }, input.controlImage);
    const mask = imageNode(owned(scene?.nodeIds.outputMask), "屏幕输出蒙版", { x: 200, y: 620 }, input.outputMask);
    const reference = input.contentReference ? imageNode(owned(scene?.nodeIds.contentReference), "内容参考图", { x: 200, y: 1040 }, input.contentReference) : undefined;
    const previousGeneration = owned(scene?.nodeIds.generation);
    const generation = previousGeneration || createCanvasNode(CanvasNodeType.Image, { x: 780, y: 360 });
    const referenceBindings: ReferenceBinding[] = [
        { id: "screen-control", nodeId: control.id, mediaType: "image", role: "control-image", order: 0, resolution: "latest" },
        { id: "screen-output-mask", nodeId: mask.id, mediaType: "image", role: "output-mask", order: 1, resolution: "latest" },
        ...(reference ? [{ id: "screen-content-reference", nodeId: reference.id, mediaType: "image" as const, role: "reference" as const, order: 2, resolution: "latest" as const }] : []),
    ];
    const spec: GenerationSpec = validateGenerationSpec({
        version: GENERATION_CONTRACT_VERSION, mode: "image", prompt: input.prompt, modelSelection: input.modelSelection,
        options: { count: 1, size: input.size, ...(input.quality ? { quality: input.quality } : {}), controlNet: [{ id: "screen-control-unit", imageBindingId: "screen-control", parameters: input.controlParameters }], outputMask: { bindingId: "screen-output-mask", mode: "luminance", resizeMode: "stretch" } },
        referenceBindings, textInputMode: "prompt-only",
    });
    const generationScale = 320 / Math.max(output.width, output.height);
    const generationNode: CanvasNodeData = { ...generation, ...(!previousGeneration ? { width: output.width * generationScale, height: output.height * generationScale } : {}), title: previousGeneration?.title || "异形屏画面", updatedAt: new Date().toISOString(), metadata: { ...generation.metadata, ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}), structureControl: true, ...generationSpecMetadata(spec) } };
    const managed = [control, mask, ...(reference ? [reference] : []), generationNode];
    const replacements = new Map(managed.map((node) => [node.id, node]));
    const nodes = (existing?.nodes || []).map((node) => replacements.get(node.id) || node);
    for (const node of managed) if (!byId.has(node.id)) nodes.push(node);
    const previousSourceIds = new Set(scene ? [scene.nodeIds.controlImage, scene.nodeIds.outputMask, scene.nodeIds.contentReference] : []);
    const connections = (existing?.connections || []).filter((connection) => !(connection.toNodeId === scene?.nodeIds.generation && previousSourceIds.has(connection.fromNodeId)));
    for (const source of [control, mask, ...(reference ? [reference] : [])]) {
        const old = existing?.connections.find((connection) => connection.fromNodeId === source.id && connection.toNodeId === generationNode.id);
        connections.push(old || { id: `screen-${source.id}-${generationNode.id}`, fromNodeId: source.id, toNodeId: generationNode.id });
    }
    return { nodes, connections, creationScene: { kind: "irregular-screen", version: 1, nodeIds: { controlImage: control.id, outputMask: mask.id, ...(reference ? { contentReference: reference.id } : {}), generation: generationNode.id }, maskMode: input.maskMode }, generationNodeId: generationNode.id };
}
