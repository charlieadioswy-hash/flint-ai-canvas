import localforage from "localforage";

import { getActiveUserScope, setActiveUserScope } from "../../src/lib/user-scope";

type InstanceHook = (storeName: string, key: string, value: unknown) => Promise<void> | void;

type Scenario =
    | "image-cleanup"
    | "scope-cleanup-switch"
    | "scope-cleanup-late-canvas-reference"
    | "video-commit-race"
    | "audio-commit-race"
    | "canvas-batch-commit-race"
    | "canvas-multi-output"
    | "canvas-copy-generation"
    | "http-registered-generation"
    | "http-generation-mismatch"
    | "http-generation-missing"
    | "http-screen-generation"
    | "http-screen-generation-mismatch"
    | "http-screen-generation-missing";

function installStorageHarness() {
    const originalCreateInstance = localforage.createInstance.bind(localforage);
    const originalGetItem = localforage.getItem.bind(localforage);
    const originalSetItem = localforage.setItem.bind(localforage);
    const originalRemoveItem = localforage.removeItem.bind(localforage);
    const originalWindow = (globalThis as { window?: unknown }).window;
    const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
    const originalDocument = (globalThis as { document?: unknown }).document;
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);

    const defaultValues = new Map<string, unknown>();
    const instanceValues = new Map<string, Map<string, unknown>>();
    const localStorageValues = new Map<string, string>();
    const scheduled: Promise<void>[] = [];
    const hooks: { onSet?: InstanceHook } = {};
    const lockTails = new Map<string, Promise<void>>();

    const storeValues = (storeName: string) => {
        let values = instanceValues.get(storeName);
        if (!values) {
            values = new Map<string, unknown>();
            instanceValues.set(storeName, values);
        }
        return values;
    };

    localforage.getItem = (async (key: string) => defaultValues.get(key) ?? null) as typeof localforage.getItem;
    localforage.setItem = (async (key: string, value: unknown) => {
        defaultValues.set(key, value);
        await hooks.onSet?.("app_state", key, value);
        return value;
    }) as typeof localforage.setItem;
    localforage.removeItem = (async (key: string) => {
        defaultValues.delete(key);
    }) as typeof localforage.removeItem;
    localforage.createInstance = ((options: { storeName?: string }) => {
        const storeName = options.storeName || "default";
        const values = storeValues(storeName);
        return {
            getItem: async (key: string) => values.get(key) ?? null,
            setItem: async (key: string, value: unknown) => {
                values.set(key, value);
                await hooks.onSet?.(storeName, key, value);
                return value;
            },
            removeItem: async (key: string) => {
                values.delete(key);
            },
            iterate: async (iterator: (value: unknown, key: string, iterationNumber: number) => unknown) => {
                let index = 1;
                for (const [key, value] of values) {
                    const result = iterator(value, key, index);
                    index += 1;
                    if (result !== undefined) return result;
                }
                return undefined;
            },
            clear: async () => values.clear(),
            keys: async () => [...values.keys()],
            length: async () => values.size,
        } as never;
    }) as typeof localforage.createInstance;

    Object.defineProperty(globalThis, "window", {
        configurable: true,
        writable: true,
        value: {
            localStorage: {
                getItem: (key: string) => localStorageValues.get(key) ?? null,
                setItem: (key: string, value: string) => localStorageValues.set(key, value),
                removeItem: (key: string) => localStorageValues.delete(key),
            },
            setTimeout: (handler: () => unknown, delay = 0) => {
                const scheduledRun = new Promise<void>((resolve, reject) => {
                    realSetTimeout(() => {
                        Promise.resolve(handler()).then(() => resolve(), reject);
                    }, delay);
                });
                scheduled.push(scheduledRun);
                return scheduled.length;
            },
            clearTimeout: () => undefined,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            dispatchEvent: () => true,
        },
    });
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        writable: true,
        value: {
            locks: {
                request: async <T>(name: string, callback: () => Promise<T>) => {
                    const previous = lockTails.get(name) ?? Promise.resolve();
                    let release!: () => void;
                    const tail = new Promise<void>((resolve) => {
                        release = resolve;
                    });
                    const queued = previous.catch(() => undefined).then(() => tail);
                    lockTails.set(name, queued);
                    await previous.catch(() => undefined);
                    try {
                        return await callback();
                    } finally {
                        release();
                        if (lockTails.get(name) === queued) lockTails.delete(name);
                    }
                },
            },
        },
    });
    delete (globalThis as { document?: unknown }).document;

    return {
        hooks,
        scheduled,
        realSetTimeout,
        restore() {
            localforage.createInstance = originalCreateInstance as typeof localforage.createInstance;
            localforage.getItem = originalGetItem;
            localforage.setItem = originalSetItem;
            localforage.removeItem = originalRemoveItem;
            if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
            else Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: originalWindow });
            if (originalNavigator === undefined) delete (globalThis as { navigator?: unknown }).navigator;
            else Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: originalNavigator });
            if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
            else Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: originalDocument });
        },
    };
}

