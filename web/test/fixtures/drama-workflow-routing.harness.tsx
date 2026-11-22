import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, StrictMode, useEffect, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaListItem, DramaSummary } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/projects" });
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    Element: browser.Element,
    Node: browser.Node,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    File: browser.File,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
}))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, Routes, Route, useLocation, useNavigate } = await import("react-router");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { environmentManager } = await import("@tanstack/query-core");
environmentManager.setIsServer(() => false);

const noop = () => undefined;
let entryProps: { showSteps?: boolean; initialFile?: File; focusInput?: boolean } = {};
let legacyState: unknown;
let panelMounts = 0;
let panelUnmounts = 0;
let listItems: DramaListItem[] = [];
let summary: DramaSummary;
let location: ReturnType<typeof useLocation>;
let navigate: ReturnType<typeof useNavigate>;
const userStore = create(() => ({ user: { id: "routing-user" }, features: { teamsEnabled: false } }));
const agentStore = create<{
    open: boolean;
    closeAgent: () => void;
    page: { context: { projectId: string } } | null;
    setPage: (page: { context: { projectId: string } } | null) => void;
}>((set) => ({
    open: true,
    closeAgent: () => set({ open: false }),
    page: null,
    setPage: (page) => set({ page }),
}));

function Box({ children, className }: { children?: ReactNode; className?: string }) {
    return <div className={className}>{children}</div>;
}
function WorkflowMock() {
    return <div>确定步骤制作台</div>;
}
const antd = await import("antd");
mock.module("antd", () => ({
    ...antd,
    App: { useApp: () => ({ message: { success: noop, info: noop, error: noop, warning: noop }, modal: { confirm: noop } }) },
    Modal: ({ open, children }: { open?: boolean; children?: ReactNode }) => (open ? <div role="dialog">{children}</div> : null),
    Button: ({ children, icon, loading: _loading, type: _type, size: _size, shape: _shape, danger: _danger, ...props }: Record<string, unknown>) => createElement("button", props, icon as ReactNode, children as ReactNode),
    Dropdown: ({ children, menu }: { children?: ReactNode; menu: { items: Array<{ key?: string; label?: ReactNode }> } }) => (
        <div>
            {children}
            {menu.items.map((item, index) => (
                <span key={item.key || index}>{item.label}</span>
            ))}
        </div>
    ),
    Input: ({ prefix: _prefix, allowClear: _allowClear, ...props }: Record<string, unknown>) => createElement("input", props),
    ConfigProvider: Box,
    Popover: Box,
}));
mock.module("@/stores/use-user-store", () => ({ useUserStore: userStore }));
mock.module("@/stores/use-global-agent-store", () => ({ useGlobalAgentStore: agentStore }));
mock.module("@/components/layout/app-top-nav", () => ({ AppWorkspaceShell: Box }));
mock.module("@/components/canvas/use-agent-panel-dock", () => ({ useAgentPanelDock: () => ({ active: false, width: 420 }) }));
mock.module("@/lib/app-theme", () => ({ getWorkspaceAntThemeConfig: () => ({}) }));
mock.module("@/components/canvas/canvas-cloud-agent-panel", () => ({
    CanvasCloudAgentPanel: ({ hidden }: { hidden?: boolean }) => {
        useEffect(() => {
            panelMounts++;
            return () => {
                panelUnmounts++;
            };
        }, []);
        return hidden ? null : <div aria-label="通用画布 Agent">保留的画布会话</div>;
    },
}));
mock.module("@/pages/projects/workflow", () => ({ default: WorkflowMock }));
mock.module("@/pages/projects/workflow-entry", () => ({
    DramaWorkflowEntry: (props: typeof entryProps) => {
        entryProps = props;
        return <div aria-label="正文导入">正文导入</div>;
    },
}));
mock.module("@/pages/projects/create", () => ({
    default: () => {
        legacyState = useLocation().state;
        return <div>原有详细创建表单</div>;
    },
}));
mock.module("@/components/layout/workspace-page", () => ({
    WorkspacePage: Box,
    PageHeader: ({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) => (
        <header>
            <h1>{title}</h1>
            <p>{description}</p>
            {actions}
        </header>
    ),
    PaginationBar: () => null,
}));
mock.module("@/components/layout/collection-toolbar", () => ({ CollectionToolbar: Box }));
mock.module("@/components/layout/workspace-state", () => ({ WorkspaceState: Box, WorkspaceLoadingState: () => <p>加载中</p>, WorkspaceErrorState: () => <p>读取失败</p>, WorkspaceNoResultsState: () => null }));
mock.module("@/components/ui/product/relative-time", () => ({ RelativeTime: () => null }));
mock.module("@/components/ui/base/segmented-control", () => ({ SegmentedControl: () => null }));
mock.module("@/pages/projects/drama-shared", () => ({
    STATUS_LABEL: { draft: "未开始", running: "制作中", paused: "已暂停", completed: "已完成" },
    STAGE_LABEL: {},
    formatCredits: String,
    formatCount: String,
    formatDuration: String,
    sourceFormatOf: () => "novel",
    MediaThumb: () => null,
    StagePips: () => null,
}));
mock.module("@/pages/projects/studio/use-studio", () => ({
    dramaKeys: { summary: (id: string) => ["summary", id] },
    isTypingTarget: () => false,
    useDramaCast: () => ({ cast: [], byId: new Map() }),
    useDramaEpisode: () => ({ data: undefined, isLoading: false }),
    useDramaInvalidate: () => noop,
    useDramaSummary: () => ({ data: summary, isLoading: false, isError: false }),
    useOpenDramaCanvas: () => ({ open: noop }),
}));
const studioMocks: Record<string, string[]> = {
    panels: ["CastPanel", "InboxPanel", "SettingsPanel"],
    "cast-editor-dialog": ["CastEditorDialog"],
    "episode-delete-modal": ["EpisodeDeleteModal"],
    "episode-rail": ["EpisodeRail"],
    "episode-source": ["AddEpisodeModal"],
    "asset-transfer": ["AssetImportModal", "AssetPackageModal"],
    "chapter-picker": ["ChapterPickerModal"],
    "final-view": ["FinalView"],
    "studio-opening": ["StudioOpening"],
    "project-asset-audit": ["ProjectAssetAudit"],
    "episode-rename-modal": ["EpisodeRenameModal"],
    genesis: ["StudioGenesis"],
    "segment-dialog": ["SegmentDialog"],
    "queue-bar": ["QueueBar"],
    "script-view": ["ScriptView"],
    storyboard: ["Storyboard"],
};
for (const [path, names] of Object.entries(studioMocks)) mock.module(`@/pages/projects/studio/${path}`, () => Object.fromEntries(names.map((name) => [name, () => <div>{name}</div>])));
const dramaApi = await import("@/services/api/drama");
mock.module("@/services/api/drama", () => ({
    ...dramaApi,
    listDramas: async () => ({ items: listItems, total: listItems.length, statusCounts: { all: listItems.length }, page: 1, pageSize: 24 }),
}));

const { default: CreatePage } = await import("@/pages/projects/workflow-create");
const { default: ListPage } = await import("@/pages/projects/index");
const { default: DetailPage } = await import("@/pages/projects/detail");
const { default: UserLayout } = await import("@/layouts/user-layout");
const { workspaceRoutePages, preloadWorkspaceRoute } = await import("@/lib/workspace-route-modules");

function ObserveLocation() {
    location = useLocation();
    navigate = useNavigate();
    return null;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 12));
