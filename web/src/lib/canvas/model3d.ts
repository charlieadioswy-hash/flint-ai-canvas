import type { Model3DCapabilities, Model3DMode, Model3DParameters, Model3DResult, Model3DTaskView, Model3DView } from "@/services/api/model3d";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export const MODEL3D_VIEWS: Model3DView[] = ["front", "left", "back", "right"];
export const MODEL3D_VIEW_LABELS: Record<Model3DView, string> = { front: "正面", left: "左侧", back: "背面", right: "右侧" };
export const MODEL3D_MODE_LABELS: Record<Model3DMode, string> = { text: "文本", image: "单图", multiview: "多视图" };

export type Model3DImageBinding = {
    sourceNodeId?: string;
    resourceId?: string;
    storageKey?: string;
    url?: string;
    title?: string;
    mimeType?: string;
    bytes?: number;
};
export type Model3DDraft = {
    mode: Model3DMode;
    prompt: string;
    image?: Model3DImageBinding;
    views: Partial<Record<Model3DView, Model3DImageBinding>>;
    parameters: Model3DParameters;
};
export type Model3DRun = {
    requestId: string;
    taskId?: string;
    sourceFingerprint: string;
    snapshot: Model3DDraft;
    status: Model3DTaskView["status"] | "submitting" | "submission_unknown";
    progress?: number;
    stage?: string;
    error?: string;
    canRetryStorage?: boolean;
    submissionOutcome?: Model3DTaskView["submissionOutcome"];
};
export type CanvasModel3DState = {
    schemaVersion: 1;
    draft: Model3DDraft;
    run?: Model3DRun;
    result?: Model3DResult;
    resultFingerprint?: string;
};

export function createDefaultModel3DState(defaultModel = ""): CanvasModel3DState {
    return { schemaVersion: 1, draft: { mode: "text", prompt: "", views: {}, parameters: { model: defaultModel, texture: true, pbr: true } } };
}

export function readModel3DState(node: CanvasNodeData) {
    return node.metadata?.model3d || createDefaultModel3DState();
}

export function model3DImageBinding(node: CanvasNodeData): Model3DImageBinding {
    return { sourceNodeId: node.id, storageKey: node.metadata?.storageKey, url: node.metadata?.content, title: node.title, mimeType: node.metadata?.mimeType, bytes: node.metadata?.bytes };
}

export function createConnectedModel3DState(sources: CanvasNodeData[]) {
    const state = createDefaultModel3DState();
    const images = sources.filter((node) => node.type === CanvasNodeType.Image);
    if (images.length) {
        state.draft.mode = images.length === 1 ? "image" : "multiview";
        if (images.length === 1) state.draft.image = model3DImageBinding(images[0]);
    }
    return state;
}

export function model3DParametersForModel(parameters: Model3DParameters, capabilities: Model3DCapabilities | null): Model3DParameters {
    const result = { ...parameters };
    const version = capabilities?.modelVersions.find((model) => model.id === parameters.model);
    if (version && !version.supportsAdvanced) {
        for (const key of ["geometryQuality", "textureQuality", "autoSize", "quad", "smartLowPoly", "compress"] as const) delete result[key];
    }
    return result;
}

export function normalizeModel3DParameters(mode: Model3DMode, parameters: Model3DParameters, capabilities: Model3DCapabilities | null): Model3DParameters {
    const result = model3DParametersForModel(parameters, capabilities);
    if (mode !== "text") { delete result.negativePrompt; delete result.imageSeed; }
    if (mode !== "image") delete result.enableImageAutofix;
    if (mode === "text") { delete result.textureAlignment; delete result.orientation; }
    if (!result.texture) {
        result.pbr = false;
        for (const key of ["textureQuality", "textureVersion", "textureSeed", "textureAlignment", "orientation"] as const) delete result[key];
    }
    if (!result.texture || result.textureVersion !== "v3.5-20260815") delete result.delight;
    return result;
}

export function model3DFaceRange(parameters: Model3DParameters, capabilities: Model3DCapabilities | null) {
    const version = capabilities?.modelVersions.find((model) => model.id === parameters.model);
    let maximum = parameters.geometryQuality === "detailed" ? version?.maxFacesDetailed : version?.maxFacesStandard;
    let minimum = 1;
    if (parameters.quad) maximum = 150000;
    if (parameters.smartLowPoly) { minimum = 500; maximum = parameters.quad ? 10000 : 20000; }
    return { min: minimum, max: maximum };
}

export function model3DParameterError(mode: Model3DMode, parameters: Model3DParameters, capabilities: Model3DCapabilities | null) {
    const normalized = normalizeModel3DParameters(mode, parameters, capabilities);
    const range = model3DFaceRange(normalized, capabilities);
    if (normalized.faceLimit !== undefined && (!Number.isSafeInteger(normalized.faceLimit) || normalized.faceLimit < range.min || (range.max !== undefined && normalized.faceLimit > range.max))) return `面数须为 ${range.min.toLocaleString()}–${range.max?.toLocaleString() || "服务允许的上限"}。`;
    if (normalized.negativePrompt && Array.from(normalized.negativePrompt).length > 255) return "负面描述最多 255 字。";
    if (normalized.textureQuality === "fast" && normalized.textureVersion !== "v3.5-20260815") return "快速贴图须选择 v3.5-20260815 贴图版本。";
    if (normalized.textureVersion && !["v2.5-20250123", "v3.0-20250812", "v3.5-20260815"].includes(normalized.textureVersion)) return "请选择服务支持的贴图版本。";
    for (const key of ["modelSeed", "imageSeed", "textureSeed"] as const) if (normalized[key] !== undefined && !Number.isSafeInteger(normalized[key])) return "随机种子须为整数。";
    return "";
}

