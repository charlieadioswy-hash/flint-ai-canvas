import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { createDefaultModel3DState, model3DSourceFingerprint } from "@/lib/canvas/model3d";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { Model3DCapabilities, Model3DCreateRequest, Model3DTaskView } from "@/services/api/model3d";

const modules: Record<string, string> = {
    react: "export const { useState, useRef, useEffect, useCallback } = globalThis.env.hooks;",
    "@/services/api/model3d": "export const { createModel3DTask, getModel3DCapabilities, getModel3DTask, getModel3DTaskByRequest, recoverModel3DTask } = globalThis.env.api;",
    "@/services/api/request": "export const ApiError = globalThis.env.ApiError;",
    "@/services/api/resources": "export const { importResourceFromUrl, resourceFileUrl, resourceIdFromStorageKey, resourceStorageKey, uploadResourceFile } = globalThis.env.resources;",
    "@/services/image-storage": "export const getImageBlob = globalThis.env.getImageBlob;",
    "@/services/file-storage": "export const getMediaBlob = globalThis.env.getMediaBlob;",
    "@/stores/use-user-store": "export const useUserStore = globalThis.env.useUserStore;",
};
const build = await Bun.build({ entrypoints: [new URL("../src/pages/canvas/use-canvas-model3d.ts", import.meta.url).pathname], target: "browser", format: "cjs", plugins: [{ name: "model3d-hook-harness", setup(builder) {
    builder.onResolve({ filter: /^(react|@\/services\/|@\/stores\/use-user-store)/ }, ({ path }) => modules[path] ? { path, namespace: "model3d-test" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "model3d-test" }, ({ path }) => ({ contents: modules[path], loader: "js" }));
} }] });
expect(build.success).toBe(true);
const hookSource = await build.outputs[0].text();
const capabilities: Model3DCapabilities = { available: true, providerName: "Tripo", policyRevision: 8, activeConfigVersion: 2, defaultModel: "h3.1", modelVersions: [{ id: "h3.1", label: "H3.1", supportsAdvanced: true, maxFacesStandard: 100000, maxFacesDetailed: 500000 }], modes: ["text", "image", "multiview"], inputLimits: { maxBytes: 10000000, mimeTypes: ["image/png", "image/jpeg"], minViews: 2, maxViews: 4, requiredView: "front" } };
function node(): CanvasNodeData { const state = createDefaultModel3DState("h3.1"); state.draft.prompt = "toy truck"; return { id: "node", type: CanvasNodeType.Model3D, title: "3D", width: 520, height: 420, position: { x: 0, y: 0 }, metadata: { model3d: state } }; }
function task(input: Model3DCreateRequest, patch: Partial<Model3DTaskView> = {}): Model3DTaskView { return { id: "task", status: "succeeded", stage: "completed", mode: input.mode, sourceFingerprint: input.sourceFingerprint, clientContext: { canvasId: input.canvasId, nodeId: input.nodeId }, submissionOutcome: "submitted", canRetryStorage: false, createdAt: "", updatedAt: "", result: { assetId: "asset", resourceId: "result", storageKey: "resource:result", url: "/api/resources/result/file", fileName: "truck.glb", mimeType: "model/gltf-binary", bytes: 50, format: "glb" }, ...patch }; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
class TestApiError extends Error { constructor(public status: number, public reason: string) { super("admission error"); } }

function harness(initial = node(), initialTask: Model3DTaskView | null = null, browserCrypto: Pick<Crypto, "getRandomValues"> = crypto) {
    const cells: any[] = [];
    let cursor = 0; let dirty = false;
    let effects: Array<{ index: number; callback: () => (() => void) | void; deps: unknown[] }> = [];
    let output: ReturnType<typeof import("@/pages/canvas/use-canvas-model3d").useCanvasModel3D>;
    const counters = { creates: 0, gets: 0, requests: 0, recovers: 0, uploads: 0 };
    const input = { projectId: "canvas", projectLoaded: true, nodes: [initial], nodesRef: { current: [initial] }, connectionsRef: { current: [] }, setNodes: (next: any) => { input.nodes = typeof next === "function" ? next(input.nodesRef.current) : next; input.nodesRef.current = input.nodes; dirty = true; } };
    const userState = { user: { id: "user" } as { id: string } | null };
    let lastPayload: Model3DCreateRequest | undefined;
    let lastTask: Model3DTaskView | null = initialTask;
    const behavior = {
        create: async (payload: Model3DCreateRequest): Promise<Model3DTaskView> => task(payload),
        get: async (): Promise<Model3DTaskView> => lastTask!,
        request: async (): Promise<Model3DTaskView | null> => lastTask,
        recover: async (): Promise<Model3DTaskView> => ({ ...lastTask!, status: "succeeded", canRetryStorage: false }),
    };
    const timers = new Map<number, () => void>(); let timerId = 0;
    const dependenciesChanged = (before?: unknown[], after: unknown[] = []) => !before || before.length !== after.length || before.some((value, index) => !Object.is(value, after[index]));
    const useUserStore = Object.assign((selector: (state: typeof userState) => any) => selector(userState), { getState: () => userState });
    const env = {
        hooks: {
            useState(value: any) { const index = cursor++; if (!(index in cells)) cells[index] = value; return [cells[index], (next: any) => { const value = typeof next === "function" ? next(cells[index]) : next; if (!Object.is(value, cells[index])) { cells[index] = value; dirty = true; } }]; },
            useRef(value: any) { const index = cursor++; return cells[index] ||= { current: value }; },
            useCallback(callback: any, deps: unknown[]) { const index = cursor++; if (dependenciesChanged(cells[index]?.deps, deps)) cells[index] = { deps, callback }; return cells[index].callback; },
            useEffect(callback: () => (() => void) | void, deps: unknown[]) { const index = cursor++; if (dependenciesChanged(cells[index]?.deps, deps)) effects.push({ index, callback, deps }); },
        }, useUserStore, ApiError: TestApiError,
        api: {
            getModel3DCapabilities: async () => capabilities,
            createModel3DTask: async (payload: Model3DCreateRequest) => { counters.creates++; lastPayload = payload; lastTask = await behavior.create(payload); return lastTask; },
            getModel3DTask: async () => { counters.gets++; return behavior.get(); },
            getModel3DTaskByRequest: async () => { counters.requests++; return behavior.request(); },
            recoverModel3DTask: async () => { counters.recovers++; return behavior.recover(); },
        }, resources: {
            resourceIdFromStorageKey: (key?: string) => key?.startsWith("resource:") ? key.slice(9) : "",
            resourceStorageKey: (id: string) => `resource:${id}`, resourceFileUrl: (id: string) => `/api/resources/${id}/file`,
            uploadResourceFile: async () => { counters.uploads++; return { id: "uploaded", mimeType: "image/png", size: 50 }; },
            importResourceFromUrl: async () => { throw new Error("unexpected external import"); },
        }, getImageBlob: async () => new Blob(["original"], { type: "image/png" }), getMediaBlob: async () => new Blob(["original"], { type: "image/png" }),
    };
    const module = { exports: {} as any };
    runInNewContext(hookSource, { module, exports: module.exports, env, AbortController, DOMException, Blob, File, structuredClone, crypto: browserCrypto, fetch: () => { throw new Error("unexpected network fetch"); }, setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; }, clearTimeout: (id: number) => timers.delete(id) });
    function render() { cursor = 0; dirty = false; output = module.exports.useCanvasModel3D(input); const committed = effects; effects = []; committed.forEach(({ index }) => cells[index]?.cleanup?.()); committed.forEach(({ index, callback, deps }) => { cells[index] = { deps, cleanup: callback() }; }); }
    render();
    return { counters, behavior, get state() { return output; }, get nodes() { return input.nodesRef.current; }, get payload() { return lastPayload; }, set task(value: Model3DTaskView | null) { lastTask = value; }, generate() { return output.generate("node"); }, mutate(change: (nodes: CanvasNodeData[]) => CanvasNodeData[]) { input.setNodes(change); render(); }, setProject(value: string) { input.projectId = value; render(); }, setUser(value: string | null) { userState.user = value ? { id: value } : null; render(); }, advancePoll() { const pending = [...timers.values()]; timers.clear(); pending.forEach((callback) => callback()); }, unmount() { cells.forEach((cell) => cell?.cleanup?.()); }, async flush() { let stable = 0; for (let attempt = 0; attempt < 160 && stable < 24; attempt++) { await Promise.resolve(); if (dirty) { render(); stable = 0; } else stable++; } expect(stable).toBe(24); } };
}

