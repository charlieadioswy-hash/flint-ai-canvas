import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import type { DramaDraft, DramaEpisodeRow, DramaModelCatalog } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/projects/new" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & { type?: string; size?: string; block?: boolean; icon?: ReactNode; loading?: boolean };
mock.module("antd", () => ({
    App: { useApp: () => ({ message: { success() {}, error() {}, warning() {} } }) },
    Button: ({ type: _type, size: _size, block: _block, loading, icon, children, ...props }: ButtonProps) => (
        <button {...props} type="button" disabled={loading || props.disabled}>
            {icon}
            {children}
        </button>
    ),
    Input: ({ size: _size, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { size?: string }) => <input {...props} />,
    InputNumber: ({ value }: { value?: number }) => <input readOnly value={value ?? ""} />,
    Select: () => null,
    Dropdown: ({ children }: { children: ReactNode }) => children,
}));
mock.module("@tanstack/react-virtual", () => ({
    useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
        getTotalSize: () => count * estimateSize(),
        getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * estimateSize(), size: estimateSize() })),
        scrollToIndex() {},
    }),
}));
mock.module("@/components/layout/workspace-page", () => ({ WorkspacePage: ({ children }: { children: ReactNode }) => children }));
mock.module("@/components/layout/workspace-state", () => ({ WorkspaceLoadingState: () => null, WorkspaceErrorState: () => null }));
mock.module("@/components/ui/base/tooltip/ant-tooltip", () => ({ AntTooltip: ({ children }: { children: ReactNode }) => children }));
mock.module("@/services/drama-canvas", () => ({ linkCanvasToDrama: async () => ({}) }));
mock.module("@/pages/projects/style-picker", () => ({ DramaStylePicker: () => null }));
mock.module("@/pages/projects/asset-scheme", () => ({
    useAssetSchemes: () => ({ data: undefined }),
    defaultAssetSettings: () => ({ mode: "custom", characterRatio: "16:9", characterPrompt: "角色", scenePrompt: "场景" }),
    AssetSchemePicker: () => null,
}));
const model = { channelId: "fixture", modelKey: "fixture", label: "测试模型" };
const catalog = { defaults: { text: model, image: model, video: model }, options: { text: [], image: [], video: [{ choice: model, videoRatios: ["9:16"], tailFrameChain: true }] } } as unknown as DramaModelCatalog;
mock.module("@/pages/projects/drama-model-picker", () => ({ DramaModelPicker: () => null, useDramaModelCatalog: () => ({ data: catalog }) }));
mock.module("@/pages/projects/step-settings", () => ({ DramaAssetImageModels: () => null, DramaTextSteps: () => null, VideoResolutionField: () => null }));
mock.module("@/pages/projects/storyboard-rules", () => ({ EpisodeDurationInput: () => null, StoryboardRules: () => null }));
mock.module("@/lib/drama/model-choice", () => ({
    dramaChoiceKey: (choice?: typeof model) => (choice?.channelId ? `${choice.channelId}:${choice.modelKey}` : ""),
    dramaVideoOptionFits: () => true,
    dramaVideoRatioIssue: () => "",
    dramaVideoResolutionIssue: () => "",
    dramaVideoResolutionValue: () => "",
    dramaResolutionAfterModelChange: () => undefined,
}));
mock.module("@/pages/projects/drama-shared", () => ({
    formatCount: (value: number) => String(value),
    formatCredits: (value: number) => String(value / 1_000_000),
    MEDIA_MODE_LABEL: { manual: { title: "手动生成", detail: "" }, auto: { title: "自动生成", detail: "" } },
    SOURCE_FORMAT_LABEL: { novel: { title: "小说" }, script: { title: "剧本" }, storyboard: { title: "分镜" } },
    VIDEO_CONTINUITY_LABEL: { tail_frame: { title: "尾帧续接", detail: "" }, parallel: { title: "并行出片", detail: "" } },
    SourceFormatPicker: () => null,
    EpisodeGroupField: () => null,
    StagePips: () => null,
    STAGE_LABEL: { draft: "待制作", review: "待审阅" },
    episodeTone: (episode: DramaEpisodeRow) => (episode.stage === "draft" ? "idle" : "review"),
    episodeStatusText: (episode: DramaEpisodeRow) => (episode.stage === "draft" ? "待制作" : "待审阅"),
}));
const sourceText = Array.from({ length: 9 }, (_, index) => `第${index + 1}集 测试${index + 1}\n△角色走进场景${index + 1}。\n角色：这是第${index + 1}集。`).join("\n\n");
let draft: DramaDraft | undefined;
const estimates: Array<{ chapterCount: number }> = [];
const saves: Array<{ id?: string; input: { chapters: Array<{ title: string; text: string }>; selectedChapters?: number[]; start: boolean } }> = [];
mock.module("@/services/api/drama", () => ({
    getDramaDraft: async () => draft,
    estimateDrama: async (input: { chapterCount: number }) => {
        estimates.push(input);
        return { episodes: input.chapterCount, durationMinutes: 9, shots: 18, priced: false, minMicrocredits: 0, maxMicrocredits: 0 };
    },
    createDrama: async (input: (typeof saves)[number]["input"]) => {
        saves.push({ input });
        return { project: { id: "saved-project" } };
    },
    saveDramaDraft: async (id: string, input: (typeof saves)[number]["input"]) => {
        saves.push({ id, input });
        return { project: { id } };
    },
}));
const { default: DramaCreatePage } = await import("@/pages/projects/create");
const { EpisodeRail } = await import("@/pages/projects/studio/episode-rail");