async function runImageCleanup() {
    const previousScope = getActiveUserScope();
    const harness = installStorageHarness();
    const scope = "generation-image-cleanup";
    const usedKey = `generation-image:${scope}:used`;
    const unusedKey = `generation-image:${scope}:unused`;
    const imageStorage = await import("../../src/services/image-storage.ts?generation-image-cleanup-contract-worker");

    try {
        setActiveUserScope(scope);
        await imageStorage.setImageBlob(usedKey, new Blob(["used"], { type: "image/png" }));
        await imageStorage.setImageBlob(unusedKey, new Blob(["unused"], { type: "image/png" }));
        await imageStorage.cleanupUnusedImages({ assets: [{ data: { storageKey: usedKey } }] });
        return {
            usedPresent: (await imageStorage.getImageBlob(usedKey)) instanceof Blob,
            unusedPresent: (await imageStorage.getImageBlob(unusedKey)) instanceof Blob,
        };
    } finally {
        setActiveUserScope(previousScope);
        harness.restore();
    }
}

async function runScopeCleanupAfterSwitch() {
    const previousScope = getActiveUserScope();
    const harness = installStorageHarness();
    const scopeA = "cleanup-account-a";
    const scopeB = "cleanup-account-b";
    const referencedKey = `image:${scopeA}:canvas-only`;
    const unusedKey = `image:${scopeA}:unused`;
    const otherScopeKey = `image:${scopeB}:unrelated`;

    try {
        setActiveUserScope(scopeA);
        const imageStorage = await import("../../src/services/image-storage.ts?scope-cleanup-switch-worker");
        const { useAssetStore } = await import("../../src/stores/use-asset-store");
        const { useCanvasStore } = await import("../../src/stores/canvas/use-canvas-store");
        await imageStorage.setImageBlob(referencedKey, new Blob(["account-a-referenced"], { type: "image/png" }));
        await imageStorage.setImageBlob(unusedKey, new Blob(["account-a-unused"], { type: "image/png" }));
        await imageStorage.setImageBlob(otherScopeKey, new Blob(["account-b-unrelated"], { type: "image/png" }));
        useAssetStore.setState({ assets: [] });
        useCanvasStore.setState({
            projects: [
                {
                    id: "canvas-account-a",
                    title: "account A",
                    createdAt: "2026-08-14T00:00:00.000Z",
                    updatedAt: "2026-08-14T00:00:00.000Z",
                    nodes: [
                        {
                            id: "node-account-a-image",
                            type: "image",
                            title: "account A image",
                            position: { x: 0, y: 0 },
                            width: 1,
                            height: 1,
                            metadata: { storageKey: referencedKey },
                        },
                    ],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "dots",
                    showImageInfo: false,
                    viewport: { x: 0, y: 0, k: 1 },
                    directorScenes: [],
                },
            ],
        } as never);

        useAssetStore.getState().cleanupImages({ assets: [] });
        const cleanupRun = harness.scheduled.at(-1);
        if (!cleanupRun) throw new Error("cleanup was not scheduled");

        setActiveUserScope(scopeB);
        useAssetStore.setState({ assets: [] });
        useCanvasStore.setState({
            projects: [
                {
                    id: "canvas-account-b",
                    title: "account B",
                    createdAt: "2026-08-14T00:00:00.000Z",
                    updatedAt: "2026-08-14T00:00:00.000Z",
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "dots",
                    showImageInfo: false,
                    viewport: { x: 0, y: 0, k: 1 },
                    directorScenes: [],
                },
            ],
        } as never);
        await cleanupRun;

        return {
            referencedPresent: (await imageStorage.getImageBlob(referencedKey)) instanceof Blob,
            unusedPresent: (await imageStorage.getImageBlob(unusedKey)) instanceof Blob,
            otherScopePresent: (await imageStorage.getImageBlob(otherScopeKey)) instanceof Blob,
        };
    } finally {
        setActiveUserScope(previousScope);
        harness.restore();
    }
}

