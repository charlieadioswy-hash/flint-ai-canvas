import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

import { applyModel3DTask, isModel3DPending, model3DInputError, normalizeModel3DParameters, model3DPrompt, model3DSourceFingerprint, MODEL3D_VIEWS, readModel3DState, resolveModel3DImage, type Model3DImageBinding, type Model3DRun } from "@/lib/canvas/model3d";
import { createClientId } from "@/lib/client-id";
import { createModel3DTask, getModel3DCapabilities, getModel3DTask, getModel3DTaskByRequest, recoverModel3DTask, type Model3DCapabilities, type Model3DCreateRequest, type Model3DTaskView } from "@/services/api/model3d";
import { ApiError } from "@/services/api/request";
import { importResourceFromUrl, resourceFileUrl, resourceIdFromStorageKey, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

type Input = { projectId: string; projectLoaded: boolean; nodes: CanvasNodeData[]; nodesRef: RefObject<CanvasNodeData[]>; connectionsRef: RefObject<CanvasConnection[]>; setNodes: Dispatch<SetStateAction<CanvasNodeData[]>> };
type Operation = { context: string; requestId: string; fingerprint: string; controller: AbortController; kind: "submit" | "poll" | "recover" };

export function useCanvasModel3D({ projectId, projectLoaded, nodes, nodesRef, connectionsRef, setNodes }: Input) {
    const userId = useUserStore((state) => state.user?.id || "");
    const context = `${userId}:${projectId}`;
    const contextRef = useRef(context);
    contextRef.current = context;
    const mounted = useRef(true);
    const operations = useRef(new Map<string, Operation>());
    const restored = useRef(new Set<string>());
    const [capabilities, setCapabilities] = useState<Model3DCapabilities | null>(null);
    const [capabilityError, setCapabilityError] = useState("");

    const inputNodes = useCallback((nodeId: string) => {
        const ids = new Set(connectionsRef.current.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId));
        return nodesRef.current.filter((node) => ids.has(node.id));
    }, [connectionsRef, nodesRef]);

    const currentNode = useCallback((nodeId: string, operation: Operation) => {
        if (!mounted.current || operation.controller.signal.aborted || operation.context !== contextRef.current || !userId || useUserStore.getState().user?.id !== userId) return undefined;
        const node = nodesRef.current.find((item) => item.id === nodeId && item.type === CanvasNodeType.Model3D);
        const run = node?.metadata?.model3d?.run;
        return node && run?.requestId === operation.requestId && run.sourceFingerprint === operation.fingerprint ? node : undefined;
    }, [nodesRef, userId]);

    const patchRun = useCallback((nodeId: string, operation: Operation, patch: Partial<Model3DRun>) => {
        if (!currentNode(nodeId, operation)) return;
        setNodes((current) => current.map((node) => {
            if (node.id !== nodeId || !currentNode(nodeId, operation)) return node;
            const state = readModel3DState(node);
            if (state.run?.requestId !== operation.requestId || state.run.sourceFingerprint !== operation.fingerprint) return node;
            return { ...node, metadata: { ...node.metadata, model3d: { ...state, run: { ...state.run, ...patch } } } };
        }));
    }, [currentNode, setNodes]);

    const writeTask = useCallback((nodeId: string, operation: Operation, task: Model3DTaskView) => {
        const latest = currentNode(nodeId, operation);
        if (!latest || applyModel3DTask(latest, task, projectId) === latest) return false;
        setNodes((current) => current.map((node) => {
            if (node.id !== nodeId || !currentNode(nodeId, operation)) return node;
            const run = node.metadata?.model3d?.run;
            if (run?.requestId !== operation.requestId || run.sourceFingerprint !== operation.fingerprint) return node;
            return applyModel3DTask(node, task, projectId);
        }));
        return true;
    }, [currentNode, projectId, setNodes]);

    const poll = useCallback(async (nodeId: string, operation: Operation, initial: Model3DTaskView) => {
        operation.kind = "poll";
        let task = initial;
        try {
            while ((task.status === "queued" || task.status === "running") && currentNode(nodeId, operation)) {
                await delay(2500, operation.controller.signal);
                if (!currentNode(nodeId, operation)) break;
                task = await getModel3DTask(task.id, operation.controller.signal);
                if (!writeTask(nodeId, operation, task)) break;
            }
        } catch {
            patchRun(nodeId, operation, { error: "暂时无法读取任务进度，请刷新状态；不会重复提交生成。" });
        } finally {
            if (operations.current.get(nodeId) === operation) operations.current.delete(nodeId);
        }
    }, [currentNode, patchRun, writeTask]);

    const reloadCapabilities = useCallback(async (signal?: AbortSignal) => {
        const result = await getModel3DCapabilities(signal);
        if (contextRef.current === context && !signal?.aborted && mounted.current) { setCapabilities(result); setCapabilityError(""); }
        return result;
    }, [context]);

    useEffect(() => {
        mounted.current = true;
        setCapabilities(null);
        setCapabilityError("");
        restored.current.clear();
        const controller = new AbortController();
        if (userId) void reloadCapabilities(controller.signal).catch(() => {
            if (!controller.signal.aborted) setCapabilityError("暂时无法读取 3D 服务配置，请刷新配置。");
        });
        return () => {
            mounted.current = false;
            controller.abort();
            operations.current.forEach((operation) => operation.controller.abort());
            operations.current.clear();
        };
    }, [context, reloadCapabilities, userId]);

    useEffect(() => {
        if (!capabilities?.available || !projectLoaded) return;
        setNodes((current) => current.map((node) => {
            if (node.type !== CanvasNodeType.Model3D) return node;
            const state = readModel3DState(node);
            if (state.draft.parameters.model) return node;
            return { ...node, metadata: { ...node.metadata, model3d: { ...state, draft: { ...state.draft, parameters: { ...state.draft.parameters, model: capabilities.defaultModel } } } } };
        }));
    }, [capabilities, projectLoaded, setNodes]);

    const refreshTask = useCallback(async (nodeId: string, recover = false) => {
        const node = nodesRef.current.find((item) => item.id === nodeId && item.type === CanvasNodeType.Model3D);
        const run = node?.metadata?.model3d?.run;
        if (!node || !run?.requestId || operations.current.has(nodeId) || !userId) return;
        if (recover && !run.canRetryStorage) return;
        const operation: Operation = { context, requestId: run.requestId, fingerprint: run.sourceFingerprint, controller: new AbortController(), kind: recover ? "recover" : "poll" };
        operations.current.set(nodeId, operation);
        let polling = false;
        try {
            const task = recover && run.taskId ? await recoverModel3DTask(run.taskId, operation.controller.signal) : run.taskId ? await getModel3DTask(run.taskId, operation.controller.signal) : await getModel3DTaskByRequest(run.requestId, operation.controller.signal);
            if (!task) { patchRun(nodeId, operation, { status: "submission_unknown", error: "暂未找到此请求的任务，请稍后刷新核实；不会自动重新提交。" }); return; }
            if (writeTask(nodeId, operation, task) && (task.status === "queued" || task.status === "running")) { polling = true; void poll(nodeId, operation, task); }
        } catch {
            patchRun(nodeId, operation, { error: recover ? "结果保存恢复失败，请稍后重试；未重新生成模型。" : "无法读取任务状态，请稍后刷新；未提交新的生成。" });
        } finally {
            if (!polling && operations.current.get(nodeId) === operation) operations.current.delete(nodeId);
        }
    }, [context, nodesRef, patchRun, poll, userId, writeTask]);

    useEffect(() => {
        operations.current.forEach((operation, nodeId) => {
            if (!currentNode(nodeId, operation)) { operation.controller.abort(); operations.current.delete(nodeId); }
        });
        if (!userId || !projectLoaded) return;
        for (const node of nodes) {
            const run = node.metadata?.model3d?.run;
            if (node.type !== CanvasNodeType.Model3D || !run || operations.current.has(node.id)) continue;
            const key = `${node.id}:${run.requestId}`;
            if (restored.current.has(key)) continue;
            restored.current.add(key);
            if (run.taskId && (isModel3DPending(run) || !node.metadata?.model3d?.result || run.canRetryStorage)) void refreshTask(node.id);
            else if (run.status === "submitting" || run.status === "submission_unknown") void refreshTask(node.id);
        }
    }, [currentNode, nodes, projectLoaded, refreshTask, setNodes, userId]);

    const generate = useCallback(async (nodeId: string) => {
        if (!userId || !projectLoaded || !projectId || operations.current.has(nodeId)) return;
        const node = nodesRef.current.find((item) => item.id === nodeId && item.type === CanvasNodeType.Model3D);
        if (!node) return;
        const state = readModel3DState(node);
        if (isModel3DPending(state.run) || state.run?.status === "submission_unknown" || state.run?.submissionOutcome === "unknown") return;
        const draft = structuredClone(state.draft);
        const originalFingerprint = model3DSourceFingerprint(draft, nodesRef.current, inputNodes(nodeId));
        const requestId = createClientId();
        const operation: Operation = { context, requestId, fingerprint: originalFingerprint, controller: new AbortController(), kind: "submit" };
        operations.current.set(nodeId, operation);
        setNodes((current) => current.map((item) => item.id === nodeId ? { ...item, metadata: { ...item.metadata, model3d: { ...readModel3DState(item), run: { requestId, sourceFingerprint: originalFingerprint, snapshot: draft, status: "submitting" } } } } : item));
        const assertCurrent = () => {
            const current = currentNode(nodeId, operation);
            if (!current || model3DSourceFingerprint(readModel3DState(current).draft, nodesRef.current, inputNodes(nodeId)) !== operation.fingerprint) throw new DOMException("3D 输入已更改", "AbortError");
        };
        let submitted = false;
        let polling = false;
        try {
            const latest = await reloadCapabilities(operation.controller.signal);
            assertCurrent();
            const error = model3DInputError(draft, nodesRef.current, inputNodes(nodeId), latest);
            if (error) throw new Error(error);
            const snapshot = structuredClone(draft);
            snapshot.parameters = normalizeModel3DParameters(draft.mode, draft.parameters, latest);
            snapshot.prompt = draft.mode === "text" ? model3DPrompt(draft, inputNodes(nodeId)) : "";
            const replacements = new Map<string, Model3DImageBinding>();
            const prepare = async (binding: Model3DImageBinding | undefined) => {
                const original = resolveModel3DImage(binding, nodesRef.current);
                if (!original) throw new Error("参考图片已删除，请重新选择。");
                const result = await ensureImageResource(original, latest, userId, assertCurrent);
                assertCurrent();
                if (original.sourceNodeId) replacements.set(original.sourceNodeId, result);
                return result;
            };
            if (draft.mode === "image") snapshot.image = await prepare(draft.image);
            if (draft.mode === "multiview") for (const view of MODEL3D_VIEWS) if (draft.views[view]) snapshot.views[view] = await prepare(draft.views[view]);
            assertCurrent();
            // Upload normalization and the submitted draft are committed together, before paid admission.
            const uploaded = nodesRef.current.map((item) => {
                const reference = replacements.get(item.id);
                return reference ? { ...item, metadata: { ...item.metadata, storageKey: reference.storageKey, content: reference.url, mimeType: reference.mimeType, bytes: reference.bytes } } : item;
            });
            const target = uploaded.find((item) => item.id === nodeId)!;
            const nextDraft = { ...draft, parameters: { ...snapshot.parameters }, image: draft.mode === "image" ? snapshot.image : draft.image, views: draft.mode === "multiview" ? snapshot.views : draft.views };
            operation.fingerprint = model3DSourceFingerprint(nextDraft, uploaded, inputNodes(nodeId));
            setNodes(uploaded.map((item) => item.id === nodeId ? { ...target, metadata: { ...target.metadata, model3d: { ...readModel3DState(target), draft: nextDraft, run: { requestId, sourceFingerprint: operation.fingerprint, snapshot, status: "submitting" } } } } : item));
            const payload: Model3DCreateRequest = { requestId, canvasId: projectId, nodeId, sourceFingerprint: operation.fingerprint, mode: draft.mode, parameters: snapshot.parameters, expectedPolicyRevision: latest.policyRevision,
                ...(draft.mode === "text" ? { prompt: snapshot.prompt } : {}),
                ...(draft.mode === "image" ? { imageResourceId: snapshot.image!.resourceId } : {}),
                ...(draft.mode === "multiview" ? { views: Object.fromEntries(MODEL3D_VIEWS.filter((view) => snapshot.views[view]).map((view) => [view, snapshot.views[view]!.resourceId])) as Model3DCreateRequest["views"] } : {}),
            };
            if (!currentNode(nodeId, operation)) return;
            submitted = true;
            const task = await createModel3DTask(payload, operation.controller.signal);
            if (!writeTask(nodeId, operation, task)) throw new Error("任务响应与当前画布请求不匹配。");
            if (task.status === "queued" || task.status === "running") { polling = true; void poll(nodeId, operation, task); }
        } catch (cause) {
            const knownRejection = cause instanceof ApiError && Boolean(cause.reason && cause.status && [400, 401, 403, 404, 409, 413, 415, 422, 429].includes(cause.status));
            patchRun(nodeId, operation, { status: submitted && !knownRejection ? "submission_unknown" : "failed", submissionOutcome: submitted && !knownRejection ? "unknown" : "not_submitted", error: submitted && !knownRejection ? "提交结果未知，请先在任务中心核实；不会自动重新提交。" : cause instanceof Error ? cause.message : "生成未提交，请稍后重试。" });
        } finally {
            if (!polling && operations.current.get(nodeId) === operation) operations.current.delete(nodeId);
        }
    }, [context, currentNode, inputNodes, nodesRef, patchRun, poll, projectId, projectLoaded, reloadCapabilities, setNodes, userId, writeTask]);

    const uploadImage = useCallback(async (file: File): Promise<Model3DImageBinding> => {
        if (!userId) throw new Error("请先登录。");
        const limits = capabilities || await reloadCapabilities();
        validateImage(file.type, file.size, limits);
        const startedContext = context;
        const resource = await uploadResourceFile(file, "image");
        if (contextRef.current !== startedContext || useUserStore.getState().user?.id !== userId) throw new DOMException("画布已切换", "AbortError");
        return { resourceId: resource.id, storageKey: resourceStorageKey(resource.id), url: resourceFileUrl(resource.id), mimeType: resource.mimeType, bytes: resource.size, title: file.name };
    }, [capabilities, context, reloadCapabilities, userId]);

    return { capabilities, capabilityError, reloadCapabilities: () => reloadCapabilities().catch(() => setCapabilityError("无法读取服务配置，请稍后刷新。")), generate, refreshTask, inputNodes, uploadImage };
}

