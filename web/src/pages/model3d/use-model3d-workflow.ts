import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";

import { model3DFaceRange, type Model3DDraft, type Model3DImageBinding } from "@/lib/canvas/model3d";
import { createClientId } from "@/lib/client-id";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import {
    createModel3DTask,
    getModel3DCapabilities,
    getModel3DTask,
    getModel3DTaskByRequest,
    getModel3DSegmentation,
    listModel3DTasks,
    recoverModel3DTask,
    type Model3DCapabilities,
    type Model3DTaskView,
    type Model3DCreateRequest,
    type Model3DProcessing,
    type Model3DProcessingRequest,
} from "@/services/api/model3d";
import { ApiError } from "@/services/api/request";
import { resourceFileUrl, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { useUserStore } from "@/stores/use-user-store";
import { defaultModel3DDraft, isActiveModel3DTask, isReusedModel3DSegmentation, mergeModel3DTasks, model3DPendingTask, model3DTaskDraft, standaloneModel3DRequest, validateModel3DImage, type Model3DWorkflowTask } from "./model3d-workflow-state";
import { model3DProcessingOptions } from "./model3d-processing-state";

export type { Model3DWorkflowTask } from "./model3d-workflow-state";

type State = {
    owner: string;
    capabilities: Model3DCapabilities | null;
    draft: Model3DDraft;
    count: number;
    tasks: Model3DWorkflowTask[];
    selectedTaskId: string;
    loading: boolean;
    refreshing: boolean;
    loadingMore: boolean;
    submitting: boolean;
    uploading: boolean;
    error: string;
    nextCursor?: string;
    hydrated: boolean;
};
type Operation = { owner: string; controller: AbortController };
type Journal = { version: 1; draft: Model3DDraft; count: number; selectedTaskId: string; pending: Model3DWorkflowTask[] };
const STORAGE_KEY = "model3d:standalone-workflow:v1";
const initialState = (owner: string): State => ({
    owner,
    capabilities: null,
    draft: defaultModel3DDraft(),
    count: 1,
    tasks: [],
    selectedTaskId: "",
    loading: Boolean(owner),
    refreshing: false,
    loadingMore: false,
    submitting: false,
    uploading: false,
    error: "",
    hydrated: false,
});
const aborted = () => new DOMException("账号或页面已切换", "AbortError");
const isAbort = (cause: unknown) => cause instanceof DOMException && cause.name === "AbortError";
const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

function journal(state: State): Journal {
    return { version: 1, draft: state.draft, count: state.count, selectedTaskId: state.selectedTaskId, pending: state.tasks.filter((task) => task.localStatus) };
}

function readJournal(raw: string | null): Journal | null {
    if (!raw || raw.length > 256000) return null;
    try {
        const data = JSON.parse(raw) as Journal;
        if (
            data.version !== 1 ||
            !data.draft ||
            !["text", "image", "multiview"].includes(data.draft.mode) ||
            typeof data.draft.prompt !== "string" ||
            !data.draft.views ||
            !data.draft.parameters ||
            typeof data.draft.parameters.model !== "string" ||
            typeof data.draft.parameters.texture !== "boolean" ||
            typeof data.draft.parameters.pbr !== "boolean"
        )
            return null;
        return {
            ...data,
            count: Number.isInteger(data.count) && data.count >= 1 && data.count <= 4 ? data.count : 1,
            selectedTaskId: typeof data.selectedTaskId === "string" ? data.selectedTaskId : "",
            pending: Array.isArray(data.pending)
                ? data.pending
                      .filter((task) => task.scope === "standalone" && task.requestId && task.localStatus && (task.snapshot || (task.processing?.sourceTaskId && ["segment", "complete", "rig_check", "rig", "animate"].includes(task.processing.operation))))
                      .slice(0, 100)
                : [],
        };
    } catch {
        return null;
    }
}

export function useModel3DWorkflow() {
    const userId = useUserStore((state) => state.user?.id || "");
    const [stored, setStored] = useState<State>(() => initialState(userId));
    const state = stored.owner === userId ? stored : initialState(userId);
    const stateRef = useRef(state);
    stateRef.current = state;
    const ownerRef = useRef(userId);
    ownerRef.current = userId;
    const mounted = useRef(false);
    const edited = useRef(false);
    const operations = useRef(new Map<string, Operation>());
    const writes = useRef<Promise<unknown>>(Promise.resolve());

    const current = useCallback((operation: Operation) => mounted.current && !operation.controller.signal.aborted && operation.owner === ownerRef.current && Boolean(operation.owner) && useUserStore.getState().user?.id === operation.owner, []);
    const update = useCallback((owner: string, change: (state: State) => State) => {
        if (!mounted.current || ownerRef.current !== owner || useUserStore.getState().user?.id !== owner) return;
        setStored((previous) => {
            if (previous.owner !== owner || ownerRef.current !== owner) return previous;
            const next = change(previous);
            stateRef.current = next;
            return next;
        });
    }, []);
    const begin = useCallback(
        (key: string): Operation | undefined => {
            if (!userId || !mounted.current || useUserStore.getState().user?.id !== userId || operations.current.has(key)) return;
            const operation = { owner: userId, controller: new AbortController() };
            operations.current.set(key, operation);
            return operation;
        },
        [userId],
    );
    const finish = useCallback((key: string, operation: Operation) => {
        if (operations.current.get(key) === operation) operations.current.delete(key);
    }, []);
    const persist = useCallback((snapshot: State) => {
        const raw = JSON.stringify(journal(snapshot));
        const write = writes.current.catch(() => undefined).then(() => localForageStorageForScope(snapshot.owner).setItem(STORAGE_KEY, raw));
        writes.current = write;
        return write;
    }, []);
    const readWithRetry = useCallback(
        async <T>(operation: Operation, read: () => Promise<T>): Promise<T> => {
            let failures = 0;
            for (;;) {
                if (!current(operation)) throw aborted();
                try {
                    const value = await read();
                    if (!current(operation)) throw aborted();
                    return value;
                } catch (cause) {
                    if (!current(operation) || isAbort(cause)) throw aborted();
                    if (!(cause instanceof ApiError) || !cause.retryable) throw cause;
                    update(operation.owner, (previous) => ({ ...previous, error: "暂时无法读取任务，正在自动重试；不会重复提交生成。" }));
                    await delay(Math.max(Math.min(30000, 2500 * 2 ** Math.min(failures++, 4)), cause.retryAfterMs || 0), operation.controller.signal);
                }
            }
        },
        [current, update],
    );
    const accept = useCallback(
        (operation: Operation, task: Model3DTaskView, expected?: Model3DWorkflowTask) => {
            if (!current(operation)) return false;
            const reused = isReusedModel3DSegmentation(task, expected);
            if (
                task.scope !== "standalone" ||
                task.clientContext.canvasId ||
                task.clientContext.nodeId ||
                (!reused && ((expected?.requestId && task.requestId !== expected.requestId) || (expected && task.sourceFingerprint !== expected.sourceFingerprint)))
            )
                throw new Error("任务响应与此独立请求不匹配。");
            update(operation.owner, (previous) => {
                const replaced = previous.tasks.find((item) => item.id === task.id || Boolean(task.requestId && item.requestId === task.requestId));
                const tasks = reused ? previous.tasks.filter((item) => item.id !== expected!.id) : previous.tasks;
                return {
                    ...previous,
                    error: "",
                    tasks: mergeModel3DTasks(tasks, [task]),
                    selectedTaskId: !previous.selectedTaskId || previous.selectedTaskId === replaced?.id || (reused && previous.selectedTaskId === expected!.id) ? task.id : previous.selectedTaskId,
                };
            });
            return true;
        },
        [current, update],
    );

    const monitor = useCallback(
        async (initial: Model3DWorkflowTask) => {
            const key = `task:${initial.requestId || initial.id}`;
            const operation = begin(key);
            if (!operation) return;
            let task = initial;
            try {
                for (;;) {
                    const next = await readWithRetry(operation, () => (task.localStatus ? getModel3DTaskByRequest(task.requestId!, operation.controller.signal) : getModel3DTask(task.id, operation.controller.signal)));
                    if (next) {
                        accept(operation, next, task);
                        task = { ...next, snapshot: task.snapshot };
                        if (!isActiveModel3DTask(task)) break;
                    } else {
                        task = { ...task, localStatus: "submission_unknown", stage: "submission_unknown", submissionOutcome: "unknown", localError: "暂未找到此请求的任务，正在核实；不会自动重新提交。" };
                        update(operation.owner, (previous) => ({ ...previous, tasks: mergeModel3DTasks(previous.tasks, [task]) }));
                    }
                    await delay(2500, operation.controller.signal);
                }
            } catch (cause) {
                if (!isAbort(cause) && current(operation)) update(operation.owner, (previous) => ({ ...previous, error: `任务状态读取已停止：${message(cause, "请稍后刷新任务。")}` }));
            } finally {
                finish(key, operation);
            }
        },
        [accept, begin, current, finish, readWithRetry, update],
    );

    const refresh = useCallback(async () => {
        const operation = begin("list");
        if (!operation) return;
        update(operation.owner, (previous) => ({ ...previous, refreshing: true }));
        try {
            const results = await Promise.allSettled([
                readWithRetry(operation, () => getModel3DCapabilities(operation.controller.signal)).then((capabilities) =>
                    update(operation.owner, (previous) => {
                        let draft = previous.draft;
                        if (!draft.parameters.model) {
                            const parameters = { ...draft.parameters, model: capabilities.defaultModel };
                            const maximum = model3DFaceRange(parameters, capabilities).max;
                            draft = { ...draft, parameters: { ...parameters, faceLimit: Math.min(parameters.faceLimit || 100000, maximum || 100000) } };
                        }
                        return { ...previous, capabilities, draft };
                    }),
                ),
                readWithRetry(operation, () => listModel3DTasks({ scope: "standalone", limit: 30 }, operation.controller.signal)).then((page) => {
                    for (const task of page.tasks) accept(operation, task);
                    update(operation.owner, (previous) => ({ ...previous, nextCursor: page.nextCursor }));
                }),
                (async () => {
                    let cursor: string | undefined;
                    const seen = new Set<string>();
                    do {
                        const page = await readWithRetry(operation, () => listModel3DTasks({ scope: "standalone", limit: 100, activeOnly: true, cursor }, operation.controller.signal));
                        for (const task of page.tasks) {
                            accept(operation, task);
                            void monitor(task);
                        }
                        cursor = page.nextCursor;
                        if (cursor && seen.has(cursor)) throw new Error("任务分页游标重复，请稍后刷新。");
                        if (cursor) seen.add(cursor);
                    } while (cursor && current(operation));
                })(),
            ]);
            for (const result of results) if (result.status === "rejected" && !isAbort(result.reason)) throw result.reason;
            if (current(operation)) {
                for (const task of stateRef.current.tasks) if (isActiveModel3DTask(task)) void monitor(task);
            }
        } catch (cause) {
            if (!isAbort(cause) && current(operation)) update(operation.owner, (previous) => ({ ...previous, error: message(cause, "无法读取独立 3D 任务，请刷新重试。") }));
        } finally {
            if (current(operation)) update(operation.owner, (previous) => ({ ...previous, loading: false, refreshing: false }));
            finish("list", operation);
        }
    }, [accept, begin, current, finish, monitor, readWithRetry, update]);

    useEffect(() => {
        mounted.current = true;
        edited.current = false;
        const fresh = initialState(userId);
        stateRef.current = fresh;
        setStored(fresh);
        const operation: Operation = { owner: userId, controller: new AbortController() };
        if (userId)
            void (async () => {
                try {
                    // Queue behind earlier writes so a quick remount cannot read an older draft or pending request.
                    await writes.current.catch(() => undefined);
                    const saved = readJournal(await localForageStorageForScope(userId).getItem(STORAGE_KEY));
                    if (!current(operation)) return;
                    update(userId, (previous) => ({
                        ...previous,
                        ...(!edited.current && saved ? { draft: saved.draft, count: saved.count } : {}),
                        selectedTaskId: saved?.selectedTaskId || "",
                        tasks: saved?.pending.map((task) => ({ ...task, localStatus: "submission_unknown", stage: "submission_unknown" })) || [],
                        hydrated: true,
                    }));
                } catch {
                    if (current(operation)) update(userId, (previous) => ({ ...previous, hydrated: true, error: "本机草稿暂时无法读取，服务端任务仍可恢复。" }));
                }
                if (current(operation)) {
                    for (const task of stateRef.current.tasks) if (task.localStatus) void monitor(task);
                    await refresh();
                }
            })();
        return () => {
            mounted.current = false;
            operation.controller.abort();
            operations.current.forEach((active) => active.controller.abort());
            operations.current.clear();
        };
    }, [current, monitor, refresh, update, userId]);

    useEffect(() => {
        if (!state.owner || !state.hydrated || state.owner !== userId) return;
        void persist(state).catch(() => {
            update(state.owner, (previous) => (previous.error ? previous : { ...previous, error: "本机草稿未能保存，服务端已接受的任务不受影响。" }));
        });
    }, [persist, state.owner, state.hydrated, state.draft, state.count, state.selectedTaskId, state.tasks, update, userId]);

    useEffect(() => {
        if (!userId || typeof window === "undefined") return;
        const onFocus = () => {
            if (typeof document === "undefined" || document.visibilityState === "visible") void refresh();
        };
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onFocus);
        return () => {
            window.removeEventListener("focus", onFocus);
            document.removeEventListener("visibilitychange", onFocus);
        };
    }, [refresh, userId]);

    const setDraft = useCallback(
        (value: SetStateAction<Model3DDraft>) => {
            edited.current = true;
            update(userId, (previous) => ({ ...previous, draft: typeof value === "function" ? value(previous.draft) : value }));
        },
        [update, userId],
    );
    const setCount = useCallback(
        (value: SetStateAction<number>) => {
            edited.current = true;
            update(userId, (previous) => {
                const count = typeof value === "function" ? value(previous.count) : value;
                return Number.isInteger(count) && count >= 1 && count <= 4 ? { ...previous, count } : previous;
            });
        },
        [update, userId],
    );
    const cancelTaskSelection = useCallback(() => {
        const pending = operations.current.get("selection");
        if (pending?.owner !== userId) return;
        pending.controller.abort();
        finish("selection", pending);
    }, [finish, userId]);
    const selectTask = useCallback(
        async (id: string) => {
            cancelTaskSelection();
            const operation = begin("selection");
            if (!operation) return;
            try {
                const existing = stateRef.current.tasks.find((task) => task.id === id);
                if (!existing) {
                    const source = await readWithRetry(operation, () => getModel3DTask(id, operation.controller.signal));
                    if (source.id !== id) throw new Error("来源任务响应与所选版本不匹配。");
                    if (!accept(operation, source)) return;
                }
                update(operation.owner, (previous) => (current(operation) && previous.tasks.some((task) => task.id === id) ? { ...previous, selectedTaskId: id } : previous));
            } catch (cause) {
                if (current(operation) && !isAbort(cause)) update(operation.owner, (previous) => ({ ...previous, error: message(cause, "来源任务读取失败。") }));
            } finally {
                finish("selection", operation);
            }
        },
        [accept, begin, cancelTaskSelection, current, finish, readWithRetry, update],
    );
    const reuseTask = useCallback(
        (id: string) => {
            const task = stateRef.current.tasks.find((item) => item.id === id);
            if (task) setDraft(model3DTaskDraft(task));
        },
        [setDraft],
    );

    const findSegmentation = useCallback(
        async (sourceTaskId: string) => {
            cancelTaskSelection();
            const key = "selection";
            const operation = begin(key);
            if (!operation) throw aborted();
            try {
                const task = await getModel3DSegmentation(sourceTaskId, operation.controller.signal);
                if (!current(operation)) throw aborted();
                if (!task) return false;
                if (task.processing?.operation !== "segment" || task.processing.sourceTaskId !== sourceTaskId) throw new Error("拆分结果与当前模型不匹配。");
                if (!accept(operation, task)) throw aborted();
                update(operation.owner, (previous) => ({ ...previous, selectedTaskId: task.id }));
                if (isActiveModel3DTask(task)) void monitor(task);
                return true;
            } finally {
                finish(key, operation);
            }
        },
        [accept, begin, cancelTaskSelection, current, finish, monitor, update],
    );

    const submitPrepared = useCallback(
        async (operation: Operation, request: Model3DCreateRequest | Model3DProcessingRequest, placeholder: Model3DWorkflowTask, select: boolean) => {
            if (!current(operation)) return "";
            // Persist the identity before POST. Recovery only queries this request and never resubmits it.
            await persist({ ...stateRef.current, tasks: mergeModel3DTasks(stateRef.current.tasks, [placeholder]), selectedTaskId: select ? placeholder.id : stateRef.current.selectedTaskId });
            if (!current(operation)) return "";
            if (select) cancelTaskSelection();
            update(operation.owner, (previous) => ({ ...previous, tasks: mergeModel3DTasks(previous.tasks, [placeholder]), selectedTaskId: select ? placeholder.id : previous.selectedTaskId }));
            try {
                const task = await createModel3DTask(request, operation.controller.signal);
                accept(operation, task, placeholder);
                if (isActiveModel3DTask(task)) void monitor(task);
                return "";
            } catch (cause) {
                if (!current(operation)) return "";
                const rejected = cause instanceof ApiError && Boolean(cause.reason && cause.status && [400, 401, 403, 404, 409, 413, 415, 422, 429].includes(cause.status));
                const error = rejected ? message(cause, "任务未提交成功。") : "提交结果未知，正在按请求核实；不会自动重新提交。";
                const failed: Model3DWorkflowTask = {
                    ...placeholder,
                    status: rejected ? "failed" : "queued",
                    stage: rejected ? "提交被拒绝" : "submission_unknown",
                    submissionOutcome: rejected ? "not_submitted" : "unknown",
                    localStatus: rejected ? undefined : "submission_unknown",
                    localError: error,
                    error: { code: "submission", reason: rejected ? "rejected" : "submission_unknown", message: error, retryClass: rejected ? "user" : "verify" },
                };
                update(operation.owner, (previous) => ({ ...previous, tasks: mergeModel3DTasks(previous.tasks, [failed]) }));
                if (!rejected) void monitor(failed);
                return error;
            }
        },
        [accept, cancelTaskSelection, current, monitor, persist, update],
    );

    const processModel = useCallback(
        async (processing: Model3DProcessing) => {
            if (stateRef.current.submitting || stateRef.current.uploading || !stateRef.current.hydrated) return;
            const operation = begin("submit");
            if (!operation) return;
            update(operation.owner, (previous) => ({ ...previous, submitting: true, error: "" }));
            try {
                if (processing.operation === "segment" && (await findSegmentation(processing.sourceTaskId))) return;
                const capabilities = await getModel3DCapabilities(operation.controller.signal);
                if (!current(operation)) return;
                update(operation.owner, (previous) => ({ ...previous, capabilities }));
                const source = stateRef.current.tasks.find((task) => task.id === processing.sourceTaskId);
                if (!capabilities.available || !capabilities.processingOperations?.includes(processing.operation) || !source || !model3DProcessingOptions(source).includes(processing.operation)) throw new Error("来源任务不支持此操作，请刷新后重新选择。");
                const request: Model3DProcessingRequest = { requestId: createClientId(), sourceFingerprint: createClientId(), scope: "standalone", expectedPolicyRevision: capabilities.policyRevision, processing: structuredClone(processing) };
                const pending: Model3DWorkflowTask = {
                    ...request,
                    id: `request:${request.requestId}`,
                    mode: source.mode,
                    prompt: source.prompt,
                    parameters: source.parameters,
                    status: "queued",
                    stage: "正在提交",
                    clientContext: { canvasId: "", nodeId: "" },
                    submissionOutcome: "unknown",
                    canRetryStorage: false,
                    localStatus: "submitting",
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                };
                const error = await submitPrepared(operation, request, pending, true);
                if (error) update(operation.owner, (previous) => ({ ...previous, error }));
            } catch (cause) {
                if (!isAbort(cause) && current(operation)) update(operation.owner, (previous) => ({ ...previous, error: message(cause, "处理任务未提交，请稍后重试。") }));
            } finally {
                if (current(operation)) update(operation.owner, (previous) => ({ ...previous, submitting: false }));
                finish("submit", operation);
            }
        },
        [begin, current, findSegmentation, finish, submitPrepared, update],
    );

    const generate = useCallback(
        async (draft = stateRef.current.draft, count = stateRef.current.count) => {
            if (stateRef.current.submitting || stateRef.current.uploading || !stateRef.current.hydrated) return;
            const operation = begin("submit");
            if (!operation) return;
            update(operation.owner, (previous) => ({ ...previous, submitting: true, error: "" }));
            try {
                const capabilities = await getModel3DCapabilities(operation.controller.signal);
                if (!current(operation)) return;
                update(operation.owner, (previous) => ({ ...previous, capabilities }));
                if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error("候选版本数量须为 1–4。");
                const groupId = createClientId();
                const candidates = Array.from({ length: count }, (_, index) => standaloneModel3DRequest(draft, capabilities, { requestId: createClientId(), groupId, candidateIndex: index + 1, candidateCount: count }));
                const pending = candidates.map(({ request, snapshot }) => model3DPendingTask(request, snapshot));
                const failures: string[] = [];
                for (let index = 0; index < candidates.length; index++) {
                    const { request } = candidates[index];
                    if (!current(operation)) return;
                    const error = await submitPrepared(operation, request, pending[index], index === 0);
                    if (error) failures.push(`候选 ${index + 1}：${error}`);
                }
                if (failures.length) update(operation.owner, (previous) => ({ ...previous, error: failures.join(" ") }));
            } catch (cause) {
                if (!isAbort(cause) && current(operation)) update(operation.owner, (previous) => ({ ...previous, error: message(cause, "生成未提交，请稍后重试。") }));
            } finally {
                if (current(operation)) update(operation.owner, (previous) => ({ ...previous, submitting: false }));
                finish("submit", operation);
            }
        },
        [begin, current, finish, submitPrepared, update],
    );

    const refreshTask = useCallback(
        async (id: string) => {
            const task = stateRef.current.tasks.find((item) => item.id === id);
            if (task) await monitor(task);
        },
        [monitor],
    );
    const recover = useCallback(
        async (id: string) => {
            const task = stateRef.current.tasks.find((item) => item.id === id);
            if (!task?.canRetryStorage || task.localStatus) return;
            const key = `task:${task.requestId || task.id}`;
            const operation = begin(key);
            if (!operation) return;
            let recovered: Model3DTaskView | undefined;
            try {
                recovered = await recoverModel3DTask(id, operation.controller.signal);
                accept(operation, recovered, task);
            } catch (cause) {
                if (!isAbort(cause) && current(operation)) update(operation.owner, (previous) => ({ ...previous, error: message(cause, "原任务保存恢复失败，请稍后重试。") }));
            } finally {
                finish(key, operation);
            }
            if (recovered && current(operation) && isActiveModel3DTask(recovered)) void monitor(recovered);
        },
        [accept, begin, current, finish, monitor, update],
    );
    const loadMore = useCallback(async () => {
        const cursor = stateRef.current.nextCursor;
        if (!cursor) return;
        const operation = begin("more");
        if (!operation) return;
        update(operation.owner, (previous) => ({ ...previous, loadingMore: true }));
        try {
            const page = await readWithRetry(operation, () => listModel3DTasks({ scope: "standalone", limit: 30, cursor }, operation.controller.signal));
            for (const task of page.tasks) {
                accept(operation, task);
                if (isActiveModel3DTask(task)) void monitor(task);
            }
            update(operation.owner, (previous) => ({ ...previous, nextCursor: page.nextCursor === cursor ? undefined : page.nextCursor }));
        } catch (cause) {
            if (!isAbort(cause) && current(operation)) update(operation.owner, (previous) => ({ ...previous, error: message(cause, "历史任务读取失败，请重试。") }));
        } finally {
            if (current(operation)) update(operation.owner, (previous) => ({ ...previous, loadingMore: false }));
            finish("more", operation);
        }
    }, [accept, begin, current, finish, monitor, readWithRetry, update]);
    const uploadImage = useCallback(
        async (file: File): Promise<Model3DImageBinding> => {
            const key = `upload:${createClientId()}`;
            const operation = begin(key);
            if (!operation) throw new Error("请先登录。");
            update(operation.owner, (previous) => ({ ...previous, uploading: true }));
            try {
                const capabilities = stateRef.current.capabilities || (await getModel3DCapabilities(operation.controller.signal));
                if (!current(operation)) throw aborted();
                validateModel3DImage(file, capabilities);
                const dimensions = await readImageDimensions(file, operation.controller.signal);
                validateModel3DImage(file, capabilities, dimensions);
                if (!current(operation)) throw aborted();
                const resource = await uploadResourceFile(file, "image", { ...dimensions, idempotencyKey: key });
                if (!current(operation)) throw aborted();
                if (resource.userId && resource.userId !== operation.owner) throw new Error("上传图片的账号归属不匹配。");
                return { resourceId: resource.id, storageKey: resourceStorageKey(resource.id), url: resourceFileUrl(resource.id), mimeType: resource.mimeType, bytes: resource.size, title: file.name };
            } finally {
                finish(key, operation);
                if (current(operation)) update(operation.owner, (previous) => ({ ...previous, uploading: [...operations.current.keys()].some((name) => name.startsWith("upload:")) }));
            }
        },
        [begin, current, finish, update],
    );

    return {
        capabilities: state.capabilities,
        loading: state.loading,
        refreshing: state.refreshing,
        loadingMore: state.loadingMore,
        error: state.error,
        draft: state.draft,
        setDraft,
        count: state.count,
        setCount,
        tasks: state.tasks,
        selectedTaskId: state.selectedTaskId,
        selectTask,
        findSegmentation,
        submitting: state.submitting,
        uploading: state.uploading,
        hasMore: Boolean(state.nextCursor),
        generate,
        processModel,
        refresh,
        refreshTask,
        recover,
        loadMore,
        uploadImage,
        reuseTask,
    };
}

function delay(milliseconds: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(aborted());
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, milliseconds);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
    });
}

async function readImageDimensions(file: File, signal: AbortSignal) {
    const url = URL.createObjectURL(file);
    try {
        return await new Promise<{ width: number; height: number }>((resolve, reject) => {
            const image = new Image();
            const clean = () => {
                image.onload = null;
                image.onerror = null;
                signal.removeEventListener("abort", onAbort);
            };
            const onAbort = () => {
                clean();
                image.src = "";
                reject(aborted());
            };
            image.onload = () => {
                clean();
                resolve({ width: image.naturalWidth, height: image.naturalHeight });
            };
            image.onerror = () => {
                clean();
                reject(new Error("无法读取图片尺寸，请选择有效图片。"));
            };
            if (signal.aborted) return onAbort();
            signal.addEventListener("abort", onAbort, { once: true });
            image.src = url;
        });
    } finally {
        URL.revokeObjectURL(url);
    }
}
