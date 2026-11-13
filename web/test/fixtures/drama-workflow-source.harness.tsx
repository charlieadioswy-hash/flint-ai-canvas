import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, StrictMode, useEffect, useState, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaChapterRef, DramaModelCatalog, DramaSettings, DramaSourceFormat, DramaSummary } from "@/services/api/drama";
import type { LocalUser } from "@/stores/use-user-store";

const browser = new Window({ url: "http://localhost/projects/project-a/guide" });
const originals = new Map<string, PropertyDescriptor | undefined>();
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
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { environmentManager } = await import("@tanstack/query-core");
environmentManager.setIsServer(() => false);

type ChapterBody = { id: string; title: string; sourceText: string; wordCount: number; position: number };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
type UserState = { user: LocalUser | null; setUser: (user: LocalUser | null) => void };

const chapterLists = new Map<string, DramaChapterRef[]>();
const chapterBodies = new Map<string, ChapterBody>();
const chapterReads: string[] = [];
const chapterWrites: Array<{ projectId: string; chapterId: string; patch: { title?: string; text?: string; expectedRevision?: number } }> = [];
const notices: Array<{ kind: string; text: string }> = [];
const navigations: string[] = [];
const createCalls: Array<{ name: string; sourceFormat: DramaSourceFormat; chapters: Array<{ title: string; text: string }> }> = [];
type SourceWrite = { expectedRevision: number; chapters?: Array<{ title: string; text: string }>; sourceFormat?: DramaSourceFormat; selectedChapters?: number[] };
const sourceWrites: Array<{ projectId: string; input: SourceWrite }> = [];
let fileReads: Deferred<string>[] = [];
const ideaAdoptions: Array<(text: string, format: DramaSourceFormat) => void> = [];

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function chapterKey(projectId: string, chapterId: string) {
    return `${projectId}:${chapterId}`;
}

function seedChapters(projectId: string, chapters: Array<{ id: string; title: string; text: string; wordCount?: number; reserved?: boolean; episodeNumber?: number }>) {
    chapterLists.set(
        projectId,
        chapters.map((chapter, index) => ({
            id: chapter.id,
            title: chapter.title,
            position: index + 1,
            wordCount: chapter.wordCount ?? chapter.text.length,
            reserved: chapter.reserved ?? false,
            episodeNumber: chapter.episodeNumber,
        })),
    );
    chapters.forEach((chapter, index) => {
        chapterBodies.set(chapterKey(projectId, chapter.id), { id: chapter.id, title: chapter.title, sourceText: chapter.text, wordCount: chapter.text.length, position: index + 1 });
    });
}

const userStore = create<UserState>((set) => ({
    user: { id: "user-a", username: "a", displayName: "账号A", role: "user", status: "active" },
    setUser: (user) => set({ user }),
}));
const useUserStore = userStore;

