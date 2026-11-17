import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, StrictMode, useEffect, useState, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaDrawingConfiguration, DramaEpisodeStyle, DramaGuideStep, DramaModelOption, DramaSettings, DramaSourceFormat, DramaSummary, UpdateDramaEpisodeStyleRequest } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/projects/project-a/guide" });
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    Element: browser.Element,
    Node: browser.Node,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    InputEvent: browser.InputEvent,
    File: browser.File,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
}))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider, useLocation, useNavigate, useSearchParams } = await import("react-router");
const { QueryClient, QueryClientProvider, useQuery } = await import("@tanstack/react-query");
const { environmentManager } = await import("@tanstack/query-core");
environmentManager.setIsServer(() => false);

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
    let resolve!: Deferred<T>["resolve"];
    let reject!: Deferred<T>["reject"];
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
const summaries = new Map<string, DramaSummary>();
const notices: Array<{ kind: string; text: string }> = [];
const confirms: Array<{ projectId: string; input: { expectedStep: DramaGuideStep; expectedRevision: number; settings?: DramaSettings }; pending: Deferred<DramaSummary> }> = [];
const sourceSaves: Array<{ projectId: string; chapterId: string; pending: Deferred<{ chapter: { id: string; title: string; sourceText: string } }> }> = [];
const styleSaves: Array<{ projectId: string; input: { expectedRevision: number; styleName: string; stylePrompt: string; drawing?: DramaDrawingConfiguration }; pending: Deferred<DramaSummary> }> = [];
const configurationSaves: Array<{ projectId: string; input: { expectedRevision?: number; settings?: DramaSettings }; pending: Deferred<DramaSummary> }> = [];
const episodeStyleSaves: Array<{ projectId: string; episodeId: string; input: UpdateDramaEpisodeStyleRequest; pending: Deferred<DramaEpisodeStyle> }> = [];
const episodeStyles = new Map<string, DramaEpisodeStyle>();
const episodeStyleReads: string[] = [];
const castImageRequests: Array<{ castId: string; episodeId?: string }> = [];
const modeConfigurationWrites: Array<Deferred<boolean>> = [];
const projectTextRetries: string[] = [];
const scopedRetries: Array<{ projectId: string; episodeId?: string }> = [];
let chapterTitles = ["第一章"];
let episodeStyleReader: ((projectId: string, episodeId: string) => Promise<DramaEpisodeStyle>) | undefined;
let queueJobs: Array<{ id: string; kind: string; status: string; createdAt: string }> = [];
let chapterReads = 0;
let videoOptions: DramaModelOption[] = [];
const userStore = create(() => ({ user: { id: "user-a" } }));
const noop = () => undefined;
const message = Object.fromEntries(["success", "error", "info", "warning"].map((kind) => [kind, (text: string) => notices.push({ kind, text })]));
mock.module("@/pages/projects/studio/drama-media-action-context", () => ({
    DramaMediaActionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    DramaMediaEpisodeScope: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useDramaMediaContext: () => null,
    QuotedMediaButton: ({ label, onClick, disabled, title, "aria-label": ariaLabel }: { label: string; onClick?: () => void; disabled?: boolean; title?: string; "aria-label"?: string }) => (
        <button disabled={disabled} onClick={onClick} title={title} aria-label={ariaLabel}>
            {label}
        </button>
    ),
}));
mock.module("antd", () => ({
    App: { useApp: () => ({ message }) },
    Button: ({ children, icon, loading: _loading, type: _type, size: _size, danger: _danger, ...props }: Record<string, unknown>) => createElement("button", props, icon as ReactNode, children as ReactNode),
    Dropdown: ({ children, menu }: { children: ReactNode; menu: { items: Array<{ key: string; label: ReactNode; onClick: () => void }> } }) => {
        const [open, setOpen] = useState(false);
        return (
            <div>
                <span onClick={() => setOpen((value) => !value)}>{children}</span>
                {open ? (
                    <div role="menu">
                        {menu.items.map((item) => (
                            <button key={item.key} role="menuitem" onClick={item.onClick}>
                                {item.label}
                            </button>
                        ))}
                    </div>
                ) : null}
            </div>
        );
    },
    Input: Object.assign((props: Record<string, unknown>) => createElement("input", props), { TextArea: (props: Record<string, unknown>) => createElement("textarea", props) }),
}));
mock.module("@/stores/use-user-store", () => ({ useUserStore: userStore }));
const userScope = await import("@/lib/user-scope");
mock.module("@/lib/user-scope", () => ({ ...userScope, getActiveUserScope: () => userStore.getState().user.id }));
mock.module("@/components/layout/workspace-page", () => ({ WorkspacePage: ({ children, className }: { children?: ReactNode; className?: string }) => <main className={className}>{children}</main> }));
mock.module("@/components/ui/product/app-modal", () => ({
    AppModal: ({ open, title, children, footer }: { open: boolean; title: string; children?: ReactNode; footer?: ReactNode }) =>
        open ? (
            <div role="dialog" aria-label={title}>
                {children}
                {footer}
            </div>
        ) : null,
}));
mock.module("@/components/layout/workspace-state", () => ({ WorkspaceLoadingState: () => <p>加载作品中</p>, WorkspaceErrorState: ({ title }: { title: string }) => <p>{title}</p> }));
mock.module("@/pages/projects/studio/project-topbar", () => ({
    DramaProjectTopbar: ({ name, controls, children }: { name: string; controls?: ReactNode; children?: ReactNode }) => (
        <header>
            <h1>{name}</h1>
            {controls}
            {children}
        </header>
    ),
}));
mock.module("@/pages/projects/studio/cast-editor-dialog", () => ({ CastEditorDialog: () => null }));
mock.module("@/pages/projects/studio/drama-media-action-dialog", () => ({ DramaMediaActionDialog: () => null }));
mock.module("@/pages/projects/studio/use-drama-media-action", () => ({
    useDramaMediaAction: () => ({ state: { submitting: false }, requestCastImage: (cast: { id: string }, episodeId?: string) => castImageRequests.push({ castId: cast.id, episodeId }) }),
}));
mock.module("@/pages/projects/studio/queue-bar", () => ({ QueueBar: () => null }));
mock.module("@/pages/projects/guide-panels", () => ({ GuideAssets: () => <div>主体资产列表</div> }));
mock.module("@/pages/projects/workflow-assets", () => ({
    WorkflowAssets: ({
        summary,
        onDirtyChange,
        busy = false,
        onContinue,
        continueDisabled,
        episodeId,
        onEpisodeChange,
        onGenerate,
    }: {
        summary: DramaSummary;
        onDirtyChange: (dirty: boolean, busy: boolean) => void;
        busy?: boolean;
        onContinue?: () => void;
        continueDisabled?: boolean;
        episodeId?: string;
        onEpisodeChange?: (episodeId: string) => void;
        onGenerate: (cast: { id: string }, episodeId?: string) => void;
    }) => {
        const [dirty, setDirty] = useState(false);
        useEffect(() => {
            onDirtyChange(dirty, busy);
            return () => onDirtyChange(false, false);
        }, [dirty, busy, onDirtyChange]);
        return (
            <section>
                主体资产列表<button onClick={() => setDirty(true)}>编辑资产方案</button>
                <button onClick={() => setDirty(false)}>还原资产方案</button>
                <output aria-label="当前主体集">{episodeId || "未选择"}</output>
                <output aria-label="主体页本集配置">
                    {summary.production.settings.styleName} · {summary.production.settings.language}
                </output>
                <output aria-label="主体页配置忙状态">{String(busy)}</output>
                <button onClick={() => onEpisodeChange?.("episode-b")}>切换主体到第二集</button>
                <button onClick={() => onGenerate({ id: "shared-cast" }, "episode-b")}>生成当前选集主体</button>
                <button onClick={() => onGenerate({ id: "shared-cast" })}>生成页面所属主体</button>
                {onContinue ? (
                    <button disabled={continueDisabled} onClick={onContinue}>
                        编排剧本
                    </button>
                ) : null}
            </section>
        );
    },
}));
mock.module("@/pages/projects/workflow-production", () => ({
    WorkflowProduction: ({
        summary,
        busy,
        onDirtyChange,
        onAllowMediaNavigation,
        headerActions,
    }: {
        summary: DramaSummary;
        busy?: boolean;
        onDirtyChange?: (dirty: boolean, busy?: boolean, automatic?: boolean) => void;
        onAllowMediaNavigation?: (next: { pathname: string; search: string }) => void;
        headerActions?: ReactNode;
    }) => {
        const [dirty, setDirty] = useState(false);
        const [automatic, setAutomatic] = useState(false);
        const [automaticBusy, setAutomaticBusy] = useState(false);
        const location = useLocation();
        const navigate = useNavigate();
        useEffect(() => setDirty(false), [location.pathname, location.search]);
        useEffect(() => {
            onDirtyChange?.(dirty, automaticBusy, automatic);
            return () => onDirtyChange?.(false, false);
        }, [dirty, automaticBusy, automatic, onDirtyChange]);
        return (
            <div>
                <header className="drama-workflow-production-toolbar">
                    <h2>分镜管理</h2>
                    {headerActions ? (
                        <div className="drama-workflow-production-guidance" aria-label="制作流程引导">
                            {headerActions}
                        </div>
                    ) : null}
                </header>
                分镜制作 {summary.project.name}
                <output aria-label="分镜页分集目录">{summary.episodes.map((episode) => episode.id).join(",")}</output>
                <output aria-label="分镜页本集配置">
                    {summary.production.settings.styleName} · {summary.production.settings.language}
                </output>
                <output aria-label="分镜页配置忙状态">{String(busy)}</output>
                <button onClick={() => setDirty(true)}>编辑镜头配置</button>
                <button onClick={() => setDirty(false)}>还原镜头配置</button>
                <button
                    onClick={() => {
                        setAutomatic(true);
                        setAutomaticBusy(true);
                    }}
                >
                    修改镜头生成参数
                </button>
                <button onClick={() => setAutomaticBusy(false)}>配置自动同步完成</button>
                <button
                    onClick={() => {
                        setAutomatic(false);
                        setAutomaticBusy(true);
                    }}
                >
                    生成提交回执未确认
                </button>
                <button
                    onClick={() => {
                        setAutomaticBusy(false);
                        setDirty(true);
                    }}
                >
                    配置自动同步失败
                </button>
                <button
                    onClick={() => {
                        const next = { pathname: `/projects/${summary.project.id}/e/episode-a`, search: "?step=story&editor=media&shot=shot-b" };
                        onAllowMediaNavigation?.(next);
                        void navigate(next);
                    }}
                >
                    已确认切换镜头
                </button>
            </div>
        );
    },
}));
mock.module("@/pages/projects/workflow-episodes", () => ({
    WorkflowEpisodes: ({ summary }: { summary: DramaSummary }) => (
        <div>
            分集管理列表<output aria-label="管理页分集目录">{summary.episodes.map((episode) => episode.id).join(",")}</output>
        </div>
    ),
}));
mock.module("@/pages/projects/workflow-mode-dialog", () => ({
    WorkflowModeDialog: ({
        open,
        summary,
        onConfirm,
        onGenerationStateChange,
        registerGenerationFlush,
    }: {
        open: boolean;
        summary: DramaSummary;
        onConfirm: (settings: DramaSettings) => Promise<unknown>;
        onGenerationStateChange: (pending: boolean) => void;
        registerGenerationFlush: (flush: (() => Promise<boolean>) | null) => void;
    }) => {
        const [pending, setPending] = useState(false);
        useEffect(() => {
            onGenerationStateChange(open && pending);
        }, [open, pending, onGenerationStateChange]);
        useEffect(() => {
            if (!open) return;
            registerGenerationFlush(async () => {
                const write = deferred<boolean>();
                modeConfigurationWrites.push(write);
                const applied = await write.promise;
                if (applied) setPending(false);
                return applied;
            });
            return () => {
                registerGenerationFlush(null);
                onGenerationStateChange(false);
            };
        }, [open, registerGenerationFlush, onGenerationStateChange]);
        return open ? (
            <div role="dialog" aria-label="选择分镜生成默认模式">
                <button onClick={() => setPending(true)}>修改模式窗口视频配置</button>
                <button onClick={() => void onConfirm(summary.production.settings).catch(noop)}>确认分镜模式</button>
            </div>
        ) : null;
    },
}));
mock.module("@/pages/projects/workflow-impact", () => ({ WorkflowImpact: () => <p>真实风格影响范围</p> }));
mock.module("@/pages/projects/workflow-configuration", () => ({
    WorkflowConfiguration: ({ settings, onChange, disabled, styleOnly, scope }: { settings: DramaSettings; onChange: (value: DramaSettings) => void; disabled: boolean; styleOnly?: boolean; scope?: "project" | "episode" }) => (
        <>
            <input aria-label="风格配置" data-style-only={styleOnly} data-scope={scope} disabled={disabled} value={settings.styleName} onChange={(event) => onChange({ ...settings, styleName: event.target.value })} />
            <textarea aria-label="风格说明" disabled={disabled} value={settings.stylePrompt} onChange={(event) => onChange({ ...settings, stylePrompt: event.target.value })} />
            <input aria-label="对白语言" disabled={disabled || styleOnly} value={settings.language} onChange={(event) => onChange({ ...settings, language: event.target.value })} />
            <input aria-label="视频模型" disabled={disabled || styleOnly} value={settings.models.video.logicalModelId || ""} onChange={(event) => onChange({ ...settings, models: { ...settings.models, video: { logicalModelId: event.target.value } } })} />
            <select aria-label="角色绘图模板" disabled={disabled} value={settings.assets.mode} onChange={(event) => onChange({ ...settings, assets: { ...settings.assets, mode: event.target.value as DramaSettings["assets"]["mode"] } })}>
                <option value="custom">自定义模板</option>
                <option value="closeup_fullbody">特写全身</option>
                <option value="closeup_turnaround">特写三视图</option>
            </select>
        </>
    ),
}));
mock.module("@/pages/projects/drama-model-picker", () => ({ useDramaModelCatalog: () => ({ data: { options: { video: videoOptions } } }) }));
mock.module("@/pages/projects/drama-shared", () => ({
    SOURCE_FORMAT_LABEL: {
        novel: { title: "小说", detail: "保留章节标题", placeholder: "小说正文", guide: [] },
        script: { title: "剧本", detail: "保留分集标题", placeholder: "剧本正文", guide: [] },
        storyboard: { title: "分镜", detail: "保留镜头编号", placeholder: "分镜正文", guide: [] },
    },
    SourceFormatPicker: ({ value, disabled, onChange }: { value: DramaSourceFormat; disabled?: boolean; onChange: (value: DramaSourceFormat) => void }) => (
        <select aria-label="素材类型" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as DramaSourceFormat)}>
            <option value="novel">小说</option>
            <option value="script">剧本</option>
        </select>
    ),
}));
mock.module("@/pages/projects/drama-source-file", () => ({ DRAMA_SOURCE_FILE_MAX_BYTES: 10_000_000, formatDramaSourceFileSize: () => "10MB", readDramaSourceFile: async () => "替换正文" }));
const summaryKey = (projectId: string) => ["drama", projectId, "summary"];
mock.module("@/pages/projects/studio/use-studio", () => ({
    dramaKeys: {
        summary: summaryKey,
        chapters: (projectId: string) => ["drama", projectId, "chapters"],
        episode: (projectId: string, episodeId: string) => ["drama", projectId, "episode", episodeId],
        jobs: (projectId: string) => ["drama", projectId, "jobs"],
    },
    useDramaSummary: (projectId: string) => useQuery({ queryKey: summaryKey(projectId), queryFn: async () => summaries.get(projectId)! }),
    useDramaCast: () => ({ cast: [], isLoading: false, refetch: async () => ({ data: [] }) }),
}));
const dramaApi = await import("@/services/api/drama");
mock.module("@/services/api/drama", () => ({
    ...dramaApi,
    confirmDramaGuide: (projectId: string, input: { expectedStep: DramaGuideStep; expectedRevision: number; settings?: DramaSettings }) => {
        const pending = deferred<DramaSummary>();
        confirms.push({ projectId, input: structuredClone(input), pending });
        return pending.promise;
    },
    listDramaChapters: async (projectId: string) => ({ chapters: chapterTitles.map((title, index) => ({ id: `${projectId}-chapter${index ? `-${index + 1}` : ""}`, title, wordCount: 4, position: index + 1, reserved: false })) }),
    getDramaEpisode: async (projectId: string, episodeId: string) => ({ episode: { id: episodeId, number: 1, chapterIdsJson: JSON.stringify([`${projectId}-chapter`]) }, shots: [], segments: [] }),
    getDramaChapter: async (projectId: string, chapterId: string) => {
        chapterReads++;
        return { chapter: { id: chapterId, title: "第一章", sourceText: `${projectId}正文`, position: 1, wordCount: 4 } };
    },
    updateDramaChapter: (projectId: string, chapterId: string) => {
        const pending = deferred<{ chapter: { id: string; title: string; sourceText: string } }>();
        sourceSaves.push({ projectId, chapterId, pending });
        return pending.promise;
    },
    saveDramaGuideSource: async () => {
        throw new Error("本组回归不提交制作范围");
    },
    retryFailedDrama: async (projectId: string, episodeId?: string) => {
        scopedRetries.push({ projectId, episodeId });
        return { jobs: 0 };
    },
    retryDramaProjectText: async (projectId: string) => {
        projectTextRetries.push(projectId);
        return { jobs: 2 };
    },
    listDramaJobs: async () => ({ jobs: queueJobs }),
    updateDramaWorkflowStyle: (projectId: string, input: { expectedRevision: number; styleName: string; stylePrompt: string; drawing?: DramaDrawingConfiguration }) => {
        const pending = deferred<DramaSummary>();
        styleSaves.push({ projectId, input: structuredClone(input), pending });
        return pending.promise;
    },
    updateDramaSettings: (projectId: string, input: { expectedRevision?: number; settings?: DramaSettings }) => {
        const pending = deferred<DramaSummary>();
        configurationSaves.push({ projectId, input: structuredClone(input), pending });
        return pending.promise;
    },
    getDramaEpisodeStyle: async (projectId: string, episodeId: string) => {
        episodeStyleReads.push(`${userStore.getState().user.id}:${projectId}:${episodeId}`);
        if (episodeStyleReader) return episodeStyleReader(projectId, episodeId);
        const key = `${projectId}:${episodeId}`;
        const saved = episodeStyles.get(key) || makeEpisodeStyle(projectId, episodeId);
        episodeStyles.set(key, saved);
        return { ...saved, revision: summaries.get(projectId)!.production.revision };
    },
    updateDramaEpisodeStyle: (projectId: string, episodeId: string, input: UpdateDramaEpisodeStyleRequest) => {
        const pending = deferred<DramaEpisodeStyle>();
        episodeStyleSaves.push({ projectId, episodeId, input: structuredClone(input), pending });
        return pending.promise;
    },
}));