async function mount(node: ReactNode, path: string, state?: unknown, strict = false) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const content = (
        <QueryClientProvider client={query}>
            <MemoryRouter initialEntries={[{ pathname: path.split("?")[0], search: path.includes("?") ? `?${path.split("?")[1]}` : "", state }]}>
                <ObserveLocation />
                <Routes>
                    <Route path="/projects/:projectId/e/:episodeId" element={node} />
                    <Route path="*" element={node} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>
    );
    await act(async () => {
        root.render(strict ? <StrictMode>{content}</StrictMode> : content);
        await settle();
    });
    await act(async () => {
        await settle();
    });
    return {
        host,
        go: async (path: string) => {
            await act(async () => {
                navigate(path);
                await settle();
            });
        },
        close: async () => {
            await act(async () => root.unmount());
            query.clear();
            host.remove();
        },
    };
}
function item(id: string, overrides: Partial<DramaListItem> = {}): DramaListItem {
    return {
        project: { id, name: id, updatedAt: "2026-11-01" },
        guideStep: "completed",
        status: "completed",
        stage: "done",
        pauseReason: "",
        episodeCount: 3,
        doneCount: 0,
        aspectRatio: "9:16",
        spentMicrocredits: 0,
        heldMicrocredits: 0,
        updatedAt: "2026-11-01",
        ...overrides,
    } as DramaListItem;
}
function basicSummary(guideStep: string): DramaSummary {
    return {
        project: { id: "project-a", name: "测试作品" },
        production: { guideStep, status: "completed", chapterCount: 1, planDone: true, settings: { reviewMode: "manual", aspectRatio: "9:16", assets: {} } },
        episodes: [],
        inbox: [],
        jobCounts: {},
        castCount: 0,
    } as unknown as DramaSummary;
}

