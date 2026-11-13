import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaWorkflowImpact } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/projects/project" });
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { environmentManager } = await import("@tanstack/query-core");
environmentManager.setIsServer(() => false);
const { MemoryRouter } = await import("react-router");
const userStore = create(() => ({ user: { id: "user-a" } }));
mock.module("@/stores/use-user-store", () => ({ useUserStore: userStore }));
mock.module("antd", () => ({ Button: ({ children, size: _size, type: _type, ...props }: Record<string, unknown>) => createElement("button", props, children as ReactNode) }));

let readImpact: (castId?: string) => Promise<DramaWorkflowImpact> = async () => impact();
mock.module("@/services/api/drama", () => ({
    getDramaCastImpact: (_projectId: string, castId: string) => readImpact(castId),
    getDramaSettingsImpact: () => readImpact(),
}));
const { WorkflowImpact } = await import("@/pages/projects/workflow-impact");
afterAll(() => browser.happyDOM.abort());

function impact(castId?: string, revision = 1, number = 2): DramaWorkflowImpact {
    const segment = { id: `segment-${number}`, episodeId: `ep-${number}`, episodeNumber: number, episodeTitle: "相遇", segmentIndex: 1, revision: 3, videoStatus: "ready", hasVideo: true };
    return {
        kind: castId ? "cast" : "style",
        castId,
        revision,
        segments: 1,
        episodes: 1,
        affectedSegments: 2,
        assetIds: ["asset-1"],
        directSegments: [segment],
        continuitySegments: [{ ...segment, id: `segment-tail-${number}`, segmentIndex: 2 }],
        message: "按已保存引用统计影响。",
    };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
async function mount(castId?: string, revision = 1) {
    userStore.setState({ user: { id: "user-a" } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const draw = async (id?: string, version = revision) => {
        await act(async () => {
            root.render(
                <QueryClientProvider client={query}>
                    <MemoryRouter>
                        <WorkflowImpact projectId="project" revision={version} castId={id} />
                    </MemoryRouter>
                </QueryClientProvider>,
            );
            await settle();
        });
        await act(async () => {
            await settle();
        });
    };
    await draw(castId);
    return {
        host,
        query,
        draw,
        close: async () => {
            await act(async () => root.unmount());
            query.clear();
            host.remove();
        },
    };
}

test("显示直接引用、尾帧续接的具体集段及定位链接", async () => {
    readImpact = async (castId) => impact(castId);
    const view = await mount("cast-1");
    try {
        expect(view.host.textContent).toContain("直接影响 1 段");
        expect(view.host.textContent).toContain("尾帧续接涉及后续 1 段");
        expect(view.host.textContent).toContain("涉及 1 项资产、2 段");
        const links = [...view.host.querySelectorAll("a")];
        expect(links.map((link) => link.textContent)).toEqual(["第 2 集 · 第 2 段 · 相遇", "第 2 集 · 第 3 段 · 相遇"]);
        expect(links[0].getAttribute("href")).toBe("/projects/project/e/ep-2?mode=simple&step=story&segment=1");
    } finally {
        await view.close();
    }
});

test("查询失败不能冒充无影响，重试后才能展示实际零引用", async () => {
    readImpact = async () => {
        throw new Error("读取失败");
    };
    const view = await mount();
    try {
        expect(view.host.textContent).toContain("影响范围读取失败");
        expect(view.host.textContent).not.toContain("直接影响 0 段");
        readImpact = async () => ({ ...impact(), segments: 0, episodes: 0, affectedSegments: 0, assetIds: [], directSegments: [], continuitySegments: [] });
        await act(async () => {
            view.host.querySelector<HTMLButtonElement>("button")!.click();
            await settle();
        });
        await act(async () => {
            await settle();
        });
        expect(view.host.textContent).toContain("没有直接引用的剧情段");
    } finally {
        await view.close();
    }
});

test("旧 revision 或目标不匹配的影响不展示为当前范围", async () => {
    readImpact = async () => impact("cast-old");
    const view = await mount("cast-current", 2);
    try {
        expect(view.host.textContent).toContain("影响范围需要刷新");
        expect(view.host.querySelectorAll("a")).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("切资产与账号后迟到影响不能混入当前弹窗", async () => {
    let resolve!: (value: DramaWorkflowImpact) => void;
    const pending = new Promise<DramaWorkflowImpact>((accept) => {
        resolve = accept;
    });
    const reads: string[] = [];
    readImpact = async (castId) => {
        reads.push(`${userStore.getState().user.id}:${castId}`);
        if (castId === "cast-old") return pending;
        return impact(castId, 1, userStore.getState().user.id === "user-a" ? 2 : 3);
    };
    const view = await mount("cast-old");
    try {
        expect(view.host.textContent).toContain("正在读取真实引用范围");
        await view.draw("cast-current");
        await act(async () => {
            resolve(impact("cast-old", 1, 99));
            await settle();
        });
        expect(view.host.textContent).toContain("第 2 集");
        expect(view.host.textContent).not.toContain("第 99 集");
        await act(async () => {
            userStore.setState({ user: { id: "user-b" } });
            await settle();
        });
        await act(async () => {
            await settle();
        });
        expect(reads).toContain("user-b:cast-current");
        expect(view.host.textContent).toContain("第 3 集");
        expect(view.host.textContent).not.toContain("第 2 集");
    } finally {
        resolve(impact("cast-old"));
        await view.close();
    }
});