async function runScopeCleanupAfterLateCanvasReference() {
    const previousScope = getActiveUserScope();
    const harness = installStorageHarness();
    const scope = "cleanup-late-canvas-reference";
    const referencedKey = `image:${scope}:late-canvas-only`;
    const unusedKey = `image:${scope}:unused`;

    try {
        setActiveUserScope(scope);
        const imageStorage = await import("../../src/services/image-storage.ts?scope-cleanup-late-canvas-reference-worker");
        const { useAssetStore } = await import("../../src/stores/use-asset-store");
        const { useCanvasStore } = await import("../../src/stores/canvas/use-canvas-store");
        await imageStorage.setImageBlob(referencedKey, new Blob(["late-canvas-reference"], { type: "image/png" }));
        await imageStorage.setImageBlob(unusedKey, new Blob(["still-unused"], { type: "image/png" }));
        useAssetStore.setState({ assets: [] });
        useCanvasStore.setState({ projects: [] });

        useAssetStore.getState().cleanupImages({ assets: [] });
        const cleanupRun = harness.scheduled.at(-1);
        if (!cleanupRun) throw new Error("cleanup was not scheduled");

        useCanvasStore.setState({
            projects: [
                {
                    id: "canvas-late-reference",
                    title: "late reference",
                    createdAt: "2026-08-14T00:00:00.000Z",
                    updatedAt: "2026-08-14T00:00:00.000Z",
                    nodes: [
                        {
                            id: "node-late-reference",
                            type: "image",
                            title: "late referenced image",
                            position: { x: 0, y: 0 },
                            width: 1,
                            height: 1,
                            metadata: { storageKey: referencedKey },
                        },
                    ],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "dots",
                    showImageInfo: false,
                    viewport: { x: 0, y: 0, k: 1 },
                    directorScenes: [],
                },
            ],
        } as never);

        await cleanupRun;

        return {
            referencedPresent: (await imageStorage.getImageBlob(referencedKey)) instanceof Blob,
            unusedPresent: (await imageStorage.getImageBlob(unusedKey)) instanceof Blob,
        };
    } finally {
        setActiveUserScope(previousScope);
        harness.restore();
    }
}

async function runMediaCommitRace(mediaType: "video" | "audio") {
    const previousScope = getActiveUserScope();
    const harness = installStorageHarness();
    const scope = `generation-media-commit-race-${mediaType}`;
    let releaseMediaWrite!: () => void;
    const mediaWriteGate = new Promise<void>((resolve) => {
        releaseMediaWrite = resolve;
    });
    let mediaWriteStartedResolve!: () => void;
    const mediaWriteStarted = new Promise<void>((resolve) => {
        mediaWriteStartedResolve = resolve;
    });
    let blocked = false;
    harness.hooks.onSet = async (storeName, key) => {
        if (!blocked && storeName === "media_files" && key.startsWith(`generation-${mediaType}:${scope}:`)) {
            blocked = true;
            mediaWriteStartedResolve();
            await mediaWriteGate;
        }
    };

    try {
        setActiveUserScope(scope);
        const { materializeGenerationTaskAssets } = await import("../../src/services/project-asset-sync.ts?generation-media-commit-race-worker");
        const { useAssetStore } = await import("../../src/stores/use-asset-store");
        await import("../../src/stores/canvas/use-canvas-store");
        const fileStorage = await import("../../src/services/file-storage");
        const task = {
            id: `remote-generation-media-race-${mediaType}`,
            provider: "remote-test-provider",
            type: mediaType,
            status: "succeeded",
            prompt: "redacted",
            attempts: 1,
            resultState: "PENDING_MATERIALIZATION",
            resultJson: JSON.stringify(
                mediaType === "video"
                    ? {
                          mode: "video",
                          video: {
                              dataUrl: "data:video/mp4;base64,AAAA",
                              width: 16,
                              height: 9,
                              mimeType: "video/mp4",
                          },
                      }
                    : {
                          mode: "audio",
                          audio: {
                              dataUrl: "data:audio/mpeg;base64,AAAA",
                              mimeType: "audio/mpeg",
                          },
                      },
            ),
            createdAt: "2026-08-14T00:00:00.000Z",
            updatedAt: "2026-08-14T00:00:00.000Z",
        } as const;

        const materializing = materializeGenerationTaskAssets(task as never);
        await mediaWriteStarted;
        useAssetStore.getState().cleanupImages({ assets: [] });
        const cleanupRun = harness.scheduled.at(-1);
        if (!cleanupRun) throw new Error("cleanup was not scheduled");
        await Promise.race([
            cleanupRun,
            new Promise<void>((resolve) => {
                harness.realSetTimeout(resolve, 20);
            }),
        ]);

        releaseMediaWrite();
        const materialized = await materializing;
        await cleanupRun;

        const assetId = materialized.outputs?.[0]?.materializedAssetId;
        const asset = useAssetStore.getState().assets.find((candidate) => candidate.id === assetId);
        const storageKey = asset?.kind === "video" || asset?.kind === "audio" ? asset.data.storageKey : undefined;
        const blobPresent = storageKey ? (await fileStorage.getMediaBlob(storageKey)) instanceof Blob : false;
        const generationAssetCount = useAssetStore.getState().assets.filter((candidate) => candidate.metadata?.generationEffectKey === `materialize:${task.id}:0`).length;
        return { kind: asset?.kind, storageKey, blobPresent, generationAssetCount };
    } finally {
        releaseMediaWrite();
        setActiveUserScope(previousScope);
        harness.restore();
    }
}