function fileDrag(target: EventTarget, type: string, options: { file?: File; relatedTarget?: EventTarget | null } = {}) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
        dataTransfer: { value: { types: ["Files"], files: options.file ? [options.file] : [], dropEffect: "none" } },
        relatedTarget: { value: options.relatedTarget ?? null },
    });
    target.dispatchEvent(event);
}

afterAll(() => browser.happyDOM.abort());

test("新建入口在 StrictMode 中传入原 File，并保留正文聚焦与主题外壳", async () => {
    const file = new File(["第一集 正文"], "剧本.docx");
    const mounted = await mount(<CreatePage />, "/projects/new?paste=1", { file }, true);
    try {
        expect(entryProps.initialFile).toBe(file);
        expect(entryProps.focusInput).toBe(true);
        expect(mounted.host.querySelector('[aria-label="正文导入"]')).not.toBeNull();
        expect(mounted.host.querySelector(".drama-root")).not.toBeNull();
    } finally {
        await mounted.close();
    }
});

test("详细创建草稿保留原编辑入口", async () => {
    const mounted = await mount(<CreatePage />, "/projects/new?draft=old-draft");
    try {
        expect(mounted.host.textContent).toContain("原有详细创建表单");
    } finally {
        await mounted.close();
    }
});

test("显式详细创建保持可用", async () => {
    const mounted = await mount(<CreatePage />, "/projects/new?mode=advanced");
    try {
        expect(mounted.host.textContent).toContain("原有详细创建表单");
    } finally {
        await mounted.close();
    }
});

test("从画布导入分镜时保留原始正文、格式和 canvasId", async () => {
    const state = { prefill: { name: "画布剧本", sourceFormat: "storyboard", text: "镜头一：城市", canvasId: "source-canvas" } };
    const mounted = await mount(<CreatePage />, "/projects/new", state);
    try {
        expect(mounted.host.textContent).toContain("原有详细创建表单");
        expect(legacyState).toEqual(state);
    } finally {
        await mounted.close();
    }
});

test("进入短剧页只隐藏画布 Agent，返回后恢复同一实例及打开状态", async () => {
    agentStore.setState({ open: true });
    panelMounts = 0;
    panelUnmounts = 0;
    const mounted = await mount(
        <UserLayout>
            <div>当前工作区</div>
        </UserLayout>,
        "/canvas/canvas-a",
    );
    try {
        expect(mounted.host.textContent).toContain("保留的画布会话");
        expect(panelMounts).toBe(1);
        await mounted.go("/projects/project-a/guide");
        expect(mounted.host.querySelector('[aria-label="通用画布 Agent"]')).toBeNull();
        expect(agentStore.getState().open).toBe(true);
        expect(panelUnmounts).toBe(0);
        await mounted.go("/canvas/canvas-a");
        expect(mounted.host.textContent).toContain("保留的画布会话");
        expect(panelMounts).toBe(1);
        expect(panelUnmounts).toBe(0);
    } finally {
        await mounted.close();
    }
});

