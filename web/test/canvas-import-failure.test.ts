import { afterEach, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { createDefaultModel3DState } from "@/lib/canvas/model3d";
import { canvasNodeToAsset } from "@/lib/canvas/canvas-node-asset";
import { repairMissingCanvasAssets } from "@/services/canvas-asset-repair";
import { useCanvasStore, withCanvasStorePersistenceSuppressed, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useAssetStore, withAssetStorePersistenceSuppressed, type Asset } from "@/stores/use-asset-store";
import type { CanvasExportFile } from "@/types/canvas-export";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const require = createRequire(import.meta.url);
const builds = await Promise.all(["pages/canvas/index.tsx", "services/project-asset-sync.ts"].map(async (path) => {
    const build = await Bun.build({ entrypoints: [new URL(`../src/${path}`, import.meta.url).pathname], target: "node", format: "cjs", external: ["*"] });
    if (!build.success) throw new Error(build.logs.map(String).join("\n"));
    return build.outputs[0].text();
}));
const initialProjects = useCanvasStore.getState().projects;
const initialAssets = useAssetStore.getState().assets;
afterEach(() => {
    withCanvasStorePersistenceSuppressed(() => useCanvasStore.setState({ projects: initialProjects }));
    withAssetStorePersistenceSuppressed(() => useAssetStore.setState({ assets: initialAssets }));
});

function fixture() {
    const state = createDefaultModel3DState();
    state.result = { assetId: "original-asset", resourceId: "original", storageKey: "resource:original", url: "/api/resources/original/file", fileName: "toy.glb", mimeType: "model/gltf-binary", bytes: 12, format: "glb" };
    state.run = { taskId: "original-task", requestId: "original-request", status: "succeeded", sourceFingerprint: "original-fingerprint", snapshot: structuredClone(state.draft) };
    const model: CanvasNodeData = { id: "model", type: CanvasNodeType.Model3D, title: "toy.glb", position: { x: 0, y: 0 }, width: 520, height: 420, metadata: { storageKey: state.result.storageKey, content: state.result.url, assetId: state.result.assetId, taskId: "original-task", model3d: state } };
    const text: CanvasNodeData = { id: "text", type: CanvasNodeType.Text, title: "note", position: { x: 600, y: 0 }, width: 200, height: 100, metadata: { content: "keep my draft", fontSize: 16 } };
    const source: CanvasProject = { id: "original-canvas", title: "Source", createdAt: "", updatedAt: "", nodes: [model, text], connections: [{ id: "edge", from: "model", to: "text" }], chatSessions: [], activeChatId: null, viewport: { x: 0, y: 0, k: 1 }, timeline: { clips: [] } };
    const asset = { ...canvasNodeToAsset(model, { canvasId: source.id, source: "canvas-upload" }), id: "original-asset", createdAt: "", updatedAt: "" } as Asset;
    const archive: CanvasExportFile = { app: "yingce", version: 4, exportedAt: "", projects: [{ project: source, files: [{ storageKey: "resource:original", path: "media/toy.glb", mimeType: "model/gltf-binary", bytes: 12 }] }] };
    return { source, asset, archive };
}

function harness(options: { failLocalSave?: boolean; failUpload?: boolean; failAssetSync?: boolean | "permanent" } = {}) {
    const { source, asset, archive } = fixture();
    withCanvasStorePersistenceSuppressed(() => useCanvasStore.setState({ projects: [structuredClone(source)] }));
    withAssetStorePersistenceSuppressed(() => useAssetStore.setState({ assets: [structuredClone(asset)] }));
    const persisted: CanvasProject[][] = [];
    const created: CanvasProject[] = [];
    const navigations: string[] = [];
    const writes = new Map<string, Blob>();
    const remoteSnapshots: CanvasProject[][] = [];
    const notices: Array<{ kind: string; content: unknown }> = [];
    let syncRetries = 0;
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => { finish = resolve; });
    const notice = (kind: string) => (content: unknown) => { notices.push({ kind, content }); finish(); };
    const message = { loading: () => () => undefined, success: notice("success"), warning: notice("warning"), error: notice("error") };
    const canvasState = () => ({
        ...useCanvasStore.getState(), hydrated: true,
        importProject: (input: Partial<CanvasProject>) => withCanvasStorePersistenceSuppressed(() => {
            const id = useCanvasStore.getState().importProject(input);
            created.push(structuredClone(useCanvasStore.getState().projects.find((item) => item.id === id)!));
            return id;
        }),
        updateProject: (id: string, patch: Partial<CanvasProject>) => withCanvasStorePersistenceSuppressed(() => useCanvasStore.getState().updateProject(id, patch)),
    });
    const canvasStore = Object.assign((selector: (state: ReturnType<typeof canvasState>) => unknown) => selector(canvasState()), { getState: canvasState });
    const assetStore = { getState: () => ({
        ...useAssetStore.getState(),
        addAsset: (input: Parameters<ReturnType<typeof useAssetStore.getState>["addAsset"]>[0]) => withAssetStorePersistenceSuppressed(() => useAssetStore.getState().addAsset(input)),
    }) };
    const sync = {
        hasRemoteUserDataSyncSession: () => true,
        subscribeRemoteUserDataReady: () => () => undefined,
        saveRemoteUserDataNow: async () => {
            remoteSnapshots.push(structuredClone(useCanvasStore.getState().projects));
            if (options.failAssetSync === "permanent") throw Object.assign(new Error("Asset sync rejected"), { permanent: true });
            if (options.failAssetSync !== false) throw new Error("Network Error");
        },
        scheduleRemoteUserDataSync: () => { syncRetries += 1; },
        loadAssetsForUse: async () => { throw new Error("Import must not load the source asset"); },
    };
    const baseRequire = (name: string): any => {
        if (name === "@/services/user-data-sync") return sync;
        if (name === "@/stores/use-asset-store") return { useAssetStore: assetStore };
        return require(name.startsWith("@/") ? new URL(`../src/${name.slice(2)}`, import.meta.url).pathname : name);
    };
    // Run the real ensureCanvasNodeAsset: it creates a local asset before the remote save rejects.
    const assetModule = { exports: {} as typeof import("@/services/project-asset-sync") };
    runInNewContext(builds[1], { module: assetModule, exports: assetModule.exports, require: baseRequire, Error, DOMException, setTimeout, clearTimeout });
    const saveBlob = async (key: string, blob: Blob) => {
        if (options.failLocalSave) throw new Error("Local media quota exceeded");
        writes.set(key, blob);
        return `blob:${key}`;
    };
    const ui = new Proxy({}, { get: (_, name) => String(name) });
    const pageModule = { exports: {} as { default(): any } };
    runInNewContext(builds[0], {
        module: pageModule, exports: pageModule.exports, crypto, Error, console: { warn() {}, error() {} },
        window: { requestAnimationFrame: (callback: () => void) => callback() },
        require(name: string): any {
            if (name === "react") return { lazy: () => "Lazy", Suspense: "Suspense", useState: (value: unknown) => [value, () => undefined], useRef: (current: unknown) => ({ current }), useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn, useEffect() {} };
            if (name === "react-router") return { useNavigate: () => (path: string) => navigations.push(path), useSearchParams: () => [new URLSearchParams()] };
            if (name === "@tanstack/react-query") return { useInfiniteQuery: () => ({ data: { pages: [{ projects: [], total: 0 }] }, isSuccess: true }), useQuery: () => ({ data: { projects: [] } }) };
            if (name === "antd") return { ...ui, App: { useApp: () => ({ message }) }, Button: "Button", Modal: "Modal", Input: "Input", Dropdown: "Dropdown" };
            if (name.startsWith("@/components/") || name === "lucide-react") return ui;
            if (name === "@/stores/canvas/use-canvas-store") return { useCanvasStore: canvasStore, flushCanvasStorePersistence: async () => { persisted.push(structuredClone(useCanvasStore.getState().projects)); } };
            if (name === "@/stores/canvas/use-canvas-ui-store") return { useCanvasUiStore: (selector: (state: unknown) => unknown) => selector({ selectedProjectIds: [], deleteProjectIds: [] }) };
            if (name === "@/stores/use-user-store") return { useUserStore: (selector: (state: unknown) => unknown) => selector({ user: { id: "test-user" }, hydrated: true, features: {} }) };
            if (name === "@/stores/use-appearance-store") return { useAppearanceStore: (selector: (state: unknown) => unknown) => selector({ appearance: { brandName: "Test" } }) };
            if (name === "@/stores/use-sync-progress-store") return { useSyncProgressStore: { getState: () => ({ setProjectProgress() {}, incrementProjectCompleted() {} }) } };
            if (name === "@/lib/zip") return { readZip: async () => new Map([["projects.json", new Blob([JSON.stringify(archive)])], ["media/toy.glb", new Blob(["model bytes"]) ]]) };
            if (name === "@/lib/workspace-route-modules") return { loadCanvasProjectPage: async () => undefined };
            if (name === "@/services/api/resources") return { ...baseRequire(name), uploadResourceFile: async () => { if (options.failUpload !== false) throw new Error("Offline upload"); return { id: "imported-resource" }; } };
            if (name === "@/services/resource-blob-cache") return { primeResourceBlobCache: async () => "" };
            if (name === "@/services/file-storage") return { setMediaBlob: saveBlob };
            if (name === "@/services/image-storage") return { setImageBlob: saveBlob };
            if (name === "@/services/project-asset-sync") return assetModule.exports;
            return baseRequire(name);
        },
    });
    const findInput = (value: any): any => {
        if (!value || typeof value !== "object") return undefined;
        if (value.type === "input" && value.props.type === "file") return value;
        return (Array.isArray(value) ? value : Object.values(value.props || {})).map(findInput).find(Boolean);
    };
    return {
        source, asset, persisted, created, navigations, writes, remoteSnapshots, notices,
        retries: () => syncRetries,
        async run() {
            findInput(pageModule.exports.default()).props.onChange({ target: { files: [new File([], "canvas.zip")] } });
            await completed;
        },
    };
}

