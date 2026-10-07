import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

import { currentImageModerationReport, imageModerationSourceIdentity, isImageModerationPending } from "@/lib/canvas/image-moderation";
import { createImageModerationCheck, getImageModerationAvailability, getImageModerationCheck, getLatestImageModerationCheck, type ModerationReport } from "@/services/api/image-moderation";
import { importResourceFromUrl, resourceFileUrl, resourceIdFromStorageKey, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { getImageBlob } from "@/services/image-storage";
import { getMediaBlob } from "@/services/file-storage";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

type Input = {
    projectId: string;
    projectLoaded: boolean;
    nodes: CanvasNodeData[];
    nodesRef: RefObject<CanvasNodeData[]>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
};
type Operation = { controller: AbortController; identity: string; context: string; kind: "restore" | "create" | "poll" };

export function useCanvasImageModeration({ projectId, projectLoaded, nodes, nodesRef, setNodes }: Input) {
    const userId = useUserStore((state) => state.user?.id || "");
    const context = `${userId}:${projectId}`;
    const contextRef = useRef(context);
    contextRef.current = context;
    const mounted = useRef(true);
    const operations = useRef(new Map<string, Operation>());
    const latestRequests = useRef(new Map<string, Promise<ModerationReport | null>>());
    const restored = useRef(new Set<string>());
    const [available, setAvailable] = useState<boolean | null>(null);
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [busyNodeId, setBusyNodeId] = useState<string | null>(null);
    const [busyKind, setBusyKind] = useState<"read" | "submit">("read");
    const [error, setError] = useState("");
    const selectedRef = useRef(selectedNodeId);
    selectedRef.current = selectedNodeId;

    const currentNode = useCallback(
        (nodeId: string, operation: Operation) => {
            if (!mounted.current || operation.controller.signal.aborted || operation.context !== contextRef.current || !userId || useUserStore.getState().user?.id !== userId) return undefined;
            const node = nodesRef.current.find((item) => item.id === nodeId && item.type === CanvasNodeType.Image);
            return node && imageModerationSourceIdentity(node) === operation.identity ? node : undefined;
        },
        [nodesRef, userId],
    );

    const writeReport = useCallback(
        (nodeId: string, operation: Operation, report: ModerationReport) => {
            if (!currentNode(nodeId, operation)) return false;
            setNodes((current) =>
                current.map((node) =>
                    node.id === nodeId && currentNode(nodeId, operation) && imageModerationSourceIdentity(node) === operation.identity ? { ...node, metadata: { ...node.metadata, imageModeration: { sourceIdentity: operation.identity, report } } } : node,
                ),
            );
            return true;
        },
        [currentNode, setNodes],
    );

    const clearReport = useCallback(
        (nodeId: string, operation: Operation) => {
            if (!currentNode(nodeId, operation)?.metadata?.imageModeration) return;
            setNodes((current) =>
                current.map((node) => (node.id === nodeId && currentNode(nodeId, operation) && imageModerationSourceIdentity(node) === operation.identity ? { ...node, metadata: { ...node.metadata, imageModeration: undefined } } : node)),
            );
        },
        [currentNode, setNodes],
    );

    const poll = useCallback(
        async (nodeId: string, operation: Operation, initial: ModerationReport) => {
            operation.kind = "poll";
            let report = initial;
            try {
                while (isImageModerationPending(report) && currentNode(nodeId, operation)) {
                    await abortableDelay(2500, operation.controller.signal);
                    if (!currentNode(nodeId, operation)) break;
                    report = await getImageModerationCheck(report.checkId, operation.controller.signal);
                    if (!writeReport(nodeId, operation, report)) break;
                }
            } catch {
                if (currentNode(nodeId, operation) && selectedRef.current === nodeId) setError("暂时无法读取检测进度，请刷新状态。检测不会重复提交。");
            } finally {
                if (operations.current.get(nodeId) === operation) operations.current.delete(nodeId);
            }
        },
        [currentNode, writeReport],
    );

    const loadLatest = useCallback(
        (node: CanvasNodeData, operation: Operation) => {
            const resourceId = resourceIdFromStorageKey(node.metadata?.storageKey);
            if (!resourceId) return Promise.resolve(null);
            const key = `${context}:${resourceId}`;
            let request = latestRequests.current.get(key);
            if (!request) {
                request = getLatestImageModerationCheck(resourceId, operation.controller.signal).finally(() => {
                    if (latestRequests.current.get(key) === request) latestRequests.current.delete(key);
                });
                latestRequests.current.set(key, request);
            }
            return request;
        },
        [context],
    );

    useEffect(() => {
        mounted.current = true;
        setAvailable(null);
        setSelectedNodeId(null);
        setBusyNodeId(null);
        setError("");
        restored.current.clear();
        latestRequests.current.clear();
        const controller = new AbortController();
        if (userId) {
            getImageModerationAvailability(controller.signal)
                .then((result) => {
                    if (contextRef.current !== context || controller.signal.aborted) return;
                    setAvailable(result.available);
                })
                .catch(() => {});
        }
        return () => {
            mounted.current = false;
            controller.abort();
            operations.current.forEach((operation) => operation.controller.abort());
            operations.current.clear();
        };
    }, [context, userId]);

    useEffect(() => {
        operations.current.forEach((operation, nodeId) => {
            if (!currentNode(nodeId, operation)) {
                operation.controller.abort();
                operations.current.delete(nodeId);
            }
        });
        if (!userId || !projectLoaded) return;
        for (const node of nodes) {
            const identity = imageModerationSourceIdentity(node);
            const resourceId = resourceIdFromStorageKey(node.metadata?.storageKey);
            const key = `${node.id}:${identity}`;
            if (node.type !== CanvasNodeType.Image || !resourceId || restored.current.has(key) || operations.current.has(node.id)) continue;
            restored.current.add(key);
            const operation: Operation = { controller: new AbortController(), identity, context, kind: "restore" };
            operations.current.set(node.id, operation);
            // 刷新和生成结果更新仅恢复报告，绝不创建检测作业。
            void loadLatest(node, operation)
                .then((report) => {
                    if (report && writeReport(node.id, operation, report) && isImageModerationPending(report)) return poll(node.id, operation, report);
                    if (!report) clearReport(node.id, operation);
                    if (operations.current.get(node.id) === operation) operations.current.delete(node.id);
                })
                .catch(() => {
                    if (operations.current.get(node.id) === operation) operations.current.delete(node.id);
                });
        }
    }, [clearReport, context, currentNode, loadLatest, nodes, poll, projectLoaded, userId, writeReport]);

    const startCheck = useCallback(
        async (nodeId: string, force: boolean) => {
            setSelectedNodeId(nodeId);
            selectedRef.current = nodeId;
            setError("");
            if (!userId) {
                setError("请登录后检测图片内容。");
                return;
            }
            const node = nodesRef.current.find((item) => item.id === nodeId && item.type === CanvasNodeType.Image);
            if (!node || !imageModerationSourceIdentity(node)) return;
            const existing = currentImageModerationReport(node);
            const active = operations.current.get(nodeId);
            if (active && currentNode(nodeId, active)) {
                if (active.kind !== "restore" || isImageModerationPending(existing)) return;
                // 等待刷新时的只读查询，避免首次打开与恢复查询争抢。
                try {
                    const latest = await loadLatest(node, active);
                    if (!currentNode(nodeId, active)) return;
                    if (latest) {
                        writeReport(nodeId, active, latest);
                        if (!force || isImageModerationPending(latest)) return;
                    }
                } catch {
                    if (currentNode(nodeId, active)) setError("无法读取已有报告，请稍后重试。未提交新的检测。");
                    return;
                }
                const replacement = operations.current.get(nodeId);
                if (replacement && replacement !== active && currentNode(nodeId, replacement)) return;
                if (operations.current.get(nodeId) === active) operations.current.delete(nodeId);
            }
            if (!force && existing) {
                const operation: Operation = { controller: new AbortController(), identity: imageModerationSourceIdentity(node), context, kind: "restore" };
                operations.current.set(nodeId, operation);
                setBusyNodeId(nodeId);
                setBusyKind("read");
                let polling = false;
                try {
                    // 每次打开已有报告都读取服务端最新状态，后台策略切换和失败复检不会回退成旧的绿色结论。
                    const latest = await loadLatest(node, operation);
                    if (!currentNode(nodeId, operation)) return;
                    if (latest && writeReport(nodeId, operation, latest) && isImageModerationPending(latest)) {
                        polling = true;
                        void poll(nodeId, operation, latest);
                    }
                    if (!latest) clearReport(nodeId, operation);
                } catch {
                    if (currentNode(nodeId, operation)) setError("暂时无法更新报告状态，显示的是上次保存的结果。");
                } finally {
                    if (!polling && operations.current.get(nodeId) === operation) operations.current.delete(nodeId);
                    if (contextRef.current === context) setBusyNodeId((current) => (current === nodeId ? null : current));
                }
                return;
            }
            const operation: Operation = { controller: new AbortController(), identity: imageModerationSourceIdentity(node), context, kind: "create" };
            operations.current.set(nodeId, operation);
            setBusyNodeId(nodeId);
            setBusyKind("submit");
            let polling = false;
            let submittedResourceId = "";
            try {
                const availability = await getImageModerationAvailability(operation.controller.signal);
                if (!currentNode(nodeId, operation)) return;
                const serviceAvailable = availability.available;
                setAvailable(serviceAvailable);
                if (!serviceAvailable) throw new Error("图片检测服务未配置，请联系管理员。");
                let resourceId = resourceIdFromStorageKey(node.metadata?.storageKey);
                if (!force && resourceId) {
                    const latest = await loadLatest(node, operation);
                    if (!currentNode(nodeId, operation)) return;
                    if (latest) {
                        writeReport(nodeId, operation, latest);
                        if (isImageModerationPending(latest)) {
                            polling = true;
                            void poll(nodeId, operation, latest);
                        }
                        return;
                    }
                }
                if (!resourceId) {
                    const storageKey = await uploadOriginalImage(node, userId, () => {
                        if (!currentNode(nodeId, operation)) throw new DOMException("图片检测请求已失效", "AbortError");
                    });
                    if (!currentNode(nodeId, operation)) return;
                    resourceId = resourceIdFromStorageKey(storageKey);
                    if (!resourceId) throw new Error("图片原图尚未保存到服务器，请稍后重试。");
                    setNodes((current) =>
                        current.map((item) =>
                            item.id === nodeId && imageModerationSourceIdentity(item) === operation.identity ? { ...item, metadata: { ...item.metadata, storageKey, content: resourceFileUrl(resourceId), imageModeration: undefined } } : item,
                        ),
                    );
                    operation.identity = storageKey;
                    if (!force) {
                        const uploadedNode = currentNode(nodeId, operation);
                        if (!uploadedNode) return;
                        const latest = await loadLatest(uploadedNode, operation);
                        if (!currentNode(nodeId, operation)) return;
                        if (latest) {
                            writeReport(nodeId, operation, latest);
                            if (isImageModerationPending(latest)) {
                                polling = true;
                                void poll(nodeId, operation, latest);
                            }
                            return;
                        }
                    }
                }
                if (!currentNode(nodeId, operation)) return;
                restored.current.add(`${nodeId}:${operation.identity}`);
                submittedResourceId = resourceId;
                const report = await createImageModerationCheck(resourceId, operation.controller.signal);
                if (!writeReport(nodeId, operation, report)) return;
                if (isImageModerationPending(report)) {
                    polling = true;
                    void poll(nodeId, operation, report);
                }
            } catch (cause) {
                if (submittedResourceId && currentNode(nodeId, operation)) {
                    // 提交响应丢失时只查询一次服务端状态，不自动重发会产生费用的 POST。
                    try {
                        const latest = await getLatestImageModerationCheck(submittedResourceId, operation.controller.signal);
                        if (!currentNode(nodeId, operation)) return;
                        if (latest) {
                            writeReport(nodeId, operation, latest);
                            if (latest.checkId !== existing?.checkId) {
                                if (isImageModerationPending(latest)) {
                                    polling = true;
                                    void poll(nodeId, operation, latest);
                                }
                                return;
                            }
                        }
                    } catch {
                        clearReport(nodeId, operation);
                    }
                }
                if (currentNode(nodeId, operation) && selectedRef.current === nodeId) setError(cause instanceof Error ? cause.message : "检测提交失败，请稍后重试。");
            } finally {
                if (!polling && operations.current.get(nodeId) === operation) operations.current.delete(nodeId);
                if (contextRef.current === context) setBusyNodeId((current) => (current === nodeId ? null : current));
            }
        },
        [clearReport, context, currentNode, loadLatest, nodesRef, poll, setNodes, userId, writeReport],
    );

    const open = useCallback(
        (node: CanvasNodeData) => {
            void startCheck(node.id, false);
        },
        [startCheck],
    );
    const refresh = useCallback(() => {
        const node = nodesRef.current.find((item) => item.id === selectedNodeId);
        const report = node && currentImageModerationReport(node);
        if (!node || !report || operations.current.has(node.id)) return;
        const operation: Operation = { controller: new AbortController(), identity: imageModerationSourceIdentity(node), context, kind: "poll" };
        operations.current.set(node.id, operation);
        setError("");
        void getImageModerationCheck(report.checkId, operation.controller.signal)
            .then((latest) => {
                if (writeReport(node.id, operation, latest) && isImageModerationPending(latest)) return poll(node.id, operation, latest);
                operations.current.delete(node.id);
            })
            .catch(() => {
                if (currentNode(node.id, operation)) setError("暂时无法读取检测结果，请稍后刷新状态。");
                if (operations.current.get(node.id) === operation) operations.current.delete(node.id);
            });
    }, [context, currentNode, nodesRef, poll, selectedNodeId, writeReport]);
    const selectedNode = nodes.find((node) => node.id === selectedNodeId && node.type === CanvasNodeType.Image) || null;
    return {
        open,
        selectedNode,
        report: selectedNode ? currentImageModerationReport(selectedNode) || null : null,
        stale: Boolean(selectedNode?.metadata?.imageModeration && !currentImageModerationReport(selectedNode)),
        available,
        error,
        busy: busyNodeId === selectedNodeId && selectedNodeId !== null,
        submitting: busyKind === "submit",
        canCheck: Boolean(userId),
        close: () => setSelectedNodeId(null),
        recheck: () => {
            if (selectedNodeId) void startCheck(selectedNodeId, Boolean(selectedNode?.metadata?.imageModeration));
        },
        refresh,
    };
}

async function uploadOriginalImage(node: CanvasNodeData, userId: string, assertCurrent: () => void) {
    const metadata = node.metadata || {};
    if (metadata.storageKey) {
        const scope = metadata.storageKey.split(":")[1];
        if (scope && scope !== "guest" && scope !== userId) throw new Error("当前图片来自其他账号的本地缓存，请重新加载画布。");
        const blob = metadata.storageKey.startsWith("image:") ? await getImageBlob(metadata.storageKey) : await getMediaBlob(metadata.storageKey);
        if (!blob) throw new Error("本地图片原图不存在，请重新上传图片。");
        assertCurrent();
        const resource = await uploadResourceFile(blob, "image", { width: metadata.naturalWidth, height: metadata.naturalHeight, idempotencyKey: metadata.storageKey });
        return resourceStorageKey(resource.id);
    }
    const content = metadata.content || "";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    const identity = `image-moderation:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    assertCurrent();
    if (content.startsWith("data:image/") || content.startsWith("blob:")) {
        const response = await fetch(content, { credentials: "omit" });
        if (!response.ok) throw new Error("图片原图读取失败");
        const blob = await response.blob();
        assertCurrent();
        const resource = await uploadResourceFile(blob, "image", { width: metadata.naturalWidth, height: metadata.naturalHeight, idempotencyKey: identity });
        return resourceStorageKey(resource.id);
    }
    if (/^https?:\/\//i.test(content)) {
        const resource = await importResourceFromUrl(content, "image", { width: metadata.naturalWidth, height: metadata.naturalHeight, idempotencyKey: identity });
        return resourceStorageKey(resource.id);
    }
    throw new Error("图片原图不可用，请重新上传图片。");
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException("请求已取消", "AbortError"));
            return;
        }
        const abort = () => {
            clearTimeout(timer);
            reject(new DOMException("请求已取消", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, milliseconds);
        signal.addEventListener("abort", abort, { once: true });
    });
}