test("HTTP browsers without randomUUID can submit unique 3D requests", async () => {
    const browserCrypto = { getRandomValues: crypto.getRandomValues.bind(crypto) };
    const first = harness(node(), null, browserCrypto);
    const second = harness(node(), null, browserCrypto);
    await Promise.all([first.flush(), second.flush()]);
    await Promise.all([first.generate(), second.generate()]);
    await Promise.all([first.flush(), second.flush()]);
    expect(first.counters.creates).toBe(1);
    expect(second.counters.creates).toBe(1);
    expect(first.payload?.requestId).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(second.payload?.requestId).not.toBe(first.payload?.requestId);
    expect(first.nodes[0].metadata?.model3d?.run?.requestId).toBe(first.payload?.requestId);
    expect(first.nodes[0].metadata?.model3d?.result?.resourceId).toBe("result");
    first.unmount(); second.unmount();
});

test("duplicate click creates one task and freezes a snapshot before paid admission", async () => {
    const h = harness(); await h.flush();
    const response = deferred<Model3DTaskView>();
    h.behavior.create = () => response.promise;
    const first = h.generate(); const second = h.generate(); await h.flush();
    expect(h.counters.creates).toBe(1);
    expect(h.payload?.expectedPolicyRevision).toBe(8);
    expect(h.nodes[0].metadata?.model3d?.run?.requestId).toBe(h.payload?.requestId);
    h.mutate((nodes) => nodes.map((node) => ({ ...node, metadata: { ...node.metadata, model3d: { ...node.metadata!.model3d!, draft: { ...node.metadata!.model3d!.draft, prompt: "changed later" } } } })));
    response.resolve(task(h.payload!)); await Promise.all([first, second]); await h.flush();
    expect(h.nodes[0].metadata?.model3d?.run?.snapshot.prompt).toBe("toy truck");
    expect(h.nodes[0].metadata?.model3d?.draft.prompt).toBe("changed later");
    expect(h.nodes[0].metadata?.model3d?.resultFingerprint).not.toBe(model3DSourceFingerprint(h.nodes[0].metadata!.model3d!.draft, h.nodes));
    h.unmount();
});