async function runCanvasBatchCommitRace(multiOutput = false) {
    const harness = installStorageHarness();
    const previousScope = getActiveUserScope();
    const { apiClient } = await import("../../src/services/api/request");
    const originalAdapter = apiClient.defaults.adapter;
    apiClient.defaults.adapter = async (config) => {
        if (config.method !== "post" || config.url !== "/resources/access") throw new Error(`Unexpected request: ${config.method} ${config.url}`);
        const requests = JSON.parse(config.data) as { resourceId: string; variant: string }[];
        const items = requests.map(({ resourceId, variant }) => {
            if (!["image-0", "image-1", "image-2", "image-3"].includes(resourceId)) throw new Error(`Unexpected resource: ${resourceId}`);
            return {
                resourceId,
                access: {
                    resourceId,
                    requestedVariant: variant,
                    actualVariant: variant,
                    url: `/api/resources/${resourceId}/content`,
                    delivery: "platform-local",
                    issuedAt: new Date().toISOString(),
                    refreshAt: new Date(Date.now() + 60000).toISOString(),
                    revision: "test",
                },
            };
        });
        return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { items }, msg: "ok" } };
    };
    let unregister: (() => void) | undefined;
    try {
        setActiveUserScope("canvas-batch-commit-race");
        const { useCanvasStore, flushCanvasStorePersistence, CANVAS_STORE_KEY } = await import("../../src/stores/canvas/use-canvas-store");
        const { useAssetStore } = await import("../../src/stores/use-asset-store");
        const { applyCanvasGenerationTaskNodeEffect, registerCanvasGenerationLiveProject } = await import("../../src/services/canvas-generation-consumer");
        const { createCanvasStateWriter } = await import("../../src/lib/canvas/canvas-editor-state");
        const { localForageStorageForScope } = await import("../../src/lib/localforage-storage");
        const { parseCanvasStorageDocument } = await import("../../src/lib/canvas/canvas-storage-revision");
        const { CanvasNodeType } = await import("../../src/types/canvas");
        const projectId = useCanvasStore.getState().createProject("batch race");
        const nodes = Array.from({ length: 5 }, (_, index) => ({
            id: `node-${index}`,
            type: CanvasNodeType.Image,
            title: `image-${index}`,
            position: { x: index * 400, y: 0 },
            width: 320,
            height: 240,
            metadata: { taskId: `task-${index}`, status: index < 2 ? ("loading" as const) : ("error" as const) },
        })).filter((node) => !multiOutput || node.id !== "node-1");
        const ref: { current: import("../../src/types/canvas").CanvasNodeData[] } = { current: nodes };
        const setNodes = createCanvasStateWriter(ref, () => {});
        useCanvasStore.getState().updateProject(projectId, { nodes });
        await flushCanvasStorePersistence();
        useAssetStore.setState({
            assets: (multiOutput ? [0, 1, 2, 3] : [0, 1]).map((index) => ({
                id: `asset-${index}`,
                kind: "image" as const,
                title: "generated",
                coverUrl: "/image.png",
                tags: [],
                createdAt: "2026-09-21T00:00:00Z",
                updatedAt: "2026-09-21T00:00:00Z",
                data: { dataUrl: "/image.png", storageKey: `resource:image-${index}`, width: multiOutput ? 640 + index : 640, height: 480, bytes: 100, mimeType: "image/png" },
            })),
        });
        unregister = registerCanvasGenerationLiveProject({ scope: getActiveUserScope(), projectId, adapter: { read: () => ({ nodes: ref.current, connections: [], chatSessions: [], activeChatId: null }), write: (state) => setNodes(state.nodes) } });
        let edited = false;
        harness.hooks.onSet = (storeName, _key, value) => {
            if (edited || storeName !== "app_state" || typeof value !== "string" || !value.includes("attach:task-")) return;
            edited = true;
            setNodes((current) => [...current.map((node) => (node.id === "node-0" ? { ...node, title: "用户改名", position: { x: 700, y: 500 } } : node)), { ...nodes[0], id: "new-during-save", metadata: {} }]);
        };
        await Promise.all(
            (multiOutput ? [0] : [0, 1]).map((index) =>
                applyCanvasGenerationTaskNodeEffect({
                    projectId,
                    nodeId: `node-${index}`,
                    nodesRef: ref,
                    setNodes,
                    task: {
                        id: `task-${index}`,
                        projectId,
                        type: "canvas_image",
                        status: "succeeded",
                        prompt: "test",
                        attempts: 1,
                        createdAt: "2026-09-21T00:00:00Z",
                        updatedAt: "2026-09-21T00:00:01Z",
                        resultJson: multiOutput ? JSON.stringify({ images: [0, 1, 2, 3].map((i) => ({ dataUrl: "/image.png", storageKey: `resource:image-${i}` })) }) : "{}",
                        ...(multiOutput ? { outputs: [0, 1, 2, 3].map((i) => ({ outputIndex: i, mediaType: "image" as const, materializedAssetId: `asset-${i}` })) } : {}),
                    },
                    output: { outputIndex: 0, mediaType: "image", materializedAssetId: `asset-${index}` },
                    effectKey: `attach:task-${index}:0`,
                }),
            ),
        );
        useCanvasStore.getState().updateProject(projectId, { nodes: ref.current });
        await flushCanvasStorePersistence();
        const stored = parseCanvasStorageDocument(await localForageStorageForScope(getActiveUserScope()).getItem(CANVAS_STORE_KEY), []);
        const restored = stored.state.projects.find((project) => project.id === projectId)?.nodes;
        const live = ref.current;
        if (multiOutput) {
            setNodes(restored!);
            await applyCanvasGenerationTaskNodeEffect({
                projectId,
                nodeId: "node-0",
                nodesRef: ref,
                setNodes,
                task: {
                    id: "task-0",
                    projectId,
                    type: "canvas_image",
                    status: "succeeded",
                    prompt: "test",
                    attempts: 1,
                    createdAt: "",
                    updatedAt: "",
                    resultJson: JSON.stringify({ images: [0, 1, 2, 3].map((i) => ({ dataUrl: "/image.png", storageKey: `resource:image-${i}` })) }),
                },
                output: { outputIndex: 0, mediaType: "image", materializedAssetId: "asset-0" },
                effectKey: "attach:task-0:0",
            });
        }
        return { edited, live, restored, replayed: ref.current };
    } finally {
        unregister?.();
        apiClient.defaults.adapter = originalAdapter;
        setActiveUserScope(previousScope);
        harness.restore();
    }
}

