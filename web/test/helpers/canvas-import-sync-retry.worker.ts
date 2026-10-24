import localforage from "localforage";
import { canvasAppearanceForPreset } from "../../src/lib/canvas/canvas-appearance";
import { remapImportedCanvasNode } from "../../src/lib/canvas/canvas-import";
import { bindCanvasNodeAsset } from "../../src/lib/canvas/canvas-node-asset";
import { rebaseCanvasLocalEdits } from "../../src/lib/canvas/canvas-sync-rebase";
import { setActiveUserScope } from "../../src/lib/user-scope";
import { ApiError, apiClient } from "../../src/services/api/request";
import type { CanvasOperationsRequest } from "../../src/services/api/user-data";
import { ensureCanvasNodeAsset } from "../../src/services/project-asset-sync";
import { initializeRemoteUserDataSession, installRemoteUserDataAutoSync, loadCanvasProjectForEditing, saveRemoteUserDataNow, scheduleRemoteUserDataSync, subscribeAgentCanvasRefresh } from "../../src/services/user-data-sync";
import { flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "../../src/stores/canvas/use-canvas-store";
import { flushAssetStorePersistence, useAssetStore, type Asset } from "../../src/stores/use-asset-store";
import { useSyncProgressStore } from "../../src/stores/use-sync-progress-store";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const disk = new Map<string, unknown>();
const timers = new Map<number, () => void>();
let nextTimer = 1;
Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
        setTimeout: (callback: () => void) => {
            const id = nextTimer++;
            timers.set(id, callback);
            return id;
        },
        clearTimeout: (id: number) => timers.delete(id),
        localStorage: { getItem: (key: string) => disk.get(key) ?? null, setItem: (key: string, value: string) => disk.set(key, value), removeItem: (key: string) => disk.delete(key) },
        addEventListener: () => {},
        removeEventListener: () => {},
    },
});
localforage.getItem = (async (key: string) => disk.get(key) ?? null) as typeof localforage.getItem;
localforage.setItem = (async (key: string, value: unknown) => {
    disk.set(key, value);
    return value;
}) as typeof localforage.setItem;
localforage.removeItem = async (key: string) => {
    disk.delete(key);
};

let remote: CanvasProject | undefined;
let remoteAsset: Asset | undefined;
let assetAttempts = 0;
let canvasWrites = 0;
let retryGate: { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
apiClient.defaults.adapter = async (config) => {
    const url = String(config.url);
    let data: unknown;
    if (url.startsWith("/assets/") && config.method === "get") {
        if (!remoteAsset) throw new ApiError("not found", { status: 404 });
        data = { asset: remoteAsset };
    } else if (url.startsWith("/assets/") && config.method === "put") {
        assetAttempts++;
        if (retryGate) {
            retryGate.started.resolve();
            await retryGate.release.promise;
        }
        if (assetAttempts <= 3) throw new ApiError("model registration unavailable", { status: 503, retryable: true });
        remoteAsset = JSON.parse(config.data).asset;
        data = { asset: remoteAsset };
    } else if (url.endsWith("/operations") && config.method === "patch") {
        const request = JSON.parse(config.data) as CanvasOperationsRequest;
        canvasWrites++;
        if (remote) remote.revision = Number(remote.revision) + 1;
        for (const operation of request.operations) {
            if (operation.type === "create_canvas") {
                remote = JSON.parse(JSON.stringify({ id: operation.id, projectId: "", ...operation.patch, createdAt: "2026-10-24T01:00:00Z", updatedAt: "2026-10-24T01:00:00Z", revision: 1, nodes: [], connections: [] }));
            } else if (operation.type === "create_node") remote!.nodes.push(operation.node);
            else if (operation.type === "patch_node") {
                const node = remote!.nodes.find((item) => item.id === operation.id)!;
                for (const [path, value] of Object.entries(operation.patch)) {
                    const keys = path.split(".");
                    let target = node as unknown as Record<string, unknown>;
                    for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
                    target[keys.at(-1)!] = value;
                }
            } else throw new Error(`Unexpected canvas operation: ${operation.type}`);
        }
        data = { project: { id: remote!.id, revision: remote!.revision }, mutationId: request.mutationId };
    } else if (url.startsWith("/canvas-projects/") && config.method === "get") {
        if (!remote) throw new ApiError("not found", { status: 404 });
        data = { project: structuredClone(remote) };
    } else throw new Error(`Unexpected request: ${config.method} ${url}`);
    return { config, status: 200, statusText: "", headers: {}, data: { code: 0, data, msg: "ok" } };
};

setActiveUserScope("canvas-import-retry-test");
useCanvasStore.setState({ projects: [] });
useAssetStore.setState({ assets: [] });
await initializeRemoteUserDataSession("canvas-import-retry-test");
installRemoteUserDataAutoSync();

const nodes: CanvasNodeData[] = [
    remapImportedCanvasNode(
        {
            id: "model-node",
            type: CanvasNodeType.Model3D,
            title: "model.glb",
            position: { x: 0, y: 0 },
            width: 520,
            height: 420,
            metadata: {
                assetId: "source-asset",
                storageKey: "resource:source-resource",
                content: "/api/resources/source-resource/file",
                status: "success",
                model3d: {
                    schemaVersion: 1,
                    draft: { mode: "text", prompt: "A block", parameters: { model: "test-model", faceLimit: 5000, pbr: false, texture: false }, views: {} },
                    result: { assetId: "source-asset", resourceId: "source-resource", storageKey: "resource:source-resource", url: "/api/resources/source-resource/file", fileName: "model.glb", format: "glb", mimeType: "model/gltf-binary", bytes: 128 },
                },
            },
        },
        new Map([["resource:source-resource", { storageKey: "resource:import-resource", url: "/api/resources/import-resource/file" }]]),
    ),
    {
        id: "text-node",
        type: CanvasNodeType.Text,
        title: "Text",
        position: { x: 600, y: 0 },
        width: 340,
        height: 240,
        metadata: { content: "Keep this text" },
    },
];
const id = useCanvasStore.getState().importProject({ title: "Imported canvas", createdAt: "2026-10-21T00:00:00Z", nodes, connections: [], appearance: canvasAppearanceForPreset("light") });
await flushCanvasStorePersistence();

// A retryable registration failure retains the local asset and reports pending
// sync. An interrupted import can leave its saved draft without that binding.
const interruptedImport = Bun.argv[3] === "interrupted";
const initialRegistration = await ensureCanvasNodeAsset({ canvasId: id, node: nodes[0], source: "canvas-upload" });
if (interruptedImport) {
    useSyncProgressStore.getState().setProjectProgress(id, { phase: "error", message: "model registration unavailable" });
    scheduleRemoteUserDataSync();
} else {
    // Match the importer: bind the retained asset, save the canvas, and schedule
    // another attempt when registration still prevents the complete save.
    nodes[0] = bindCanvasNodeAsset(nodes[0], initialRegistration.assetId);
    useCanvasStore.getState().updateProject(id, { nodes });
    useSyncProgressStore.getState().setProjectProgress(id, { phase: "saving", message: "正在保存画布结构" });
    await flushCanvasStorePersistence();
    try {
        await saveRemoteUserDataNow(id);
        throw new Error("The initial canvas save should wait for model registration");
    } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 503) throw error;
        scheduleRemoteUserDataSync();
    }
}
await loadCanvasProjectForEditing(id);