test("refresh restores queued task through GET and never creates a new generation", async () => {
    const initial = node(); const state = initial.metadata!.model3d!;
    const request: Model3DCreateRequest = { requestId: "request", canvasId: "canvas", nodeId: "node", sourceFingerprint: model3DSourceFingerprint(state.draft, [initial]), mode: "text", prompt: state.draft.prompt, parameters: state.draft.parameters, expectedPolicyRevision: 8 };
    state.run = { requestId: request.requestId, taskId: "task", sourceFingerprint: request.sourceFingerprint, snapshot: structuredClone(state.draft), status: "queued" };
    const h = harness(initial, task(request)); await h.flush();
    expect(h.counters.gets).toBe(1); expect(h.counters.creates).toBe(0);
    expect(h.nodes[0].metadata?.model3d?.result?.resourceId).toBe("result"); h.unmount();
});

test("lost submission response uses read-only request discovery and does not resend POST", async () => {
    const h = harness(); await h.flush();
    h.behavior.create = async () => { throw new Error("connection lost"); };
    await h.generate(); await h.flush();
    expect(h.counters.creates).toBe(1); expect(h.counters.requests).toBeGreaterThan(0);
    expect(h.nodes[0].metadata?.model3d?.run?.status).toBe("submission_unknown");
    h.task = task(h.payload!); await h.state.refreshTask("node"); await h.flush();
    expect(h.nodes[0].metadata?.model3d?.run?.status).toBe("succeeded"); expect(h.counters.creates).toBe(1); h.unmount();
});