/** 使用真实画布存储和生成持久化入口验证复制流程，不调用供应商或生成付费媒体。 */
async function runCanvasCopyGeneration() {
    const harness = installStorageHarness();
    const previousScope = getActiveUserScope();
    try {
        setActiveUserScope("canvas-copy-generation");
        const { useCanvasStore, flushCanvasStorePersistence, CANVAS_STORE_KEY } = await import("../../src/stores/canvas/use-canvas-store");
        const { persistCanvasGenerationEffect } = await import("../../src/services/canvas-generation-consumer");
        const { isolateCopiedNodeMetadata } = await import("../../src/lib/canvas/canvas-node-copy");
        const { localForageStorageForScope } = await import("../../src/lib/localforage-storage");
        const { parseCanvasStorageDocument } = await import("../../src/lib/canvas/canvas-storage-revision");
        const { CanvasNodeType } = await import("../../src/types/canvas");
        const projectId = useCanvasStore.getState().createProject("copy generation");
        const readNodes = async () => {
            const stored = parseCanvasStorageDocument(await localForageStorageForScope(getActiveUserScope()).getItem(CANVAS_STORE_KEY));
            return stored.state.projects.find((project) => project.id === projectId)!.nodes;
        };
        const initial: import("../../src/types/canvas").CanvasNodeData = {
            id: "source",
            type: CanvasNodeType.Image,
            title: "source",
            position: { x: 0, y: 0 },
            width: 320,
            height: 240,
            metadata: { content: "original-image", prompt: "test prompt", status: "success" },
        };
        useCanvasStore.getState().updateProject(projectId, { nodes: [initial] });
        await flushCanvasStorePersistence();
        const sourceEffect = "attach-node:old-task:source:0";
        await persistCanvasGenerationEffect({
            projectId,
            effectKey: sourceEffect,
            previousNodes: [initial],
            nodes: [{ ...initial, metadata: { ...initial.metadata, generationEffectKeys: [sourceEffect] } }],
        });
        const source = (await readNodes())[0]!;
        const copy = { ...source, id: "copy", title: "source_copy1", position: { x: 400, y: 0 }, metadata: isolateCopiedNodeMetadata(source, new Map([["source", "copy"]])) };
        useCanvasStore.getState().updateProject(projectId, { nodes: [source, copy] });
        await flushCanvasStorePersistence();
        const beforeGeneration = await readNodes();
        if (!beforeGeneration.some((node) => node.id === "copy")) throw new Error("复制节点在普通保存后丢失");

        const pendingNodes = [source, { ...copy, metadata: { ...copy.metadata, status: "loading" as const, taskId: "new-task" } }];
        useCanvasStore.getState().updateProject(projectId, { nodes: pendingNodes });
        await flushCanvasStorePersistence();
        const copyEffect = "attach-node:new-task:copy:0";
        await persistCanvasGenerationEffect({
            projectId,
            effectKey: copyEffect,
            previousNodes: pendingNodes,
            nodes: pendingNodes.map((node) => (node.id === "copy" ? { ...node, metadata: { ...node.metadata, content: "new-image", status: "success", generationEffectKeys: [copyEffect] } } : node)),
        });
        await flushCanvasStorePersistence();
        return { beforeGeneration, restored: await readNodes() };
    } finally {
        setActiveUserScope(previousScope);
        harness.restore();
    }
}

