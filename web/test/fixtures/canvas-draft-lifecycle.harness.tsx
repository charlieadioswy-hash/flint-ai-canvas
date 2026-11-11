import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import localforage from "localforage";
import type { CanvasStarterMode } from "../../src/lib/canvas/canvas-starter";
import type { CanvasAppearance } from "../../src/lib/canvas/canvas-appearance";
import type { CanvasBackgroundMode } from "../../src/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData } from "../../src/types/canvas";

const dom = new Window({ url: "http://localhost/" });
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, localStorage: dom.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const disk = new Map<string, unknown>();
let writes = 0;
localforage.getItem = (async (key: string) => disk.get(key) ?? null) as typeof localforage.getItem;
localforage.setItem = (async (key: string, value: unknown) => {
    writes += 1;
    disk.set(key, value);
    return value;
}) as typeof localforage.setItem;
localforage.removeItem = async (key: string) => {
    disk.delete(key);
};

const { act, useRef, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, useLocation } = await import("react-router");
const { App } = await import("antd");
const skills = await import("../../src/services/api/skills");
const sync = await import("../../src/services/user-data-sync");
const polling = await import("../../src/services/canvas-sync-polling");
const { canvasEditLeases } = await import("../../src/services/canvas-edit-leases");
const { setActiveUserScope } = await import("../../src/lib/user-scope");
const { canvasAppearanceForTheme } = await import("../../src/lib/canvas/canvas-appearance");
const { resolveCanvasEmptyStateKind } = await import("../../src/lib/canvas/canvas-starter");
const { canvasDraftNavigationState, flushCanvasStorePersistence, useCanvasStore, withCanvasStorePersistenceSuppressed } = await import("../../src/stores/canvas/use-canvas-store");
const { useUserStore } = await import("../../src/stores/use-user-store");
const { useCanvasProjectLifecycle } = await import("../../src/pages/canvas/use-canvas-project-lifecycle");

const messageSpy = spyOn(App, "useApp").mockReturnValue({ message: { info() {}, error() {}, success() {}, warning() {} } } as unknown as ReturnType<typeof App.useApp>);
const skillsSpy = spyOn(skills, "listAddedSkills").mockResolvedValue({ skills: [] });
const loadSpy = spyOn(sync, "loadCanvasProjectForEditing").mockResolvedValue(null);
const pollingSpy = spyOn(polling, "startCanvasSyncPolling").mockImplementation(() => () => {});
const leaseSpy = spyOn(canvasEditLeases, "tick").mockResolvedValue();
const cleanups: Array<() => Promise<void>> = [];
const noop = () => {};
let sequence = 0;

beforeEach(async () => {
    disk.clear();
    dom.localStorage.clear();
    setActiveUserScope(`draft-lifecycle-${++sequence}`);
    withCanvasStorePersistenceSuppressed(() => useCanvasStore.setState({ projects: [], drafts: {} }));
    useUserStore.setState({ hydrated: true });
    await useCanvasStore.persist.rehydrate();
    await flushCanvasStorePersistence();
    loadSpy.mockClear();
    writes = 0;
});
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    await flushCanvasStorePersistence();
});
afterAll(() => {
    for (const spy of [messageSpy, skillsSpy, loadSpy, pollingSpy, leaseSpy]) spy.mockRestore();
    dom.happyDOM.abort();
});

async function refreshMemory() {
    withCanvasStorePersistenceSuppressed(() => useCanvasStore.setState({ drafts: {} }));
    await useCanvasStore.persist.rehydrate();
}

async function mount(projectId: string, state: unknown) {
    let view!: { loaded: boolean; pathname: string; mode: string | undefined };
    const host = document.createElement("div");
    const root = createRoot(host);
    function Harness() {
        const [projectLoaded, setProjectLoaded] = useState(false);
        const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
        const [connections, setConnections] = useState<CanvasConnection[]>([]);
        const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
        const [activeChatId, setActiveChatId] = useState<string | null>(null);
        const [canvasAppearance, setCanvasAppearance] = useState<CanvasAppearance>(canvasAppearanceForTheme("light"));
        const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("dots");
        const [showImageInfo, setShowImageInfo] = useState(false);
        const [viewport, setViewport] = useState({ x: 0, y: 0, k: 1 });
        const nodesRef = useRef(nodes);
        const connectionsRef = useRef(connections);
        const chatSessionsRef = useRef(chatSessions);
        const activeChatIdRef = useRef(activeChatId);
        const viewportRef = useRef(viewport);
        const historyPausedRef = useRef(false);
        const lifecycle = useCanvasProjectLifecycle({
            projectId,
            projectLoaded,
            nodes,
            connections,
            chatSessions,
            activeChatId,
            canvasAppearance,
            backgroundMode,
            showImageInfo,
            viewport,
            nodesRef,
            connectionsRef,
            chatSessionsRef,
            activeChatIdRef,
            viewportRef,
            historyPausedRef,
            setNodes,
            setConnections,
            setChatSessions,
            setActiveChatId,
            setCanvasAppearance,
            setBackgroundMode,
            setShowImageInfo,
            setViewport,
            setProjectLoaded,
            resetHistory: noop,
            cleanupAssetImages: noop,
            cleanupCanvasFiles: noop,
        });
        view = { loaded: projectLoaded, pathname: useLocation().pathname, mode: lifecycle.currentProject?.starterMode };
        return null;
    }
    let mounted = true;
    const unmount = async () => {
        if (!mounted) return;
        mounted = false;
        await act(() => root.unmount());
        await flushCanvasStorePersistence();
    };
    cleanups.push(unmount);
    await act(async () => {
        root.render(
            <MemoryRouter initialEntries={[{ pathname: `/canvas/${projectId}`, state }]}>
                <Harness />
            </MemoryRouter>,
        );
    });
    return { view: () => view, unmount };
}

