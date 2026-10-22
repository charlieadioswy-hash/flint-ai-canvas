import { MODEL3D_VIEWS, model3DFaceRange, model3DInputError, model3DSourceFingerprint, normalizeModel3DParameters, type Model3DDraft, type Model3DImageBinding } from "@/lib/canvas/model3d";
import type { Model3DCapabilities, Model3DCreateRequest, Model3DTaskView } from "@/services/api/model3d";

export type Model3DWorkflowTask = Model3DTaskView & { snapshot?: Model3DDraft; localStatus?: "submitting" | "submission_unknown"; localError?: string };

export function defaultModel3DDraft(capabilities?: Model3DCapabilities | null): Model3DDraft {
    const parameters = { model: capabilities?.defaultModel || "", texture: true, pbr: true, faceLimit: 100000 };
    const range = model3DFaceRange(parameters, capabilities || null);
    parameters.faceLimit = Math.min(parameters.faceLimit, range.max || parameters.faceLimit);
    return { mode: "text", prompt: "", views: {}, parameters };
}

export function model3DTaskDraft(task: Model3DWorkflowTask): Model3DDraft {
    if (task.snapshot) return structuredClone(task.snapshot);
    const binding = (id: string): Model3DImageBinding => ({ resourceId: id, storageKey: `resource:${id}` });
    return {
        mode: task.mode,
        prompt: task.prompt || "",
        parameters: { ...(task.parameters || defaultModel3DDraft().parameters) },
        ...(task.imageResourceId ? { image: binding(task.imageResourceId) } : {}),
        views: Object.fromEntries(MODEL3D_VIEWS.filter((view) => task.views?.[view]).map((view) => [view, binding(task.views![view]!)])),
    };
}

export function isActiveModel3DTask(task: Model3DWorkflowTask) {
    return task.status === "queued" || task.status === "running" || task.submissionOutcome === "unknown" || Boolean(task.localStatus);
}

export function mergeModel3DTasks(previous: Model3DWorkflowTask[], incoming: Model3DWorkflowTask[]) {
    const result = [...previous];
    for (const task of incoming) {
        if (task.scope !== "standalone") continue;
        const index = result.findIndex((item) => item.id === task.id || Boolean(task.requestId && item.requestId === task.requestId));
        if (index === -1) result.push(task);
        else {
            const previous = result[index];
            if (!previous.localStatus && !task.localStatus) {
                if (previous.status === "succeeded" && task.status !== "succeeded") continue;
                if (Date.parse(previous.updatedAt) > Date.parse(task.updatedAt)) continue;
            }
            result[index] = { ...task, snapshot: task.snapshot || previous.snapshot };
        }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.groupId === b.groupId ? (a.candidateIndex || 0) - (b.candidateIndex || 0) : b.id.localeCompare(a.id)));
}

export function standaloneModel3DRequest(draft: Model3DDraft, capabilities: Model3DCapabilities, identity: { requestId: string; groupId: string; candidateIndex: number; candidateCount: number }): { request: Model3DCreateRequest; snapshot: Model3DDraft } {
    if (!Number.isInteger(identity.candidateCount) || identity.candidateCount < 1 || identity.candidateCount > 4) throw new Error("候选版本数量须为 1–4。");
    const inputError = model3DInputError(draft, [], [], capabilities);
    if (inputError) throw new Error(inputError);
    const snapshot = structuredClone(draft);
    snapshot.parameters = normalizeModel3DParameters(snapshot.mode, snapshot.parameters, capabilities);
    snapshot.prompt = snapshot.prompt.trim();
    const imageId = (image?: Model3DImageBinding) => {
        const id = image?.resourceId || (image?.storageKey?.startsWith("resource:") ? image.storageKey.slice("resource:".length) : "");
        if (!image || !id || image.sourceNodeId) throw new Error("请重新上传参考图片后再生成。");
        if (image.mimeType && !capabilities.inputLimits.mimeTypes.includes(image.mimeType)) throw new Error("参考图片格式不受当前服务支持。");
        if (image.bytes && image.bytes > capabilities.inputLimits.maxBytes) throw new Error("参考图片超过当前服务允许的大小。");
        return id;
    };
    const request: Model3DCreateRequest = { ...identity, scope: "standalone", sourceFingerprint: model3DSourceFingerprint(snapshot, []), mode: snapshot.mode, parameters: snapshot.parameters, expectedPolicyRevision: capabilities.policyRevision };
    if (snapshot.mode === "text") request.prompt = snapshot.prompt;
    if (snapshot.mode === "image") request.imageResourceId = imageId(snapshot.image);
    if (snapshot.mode === "multiview") request.views = Object.fromEntries(MODEL3D_VIEWS.filter((view) => snapshot.views[view]).map((view) => [view, imageId(snapshot.views[view])])) as Model3DCreateRequest["views"];
    return { request, snapshot };
}

export function model3DPendingTask(request: Model3DCreateRequest, snapshot: Model3DDraft): Model3DWorkflowTask {
    return {
        ...request,
        id: `request:${request.requestId}`,
        scope: "standalone",
        status: "queued",
        stage: "正在提交",
        clientContext: { canvasId: "", nodeId: "" },
        submissionOutcome: "unknown",
        canRetryStorage: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        snapshot,
        localStatus: "submitting",
    };
}

export function validateModel3DImage(file: Pick<File, "type" | "size">, capabilities: Model3DCapabilities, dimensions?: { width: number; height: number }) {
    const limits = capabilities.inputLimits;
    if (!limits.mimeTypes.includes(file.type)) throw new Error("当前 3D 服务不支持此图片格式。");
    if (file.size <= 0 || file.size > limits.maxBytes) throw new Error(`参考图片须大于 0 且不超过 ${Math.floor(limits.maxBytes / 1024 / 1024)} MB。`);
    if (dimensions) {
        const { width, height } = dimensions;
        if (
            !Number.isSafeInteger(width) ||
            !Number.isSafeInteger(height) ||
            width < Math.max(1, limits.minWidth || 1) ||
            height < Math.max(1, limits.minHeight || 1) ||
            (limits.maxWidth && width > limits.maxWidth) ||
            (limits.maxHeight && height > limits.maxHeight)
        )
            throw new Error("参考图片尺寸不符合当前服务要求。");
    }
}