test("历史 guide 含查询参数和 hash 时预取新步骤工作流", async () => {
    const preload = spyOn(workspaceRoutePages.projectGuide, "preload");
    try {
        preloadWorkspaceRoute("/projects/project-a/guide?step=assets#characters");
        expect(preload).toHaveBeenCalledTimes(1);
        expect(await preload.mock.results[0].value).toMatchObject({ default: WorkflowMock });
    } finally {
        preload.mockRestore();
    }
});

test("带粘贴参数的新建路由预取创建包装页", async () => {
    const preload = spyOn(workspaceRoutePages.projectCreate, "preload");
    try {
        preloadWorkspaceRoute("/projects/new?paste=1#source");
        expect(preload).toHaveBeenCalledTimes(1);
        expect(await preload.mock.results[0].value).toMatchObject({ default: CreatePage });
    } finally {
        preload.mockRestore();
    }
});

test("默认项目制作入口直接呈现确定步骤界面", async () => {
    const mounted = await mount(<DetailPage />, "/projects/project-a/e/episode-a?scope=all&mode=simple");
    try {
        expect(mounted.host.textContent).toContain("确定步骤制作台");
    } finally {
        await mounted.close();
    }
});

test("进行中与完成作品均可打开详细制作台，返回简易保留所有定位和步骤", async () => {
    for (const stage of ["assets", "completed"]) {
        summary = basicSummary(stage);
        const mounted = await mount(<DetailPage />, "/projects/project-a/e/episode-a?mode=advanced&view=settings&step=preview&scope=all&segment=4&shot=shot-a&episode=episode-b&status=failed");
        try {
            expect(mounted.host.textContent).toContain("SettingsPanel");
            const button = [...mounted.host.querySelectorAll("button")].find((element) => element.textContent === "简易制作台")!;
            await act(async () => {
                button.click();
                await settle();
            });
            const search = new URLSearchParams(location.search);
            expect(location.pathname).toBe("/projects/project-a/e/episode-a");
            expect(Object.fromEntries(search)).toEqual({ mode: "simple", step: "preview", scope: "all", segment: "4", shot: "shot-a", episode: "episode-b", status: "failed" });
        } finally {
            await mounted.close();
        }
    }
});

test("作品卡区分文字就绪与真正成片，配置作品提供继续配置", async () => {
    listItems = [
        item("未成片"),
        item("已成片", { doneCount: 3 }),
        item("配置项目", { guideStep: "configuring", status: "draft" }),
        item("空草稿", { episodeCount: 0, guideStep: "configuring", status: "draft", hasDraftForm: true }),
        item("等待分集", { episodeCount: 0, guideStep: "story" }),
    ];
    const mounted = await mount(<ListPage />, "/projects");
    try {
        const cards = [...mounted.host.querySelectorAll("article")];
        expect(cards[0].textContent).toContain("待制作视频");
        expect(cards[0].textContent).toContain("文字已就绪 · 0/3 集成片");
        expect(cards[1].textContent).toContain("已完成");
        expect(cards[2].textContent).toContain("继续配置");
        expect(cards[2].querySelector("a")?.getAttribute("href")).toBe(`/projects/${encodeURIComponent("配置项目")}/guide`);
        expect(cards[0].querySelector("a")?.getAttribute("href")).toBe(`/projects/${encodeURIComponent("未成片")}?manage=episodes`);
        expect(cards[1].querySelector("a")?.getAttribute("href")).toBe(`/projects/${encodeURIComponent("已成片")}?manage=episodes`);
        expect(cards[3].querySelector("a")?.getAttribute("href")).toBe(`/projects/new?draft=${encodeURIComponent("空草稿")}`);
        expect(cards[4].querySelector("a")?.getAttribute("href")).toBe(`/projects/${encodeURIComponent("等待分集")}/guide`);
        expect(mounted.host.textContent).not.toContain("创作引导");
    } finally {
        await mounted.close();
    }
});

