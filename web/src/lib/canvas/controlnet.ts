import type { ControlNetBinding, ControlNetParameters, GenerationSpec, OutputMaskBinding, ReferenceBinding } from "./generation-contract.generated";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import { resourceStorageKey } from "@/services/api/resources";

export type ControlNetInput = { id: string; image: ReferenceImage; mask?: ReferenceImage; parameters: ControlNetParameters };
export type OutputMaskInput = { image: ReferenceImage; mode: OutputMaskBinding["mode"]; resizeMode: "stretch" };

export function controlImageReference(node: CanvasNodeData): ReferenceImage | null {
    if (node.type === "media-conversion" && node.metadata?.mediaConversion?.status !== "completed") return null;
    if (node.type !== "image" && node.type !== "media-conversion") return null;
    const storageKey = node.metadata?.mediaConversion?.resultStorageKey || node.metadata?.storageKey;
    const dataUrl = node.metadata?.content || "";
    if (!storageKey && !dataUrl) return null;
    return { id: node.id, name: node.title, type: node.metadata?.mimeType || "image/png", dataUrl, storageKey, width: node.metadata?.naturalWidth, height: node.metadata?.naturalHeight };
}

export function defaultControlNetBinding(id: string): ControlNetBinding {
    return { id, imageBindingId: "", parameters: { preprocessor: "canny", model: "", strength: 0.6, start: 0, end: 0.6, pixelPerfect: true, controlMode: "balanced", resizeMode: "fill", canny: { resolution: 512, lowThreshold: 100, highThreshold: 200 } } };
}

export function structureControlNodeMetadata(): Partial<CanvasNodeMetadata> {
    return { structureControl: true, controlNet: [defaultControlNetBinding("control-1")] };
}

export function nodeControlNet(node?: Pick<CanvasNodeData, "metadata">): ControlNetBinding[] {
    return node?.metadata?.generationSpec?.options.controlNet ?? node?.metadata?.controlNet ?? [];
}

export function nodeOutputMask(node?: Pick<CanvasNodeData, "metadata">): OutputMaskBinding | undefined {
    return node?.metadata?.generationSpec?.options.outputMask ?? node?.metadata?.outputMask;
}

export function isStructureControlNode(node?: Pick<CanvasNodeData, "metadata">) {
    return Boolean(node?.metadata?.structureControl || nodeControlNet(node).length);
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须是对象`);
    return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string) {
    if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label}包含未知参数`);
}

