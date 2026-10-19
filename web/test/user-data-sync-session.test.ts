import { afterEach, beforeEach, expect, test } from "bun:test";
import localforage from "localforage";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasSyncConflict } from "@/components/canvas/canvas-sync-conflict";
import { apiClient } from "@/services/api/request";
import {
    exportCanvasSyncConflictDraftAndResume,
    getRemoteUserDataSyncSessionSnapshot,
    hasCanvasSyncConflictDraft,
    initializeRemoteUserDataSession,
    loadCanvasProjectForEditing,
    resetRemoteUserDataSync,
    saveRemoteUserDataNow,
    subscribeRemoteUserDataSyncSession,
    syncRemoteUserData,
} from "@/services/user-data-sync";
import { flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { flushAssetStorePersistence, useAssetStore } from "@/stores/use-asset-store";
import { useSyncProgressStore } from "@/stores/use-sync-progress-store";
import type { CanvasOperationsRequest } from "@/services/api/user-data";
import { CanvasNodeType } from "@/types/canvas";

const originalWindow = globalThis.window;
const originalAdapter = apiClient.defaults.adapter;
const originalGet = localforage.getItem;
const originalSet = localforage.setItem;
const originalRemove = localforage.removeItem;
const originalProjects = useCanvasStore.getState().projects;
const originalAssets = useAssetStore.getState().assets;
const scope = "remote-session-test";
const storage = new Map<string, unknown>();

beforeEach(async () => {
    resetRemoteUserDataSync();
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            setTimeout: () => 1,
            clearTimeout: () => undefined,
            localStorage: { getItem: () => scope, setItem: () => undefined },
        },
    });
    storage.clear();
    localforage.getItem = (async (key: string) => storage.get(key) ?? null) as typeof localforage.getItem;
    localforage.setItem = (async (key: string, value: unknown) => {
        storage.set(key, value);
        return value;
    }) as typeof localforage.setItem;
    localforage.removeItem = async (key: string) => {
        storage.delete(key);
    };
    useCanvasStore.setState({ projects: [] });
    useAssetStore.setState({ assets: [] });
    await initializeRemoteUserDataSession(scope);
});