const { default: WorkflowPage } = await import("@/pages/projects/workflow");
const { isAdvancedDramaStudio } = await import("@/pages/projects/studio/studio-route");
function Host() {
    const [search] = useSearchParams();
    return isAdvancedDramaStudio(search) ? <p>详细制作台</p> : <WorkflowPage />;
}
function makeSummary(projectId: string, stage: DramaGuideStep = "configuring", revision = 1): DramaSummary {
    return {
        project: { id: projectId, name: projectId, userId: "user-a", sourceType: "novel" },
        production: {
            guideStep: stage,
            revision,
            chapterCount: 1,
            reservedChapterCount: 0,
            planDone: true,
            status: "draft",
            settings: {
                styleName: "原始风格",
                stylePrompt: "原始提示",
                aspectRatio: "9:16",
                language: "中文",
                models: { text: {}, image: {}, video: {} },
                assets: { mode: "custom", characterPrompt: "原始角色模板", scenePrompt: "原始场景模板", characterRatio: "16:9" },
            },
        },
        guide: { step: stage, canConfirm: true, blockingReason: "" },
        episodes: [],
        jobCounts: {},
    } as unknown as DramaSummary;
}
function makeEpisodeStyle(projectId: string, episodeId: string): DramaEpisodeStyle {
    const summary = summaries.get(projectId)!;
    return {
        projectId,
        episodeId,
        revision: summary.production.revision,
        episodeRevision: 3,
        settings: structuredClone(summary.production.settings),
    };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
async function mount(path = "/projects/project-a/guide?step=review", strict = false) {
    notices.length = 0;
    confirms.length = 0;
    sourceSaves.length = 0;
    styleSaves.length = 0;
    configurationSaves.length = 0;
    episodeStyleSaves.length = 0;
    episodeStyleReads.length = 0;
    castImageRequests.length = 0;
    modeConfigurationWrites.length = 0;
    projectTextRetries.length = 0;
    scopedRetries.length = 0;
    chapterTitles = ["第一章"];
    episodeStyles.clear();
    episodeStyleReader = undefined;
    queueJobs = [];
    chapterReads = 0;
    videoOptions = [];
    summaries.clear();
    summaries.set("project-a", makeSummary("project-a"));
    summaries.set("project-b", makeSummary("project-b"));
    userStore.setState({ user: { id: "user-a" } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const router = createMemoryRouter(
        [
            { path: "/projects/:projectId/guide", element: <Host /> },
            { path: "/projects/:projectId/e/:episodeId", element: <Host /> },
            { path: "/projects/:projectId", element: <Host /> },
            { path: "/outside", element: <p>外部页面</p> },
        ],
        { initialEntries: [path] },
    );
    const content = (
        <QueryClientProvider client={query}>
            <RouterProvider router={router} />
        </QueryClientProvider>
    );
    await act(async () => {
        root.render(strict ? <StrictMode>{content}</StrictMode> : content);
        await settle();
    });
    for (let turn = 0; turn < 4; turn++)
        await act(async () => {
            await settle();
        });
    return {
        host,
        router,
        query,
        go: async (next: string) => {
            await act(async () => {
                await router.navigate(next);
                await settle();
            });
        },
        close: async () => {
            await act(async () => root.unmount());
            router.dispose();
            query.clear();
            host.remove();
        },
    };
}
function button(host: HTMLElement, text: string) {
    const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.includes(text));
    if (!found) throw new Error(`没有按钮 ${text}`);
    return found;
}
async function click(element: HTMLElement) {
    await act(async () => {
        element.click();
        await settle();
    });
}
async function fill(host: HTMLElement, label: string, value: string) {
    const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
    const prototype = input.tagName === "SELECT" ? browser.HTMLSelectElement.prototype : input.tagName === "TEXTAREA" ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype;
    await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new browser.Event("input", { bubbles: true }));
        input.dispatchEvent(new browser.Event("change", { bubbles: true }));
        await settle();
    });
}
afterAll(() => browser.happyDOM.abort());

