import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaEpisodeDetail, DramaEpisodeRow, DramaSummary, DramaWorkflowReadiness } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/projects/project-a?step=story" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    InputEvent: browser.InputEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { environmentManager } = await import("@tanstack/query-core");
environmentManager.setIsServer(() => false);
const { ApiError } = await import("@/services/api/request");

const userStore = create<{ user: { id: string }; setUser: (id: string) => void }>((set) => ({ user: { id: "user-a" }, setUser: (id) => set({ user: { id } }) }));
const reads: string[] = [];
const renders: Array<{ projectId: string; episodeId: string; expectedRevision: number }> = [];
const downloads: string[] = [];
let ready: DramaWorkflowReadiness;
let renderImpl: (episodeId: string) => Promise<{ jobs: number }>;
let downloadImpl: (resourceId: string) => Promise<void>;

mock.module("antd", () => ({
    Button: ({ children, icon, type: _type, size: _size, loading: _loading, ...props }: any) => createElement("button", { ...props, type: "button" }, icon, children),
    Input: ({ prefix: _prefix, allowClear: _allowClear, ...props }: any) => createElement("input", props),
    Select: ({ options, onChange, suffixIcon: _suffixIcon, ...props }: any) =>
        createElement(
            "select",
            { ...props, onChange: (event: Event) => onChange((event.target as HTMLSelectElement).value) },
            options.map((option: any) => createElement("option", { key: option.value, value: option.value }, option.label)),
        ),
}));
mock.module("@/stores/use-user-store", () => ({ useUserStore: userStore }));
mock.module("@/components/ui/product/app-modal", () => ({
    AppModal: ({ children, footer, title, open }: { children: ReactNode; footer: ReactNode; title: string; open: boolean }) =>
        open ? createElement("section", { role: "dialog", "aria-label": title }, createElement("h2", null, title), children, footer) : null,
}));
mock.module("@/pages/projects/studio/asset-transfer", () => ({ AssetPackageModal: () => null }));
mock.module("@/pages/projects/studio/episode-source", () => ({ AddEpisodeModal: () => null }));
mock.module("@/pages/projects/workflow-batch", () => ({
    WorkflowBatch: ({ targetIds, targetLabels }: any) => createElement("output", { "aria-label": "真实批次范围", "data-target-ids": targetIds.join(",") }, targetIds.map((id: string) => targetLabels[id]).join(" / ")),
}));
mock.module("@/pages/projects/drama-shared", () => ({
    aspectRatioValue: () => "9 / 16",
    sourceFormatOf: () => "novel",
    formatDuration: () => "30 秒",
    episodeStatusText: (episode: DramaEpisodeRow) => (episode.stage === "done" ? "已完成" : "制作中"),
    episodeTone: (episode: DramaEpisodeRow) => (episode.error ? "error" : episode.stage === "done" && !episode.finalStale ? "done" : episode.awaitingMedia ? "ready" : "active"),
    MediaThumb: ({ fallback }: any) => fallback,
    downloadResource: async (resourceId: string) => {
        downloads.push(resourceId);
        await downloadImpl(resourceId);
    },
}));
mock.module("@/services/api/drama", () => ({
    getDramaEpisode: async (projectId: string, episodeId: string) => {
        reads.push(`${projectId}:${episodeId}`);
        return detailOf(projectId, episodeId);
    },
    getDramaWorkflowReadiness: async () => ready,
    renderDramaEpisode: async (projectId: string, episodeId: string, input: { expectedRevision: number }) => {
        renders.push({ projectId, episodeId, expectedRevision: input.expectedRevision });
        return renderImpl(episodeId);
    },
}));