afterEach(async () => {
    resetRemoteUserDataSync();
    useCanvasStore.setState({ projects: originalProjects });
    useAssetStore.setState({ assets: originalAssets });
    await Promise.all([flushCanvasStorePersistence(), flushAssetStorePersistence()]);
    apiClient.defaults.adapter = originalAdapter;
    localforage.getItem = originalGet;
    localforage.setItem = originalSet;
    localforage.removeItem = originalRemove;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

test("remote session observers wait for readiness and reset across accounts", async () => {
    const snapshots: ReturnType<typeof getRemoteUserDataSyncSessionSnapshot>[] = [];
    const unsubscribe = subscribeRemoteUserDataSyncSession(() => snapshots.push(getRemoteUserDataSyncSessionSnapshot()));
    try {
        const ready = getRemoteUserDataSyncSessionSnapshot();
        expect(ready).toEqual({ userId: scope, phase: "ready" });
        expect(getRemoteUserDataSyncSessionSnapshot()).toBe(ready);
        resetRemoteUserDataSync();
        await initializeRemoteUserDataSession("second-account");
        expect(snapshots).toEqual([
            { userId: "", phase: "inactive" },
            { userId: "second-account", phase: "ready" },
        ]);
        expect(ready).toEqual({ userId: scope, phase: "ready" });
        unsubscribe();
        resetRemoteUserDataSync();
        expect(snapshots).toHaveLength(2);
    } finally {
        unsubscribe();
    }
});

test("remote session observers distinguish snapshot failure from readiness", async () => {
    const snapshots: ReturnType<typeof getRemoteUserDataSyncSessionSnapshot>[] = [];
    const unsubscribe = subscribeRemoteUserDataSyncSession(() => snapshots.push(getRemoteUserDataSyncSessionSnapshot()));
    apiClient.defaults.adapter = async () => {
        throw new Error("snapshot unavailable");
    };
    try {
        await expect(syncRemoteUserData(scope)).rejects.toThrow("snapshot unavailable");
        expect(snapshots).toEqual([
            { userId: scope, phase: "hydrating" },
            { userId: scope, phase: "failed" },
        ]);
        expect(getRemoteUserDataSyncSessionSnapshot()).toBe(snapshots[1]!);
    } finally {
        unsubscribe();
    }
});

function screenProject(): CanvasProject {
    return {
        id: "screen",
        revision: 30,
        title: "Screen",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        nodes: ["control", "mask", "original"].map((id) => ({ id, title: id, type: CanvasNodeType.Text, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { prompt: "original prompt" } })),
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "dots",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        previsScenes: [],
        creationScene: { kind: "irregular-screen", version: 1, nodeIds: { controlImage: "control", outputMask: "mask", generation: "original" } },
    };
}

function withCloudResults(base: CanvasProject): CanvasProject {
    return { ...base, revision: 33, nodes: [...base.nodes, { ...base.nodes[2]!, id: "A" }, { ...base.nodes[2]!, id: "B" }], creationScene: { ...base.creationScene!, nodeIds: { ...base.creationScene!.nodeIds, generation: "A" } } };
}

function renderConflict(projectId: string) {
    const initialState = useSyncProgressStore.getInitialState();
    const initialProjects = initialState.syncingProjects;
    initialState.syncingProjects = useSyncProgressStore.getState().syncingProjects;
    try {
        return renderToStaticMarkup(createElement(CanvasSyncConflict, { projectId }));
    } finally {
        initialState.syncingProjects = initialProjects;
    }
}

for (const entry of ["load", "login"] as const) {
    test(`${entry} rebases verified local edits without deleting cloud results or restoring the old scene`, async () => {
        const baseline = screenProject();
        let cloud = baseline;
        const writes: CanvasOperationsRequest[] = [];
        apiClient.defaults.adapter = async (config) => {
            let data: unknown;
            if (config.method === "patch") {
                const request = JSON.parse(config.data) as CanvasOperationsRequest;
                writes.push(request);
                expect(request.operations).toEqual([{ type: "patch_node", id: "original", patch: { "metadata.prompt": "local edit" }, before: { "metadata.prompt": "original prompt" } }]);
                cloud = { ...cloud, revision: 34, nodes: cloud.nodes.map((node) => (node.id === "original" ? { ...node, metadata: { ...node.metadata, prompt: "local edit" } } : node)) };
                data = { project: { id: cloud.id, revision: cloud.revision }, mutationId: request.mutationId };
            } else data = config.url === "/user-data/snapshot" ? { assets: [], projects: [cloud] } : { project: cloud };
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "ok", data: structuredClone(data) } };
        };
        await loadCanvasProjectForEditing(baseline.id);
        useCanvasStore.getState().updateProject(baseline.id, { nodes: baseline.nodes.map((node) => (node.id === "original" ? { ...node, metadata: { ...node.metadata, prompt: "local edit" } } : node)) });
        cloud = withCloudResults(baseline);
        if (entry === "load") await loadCanvasProjectForEditing(baseline.id);
        else await syncRemoteUserData(scope);
        const merged = useCanvasStore.getState().openProject(baseline.id)!;
        expect(merged.nodes.map((node) => node.id)).toEqual(["control", "mask", "original", "A", "B"]);
        expect(merged.creationScene?.nodeIds.generation).toBe("A");
        expect(merged.nodes[2]?.metadata?.prompt).toBe("local edit");
        await saveRemoteUserDataNow(baseline.id);
        expect(writes).toHaveLength(1);
        expect(cloud.nodes).toHaveLength(5);
        expect(cloud.creationScene?.nodeIds.generation).toBe("A");
    });

    test(`${entry} retains an unverified local draft and displays cloud results without sending deletion operations`, async () => {
        const local = screenProject();
        local.nodes[2]!.metadata!.prompt = "unsaved local draft";
        useCanvasStore.setState({ projects: [local] });
        await initializeRemoteUserDataSession(scope);
        const cloud = withCloudResults(screenProject());
        let writes = 0;
        apiClient.defaults.adapter = async (config) => {
            if (config.method === "patch") {
                writes++;
                throw new Error("unexpected mutation");
            }
            const data = config.url === "/user-data/snapshot" ? { assets: [], projects: [cloud] } : { project: cloud };
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "ok", data: structuredClone(data) } };
        };
        if (entry === "load") await loadCanvasProjectForEditing(local.id);
        else await syncRemoteUserData(scope);
        const displayed = useCanvasStore.getState().openProject(local.id)!;
        expect(displayed.nodes).toHaveLength(5);
        expect(displayed.creationScene?.nodeIds.generation).toBe("A");
        const journalValue = [...storage.entries()].find(([key]) => key.includes("canvas-mutation-journal"))?.[1];
        const journal = JSON.parse(String(journalValue));
        expect(journal[0].request.operations).toEqual([]);
        expect(journal[0].conflict.draft.nodes[2].metadata.prompt).toBe("unsaved local draft");
        expect(useSyncProgressStore.getState().syncingProjects[local.id]?.errorKind).toBe("conflict");
        await expect(saveRemoteUserDataNow(local.id)).rejects.toThrow("自动保存已暂停");
        expect(writes).toBe(0);
        await initializeRemoteUserDataSession(scope);
        await loadCanvasProjectForEditing(local.id);
        await expect(saveRemoteUserDataNow(local.id)).rejects.toThrow("自动保存已暂停");
        expect(writes).toBe(0);
    });
}