mock.module("antd", () => ({
    App: {
        useApp: () => ({
            message: {
                success: (text: string) => notices.push({ kind: "success", text }),
                info: (text: string) => notices.push({ kind: "info", text }),
                warning: (text: string) => notices.push({ kind: "warning", text }),
                error: (text: string) => notices.push({ kind: "error", text }),
            },
        }),
    },
    Button: ({ children, icon, loading: _loading, size: _size, type: _type, danger: _danger, ...props }: { children?: ReactNode; icon?: ReactNode; loading?: boolean; size?: string; type?: string; danger?: boolean } & Record<string, unknown>) =>
        createElement("button", props, icon, children),
    Input: Object.assign(({ autoSize: _autoSize, ...props }: Record<string, unknown>) => createElement("input", props), {
        TextArea: ({ autoSize: _autoSize, ...props }: Record<string, unknown>) => createElement("textarea", props),
    }),
}));
mock.module("react-router", () => ({
    useNavigate: () => (to: string) => {
        navigations.push(to);
    },
    useParams: () => ({}),
    Link: ({ children }: { children?: ReactNode }) => children,
}));
mock.module("@/stores/use-user-store", () => ({ useUserStore }));
mock.module("@/pages/projects/drama-shared", () => ({
    SOURCE_FORMAT_LABEL: {
        novel: { title: "小说原文", detail: "按原文改编", placeholder: "粘贴小说" },
        script: { title: "剧本", detail: "只拆镜头", placeholder: "粘贴剧本" },
        storyboard: { title: "分镜", detail: "原样转录", placeholder: "粘贴分镜" },
    },
    SourceFormatPicker: ({ value, onChange, disabled }: { value: DramaSourceFormat; onChange: (value: DramaSourceFormat) => void; disabled?: boolean }) =>
        createElement(
            "select",
            { "aria-label": "素材类型", value, disabled, onChange: (event: Event) => onChange((event.target as HTMLSelectElement).value as DramaSourceFormat) },
            createElement("option", { value: "novel" }, "小说原文"),
            createElement("option", { value: "script" }, "剧本"),
        ),
}));
mock.module("@/pages/projects/studio/use-studio", () => ({
    dramaKeys: { chapters: (projectId: string) => ["drama", projectId, "chapters"] as const },
}));
mock.module("@/pages/projects/drama-source-file", () => ({
    DRAMA_SOURCE_FILE_MAX_BYTES: 30 * 1024 * 1024,
    formatDramaSourceFileSize: () => "30MB",
    readDramaSourceFile: () => {
        const pending = deferred<string>();
        fileReads.push(pending);
        return pending.promise;
    },
}));
mock.module("@/pages/projects/workflow-idea", () => ({
    WorkflowIdea: ({ disabled, onAdopt, onDirtyChange }: { disabled?: boolean; onAdopt: (text: string, format: DramaSourceFormat) => void; onDirtyChange: (dirty: boolean, busy: boolean) => void }) => {
        ideaAdoptions.push(onAdopt);
        const [state, setState] = useState({ dirty: false, busy: false });
        useEffect(() => {
            onDirtyChange(state.dirty, state.busy);
        }, [state]);
        useEffect(() => () => onDirtyChange(false, false), []);
        return createElement(
            "div",
            { "aria-label": "独立创意任务", "data-disabled": String(Boolean(disabled)) },
            createElement("button", { disabled, onClick: () => onAdopt("第1集\nAI扩写的完整剧本", "script") }, "采用扩写样稿"),
            createElement("button", { disabled, onClick: () => setState({ dirty: true, busy: true }) }, "模拟扩写开始"),
            createElement("button", { disabled, onClick: () => setState({ dirty: true, busy: false }) }, "模拟扩写完成"),
            createElement("button", { disabled, onClick: () => setState({ dirty: true, busy: false }) }, "填写创意草稿"),
        );
    },
}));
mock.module("@/pages/projects/drama-model-picker", () => ({
    useDramaModelCatalog: () => ({
        data: {
            defaults: { text: { modelKey: "text" }, image: { modelKey: "image" }, video: { modelKey: "video", channelId: "video-channel" } },
            options: { text: [], image: [], video: [{ choice: { modelKey: "video", channelId: "video-channel" }, capability: "video", label: "测试视频", priceLabel: "", tailFrameChain: true, videoRatios: ["9:16"] }] },
        } as DramaModelCatalog,
        isLoading: false,
        isError: false,
        refetch: async () => ({ data: undefined }),
    }),
}));
mock.module("@/pages/projects/asset-scheme", () => ({
    useAssetSchemes: () => ({
        data: { schemes: [{ mode: "portrait", name: "肖像", description: "", ratio: "9:16", frameHint: "", characterPrompt: "角色提示" }], scenePrompt: "场景提示", characterVariables: [], sceneVariables: [] },
        isLoading: false,
        isError: false,
        refetch: async () => ({ data: undefined }),
    }),
    defaultAssetSettings: () => ({ mode: "portrait", characterPrompt: "角色提示", scenePrompt: "场景提示", characterRatio: "9:16" }),
}));
mock.module("@/services/api/drama", () => ({
    listDramaChapters: async (projectId: string) => ({ chapters: chapterLists.get(projectId) || [] }),
    getDramaChapter: async (projectId: string, chapterId: string) => {
        chapterReads.push(chapterKey(projectId, chapterId));
        const chapter = chapterBodies.get(chapterKey(projectId, chapterId));
        if (!chapter) throw new Error(`没有章节 ${chapterKey(projectId, chapterId)}`);
        return { chapter: structuredClone(chapter) };
    },
    updateDramaChapter: async (projectId: string, chapterId: string, patch: { title?: string; text?: string; expectedRevision?: number }) => {
        chapterWrites.push({ projectId, chapterId, patch: structuredClone(patch) });
        const pending = deferred<{ chapter: ChapterBody }>();
        pendingWrites.push(pending);
        return pending.promise;
    },
    createDrama: async (input: { name: string; sourceFormat: DramaSourceFormat; chapters: Array<{ title: string; text: string }> }) => {
        createCalls.push({ name: input.name, sourceFormat: input.sourceFormat, chapters: input.chapters.map((chapter) => ({ ...chapter })) });
        const pending = deferred<DramaSummary>();
        pendingCreates.push(pending);
        return pending.promise;
    },
    saveDramaGuideSource: async (projectId: string, input: SourceWrite) => {
        sourceWrites.push({ projectId, input: structuredClone(input) });
        if (input.chapters)
            seedChapters(
                projectId,
                input.chapters.map((chapter, index) => ({ id: `replacement-${index}`, title: chapter.title, text: chapter.text, reserved: !input.selectedChapters?.includes(index) })),
            );
        else
            chapterLists.set(
                projectId,
                (chapterLists.get(projectId) || []).map((chapter, index) => ({ ...chapter, reserved: !input.selectedChapters?.includes(index) })),
            );
        return summaryOf(projectId, input.expectedRevision + 1, input.sourceFormat);
    },
}));

