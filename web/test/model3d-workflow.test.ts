import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { defaultModel3DDraft, mergeModel3DTasks, model3DTaskDraft, standaloneModel3DRequest, validateModel3DImage } from "@/pages/model3d/model3d-workflow-state";
import type { Model3DCapabilities, Model3DCreateRequest, Model3DTaskList, Model3DTaskView } from "@/services/api/model3d";
import { ApiError, apiClient } from "@/services/api/request";
import { listModel3DTasks } from "@/services/api/model3d";

const capabilities: Model3DCapabilities = {
    available: true,
    providerName: "Tripo",
    policyRevision: 8,
    activeConfigVersion: 2,
    defaultModel: "h3.1",
    modelVersions: [{ id: "h3.1", label: "H3.1", supportsAdvanced: true, maxFacesStandard: 100000, maxFacesDetailed: 500000 }],
    modes: ["text", "image", "multiview"],
    inputLimits: { maxBytes: 10000000, mimeTypes: ["image/png", "image/jpeg"], minViews: 2, maxViews: 4, requiredView: "front" },
};
function draft(prompt = "toy truck") {
    return { ...defaultModel3DDraft(capabilities), prompt };
}
function task(id: string, patch: Partial<Model3DTaskView> = {}): Model3DTaskView {
    return {
        id,
        scope: "standalone",
        requestId: `request-${id}`,
        status: "succeeded",
        stage: "completed",
        mode: "text",
        prompt: "toy truck",
        parameters: draft().parameters,
        sourceFingerprint: "fingerprint",
        clientContext: { canvasId: "", nodeId: "" },
        submissionOutcome: "submitted",
        canRetryStorage: false,
        createdAt: "2026-10-22T02:00:00Z",
        updatedAt: "2026-10-22T02:01:00Z",
        ...patch,
    };
}
function response(input: Model3DCreateRequest, patch: Partial<Model3DTaskView> = {}) {
    return task(input.requestId, { ...input, id: `task-${input.requestId}`, ...patch });
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<T>((a, b) => {
        resolve = a;
        reject = b;
    });
    return { promise, resolve, reject };
}

const modules: Record<string, string> = {
    react: "export const { useState, useRef, useEffect, useCallback } = globalThis.env.hooks;",
    "@/services/api/model3d": "export const { createModel3DTask, getModel3DCapabilities, getModel3DTask, getModel3DTaskByRequest, listModel3DTasks, recoverModel3DTask } = globalThis.env.api;",
    "@/services/api/request": "export const ApiError = globalThis.env.ApiError;",
    "@/services/api/resources": "export const { resourceFileUrl, resourceStorageKey, uploadResourceFile } = globalThis.env.resources;",
    "@/lib/localforage-storage": "export const localForageStorageForScope = globalThis.env.storage;",
    "@/stores/use-user-store": "export const useUserStore = globalThis.env.useUserStore;",
};
const build = await Bun.build({
    entrypoints: [new URL("../src/pages/model3d/use-model3d-workflow.ts", import.meta.url).pathname],
    target: "browser",
    format: "cjs",
    plugins: [
        {
            name: "standalone-model3d-harness",
            setup(builder) {
                builder.onResolve({ filter: /^(react|@\/services\/|@\/lib\/localforage-storage|@\/stores\/use-user-store)/ }, ({ path }) => (modules[path] ? { path, namespace: "workflow-test" } : undefined));
                builder.onLoad({ filter: /.*/, namespace: "workflow-test" }, ({ path }) => ({ contents: modules[path], loader: "js" }));
            },
        },
    ],
});
expect(build.success).toBe(true);
const source = await build.outputs[0].text();

