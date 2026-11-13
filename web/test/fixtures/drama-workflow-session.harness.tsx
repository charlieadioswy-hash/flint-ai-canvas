import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, StrictMode, useEffect, useState, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaGuideStep, DramaSettings, DramaSourceFormat, DramaSummary } from "@/services/api/drama";

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
const { createMemoryRouter, RouterProvider, useSearchParams } = await import("react-router");
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
let chapterReads = 0;
const userStore = create(() => ({ user: { id: "user-a" } }));
const noop = () => undefined;
const message = Object.fromEntries(["success", "error", "info", "warning"].map((kind) => [kind, (text: string) => notices.push({ kind, text })]));
mock.module("antd", () => ({
    App: { useApp: () => ({ message }) },
    Button: ({ children, icon, loading: _loading, type: _type, size: _size, danger: _danger, ...props }: Record<string, unknown>) => createElement("button", props, icon as ReactNode, children as ReactNode),
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
mock.module("@/pages/projects/studio/use-drama-media-action", () => ({ useDramaMediaAction: () => ({ state: { submitting: false }, requestCastImage: noop }) }));
mock.module("@/pages/projects/studio/queue-bar", () => ({ QueueBar: () => null }));
mock.module("@/pages/projects/guide-panels", () => ({ GuideAssets: () => <div>主体资产列表</div> }));
mock.module("@/pages/projects/workflow-assets", () => ({
    WorkflowAssets: ({ onDirtyChange, busy = false }: { onDirtyChange: (dirty: boolean, busy: boolean) => void; busy?: boolean }) => {
        const [dirty, setDirty] = useState(false);
        useEffect(() => {
            onDirtyChange(dirty, busy);
            return () => onDirtyChange(false, false);
        }, [dirty, busy, onDirtyChange]);
        return (
            <section>
                主体资产列表<button onClick={() => setDirty(true)}>编辑资产方案</button>
                <button onClick={() => setDirty(false)}>还原资产方案</button>
            </section>
        );
    },
}));
mock.module("@/pages/projects/workflow-production", () => ({ WorkflowProduction: ({ summary }: { summary: DramaSummary }) => <div>分镜制作 {summary.project.name}</div> }));
mock.module("@/pages/projects/workflow-configuration", () => ({
    WorkflowConfiguration: ({ settings, onChange, disabled }: { settings: DramaSettings; onChange: (value: DramaSettings) => void; disabled: boolean }) => (
        <input aria-label="风格配置" disabled={disabled} value={settings.styleName} onChange={(event) => onChange({ ...settings, styleName: event.target.value })} />
    ),
}));
mock.module("@/pages/projects/drama-model-picker", () => ({ useDramaModelCatalog: () => ({ data: { options: { video: [] } } }) }));
mock.module("@/pages/projects/drama-shared", () => ({
    SourceFormatPicker: ({ value, disabled, onChange }: { value: DramaSourceFormat; disabled?: boolean; onChange: (value: DramaSourceFormat) => void }) => (
        <select aria-label="素材类型" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as DramaSourceFormat)}>
            <option value="novel">小说</option>
            <option value="script">剧本</option>
        </select>
    ),
}));
mock.module("@/pages/projects/drama-source-file", () => ({ readDramaSourceFile: async () => "替换正文" }));
const summaryKey = (projectId: string) => ["drama", projectId, "summary"];
mock.module("@/pages/projects/studio/use-studio", () => ({
    dramaKeys: { summary: summaryKey, chapters: (projectId: string) => ["drama", projectId, "chapters"] },
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
    listDramaChapters: async (projectId: string) => ({ chapters: [{ id: `${projectId}-chapter`, title: "第一章", wordCount: 4, position: 1, reserved: false }] }),
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
    retryFailedDrama: async () => ({ jobs: 0 }),
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
        production: { guideStep: stage, revision, chapterCount: 1, status: "draft", settings: { styleName: "原始风格", stylePrompt: "原始提示", aspectRatio: "9:16", language: "中文", models: { video: {} }, assets: {} } },
        guide: { step: stage, canConfirm: true, blockingReason: "" },
        episodes: [],
        jobCounts: {},
    } as unknown as DramaSummary;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
async function mount(path = "/projects/project-a/guide?step=review", strict = false) {
    notices.length = 0;
    confirms.length = 0;
    sourceSaves.length = 0;
    chapterReads = 0;
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
    const prototype = input.tagName === "TEXTAREA" ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype;
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
        expect(button(mounted.host, "下一步：风格和基础配置").disabled).toBe(false);
        expect(mounted.host.querySelector(".drama-root")).not.toBeNull();
    } finally {
        await mounted.close();
    }
});

test("正文草稿阻止切步和外部路由离开，继续编辑保留草稿并拦截刷新", async () => {
    const mounted = await mount();
    try {
        await fill(mounted.host, "章节正文", "尚未保存的正文");
        expect(button(mounted.host, "下一步：风格和基础配置").disabled).toBe(true);
        await click(button(mounted.host, "风格和基础配置"));
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
        await click(mounted.host.querySelector<HTMLAnchorElement>('a[href*="mode=advanced"]')!);
        expect(mounted.router.state.location.pathname).toBe("/projects/project-a/guide");
        expect(notices.at(-1)?.text).toContain("先保存或放弃");
        await click(button(mounted.host, "确认正文与拆集"));
        await click(button(mounted.host, "风格和基础配置"));
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
        await click(button(mounted.host, "确认配置并提取资产"));
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
        await click(button(mounted.host, "确认配置并提取资产"));
        await click(button(mounted.host, "确认正文与拆集"));
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
        await click(button(mounted.host, "确认资产并继续"));
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
        await click(button(mounted.host, "确认配置并提取资产"));
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
        await click(button(mounted.host, "确认配置并提取资产"));
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
        expect(button(mounted.host, "确认资产并继续").disabled).toBe(false);
        await click(button(mounted.host, "编辑资产方案"));
        expect(button(mounted.host, "确认资产并继续").disabled).toBe(true);
        await click(button(mounted.host, "风格和基础配置"));
        expect(new URLSearchParams(mounted.router.state.location.search).get("step")).toBe("assets");
        await mounted.go("/outside");
        expect(mounted.host.querySelector('[role="dialog"]')).not.toBeNull();
        await click(button(mounted.host, "继续编辑"));
        await click(button(mounted.host, "还原资产方案"));
        expect(button(mounted.host, "确认资产并继续").disabled).toBe(false);
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
        expect(button(mounted.host, "确认配置并提取资产").disabled).toBe(false);
    } finally {
        await mounted.close();
    }
});
