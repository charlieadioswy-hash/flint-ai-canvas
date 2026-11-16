import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { DramaCast, DramaStudioBatchRequest, DramaStudioBatchView } from "@/services/api/drama";

const dom = new Window({ url: "http://localhost/projects/current" });
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const api = await import("@/services/api/drama");
const { useUserStore } = await import("@/stores/use-user-store");
const { CastImageNotSubmittedError, useCastImageQuote } = await import("@/pages/projects/studio/use-cast-image-quote");

const cast = { id: "hero", projectId: "current", kind: "character", name: "林溪", appearance: "蓝衣短发", revision: 2 } as DramaCast;
const draft = { name: cast.name, appearance: cast.appearance, imageOptions: { model: {}, ratio: "", resolution: "", subjectReferenceIds: [], styleReferenceIds: [] } };
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
let latest: ReturnType<typeof useCastImageQuote>;
let scope: string;
let amount: number;
let checks: DramaStudioBatchRequest[];
let executions: DramaStudioBatchRequest[];

function quote(input: DramaStudioBatchRequest, queued = false): DramaStudioBatchView {
    const fromDraft = Boolean(input.castDrafts);
    return {
        action: "cast_image",
        targetIds: input.targetIds,
        baseRevision: fromDraft ? 9 : 10,
        ready: true,
        confirmationToken: fromDraft ? "draft-token" : input.restyleSegments ? "saved-restyle-token" : "saved-token",
        scopeHash: fromDraft ? "same-generation-inputs" : scope,
        amountMicrocredits: fromDraft ? 2_000_000 : amount,
        priced: true,
        items: input.targetIds.map((targetId) => ({ targetId, targetKind: "cast", episodeId: "episode-a", targetRevision: fromDraft ? 2 : 3, status: queued ? "queued" : "ready", amountMicrocredits: fromDraft ? 2_000_000 : amount, priced: true })),
        counts: queued ? { queued: input.targetIds.length } : { ready: input.targetIds.length },
    };
}

beforeEach(() => {
    window.localStorage.setItem("yingce:active-user-scope", "user-a");
    useUserStore.setState({ user: { id: "user-a" } as never });
    scope = "same-generation-inputs";
    amount = 2_000_000;
    checks = [];
    executions = [];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    spyOn(api, "preflightDramaStudioBatch").mockImplementation(async (_projectId, input) => {
        checks.push(structuredClone(input));
        return quote(input);
    });
    spyOn(api, "executeDramaStudioBatch").mockImplementation(async (_projectId, input) => {
        executions.push(structuredClone(input));
        return quote(input, true);
    });
});

afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    mock.restore();
});
afterAll(() => dom.happyDOM.abort());

function Harness() {
    latest = useCastImageQuote({ projectId: "current", episodeId: "episode-a", cast, revision: 9, draft });
    return <output>{latest.data?.amountMicrocredits}</output>;
}

async function mount() {
    await act(async () =>
        root.render(
            <QueryClientProvider client={client}>
                <Harness />
            </QueryClientProvider>,
        ),
    );
    const deadline = Date.now() + 3000;
    while ((!latest.data || latest.isFetching) && Date.now() < deadline)
        await act(async () => {
            await Bun.sleep(1);
        });
    expect(latest.disabled).toBe(false);
    return latest.data!;
}

test("保存递增版本和选择更新下游视频后使用重新预检的执行令牌", async () => {
    const accepted = await mount();
    await act(async () => {
        await latest.execute(accepted, true);
    });
    expect(checks[0].castDrafts).toEqual({ hero: draft });
    expect(checks[0].restyleSegments).toBeUndefined();
    expect(checks[1].castDrafts).toBeUndefined();
    expect(checks[1].restyleSegments).toBe(true);
    expect(executions).toEqual([{ action: "cast_image", targetIds: ["hero"], regenerate: true, restyleSegments: true, baseRevision: 10, confirmationToken: "saved-restyle-token", episodeId: "episode-a" }]);
});

for (const change of ["scope", "price"] as const) {
    test(`保存后实际${change === "scope" ? "生成输入" : "费用"}变化时不提交生成`, async () => {
        const accepted = await mount();
        if (change === "scope") scope = "different-reference-image";
        else amount = 3_000_000;
        let failure: unknown;
        await act(async () => {
            try {
                await latest.execute(accepted, true);
            } catch (error) {
                failure = error;
            }
        });
        expect(failure).toBeInstanceOf(CastImageNotSubmittedError);
        expect((failure as Error).message).toContain("图片费用或生成范围已更新");
        expect(executions).toHaveLength(0);
    });
}