function harness(cache = new Map<string, string>()) {
    const cells: any[] = [];
    let cursor = 0;
    let dirty = false;
    let effects: Array<{ index: number; callback: () => void | (() => void); deps: unknown[] }> = [];
    let output!: ReturnType<typeof import("@/pages/model3d/use-model3d-workflow").useModel3DWorkflow>;
    const userState = { user: { id: "user" } as { id: string } | null };
    const creates: Model3DCreateRequest[] = [];
    const lists: Array<{ scope?: string; cursor?: string; activeOnly?: boolean; limit?: number }> = [];
    const signals: AbortSignal[] = [];
    const behavior = {
        create: async (input: Model3DCreateRequest): Promise<Model3DTaskView> => response(input),
        list: async (_input: { activeOnly?: boolean; cursor?: string }): Promise<Model3DTaskList> => ({ tasks: [] }),
        get: async (id: string): Promise<Model3DTaskView> => task(id),
        request: async (_id: string): Promise<Model3DTaskView | null> => null,
        recover: async (id: string): Promise<Model3DTaskView> => task(id),
        capabilities: async (): Promise<Model3DCapabilities> => capabilities,
    };
    const timers = new Map<number, { callback: () => void; delay: number }>();
    let timerId = 0;
    let requests = 0;
    let gets = 0;
    let recovers = 0;
    let failStorage = false;
    const listeners = new Map<string, () => void>();
    const changed = (before?: unknown[], after: unknown[] = []) => !before || before.length !== after.length || before.some((value, index) => !Object.is(value, after[index]));
    const useUserStore = Object.assign((selector: (state: typeof userState) => any) => selector(userState), { getState: () => userState });
    const env = {
        hooks: {
            useState(value: any) {
                const index = cursor++;
                if (!(index in cells)) cells[index] = typeof value === "function" ? value() : value;
                return [
                    cells[index],
                    (next: any) => {
                        const value = typeof next === "function" ? next(cells[index]) : next;
                        if (!Object.is(value, cells[index])) {
                            cells[index] = value;
                            dirty = true;
                        }
                    },
                ];
            },
            useRef(value: any) {
                const index = cursor++;
                return (cells[index] ||= { current: value });
            },
            useCallback(callback: any, deps: unknown[]) {
                const index = cursor++;
                if (changed(cells[index]?.deps, deps)) cells[index] = { callback, deps };
                return cells[index].callback;
            },
            useEffect(callback: any, deps: unknown[]) {
                const index = cursor++;
                if (changed(cells[index]?.deps, deps)) effects.push({ index, callback, deps });
            },
        },
        api: {
            createModel3DTask(input: Model3DCreateRequest, signal: AbortSignal) {
                creates.push(input);
                signals.push(signal);
                return behavior.create(input);
            },
            getModel3DCapabilities(signal: AbortSignal) {
                signals.push(signal);
                return behavior.capabilities();
            },
            getModel3DTask(id: string, signal: AbortSignal) {
                gets++;
                signals.push(signal);
                return behavior.get(id);
            },
            getModel3DTaskByRequest(id: string, signal: AbortSignal) {
                requests++;
                signals.push(signal);
                return behavior.request(id);
            },
            listModel3DTasks(input: any, signal: AbortSignal) {
                lists.push(input);
                signals.push(signal);
                return behavior.list(input);
            },
            recoverModel3DTask(id: string, signal: AbortSignal) {
                recovers++;
                signals.push(signal);
                return behavior.recover(id);
            },
        },
        resources: {
            resourceFileUrl: (id: string) => `/api/resources/${id}/file`,
            resourceStorageKey: (id: string) => `resource:${id}`,
            uploadResourceFile: () => {
                throw new Error("unexpected upload");
            },
        },
        storage: (owner: string) => ({
            getItem: (key: string) => Promise.resolve(cache.get(`${owner}:${key}`) || null),
            setItem: (key: string, value: string) => {
                if (failStorage) return Promise.reject(new Error("storage full"));
                cache.set(`${owner}:${key}`, value);
                return Promise.resolve();
            },
        }),
        ApiError,
        useUserStore,
    };
    const browser = { addEventListener: (name: string, callback: () => void) => listeners.set(name, callback), removeEventListener: (name: string) => listeners.delete(name), visibilityState: "visible" };
    const module: { exports: any } = { exports: {} };
    runInNewContext(source, {
        env,
        module,
        exports: module.exports,
        crypto,
        AbortController,
        DOMException,
        structuredClone,
        Date,
        console,
        window: browser,
        document: browser,
        setTimeout: (callback: () => void, delay: number) => {
            const id = ++timerId;
            timers.set(id, { callback, delay });
            return id;
        },
        clearTimeout: (id: number) => timers.delete(id),
    });
    function render() {
        cursor = 0;
        dirty = false;
        output = module.exports.useModel3DWorkflow();
        const queue = effects;
        effects = [];
        for (const effect of queue) {
            cells[effect.index]?.cleanup?.();
            cells[effect.index] = { deps: effect.deps, cleanup: effect.callback() };
        }
    }
    async function flush() {
        for (let i = 0; i < 70; i++) {
            await Promise.resolve();
            if (dirty) render();
        }
    }
    render();
    return {
        behavior,
        cache,
        creates,
        lists,
        signals,
        userState,
        timers,
        listeners,
        get value() {
            return output;
        },
        get requests() {
            return requests;
        },
        get gets() {
            return gets;
        },
        get recovers() {
            return recovers;
        },
        set failStorage(value: boolean) {
            failStorage = value;
        },
        flush,
        render,
        async advance() {
            const next = timers.entries().next().value;
            if (next) {
                timers.delete(next[0]);
                next[1].callback();
            }
            await flush();
        },
        unmount() {
            for (const cell of cells) cell?.cleanup?.();
        },
    };
}