test("StrictMode 挂载真实正文组件，脏状态回调稳定且初始内容可继续", async () => {
    const mounted = await mount(undefined, true);
    try {
        expect(mounted.host.querySelector<HTMLTextAreaElement>('[aria-label="章节正文"]')?.value).toBe("project-a正文");
        expect(chapterReads).toBeLessThanOrEqual(2);
        expect(mounted.host.textContent).not.toContain("下一步：风格设置");
        expect(mounted.host.querySelector(".drama-root")).not.toBeNull();
    } finally {
        await mounted.close();
    }
});

test("正文草稿阻止切步和外部路由离开，继续编辑保留草稿并拦截刷新", async () => {
    const mounted = await mount();
    try {
        await fill(mounted.host, "章节正文", "尚未保存的正文");
        expect(mounted.host.textContent).not.toContain("下一步：风格设置");
        await click(button(mounted.host, "风格设置"));
        expect(mounted.router.state.location.search).toBe("?step=review");
        expect(notices.at(-1)?.text).toContain("先保存");
        const event = new browser.Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        await mounted.go("/outside");
        expect(mounted.host.querySelector('[role="dialog"]')).not.toBeNull();
        await click(button(mounted.host, "继续编辑"));
        expect(mounted.router.state.location.pathname).toBe("/projects/project-a/guide");
        expect(mounted.host.querySelector<HTMLTextAreaElement>('[aria-label="章节正文"]')?.value).toBe("尚未保存的正文");
    } finally {
        await mounted.close();
    }
});

test("明确放弃正文修改后才离开当前作品", async () => {
    const mounted = await mount();
    try {
        await fill(mounted.host, "章节正文", "准备放弃的修改");
        await mounted.go("/outside");
        expect(mounted.router.state.location.pathname).toBe("/projects/project-a/guide");
        await click(button(mounted.host, "放弃修改并离开"));
        expect(mounted.router.state.location.pathname).toBe("/outside");
        expect(mounted.host.textContent).toBe("外部页面");
    } finally {
        await mounted.close();
    }
});

test("配置草稿在同作品回看步骤时保留，详细制作台入口提示先保存", async () => {
    const mounted = await mount("/projects/project-a/guide?step=style");
    try {
        await fill(mounted.host, "风格配置", "我选择的风格");
        expect(mounted.host.querySelector('[role="menuitem"]')).toBeNull();
        await click(button(mounted.host, "更多"));
        await click(button(mounted.host, "高级制作台"));
        expect(mounted.router.state.location.pathname).toBe("/projects/project-a/guide");
        expect(notices.at(-1)?.text).toContain("先保存或放弃");
        await click(button(mounted.host, "剧本格式"));
        await click(button(mounted.host, "风格设置"));
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("我选择的风格");
        await mounted.go("/outside");
        expect(mounted.host.querySelector('[role="dialog"]')).not.toBeNull();
    } finally {
        await mounted.close();
    }
});

test("同路径显式或隐式切换详细模式也保护草稿，不能绕过路由拦截", async () => {
    for (const entry of [
        { from: "?mode=simple&step=style", to: "?mode=advanced&step=style", label: "风格配置" },
        { from: "?mode=simple&step=review", to: "?mode=advanced&step=review", label: "章节正文" },
        { from: "?step=style", to: "?step=style&view=settings", label: "风格配置" },
    ]) {
        const mounted = await mount(`/projects/project-a${entry.from}`);
        try {
            await fill(mounted.host, entry.label, "同路径草稿");
            await mounted.go(`/projects/project-a${entry.to}`);
            expect(mounted.router.state.location.search).toBe(entry.from);
            expect(mounted.host.querySelector('[role="dialog"]')).not.toBeNull();
            await click(button(mounted.host, "继续编辑"));
            expect(mounted.host.querySelector<HTMLInputElement>(`[aria-label="${entry.label}"]`)?.value).toBe("同路径草稿");
        } finally {
            await mounted.close();
        }
    }
});

test("正文保存进行中同样阻止离开，允许明确离开且迟到结果不污染新页面", async () => {
    const mounted = await mount();
    try {
        await fill(mounted.host, "章节正文", "正在保存正文");
        await click(button(mounted.host, "保存本章"));
        expect(sourceSaves).toHaveLength(1);
        await mounted.go("/outside");
        expect(mounted.host.querySelector('[role="dialog"]')).not.toBeNull();
        await click(button(mounted.host, "放弃修改并离开"));
        const count = notices.length;
        await act(async () => {
            sourceSaves[0].pending.resolve({ chapter: { id: "project-a-chapter", title: "第一章", sourceText: "正在保存正文" } });
            await settle();
        });
        expect(mounted.router.state.location.pathname).toBe("/outside");
        expect(notices).toHaveLength(count);
    } finally {
        await mounted.close();
    }
});

test("确认配置复用 CAS 并进入资产步骤，不触发媒体生成", async () => {
    const mounted = await mount("/projects/project-a/guide?step=style&scope=all");
    try {
        await fill(mounted.host, "风格配置", "确认的风格");
        await click(button(mounted.host, "下一步：角色场景"));
        expect(confirms).toHaveLength(1);
        expect(confirms[0]).toMatchObject({ projectId: "project-a", input: { expectedStep: "configuring", expectedRevision: 1, settings: { styleName: "确认的风格" } } });
        const next = makeSummary("project-a", "assets", 2);
        summaries.set("project-a", next);
        await act(async () => {
            confirms[0].pending.resolve(next);
            await settle();
        });
        expect(new URLSearchParams(mounted.router.state.location.search).get("step")).toBe("assets");
        expect(new URLSearchParams(mounted.router.state.location.search).get("scope")).toBe("all");
        expect(mounted.host.textContent).toContain("主体资产列表");
    } finally {
        await mounted.close();
    }
});

test("配置确认进行中点击回看正文，不应把成功推进误拦成未保存修改", async () => {
    const mounted = await mount("/projects/project-a/guide?step=style");
    try {
        await click(button(mounted.host, "下一步：角色场景"));
        await click(button(mounted.host, "剧本格式"));
        const next = makeSummary("project-a", "assets", 2);
        summaries.set("project-a", next);
        await act(async () => {
            confirms[0].pending.resolve(next);
            await settle();
        });
        expect(new URLSearchParams(mounted.router.state.location.search).get("step")).toBe("assets");
        expect(mounted.host.querySelector('[role="dialog"]')).toBeNull();
    } finally {
        await mounted.close();
    }
});

test("资产确认时子组件回报父层忙状态，不应拦截确认成功后进入分镜", async () => {
    const mounted = await mount("/projects/project-a/guide?step=assets");
    try {
        const assets = makeSummary("project-a", "assets", 2);
        summaries.set("project-a", assets);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), assets);
            await settle();
        });
        await click(button(mounted.host, "编排剧本"));
        expect(confirms).toHaveLength(0);
        await click(button(mounted.host, "确认分镜模式"));
        expect(confirms[0]).toMatchObject({ input: { expectedStep: "assets", expectedRevision: 2 } });
        const next = makeSummary("project-a", "story", 3);
        summaries.set("project-a", next);
        await act(async () => {
            confirms[0].pending.resolve(next);
            await settle();
        });
        expect(new URLSearchParams(mounted.router.state.location.search).get("step")).toBe("story");
        expect(mounted.host.querySelector('[role="dialog"]')).toBeNull();
    } finally {
        await mounted.close();
    }
});

test("作品切换后上一作品的迟到确认不会导航或修改当前作品缓存", async () => {
    const mounted = await mount("/projects/project-a/guide?step=style");
    try {
        await click(button(mounted.host, "下一步：角色场景"));
        await mounted.go("/projects/project-b/guide?step=style");
        const count = notices.length;
        await act(async () => {
            confirms[0].pending.resolve(makeSummary("project-a", "assets", 2));
            await settle();
        });
        expect(mounted.router.state.location.pathname).toBe("/projects/project-b/guide");
        expect(mounted.router.state.location.search).toBe("?step=style");
        expect(mounted.query.getQueryData<DramaSummary>(summaryKey("project-b"))?.project.id).toBe("project-b");
        expect(notices).toHaveLength(count);
    } finally {
        await mounted.close();
    }
});

test("账号切换后迟到确认不会推进新账号的页面或发送成功提示", async () => {
    const mounted = await mount("/projects/project-a/guide?step=style");
    try {
        await click(button(mounted.host, "下一步：角色场景"));
        expect(confirms).toHaveLength(1);
        await act(async () => {
            userStore.setState({ user: { id: "user-b" } });
            await settle();
        });
        const count = notices.length;
        await act(async () => {
            confirms[0].pending.resolve(makeSummary("project-a", "assets", 2));
            await settle();
        });
        expect(mounted.router.state.location.search).toBe("?step=style");
        expect(notices).toHaveLength(count);
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("原始风格");
    } finally {
        await mounted.close();
    }
});

test("资产方案的未保存状态接入主壳，阻止确认和离开直到还原", async () => {
    const mounted = await mount("/projects/project-a/guide?step=assets");
    try {
        const assets = makeSummary("project-a", "assets", 2);
        summaries.set("project-a", assets);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), assets);
            await settle();
        });
        expect(button(mounted.host, "编排剧本").disabled).toBe(false);
        await click(button(mounted.host, "编辑资产方案"));
        expect(button(mounted.host, "编排剧本").disabled).toBe(true);
        await click(button(mounted.host, "风格设置"));
        expect(new URLSearchParams(mounted.router.state.location.search).get("step")).toBe("assets");
        await mounted.go("/outside");
        expect(mounted.host.querySelector('[role="dialog"]')).not.toBeNull();
        await click(button(mounted.host, "继续编辑"));
        await click(button(mounted.host, "还原资产方案"));
        expect(button(mounted.host, "编排剧本").disabled).toBe(false);
    } finally {
        await mounted.close();
    }
});