const pendingWrites: Deferred<{ chapter: ChapterBody }>[] = [];
const pendingCreates: Deferred<DramaSummary>[] = [];

const { WorkflowSourceReview } = await import("@/pages/projects/workflow-source");
const { DramaWorkflowEntry } = await import("@/pages/projects/workflow-entry");

afterAll(() => {
    browser.happyDOM.abort();
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function settings(): DramaSettings {
    return {
        aspectRatio: "9:16",
        episodeSeconds: 90,
        stylePrompt: "写实",
        styleName: "写实",
        language: "中文普通话",
        assets: { mode: "portrait", characterPrompt: "角色", scenePrompt: "场景", characterRatio: "9:16" },
        storyboard: { segmentMode: "auto", segmentSeconds: 8, segmentMinSeconds: 4, segmentMaxSeconds: 12, pacing: "fast", dialogue: "standard", transition: "auto", transitionMs: 0, performance: 5, cameraMotion: 5 },
        reviewMode: "sample",
        mediaMode: "manual",
        concurrency: 2,
        models: { text: { modelKey: "text" }, image: { modelKey: "image" }, video: { modelKey: "video" } },
        referenceLimit: 3,
        episodeMode: "chapter",
        chaptersPerEpisode: 1,
        videoContinuity: "tail_frame",
    };
}

function summaryOf(projectId: string, revision: number, sourceFormat: DramaSourceFormat = "novel"): DramaSummary {
    return {
        project: {
            id: projectId,
            userId: "user-a",
            name: "正文回归",
            type: "drama",
            aspectRatio: "9:16",
            sourceType: sourceFormat,
            description: "",
            stylePresetId: "",
            status: "active",
            revision: 1,
            createdAt: "2026-11-13T00:00:00Z",
            updatedAt: "2026-11-13T00:00:00Z",
        },
        production: {
            revision,
            guideStep: "configuring",
            status: "draft",
            stage: "bible",
            pauseReason: "",
            settings: settings(),
            budgetMicrocredits: 0,
            spentMicrocredits: 0,
            canvasSpentMicrocredits: 0,
            heldMicrocredits: 0,
            planDone: false,
            planCursor: 0,
            sampleApproved: false,
            assetsReleased: false,
            logline: "",
            tone: "",
            chapterCount: 2,
            wordCount: 12,
            reservedChapterCount: 0,
            reservedWordCount: 0,
        },
        episodes: [
            {
                id: "episode-1",
                number: 1,
                title: "第一集",
                synopsis: "",
                stage: "queued",
                sourceFormat,
                error: "",
                shotCount: 0,
                durationMs: 0,
                approved: false,
                mediaReleased: false,
                awaitingMedia: false,
                finalStale: false,
                stats: { segments: 0, promptReady: 0, promptSucceeded: 0, videoReady: 0, videoGenerated: 0, failed: 0 },
            },
        ],
        jobCounts: {},
        inbox: [],
        castCount: 0,
        guide: { step: "configuring", canConfirm: false },
    } as unknown as DramaSummary;
}

function resetFixture() {
    chapterLists.clear();
    chapterBodies.clear();
    chapterReads.length = 0;
    chapterWrites.length = 0;
    notices.length = 0;
    navigations.length = 0;
    createCalls.length = 0;
    sourceWrites.length = 0;
    ideaAdoptions.length = 0;
    fileReads = [];
    pendingWrites.length = 0;
    pendingCreates.length = 0;
    userStore.setState({ user: { id: "user-a", username: "a", displayName: "账号A", role: "user", status: "active" } });
    seedChapters("project-a", [
        { id: "chapter-a", title: "第一章 A", text: "A的服务器正文", episodeNumber: 1 },
        { id: "chapter-b", title: "第二章 B", text: "B的服务器正文", episodeNumber: 2 },
    ]);
    seedChapters("project-b", [{ id: "chapter-b-only", title: "新项目章节", text: "新项目服务器正文", episodeNumber: 1 }]);
}

async function settle() {
    for (let index = 0; index < 8; index += 1) await Bun.sleep(10);
}

async function mount(render: (props: { summary: DramaSummary; onChanged: () => void }) => ReactNode, initial: DramaSummary, strict = false) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const changed: string[] = [];
    let current = initial;
    const update = async (next: DramaSummary) => {
        current = next;
        await act(async () => {
            const content = createElement(QueryClientProvider, { client }, render({ summary: current, onChanged: () => changed.push(current.project.id) }));
            root.render(strict ? createElement(StrictMode, {}, content) : content);
            await settle();
        });
        await act(async () => {
            await settle();
        });
        await act(async () => {
            await settle();
        });
    };
    await update(initial);
    return {
        container,
        changed,
        client,
        update,
        dispose: async () => {
            await act(async () => root.unmount());
            container.remove();
            client.clear();
            client.unmount();
        },
    };
}

function field(container: HTMLElement, label: string) {
    const found = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
    expect(found, `未找到 ${label}`).not.toBeNull();
    return found!;
}

function button(container: HTMLElement, label: string) {
    const found = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes(label));
    expect(found, `未找到按钮 ${label}`).toBeDefined();
    return found!;
}