function number(value: unknown, min: number, max: number, label: string, integer = false): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${label}必须在 ${min}–${max} 之间${integer ? "且为整数" : ""}`);
    return value;
}

export function validateControlNetBindings(value: unknown): ControlNetBinding[] {
    if (!Array.isArray(value) || value.length > 4) throw new Error("结构控制最多支持 4 组");
    const ids = new Set<string>();
    return value.map((raw, index) => {
        const label = `结构控制 ${index + 1}`;
        const unit = record(raw, label);
        keys(unit, ["id", "imageBindingId", "maskBindingId", "parameters"], label);
        if (typeof unit.id !== "string" || !unit.id || ids.has(unit.id)) throw new Error(`${label}的标识必须有效且唯一`);
        ids.add(unit.id);
        if (typeof unit.imageBindingId !== "string") throw new Error(`${label}缺少控制图绑定`);
        if (unit.maskBindingId !== undefined && (typeof unit.maskBindingId !== "string" || !unit.maskBindingId)) throw new Error(`${label}的区域蒙版绑定无效`);
        const params = record(unit.parameters, label);
        keys(params, ["preprocessor", "model", "strength", "start", "end", "pixelPerfect", "controlMode", "resizeMode", "canny"], label);
        if (typeof params.preprocessor !== "string" || !params.preprocessor || typeof params.model !== "string") throw new Error(`${label}的预处理器或控制模型无效`);
        number(params.strength, 0, 2, "控制强度");
        number(params.start, 0, 1, "开始比例");
        number(params.end, 0, 1, "结束比例");
        if ((params.start as number) > (params.end as number)) throw new Error("控制开始比例不能大于结束比例");
        if (typeof params.pixelPerfect !== "boolean" || !["balanced", "prompt", "control"].includes(String(params.controlMode)) || !["stretch", "crop", "fill"].includes(String(params.resizeMode))) throw new Error(`${label}的控制方式无效`);
        if (params.preprocessor === "canny" && params.canny === undefined) throw new Error("Canny 预处理需要检测分辨率与阈值参数");
        if (params.canny !== undefined) {
            const canny = record(params.canny, "Canny 参数");
            keys(canny, ["resolution", "lowThreshold", "highThreshold"], "Canny 参数");
            number(canny.resolution, 64, 2048, "检测分辨率", true);
            number(canny.lowThreshold, 1, 255, "Canny 低阈值", true);
            number(canny.highThreshold, 1, 255, "Canny 高阈值", true);
            if ((canny.lowThreshold as number) > (canny.highThreshold as number)) throw new Error("Canny 低阈值不能大于高阈值");
        }
        return structuredClone(raw) as ControlNetBinding;
    });
}

export function validateOutputMaskBinding(value: unknown): OutputMaskBinding {
    const mask = record(value, "输出蒙版");
    keys(mask, ["bindingId", "mode", "resizeMode"], "输出蒙版");
    if (typeof mask.bindingId !== "string" || !["luminance", "non-black"].includes(String(mask.mode)) || mask.resizeMode !== "stretch") throw new Error("输出蒙版绑定或解释方式无效");
    return { bindingId: mask.bindingId, mode: mask.mode as OutputMaskBinding["mode"], resizeMode: "stretch" };
}

export function structureControlBindingNodeIds(node?: Pick<CanvasNodeData, "metadata">) {
    const ids = new Set(nodeControlNet(node).flatMap((unit) => [unit.imageBindingId, unit.maskBindingId]).filter(Boolean));
    const output = nodeOutputMask(node);
    if (output) ids.add(output.bindingId);
    const bindings = node?.metadata?.generationSpec?.referenceBindings ?? [];
    const explicitReferences = new Set(bindings.filter((binding) => binding.role === "reference").map((binding) => binding.nodeId));
    return new Set(bindings.filter((binding) => ids.has(binding.id) && !explicitReferences.has(binding.nodeId)).flatMap((binding) => binding.nodeId ? [binding.nodeId] : []));
}

export function setControlNetReference(spec: GenerationSpec, bindingId: string, role: ReferenceBinding["role"], source?: { nodeId: string } | { resourceId: string }): GenerationSpec {
    const references = spec.referenceBindings.filter((binding) => binding.id !== bindingId);
    if (source) references.push({ id: bindingId, ...source, mediaType: "image", role, order: references.reduce((max, binding) => Math.max(max, binding.order), -1) + 1, resolution: source && "nodeId" in source ? "latest" : "snapshot" });
    return { ...spec, referenceBindings: references };
}

export function resolveCanvasControlNetInputs(node: CanvasNodeData | undefined, nodes: CanvasNodeData[]): { controlNet: ControlNetInput[]; outputMask?: OutputMaskInput } {
    const bindings = node?.metadata?.generationSpec?.referenceBindings ?? [];
    const read = (id: string, role: ReferenceBinding["role"], label: string): ReferenceImage => {
        const binding = bindings.find((item) => item.id === id && item.role === role);
        if (!binding) throw new Error(`请选择${label}`);
        if (binding.resourceId) return { id: binding.id, name: label, type: "image/png", storageKey: resourceStorageKey(binding.resourceId), dataUrl: "" };
        const source = nodes.find((item) => item.id === binding.nodeId);
        const image = source ? controlImageReference(source) : null;
        if (!image) throw new Error(`${label}尚未准备好或已移除，请重新连接并选择图片`);
        return image;
    };
    const controlNet = validateControlNetBindings(nodeControlNet(node)).map((unit) => {
        if (!unit.parameters.model.trim()) throw new Error("请填写或选择控制模型标识");
        const image = read(unit.imageBindingId, "control-image", "控制图");
        const mask = unit.maskBindingId ? read(unit.maskBindingId, "control-mask", "控制区域蒙版") : undefined;
        return { id: unit.id, image, mask, parameters: structuredClone(unit.parameters) };
    });
    const output = nodeOutputMask(node);
    if (isStructureControlNode(node) && !controlNet.length) throw new Error("请添加至少一组结构控制");
    return { controlNet, ...(output ? { outputMask: { image: read(output.bindingId, "output-mask", "输出蒙版"), mode: output.mode, resizeMode: "stretch" as const } } : {}) };
}