const { WorkflowEpisodes } = await import("@/pages/projects/workflow-episodes");
function episodeOf(id: string, number: number, patch: Partial<DramaEpisodeRow> = {}): DramaEpisodeRow {
    return {
        id,
        number,
        title: `剧情 ${number}`,
        synopsis: `本集剧情 ${number}`,
        stage: "video",
        sourceFormat: "novel",
        error: "",
        shotCount: 2,
        durationMs: 30000,
        approved: true,
        mediaReleased: true,
        awaitingMedia: false,
        finalStale: false,
        stats: { segments: 2, promptReady: 2, promptSucceeded: 2, videoReady: 2, videoGenerated: 2, failed: 0 },
        ...patch,
    };
}
function summaryOf(projectId = "project-a", episodes = [episodeOf("e1", 1), episodeOf("e2", 2), episodeOf("e3", 3, { stage: "done", finalResourceId: "final-3" })]) {
    return { project: { id: projectId, name: "测试作品" }, production: { revision: 8, planDone: true, settings: { aspectRatio: "9:16" } }, episodes, jobCounts: {}, inbox: [], castCount: 2 } as unknown as DramaSummary;
}
function detailOf(projectId: string, episodeId: string): DramaEpisodeDetail {
    return {
        episode: { id: episodeId, projectId, number: Number(episodeId.slice(1)), revision: 10 },
        segments: [{ id: `${episodeId}-segment`, index: 0, request: { references: [{ castId: "hero", resourceId: "hero-image" }] } }],
        shots: [],
        jobs: [],
        chapters: [],
    } as unknown as DramaEpisodeDetail;
}
beforeEach(() => {
    reads.length = 0;
    renders.length = 0;
    downloads.length = 0;
    userStore.getState().setUser("user-a");
    ready = {
        revision: 8,
        guideStep: "story",
        episodes: [1, 2, 3].map((number) => ({ episodeId: `e${number}`, number, title: `剧情 ${number}`, revision: number + 40, canRender: true, textReady: true, canGenerateVideo: true, segmentCount: 2, readyVideos: 2 })),
    };
    renderImpl = async () => ({ jobs: 1 });
    downloadImpl = async () => {};
});
afterAll(() => {
    browser.happyDOM.abort();
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 0));
}
async function mount(initial = summaryOf()) {
    const container = document.createElement("div");
    document.body.append(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const root = createRoot(container);
    const changed: string[] = [];
    const opened: string[] = [];
    let summary = initial;
    const update = async (next = summary) => {
        summary = next;
        await act(async () => {
            root.render(
                createElement(
                    QueryClientProvider,
                    { client },
                    createElement(WorkflowEpisodes, {
                        summary,
                        onChanged: () => {
                            changed.push(summary.project.id);
                        },
                        onOpenEpisode: (id) => opened.push(id),
                    }),
                ),
            );
            await settle();
        });
        await act(settle);
    };
    await update();
    return {
        container,
        changed,
        opened,
        update,
        dispose: async () => {
            await act(async () => root.unmount());
            client.clear();
            container.remove();
        },
    };
}
function button(container: ParentNode, label: string) {
    const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label);
    expect(found, label).toBeDefined();
    return found!;
}
async function click(element: HTMLElement) {
    await act(async () => {
        element.click();
        await settle();
    });
    await act(settle);
}
async function edit(input: HTMLInputElement, value: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
        await settle();
    });
}