async function runHTTPRegisteredGeneration(variant: "registered" | "mismatch" | "missing" = "registered", screen = false) {
    const harness = installStorageHarness();
    const previousScope = getActiveUserScope();
    const originalCrypto = globalThis.crypto;
    const { apiClient } = await import("../../src/services/api/request");
    const originalAdapter = apiClient.defaults.adapter;
    const assetId = "generation_e8a36a9adf905e4dfd72cd164c1f5b412e6464d00dc490e3d988121db742e6e4";
    const storageKey = "resource:http-image";
    const asset = {
        id: assetId,
        kind: "image",
        title: "用户已修改标题",
        category: "material",
        tags: ["精选"],
        status: "confirmed",
        source: "生成任务",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
        coverUrl: "/api/resources/http-image/file",
        metadata: { taskId: "task-http-recovery", generationEffectKey: "materialize:task-http-recovery:0", outputIndex: 0 },
        data: { dataUrl: "/api/resources/http-image/file", storageKey, width: 640, height: 480, bytes: 100, mimeType: "image/png" },
    };
    const requests: string[] = [];
    let savedProject: import("../../src/stores/canvas/use-canvas-store").CanvasProject | undefined;
    let remoteProject: import("../../src/stores/canvas/use-canvas-store").CanvasProject;
    let polledTask: import("../../src/services/api/task-center").GenerationTask;
    apiClient.defaults.adapter = async (config) => {
        requests.push(`${config.method}:${config.url}`);
        const body = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
        let data: unknown;
        if (config.url === "/tasks/task-http-recovery") data = polledTask;
        else if (config.url === "/assets/batch") data = { assets: body.ids.includes(assetId) && variant !== "missing" ? [{ ...asset, data: { ...asset.data, storageKey: variant === "mismatch" ? "resource:other-image" : storageKey } }] : [] };
        else if (config.url === "/resources/access")
            data = {
                items: [
                    {
                        access: {
                            resourceId: "http-image",
                            requestedVariant: "original",
                            actualVariant: "original",
                            url: "/api/resources/http-image/file",
                            delivery: "platform-local",
                            issuedAt: new Date().toISOString(),
                            expiresAt: new Date(Date.now() + 3600000).toISOString(),
                        },
                    },
                ],
            };
        else if (config.method === "get" && config.url?.startsWith("/canvas-projects/")) data = { project: remoteProject };
        else if (config.method === "put" && config.url?.startsWith("/canvas-projects/")) {
            savedProject = body.project;
            if (savedProject?.nodes[0]?.metadata?.assetId !== assetId || savedProject.nodes[0].metadata.storageKey !== storageKey) throw new Error("保存 payload 没有引用已登记素材");
            data = { project: { ...savedProject, revision: 2 } };
        } else throw new Error(`不应调用 ${config.method}:${config.url}`);
        return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data, msg: "ok" } };
    };
    try {
        // 内网 HTTP 仅保留 CSPRNG；不能靠测试提供 Web Lock / subtle / randomUUID 掩盖故障。
        Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
        Object.defineProperty(globalThis, "document", { configurable: true, value: {} });
        Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) } });
        setActiveUserScope("http-registered-generation");
        const { useCanvasStore, flushCanvasStorePersistence, CANVAS_STORE_KEY } = await import("../../src/stores/canvas/use-canvas-store");
        const { useAssetStore } = await import("../../src/stores/use-asset-store");
        const { initializeRemoteUserDataSession, saveRemoteUserDataNow, resetRemoteUserDataSync } = await import("../../src/services/user-data-sync");
        const { materializeGenerationTaskAssets, consumeGenerationTaskNode, projectGenerationTaskResult } = await import("../../src/services/project-asset-sync");
        const { applyGenerationTaskResultToNodes, generationTaskOutputsApplied, shouldRecoverCanvasMediaAsset } = await import("../../src/lib/canvas/canvas-generation-task-sync");
        const { localForageStorageForScope } = await import("../../src/lib/localforage-storage");
        const { parseCanvasStorageDocument } = await import("../../src/lib/canvas/canvas-storage-revision");
        const { CanvasNodeType } = await import("../../src/types/canvas");
        useAssetStore.setState({ assets: [] });
        const projectId = useCanvasStore.getState().createProject("HTTP recovery");
        const node: import("../../src/types/canvas").CanvasNodeData = {
            id: "front",
            type: CanvasNodeType.Image,
            title: "用户改名",
            position: { x: 700, y: 100 },
            width: 320,
            height: 240,
            metadata: { content: "/api/resources/http-image/file", storageKey, taskId: "task-http-recovery", taskStatus: "succeeded", status: "success", generationOutputCount: 1 },
        };
        if (screen) node.metadata = { taskId: "task-http-recovery", taskStatus: "succeeded", status: "loading", size: "640x480" };
        useCanvasStore.getState().updateProject(projectId, {
            nodes: [node], revision: 1,
            ...(screen ? { creationScene: { kind: "irregular-screen" as const, version: 1 as const, nodeIds: { controlImage: "screen-control", outputMask: "screen-mask", generation: node.id } } } : {}),
        });
        await flushCanvasStorePersistence();
        remoteProject = structuredClone(useCanvasStore.getState().projects.find((project) => project.id === projectId)!);
        await initializeRemoteUserDataSession("http-user");
        const task: import("../../src/services/api/task-center").GenerationTask = {
            id: "task-http-recovery",
            projectId,
            type: "canvas_image",
            status: "succeeded",
            prompt: "robot front",
            attempts: 1,
            createdAt: "",
            updatedAt: "",
            resultJson: JSON.stringify({ images: [{ dataUrl: "/api/resources/http-image/file", storageKey, width: 640, height: 480, bytes: 100, mimeType: "image/png" }] }),
        };
        polledTask = task;
        if (screen) {
            const { recoverScreenGeneration } = await import("../../src/services/irregular-screen-generation");
            let rejection = "";
            try {
                await recoverScreenGeneration(projectId, new AbortController().signal, () => {});
            } catch (error) {
                rejection = error instanceof Error ? error.message : String(error);
            }
            await flushCanvasStorePersistence();
            const restored = parseCanvasStorageDocument(await localForageStorageForScope(getActiveUserScope()).getItem(CANVAS_STORE_KEY)).state.projects.find((project) => project.id === projectId)!;
            const result = { rejection, saved: savedProject?.nodes[0], restored: restored.nodes[0], assets: useAssetStore.getState().assets, requests };
            resetRemoteUserDataSync();
            return result;
        }
        const needsRecovery = shouldRecoverCanvasMediaAsset(node) && !generationTaskOutputsApplied(node, task);
        if (variant !== "registered") {
            let rejection = "";
            try {
                await materializeGenerationTaskAssets(task);
            } catch (error) {
                rejection = error instanceof Error ? error.message : String(error);
            }
            const raw = await applyGenerationTaskResultToNodes([node], task, node.id);
            resetRemoteUserDataSync();
            return { rejection, boundAssetId: raw.node?.metadata?.assetId, requests };
        }
        const materialized = await materializeGenerationTaskAssets(task);
        const projected = projectGenerationTaskResult(materialized);
        let lockError = "";
        try {
            await consumeGenerationTaskNode(task, node.id, 0, () => {
                throw new Error("HTTP 无锁环境不应写入 attach effect");
            });
        } catch (error) {
            lockError = error instanceof Error ? error.message : String(error);
        }
        const recovered = await applyGenerationTaskResultToNodes([node], task, node.id);
        useCanvasStore.getState().updateProject(projectId, { nodes: recovered.nodes });
        await saveRemoteUserDataNow(projectId);
        await flushCanvasStorePersistence();
        const restored = parseCanvasStorageDocument(await localForageStorageForScope(getActiveUserScope()).getItem(CANVAS_STORE_KEY)).state.projects.find((project) => project.id === projectId)!;
        const replayed = await applyGenerationTaskResultToNodes(restored.nodes, task, node.id);
        const result = {
            needsRecovery,
            lockError,
            materializedId: materialized.outputs?.[0]?.materializedAssetId,
            projectedId: projected.outputs?.[0]?.materializedAssetId,
            saved: savedProject?.nodes[0],
            restored: restored.nodes[0],
            replayed: replayed.nodes[0],
            assets: useAssetStore.getState().assets,
            requests,
        };
        resetRemoteUserDataSync();
        return result;
    } finally {
        apiClient.defaults.adapter = originalAdapter;
        Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
        setActiveUserScope(previousScope);
        harness.restore();
    }
}