test("完整目录中的待制作集直接进入主流程，不要求选章或自动启动制作", async () => {
    const mounted = await mount("/projects/project-a/guide?step=story");
    try {
        const data = makeSummary("project-a", "story", 2);
        data.production.chapterCount = 9;
        data.episodes = Array.from({ length: 9 }, (_, index) => ({ id: `episode-${index + 1}`, number: index + 1, title: `第 ${index + 1} 集`, stage: index < 2 ? "prompts" : "draft" })) as DramaSummary["episodes"];
        summaries.set("project-a", data);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), data);
            await settle();
        });
        expect(mounted.host.querySelector('[aria-label="分镜页分集目录"]')?.textContent?.split(",")).toHaveLength(9);
        expect(mounted.host.textContent).not.toContain("继续选章");
        expect(mounted.host.querySelector('[role="dialog"]')).toBeNull();
        expect(button(mounted.host, "完成分镜编排").disabled).toBe(false);
        await mounted.go("/projects/project-a");
        expect(mounted.host.querySelector('[aria-label="管理页分集目录"]')?.textContent?.split(",")).toHaveLength(9);
        expect(mounted.host.textContent).not.toContain("继续选章");
        await mounted.go("/projects/project-a?step=assets");
        expect(mounted.host.textContent).not.toContain("继续选章");
        expect(confirms).toHaveLength(0);
        expect(sourceSaves).toHaveLength(0);
        expect(projectTextRetries).toHaveLength(0);
        expect(scopedRetries).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("刷新摘要补齐全部剧集时保留当前步骤、筛选与已有分集缓存", async () => {
    const mounted = await mount("/projects/project-a/guide?step=story&status=failed&scope=all");
    try {
        const data = makeSummary("project-a", "story", 2);
        data.production.reservedChapterCount = 7;
        data.episodes = [
            { id: "episode-a", number: 1, title: "第一集" },
            { id: "episode-b", number: 2, title: "第二集" },
        ] as DramaSummary["episodes"];
        summaries.set("project-a", data);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), data);
            mounted.query.setQueryDefaults(["drama", "project-a", "episode"], { gcTime: Infinity });
            mounted.query.setQueryDefaults(["drama", "project-a", "chapters"], { gcTime: Infinity });
            mounted.query.setQueryData(["drama", "project-a", "episode", "episode-a"], { old: true });
            mounted.query.setQueryData(["drama", "project-a", "episode", "episode-b"], { old: true });
            mounted.query.setQueryData(["drama", "project-a", "chapters"], { old: true });
            await settle();
        });
        const next = {
            ...data,
            production: { ...data.production, revision: 3, chapterCount: 9, reservedChapterCount: 0 },
            episodes: [...data.episodes, ...Array.from({ length: 7 }, (_, index) => ({ id: `episode-new-${index + 3}`, number: index + 3, title: `第 ${index + 3} 集`, stage: "draft" }))] as DramaSummary["episodes"],
        };
        summaries.set("project-a", next);
        await act(async () => {
            await mounted.query.invalidateQueries({ queryKey: summaryKey("project-a"), exact: true });
            await settle();
        });
        expect(mounted.query.getQueryData(summaryKey("project-a"))).toEqual(next);
        expect(mounted.host.querySelector('[aria-label="分镜页分集目录"]')?.textContent?.split(",")).toHaveLength(9);
        expect(mounted.query.getQueryData(["drama", "project-a", "episode", "episode-a"])).toEqual({ old: true });
        expect(mounted.query.getQueryData(["drama", "project-a", "episode", "episode-b"])).toEqual({ old: true });
        expect(mounted.host.textContent).not.toContain("继续选章");
        expect(mounted.router.state.location.search).toBe("?step=story&status=failed&scope=all");
        expect(confirms).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("已有集默认进入分集管理，显式步骤单集链接与未确认配置保留创作流程", async () => {
    const mounted = await mount("/projects/project-a");
    try {
        const data = makeSummary("project-a", "story", 2);
        data.episodes = [{ id: "episode-a", number: 1, title: "序章" }] as DramaSummary["episodes"];
        data.production.chapterCount = 1;
        summaries.set("project-a", data);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), data);
            await settle();
        });
        expect(mounted.host.textContent).toContain("分集管理列表");
        expect(mounted.host.querySelector(".drama-workflow-body")?.classList.contains("is-production")).toBe(false);
        expect(mounted.host.textContent).not.toContain("继续选章");
        await mounted.go("/projects/project-a?step=assets");
        expect(mounted.host.textContent).toContain("主体资产列表");
        expect(mounted.host.textContent).not.toContain("分集管理列表");
        await mounted.go("/projects/project-a/e/episode-a");
        expect(mounted.host.textContent).toContain("分镜制作 project-a");
        expect(mounted.host.querySelector(".drama-workflow-body")?.classList.contains("is-production")).toBe(true);
        expect(mounted.host.textContent).not.toContain("分集管理列表");
        const configuring = { ...data, guide: { step: "configuring" as const, canConfirm: true }, production: { ...data.production, guideStep: "configuring" as const } };
        summaries.set("project-a", configuring);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), configuring);
            await settle();
        });
        await mounted.go("/projects/project-a");
        expect(mounted.host.querySelector('[aria-label="章节正文"]')).not.toBeNull();
        expect(mounted.host.textContent).not.toContain("分集管理列表");
    } finally {
        await mounted.close();
    }
});

test("无显式步骤的query集与媒体深链保留制作页，不被默认分集管理覆盖", async () => {
    for (const search of ["?episode=episode-a", "?episode=episode-a&editor=media&shot=shot-a&segment=0"]) {
        const mounted = await mount(`/projects/project-a${search}`);
        try {
            const data = makeSummary("project-a", "story", 2);
            data.episodes = [{ id: "episode-a", number: 1, title: "序章" }] as DramaSummary["episodes"];
            summaries.set("project-a", data);
            await act(async () => {
                mounted.query.setQueryData(summaryKey("project-a"), data);
                await settle();
            });
            expect(mounted.host.textContent).toContain("分镜制作 project-a");
            expect(mounted.host.textContent).not.toContain("分集管理列表");
            expect(mounted.router.state.location.pathname).toBe("/projects/project-a");
            expect(mounted.router.state.location.search).toBe(search);
            expect(confirms).toHaveLength(0);
        } finally {
            await mounted.close();
        }
    }
});

test("同路径query切集保护未保存资产草稿，明确还原后才切换当前集", async () => {
    const mounted = await mount("/projects/project-a/guide?step=assets&episode=episode-a");
    try {
        const assets = makeSummary("project-a", "assets", 2);
        summaries.set("project-a", assets);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), assets);
            await settle();
        });
        expect(mounted.host.querySelector('[aria-label="当前主体集"]')?.textContent).toBe("episode-a");
        await click(button(mounted.host, "编辑资产方案"));
        await mounted.go("/projects/project-a/guide?step=assets&episode=episode-b");
        expect(mounted.router.state.location.search).toBe("?step=assets&episode=episode-a");
        expect(mounted.host.querySelector('[role="dialog"]')).not.toBeNull();
        expect(mounted.host.querySelector('[aria-label="当前主体集"]')?.textContent).toBe("episode-a");
        await click(button(mounted.host, "继续编辑"));
        await click(button(mounted.host, "还原资产方案"));
        await mounted.go("/projects/project-a/guide?step=assets&episode=episode-b");
        expect(mounted.router.state.location.search).toBe("?step=assets&episode=episode-b");
        expect(mounted.host.querySelector('[aria-label="当前主体集"]')?.textContent).toBe("episode-b");
        expect(mounted.host.querySelector('[role="dialog"]')).toBeNull();
    } finally {
        await mounted.close();
    }
});

test("主体管理选集回调进入真实单集资产路由并移除旧query集ID", async () => {
    const mounted = await mount("/projects/project-a/guide?step=assets&episode=episode-a&scope=all");
    try {
        const assets = makeSummary("project-a", "assets", 2);
        summaries.set("project-a", assets);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), assets);
            await settle();
        });
        await click(button(mounted.host, "生成当前选集主体"));
        expect(castImageRequests).toEqual([{ castId: "shared-cast", episodeId: "episode-b" }]);
        await click(button(mounted.host, "切换主体到第二集"));
        expect(mounted.router.state.location.pathname).toBe("/projects/project-a/e/episode-b");
        const search = new URLSearchParams(mounted.router.state.location.search);
        expect(search.get("step")).toBe("assets");
        expect(search.get("scope")).toBe("all");
        expect(search.has("episode")).toBe(false);
        expect(search.has("manage")).toBe(false);
        expect(mounted.host.querySelector('[aria-label="当前主体集"]')?.textContent).toBe("episode-b");
        await act(async () => {
            await settle();
        });
        await click(button(mounted.host, "生成页面所属主体"));
        expect(castImageRequests).toEqual([
            { castId: "shared-cast", episodeId: "episode-b" },
            { castId: "shared-cast", episodeId: "episode-b" },
        ]);
        expect(mounted.host.querySelector('[role="dialog"]')).toBeNull();
        expect(confirms).toHaveLength(0);
        expect(styleSaves).toHaveLength(0);
        expect(sourceSaves).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("服务端 revision 更新保留本地配置草稿，重新载入后再允许确认", async () => {
    const mounted = await mount("/projects/project-a/guide?step=style");
    try {
        await fill(mounted.host, "风格配置", "不能静默覆盖的风格");
        const updated = makeSummary("project-a", "configuring", 2);
        updated.production.settings.styleName = "其他设备保存的风格";
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), updated);
            await settle();
        });
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("不能静默覆盖的风格");
        expect(mounted.host.textContent).toContain("服务端配置已更新");
        await click(button(mounted.host, "重新载入配置"));
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("其他设备保存的风格");
        expect(button(mounted.host, "下一步：角色场景").disabled).toBe(false);
    } finally {
        await mounted.close();
    }
});

