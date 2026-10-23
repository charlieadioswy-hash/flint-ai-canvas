export async function runHTTPGenerationConsumer() {
    const { apiClient } = await import("../../src/services/api/request");
    const originalAdapter = apiClient.defaults.adapter;
    const { setActiveUserScope } = await import("../../src/lib/user-scope");
    setActiveUserScope("http-consumer-browser-check");
    const { localForageStorageForScope } = await import("../../src/lib/localforage-storage");
    const { useCanvasStore, flushCanvasStorePersistence, CANVAS_STORE_KEY } = await import("../../src/stores/canvas/use-canvas-store");
    const { useAssetStore } = await import("../../src/stores/use-asset-store");
    const { consumeGenerationTaskNode } = await import("../../src/services/project-asset-sync");
    const { applyCanvasGenerationTaskNodeEffect } = await import("../../src/services/canvas-generation-consumer");
    const { parseCanvasStorageDocument } = await import("../../src/lib/canvas/canvas-storage-revision");
    const { initializeRemoteUserDataSession, resetRemoteUserDataSync } = await import("../../src/services/user-data-sync");
    const { CanvasNodeType } = await import("../../src/types/canvas");
    const assetId = "generation_e8a36a9adf905e4dfd72cd164c1f5b412e6464d00dc490e3d988121db742e6e4";
    const storageKey = "resource:http-image";
    const requests: string[] = [];
    apiClient.defaults.adapter = async (config) => {
        requests.push(`${config.method}:${config.url}`);
        const data = config.url === "/assets/batch" ? { assets: [{ id: assetId, kind: "image", title: "素材标题", category: "material", tags: [], status: "confirmed", source: "生成任务", createdAt: "2026-08-14T00:00:00.000Z", updatedAt: "2026-08-14T00:00:00.000Z", coverUrl: "/api/resources/http-image/file", metadata: { taskId: "task-http-recovery", generationEffectKey: "materialize:task-http-recovery:0", outputIndex: 0 }, data: { dataUrl: "/api/resources/http-image/file", storageKey, width: 640, height: 480, bytes: 100, mimeType: "image/png" } }] }
            : config.url === "/resources/access" ? { items: [{ access: { resourceId: "http-image", requestedVariant: "original", actualVariant: "original", url: "/api/resources/http-image/file", delivery: "platform-local", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }] }
            : undefined;
        if (!data) throw new Error(`Unexpected browser fixture API ${config.method}:${config.url}`);
        return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data, msg: "ok" } };
    };
    try {
        await useCanvasStore.persist.rehydrate();
        await useAssetStore.persist.rehydrate();
        useAssetStore.setState({ assets: [] });
        const projectId = useCanvasStore.getState().createProject("HTTP consumer");
        const node: import("../../src/types/canvas").CanvasNodeData = { id: "front", type: CanvasNodeType.Image, title: "用户标题", position: { x: 700, y: 100 }, width: 320, height: 240, metadata: { taskId: "task-http-recovery", taskStatus: "succeeded", status: "loading", size: "640x480", manualSize: true } };
        useCanvasStore.getState().updateProject(projectId, { nodes: [node] });
        await flushCanvasStorePersistence();
        await initializeRemoteUserDataSession("browser-check-user");
        const task: import("../../src/services/api/task-center").GenerationTask = { id: "task-http-recovery", projectId, type: "canvas_image", status: "succeeded", prompt: "browser fixture", attempts: 1, createdAt: "", updatedAt: "", resultJson: JSON.stringify({ images: [{ dataUrl: "/api/resources/http-image/file", storageKey, width: 640, height: 480, bytes: 100, mimeType: "image/png" }] }) };
        const nodesRef = { get current() { return useCanvasStore.getState().projects.find((project) => project.id === projectId)!.nodes; } };
        const setNodes: import("react").Dispatch<import("react").SetStateAction<import("../../src/types/canvas").CanvasNodeData[]>> = (update) => useCanvasStore.getState().updateProject(projectId, { nodes: typeof update === "function" ? update(nodesRef.current) : update });
        let applied = 0;
        const consume = () => consumeGenerationTaskNode(task, node.id, 0, async (input) => {
            applied++;
            await applyCanvasGenerationTaskNodeEffect({ ...input, projectId, nodeId: node.id, nodesRef, setNodes });
        });
        await consume();
        await consume();
        await flushCanvasStorePersistence();
        const document = parseCanvasStorageDocument(await localForageStorageForScope().getItem(CANVAS_STORE_KEY));
        const durable = document.state.projects.find((project) => project.id === projectId)!.nodes[0];
        return { applied, durable, live: nodesRef.current[0], assetCount: useAssetStore.getState().assets.length, requests };
    } finally {
        resetRemoteUserDataSync();
        apiClient.defaults.adapter = originalAdapter;
    }
}