let editorNodes = useCanvasStore.getState().openProject(id)!.nodes;
const importedModel = editorNodes.find((node) => node.id === "model-node")!;
const importedAssetBoundBeforeRetry = Boolean(importedModel.metadata?.assetId && importedModel.metadata?.model3d?.result?.assetId);
const dispose = subscribeAgentCanvasRefresh((project, previous, source) => {
    if (project.id !== id || source !== "sync") return;
    // The open lifecycle merges sync projections against its live node refs,
    // then persists the resulting React state through updateProject.
    editorNodes = previous ? rebaseCanvasLocalEdits(previous, project, { ...previous, nodes: editorNodes }).nodes : project.nodes;
    const next = editorNodes;
    queueMicrotask(() => useCanvasStore.getState().updateProject(id, { nodes: next }));
});
// Keep this edit in the editor only, before its persistence effect has run.
if (Bun.argv[2] === "edited") editorNodes = editorNodes.map((node) => (node.id === "text-node" ? { ...node, title: "Edited during retry" } : node));

const retryCount = interruptedImport ? 3 : 2;
for (let retry = 0; retry < retryCount; retry++) {
    if (timers.size !== 1) throw new Error(`Expected one scheduled retry, got ${timers.size}`);
    const callback = [...timers.values()][0];
    timers.clear();
    retryGate = { started: deferred(), release: deferred() };
    callback();
    await retryGate.started.promise;
    // Join the already-running timer's single flight while its PUT is held.
    const completion = saveRemoteUserDataNow();
    retryGate.release.resolve();
    try {
        await completion;
    } catch (error) {
        if (retry === retryCount - 1 || !(error instanceof ApiError) || error.status !== 503) throw error;
    }
    retryGate = undefined;
    await flushCanvasStorePersistence();
}

// Drain the no-op work queued by editor/store projection, with no wall-clock sleeps.
for (let pass = 0; timers.size && pass < 3; pass++) {
    const callbacks = [...timers.values()];
    timers.clear();
    callbacks.forEach((callback) => callback());
    await saveRemoteUserDataNow();
    await flushCanvasStorePersistence();
}
await flushAssetStorePersistence();
dispose();
const localNodes = useCanvasStore.getState().openProject(id)!.nodes;
const model = (items: CanvasNodeData[]) => items.find((node) => node.id === "model-node")!;
const text = (items: CanvasNodeData[]) => items.find((node) => node.id === "text-node")!;
const nodeSets = [editorNodes, localNodes, remote!.nodes];
console.log(
    JSON.stringify({
        initialRegistration,
        importedAssetBoundBeforeRetry,
        assetAttempts,
        canvasWrites,
        remoteRevision: remote!.revision,
        assetId: remoteAsset!.id,
        nodeCounts: { editor: editorNodes.length, local: localNodes.length, remote: remote!.nodes.length },
        bindings: nodeSets.map((items) => model(items).metadata?.assetId),
        resultBindings: nodeSets.map((items) => model(items).metadata?.model3d?.result?.assetId),
        titles: nodeSets.map((items) => text(items).title),
        progress: useSyncProgressStore.getState().syncingProjects[id],
        isAnySyncing: useSyncProgressStore.getState().isAnySyncing(),
    }),
);