test("已完成流程 CAS 保存风格后进入角色场景，保留阶段、集和模型", async () => {
    const mounted = await mount("/projects/project-a/guide?step=style");
    try {
        const completed = makeSummary("project-a", "completed", 7);
        summaries.set("project-a", completed);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), completed);
            await settle();
        });
        expect(mounted.host.querySelector('[aria-label="风格配置"]')?.getAttribute("data-style-only")).toBe("true");
        expect(mounted.host.textContent).toContain("真实风格影响范围");
        await fill(mounted.host, "风格配置", "后续采用的风格");
        await click(button(mounted.host, "保存并继续"));
        expect(styleSaves[0]).toMatchObject({ projectId: "project-a", input: { expectedRevision: 7, styleName: "后续采用的风格", stylePrompt: "原始提示" } });
        expect(Object.keys(styleSaves[0].input).sort()).toEqual(["expectedRevision", "styleName", "stylePrompt"]);
        const next = makeSummary("project-a", "completed", 8);
        next.production.settings.styleName = "后续采用的风格";
        summaries.set("project-a", next);
        await act(async () => {
            styleSaves[0].pending.resolve(next);
            await settle();
        });
        expect(confirms).toHaveLength(0);
        expect(mounted.router.state.location.search).toBe("?step=assets");
        expect(mounted.query.getQueryData<DramaSummary>(summaryKey("project-a"))?.production.guideStep).toBe("completed");
    } finally {
        await mounted.close();
    }
});

test("风格保存失败保留草稿，未保存时拦截切步和外部路由", async () => {
    const mounted = await mount("/projects/project-a/guide?step=style");
    try {
        const completed = makeSummary("project-a", "completed", 7);
        summaries.set("project-a", completed);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), completed);
            await settle();
        });
        await fill(mounted.host, "风格配置", "保存失败也要保留");
        await click(button(mounted.host, "保存并继续"));
        await act(async () => {
            styleSaves[0].pending.reject(new Error("暂时不能保存"));
            await settle();
        });
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("保存失败也要保留");
        await click(button(mounted.host, "漫剧分镜"));
        expect(mounted.router.state.location.search).toBe("?step=style");
        await mounted.go("/projects/project-a/guide?step=story");
        expect(mounted.host.querySelector('[role="dialog"]')).not.toBeNull();
        await click(button(mounted.host, "继续编辑"));
        await click(button(mounted.host, "放弃修改"));
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("原始风格");
    } finally {
        await mounted.close();
    }
});

test("风格迟到响应不覆盖更新 revision，账号切换后不提示成功", async () => {
    const mounted = await mount("/projects/project-a/guide?step=style");
    try {
        const completed = makeSummary("project-a", "completed", 7);
        summaries.set("project-a", completed);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), completed);
            await settle();
        });
        await fill(mounted.host, "风格配置", "保存中的风格");
        await click(button(mounted.host, "保存并继续"));
        const newer = makeSummary("project-a", "completed", 10);
        newer.production.settings.styleName = "最新风格";
        summaries.set("project-a", newer);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), newer);
            styleSaves[0].pending.resolve(makeSummary("project-a", "completed", 8));
            await settle();
        });
        expect(mounted.query.getQueryData<DramaSummary>(summaryKey("project-a"))?.production.revision).toBe(10);
        await click(button(mounted.host, "重新载入配置"));
        await mounted.go("/projects/project-a/guide?step=style");
        await fill(mounted.host, "风格配置", "另一次保存");
        await click(button(mounted.host, "保存并继续"));
        await act(async () => {
            userStore.setState({ user: { id: "user-b" } });
            await settle();
        });
        const count = notices.length;
        await act(async () => {
            styleSaves[1].pending.resolve(makeSummary("project-a", "completed", 11));
            await settle();
        });
        expect(notices).toHaveLength(count);
        expect(mounted.query.getQueryData<DramaSummary>(summaryKey("project-a"))?.production.revision).toBe(10);
    } finally {
        await mounted.close();
    }
});

test("仅历史媒体失败不展示文字重试，当前资产提取失败才可重试文字", async () => {
    const mounted = await mount("/projects/project-a/guide?step=assets");
    try {
        const assets = makeSummary("project-a", "assets", 7);
        assets.production.stage = "produce";
        assets.jobCounts.failed = 5;
        assets.inbox = [{ id: "video-failed", kind: "segment_failed", media: "video", severity: "error", title: "视频失败", detail: "视频失败", segmentIndex: 0 }];
        summaries.set("project-a", assets);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), assets);
            await settle();
        });
        expect(mounted.host.textContent).not.toContain("重试失败的文字任务");
        const extraction = structuredClone(assets);
        extraction.production.stage = "bible";
        queueJobs = [{ id: "bible-failed", kind: "bible", status: "failed", createdAt: "2026-01-01" }];
        summaries.set("project-a", extraction);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), extraction);
            await settle();
        });
        await act(async () => {
            await settle();
        });
        expect(mounted.host.textContent).toContain("重试失败的文字任务");
    } finally {
        await mounted.close();
    }
});

test("资产提取失败的重试使用作品文字接口，不提交空集或重试媒体", async () => {
    const mounted = await mount("/projects/project-a/guide?step=assets");
    try {
        const assets = makeSummary("project-a", "assets", 7);
        assets.production.stage = "bible";
        queueJobs = [{ id: "bible-failed", kind: "bible", status: "failed", createdAt: "2026-01-01" }];
        summaries.set("project-a", assets);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), assets);
            await settle();
        });
        await act(settle);
        await click(button(mounted.host, "重试失败的文字任务"));
        expect(projectTextRetries).toEqual(["project-a"]);
        expect(scopedRetries).toEqual([]);
        expect(notices.some((notice) => notice.text === "已重新排队 2 项文字任务")).toBe(true);
    } finally {
        await mounted.close();
    }
});

test("query选集和单集路由的剧本都仅展示本集章节，作品管理仍展示全剧", async () => {
    for (const [path, expected] of [
        ["/projects/project-a/e/episode-a?step=review", ["第一章"]],
        ["/projects/project-a/guide?step=review&episode=episode-a", ["第一章"]],
        ["/projects/project-a/guide?manage=script&episode=episode-a", ["第一章", "第二章"]],
    ] as const) {
        const mounted = await mount(path);
        try {
            chapterTitles = ["第一章", "第二章"];
            const completed = makeSummary("project-a", "completed", 7);
            summaries.set("project-a", completed);
            await act(async () => {
                mounted.query.setQueryData(summaryKey("project-a"), completed);
                await mounted.query.invalidateQueries({ queryKey: ["drama", "project-a", "chapters"] });
                await settle();
            });
            const titles = Array.from(mounted.host.querySelectorAll('[role="option"] strong')).map((item) => item.textContent);
            expect(titles).toEqual([...expected]);
        } finally {
            await mounted.close();
        }
    }
});

test("同一步的媒体查询导航保护草稿，已确认切镜只放行一次精确目标", async () => {
    const mounted = await mount("/projects/project-a/guide?step=story&editor=media&episode=episode-a&shot=shot-a");
    try {
        const completed = makeSummary("project-a", "completed", 7);
        summaries.set("project-a", completed);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), completed);
            await settle();
        });
        await click(button(mounted.host, "编辑镜头配置"));
        await mounted.go("/projects/project-a/guide?step=story&editor=media&episode=episode-a&shot=shot-b");
        expect(mounted.host.querySelector('[role="dialog"]')).not.toBeNull();
        expect(mounted.router.state.location.search).toContain("shot=shot-a");
        await click(button(mounted.host, "继续编辑"));
        await click(button(mounted.host, "已确认切换镜头"));
        expect(mounted.router.state.location.pathname).toBe("/projects/project-a/e/episode-a");
        expect(mounted.router.state.location.search).toBe("?step=story&editor=media&shot=shot-b");
        expect(mounted.host.querySelector('[role="dialog"]')).toBeNull();
        await click(button(mounted.host, "编辑镜头配置"));
        await mounted.go("/projects/project-a/e/episode-a?step=preview");
        expect(mounted.host.querySelector('[role="dialog"]')).not.toBeNull();
        expect(mounted.router.state.location.search).toContain("shot=shot-b");
        await click(button(mounted.host, "继续编辑"));
    } finally {
        await mounted.close();
    }
});

test("单镜生成配置自动同步期间离开不弹确认，同步完成继续原导航", async () => {
    const mounted = await mount("/projects/project-a/guide?step=story&editor=media&episode=episode-a&shot=shot-a");
    try {
        const completed = makeSummary("project-a", "completed", 7);
        summaries.set("project-a", completed);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), completed);
            await settle();
        });
        await click(button(mounted.host, "修改镜头生成参数"));
        await mounted.go("/outside");
        expect(mounted.host.querySelector('[role="dialog"]')).toBeNull();
        expect(mounted.router.state.location.pathname).not.toBe("/outside");
        await click(button(mounted.host, "配置自动同步完成"));
        expect(mounted.router.state.location.pathname).toBe("/outside");
    } finally {
        await mounted.close();
    }
});

test("单镜配置同步失败保留当前页面，允许继续修正而不静默离开", async () => {
    const mounted = await mount("/projects/project-a/guide?step=story&editor=media&episode=episode-a&shot=shot-a");
    try {
        const completed = makeSummary("project-a", "completed", 7);
        summaries.set("project-a", completed);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), completed);
            await settle();
        });
        await click(button(mounted.host, "修改镜头生成参数"));
        await mounted.go("/outside");
        await click(button(mounted.host, "配置自动同步失败"));
        expect(mounted.router.state.location.pathname).not.toBe("/outside");
        await click(button(mounted.host, "继续编辑"));
        expect(mounted.host.textContent).toContain("分镜制作");
    } finally {
        await mounted.close();
    }
});

test("单镜生成回执未确认时外部导航显示离开确认，保留编辑或明确离开", async () => {
    const mounted = await mount("/projects/project-a/guide?step=story&editor=media&episode=episode-a&shot=shot-a");
    try {
        const completed = makeSummary("project-a", "completed", 7);
        summaries.set("project-a", completed);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), completed);
            await settle();
        });
        await click(button(mounted.host, "生成提交回执未确认"));
        await mounted.go("/outside");
        expect(mounted.host.querySelector('[role="dialog"]')).not.toBeNull();
        expect(mounted.router.state.location.pathname).not.toBe("/outside");
        await click(button(mounted.host, "继续编辑"));
        expect(mounted.host.textContent).toContain("分镜制作");
        await mounted.go("/outside");
        await click(button(mounted.host, "放弃修改并离开"));
        expect(mounted.router.state.location.pathname).toBe("/outside");
    } finally {
        await mounted.close();
    }
});