test("从短剧首页的子元素拖出文件时清除遮罩，在页内移动时保留遮罩", async () => {
    const mounted = await mount(<ListPage />, "/projects");
    try {
        const source = mounted.host.querySelector('[aria-label="正文导入"]')!;
        const heading = mounted.host.querySelector("h1")!;
        const overlayVisible = () => Boolean(mounted.host.querySelector(".drama-library-drop"));
        await act(async () => fileDrag(source, "dragover"));
        expect(overlayVisible()).toBe(true);
        await act(async () => fileDrag(source, "dragleave", { relatedTarget: heading }));
        expect(overlayVisible()).toBe(true);
        await act(async () => fileDrag(heading, "dragleave", { relatedTarget: document.body }));
        expect(overlayVisible()).toBe(false);
        await act(async () => fileDrag(source, "dragover"));
        expect(overlayVisible()).toBe(true);
        await act(async () => fileDrag(source, "dragleave"));
        expect(overlayVisible()).toBe(false);
        expect(location.pathname).toBe("/projects");
    } finally {
        await mounted.close();
    }
});

test("子上传区接收文件后清除首页遮罩并保留子上传流程", async () => {
    const mounted = await mount(<ListPage />, "/projects");
    try {
        const file = new File(["第一集 正文"], "剧本.txt");
        const heading = mounted.host.querySelector("h1")!;
        const uploader = mounted.host.querySelector('[aria-label="正文导入"]')!;
        let receivedFile: File | undefined;
        uploader.addEventListener("drop", (event) => {
            event.preventDefault();
            event.stopPropagation();
            receivedFile = (event as DragEvent).dataTransfer?.files[0];
        });
        await act(async () => fileDrag(heading, "dragover"));
        expect(Boolean(mounted.host.querySelector(".drama-library-drop"))).toBe(true);
        await act(async () => fileDrag(uploader, "drop", { file }));
        expect(receivedFile).toBe(file);
        expect(Boolean(mounted.host.querySelector(".drama-library-drop"))).toBe(false);

        const nextFile = new File(["第二集 正文"], "第二集.txt");
        // 两个事件可以在 React 提交首次拖入状态之前到达。
        await act(async () => {
            fileDrag(heading, "dragover");
            fileDrag(uploader, "drop", { file: nextFile });
        });
        expect(receivedFile).toBe(nextFile);
        expect(Boolean(mounted.host.querySelector(".drama-library-drop"))).toBe(false);
        expect(location.pathname).toBe("/projects");
    } finally {
        await mounted.close();
    }
});

test("在短剧首页放下文件时清除遮罩并打开新建入口", async () => {
    const mounted = await mount(<ListPage />, "/projects");
    try {
        const file = new File(["第一集 正文"], "剧本.txt");
        const heading = mounted.host.querySelector("h1")!;
        await act(async () => fileDrag(heading, "dragover"));
        expect(Boolean(mounted.host.querySelector(".drama-library-drop"))).toBe(true);
        await act(async () => fileDrag(heading, "drop"));
        expect(Boolean(mounted.host.querySelector(".drama-library-drop"))).toBe(false);
        expect(location.pathname).toBe("/projects");
        await act(async () => fileDrag(heading, "dragover"));
        await act(async () => fileDrag(heading, "drop", { file }));
        expect(Boolean(mounted.host.querySelector(".drama-library-drop"))).toBe(false);
        expect(location.pathname).toBe("/projects/new");
        expect(location.state.file).toBe(file);
    } finally {
        await mounted.close();
    }
});

test("拖动结束、按 Escape 或窗口失焦时收起短剧首页的拖放遮罩", async () => {
    const mounted = await mount(<ListPage />, "/projects");
    try {
        const source = mounted.host.querySelector('[aria-label="正文导入"]')!;
        const overlayVisible = () => Boolean(mounted.host.querySelector(".drama-library-drop"));
        const terminalEvents = [new Event("dragend"), new browser.KeyboardEvent("keydown", { key: "Escape" }), new Event("blur")];
        for (const event of terminalEvents) {
            await act(async () => fileDrag(source, "dragover"));
            expect(overlayVisible()).toBe(true);
            await act(async () => window.dispatchEvent(event));
            expect(overlayVisible()).toBe(false);
        }
        expect(location.pathname).toBe("/projects");
    } finally {
        await mounted.close();
    }
});