test("retryable asset-sync failure retains a complete bound import draft after offline media fallback", async () => {
    const h = harness();
    await h.run();
    const draft = useCanvasStore.getState().projects.find((item) => item.id !== h.source.id)!;
    expect(draft.nodes).toHaveLength(2);
    expect(draft.connections).toEqual(h.source.connections);
    expect(draft.timeline).toEqual(h.source.timeline);
    expect(h.created[0].nodes).toHaveLength(2);
    expect(h.persisted.at(-1)?.find((item) => item.id === draft.id)?.nodes).toEqual(draft.nodes);
    const model = draft.nodes[0];
    expect(model.metadata?.storageKey).not.toBe("resource:original");
    expect(h.writes.has(model.metadata!.storageKey!)).toBe(true);
    expect(model.metadata?.model3d?.result?.storageKey).toBe(model.metadata?.storageKey);
    expect(model.metadata?.model3d?.run).toBeUndefined();
    expect(model.metadata?.taskId).toBeUndefined();
    expect(useAssetStore.getState().assets.some((item) => item.id !== h.asset.id && item.metadata?.canvasId === draft.id)).toBe(true);
    // Transient asset sync now returns its local asset with syncPending, so
    // import can bind it before the final canvas save also reports offline.
    expect(h.remoteSnapshots).toHaveLength(2);
    expect(h.remoteSnapshots[0].find((item) => item.id === draft.id)?.nodes).toHaveLength(2);
    expect(h.remoteSnapshots.at(-1)?.find((item) => item.id === draft.id)?.nodes).toEqual(draft.nodes);
    const importedAsset = useAssetStore.getState().assets.find((item) => item.metadata?.canvasId === draft.id)!;
    expect(model.metadata?.assetId).toBe(importedAsset.id);
    expect(model.metadata?.model3d?.result?.assetId).toBe(importedAsset.id);
    expect(h.notices.at(-1)?.kind).toBe("warning");
    expect(h.notices.at(-1)?.content).toContain("云端同步未完成，将自动重试");
    expect(h.navigations).toHaveLength(0);
    expect(h.retries()).toBeGreaterThan(0);
    expect(useCanvasStore.getState().projects.find((item) => item.id === h.source.id)).toEqual(h.source);
    expect(useAssetStore.getState().assets.find((item) => item.id === h.asset.id)).toEqual(h.asset);
    const repaired = withCanvasStorePersistenceSuppressed(() => withAssetStorePersistenceSuppressed(() => repairMissingCanvasAssets(new Set([draft.id]), true)));
    expect(repaired).toEqual({ createdAssets: 0, updatedProjects: 0 });
    const recovered = useCanvasStore.getState().projects.find((item) => item.id === draft.id)!.nodes[0];
    expect(recovered.metadata?.assetId).toBe(importedAsset.id);
    expect(recovered.metadata?.model3d?.result?.assetId).toBe(importedAsset.id);
    expect(useAssetStore.getState().assets).toHaveLength(2);
});