test.each(["guided", "freeform"] as const)("刷新 %s 草稿保留 ID 和入口模式，不落盘或加载云端", async (starterMode: CanvasStarterMode) => {
    const store = useCanvasStore.getState();
    const id = store.createDraftProject("剧本.v2.md");
    store.updateProject(id, { starterMode });
    const state = canvasDraftNavigationState(id)!;
    expect(state.canvasDraft.starterMode).toBe(starterMode);
    await refreshMemory();
    const page = await mount(id, state);
    const restored = store.getDraftProject(id)!;
    expect(page.view()).toMatchObject({ loaded: true, mode: starterMode });
    expect(restored).toMatchObject({ id, title: "剧本.v2.md", starterMode });
    expect(resolveCanvasEmptyStateKind({ nodeCount: restored.nodes.length, starterMode: restored.starterMode, shortDramaEnabled: true, isProjectLinked: false })).toBe(starterMode);
    await page.unmount();
    expect(useCanvasStore.getState().projects).toHaveLength(0);
    expect(writes).toBe(0);
    expect(loadSpy).not.toHaveBeenCalled();
});

test("不信任导航中的非法入口模式或附带画布内容", async () => {
    for (const starterMode of [undefined, "invalid", { mode: "guided" }, ["guided"]]) {
        const store = useCanvasStore.getState();
        const id = store.createDraftProject();
        const state = canvasDraftNavigationState(id)!;
        await refreshMemory();
        const page = await mount(id, { canvasDraft: { ...state.canvasDraft, starterMode, nodes: [{ id: "injected" }] } });
        expect(page.view()).toMatchObject({ loaded: true, mode: "freeform" });
        expect(store.getDraftProject(id)?.nodes).toEqual([]);
        await page.unmount();
    }
    expect(useCanvasStore.getState().projects).toHaveLength(0);
    expect(writes).toBe(0);
    expect(loadSpy).not.toHaveBeenCalled();
});

test("另一账号不能复用旧 history 意图恢复草稿", async () => {
    const store = useCanvasStore.getState();
    const id = store.createDraftProject("账号 A 的短剧");
    store.updateProject(id, { starterMode: "guided" });
    const state = canvasDraftNavigationState(id)!;
    await refreshMemory();
    setActiveUserScope("different-account");
    await useCanvasStore.persist.rehydrate();
    await flushCanvasStorePersistence();
    writes = 0;
    const page = await mount(id, state);
    expect(page.view()).toMatchObject({ loaded: false, pathname: "/canvas" });
    expect(store.getDraftProject(id)).toBeNull();
    expect(useCanvasStore.getState().drafts).toEqual({});
    expect(useCanvasStore.getState().projects).toHaveLength(0);
    await page.unmount();
    expect(writes).toBe(0);
});

test("旧导航模式不能覆盖仍在内存中的草稿选择", async () => {
    const store = useCanvasStore.getState();
    const id = store.createDraftProject();
    store.updateProject(id, { starterMode: "guided" });
    const state = canvasDraftNavigationState(id)!;
    store.updateProject(id, { starterMode: "freeform" });
    const page = await mount(id, state);
    expect(page.view()).toMatchObject({ loaded: true, mode: "freeform" });
    await page.unmount();
    expect(writes).toBe(0);
});

test("已保存画布优先于过期草稿的标题与入口模式", async () => {
    const store = useCanvasStore.getState();
    const id = store.createDraftProject("旧草稿");
    store.updateProject(id, { starterMode: "guided" });
    const state = canvasDraftNavigationState(id)!;
    const saved = { ...store.getDraftProject(id)!, title: "已保存", starterMode: "freeform" as const, revision: 2 };
    withCanvasStorePersistenceSuppressed(() => store.replaceProjects([saved]));
    const page = await mount(id, state);
    expect(page.view()).toMatchObject({ loaded: true, mode: "freeform" });
    expect(store.openProject(id)?.title).toBe("已保存");
    expect(store.getDraftProject(id)).toBeNull();
    await page.unmount();
    expect(writes).toBe(0);
});