function options(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'));
}

async function edit(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
    await act(async () => {
        const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        setter?.call(node, value);
        node.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
        await settle();
    });
}

test("StrictMode 空白入口允许连续输入正文并保存，效果重放不伪造文件读取", async () => {
    resetFixture();
    const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1), true);
    try {
        const content = "第1章 回家\n秦子文带弟弟回到了小区。";
        const complete = `${content}\n窗外突然变成了森林。`;
        expect(field(view.container, "短剧正文").disabled).toBe(false);
        expect(button(view.container, "保存并确认正文").disabled).toBe(true);
        await edit(field(view.container, "短剧正文"), content);
        expect(field(view.container, "短剧正文").value).toBe(content);
        await edit(field(view.container, "短剧正文"), complete);
        expect(field(view.container, "短剧正文").value).toBe(complete);
        expect(button(view.container, "保存并确认正文").disabled).toBe(false);
        await tap(view.container, "保存并确认正文");
        expect(createCalls).toHaveLength(1);
        expect(createCalls[0].chapters[0].text).toContain("窗外突然变成了森林。");
        expect(fileReads).toHaveLength(0);
        await act(async () => {
            pendingCreates[0].resolve(summaryOf("strict-created", 1));
            await settle();
        });
        expect(navigations).toEqual(["/projects/strict-created/guide"]);
    } finally {
        await view.dispose();
    }
});

test("首屏渲染两章正文，不因章节选择提前引用而崩溃", async () => {
    resetFixture();
    const view = await mount((props) => createElement(WorkflowSourceReview, props), summaryOf("project-a", 4));
    try {
        expect(view.container.textContent).not.toContain("ReferenceError");
        expect(field(view.container, "章节标题").value).toBe("第一章 A");
        expect(field(view.container, "章节正文").value).toBe("A的服务器正文");
        expect(options(view.container).map((item) => item.textContent)).toEqual([expect.stringContaining("第一章 A"), expect.stringContaining("第二章 B")]);
        expect(chapterReads).toContain("project-a:chapter-a");
    } finally {
        await view.dispose();
    }
});