test("permanent asset-sync rejection opens a persisted complete draft whose asset binding can recover", async () => {
    const h = harness({ failAssetSync: "permanent" });
    await h.run();
    const draft = useCanvasStore.getState().projects.find((item) => item.id !== h.source.id)!;
    expect(draft.nodes).toHaveLength(2);
    expect(draft.connections).toEqual(h.source.connections);
    expect(h.persisted.at(-1)?.find((item) => item.id === draft.id)?.nodes).toEqual(draft.nodes);
    expect(h.remoteSnapshots).toHaveLength(1);
    expect(h.remoteSnapshots[0].find((item) => item.id === draft.id)?.nodes).toHaveLength(2);
    expect(h.notices.at(-1)).toMatchObject({ kind: "warning", content: "已保留本地导入草稿，后续保存未完成：Asset sync rejected" });
    expect(h.navigations).toContain(`/canvas/${draft.id}`);
    expect(h.retries()).toBeGreaterThan(0);
    const repaired = withCanvasStorePersistenceSuppressed(() => withAssetStorePersistenceSuppressed(() => repairMissingCanvasAssets(new Set([draft.id]), true)));
    expect(repaired).toEqual({ createdAssets: 0, updatedProjects: 1 });
    const recovered = useCanvasStore.getState().projects.find((item) => item.id === draft.id)!.nodes[0];
    const importedAsset = useAssetStore.getState().assets.find((item) => item.metadata?.canvasId === draft.id)!;
    expect(recovered.metadata?.assetId).toBe(importedAsset.id);
    expect(recovered.metadata?.model3d?.result?.assetId).toBe(importedAsset.id);
    expect(useAssetStore.getState().assets).toHaveLength(2);
    expect(useCanvasStore.getState().projects.find((item) => item.id === h.source.id)).toEqual(h.source);
    expect(useAssetStore.getState().assets.find((item) => item.id === h.asset.id)).toEqual(h.asset);
});