test("单集五步进入作品管理后内部推进留在四页，选择分集始终回列表", async () => {
    const mounted = await mount("/projects/project-a/e/episode-a?step=review&segment=old-segment&shot=old-shot&editor=media");
    try {
        const steps = mounted.host.querySelector('[aria-label="短剧制作步骤"]');
        expect(steps?.textContent).toContain("分集剧本");
        expect(steps?.textContent).not.toContain("上传剧本");
        expect(steps?.querySelectorAll("button")).toHaveLength(5);
        await click(button(mounted.host, "作品管理"));
        expect(mounted.router.state.location.pathname).toBe("/projects/project-a/guide");
        expect(mounted.router.state.location.search).toBe("?manage=episodes");
        const tabs = mounted.host.querySelector('[aria-label="作品管理"]');
        expect([...tabs!.querySelectorAll("button")].map((item) => item.textContent)).toEqual(["剧本设定", "风格设置", "主体资产", "分集管理"]);
        await click(button(mounted.host, "剧本设定"));
        expect(mounted.host.textContent).toContain("确认您的剧本，并选择单集剧本进行视频创作。");
        await click(button(mounted.host, "下一步：风格设置"));
        expect(mounted.router.state.location.search).toBe("?manage=style");
        await click(button(mounted.host, "选择分集"));
        expect(mounted.router.state.location.search).toBe("?manage=episodes");
        expect(mounted.host.querySelector('[aria-label="短剧制作步骤"]')).toBeNull();
        expect(mounted.host.textContent).toContain("分集管理列表");
    } finally {
        await mounted.close();
    }
});

test("本集直接编辑配置，双版本保存后只进入本集角色场景", async () => {
    const mounted = await mount("/projects/project-a/e/episode-a?step=style");
    try {
        const completed = makeSummary("project-a", "completed", 7);
        summaries.set("project-a", completed);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), completed);
            await settle();
        });
        await act(settle);
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.disabled).toBe(false);
        expect(mounted.host.querySelector('[aria-label="风格配置"]')?.getAttribute("data-style-only")).toBe("false");
        expect(mounted.host.querySelector('[aria-label="风格配置"]')?.getAttribute("data-scope")).toBe("episode");
        expect(mounted.host.textContent).not.toContain("沿用全剧默认");
        expect(mounted.host.textContent).not.toContain("本集独立风格");
        expect(mounted.host.textContent).not.toContain("真实风格影响范围");
        await fill(mounted.host, "风格配置", "仅本集的风格");
        await click(button(mounted.host, "保存并继续"));
        expect(episodeStyleSaves).toHaveLength(1);
        expect(episodeStyleSaves[0]).toMatchObject({ projectId: "project-a", episodeId: "episode-a", input: { expectedRevision: 7, expectedEpisodeRevision: 3, settings: { styleName: "仅本集的风格", stylePrompt: "原始提示" } } });
        expect(Object.keys(episodeStyleSaves[0].input).sort()).toEqual(["expectedEpisodeRevision", "expectedRevision", "settings"]);
        const next = makeSummary("project-a", "completed", 8);
        summaries.set("project-a", next);
        const saved = { ...makeEpisodeStyle("project-a", "episode-a"), episodeRevision: 4, settings: episodeStyleSaves[0].input.settings };
        episodeStyles.set("project-a:episode-a", saved);
        await act(async () => {
            episodeStyleSaves[0].pending.resolve(saved);
            await settle();
        });
        expect(mounted.router.state.location.pathname).toBe("/projects/project-a/e/episode-a");
        expect(mounted.router.state.location.search).toBe("?step=assets");
        expect(styleSaves).toHaveLength(0);
        expect(confirms).toHaveLength(0);
        expect(mounted.query.getQueryData<DramaSummary>(summaryKey("project-a"))?.production.settings.styleName).toBe("原始风格");
    } finally {
        await mounted.close();
    }
});

test("作品仍在配置时本集保存失败保留草稿并保护切步", async () => {
    const mounted = await mount("/projects/project-a/e/episode-a?step=style");
    try {
        await fill(mounted.host, "风格配置", "失败后保留的本集风格");
        await click(button(mounted.host, "保存并继续"));
        await act(async () => {
            episodeStyleSaves[0].pending.reject(new Error("本集保存暂时失败"));
            await settle();
        });
        expect(mounted.router.state.location.search).toBe("?step=style");
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("失败后保留的本集风格");
        await click(button(mounted.host, "分集剧本"));
        expect(mounted.router.state.location.search).toBe("?step=style");
        await mounted.go("/projects/project-a/e/episode-a?step=review");
        expect(mounted.host.querySelector('[role="dialog"]')).not.toBeNull();
        await click(button(mounted.host, "继续编辑"));
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("失败后保留的本集风格");
        expect(styleSaves).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("本集完整配置随双版本一次保存，允许清空画风并修改模型和制作参数", async () => {
    const mounted = await mount("/projects/project-a/e/episode-a?step=review");
    try {
        const saved = makeEpisodeStyle("project-a", "episode-a");
        saved.settings.styleName = "本集旧风格";
        saved.settings.language = "粤语";
        saved.settings.models.video = { logicalModelId: "episode-video" };
        episodeStyles.set("project-a:episode-a", saved);
        await act(async () => {
            await mounted.query.invalidateQueries({ queryKey: ["drama-episode-style"] });
            await settle();
        });
        await click(button(mounted.host, "风格设置"));
        await act(settle);
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("本集旧风格");
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="视频模型"]')?.value).toBe("episode-video");
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="对白语言"]')?.disabled).toBe(false);
        await fill(mounted.host, "对白语言", "日语");
        await fill(mounted.host, "视频模型", "episode-video-new");
        await fill(mounted.host, "风格配置", "");
        await fill(mounted.host, "风格说明", "");
        await click(button(mounted.host, "保存并继续"));
        expect(episodeStyleSaves[0].input).toEqual({
            expectedRevision: 1,
            expectedEpisodeRevision: 3,
            settings: { ...saved.settings, styleName: "", stylePrompt: "", language: "日语", models: { ...saved.settings.models, video: { logicalModelId: "episode-video-new" } } },
        });
        expect(styleSaves).toHaveLength(0);
        expect(mounted.query.getQueryData<DramaSummary>(summaryKey("project-a"))?.production.settings.language).toBe("中文");
    } finally {
        await mounted.close();
    }
});

test("本集绘图模板修改后自动同步，作品和其他集配置保持不变", async () => {
    const mounted = await mount("/projects/project-a/e/episode-a?step=style");
    try {
        expect(mounted.host.querySelector<HTMLSelectElement>('[aria-label="角色绘图模板"]')?.disabled).toBe(false);
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.disabled).toBe(false);
        const other = makeEpisodeStyle("project-a", "episode-b");
        episodeStyles.set("project-a:episode-b", other);
        await fill(mounted.host, "角色绘图模板", "closeup_fullbody");
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
            await settle();
        });
        expect(episodeStyleSaves).toHaveLength(1);
        const input = episodeStyleSaves[0].input;
        expect(input).toMatchObject({ expectedRevision: 1, expectedEpisodeRevision: 3, settings: { styleName: "原始风格", stylePrompt: "原始提示", assets: { mode: "closeup_fullbody" } } });
        expect(input.settings.models).toEqual({ text: {}, image: {}, video: {} });
        const next = makeSummary("project-a", "configuring", 2);
        summaries.set("project-a", next);
        const saved = { ...makeEpisodeStyle("project-a", "episode-a"), episodeRevision: 4, settings: input.settings };
        episodeStyles.set("project-a:episode-a", saved);
        await act(async () => {
            episodeStyleSaves[0].pending.resolve(saved);
            await settle();
        });
        const current = mounted.query.getQueryData<DramaSummary>(summaryKey("project-a"))!;
        expect(current.production.settings.assets.mode).toBe("custom");
        expect(current.production.settings.styleName).toBe("原始风格");
        expect(current.production.settings.models.video).toEqual({});
        expect(episodeStyles.get("project-a:episode-b")?.settings).toEqual(other.settings);
        expect(mounted.query.getQueryData<DramaEpisodeStyle>(["drama-episode-style", "user-a", "project-a", "episode-a", 2])?.settings.assets.mode).toBe("closeup_fullbody");
        expect(mounted.router.state.location.search).toBe("?step=style");
        await click(button(mounted.host, "继续：角色场景"));
        expect(mounted.router.state.location.search).toBe("?step=assets");
        expect(styleSaves).toHaveLength(0);
        expect(confirms).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("本集整组配置保存失败保留所有字段，并可继续修改", async () => {
    const mounted = await mount("/projects/project-a/e/episode-a?step=style");
    try {
        await fill(mounted.host, "角色绘图模板", "closeup_fullbody");
        await fill(mounted.host, "风格配置", "待保存的本集风格");
        await fill(mounted.host, "对白语言", "粤语");
        expect(mounted.host.querySelector<HTMLSelectElement>('[aria-label="角色绘图模板"]')?.value).toBe("closeup_fullbody");
        await click(button(mounted.host, "保存并继续"));
        expect(episodeStyleSaves[0].input).toMatchObject({ settings: { styleName: "待保存的本集风格", language: "粤语", assets: { mode: "closeup_fullbody" } } });
        await act(async () => {
            episodeStyleSaves[0].pending.reject(new Error("绘图配置保存暂时失败"));
            await settle();
        });
        expect(mounted.router.state.location.search).toBe("?step=style");
        expect(mounted.host.querySelector<HTMLSelectElement>('[aria-label="角色绘图模板"]')?.value).toBe("closeup_fullbody");
        expect(mounted.host.querySelector<HTMLSelectElement>('[aria-label="角色绘图模板"]')?.disabled).toBe(false);
        expect(notices.at(-1)?.text).toContain("绘图配置保存暂时失败");
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("待保存的本集风格");
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="对白语言"]')?.value).toBe("粤语");
        await fill(mounted.host, "角色绘图模板", "closeup_turnaround");
        expect(mounted.host.querySelector<HTMLSelectElement>('[aria-label="角色绘图模板"]')?.value).toBe("closeup_turnaround");
    } finally {
        await mounted.close();
    }
});