test("选择分集才读取对应剧情段，筛选与排序不会把批次换成镜头或其它集", async () => {
    const view = await mount();
    try {
        expect(reads).toEqual([]);
        await click(view.container.querySelector<HTMLInputElement>('[aria-label="选择第 2 集"]')!);
        expect(reads).toEqual(["project-a:e2"]);
        expect(view.container.querySelector('[aria-label="真实批次范围"]')?.getAttribute("data-target-ids")).toBe("e2-segment");
        expect(view.container.textContent).toContain("已引用 1 项");
        const sort = view.container.querySelector<HTMLSelectElement>('[aria-label="分集排序"]')!;
        await act(async () => {
            sort.value = "desc";
            sort.dispatchEvent(new Event("change", { bubbles: true }));
        });
        expect(view.container.querySelector(".drama-workflow-episode-open")?.getAttribute("aria-label")).toBe("打开第 3 集分镜");
        await edit(view.container.querySelector<HTMLInputElement>('[aria-label="搜索分集"]')!, "剧情 1");
        expect(view.container.querySelectorAll(".drama-workflow-episode-card")).toHaveLength(1);
        expect(view.container.querySelector('[aria-label="真实批次范围"]')?.getAttribute("data-target-ids")).toBe("e2-segment");
        await click(button(view.container, "打开第 1 集分镜"));
        expect(view.opened).toEqual(["e1"]);
        expect(renders).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("全部合成只提交就绪集的各自版本，失败逐项保留并可重新检查", async () => {
    ready.episodes[1].canRender = false;
    ready.episodes[1].blockingReason = "本集第 2 段尚未生成";
    const view = await mount();
    try {
        await click(button(view.container, "合成全部就绪分集"));
        expect(renders).toHaveLength(0);
        expect(view.container.textContent).toContain("本集第 2 段尚未生成");
        expect(view.container.textContent).toContain("已有最新成片");
        renderImpl = async () => {
            throw new ApiError("本集内容已改变", { status: 409, reason: "conflict" });
        };
        await click(button(view.container, "合成 1 集"));
        expect(renders).toEqual([{ projectId: "project-a", episodeId: "e1", expectedRevision: 41 }]);
        expect(view.container.textContent).toContain("本集内容已改变");
        ready.episodes[0].revision = 51;
        await click(button(view.container, "重新检查未完成项"));
        renderImpl = async () => ({ jobs: 1 });
        await click(button(view.container, "合成 1 集"));
        expect(renders.at(-1)?.expectedRevision).toBe(51);
        expect(view.container.textContent).toContain("已提交合成");
        expect(view.changed).toEqual(["project-a", "project-a"]);
    } finally {
        await view.dispose();
    }
});

test("旧版成片明确标记，逐项下载失败后重试不重复成功项", async () => {
    const view = await mount(summaryOf("project-a", [episodeOf("e1", 1, { finalResourceId: "final-1", stage: "done" }), episodeOf("e2", 2, { finalResourceId: "final-2", stage: "done", finalStale: true })]));
    let first = true;
    downloadImpl = async (id) => {
        if (id === "final-2" && first) {
            first = false;
            throw new Error("下载凭证读取失败");
        }
    };
    try {
        await click(button(view.container, "下载全部成片"));
        expect(view.container.textContent).toContain("当前为旧版成片");
        expect(downloads).toEqual([]);
        await click(button(view.container, "下载 2 集成片"));
        expect(downloads).toEqual(["final-1", "final-2"]);
        expect(view.container.textContent).toContain("下载凭证读取失败");
        await click(button(view.container, "重新检查未完成项"));
        await click(button(view.container, "下载 1 集成片"));
        expect(downloads).toEqual(["final-1", "final-2", "final-2"]);
        expect(view.container.textContent).toContain("已发起下载");
        expect(renders).toEqual([]);
    } finally {
        await view.dispose();
    }
});

test("切换账号后迟到回执不刷新新页，也不继续提交下一集", async () => {
    let finish!: (value: { jobs: number }) => void;
    renderImpl = () =>
        new Promise((resolve) => {
            finish = resolve;
        });
    const view = await mount(summaryOf("project-a", [episodeOf("e1", 1), episodeOf("e2", 2)]));
    try {
        await click(button(view.container, "合成全部就绪分集"));
        await click(button(view.container, "合成 2 集"));
        expect(renders).toHaveLength(1);
        await act(async () => {
            userStore.getState().setUser("user-b");
            await settle();
        });
        await act(async () => {
            finish({ jobs: 1 });
            await settle();
        });
        expect(renders).toHaveLength(1);
        expect(view.changed).toEqual([]);
        expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    } finally {
        await view.dispose();
    }
});
