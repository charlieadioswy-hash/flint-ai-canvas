import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { DramaCast, DramaSummary } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/" });
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

let cast: DramaCast[] = [];
let castRequests = 0;
let summary = { production: { guideStep: "configuring", revision: 1, status: "draft", stage: "bible" }, jobCounts: {} } as DramaSummary;
mock.module("@/services/api/drama", () => ({
    getDrama: async () => structuredClone(summary),
    getDramaEpisode: async () => ({}),
    listDramaCast: async () => {
        castRequests++;
        return { cast: structuredClone(cast) };
    },
}));
mock.module("@/services/drama-canvas", () => ({ encodeDramaCanvasFocus: () => "", openDramaCanvasPath: async () => "" }));
mock.module("antd", () => ({ App: { useApp: () => ({}) } }));
mock.module("react-router", () => ({ useNavigate: () => () => {} }));
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { environmentManager } = await import("@tanstack/query-core");
environmentManager.setIsServer(() => false);
const { dramaKeys, useDramaCast, useDramaSummary } = await import("@/pages/projects/studio/use-studio");
const settle = async () => {
    for (let i = 0; i < 5; i++) await Bun.sleep(10);
};
afterAll(() => browser.happyDOM.abort());

test("空资产列表随文字版本刷新，剧本补充资产可见，闲置引导停止资产轮询", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let visible: DramaCast[] = [];
    let refreshSummary!: () => Promise<unknown>;
    function Probe() {
        const query = useDramaSummary("project");
        refreshSummary = query.refetch;
        const jobsActive = Boolean((query.data?.jobCounts.queued || 0) + (query.data?.jobCounts.running || 0));
        visible = useDramaCast("project", jobsActive, query.data?.production.revision).cast;
        return null;
    }
    try {
        await act(async () => {
            root.render(
                <QueryClientProvider client={client}>
                    <Probe />
                </QueryClientProvider>,
            );
            await settle();
        });
        expect(visible).toEqual([]);
        await act(async () => {
            summary = { ...summary, production: { ...summary.production, guideStep: "assets", revision: 2, status: "running" }, jobCounts: { running: 1 } };
            await refreshSummary();
            await settle();
        });
        expect(visible).toEqual([]);
        await act(async () => {
            cast = [{ id: "character", imageStatus: "", locked: false } as DramaCast];
            summary = { ...summary, production: { ...summary.production, revision: 3, stage: "produce" }, jobCounts: {} };
            await refreshSummary();
            await settle();
        });
        expect(visible.map((item) => item.id)).toEqual(["character"]);
        await act(async () => {
            cast.push({ id: "script-added-scene", imageStatus: "", locked: false } as DramaCast);
            summary = { ...summary, production: { ...summary.production, guideStep: "story", revision: 4 } };
            await refreshSummary();
            await settle();
        });
        expect(visible.map((item) => item.id)).toEqual(["character", "script-added-scene"]);
        const before = castRequests;
        await act(async () => {
            await refreshSummary();
            await Bun.sleep(4_100);
        });
        expect(castRequests).toBe(before);
        await act(async () => {
            cast[0].imageStatus = "running";
            summary = { ...summary, jobCounts: { running: 1 } };
            await refreshSummary();
            await client.invalidateQueries({ queryKey: dramaKeys.cast("project") });
            await settle();
        });
        expect(visible[0].imageStatus).toBe("running");
        await act(async () => {
            cast[0].imageStatus = "ready";
            summary = { ...summary, jobCounts: {} };
            await refreshSummary();
            await Bun.sleep(4_100);
            await settle();
        });
        expect(visible[0].imageStatus).toBe("ready");
    } finally {
        await act(async () => root.unmount());
        client.clear();
        container.remove();
    }
}, 12_000);