async function mount(content: ReactNode, entries: Parameters<typeof MemoryRouter>[0]["initialEntries"] = ["/"]) {
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
        root.render(
            <QueryClientProvider client={query}>
                <MemoryRouter initialEntries={entries}>{content}</MemoryRouter>
            </QueryClientProvider>,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return {
        host,
        close: async () => {
            await act(() => root.unmount());
            host.remove();
            query.clear();
        },
    };
}
async function flushQueries() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
    });
}
function saveButton(host: HTMLElement) {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === "保存为草稿");
    expect(button).toBeDefined();
    expect(button!.disabled).toBe(false);
    return button!;
}
afterAll(() => {
    browser.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

test("新建九集原文全部进入报价与提交，点击第九集只切预览", async () => {
    estimates.length = 0;
    saves.length = 0;
    const view = await mount(<DramaCreatePage />, [{ pathname: "/projects/new", state: { prefill: { name: "九集测试", sourceFormat: "script", text: sourceText } } }]);
    try {
        await flushQueries();
        const rows = view.host.querySelectorAll<HTMLButtonElement>("nav[aria-label='原文章节目录'] button");
        expect(rows.length).toBe(9);
        expect(view.host.querySelector("input[type='checkbox']")).toBeNull();
        expect(estimates.at(-1)?.chapterCount).toBe(9);
        await act(() => rows[8].click());
        expect(view.host.querySelector(".drama-compose-preview h2")!.textContent).toContain("第9集");
        await act(() => saveButton(view.host).click());
        await flushQueries();
        expect(saves).toHaveLength(1);
        expect(saves[0].input.chapters).toHaveLength(9);
        expect(saves[0].input.selectedChapters).toBeUndefined();
        expect(saves[0].input.start).toBe(false);
    } finally {
        await view.close();
    }
});

test("旧草稿原来只选第一集，重新保存仍包含全部九集", async () => {
    estimates.length = 0;
    saves.length = 0;
    draft = {
        projectId: "old-draft",
        name: "旧草稿",
        sourceFormat: "script",
        chapterCount: 9,
        selectedChapters: [0],
        budgetMicrocredits: 0,
        settings: { models: catalog.defaults, videoContinuity: "tail_frame", aspectRatio: "9:16", episodeMode: "chapter" },
        form: { sourceText },
    } as DramaDraft;
    const view = await mount(<DramaCreatePage />, ["/projects/new?draft=old-draft"]);
    try {
        await flushQueries();
        await flushQueries();
        expect(view.host.querySelectorAll("nav[aria-label='原文章节目录'] button")).toHaveLength(9);
        expect(estimates.at(-1)?.chapterCount).toBe(9);
        await act(() => saveButton(view.host).click());
        await flushQueries();
        expect(saves).toHaveLength(1);
        expect(saves[0].id).toBe("old-draft");
        expect(saves[0].input.chapters).toHaveLength(9);
        expect(saves[0].input.selectedChapters).toBeUndefined();
        expect(saves[0].input.start).toBe(false);
    } finally {
        draft = undefined;
        await view.close();
    }
});

test("高级台直接展示所有目录集并可选择末集，无继续选章入口", async () => {
    const selected: string[] = [];
    const episodes = Array.from({ length: 9 }, (_, index) => ({ id: `episode-${index + 1}`, number: index + 1, title: `测试${index + 1}`, synopsis: "", stage: index ? "draft" : "review", stats: { failed: 0 } })) as DramaEpisodeRow[];
    const view = await mount(<EpisodeRail episodes={episodes} currentId="episode-1" planning={false} onSelect={(id) => selected.push(id)} onAdd={() => {}} />);
    try {
        expect(view.host.querySelectorAll(".drama-ep")).toHaveLength(9);
        expect(view.host.textContent).not.toContain("继续选章");
        expect(view.host.querySelector("button[aria-label='原著章节']")).toBeNull();
        const last = view.host.querySelectorAll<HTMLButtonElement>(".drama-ep")[8];
        expect(last.textContent).toContain("待制作");
        await act(() => last.click());
        expect(selected).toEqual(["episode-9"]);
    } finally {
        await view.close();
    }
});