test("failed offline blob fallback creates no empty canvas and leaves the source available for retry", async () => {
    const h = harness({ failLocalSave: true });
    await h.run();
    expect(useCanvasStore.getState().projects).toEqual([h.source]);
    expect(useAssetStore.getState().assets).toEqual([h.asset]);
    expect(h.created).toHaveLength(0);
    expect(h.remoteSnapshots).toHaveLength(0);
    expect(h.notices.at(-1)?.kind).toBe("error");
    expect(h.navigations).toHaveLength(0);
});

test("successful ZIP import binds the new model resource and asset before the final canvas sync", async () => {
    const h = harness({ failUpload: false, failAssetSync: false });
    await h.run();
    const draft = useCanvasStore.getState().projects.find((item) => item.id !== h.source.id)!;
    const model = draft.nodes[0];
    const asset = useAssetStore.getState().assets.find((item) => item.metadata?.canvasId === draft.id)!;
    expect(model.metadata).toMatchObject({ assetId: asset.id, storageKey: "resource:imported-resource" });
    expect(model.metadata?.model3d?.result).toMatchObject({ assetId: asset.id, resourceId: "imported-resource", storageKey: "resource:imported-resource" });
    expect(h.remoteSnapshots.at(-1)?.find((item) => item.id === draft.id)?.nodes).toEqual(draft.nodes);
    expect(h.persisted.at(-1)?.find((item) => item.id === draft.id)?.nodes).toEqual(draft.nodes);
    expect(h.notices.at(-1)?.kind).toBe("success");
    expect(h.created.every((item) => item.nodes.length === 2)).toBe(true);
    expect(h.writes.size).toBe(0);
});
