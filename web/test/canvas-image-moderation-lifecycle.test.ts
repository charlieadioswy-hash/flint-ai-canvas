import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

import type { ModerationReport } from "@/services/api/image-moderation";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

// 与 launcher 测试一样执行真实 hook；只替换 React 调度和外部 I/O，所有付费调用均为内存桩。
const modules: Record<string, string> = {
    react: "export const { useState, useRef, useEffect, useCallback } = globalThis.env.hooks;",
    "@/services/api/image-moderation": "export const { createImageModerationCheck, getImageModerationAvailability, getImageModerationCheck, getLatestImageModerationCheck } = globalThis.env.api;",
    "@/services/api/resources": "export const { importResourceFromUrl, resourceFileUrl, resourceIdFromStorageKey, resourceStorageKey, uploadResourceFile } = globalThis.env.resources;",
    "@/services/image-storage": "export const getImageBlob = globalThis.env.getImageBlob;",
    "@/services/file-storage": "export const getMediaBlob = globalThis.env.getMediaBlob;",
    "@/stores/use-user-store": "export const useUserStore = globalThis.env.useUserStore;",
};
const build = await Bun.build({
    entrypoints: [new URL("../src/pages/canvas/use-canvas-image-moderation.ts", import.meta.url).pathname],
    target: "browser",
    format: "cjs",
    plugins: [
        {
            name: "moderation-hook-harness",
            setup(builder) {
                builder.onResolve({ filter: /^(react|@\/services\/|@\/stores\/use-user-store)/ }, ({ path }) => (modules[path] ? { path, namespace: "moderation-test" } : undefined));
                builder.onLoad({ filter: /.*/, namespace: "moderation-test" }, ({ path }) => ({ contents: modules[path], loader: "js" }));
            },
        },
    ],
});
expect(build.success).toBe(true);
const hookSource = await build.outputs[0].text();

function report(patch: Partial<ModerationReport> = {}): ModerationReport {
    return { checkId: "check", resourceId: "original", contentVersion: "v1", status: "completed", overallRisk: "none", riskTags: [], summary: "未发现风险", createdAt: "2026-10-01T00:00:00Z", isCurrent: true, ...patch };
}
function node(patch: Partial<CanvasNodeData["metadata"]> = {}): CanvasNodeData {
    return { id: "node", type: CanvasNodeType.Image, title: "图片", width: 320, height: 240, position: { x: 0, y: 0 }, metadata: { storageKey: "resource:original", content: "https://cdn/original", ...patch } };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((success, failure) => {
        resolve = success;
        reject = failure;
    });
    return { promise, resolve, reject };
}