test("切章后各自草稿独立保留", async () => {
    resetFixture();
    const view = await mount((props) => createElement(WorkflowSourceReview, props), summaryOf("project-a", 4));
    try {
        await edit(field(view.container, "章节正文"), "A的本地草稿");
        await act(async () => {
            options(view.container)[1]?.click();
            await settle();
        });
        expect(field(view.container, "章节正文").value).toBe("B的服务器正文");
        await edit(field(view.container, "章节正文"), "B的本地草稿");
        await act(async () => {
            options(view.container)[0]?.click();
            await settle();
        });
        expect(field(view.container, "章节正文").value).toBe("A的本地草稿");
        await act(async () => {
            options(view.container)[1]?.click();
            await settle();
        });
        expect(field(view.container, "章节正文").value).toBe("B的本地草稿");
        expect(chapterWrites).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("正文版本变新后不能用旧版本保存，重新载入会再次读取并采用服务器正文", async () => {
    resetFixture();
    const view = await mount((props) => createElement(WorkflowSourceReview, props), summaryOf("project-a", 4));
    try {
        await edit(field(view.container, "章节正文"), "A的未保存修改");
        const readsBefore = chapterReads.length;
        await view.update(summaryOf("project-a", 9));
        expect(view.container.textContent).toContain("正文已有更新");
        expect(button(view.container, "重新载入")).toBeDefined();
        expect(view.container.textContent).not.toContain("保存本章");
        chapterBodies.set(chapterKey("project-a", "chapter-a"), { id: "chapter-a", title: "第一章 A", sourceText: "服务器的新正文", wordCount: 7, position: 1 });
        await act(async () => {
            button(view.container, "重新载入").click();
            await settle();
        });
        expect(chapterReads.length).toBeGreaterThan(readsBefore);
        expect(chapterReads.at(-1)).toBe("project-a:chapter-a");
        expect(field(view.container, "章节正文").value).toBe("服务器的新正文");
        expect(chapterWrites).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("延迟的保存回执不能写入后来挂载的另一个项目", async () => {
    resetFixture();
    const view = await mount((props) => createElement(WorkflowSourceReview, props), summaryOf("project-a", 4));
    try {
        await edit(field(view.container, "章节正文"), "A准备保存");
        await act(async () => {
            button(view.container, "保存本章").click();
            await settle();
        });
        expect(chapterWrites).toEqual([{ projectId: "project-a", chapterId: "chapter-a", patch: { title: "第一章 A", text: "A准备保存", expectedRevision: 4 } }]);
        const first = pendingWrites[0];
        expect(first).toBeDefined();
        await view.update(summaryOf("project-b", 1));
        expect(field(view.container, "章节正文").value).toBe("新项目服务器正文");
        const changedBefore = view.changed.length;
        const noticesBefore = notices.length;
        await act(async () => {
            first!.resolve({ chapter: { id: "chapter-a", title: "第一章 A", sourceText: "A准备保存", wordCount: 5, position: 1 } });
            await settle();
        });
        expect(view.changed.length).toBe(changedBefore);
        expect(notices.slice(noticesBefore)).toEqual([]);
        expect(field(view.container, "章节正文").value).toBe("新项目服务器正文");

        await edit(field(view.container, "章节正文"), "新项目准备保存");
        await act(async () => {
            button(view.container, "保存本章").click();
            await settle();
        });
        const rejected = pendingWrites.at(-1);
        await view.update(summaryOf("project-a", 4));
        const noticesAtReject = notices.length;
        const changedAtReject = view.changed.length;
        await act(async () => {
            rejected!.reject(new Error("保存失败"));
            await settle();
        });
        expect(view.changed.length).toBe(changedAtReject);
        expect(notices.slice(noticesAtReject)).toEqual([]);
        expect(field(view.container, "章节正文").value).toBe("A的服务器正文");
    } finally {
        await view.dispose();
    }
});

test("同项目切换账号后，旧保存回执不能通知或覆盖新账号", async () => {
    resetFixture();
    const view = await mount((props) => createElement(WorkflowSourceReview, props), summaryOf("project-a", 4));
    try {
        expect(useUserStore.getState().user?.id).toBe("user-a");
        await edit(field(view.container, "章节正文"), "旧账号草稿");
        await act(async () => {
            button(view.container, "保存本章").click();
            await settle();
        });
        const pending = pendingWrites[0];
        await act(async () => {
            useUserStore.getState().setUser({ id: "user-b", username: "b", displayName: "账号B", role: "user", status: "active" });
            await settle();
        });
        expect(useUserStore.getState().user?.id).toBe("user-b");
        const noticesBefore = notices.length;
        const changedBefore = view.changed.length;
        await act(async () => {
            pending!.resolve({ chapter: { id: "chapter-a", title: "旧账号标题", sourceText: "旧账号已保存正文", wordCount: 8, position: 1 } });
            await settle();
        });
        expect(notices.slice(noticesBefore)).toEqual([]);
        expect(view.changed.length).toBe(changedBefore);
        expect(field(view.container, "章节正文").value).not.toBe("旧账号已保存正文");
        expect(field(view.container, "章节标题").value).not.toBe("旧账号标题");
    } finally {
        await view.dispose();
    }
});

test("创建请求和文件读取在卸载或切账号后返回时，不跳转、不提示成功、不回填正文", async () => {
    resetFixture();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    const container = document.createElement("div");
    document.body.append(container);
    let root = createRoot(container);
    await act(async () => {
        root.render(createElement(QueryClientProvider, { client }, createElement(DramaWorkflowEntry)));
        await settle();
    });
    try {
        await edit(field(container, "短剧正文"), "第一章 雨夜\n林夏推开门。");
        await act(async () => {
            button(container, "保存并确认正文").click();
            await settle();
        });
        expect(createCalls).toHaveLength(1);
        const pendingCreate = pendingCreates[0];
        await act(async () => root.unmount());
        await act(async () => {
            pendingCreate!.resolve(summaryOf("created-project", 1));
            await settle();
        });
        expect(navigations).toEqual([]);
        expect(notices.filter((item) => item.kind === "success")).toEqual([]);

        root = createRoot(container);
        await act(async () => {
            root.render(createElement(QueryClientProvider, { client }, createElement(DramaWorkflowEntry)));
            await settle();
        });
        const file = new File(["迟到的正文"], "rain.txt", { type: "text/plain" });
        const input = field(container, "上传正文文件") as HTMLInputElement;
        await act(async () => {
            Object.defineProperty(input, "files", { configurable: true, value: [file] });
            input.dispatchEvent(new Event("change", { bubbles: true }));
            await settle();
        });
        const pendingRead = fileReads.at(-1);
        expect(pendingRead).toBeDefined();
        await act(async () => {
            useUserStore.getState().setUser({ id: "user-b", username: "b", displayName: "账号B", role: "user", status: "active" });
            await settle();
        });
        await act(async () => {
            pendingRead!.resolve("账号切换后不应回填的正文");
            await settle();
        });
        expect(field(container, "短剧正文").value).toBe("");
        expect(navigations).toEqual([]);
    } finally {
        await act(async () => root.unmount());
        container.remove();
        client.clear();
        client.unmount();
    }
});

test("素材类型与制作范围单独保存，不重传章节正文", async () => {
    resetFixture();
    const view = await mount((props) => createElement(WorkflowSourceReview, props), summaryOf("project-a", 4));
    try {
        const select = view.container.querySelector<HTMLSelectElement>('select[aria-label="素材类型"]')!;
        await act(async () => {
            select.value = "script";
            select.dispatchEvent(new Event("change", { bubbles: true }));
            field(view.container, "本次制作 第一章 A").click();
            await settle();
        });
        expect(button(view.container, "保存类型与制作范围").disabled).toBe(false);
        await act(async () => {
            button(view.container, "保存类型与制作范围").click();
            await settle();
        });
        expect(sourceWrites).toEqual([{ projectId: "project-a", input: { expectedRevision: 4, sourceFormat: "script", selectedChapters: [1] } }]);
        expect(chapterBodies.get(chapterKey("project-a", "chapter-a"))?.sourceText).toBe("A的服务器正文");
        expect(chapterLists.get("project-a")?.map((chapter) => chapter.reserved)).toEqual([true, false]);
    } finally {
        await view.dispose();
    }
});

test("替换先预览再显式确认范围，长预留章节不阻止导入", async () => {
    resetFixture();
    const states: Array<[boolean, boolean]> = [];
    const view = await mount((props) => createElement(WorkflowSourceReview, { ...props, onDirtyChange: (dirty: boolean, busy: boolean) => states.push([dirty, busy]) }), summaryOf("project-a", 4));
    try {
        await act(async () => {
            const input = field(view.container, "替换正文文件");
            Object.defineProperty(input, "files", { configurable: true, value: [new File(["正文"], "replace.txt")] });
            input.dispatchEvent(new Event("change", { bubbles: true }));
            await settle();
        });
        expect(states.at(-1)?.[1]).toBe(true);
        await act(async () => {
            fileReads.at(-1)!.resolve(`第一章 初见\n林夏推门。\n第二章 预留\n${"预留正文。".repeat(3000)}`);
            await settle();
        });
        expect(view.container.textContent).toContain("替换预览：replace.txt");
        expect(sourceWrites).toHaveLength(0);
        expect(states.at(-1)).toEqual([true, false]);
        const range = Array.from(view.container.querySelectorAll<HTMLInputElement>('input[aria-label^="替换范围 "]'));
        expect(range).toHaveLength(2);
        expect(range.map((item) => item.checked)).toEqual([true, false]);
        await act(async () => {
            range[1].click();
            await settle();
        });
        await act(async () => {
            button(view.container, "确认替换正文").click();
            await settle();
        });
        expect(sourceWrites).toHaveLength(0);
        expect(notices.at(-1)?.text).toContain("1.2 万字");
        await act(async () => {
            range[1].click();
            await settle();
        });
        await act(async () => {
            button(view.container, "确认替换正文").click();
            await settle();
        });
        expect(sourceWrites).toHaveLength(1);
        expect(sourceWrites[0]?.input.selectedChapters).toEqual([0]);
        expect(sourceWrites[0]?.input.chapters).toHaveLength(2);
        expect(sourceWrites[0]?.input.chapters?.[1].text.length).toBeGreaterThan(12000);
    } finally {
        await view.dispose();
    }
    expect(states.at(-1)).toEqual([false, false]);
});

test("汇总其他章的未保存修改，切章期间保存成功仍刷新当前项目", async () => {
    resetFixture();
    const states: Array<[boolean, boolean]> = [];
    const view = await mount((props) => createElement(WorkflowSourceReview, { ...props, onDirtyChange: (dirty: boolean, busy: boolean) => states.push([dirty, busy]) }), summaryOf("project-a", 4));
    try {
        await edit(field(view.container, "章节正文"), "第一章已修改");
        await act(async () => {
            options(view.container)[1].click();
            await settle();
        });
        await act(async () => {
            await settle();
        });
        expect(field(view.container, "章节正文").value).toBe("B的服务器正文");
        expect(states.at(-1)).toEqual([true, false]);
        await act(async () => {
            options(view.container)[0].click();
            await settle();
        });
        await act(async () => {
            button(view.container, "保存本章").click();
            await settle();
        });
        await act(async () => {
            options(view.container)[1].click();
            await settle();
        });
        const saved: ChapterBody = { id: "chapter-a", title: "第一章 A", sourceText: "第一章已修改", wordCount: 7, position: 1 };
        chapterBodies.set(chapterKey("project-a", "chapter-a"), saved);
        const changedBefore = view.changed.length;
        const noticesBefore = notices.length;
        await act(async () => {
            pendingWrites[0].resolve({ chapter: saved });
            await settle();
        });
        expect(view.changed.length).toBe(changedBefore + 1);
        expect(notices.slice(noticesBefore)).toEqual([]);
        expect(field(view.container, "章节正文").value).toBe("B的服务器正文");
    } finally {
        await view.dispose();
    }
});

test("首个上传文件在 StrictMode 只读取一次，失败不标记已读取", async () => {
    resetFixture();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
        const file = new File(["内容"], "initial.docx");
        await act(async () => {
            root.render(createElement(StrictMode, {}, createElement(QueryClientProvider, { client }, createElement(DramaWorkflowEntry, { initialFile: file, focusInput: true }))));
            await settle();
        });
        expect(fileReads).toHaveLength(1);
        expect(container.textContent).not.toContain("已读取 initial.docx");
        await act(async () => {
            fileReads[0].reject(new Error("损坏的文件"));
            await settle();
        });
        expect(container.textContent).not.toContain("已读取 initial.docx");
        expect(notices.at(-1)?.text).toBe("损坏的文件");
        expect(field(container, "短剧正文").value).toBe("");
        await act(async () => {
            useUserStore.getState().setUser({ id: "user-b", username: "b", displayName: "账号B", role: "user", status: "active" });
            await settle();
        });
        expect(fileReads).toHaveLength(1);
        expect(field(container, "短剧正文").value).toBe("");
    } finally {
        await act(async () => root.unmount());
        container.remove();
        client.clear();
        client.unmount();
    }
});

async function tap(container: HTMLElement, label: string) {
    await act(async () => {
        button(container, label).click();
        await settle();
    });
}

test("StrictMode 创意默认收起，空正文显式采用后仍需保存且重复点击只创建一次", async () => {
    resetFixture();
    const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1), true);
    try {
        expect(view.container.querySelector('[aria-label="独立创意任务"]')).toBeNull();
        await tap(view.container, "一句想法生成正文");
        expect(createCalls).toHaveLength(0);
        expect(field(view.container, "短剧正文").value).toBe("");
        await tap(view.container, "采用扩写样稿");
        expect(field(view.container, "短剧正文").value).toBe("第1集\nAI扩写的完整剧本");
        expect(createCalls).toHaveLength(0);
        expect(view.container.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.textContent).toContain("剧本");
        await act(async () => {
            const save = button(view.container, "保存并确认正文");
            save.click();
            save.click();
            await settle();
        });
        expect(createCalls).toHaveLength(1);
        expect(createCalls[0].sourceFormat).toBe("script");
        expect(createCalls[0].chapters[0].text).toContain("AI扩写的完整剧本");
    } finally {
        await view.dispose();
    }
});

test("已有人工正文必须确认替换，取消保留原文，采用不会创建作品", async () => {
    resetFixture();
    const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1));
    try {
        await edit(field(view.container, "短剧正文"), "第一章\n人工原文");
        await tap(view.container, "一句想法生成正文");
        await tap(view.container, "采用扩写样稿");
        expect(view.container.querySelector('[aria-label="确认替换为AI正文"]')).not.toBeNull();
        expect(field(view.container, "短剧正文").value).toContain("人工原文");
        expect(field(view.container, "短剧正文").disabled).toBe(true);
        expect(button(view.container, "保存并确认正文").disabled).toBe(true);
        await tap(view.container, "保留现有正文");
        expect(field(view.container, "短剧正文").value).toContain("人工原文");
        await tap(view.container, "采用扩写样稿");
        await tap(view.container, "确认采用AI正文");
        expect(field(view.container, "短剧正文").value).toContain("AI扩写的完整剧本");
        expect(createCalls).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("上传文件读取与创意采用互斥，文件正文采用AI前确认并清除旧文件标题", async () => {
    resetFixture();
    const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1));
    try {
        await tap(view.container, "一句想法生成正文");
        const adopt = ideaAdoptions.at(-1)!;
        const input = field(view.container, "上传正文文件") as HTMLInputElement;
        await act(async () => {
            Object.defineProperty(input, "files", { configurable: true, value: [new File(["原文"], "文件标题.txt")] });
            input.dispatchEvent(new Event("change", { bubbles: true }));
            await settle();
        });
        expect(view.container.querySelector('[aria-label="独立创意任务"]')?.getAttribute("data-disabled")).toBe("true");
        await act(async () => {
            adopt("不能覆盖在读文件", "script");
            await settle();
        });
        expect(field(view.container, "短剧正文").value).toBe("");
        await act(async () => {
            fileReads[0].resolve("第一章\n已上传的正文");
            await settle();
        });
        expect(view.container.textContent).toContain("已读取 文件标题.txt");
        await tap(view.container, "采用扩写样稿");
        expect(field(view.container, "短剧正文").value).toContain("已上传的正文");
        await tap(view.container, "确认采用AI正文");
        expect(view.container.textContent).not.toContain("已读取 文件标题.txt");
        await tap(view.container, "保存并确认正文");
        expect(createCalls[0].name).not.toBe("文件标题");
        expect(createCalls[0].sourceFormat).toBe("script");
    } finally {
        await view.dispose();
    }
});

test("创意任务运行时冻结导入与创建，作品创建时旧采用和文件事件不能改正文", async () => {
    resetFixture();
    const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1));
    try {
        await edit(field(view.container, "短剧正文"), "第一章\n当前正文");
        await tap(view.container, "一句想法生成正文");
        await tap(view.container, "模拟扩写开始");
        expect(button(view.container, "保存并确认正文").disabled).toBe(true);
        expect(button(view.container, "一句想法生成正文").disabled).toBe(true);
        expect(field(view.container, "上传正文文件").disabled).toBe(true);
        expect(field(view.container, "短剧正文").disabled).toBe(true);
        await tap(view.container, "模拟扩写完成");
        const adopt = ideaAdoptions.at(-1)!;
        await tap(view.container, "保存并确认正文");
        expect(createCalls).toHaveLength(1);
        expect(view.container.querySelector('[aria-label="独立创意任务"]')?.getAttribute("data-disabled")).toBe("true");
        await act(async () => {
            adopt("旧采用不应回填", "script");
            const input = field(view.container, "上传正文文件");
            Object.defineProperty(input, "files", { configurable: true, value: [new File(["无效"], "late.txt")] });
            input.dispatchEvent(new Event("change", { bubbles: true }));
            await settle();
        });
        expect(fileReads).toHaveLength(0);
        expect(field(view.container, "短剧正文").value).toContain("当前正文");
        expect(view.container.querySelector('[aria-label="确认替换为AI正文"]')).toBeNull();
    } finally {
        await view.dispose();
    }
});