test("save merges cloud additions with edits made while the operation was in flight", async () => {
    const baseline = screenProject();
    let cloud = baseline;
    const writes: CanvasOperationsRequest[] = [];
    apiClient.defaults.adapter = async (config) => {
        let data: unknown;
        if (config.method === "patch") {
            const request = JSON.parse(config.data) as CanvasOperationsRequest;
            writes.push(request);
            if (writes.length === 1) {
                expect(request.operations).toEqual([{ type: "set_field", field: "title", value: "local title", beforeValue: "Screen" }]);
                cloud = { ...withCloudResults(baseline), title: "local title" };
                const live = useCanvasStore.getState().openProject(baseline.id)!;
                useCanvasStore.getState().updateProject(baseline.id, { nodes: live.nodes.map((node) => (node.id === "original" ? { ...node, metadata: { ...node.metadata, prompt: "typed during save" } } : node)) });
            } else {
                expect(request.operations).toEqual([{ type: "patch_node", id: "original", patch: { "metadata.prompt": "typed during save" }, before: { "metadata.prompt": "original prompt" } }]);
                cloud = { ...cloud, revision: 34, nodes: cloud.nodes.map((node) => (node.id === "original" ? { ...node, metadata: { ...node.metadata, prompt: "typed during save" } } : node)) };
            }
            data = { project: { id: cloud.id, revision: cloud.revision }, mutationId: request.mutationId };
        } else data = { project: cloud };
        return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "ok", data: structuredClone(data) } };
    };
    await loadCanvasProjectForEditing(baseline.id);
    useCanvasStore.getState().updateProject(baseline.id, { title: "local title" });

    await saveRemoteUserDataNow(baseline.id);

    expect(writes).toHaveLength(2);
    expect(cloud.nodes).toHaveLength(5);
    expect(cloud.creationScene?.nodeIds.generation).toBe("A");
    expect(cloud.title).toBe("local title");
    expect(cloud.nodes[2]?.metadata?.prompt).toBe("typed during save");
    expect(useCanvasStore.getState().openProject(baseline.id)?.creationScene?.nodeIds.generation).toBe("A");
});

test("a competing scene selection preserves the local draft and stops automatic writes", async () => {
    const baseline = screenProject();
    let cloud = baseline;
    let writes = 0;
    apiClient.defaults.adapter = async (config) => {
        if (config.method === "patch") {
            writes++;
            throw new Error("unexpected mutation");
        }
        return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "ok", data: { project: structuredClone(cloud) } } };
    };
    await loadCanvasProjectForEditing(baseline.id);
    useCanvasStore.getState().updateProject(baseline.id, { creationScene: { ...baseline.creationScene!, nodeIds: { ...baseline.creationScene!.nodeIds, generation: "mask" } } });
    cloud = withCloudResults(baseline);

    await loadCanvasProjectForEditing(baseline.id);

    const journalValue = [...storage.entries()].find(([key]) => key.includes("canvas-mutation-journal"))?.[1];
    expect(JSON.parse(String(journalValue))[0].conflict.draft.creationScene.nodeIds.generation).toBe("mask");
    expect(useCanvasStore.getState().openProject(baseline.id)?.creationScene?.nodeIds.generation).toBe("A");
    await expect(saveRemoteUserDataNow(baseline.id)).rejects.toThrow("自动保存已暂停");
    expect(writes).toBe(0);
});