test("standalone requests preserve the real draft and carry no canvas or node binding", () => {
    const input = draft();
    const prepared = standaloneModel3DRequest(input, capabilities, { requestId: "a", groupId: "group", candidateIndex: 1, candidateCount: 2 });
    expect(prepared.request.scope).toBe("standalone");
    expect(prepared.request).not.toHaveProperty("canvasId");
    expect(prepared.request).not.toHaveProperty("nodeId");
    expect(prepared.request.parameters.faceLimit).toBe(100000);
    expect(prepared.snapshot).toEqual(input);
    expect(prepared.snapshot).not.toBe(input);
    expect(defaultModel3DDraft({ ...capabilities, modelVersions: [{ ...capabilities.modelVersions[0], maxFacesStandard: 80000 }] }).parameters.faceLimit).toBe(80000);
});

test("multiview admission requires distinct uploaded resources and validates capability MIME, bytes and dimensions", () => {
    const input = { ...draft(), mode: "multiview" as const, views: { front: { resourceId: "front" }, left: { resourceId: "left" } } };
    expect(standaloneModel3DRequest(input, capabilities, { requestId: "a", groupId: "g", candidateIndex: 1, candidateCount: 1 }).request.views).toEqual({ front: "front", left: "left" });
    expect(() => standaloneModel3DRequest({ ...input, views: { front: input.views.front, left: input.views.front } }, capabilities, { requestId: "a", groupId: "g", candidateIndex: 1, candidateCount: 1 })).toThrow("同一张");
    for (const file of [
        { type: "image/gif", size: 10 },
        { type: "image/png", size: 10000001 },
        { type: "image/png", size: 0 },
    ])
        expect(() => validateModel3DImage(file, capabilities)).toThrow();
    expect(() => validateModel3DImage({ type: "image/png", size: 100 }, { ...capabilities, inputLimits: { ...capabilities.inputLimits, minWidth: 128, maxHeight: 2048 } }, { width: 64, height: 512 })).toThrow("尺寸");
});

test("history reuse reconstructs input without mutating task data and foreign canvas history is excluded", () => {
    const original = task("a", { mode: "image", imageResourceId: "image" });
    const reused = model3DTaskDraft(original);
    reused.parameters.faceLimit = 100;
    expect(original.parameters?.faceLimit).toBe(100000);
    expect(reused.image?.storageKey).toBe("resource:image");
    expect(mergeModel3DTasks([], [original, task("canvas", { scope: "canvas" })])).toEqual([original]);
    expect(mergeModel3DTasks([original], [task("a", { status: "running", updatedAt: "2026-10-22T01:00:00Z" })])[0].status).toBe("succeeded");
    expect(mergeModel3DTasks([original], [task("a", { status: "running", updatedAt: original.updatedAt })])[0].status).toBe("succeeded");
    expect(mergeModel3DTasks([task("active", { status: "running", updatedAt: "2026-10-22T02:01:00.100Z" })], [task("active", { status: "queued", updatedAt: "2026-10-22T02:01:00Z" })])[0].status).toBe("running");
});