test("创意旧采用回调不能跨账号或在卸载后修改导入页", async () => {
    resetFixture();
    const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1));
    await tap(view.container, "一句想法生成正文");
    const adopt = ideaAdoptions.at(-1)!;
    await act(async () => {
        userStore.getState().setUser({ id: "user-b", username: "b", displayName: "B", role: "user", status: "active" });
        await settle();
        adopt("账号A的正文", "script");
        await settle();
    });
    expect(field(view.container, "短剧正文").value).toBe("");
    expect(view.container.querySelector('[aria-label="确认替换为AI正文"]')).toBeNull();
    await view.dispose();
    await act(async () => {
        adopt("卸载后不能采用", "script");
        await settle();
    });
    expect(createCalls).toHaveLength(0);
    expect(navigations).toHaveLength(0);
});

test("未采用创意收起前确认，收起不影响已有导入正文", async () => {
    resetFixture();
    const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1));
    try {
        await edit(field(view.container, "短剧正文"), "导入正文");
        await tap(view.container, "一句想法生成正文");
        await tap(view.container, "填写创意草稿");
        await tap(view.container, "一句想法生成正文");
        expect(view.container.querySelector('[aria-label="确认收起创意草稿"]')).not.toBeNull();
        expect(view.container.querySelector('[aria-label="独立创意任务"]')).not.toBeNull();
        await tap(view.container, "收起创意草稿");
        expect(view.container.querySelector('[aria-label="独立创意任务"]')).toBeNull();
        expect(field(view.container, "短剧正文").value).toBe("导入正文");
        expect(createCalls).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});