test("polling failure preserves task id and refresh retries only the status query", async () => {
    const h = harness(); await h.flush();
    h.behavior.create = async (payload) => task(payload, { status: "running", result: undefined });
    await h.generate(); await h.flush();
    h.behavior.get = async () => { throw new Error("offline"); }; h.advancePoll(); await h.flush();
    expect(h.nodes[0].metadata?.model3d?.run?.taskId).toBe("task"); expect(h.counters.creates).toBe(1);
    h.behavior.get = async () => task(h.payload!); await h.state.refreshTask("node"); await h.flush();
    expect(h.nodes[0].metadata?.model3d?.run?.status).toBe("succeeded"); expect(h.counters.creates).toBe(1); h.unmount();
});

test("HTTP 408 remains uncertain while explicit admission rejection allows another manual request", async () => {
    for (const status of [408, 409]) {
        const h = harness(); await h.flush();
        h.behavior.create = async () => { throw new TestApiError(status, "policy_changed"); };
        await h.generate(); await h.flush();
        expect(h.nodes[0].metadata?.model3d?.run?.status).toBe(status === 408 ? "submission_unknown" : "failed");
        await h.generate(); await h.flush();
        expect(h.counters.creates).toBe(status === 408 ? 1 : 2); h.unmount();
    }
});

test("multiview sends named resource ids without using input order and rejects missing front", async () => {
    const initial = node(); const state = initial.metadata!.model3d!;
    state.draft.mode = "multiview";
    state.draft.views = { left: { storageKey: "resource:left", url: "/left" } };
    const h = harness(initial); await h.flush(); await h.generate(); await h.flush();
    expect(h.counters.creates).toBe(0);
    h.mutate((nodes) => nodes.map((node) => ({ ...node, metadata: { ...node.metadata, model3d: { ...node.metadata!.model3d!, draft: { ...node.metadata!.model3d!.draft, views: { ...node.metadata!.model3d!.draft.views, front: { storageKey: "resource:front", url: "/front" } } } } } })));
    await h.generate(); await h.flush();
    expect(h.payload?.views).toEqual({ front: "front", left: "left" });
    expect(h.payload).not.toHaveProperty("prompt"); expect(h.counters.uploads).toBe(0); h.unmount();
});

test("real generation payload and saved draft remove stale parameters for every input mode", async () => {
    for (const mode of ["text", "image", "multiview"] as const) {
        const initial = node(); const draft = initial.metadata!.model3d!.draft;
        draft.mode = mode;
        draft.image = { storageKey: "resource:front" };
        draft.views = { front: { storageKey: "resource:front" }, left: { storageKey: "resource:left" } };
        draft.parameters = { ...draft.parameters, negativePrompt: "noise", imageSeed: 9, enableImageAutofix: false, textureAlignment: "original_image", orientation: "align_image" };
        const h = harness(initial); await h.flush(); await h.generate(); await h.flush();
        expect(h.counters.creates).toBe(1);
        const parameters = h.payload!.parameters;
        expect(h.nodes[0].metadata?.model3d?.draft.parameters).toEqual(parameters);
        expect(h.nodes[0].metadata?.model3d?.run?.snapshot.parameters).toEqual(parameters);
        if (mode === "text") {
            expect(parameters.negativePrompt).toBe("noise"); expect(parameters.imageSeed).toBe(9);
            expect(parameters).not.toHaveProperty("textureAlignment"); expect(parameters).not.toHaveProperty("orientation");
        } else { expect(parameters).not.toHaveProperty("negativePrompt"); expect(parameters).not.toHaveProperty("imageSeed"); }
        if (mode === "image") expect(parameters.enableImageAutofix).toBe(false);
        else expect(parameters).not.toHaveProperty("enableImageAutofix");
        h.unmount();
    }
});