test("list API forwards standalone filters, compacts empty cursors and preserves AbortSignal", async () => {
    const original = apiClient.request;
    const seen: any[] = [];
    apiClient.request = (async (input: any) => {
        seen.push(input);
        return { data: { code: 0, data: { tasks: [], nextCursor: "next" }, msg: "ok" }, status: 200, headers: {} };
    }) as typeof apiClient.request;
    const controller = new AbortController();
    try {
        expect(await listModel3DTasks({ scope: "standalone", limit: 30, activeOnly: true, cursor: "" }, controller.signal)).toEqual({ tasks: [], nextCursor: "next" });
        expect(seen[0]).toMatchObject({ method: "get", url: "/model3d/tasks", signal: controller.signal, params: { scope: "standalone", limit: 30, activeOnly: "true" } });
        expect(seen[0].params).not.toHaveProperty("cursor");
    } finally {
        apiClient.request = original;
    }
});

test("partial candidate rejection preserves accepted versions and unique request identities", async () => {
    const h = harness();
    await h.flush();
    h.behavior.create = async (input) => {
        if (input.candidateIndex === 2) throw new ApiError("not allowed", { status: 403, reason: "denied" });
        return response(input);
    };
    await h.value.generate(draft(), 3);
    await h.flush();
    expect(h.creates).toHaveLength(3);
    expect(new Set(h.creates.map((input) => input.requestId)).size).toBe(3);
    expect(new Set(h.creates.map((input) => input.groupId)).size).toBe(1);
    expect(h.creates.every((input) => input.scope === "standalone" && !input.canvasId && !input.nodeId)).toBe(true);
    expect(h.value.tasks.filter((item) => item.status === "succeeded")).toHaveLength(2);
    expect(h.value.tasks.find((item) => item.candidateIndex === 2)?.submissionOutcome).toBe("not_submitted");
    expect(h.value.error).toContain("候选 2");
    h.unmount();
});

test("unknown POST is verified by request ID and restored after reload without a second POST", async () => {
    const h = harness();
    await h.flush();
    h.behavior.create = async () => {
        throw new ApiError("connection lost", { retryable: true });
    };
    await h.value.generate(draft(), 1);
    await h.flush();
    expect(h.creates).toHaveLength(1);
    expect(h.requests).toBeGreaterThan(0);
    expect(h.value.tasks[0].localStatus).toBe("submission_unknown");
    const accepted = response(h.creates[0]);
    h.unmount();
    const restored = harness(h.cache);
    restored.behavior.request = async () => accepted;
    await restored.flush();
    expect(restored.creates).toHaveLength(0);
    expect(restored.value.tasks[0].id).toBe(accepted.id);
    expect(restored.value.tasks[0].status).toBe("succeeded");
    expect(restored.value.tasks[0].localStatus).toBeUndefined();
    restored.unmount();
});

test("reloading during candidate submission restores only the candidate actually sent", async () => {
    const h = harness();
    await h.flush();
    const pending = deferred<Model3DTaskView>();
    h.behavior.create = () => pending.promise;
    const generating = h.value.generate(draft(), 4);
    await h.flush();
    expect(h.creates).toHaveLength(1);
    const saved = JSON.parse([...h.cache.values()][0]);
    expect(saved.pending).toHaveLength(1);
    expect(saved.pending[0].candidateIndex).toBe(1);
    const accepted = response(h.creates[0]);
    h.unmount();
    pending.resolve(accepted);
    await generating;
    const restored = harness(h.cache);
    restored.behavior.request = async () => accepted;
    await restored.flush();
    expect(restored.value.tasks).toHaveLength(1);
    expect(restored.value.tasks[0].candidateIndex).toBe(1);
    expect(restored.value.tasks[0].localStatus).toBeUndefined();
    expect(restored.creates).toHaveLength(0);
    restored.unmount();
});

test("temporary task GET failures honor Retry-After and resume without creating a new task", async () => {
    const h = harness();
    await h.flush();
    h.behavior.create = async (input) => response(input, { status: "running", stage: "generating", providerProgress: 10 });
    h.behavior.get = async () => {
        throw new ApiError("busy", { status: 429, reason: "limited", retryAfterMs: 45000 });
    };
    await h.value.generate(draft());
    await h.flush();
    expect([...h.timers.values()].map((timer) => timer.delay)).toContain(45000);
    h.behavior.get = async () => response(h.creates[0]);
    await h.advance();
    expect(h.value.tasks[0].status).toBe("succeeded");
    expect(h.creates).toHaveLength(1);
    expect(h.recovers).toBe(0);
    h.unmount();
});