function validateImage(mime: string | undefined, bytes: number | undefined, capabilities: Model3DCapabilities) {
    if (mime && !capabilities.inputLimits.mimeTypes.includes(mime)) throw new Error("当前 3D 服务不支持此图片格式，请使用 PNG 或 JPEG。");
    if (bytes && bytes > capabilities.inputLimits.maxBytes) throw new Error(`参考图片不能超过 ${Math.floor(capabilities.inputLimits.maxBytes / 1024 / 1024)} MB。`);
}

async function ensureImageResource(binding: Model3DImageBinding, capabilities: Model3DCapabilities, userId: string, assertCurrent: () => void): Promise<Model3DImageBinding> {
    validateImage(binding.mimeType, binding.bytes, capabilities);
    const resourceId = binding.resourceId || resourceIdFromStorageKey(binding.storageKey);
    if (resourceId) return { ...binding, resourceId, storageKey: resourceStorageKey(resourceId), url: resourceFileUrl(resourceId) };
    let blob: Blob | undefined;
    if (binding.storageKey) {
        const owner = binding.storageKey.split(":")[1];
        if (owner && owner !== "guest" && owner !== userId) throw new Error("参考图片属于其他账号的本地缓存，请重新选择。");
        blob = await (binding.storageKey.startsWith("image:") ? getImageBlob(binding.storageKey) : getMediaBlob(binding.storageKey)) || undefined;
    } else if (binding.url?.startsWith("data:image/") || binding.url?.startsWith("blob:")) {
        const response = await fetch(binding.url, { credentials: "omit" });
        if (!response.ok) throw new Error("参考图片读取失败。");
        blob = await response.blob();
    }
    assertCurrent();
    if (blob) validateImage(blob.type, blob.size, capabilities);
    const resource = blob ? await uploadResourceFile(blob, "image", { idempotencyKey: binding.storageKey }) : /^https?:\/\//i.test(binding.url || "") ? await importResourceFromUrl(binding.url!, "image") : undefined;
    assertCurrent();
    if (!resource) throw new Error("参考图片原图不可用，请重新上传。");
    validateImage(resource.mimeType, resource.size, capabilities);
    return { ...binding, resourceId: resource.id, storageKey: resourceStorageKey(resource.id), url: resourceFileUrl(resource.id), mimeType: resource.mimeType, bytes: resource.size };
}

function delay(milliseconds: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
    });
}