test("conflict export uses the retained draft, preserves it on failure and resumes without losing newer edits", async () => {
    const local = screenProject();
    local.title = "unsaved local draft";
    useCanvasStore.setState({ projects: [local] });
    await initializeRemoteUserDataSession(scope);
    let cloud = withCloudResults(screenProject());
    const writes: CanvasOperationsRequest[] = [];
    apiClient.defaults.adapter = async (config) => {
        if (config.method === "patch") {
            const request = JSON.parse(config.data) as CanvasOperationsRequest;
            writes.push(request);
            expect(request.operations).toEqual([{ type: "set_field", field: "title", value: "edited during export", beforeValue: "Screen" }]);
            cloud = { ...cloud, revision: 34, title: "edited during export" };
        }
        return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "ok", data: { project: structuredClone(cloud) } } };
    };
    await loadCanvasProjectForEditing(local.id);
    const recoveryMarkup = renderConflict(local.id);
    expect(recoveryMarkup).toContain("自动保存已暂停");
    expect(recoveryMarkup).toContain("导出保留草稿并继续编辑");
    await expect(
        exportCanvasSyncConflictDraftAndResume(local.id, async (draft) => {
            expect(draft.title).toBe("unsaved local draft");
            throw new Error("download failed");
        }),
    ).rejects.toThrow("download failed");
    expect(hasCanvasSyncConflictDraft(local.id)).toBe(true);
    await expect(saveRemoteUserDataNow(local.id)).rejects.toThrow("自动保存已暂停");

    await exportCanvasSyncConflictDraftAndResume(local.id, async (draft) => {
        expect(draft.title).toBe("unsaved local draft");
        expect(draft.nodes).toHaveLength(3);
        expect(draft.creationScene?.nodeIds.generation).toBe("original");
        useCanvasStore.getState().updateProject(local.id, { title: "edited during export" });
    });

    expect(hasCanvasSyncConflictDraft(local.id)).toBe(false);
    expect(renderConflict(local.id)).toBe("");
    expect(useCanvasStore.getState().openProject(local.id)?.title).toBe("edited during export");
    await saveRemoteUserDataNow(local.id);
    expect(writes).toHaveLength(1);
    expect(cloud.nodes).toHaveLength(5);
    expect(cloud.creationScene?.nodeIds.generation).toBe("A");
});

test("an account session reset during draft export does not resolve the persisted conflict", async () => {
    const local = screenProject();
    local.title = "retained draft";
    useCanvasStore.setState({ projects: [local] });
    await initializeRemoteUserDataSession(scope);
    const cloud = withCloudResults(screenProject());
    apiClient.defaults.adapter = async (config) => ({ config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "ok", data: { project: structuredClone(cloud) } } });
    await loadCanvasProjectForEditing(local.id);

    await expect(
        exportCanvasSyncConflictDraftAndResume(local.id, async () => {
            resetRemoteUserDataSync();
        }),
    ).rejects.toThrow("画布会话已变化");

    await initializeRemoteUserDataSession(scope);
    await loadCanvasProjectForEditing(local.id);
    expect(hasCanvasSyncConflictDraft(local.id)).toBe(true);
    await expect(saveRemoteUserDataNow(local.id)).rejects.toThrow("自动保存已暂停");
});

test("undoing to the old acknowledged content during save is preserved as a later edit", async () => {
    const baseline = screenProject();
    let cloud = baseline;
    const values: unknown[] = [];
    apiClient.defaults.adapter = async (config) => {
        if (config.method === "patch") {
            const request = JSON.parse(config.data) as CanvasOperationsRequest;
            const operation = request.operations[0]!;
            expect(operation.type).toBe("set_field");
            values.push(operation.value);
            cloud = { ...cloud, revision: 31 + values.length, title: String(operation.value) };
            if (values.length === 1) useCanvasStore.getState().updateProject(baseline.id, { title: "Screen" });
        }
        return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "ok", data: { project: structuredClone(cloud) } } };
    };
    await loadCanvasProjectForEditing(baseline.id);
    useCanvasStore.getState().updateProject(baseline.id, { title: "New" });
    await saveRemoteUserDataNow(baseline.id);
    expect(values).toEqual(["New", "Screen"]);
    expect(useCanvasStore.getState().openProject(baseline.id)?.title).toBe("Screen");
});

for (const interruption of ["edit", "storage-failure"] as const) {
    test(`conflict adoption can retry after ${interruption} while preserving every local draft`, async () => {
        const local = { ...screenProject(), title: "first draft" };
        useCanvasStore.setState({ projects: [local] });
        await initializeRemoteUserDataSession(scope);
        const cloud = withCloudResults(screenProject());
        apiClient.defaults.adapter = async (config) => ({ config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "ok", data: { project: structuredClone(cloud) } } });
        const write = localforage.setItem;
        let interrupted = false;
        localforage.setItem = (async (key: string, value: unknown) => {
            if (key.includes("canvas-mutation-journal") && !interrupted) {
                interrupted = true;
                if (interruption === "storage-failure") throw new Error("disk unavailable");
                useCanvasStore.getState().updateProject(local.id, { title: "edited during journal write" });
            }
            return write.call(localforage, key, value);
        }) as typeof localforage.setItem;
        await expect(loadCanvasProjectForEditing(local.id)).rejects.toThrow();
        await loadCanvasProjectForEditing(local.id);
        expect(useCanvasStore.getState().openProject(local.id)?.creationScene?.nodeIds.generation).toBe("A");
        await exportCanvasSyncConflictDraftAndResume(local.id, async (draft, additional) => {
            expect(draft.title).toBe("first draft");
            expect(additional.map((item) => item.title)).toEqual(interruption === "edit" ? ["edited during journal write"] : []);
        });
        expect(hasCanvasSyncConflictDraft(local.id)).toBe(false);
    });
}