test("refresh paginates all active tasks independently of history pages and preserves in-progress editing", async () => {
    const h = harness();
    h.behavior.list = async (input) =>
        input.activeOnly
            ? input.cursor
                ? { tasks: [task("active-b", { status: "running" })] }
                : { tasks: [task("active-a", { status: "queued" })], nextCursor: "active-page-2" }
            : input.cursor
              ? { tasks: [task("older")] }
              : { tasks: [task("history")], nextCursor: "history-page-2" };
    h.behavior.get = async (id) => task(id, { requestId: `request-${id}`, status: "running" });
    await h.flush();
    expect(h.value.tasks.map((item) => item.id).sort()).toEqual(["active-a", "active-b", "history"]);
    expect(h.lists.some((input) => input.activeOnly && input.cursor === "active-page-2")).toBe(true);
    h.value.setDraft(draft("editing the next object"));
    await h.flush();
    await h.value.loadMore();
    await h.flush();
    expect(h.value.tasks.some((item) => item.id === "older")).toBe(true);
    expect(h.value.draft.prompt).toBe("editing the next object");
    h.listeners.get("focus")?.();
    await h.flush();
    expect(h.value.draft.prompt).toBe("editing the next object");
    expect(h.creates).toHaveLength(0);
    h.unmount();
});

test("account switches abort requests, hide old tasks immediately and isolate cached drafts", async () => {
    const h = harness();
    await h.flush();
    const pending = deferred<Model3DTaskView>();
    h.behavior.create = () => pending.promise;
    h.value.setDraft(draft("private user one"));
    await h.flush();
    const submitting = h.value.generate(draft("private user one"));
    await h.flush();
    const oldSignal = h.signals.at(-1)!;
    h.userState.user = { id: "user-two" };
    h.render();
    await h.flush();
    expect(oldSignal.aborted).toBe(true);
    expect(h.value.tasks).toEqual([]);
    expect(h.value.draft.prompt).toBe("");
    pending.resolve(response(h.creates[0]));
    await submitting;
    await h.flush();
    expect(h.value.tasks).toEqual([]);
    expect(h.value.draft.prompt).toBe("");
    expect([...h.cache.keys()].some((key) => key.startsWith("user:model3d:"))).toBe(true);
    expect([...h.cache.keys()].some((key) => key.startsWith("user-two:model3d:"))).toBe(true);
    h.unmount();
});

test("unwritable request journal blocks admission and invalid candidate counts never POST", async () => {
    const h = harness();
    await h.flush();
    h.failStorage = true;
    await h.value.generate(draft(), 1);
    await h.flush();
    expect(h.creates).toHaveLength(0);
    expect(h.value.submitting).toBe(false);
    expect(h.value.tasks).toEqual([]);
    for (const count of [0, 5, 1.5]) await h.value.generate(draft(), count);
    expect(h.creates).toHaveLength(0);
    h.unmount();
});

test("storage recovery uses the original task once and never calls generation", async () => {
    const h = harness();
    h.behavior.list = async (input) => ({ tasks: input.activeOnly ? [] : [task("saved", { status: "failed", canRetryStorage: true })] });
    await h.flush();
    h.behavior.recover = async () => {
        throw new ApiError("save unavailable", { status: 503, reason: "temporary" });
    };
    await h.value.recover("saved");
    await h.flush();
    expect(h.recovers).toBe(1);
    expect(h.creates).toHaveLength(0);
    expect(h.timers.size).toBe(0);
    h.behavior.recover = async () => task("saved");
    await h.value.recover("saved");
    await h.flush();
    expect(h.value.tasks[0].status).toBe("succeeded");
    expect(h.recovers).toBe(2);
    expect(h.creates).toHaveLength(0);
    h.unmount();
});

test("a permanent GET failure stops observation without rewriting server status or creating again", async () => {
    const h = harness();
    await h.flush();
    h.behavior.create = async (input) => response(input, { status: "running", stage: "generating" });
    h.behavior.get = async () => {
        throw new ApiError("forbidden", { status: 403, reason: "denied" });
    };
    await h.value.generate(draft());
    await h.flush();
    expect(h.value.tasks[0].status).toBe("running");
    expect(h.value.error).toContain("读取已停止");
    expect(h.timers.size).toBe(0);
    expect(h.creates).toHaveLength(1);
    h.unmount();
});
