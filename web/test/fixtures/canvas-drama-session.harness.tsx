import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    Element: dom.Element,
    Node: dom.Node,
    SVGElement: dom.SVGElement,
    localStorage: dom.localStorage,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { App } = await import("antd");
const api = await import("../../src/services/api/drama");
const assets = await import("../../src/services/drama-canvas");
const { setActiveUserScope } = await import("../../src/lib/user-scope");
const { useCanvasDrama } = await import("../../src/pages/canvas/use-canvas-drama");
import type { DramaCast, DramaEpisodeDetail, DramaSummary } from "../../src/services/api/drama";
import type { CanvasNodeData } from "../../src/types/canvas";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

const cast = { id: "cast-a", kind: "character", name: "角色 A", imageResourceId: "image-a", position: 0 } as DramaCast;
function summary(id: string): DramaSummary {
    return { project: { id }, production: { status: "idle", settings: { aspectRatio: "9:16" } }, episodes: [], jobCounts: { running: 0 } } as unknown as DramaSummary;
}
const episode = {
    episode: { id: "episode-a", number: 1, title: "A" },
    segments: [{ id: "segment-a", index: 0, videoResourceId: "video-a", videoStatus: "ready", videoSeconds: 5, request: { seconds: 5, references: [] } }],
    shots: [],
} as unknown as DramaEpisodeDetail;

const messageError = spyOn(App, "useApp").mockReturnValue({ message: { info() {}, error() {}, success() {}, warning() {} }, modal: { confirm: async () => true }, notification: {} } as unknown as ReturnType<typeof App.useApp>);
const summarySpy = spyOn(api, "getDrama").mockImplementation(async (id) => summary(id));
const castSpy = spyOn(api, "listDramaCast").mockImplementation(async () => ({ cast: [cast] }));
const takesSpy = spyOn(api, "listDramaTakes").mockImplementation(async () => ({ takes: [] }));
const mediaSpy = spyOn(assets, "ensureDramaCanvasAssets");
const episodeSpy = spyOn(api, "getDramaEpisode");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});
afterAll(() => {
    for (const spy of [messageError, summarySpy, castSpy, takesSpy, mediaSpy, episodeSpy]) spy.mockRestore();
    dom.happyDOM.abort();
});

async function settle() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

async function mount() {
    setActiveUserScope("account-a");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const nodesRef = { current: [] as CanvasNodeData[] };
    const writes: Array<{ canvasId: string; nodeIds: string[] }> = [];
    let controller!: ReturnType<typeof useCanvasDrama>;
    const host = document.createElement("div");
    const root = createRoot(host);
    function Harness({ canvasId, dramaId }: { canvasId: string; dramaId: string }) {
        controller = useCanvasDrama({
            canvasId,
            dramaId,
            projectLoaded: true,
            nodes: nodesRef.current,
            nodesRef,
            setNodes: (update) => {
                nodesRef.current = typeof update === "function" ? update(nodesRef.current) : update;
            },
            setConnections() {},
            focusNodes(nodeIds) {
                writes.push({ canvasId, nodeIds });
            },
            searchParams: new URLSearchParams(),
            setSearchParams() {},
        });
        return null;
    }
    const render = async (canvasId: string, dramaId: string) => {
        await act(async () => {
            root.render(
                <QueryClientProvider client={queryClient}>
                    <Harness canvasId={canvasId} dramaId={dramaId} />
                </QueryClientProvider>,
            );
        });
        await settle();
    };
    cleanups.push(async () => {
        await act(() => root.unmount());
        queryClient.clear();
    });
    await render("canvas-a", "drama-a");
    return { render, nodesRef, writes, controller: () => controller };
}

test("读取 A 的成片期间切到 B，不登记旧媒体或添加节点，不改变 B 的定位", async () => {
    const finalRead = deferred<DramaEpisodeDetail>();
    let episodeReads = 0;
    episodeSpy.mockImplementation(async () => {
        episodeReads += 1;
        return finalRead.promise;
    });
    mediaSpy.mockImplementation(async () => new Map([["video-a", "asset-video-a"]]));
    const mediaCalls = mediaSpy.mock.calls.length;
    const view = await mount();
    let pending!: Promise<void>;
    await act(async () => {
        pending = view.controller().projectFinal("episode-a");
    });
    await settle();
    expect(episodeReads).toBe(1);
    const bNodes = [{ id: "node-b" }] as CanvasNodeData[];
    view.nodesRef.current = bNodes;
    await view.render("canvas-b", "drama-b");
    await act(async () => {
        finalRead.resolve({ ...episode, episode: { ...episode.episode, finalResourceId: "video-a" } });
        await pending;
    });
    expect(view.nodesRef.current).toBe(bNodes);
    expect(view.writes).toEqual([]);
    expect(mediaSpy.mock.calls).toHaveLength(mediaCalls);
    expect(view.controller().busyKey).toBeNull();
});

test("登记 A 的成片媒体期间切到 B，迟到回执不添加旧节点或抢走定位", async () => {
    const registration = deferred<Map<string, string>>();
    episodeSpy.mockImplementation(async () => ({ ...episode, episode: { ...episode.episode, finalResourceId: "video-a" } }));
    mediaSpy.mockImplementation(async () => registration.promise);
    const view = await mount();
    let pending!: Promise<void>;
    await act(async () => {
        pending = view.controller().projectFinal("episode-a");
    });
    await settle();
    const bNodes = [{ id: "node-b" }] as CanvasNodeData[];
    view.nodesRef.current = bNodes;
    await view.render("canvas-b", "drama-b");
    await act(async () => {
        registration.resolve(new Map([["video-a", "asset-video-a"]]));
        await pending;
    });
    expect(view.nodesRef.current).toBe(bNodes);
    expect(view.writes).toEqual([]);
    expect(view.controller().busyKey).toBeNull();
});

test("切到 B 又返回 A，旧一轮参考图投送也不能继续", async () => {
    const registration = deferred<Map<string, string>>();
    mediaSpy.mockImplementation(async () => registration.promise);
    const view = await mount();
    let pending!: Promise<void>;
    await act(async () => {
        pending = view.controller().projectCast(cast.id);
    });
    await settle();
    await view.render("canvas-b", "drama-b");
    await view.render("canvas-a", "drama-a");
    await act(async () => {
        registration.resolve(new Map([["image-a", "asset-image-a"]]));
        await pending;
    });
    expect(view.nodesRef.current).toEqual([]);
});

test("账号切换即使尚未重渲染，也不能写入旧投送结果", async () => {
    const registration = deferred<Map<string, string>>();
    mediaSpy.mockImplementation(async () => registration.promise);
    const view = await mount();
    let pending!: Promise<void>;
    await act(async () => {
        pending = view.controller().projectCast(cast.id);
    });
    await settle();
    setActiveUserScope("account-b");
    await act(async () => {
        registration.resolve(new Map([["image-a", "asset-image-a"]]));
        await pending;
    });
    expect(view.nodesRef.current).toEqual([]);
});