function harness(initial = node(), initialLatest?: () => Promise<ModerationReport | null>) {
    const cells: any[] = [];
    let cursor = 0;
    let dirty = false;
    let effects: Array<{ index: number; callback: () => (() => void) | void; deps: unknown[] }> = [];
    let output: ReturnType<typeof import("@/pages/canvas/use-canvas-image-moderation").useCanvasImageModeration>;
    const counters = { latest: 0, availability: 0, create: 0, status: 0, uploads: 0, imports: 0, imageReads: 0, mediaReads: 0 };
    const input = {
        projectId: "canvas-a",
        projectLoaded: true,
        nodes: [initial],
        nodesRef: { current: [initial] },
        setNodes: (next: any) => {
            input.nodes = typeof next === "function" ? next(input.nodesRef.current) : next;
            input.nodesRef.current = input.nodes;
            dirty = true;
        },
    };
    const userState = { user: { id: "user-a" } as { id: string } | null };
    let latestValue: ModerationReport | null = null;
    let originalBlob = new Blob(["original pixels"], { type: "image/png" });
    const uploads: Array<{ file: Blob; kind: string; meta: any }> = [];
    const imports: string[] = [];
    const dependenciesChanged = (before?: unknown[], after: unknown[] = []) => !before || before.length !== after.length || before.some((value, index) => !Object.is(value, after[index]));
    const useUserStore = Object.assign((selector: (state: typeof userState) => any) => selector(userState), { getState: () => userState });
    const behavior = {
        latest: initialLatest || (async () => latestValue),
        create: async (resourceId: string) => {
            latestValue = report({ checkId: `check-${counters.create}`, resourceId });
            return latestValue;
        },
        status: async () => latestValue || report(),
        upload: async (_file: Blob) => ({ id: "uploaded-original" }),
        imageBlob: async () => originalBlob,
    };
    const timers = new Map<number, () => void>();
    let timerId = 0;
    const env = {
        hooks: {
            useState(initialValue: any) {
                const index = cursor++;
                if (!(index in cells)) cells[index] = typeof initialValue === "function" ? initialValue() : initialValue;
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
            useRef(initialValue: any) {
                const index = cursor++;
                return (cells[index] ||= { current: initialValue });
            },
            useCallback(callback: any, deps: unknown[]) {
                const index = cursor++;
                if (dependenciesChanged(cells[index]?.deps, deps)) cells[index] = { deps, callback };
                return cells[index].callback;
            },
            useEffect(callback: () => (() => void) | void, deps: unknown[]) {
                const index = cursor++;
                if (dependenciesChanged(cells[index]?.deps, deps)) effects.push({ index, callback, deps });
            },
        },
        useUserStore,
        api: {
            getImageModerationAvailability: async () => {
                counters.availability++;
                return { available: true };
            },
            getLatestImageModerationCheck: async () => {
                counters.latest++;
                return behavior.latest();
            },
            createImageModerationCheck: async (resourceId: string) => {
                counters.create++;
                return behavior.create(resourceId);
            },
            getImageModerationCheck: async () => {
                counters.status++;
                return behavior.status();
            },
        },
        resources: {
            resourceIdFromStorageKey: (key?: string) => (key?.startsWith("resource:") ? key.slice(9) : ""),
            resourceStorageKey: (id: string) => `resource:${id}`,
            resourceFileUrl: (id: string) => `/api/resources/${id}/file`,
            uploadResourceFile: async (file: Blob, kind: string, meta: any) => {
                counters.uploads++;
                uploads.push({ file, kind, meta });
                return behavior.upload(file);
            },
            importResourceFromUrl: async (url: string) => {
                counters.imports++;
                imports.push(url);
                return { id: "imported-original" };
            },
        },
        getImageBlob: async () => {
            counters.imageReads++;
            return behavior.imageBlob();
        },
        getMediaBlob: async () => {
            counters.mediaReads++;
            return originalBlob;
        },
    };
    const module = { exports: {} as any };
    runInNewContext(hookSource, {
        module,
        exports: module.exports,
        env,
        AbortController,
        DOMException,
        Blob,
        Response,
        TextEncoder,
        crypto,
        setTimeout: (callback: () => void) => {
            timers.set(++timerId, callback);
            return timerId;
        },
        clearTimeout: (id: number) => timers.delete(id),
        fetch: () => {
            throw new Error("unexpected network fetch");
        },
    });
    function render() {
        cursor = 0;
        dirty = false;
        output = module.exports.useCanvasImageModeration(input);
        const committed = effects;
        effects = [];
        committed.forEach(({ index }) => cells[index]?.cleanup?.());
        committed.forEach(({ index, callback, deps }) => {
            cells[index] = { deps, cleanup: callback() };
        });
    }
    render();
    return {
        counters,
        behavior,
        uploads,
        imports,
        get state() {
            return output;
        },
        get nodes() {
            return input.nodesRef.current;
        },
        get blob() {
            return originalBlob;
        },
        set latest(value: ModerationReport | null) {
            latestValue = value;
        },
        setBlob(value: Blob) {
            originalBlob = value;
        },
        open() {
            output.open(input.nodesRef.current[0]);
        },
        mutate(change: (value: CanvasNodeData[]) => CanvasNodeData[]) {
            input.setNodes(change);
            render();
        },
        setUser(userId: string | null) {
            userState.user = userId ? { id: userId } : null;
            render();
        },
        setProject(projectId: string) {
            input.projectId = projectId;
            render();
        },
        advancePoll() {
            const pending = [...timers.values()];
            timers.clear();
            pending.forEach((callback) => callback());
        },
        unmount() {
            cells.forEach((cell) => cell?.cleanup?.());
        },
        async flush() {
            let stable = 0;
            for (let attempt = 0; attempt < 120 && stable < 24; attempt++) {
                await Promise.resolve();
                if (dirty) {
                    render();
                    stable = 0;
                } else stable++;
            }
            expect(stable).toBe(24);
        },
    };
}

test("refresh and metadata updates only read latest once, with zero paid submissions", async () => {
    const h = harness();
    await h.flush();
    expect(h.counters.latest).toBe(1);
    expect(h.counters.create).toBe(0);
    h.mutate((nodes) => nodes.map((item) => ({ ...item, title: "重命名", metadata: { ...item.metadata, previewContent: "thumbnail" } })));
    await h.flush();
    expect(h.counters.latest).toBe(1);
    expect(h.counters.create).toBe(0);
    h.unmount();
});

test("rapid repeated clicks share one submission and explicit recheck starts a second", async () => {
    const h = harness();
    await h.flush();
    const pending = deferred<ModerationReport>();
    h.behavior.create = () => pending.promise;
    h.open();
    await h.flush();
    h.open();
    h.open();
    h.state.recheck();
    await h.flush();
    expect(h.counters.create).toBe(1);
    h.latest = report({ checkId: "first" });
    pending.resolve(report({ checkId: "first" }));
    await h.flush();
    h.behavior.create = async () => report({ checkId: "second", status: "failed", overallRisk: "unknown" });
    h.state.recheck();
    await h.flush();
    expect(h.counters.create).toBe(2);
    expect(h.state.report?.status).toBe("failed");
    h.unmount();
});

test("repeated clicks during refresh share its GET and create at most one check", async () => {
    const pending = deferred<ModerationReport | null>();
    const h = harness(node(), () => pending.promise);
    await h.flush();
    h.open();
    h.open();
    h.open();
    await h.flush();
    expect(h.counters.latest).toBe(1);
    expect(h.counters.create).toBe(0);
    pending.resolve(null);
    await h.flush();
    expect(h.counters.create).toBe(1);
    h.unmount();
});

test("failed latest reads never fall through to a paid POST", async () => {
    const h = harness();
    h.behavior.latest = async () => {
        throw new Error("offline");
    };
    await h.flush();
    h.open();
    await h.flush();
    expect(h.counters.create).toBe(0);
    expect(h.state.error).toBeTruthy();
    h.unmount();
});

test("lost submit responses are recovered by GET without resubmitting", async () => {
    const h = harness();
    await h.flush();
    h.behavior.create = async () => {
        h.latest = report({ checkId: "accepted" });
        throw new Error("response lost");
    };
    h.open();
    await h.flush();
    expect(h.counters.create).toBe(1);
    expect(h.state.report?.checkId).toBe("accepted");
    h.open();
    await h.flush();
    expect(h.counters.create).toBe(1);
    h.unmount();
});

test("latest failed report replaces previously saved green result", async () => {
    const original = node();
    original.metadata!.imageModeration = { sourceIdentity: "resource:original", report: report({ checkId: "old-green" }) };
    const h = harness(original);
    h.latest = report({ checkId: "latest-failed", status: "failed", overallRisk: "unknown" });
    await h.flush();
    h.open();
    await h.flush();
    expect(h.state.report?.checkId).toBe("latest-failed");
    expect(h.state.report?.status).toBe("failed");
    expect(h.counters.create).toBe(0);
    h.unmount();
});

for (const change of ["replace", "delete", "user", "project", "unmount"] as const) {
    test(`late completion cannot write after ${change}`, async () => {
        const h = harness();
        await h.flush();
        const pending = deferred<ModerationReport>();
        h.behavior.create = () => pending.promise;
        h.open();
        await h.flush();
        expect(h.counters.create).toBe(1);
        if (change === "replace") h.mutate((nodes) => nodes.map((item) => ({ ...item, metadata: { storageKey: "resource:replacement", content: "new-original" } })));
        if (change === "delete") h.mutate(() => []);
        if (change === "user") h.setUser("user-b");
        if (change === "project") h.setProject("canvas-b");
        if (change === "unmount") h.unmount();
        pending.resolve(report({ checkId: "late" }));
        await h.flush();
        expect(h.nodes[0]?.metadata?.imageModeration).toBeUndefined();
        expect(h.counters.create).toBe(1);
        h.unmount();
    });
}

test("local-image detection uploads its stored original, not preview or display URL", async () => {
    const h = harness(node({ storageKey: "image:user-a:original", content: "blob:display-only", previewContent: "thumbnail" }));
    await h.flush();
    h.open();
    h.open();
    await h.flush();
    expect(h.counters.imageReads).toBe(1);
    expect(h.counters.mediaReads).toBe(0);
    expect(h.uploads).toHaveLength(1);
    expect(h.uploads[0].file).toBe(h.blob);
    expect(h.uploads[0].meta.idempotencyKey).toBe("image:user-a:original");
    expect(h.nodes[0].metadata?.storageKey).toBe("resource:uploaded-original");
    expect(h.state.report?.resourceId).toBe("uploaded-original");
    expect(h.counters.create).toBe(1);
    h.unmount();
});

test("account switch while uploading local original prevents detection submission", async () => {
    const h = harness(node({ storageKey: "image:user-a:original", content: "blob:original" }));
    const pending = deferred<{ id: string }>();
    h.behavior.upload = () => pending.promise;
    await h.flush();
    h.open();
    await h.flush();
    expect(h.counters.uploads).toBe(1);
    h.setUser("user-b");
    pending.resolve({ id: "old-user-upload" });
    await h.flush();
    expect(h.counters.create).toBe(0);
    expect(h.nodes[0].metadata?.storageKey).toBe("image:user-a:original");
    h.unmount();
});

test("account switch while reading local original prevents upload", async () => {
    const h = harness(node({ storageKey: "image:user-a:original", content: "blob:original" }));
    const pending = deferred<Blob>();
    h.behavior.imageBlob = () => pending.promise;
    await h.flush();
    h.open();
    await h.flush();
    expect(h.counters.imageReads).toBe(1);
    expect(h.counters.uploads).toBe(0);
    h.setUser("user-b");
    pending.resolve(h.blob);
    await h.flush();
    expect(h.counters.uploads).toBe(0);
    expect(h.counters.create).toBe(0);
    h.unmount();
});

test("new account cannot upload a stale previous-account local reference", async () => {
    const h = harness(node({ storageKey: "image:user-a:original", content: "blob:original" }));
    h.setUser("user-b");
    await h.flush();
    h.open();
    await h.flush();
    expect(h.counters.imageReads).toBe(0);
    expect(h.counters.uploads).toBe(0);
    expect(h.counters.create).toBe(0);
    expect(h.state.error).toContain("其他账号");
    h.unmount();
});

test("signed existing resource display URLs are never imported or uploaded", async () => {
    const h = harness(node({ content: "https://cdn/thumbnail?signature=secret", previewContent: "other-thumbnail" }));
    await h.flush();
    h.open();
    await h.flush();
    expect(h.counters.uploads).toBe(0);
    expect(h.counters.imports).toBe(0);
    expect(h.state.report?.resourceId).toBe("original");
    h.unmount();
});

test("pending reports only poll GET and stop after completion", async () => {
    const h = harness();
    h.latest = report({ status: "queued" });
    await h.flush();
    h.open();
    h.state.recheck();
    await h.flush();
    expect(h.counters.create).toBe(0);
    h.latest = report({ status: "failed", overallRisk: "unknown" });
    h.advancePoll();
    await h.flush();
    expect(h.counters.status).toBe(1);
    expect(h.state.report?.status).toBe("failed");
    h.advancePoll();
    await h.flush();
    expect(h.counters.status).toBe(1);
    expect(h.counters.create).toBe(0);
    h.unmount();
});

test("guest clicks cannot submit detection", async () => {
    const h = harness();
    h.setUser(null);
    await h.flush();
    h.open();
    await h.flush();
    expect(h.counters.create).toBe(0);
    expect(h.counters.uploads).toBe(0);
    expect(h.state.canCheck).toBe(false);
    h.unmount();
});