test("放弃本集配置修改恢复本集快照，无修改直接继续不提交", async () => {
    const mounted = await mount("/projects/project-a/e/episode-a?step=style");
    try {
        const completed = makeSummary("project-a", "completed");
        summaries.set("project-a", completed);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), completed);
            await settle();
        });
        await fill(mounted.host, "风格配置", "本集手工风格名称");
        await fill(mounted.host, "风格说明", "本集手工调整的色调与光线");
        await fill(mounted.host, "角色绘图模板", "closeup_fullbody");
        await fill(mounted.host, "对白语言", "英语");
        await click(button(mounted.host, "放弃修改"));
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("原始风格");
        expect(mounted.host.querySelector<HTMLTextAreaElement>('[aria-label="风格说明"]')?.value).toBe("原始提示");
        expect(mounted.host.querySelector<HTMLSelectElement>('[aria-label="角色绘图模板"]')?.value).toBe("custom");
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="对白语言"]')?.value).toBe("中文");
        await click(button(mounted.host, "继续：角色场景"));
        expect(mounted.router.state.location.search).toBe("?step=assets");
        expect(episodeStyleSaves).toHaveLength(0);
        expect(styleSaves).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("首次配置的视频参数自动保存，不推进流程或顺便提交文字草稿", async () => {
    const mounted = await mount("/projects/project-a/guide?step=style");
    try {
        await fill(mounted.host, "风格配置", "尚未确认的画风");
        await fill(mounted.host, "视频模型", "video-new");
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
            await settle();
        });
        expect(configurationSaves).toHaveLength(1);
        expect(configurationSaves[0].input).toMatchObject({ expectedRevision: 1, settings: { styleName: "原始风格", models: { video: { logicalModelId: "video-new" } } } });
        const saved = makeSummary("project-a", "configuring", 2);
        saved.production.settings = configurationSaves[0].input.settings!;
        summaries.set("project-a", saved);
        await act(async () => {
            configurationSaves[0].pending.resolve(saved);
            await settle();
        });
        expect(mounted.router.state.location.search).toBe("?step=style");
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("尚未确认的画风");
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="视频模型"]')?.value).toBe("video-new");
        expect(confirms).toHaveLength(0);
        expect(castImageRequests).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("本集生成参数自动保存保留文字草稿，后续文字保存使用同步后的双版本", async () => {
    const mounted = await mount("/projects/project-a/e/episode-a?step=style");
    try {
        await fill(mounted.host, "风格配置", "仍在编辑的风格");
        await fill(mounted.host, "视频模型", "episode-video-new");
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
            await settle();
        });
        expect(episodeStyleSaves).toHaveLength(1);
        expect(episodeStyleSaves[0].input.settings).toMatchObject({ styleName: "原始风格", models: { video: { logicalModelId: "episode-video-new" } } });
        const saved = { ...makeEpisodeStyle("project-a", "episode-a"), revision: 2, episodeRevision: 4, settings: episodeStyleSaves[0].input.settings };
        episodeStyles.set("project-a:episode-a", saved);
        summaries.set("project-a", makeSummary("project-a", "configuring", 2));
        await act(async () => {
            episodeStyleSaves[0].pending.resolve(saved);
            await settle();
        });
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("仍在编辑的风格");
        await click(button(mounted.host, "保存并继续"));
        expect(episodeStyleSaves[1].input).toMatchObject({ expectedRevision: 2, expectedEpisodeRevision: 4, settings: { styleName: "仍在编辑的风格", models: { video: { logicalModelId: "episode-video-new" } } } });
    } finally {
        await mounted.close();
    }
});

test("只有生成参数变化时离开会先自动同步，不弹出放弃确认", async () => {
    const mounted = await mount("/projects/project-a/e/episode-a?step=style");
    try {
        await fill(mounted.host, "角色绘图模板", "closeup_fullbody");
        await mounted.go("/outside");
        await act(settle);
        expect(mounted.host.querySelector('[role="dialog"]')).toBeNull();
        expect(episodeStyleSaves).toHaveLength(1);
        const saved = { ...makeEpisodeStyle("project-a", "episode-a"), revision: 2, episodeRevision: 4, settings: episodeStyleSaves[0].input.settings };
        episodeStyles.set("project-a:episode-a", saved);
        summaries.set("project-a", makeSummary("project-a", "configuring", 2));
        await act(async () => {
            episodeStyleSaves[0].pending.resolve(saved);
            await settle();
        });
        expect(mounted.router.state.location.pathname).toBe("/outside");
    } finally {
        await mounted.close();
    }
});

test("无效的生成配置不会卡住离开，允许继续编辑或明确放弃", async () => {
    const mounted = await mount("/projects/project-a/e/episode-a?step=style");
    try {
        videoOptions = [{ choice: { logicalModelId: "horizontal-only" }, videoRatios: ["16:9"], tailFrameChain: true } as DramaModelOption];
        await fill(mounted.host, "视频模型", "horizontal-only");
        await mounted.go("/outside");
        await act(settle);
        expect(mounted.host.querySelector('[role="dialog"]')).not.toBeNull();
        expect(mounted.host.textContent).not.toContain("正在同步生成配置");
        expect(episodeStyleSaves).toHaveLength(0);
        await click(button(mounted.host, "继续编辑"));
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="视频模型"]')?.value).toBe("horizontal-only");
        await mounted.go("/outside");
        await click(button(mounted.host, "放弃修改并离开"));
        expect(mounted.router.state.location.pathname).toBe("/outside");
    } finally {
        await mounted.close();
    }
});

test("尚未修正的风格文字不阻止合法的生成参数自动同步", async () => {
    const mounted = await mount("/projects/project-a/e/episode-a?step=style");
    try {
        await fill(mounted.host, "风格配置", "字".repeat(61));
        await fill(mounted.host, "视频模型", "episode-video-new");
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
            await settle();
        });
        expect(episodeStyleSaves).toHaveLength(1);
        expect(episodeStyleSaves[0].input.settings).toMatchObject({ styleName: "原始风格", models: { video: { logicalModelId: "episode-video-new" } } });
    } finally {
        await mounted.close();
    }
});

test("后续作品风格页自动同步图片模板，失败保留草稿后可重新同步", async () => {
    const mounted = await mount("/projects/project-a/guide?manage=style");
    try {
        const completed = makeSummary("project-a", "completed", 7);
        summaries.set("project-a", completed);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), completed);
            await settle();
        });
        await fill(mounted.host, "角色绘图模板", "closeup_turnaround");
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
            await settle();
        });
        expect(styleSaves[0].input).toMatchObject({ expectedRevision: 7, styleName: "原始风格", stylePrompt: "原始提示", drawing: { assets: { mode: "closeup_turnaround" } } });
        await act(async () => {
            styleSaves[0].pending.reject(new Error("共享模板暂时保存失败"));
            await settle();
        });
        expect(mounted.router.state.location.search).toBe("?manage=style");
        expect(mounted.host.querySelector<HTMLSelectElement>('[aria-label="角色绘图模板"]')?.value).toBe("closeup_turnaround");
        await click(button(mounted.host, "重新同步配置"));
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
            await settle();
        });
        const next = makeSummary("project-a", "completed", 8);
        next.production.settings.assets = styleSaves[1].input.drawing!.assets;
        summaries.set("project-a", next);
        await act(async () => {
            styleSaves[1].pending.resolve(next);
            await settle();
        });
        expect(mounted.router.state.location.search).toBe("?manage=style");
        await click(button(mounted.host, "继续：主体资产"));
        expect(mounted.router.state.location.search).toBe("?manage=assets");
        expect(mounted.query.getQueryData<DramaSummary>(summaryKey("project-a"))?.production.settings.assets.mode).toBe("closeup_turnaround");
        expect(episodeStyleSaves).toHaveLength(0);
        expect(confirms).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("切集与切账号重新读取各自风格，旧账号保存回执不能推进", async () => {
    const mounted = await mount("/projects/project-a/e/episode-a?step=style");
    try {
        await fill(mounted.host, "风格配置", "第一集草稿");
        await mounted.go("/projects/project-a/e/episode-b?step=style");
        await click(button(mounted.host, "放弃修改并离开"));
        await act(settle);
        expect(episodeStyleReads).toContain("user-a:project-a:episode-b");
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("原始风格");
        await fill(mounted.host, "风格配置", "旧账号保存中");
        await click(button(mounted.host, "保存并继续"));
        await act(async () => {
            userStore.setState({ user: { id: "user-b" } });
            await settle();
        });
        await act(settle);
        expect(episodeStyleReads).toContain("user-b:project-a:episode-b");
        const count = notices.length;
        await act(async () => {
            episodeStyleSaves[0].pending.resolve({ ...makeEpisodeStyle("project-a", "episode-b"), revision: 2, episodeRevision: 4, settings: episodeStyleSaves[0].input.settings });
            await settle();
        });
        expect(notices).toHaveLength(count);
        expect(mounted.router.state.location.search).toBe("?step=style");
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("原始风格");
    } finally {
        await mounted.close();
    }
});

test("后续风格没有修改直接继续，管理页进入主体资产且不发送保存", async () => {
    for (const [entry, expected] of [
        ["?step=style", "?step=assets"],
        ["?manage=style", "?manage=assets"],
    ]) {
        const mounted = await mount(`/projects/project-a/guide${entry}`);
        try {
            const completed = makeSummary("project-a", "completed", 7);
            summaries.set("project-a", completed);
            await act(async () => {
                mounted.query.setQueryData(summaryKey("project-a"), completed);
                await settle();
            });
            await click(button(mounted.host, "继续："));
            expect(mounted.router.state.location.search).toBe(expected);
            expect(styleSaves).toHaveLength(0);
            expect(episodeStyleSaves).toHaveLength(0);
        } finally {
            await mounted.close();
        }
    }
});