export function resolveModel3DImage(binding: Model3DImageBinding | undefined, nodes: CanvasNodeData[]): Model3DImageBinding | undefined {
    if (!binding) return undefined;
    if (!binding.sourceNodeId) return binding;
    const source = nodes.find((node) => node.id === binding.sourceNodeId && node.type === CanvasNodeType.Image);
    return source ? model3DImageBinding(source) : undefined;
}

export function model3DPrompt(draft: Model3DDraft, inputNodes: CanvasNodeData[]) {
    return [draft.prompt.trim(), ...inputNodes.filter((node) => node.type === CanvasNodeType.Text || node.type === CanvasNodeType.Markdown).map((node) => (node.metadata?.content || node.metadata?.prompt || "").trim())].filter(Boolean).join("\n\n");
}

function imageIdentity(binding?: Model3DImageBinding) {
    return binding ? binding.storageKey || (binding.resourceId ? `resource:${binding.resourceId}` : binding.url || "") : "";
}

/** Stable draft identity includes current bound image contents, not merely source node IDs. */
export function model3DSourceFingerprint(draft: Model3DDraft, nodes: CanvasNodeData[], inputNodes: CanvasNodeData[] = []) {
    const parameters = Object.fromEntries(Object.entries(draft.parameters).filter(([, value]) => value !== undefined && value !== "").sort(([a], [b]) => a.localeCompare(b)));
    const value = JSON.stringify({ mode: draft.mode, prompt: draft.mode === "text" ? model3DPrompt(draft, inputNodes) : "", image: draft.mode === "image" ? imageIdentity(resolveModel3DImage(draft.image, nodes)) : "", views: draft.mode === "multiview" ? MODEL3D_VIEWS.map((view) => [view, imageIdentity(resolveModel3DImage(draft.views[view], nodes))]) : [], parameters });
    let hash = 2166136261;
    let second = 5381;
    for (let index = 0; index < value.length; index++) {
        hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
        second = Math.imul(second, 33) ^ value.charCodeAt(index);
    }
    return `model3d-v1-${(hash >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

export function model3DInputError(draft: Model3DDraft, nodes: CanvasNodeData[], inputNodes: CanvasNodeData[], capabilities?: Model3DCapabilities | null) {
    if (capabilities && !capabilities.available) return "3D 生成服务尚未配置，请联系管理员。";
    if (capabilities && !capabilities.modes.includes(draft.mode)) return "当前生效配置不支持此生成模式。";
    if (capabilities && !capabilities.modelVersions.some((version) => version.id === draft.parameters.model)) return "请选择当前生效配置允许的模型。";
    const parameterError = model3DParameterError(draft.mode, draft.parameters, capabilities || null);
    if (parameterError) return parameterError;
    if (draft.mode === "text") {
        const prompt = model3DPrompt(draft, inputNodes);
        if (Array.from(prompt).length > 1024) return "模型描述与已连接文字合计最多 1024 字。";
        return prompt ? "" : "请填写描述或连接文字节点。";
    }
    if (draft.mode === "image") return imageIdentity(resolveModel3DImage(draft.image, nodes)) ? "" : "请选择或上传一张参考图片。";
    const views = MODEL3D_VIEWS.map((view) => resolveModel3DImage(draft.views[view], nodes));
    if (!imageIdentity(views[0])) return "多视图必须指定正面图片。";
    const identities = views.map(imageIdentity).filter(Boolean);
    if (identities.length < Math.max(2, capabilities?.inputLimits.minViews || 2)) return "多视图至少需要正面及另一视角的两张图片。";
    if (identities.length > (capabilities?.inputLimits.maxViews || 4)) return "参考视图超过当前服务允许的数量。";
    if (new Set(identities).size !== identities.length) return "不同视角不能使用同一张图片。";
    return "";
}

export function isModel3DPending(run?: Model3DRun) {
    return Boolean(run && (run.status === "submitting" || run.status === "queued" || run.status === "running"));
}

export function model3DTaskMatches(task: Model3DTaskView, input: { canvasId: string; nodeId: string; fingerprint: string; taskId?: string }) {
    return task.clientContext.canvasId === input.canvasId && task.clientContext.nodeId === input.nodeId && task.sourceFingerprint === input.fingerprint && (!input.taskId || input.taskId === task.id);
}

export function applyModel3DTask(node: CanvasNodeData, task: Model3DTaskView, canvasId: string): CanvasNodeData {
    const state = readModel3DState(node);
    if (!state.run || !model3DTaskMatches(task, { canvasId, nodeId: node.id, fingerprint: state.run.sourceFingerprint, taskId: state.run.taskId })) return node;
    const result = task.status === "succeeded" ? task.result : undefined;
    return { ...node, metadata: { ...node.metadata,
        ...(result ? { content: result.url, storageKey: result.storageKey, assetId: result.assetId, bytes: result.bytes, mimeType: result.mimeType, model3dFormat: result.format, status: "success" as const } : {}),
        model3d: { ...state, run: { ...state.run, taskId: task.id, status: task.status, stage: task.stage, progress: task.progress, submissionOutcome: task.submissionOutcome, error: task.error?.message, canRetryStorage: task.canRetryStorage }, ...(result ? { result, resultFingerprint: state.run.sourceFingerprint } : {}) },
    } };
}

export function model3DDownloadName(result: Pick<Model3DResult, "format" | "fileName">, title = "3D模型") {
    const base = (result.fileName || title).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\.(glb|fbx)$/i, "").trim() || "model";
    return `${base}.${result.format}`;
}