test("editing after a conflict and reopening retains both drafts and can resume", async () => {
    const local = { ...screenProject(), title: "first draft" };
    useCanvasStore.setState({ projects: [local] });
    await initializeRemoteUserDataSession(scope);
    const cloud = withCloudResults(screenProject());
    apiClient.defaults.adapter = async (config) => ({ config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "ok", data: { project: structuredClone(cloud) } } });
    await loadCanvasProjectForEditing(local.id);
    useCanvasStore.getState().updateProject(local.id, { title: "second draft" });
    await initializeRemoteUserDataSession(scope);
    await loadCanvasProjectForEditing(local.id);
    expect(useCanvasStore.getState().openProject(local.id)?.creationScene?.nodeIds.generation).toBe("A");
    await exportCanvasSyncConflictDraftAndResume(local.id, async (draft, additional) => {
        expect(draft.title).toBe("first draft");
        expect(additional.map((item) => item.title)).toEqual(["second draft"]);
        expect(additional[0]?.creationScene?.nodeIds.generation).toBe("A");
    });
    expect(hasCanvasSyncConflictDraft(local.id)).toBe(false);
});

for (const entry of ["load", "login"] as const) {
    test(`${entry} preserves an undo after an accepted mutation loses its response`, async () => {
        const baseline = screenProject();
        let cloud = baseline;
        const writes: CanvasOperationsRequest[] = [];
        let confirmationAvailable = false;
        apiClient.defaults.adapter = async (config) => {
            if (config.method === "patch") {
                const request = JSON.parse(config.data) as CanvasOperationsRequest;
                writes.push(request);
                const title = request.operations.find((operation) => operation.type === "set_field" && operation.field === "title");
                if (title?.type === "set_field") cloud = { ...cloud, revision: 31, title: title.value as string };
                if (!confirmationAvailable) throw new Error("response lost after server accepted mutation");
                const data = { project: { id: cloud.id, revision: cloud.revision }, mutationId: request.mutationId };
                return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "ok", data } };
            }
            const data = config.url === "/user-data/snapshot" ? { assets: [], projects: [cloud] } : { project: cloud };
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "ok", data: structuredClone(data) } };
        };
        await loadCanvasProjectForEditing(baseline.id);
        useCanvasStore.getState().updateProject(baseline.id, { title: "New" });
        await expect(saveRemoteUserDataNow(baseline.id)).rejects.toThrow("response lost");
        useCanvasStore.getState().updateProject(baseline.id, { title: "Screen" });
        await initializeRemoteUserDataSession(scope);

        if (entry === "load") await loadCanvasProjectForEditing(baseline.id);
        else await syncRemoteUserData(scope);

        expect(hasCanvasSyncConflictDraft(baseline.id)).toBe(false);
        expect(useCanvasStore.getState().openProject(baseline.id)?.title).toBe("Screen");
        expect(writes).toHaveLength(1);
        await expect(saveRemoteUserDataNow(baseline.id)).rejects.toThrow("response lost");
        expect(useCanvasStore.getState().openProject(baseline.id)?.title).toBe("Screen");
        await initializeRemoteUserDataSession(scope);
        await loadCanvasProjectForEditing(baseline.id);
        confirmationAvailable = true;
        await saveRemoteUserDataNow(baseline.id);
        expect(writes).toHaveLength(4);
        expect(writes[1]).toEqual(writes[0]);
        expect(writes[2]).toEqual(writes[0]);
        expect(writes[3]!.mutationId).not.toBe(writes[0]!.mutationId);
        expect(writes[3]!.operations).toEqual([{ type: "set_field", field: "title", beforeValue: "New", value: "Screen" }]);
        expect(cloud.title).toBe("Screen");
        expect(useCanvasStore.getState().openProject(baseline.id)?.title).toBe("Screen");
        expect(hasCanvasSyncConflictDraft(baseline.id)).toBe(false);
    });
}