test("untextured generation cleans persisted texture options before actual POST", async () => {
    const initial = node(); const draft = initial.metadata!.model3d!.draft;
    draft.mode = "image"; draft.image = { storageKey: "resource:front" };
    draft.parameters = { ...draft.parameters, texture: false, pbr: true, textureQuality: "detailed", textureVersion: "v3.0-20250812", textureSeed: 5, textureAlignment: "original_image", orientation: "align_image", modelSeed: 8, geometryQuality: "detailed" };
    const h = harness(initial); await h.flush(); await h.generate(); await h.flush();
    expect(h.payload?.parameters).toEqual({ model: "h3.1", texture: false, pbr: false, modelSeed: 8, geometryQuality: "detailed" });
    expect(h.nodes[0].metadata?.model3d?.draft.parameters).toEqual(h.payload!.parameters);
    expect(h.nodes[0].metadata?.model3d?.run?.sourceFingerprint).toBe(model3DSourceFingerprint(h.nodes[0].metadata!.model3d!.draft, h.nodes));
    expect(h.counters.creates).toBe(1); h.unmount();
});

test("topology changes reject a stale face limit before POST and accept the corrected minimum", async () => {
    const initial = node(); initial.metadata!.model3d!.draft.parameters = { ...initial.metadata!.model3d!.draft.parameters, quad: true, smartLowPoly: true, faceLimit: 20000 };
    const h = harness(initial); await h.flush(); await h.generate(); await h.flush();
    expect(h.counters.creates).toBe(0);
    expect(h.nodes[0].metadata?.model3d?.run?.error).toContain("10,000");
    h.mutate((nodes) => nodes.map((node) => ({ ...node, metadata: { ...node.metadata, model3d: { ...node.metadata!.model3d!, draft: { ...node.metadata!.model3d!.draft, parameters: { ...node.metadata!.model3d!.draft.parameters, faceLimit: 500 } } } } })));
    await h.generate(); await h.flush();
    expect(h.counters.creates).toBe(1); expect(h.payload?.parameters.faceLimit).toBe(500); h.unmount();
});

test("direct upload rejects unsupported image format before resource upload", async () => {
    const h = harness(); await h.flush();
    await expect(h.state.uploadImage(new File(["pixels"], "image.webp", { type: "image/webp" }))).rejects.toThrow("不支持");
    expect(h.counters.uploads).toBe(0);
    const result = await h.state.uploadImage(new File(["pixels"], "image.png", { type: "image/png" }));
    expect(result.storageKey).toBe("resource:uploaded"); expect(h.counters.uploads).toBe(1); h.unmount();
});

test("switching canvas or account prevents late generation result from mutating current nodes", async () => {
    for (const change of ["canvas", "user"] as const) {
        const h = harness(); await h.flush(); const response = deferred<Model3DTaskView>(); h.behavior.create = () => response.promise;
        const generation = h.generate(); await h.flush();
        if (change === "canvas") h.setProject("other-canvas"); else h.setUser("other-user");
        response.resolve(task(h.payload!)); await generation; await h.flush();
        expect(h.nodes[0].metadata?.model3d?.result).toBeUndefined(); h.unmount();
    }
});

test("deleting node prevents result materialization and storage recovery never calls generate", async () => {
    const h = harness(); await h.flush(); const response = deferred<Model3DTaskView>(); h.behavior.create = () => response.promise;
    const generation = h.generate(); await h.flush(); h.mutate(() => []); response.resolve(task(h.payload!)); await generation; await h.flush();
    expect(h.nodes).toHaveLength(0); expect(h.counters.creates).toBe(1); h.unmount();
    const second = harness(); await second.flush(); second.behavior.create = async (payload) => task(payload, { status: "failed", result: undefined, canRetryStorage: true });
    await second.generate(); await second.flush(); await second.state.refreshTask("node", true); await second.flush();
    expect(second.counters.recovers).toBe(1); expect(second.counters.creates).toBe(1); second.unmount();
});