test("同路径query切集时已还原的配置草稿不覆盖新集配置", async () => {
    const mounted = await mount("/projects/project-a/guide?step=style&episode=episode-a");
    try {
        const second = makeEpisodeStyle("project-a", "episode-b");
        second.settings.styleName = "第二集风格";
        second.settings.language = "粤语";
        episodeStyles.set("project-a:episode-b", second);
        await fill(mounted.host, "风格配置", "临时修改");
        await fill(mounted.host, "风格配置", "原始风格");
        expect(mounted.host.textContent).not.toContain("保存并继续");
        await mounted.go("/projects/project-a/guide?step=style&episode=episode-b");
        await act(settle);
        expect(mounted.host.querySelector('[role="dialog"]')).toBeNull();
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("第二集风格");
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="对白语言"]')?.value).toBe("粤语");
        expect(episodeStyleSaves).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("本集配置读取失败只提供重读，不能编辑或提交作品默认", async () => {
    const mounted = await mount("/projects/project-a/e/episode-a?step=review");
    try {
        episodeStyleReader = async () => {
            throw new Error("读取失败");
        };
        await act(async () => {
            await mounted.query.invalidateQueries({ queryKey: ["drama-episode-style"] });
            await settle();
        });
        await click(button(mounted.host, "风格设置"));
        await act(settle);
        expect(mounted.host.textContent).toContain("本集配置读取失败");
        expect(mounted.host.querySelector('[aria-label="风格配置"]')).toBeNull();
        expect(button(mounted.host, "继续：角色场景").disabled).toBe(true);
        expect(styleSaves).toHaveLength(0);
        expect(episodeStyleSaves).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("作品默认更新不覆盖已有两集各自的完整配置", async () => {
    const mounted = await mount("/projects/project-a/e/episode-a?step=style");
    try {
        const second = makeEpisodeStyle("project-a", "episode-b");
        second.settings.styleName = "第二集风格";
        second.settings.language = "粤语";
        second.settings.models.video = { logicalModelId: "second-video" };
        episodeStyles.set("project-a:episode-b", second);
        const next = makeSummary("project-a", "completed", 2);
        next.production.settings.styleName = "新的全剧默认";
        next.production.settings.language = "日语";
        summaries.set("project-a", next);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), next);
            await settle();
        });
        await act(settle);
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("原始风格");
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="对白语言"]')?.value).toBe("中文");
        await mounted.go("/projects/project-a/e/episode-b?step=style");
        await act(settle);
        const later = makeSummary("project-a", "completed", 3);
        later.production.settings.styleName = "再次更新默认";
        summaries.set("project-a", later);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), later);
            await settle();
        });
        await act(settle);
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("第二集风格");
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="对白语言"]')?.value).toBe("粤语");
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="视频模型"]')?.value).toBe("second-video");
        expect(styleSaves).toHaveLength(0);
        expect(episodeStyleSaves).toHaveLength(0);
        expect(confirms).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("主体和分镜页使用本集配置展示，重新读取期间保留内容并暂停生成", async () => {
    for (const [step, label] of [
        ["assets", "主体页"],
        ["story", "分镜页"],
    ] as const) {
        const mounted = await mount("/projects/project-a/e/episode-a?step=review");
        try {
            const saved = makeEpisodeStyle("project-a", "episode-a");
            saved.settings.styleName = "本集画风";
            saved.settings.language = "粤语";
            episodeStyles.set("project-a:episode-a", saved);
            const next = makeSummary("project-a", "completed", 2);
            summaries.set("project-a", next);
            await act(async () => {
                mounted.query.setQueryData(summaryKey("project-a"), next);
                await settle();
            });
            await act(settle);
            await mounted.go(`/projects/project-a/e/episode-a?step=${step}`);
            expect(mounted.host.querySelector(`[aria-label="${label}本集配置"]`)?.textContent).toBe("本集画风 · 粤语");
            expect(mounted.host.querySelector(`[aria-label="${label}配置忙状态"]`)?.textContent).toBe("false");

            const pending = deferred<DramaEpisodeStyle>();
            episodeStyleReader = () => pending.promise;
            const newer = makeSummary("project-a", "completed", 3);
            summaries.set("project-a", newer);
            await act(async () => {
                mounted.query.setQueryData(summaryKey("project-a"), newer);
                await settle();
            });
            expect(mounted.host.querySelector(`[aria-label="${label}本集配置"]`)?.textContent).toBe("本集画风 · 粤语");
            expect(mounted.host.querySelector(`[aria-label="${label}配置忙状态"]`)?.textContent).toBe("true");
            await act(async () => {
                pending.resolve({ ...saved, revision: 3 });
                await settle();
            });
            expect(mounted.host.querySelector(`[aria-label="${label}配置忙状态"]`)?.textContent).toBe("false");
            expect(mounted.query.getQueryData<DramaSummary>(summaryKey("project-a"))?.production.settings.styleName).toBe("原始风格");
            expect(styleSaves).toHaveLength(0);
            expect(episodeStyleSaves).toHaveLength(0);
        } finally {
            await mounted.close();
        }
    }
});

test("本集预览风格与剧本页不显示其他集的全剧阻断，阶段确认页保留阻断和门禁", async () => {
    for (const [step, stage, blocked] of [
        ["preview", "story", false],
        ["style", "story", false],
        ["review", "story", false],
        ["assets", "assets", true],
        ["story", "story", true],
    ] as const) {
        const mounted = await mount(`/projects/project-a/e/episode-8?step=${step}`);
        try {
            const current = makeSummary("project-a", stage, 7);
            current.guide!.canConfirm = false;
            current.guide!.blockingReason = "第 7 集剧本与分镜尚未就绪";
            summaries.set("project-a", current);
            await act(async () => {
                mounted.query.setQueryData(summaryKey("project-a"), current);
                await settle();
            });
            await act(settle);
            const footer = mounted.host.querySelector(".drama-workflow-footer");
            if (step === "preview" || step === "assets" || step === "story") expect(footer).toBeNull();
            else expect(footer).not.toBeNull();
            expect(mounted.host.textContent?.includes("第 7 集剧本与分镜尚未就绪")).toBe(blocked);
            if (step === "assets") expect(button(mounted.host, "编排剧本").disabled).toBe(true);
            if (step === "story") {
                const guidance = mounted.host.querySelectorAll('[aria-label="制作流程引导"]');
                expect(guidance).toHaveLength(1);
                expect(guidance[0].closest(".drama-workflow-production-toolbar")).not.toBeNull();
                expect(guidance[0].textContent).toContain("第 7 集剧本与分镜尚未就绪");
                expect(button(guidance[0] as HTMLElement, "完成分镜编排").disabled).toBe(true);
                expect([...mounted.host.querySelectorAll("button")].filter((item) => item.textContent === "完成分镜编排")).toHaveLength(1);
            }
            expect(confirms).toHaveLength(0);
        } finally {
            await mounted.close();
        }
    }
});

test("资产页不留已保存状态底栏，未保存保护和编排入口继续可用", async () => {
    const mounted = await mount("/projects/project-a/e/episode-a?step=assets");
    try {
        const current = makeSummary("project-a", "assets", 7);
        summaries.set("project-a", current);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), current);
            await settle();
        });
        await act(settle);
        expect(mounted.host.querySelector(".drama-workflow-footer")).toBeNull();
        expect(mounted.host.textContent).not.toContain("当前内容已保存");
        expect(button(mounted.host, "编排剧本").disabled).toBe(false);

        await click(button(mounted.host, "编辑资产方案"));
        expect(mounted.host.querySelector(".drama-workflow-footer")?.textContent).toBe("当前内容尚未保存");
        expect(button(mounted.host, "编排剧本").disabled).toBe(true);
        await mounted.go("/outside");
        expect(mounted.host.querySelector('[role="dialog"][aria-label="当前修改尚未保存"]')).not.toBeNull();
        await click(button(mounted.host, "继续编辑"));
        await click(button(mounted.host, "还原资产方案"));
        expect(mounted.host.querySelector(".drama-workflow-footer")).toBeNull();
        await click(button(mounted.host, "编排剧本"));
        expect(mounted.host.querySelector('[role="dialog"][aria-label="选择分镜生成默认模式"]')).not.toBeNull();
    } finally {
        await mounted.close();
    }
});

test("管理风格保存期间禁用离开入口，同作品导航被拦截且不能放弃在途保存", async () => {
    const mounted = await mount("/projects/project-a/guide?manage=style");
    try {
        const current = makeSummary("project-a", "completed", 7);
        summaries.set("project-a", current);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), current);
            await settle();
        });
        await fill(mounted.host, "风格配置", "管理页保存中的风格");
        await click(button(mounted.host, "保存并继续"));
        expect(styleSaves).toHaveLength(1);
        for (const label of ["剧本设定", "分集管理", "选择分集", "更多"]) expect(button(mounted.host, label).disabled).toBe(true);
        await click(button(mounted.host, "分集管理"));
        expect(mounted.router.state.location.search).toBe("?manage=style");
        await mounted.go("/projects/project-a/guide?manage=episodes");
        expect(mounted.host.querySelector('[role="dialog"][aria-label="风格正在保存"]')).not.toBeNull();
        expect(button(mounted.host, "放弃修改并离开").disabled).toBe(true);
        await click(button(mounted.host, "放弃修改并离开"));
        expect(mounted.router.state.location.search).toBe("?manage=style");
        const saved = makeSummary("project-a", "completed", 8);
        saved.production.settings.styleName = "管理页保存中的风格";
        summaries.set("project-a", saved);
        await act(async () => {
            styleSaves[0].pending.resolve(saved);
            await settle();
        });
        expect(mounted.router.state.location.search).toBe("?manage=assets");
        expect(mounted.host.querySelector('[role="dialog"]')).toBeNull();
        expect(mounted.query.getQueryData<DramaSummary>(summaryKey("project-a"))?.production.settings.styleName).toBe("管理页保存中的风格");
    } finally {
        await mounted.close();
    }
});

test("明确放弃管理风格草稿再切页后，回到风格页展示已保存内容", async () => {
    const mounted = await mount("/projects/project-a/guide?manage=style");
    try {
        const current = makeSummary("project-a", "completed", 7);
        summaries.set("project-a", current);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), current);
            await settle();
        });
        await fill(mounted.host, "风格配置", "准备放弃的管理风格");
        await click(button(mounted.host, "分集管理"));
        expect(mounted.host.querySelector('[role="dialog"]')).not.toBeNull();
        await click(button(mounted.host, "继续编辑"));
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("准备放弃的管理风格");
        await click(button(mounted.host, "分集管理"));
        await click(button(mounted.host, "放弃修改并离开"));
        expect(mounted.router.state.location.search).toBe("?manage=episodes");
        await click(button(mounted.host, "风格设置"));
        expect(mounted.host.querySelector<HTMLInputElement>('[aria-label="风格配置"]')?.value).toBe("原始风格");
        expect(mounted.host.textContent).not.toContain("放弃修改");
        expect(styleSaves).toHaveLength(0);
        expect(confirms).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("模式窗口媒体修改后离开会等待同步，不弹保存确认或推进制作", async () => {
    const mounted = await mount("/projects/project-a/guide?step=assets");
    try {
        const assets = makeSummary("project-a", "assets", 2);
        summaries.set("project-a", assets);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), assets);
            await settle();
        });
        await click(button(mounted.host, "编排剧本"));
        await click(button(mounted.host, "修改模式窗口视频配置"));
        await mounted.go("/outside");
        expect(mounted.router.state.location.pathname).toBe("/projects/project-a/guide");
        expect(mounted.host.querySelector('[role="dialog"][aria-label="当前修改尚未保存"]')).toBeNull();
        expect(modeConfigurationWrites).toHaveLength(1);
        await act(async () => {
            modeConfigurationWrites[0].resolve(true);
            await settle();
        });
        expect(mounted.router.state.location.pathname).toBe("/outside");
        expect(confirms).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("模式窗口媒体同步失败时留在当前页和窗口，再次离开可重试", async () => {
    const mounted = await mount("/projects/project-a/guide?step=assets");
    try {
        const assets = makeSummary("project-a", "assets", 2);
        summaries.set("project-a", assets);
        await act(async () => {
            mounted.query.setQueryData(summaryKey("project-a"), assets);
            await settle();
        });
        await click(button(mounted.host, "编排剧本"));
        await click(button(mounted.host, "修改模式窗口视频配置"));
        await mounted.go("/outside");
        await act(async () => {
            modeConfigurationWrites[0].resolve(false);
            await settle();
        });
        expect(mounted.router.state.location.pathname).toBe("/projects/project-a/guide");
        expect(mounted.host.querySelector('[role="dialog"][aria-label="选择分镜生成默认模式"]')).not.toBeNull();
        await mounted.go("/outside");
        expect(modeConfigurationWrites).toHaveLength(2);
        await act(async () => {
            modeConfigurationWrites[1].resolve(true);
            await settle();
        });
        expect(mounted.router.state.location.pathname).toBe("/outside");
        expect(confirms).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});