self.onmessage = async (event: MessageEvent<Scenario>) => {
    try {
        const result =
            event.data === "http-screen-generation"
                ? await runHTTPRegisteredGeneration("registered", true)
                : event.data === "http-screen-generation-mismatch"
                  ? await runHTTPRegisteredGeneration("mismatch", true)
                  : event.data === "http-screen-generation-missing"
                    ? await runHTTPRegisteredGeneration("missing", true)
                    : event.data === "http-generation-mismatch"
                ? await runHTTPRegisteredGeneration("mismatch")
                : event.data === "http-generation-missing"
                  ? await runHTTPRegisteredGeneration("missing")
                  : event.data === "http-registered-generation"
                    ? await runHTTPRegisteredGeneration()
                    : event.data === "image-cleanup"
                      ? await runImageCleanup()
                      : event.data === "scope-cleanup-switch"
                        ? await runScopeCleanupAfterSwitch()
                        : event.data === "scope-cleanup-late-canvas-reference"
                          ? await runScopeCleanupAfterLateCanvasReference()
                          : event.data === "canvas-multi-output"
                            ? await runCanvasBatchCommitRace(true)
                            : event.data === "canvas-copy-generation"
                              ? await runCanvasCopyGeneration()
                              : event.data === "canvas-batch-commit-race"
                                ? await runCanvasBatchCommitRace()
                                : await runMediaCommitRace(event.data === "audio-commit-race" ? "audio" : "video");
        self.postMessage({ ok: true, result });
    } catch (error) {
        self.postMessage({ ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    }
};
