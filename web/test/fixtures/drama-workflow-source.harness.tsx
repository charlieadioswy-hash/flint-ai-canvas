import { afterAll, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { createElement, StrictMode, useEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import type { CreateDramaInput, DramaChapterRef, DramaModelCatalog, DramaSettings, DramaSourceFormat, DramaSummary } from "@/services/api/drama";
import { ApiError } from "@/services/api/request";
import type { LocalUser } from "@/stores/use-user-store";

const browser = new Window({ url: "http://localhost/projects/project-a/guide" });
const sourceStyles = browser.document.createElement("style");
sourceStyles.textContent = readFileSync(new URL("../../src/pages/projects/workflow-source.css", import.meta.url), "utf8");
browser.document.head.append(sourceStyles);
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
const episodeChapterIDs = new Map<string, string[]>();
const draftEpisodes = new Set<string>();
const storyboardStarts: string[] = [];
const chapterWrites: Array<{ projectId: string; chapterId: string; patch: { title?: string; text?: string; expectedRevision?: number } }> = [];
const notices: Array<{ kind: string; text: string }> = [];
const navigations: string[] = [];
const createCalls: CreateDramaInput[] = [];
type SourceWrite = { expectedRevision: number; chapters?: Array<{ title: string; text: string }>; sourceFormat?: DramaSourceFormat; selectedChapters?: number[] };
const sourceWrites: Array<{ projectId: string; input: SourceWrite }> = [];
const settingsWrites: Array<{ projectId: string; input: { settings?: DramaSettings; expectedRevision?: number } }> = [];
const projectWrites: Array<{ projectId: string; input: { name?: string; description?: string; aspectRatio?: string } }> = [];
const projectSettings = new Map<string, DramaSettings>();
let settingsFailure: Error | null = null;
let fileReads: Deferred<string>[] = [];
const ideaAdoptions: Array<(text: string, format: DramaSourceFormat) => void> = [];
const canvasGuards: Array<() => boolean | Promise<boolean>> = [];
const canvasDecisions: boolean[] = [];
let canvasCreation: Deferred<void> | undefined;
let canvasCreationCalls = 0;

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
    Button: ({
        children,
        icon,
        loading: _loading,
        size: _size,
        type: _type,
        htmlType,
        danger: _danger,
        ...props
    }: { children?: ReactNode; icon?: ReactNode; loading?: boolean; size?: string; type?: string; htmlType?: string; danger?: boolean } & Record<string, unknown>) => createElement("button", { type: htmlType || "button", ...props }, icon, children),
    Input: Object.assign(({ autoSize: _autoSize, count: _count, status: _status, ...props }: Record<string, unknown>) => createElement("input", props), {
        TextArea: ({ autoSize: _autoSize, ...props }: Record<string, unknown>) => createElement("textarea", props),
    }),
}));
mock.module("@/components/ui/product/app-modal", () => ({
    AppModal: ({
        open,
        title,
        children,
        "aria-label": label,
        onCancel,
        afterOpenChange,
        closable = true,
        maskClosable = true,
        keyboard = true,
        destroyOnHidden,
        className,
        footer,
    }: {
        open?: boolean;
        title?: string;
        children?: ReactNode;
        "aria-label"?: string;
        onCancel?: () => void;
        afterOpenChange?: (open: boolean) => void;
        closable?: boolean;
        maskClosable?: boolean;
        keyboard?: boolean;
        destroyOnHidden?: boolean;
        className?: string;
        footer?: ReactNode;
    }) => {
        const opened = useRef(false);
        if (open) opened.current = true;
        useEffect(() => {
            afterOpenChange?.(Boolean(open));
        }, [open]);
        return open || (opened.current && destroyOnHidden === false)
            ? createElement(
                  "section",
                  {
                      role: "dialog",
                      "aria-label": label,
                      "aria-hidden": !open,
                      "data-app-modal": "true",
                      "data-mask-closable": String(maskClosable),
                      "data-keyboard": String(keyboard),
                      className,
                      hidden: !open,
                      inert: !open,
                      onKeyDown: (event: { key: string }) => {
                          if (open && keyboard && event.key === "Escape") onCancel?.();
                      },
                  },
                  createElement("h2", {}, title),
                  closable ? createElement("button", { type: "button", "aria-label": `关闭${label || "弹窗"}`, onClick: onCancel }, "×") : null,
                  children,
                  footer,
              )
            : null;
    },
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
    dramaKeys: {
        summary: (projectId: string) => ["drama", projectId] as const,
        episode: (projectId: string, episodeId: string) => ["drama", projectId, "episode", episodeId] as const,
        chapters: (projectId: string) => ["drama", projectId, "chapters"] as const,
    },
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
            { "aria-label": "独立创意任务", "data-disabled": String(Boolean(disabled)), "data-dirty": String(state.dirty), "data-busy": String(state.busy) },
            createElement("button", { disabled, onClick: () => onAdopt("第1集\nAI扩写的完整剧本", "script") }, "采用扩写样稿"),
            createElement("button", { disabled, onClick: () => setState({ dirty: true, busy: true }) }, "模拟扩写开始"),
            createElement("button", { disabled, onClick: () => setState({ dirty: true, busy: false }) }, "模拟扩写完成"),
            createElement("button", { disabled, onClick: () => setState({ dirty: true, busy: false }) }, "填写创意草稿"),
        );
    },
}));
mock.module("@/pages/projects/workflow-canvas-entry", () => ({
    WorkflowCanvasEntry: ({ disabled, hidden, onBeforeCreate, onBusyChange }: { disabled?: boolean; hidden?: boolean; onBeforeCreate: () => boolean | Promise<boolean>; onBusyChange: (busy: boolean) => void }) => {
        const locked = useRef(false);
        const [busy, setBusy] = useState(false);
        canvasGuards.push(onBeforeCreate);
        const create = async () => {
            if (disabled || hidden || locked.current) return;
            locked.current = true;
            setBusy(true);
            onBusyChange(true);
            try {
                const allowed = await onBeforeCreate();
                canvasDecisions.push(allowed);
                if (!allowed) return;
                canvasCreationCalls += 1;
                await canvasCreation?.promise;
                navigations.push("/canvas/new-draft");
            } finally {
                locked.current = false;
                setBusy(false);
                onBusyChange(false);
            }
        };
        return createElement("button", { type: "button", hidden, disabled: disabled || busy, onClick: () => void create() }, "新建画布");
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
        data: { schemes: [{ mode: "closeup_turnaround", name: "单特写+三视图", description: "", ratio: "16:9", frameHint: "", characterPrompt: "角色提示" }], scenePrompt: "场景提示", characterVariables: [], sceneVariables: [] },
        isLoading: false,
        isError: false,
        refetch: async () => ({ data: undefined }),
    }),
    defaultAssetSettings: () => ({ mode: "closeup_turnaround", characterPrompt: "角色提示", scenePrompt: "场景提示", characterRatio: "16:9" }),
}));
mock.module("@/services/api/drama", () => ({
    listDramaChapters: async (projectId: string) => ({ chapters: chapterLists.get(projectId) || [] }),
    getDramaEpisode: async (projectId: string, episodeId: string) => ({
        episode: { id: episodeId, number: 2, title: "第二集", stage: draftEpisodes.has(episodeId) ? "draft" : "script", chapterIdsJson: JSON.stringify(episodeChapterIDs.get(`${projectId}:${episodeId}`) || []) },
    }),
    rescriptDramaEpisode: async (projectId: string, episodeId: string) => {
        storyboardStarts.push(episodeId);
        draftEpisodes.delete(episodeId);
        return { episode: { id: episodeId, stage: "script", chapterIdsJson: JSON.stringify(episodeChapterIDs.get(`${projectId}:${episodeId}`) || []) } };
    },
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
    createDrama: async (input: CreateDramaInput) => {
        createCalls.push(structuredClone(input));
        const pending = deferred<DramaSummary>();
        pendingCreates.push(pending);
        return pending.promise;
    },
    saveDramaGuideSource: async (projectId: string, input: SourceWrite) => {
        sourceWrites.push({ projectId, input: structuredClone(input) });
        if (input.chapters)
            seedChapters(
                projectId,
                input.chapters.map((chapter, index) => ({ id: `replacement-${index}`, title: chapter.title, text: chapter.text, reserved: input.selectedChapters ? !input.selectedChapters.includes(index) : false })),
            );
        else
            chapterLists.set(
                projectId,
                (chapterLists.get(projectId) || []).map((chapter, index) => ({ ...chapter, reserved: input.selectedChapters ? !input.selectedChapters.includes(index) : false })),
            );
        return summaryOf(projectId, input.expectedRevision + 1, input.sourceFormat);
    },
    updateDramaSettings: async (projectId: string, input: { settings?: DramaSettings; expectedRevision?: number }) => {
        settingsWrites.push({ projectId, input: structuredClone(input) });
        if (settingsFailure) {
            const error = settingsFailure;
            settingsFailure = null;
            throw error;
        }
        if (input.settings) projectSettings.set(projectId, structuredClone(input.settings));
        return summaryOf(projectId, (input.expectedRevision || 0) + 1);
    },
}));
mock.module("@/services/api/projects", () => ({
    updateProject: async (projectId: string, input: { name?: string; description?: string; aspectRatio?: string }) => {
        projectWrites.push({ projectId, input: structuredClone(input) });
        return { project: { ...summaryOf(projectId, 1).project, ...input } };
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
        assets: { mode: "closeup_turnaround", characterPrompt: "角色", scenePrompt: "场景", characterRatio: "16:9" },
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
            settings: projectSettings.get(projectId) || settings(),
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
    episodeChapterIDs.clear();
    draftEpisodes.clear();
    storyboardStarts.length = 0;
    chapterWrites.length = 0;
    notices.length = 0;
    navigations.length = 0;
    createCalls.length = 0;
    sourceWrites.length = 0;
    settingsWrites.length = 0;
    projectWrites.length = 0;
    projectSettings.clear();
    settingsFailure = null;
    ideaAdoptions.length = 0;
    canvasGuards.length = 0;
    canvasDecisions.length = 0;
    canvasCreation = undefined;
    canvasCreationCalls = 0;
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

function isActive(node: Element) {
    return !node.closest('[hidden], [inert], [aria-hidden="true"]');
}

function button(container: HTMLElement, label: string, includeHidden = false) {
    const found = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes(label) && (includeHidden || isActive(item)));
    expect(found, `未找到按钮 ${label}`).toBeDefined();
    return found!;
}

function ideaDialog(container: HTMLElement) {
    const found = Array.from(container.querySelectorAll<HTMLElement>('[role="dialog"][aria-label="一句想法生成正文"]')).find(isActive);
    expect(found, "未找到打开的创意弹窗").toBeDefined();
    return found!;
}

async function closeIdeaDialog(container: HTMLElement) {
    await act(async () => {
        const close = ideaDialog(container).querySelector<HTMLButtonElement>('[aria-label="关闭一句想法生成正文"]');
        expect(close).not.toBeNull();
        close!.click();
        await settle();
    });
}

function options(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'));
}

async function edit(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
    if (node.closest(".drama-entry-paste")?.hasAttribute("hidden")) {
        await tap(node.closest(".drama-workflow-entry") as HTMLElement, "手动输入 / 粘贴");
    }
    if (node.closest(".drama-source-edit-fields")?.hasAttribute("hidden")) {
        await act(async () => {
            node.closest(".drama-source-page")?.querySelector<HTMLButtonElement>("[data-source-edit]")?.click();
            await settle();
        });
    }
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
        expect(navigations).toEqual(["/projects/strict-created/guide?step=review"]);
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

test("上传剧本与剧本格式呈现不同页面，切换步骤保留章节编辑草稿", async () => {
    resetFixture();
    let step: "source" | "review" = "source";
    const view = await mount((props) => createElement(WorkflowSourceReview, { ...props, step }), summaryOf("project-a", 4));
    try {
        expect(view.container.querySelector('[aria-label="上传剧本"]')).not.toBeNull();
        expect(view.container.querySelector('[aria-label="剧本格式说明"]')).not.toBeNull();
        expect(view.container.querySelector(".drama-source-upload-zone")?.textContent).toContain("文件已就绪");
        expect(view.container.querySelector(".drama-source-upload-zone")?.textContent).toContain("2 章");
        expect(view.container.querySelector('[aria-label="剧本格式说明"]')?.textContent).toContain("拆分场次格式示意");
        expect(view.container.querySelector('[aria-label="章节正文"]')).toBeNull();
        step = "review";
        await view.update(summaryOf("project-a", 4));
        expect(view.container.querySelector('[aria-label="剧本格式"]')).not.toBeNull();
        expect(view.container.querySelector('[aria-label="剧本格式说明"]')).toBeNull();
        await edit(field(view.container, "章节正文"), "切步骤也要保留的草稿");
        step = "source";
        await view.update(summaryOf("project-a", 4));
        expect(field(view.container, "替换正文文件").disabled).toBe(true);
        expect(view.container.textContent).toContain("还有未保存的章节修改");
        step = "review";
        await view.update(summaryOf("project-a", 4));
        expect(field(view.container, "章节正文").value).toBe("切步骤也要保留的草稿");
        expect(chapterWrites).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("剧本格式默认阅读，显式编辑与取消只影响当前章，制作设置默认收起", async () => {
    resetFixture();
    const view = await mount((props) => createElement(WorkflowSourceReview, props), summaryOf("project-a", 4));
    try {
        expect(view.container.querySelector('[aria-label="章节预览"]')?.textContent).toContain("A的服务器正文");
        expect(view.container.querySelector(".drama-source-edit-fields")?.hasAttribute("hidden")).toBe(true);
        expect(view.container.querySelector<HTMLDetailsElement>(".drama-source-review-options")?.open).toBe(false);
        expect(view.container.querySelector(".drama-source-scope")).toBeNull();
        await tap(view.container, "手动编辑");
        expect(view.container.querySelector('[aria-label="章节预览"]')).toBeNull();
        await edit(field(view.container, "章节正文"), "A保留的编辑草稿");
        await act(async () => {
            options(view.container)[1].click();
            await settle();
        });
        await edit(field(view.container, "章节正文"), "B待放弃的编辑稿");
        await tap(view.container, "放弃本章修改");
        expect(view.container.querySelector('[aria-label="章节预览"]')?.textContent).toContain("B的服务器正文");
        expect(view.container.querySelector(".drama-source-edit-fields")?.hasAttribute("hidden")).toBe(true);
        await act(async () => {
            options(view.container)[0].click();
            await settle();
        });
        expect(view.container.querySelector('[aria-label="章节预览"]')?.textContent).toContain("A保留的编辑草稿");
        expect(chapterWrites).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("九章完整展示真实九集，没有制作范围复选框或默认首章说明", async () => {
    resetFixture();
    seedChapters(
        "project-a",
        Array.from({ length: 9 }, (_, index) => ({ id: `scope-${index}`, title: index === 0 ? "序章" : `第${index}章`, text: "原文章节".repeat(index + 1), episodeNumber: index + 1 })),
    );
    const initial = summaryOf("project-a", 4);
    initial.production.chapterCount = 9;
    initial.episodes = Array.from({ length: 9 }, (_, index) => ({ ...initial.episodes[0], id: `episode-${index}`, number: index + 1 }));
    const view = await mount((props) => createElement(WorkflowSourceReview, props), initial);
    try {
        const heading = view.container.querySelector(".drama-source-chapter-summary")!;
        expect(heading.textContent).toBe("原文共 9 章 · 共 9 集");
        expect(view.container.querySelector(".drama-source-chapter-list > p")?.textContent).toBe(heading.textContent);
        expect(view.container.querySelector<HTMLDetailsElement>(".drama-source-review-options")?.open).toBe(false);
        expect(options(view.container)).toHaveLength(9);
        expect(options(view.container)[0].textContent).toContain("第 1 集");
        expect(options(view.container)[1].textContent).toContain("第 2 集");
        expect(options(view.container)[1].textContent).toContain("8 字");
        expect(view.container.querySelector('input[type="checkbox"]')).toBeNull();
        expect(getComputedStyle(options(view.container)[1].querySelector("span")!).display).toBe("block");
        expect(view.container.textContent).toContain("全部章节已加入分集列表");
        await act(async () => {
            options(view.container)[8].click();
            await settle();
        });
        expect(heading.textContent).toBe("原文共 9 章 · 共 9 集");
        expect(options(view.container)[8].getAttribute("aria-selected")).toBe("true");
        expect(sourceWrites).toHaveLength(0);
        expect(chapterLists.get("project-a")?.filter((chapter) => chapter.reserved)).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("确认后原文目录保持全部章节，阅读切章不再要求继续选章", async () => {
    resetFixture();
    seedChapters(
        "project-a",
        Array.from({ length: 9 }, (_, index) => ({ id: `scope-${index}`, title: index === 0 ? "序章" : `第${index}章`, text: "原文章节".repeat(index + 1), episodeNumber: index + 1 })),
    );
    const initial = summaryOf("project-a", 4);
    initial.production.chapterCount = 9;
    initial.episodes = Array.from({ length: 9 }, (_, index) => ({ ...initial.episodes[0], id: `episode-${index}`, number: index + 1 }));
    initial.production.guideStep = "assets";
    initial.guide!.step = "assets";
    let busy = false;
    let step: "source" | "review" = "review";
    const view = await mount((props) => createElement(WorkflowSourceReview, { ...props, busy, step }), initial);
    try {
        expect(view.container.querySelector(".drama-source-chapter-summary")?.textContent).toBe("原文共 9 章 · 共 9 集");
        expect(options(view.container)).toHaveLength(9);
        expect(options(view.container)[0].textContent).toContain("第 1 集");
        expect(options(view.container)[1].textContent).toContain("第 2 集");
        expect(getComputedStyle(options(view.container)[1].querySelector("span")!).display).toBe("block");
        expect(view.container.querySelector('[aria-label^="本次制作 "]')).toBeNull();
        expect(view.container.textContent).not.toContain("继续选章");
        await tap(view.container, "手动编辑");
        await edit(field(view.container, "章节正文"), "切章不能丢失的草稿");
        await act(async () => {
            options(view.container)[1].click();
            await settle();
        });
        await act(async () => {
            options(view.container)[0].click();
            await settle();
        });
        await tap(view.container, "放弃本章修改");
        busy = true;
        await view.update(initial);
        expect(button(view.container, "手动编辑").disabled).toBe(true);
        busy = false;
        step = "source";
        await view.update(initial);
        expect(view.container.textContent).not.toContain("继续选章");
        expect(sourceWrites).toHaveLength(0);
        expect(chapterWrites).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("配置确认后仍保留上传页未保存的粘贴输入且不出现选章入口", async () => {
    resetFixture();
    seedChapters("project-a", [
        { id: "chapter-a", title: "序章", text: "保留的首章", episodeNumber: 1 },
        { id: "chapter-b", title: "第一章", text: "尚未加入的正文", reserved: true },
    ]);
    const initial = summaryOf("project-a", 4);
    const view = await mount((props) => createElement(WorkflowSourceReview, { ...props, step: "source" }), initial);
    try {
        expect(Array.from(view.container.querySelectorAll("button")).some((item) => item.textContent?.includes("继续选章"))).toBe(false);
        await tap(view.container, "手动输入 / 粘贴");
        await edit(field(view.container, "粘贴新的来源正文"), "尚未保存的新来源正文");
        const confirmed = structuredClone(initial);
        confirmed.production.guideStep = "assets";
        confirmed.guide!.step = "assets";
        await view.update(confirmed);
        expect(view.container.textContent).not.toContain("继续选章");
        expect(field(view.container, "粘贴新的来源正文").value).toBe("尚未保存的新来源正文");
        await tap(view.container, "清空输入");
        expect(view.container.textContent).not.toContain("继续选章");
        expect(sourceWrites).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("单集剧本按真实章节关联限制目录，缺少关联时不回退到全剧", async () => {
    resetFixture();
    episodeChapterIDs.set("project-a:episode-b", ["chapter-b"]);
    let episodeId = "episode-b";
    const view = await mount((props) => createElement(WorkflowSourceReview, { ...props, episodeId }), summaryOf("project-a", 4));
    try {
        expect(options(view.container)).toHaveLength(1);
        expect(options(view.container)[0].textContent).toContain("第二章 B");
        expect(field(view.container, "章节正文").value).toBe("B的服务器正文");
        expect(chapterReads).toEqual(["project-a:chapter-b"]);
        expect(view.container.querySelector('input[aria-label^="本次制作 "]')).toBeNull();
        expect(Array.from(view.container.querySelectorAll("button")).some((item) => item.textContent?.includes("创建剧集"))).toBe(false);
        await edit(field(view.container, "章节正文"), "仅修改本集的原文");
        await tap(view.container, "保存本章");
        expect(chapterWrites[0]?.chapterId).toBe("chapter-b");
        expect(sourceWrites).toHaveLength(0);
        episodeId = "without-chapters";
        await view.update(summaryOf("project-a", 4));
        expect(options(view.container)).toHaveLength(0);
        expect(view.container.querySelector('[aria-label="章节正文"]')).toBeNull();
        expect(view.container.textContent).toContain("本集尚无可编辑的原文章节");
        expect(chapterReads).not.toContain("project-a:chapter-a");
    } finally {
        await view.dispose();
    }
});

test("待制作集在剧本页直接生成分镜，读取与阅读均不自动启动", async () => {
    resetFixture();
    episodeChapterIDs.set("project-a:episode-b", ["chapter-b"]);
    draftEpisodes.add("episode-b");
    const initial = summaryOf("project-a", 4);
    initial.production.guideStep = "story";
    initial.guide!.step = "story";
    let started = 0;
    const view = await mount((props) => createElement(WorkflowSourceReview, { ...props, episodeId: "episode-b", onStoryboardStarted: () => started++ }), initial);
    try {
        expect(storyboardStarts).toHaveLength(0);
        expect(options(view.container)).toHaveLength(1);
        expect(button(view.container, "生成分镜").disabled).toBe(false);
        await tap(view.container, "生成分镜");
        expect(storyboardStarts).toEqual(["episode-b"]);
        expect(started).toBe(1);
        expect(sourceWrites).toHaveLength(0);
        expect(chapterWrites).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("粘贴来源先解析与预览，确认才写入并沿用原有分集设置", async () => {
    resetFixture();
    const states: Array<[boolean, boolean]> = [];
    const initial = summaryOf("project-a", 4);
    initial.production.settings.episodeMode = "auto";
    initial.production.settings.chaptersPerEpisode = 3;
    const view = await mount((props) => createElement(WorkflowSourceReview, { ...props, step: "source", onDirtyChange: (dirty: boolean, busy: boolean) => states.push([dirty, busy]) }), initial);
    try {
        await tap(view.container, "手动输入 / 粘贴");
        await edit(field(view.container, "粘贴新的来源正文"), "第1集\n林晚推门。\n第2集\n顾言走进房间。");
        expect(states.at(-1)).toEqual([true, false]);
        expect(field(view.container, "替换正文文件").disabled).toBe(true);
        await tap(view.container, "解析正文");
        expect(view.container.textContent).toContain("替换预览：手动输入的正文");
        expect(sourceWrites).toHaveLength(0);
        expect(view.container.querySelectorAll(".drama-source-replacement-item")).toHaveLength(2);
        expect(view.container.querySelector('input[aria-label^="替换范围 "]')).toBeNull();
        await tap(view.container, "确认替换正文");
        expect(sourceWrites).toHaveLength(1);
        expect(sourceWrites[0]?.input).toEqual({
            expectedRevision: 4,
            chapters: [
                { title: "第1集", text: "林晚推门。" },
                { title: "第2集", text: "顾言走进房间。" },
            ],
            sourceFormat: "novel",
        });
        expect(initial.production.settings.episodeMode).toBe("auto");
        expect(initial.production.settings.chaptersPerEpisode).toBe(3);
        expect(field(view.container, "粘贴新的来源正文").value).toBe("");
    } finally {
        await view.dispose();
    }
});

test("下载剧本包含全部章节和当前草稿，不触发正文保存", async () => {
    resetFixture();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalClick = browser.HTMLAnchorElement.prototype.click;
    const downloads: Blob[] = [];
    const fileNames: string[] = [];
    URL.createObjectURL = (blob) => {
        downloads.push(blob as Blob);
        return "blob:drama-script";
    };
    URL.revokeObjectURL = () => {};
    browser.HTMLAnchorElement.prototype.click = function () {
        fileNames.push(this.download);
    };
    const view = await mount((props) => createElement(WorkflowSourceReview, props), summaryOf("project-a", 4));
    try {
        await edit(field(view.container, "章节正文"), "第一章尚未保存的内容");
        await tap(view.container, "下载剧本");
        expect(downloads).toHaveLength(1);
        const text = await downloads[0].text();
        expect(text).toContain("# 第一章 A\n\n第一章尚未保存的内容");
        expect(text).toContain("# 第二章 B\n\nB的服务器正文");
        expect(fileNames).toEqual(["正文回归.md"]);
        expect(chapterWrites).toHaveLength(0);
    } finally {
        await view.dispose();
        URL.createObjectURL = originalCreate;
        URL.revokeObjectURL = originalRevoke;
        browser.HTMLAnchorElement.prototype.click = originalClick;
    }
});

test("新建单集保留全部原文章节，类型比例备注真实写入且连续点击不重复", async () => {
    resetFixture();
    const initial = summaryOf("project-a", 4);
    initial.production.settings.episodeMode = "auto";
    initial.production.settings.chaptersPerEpisode = 3;
    projectSettings.set("project-a", initial.production.settings);
    let continued = 0;
    const view = await mount(
        (props) =>
            createElement(WorkflowSourceReview, {
                ...props,
                onContinue: () => {
                    continued += 1;
                },
            }),
        initial,
    );
    try {
        view.client.setQueryDefaults(["drama", "project-a"], { gcTime: Infinity });
        await act(async () => {
            options(view.container)[1].click();
            await settle();
        });
        await tap(view.container, "创建单集");
        expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain("全部章节已加入分集列表");
        expect(view.container.querySelectorAll(".drama-source-type-card img")).toHaveLength(3);
        await edit(field(view.container, "剧集名称"), "雨夜单集");
        await edit(field(view.container, "剧集备注"), "以解说推进剧情");
        await act(async () => {
            view.container.querySelector<HTMLInputElement>('input[type="radio"][value="narration"]')!.click();
            view.container.querySelector<HTMLInputElement>('input[type="radio"][value="16:9"]')!.click();
            await settle();
        });
        await act(async () => {
            const submit = button(view.container, "新建");
            submit.click();
            submit.click();
            await settle();
        });
        expect(sourceWrites).toHaveLength(1);
        expect(sourceWrites[0]?.input.selectedChapters).toBeUndefined();
        expect(settingsWrites).toHaveLength(1);
        expect(settingsWrites[0]?.input.expectedRevision).toBe(5);
        expect(settingsWrites[0]?.input.settings).toMatchObject({ dramaType: "narration", aspectRatio: "16:9", episodeMode: "auto", chaptersPerEpisode: 3 });
        expect(projectWrites).toEqual([{ projectId: "project-a", input: { name: "雨夜单集", description: "以解说推进剧情", aspectRatio: "16:9" } }]);
        expect(view.client.getQueryData<DramaSummary>(["drama", "project-a"])?.production.revision).toBe(6);
        expect(view.client.getQueryData<DramaSummary>(["drama", "project-a"])?.project.name).toBe("雨夜单集");
        expect(continued).toBe(1);
        expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    } finally {
        await view.dispose();
    }
});

test("新建剧集的后续设置失败保留表单与已保存版本，重试使用最新 CAS", async () => {
    resetFixture();
    settingsFailure = new Error("设置暂时无法保存");
    let continued = 0;
    const view = await mount(
        (props) =>
            createElement(WorkflowSourceReview, {
                ...props,
                onContinue: () => {
                    continued += 1;
                },
            }),
        summaryOf("project-a", 4),
    );
    try {
        view.client.setQueryDefaults(["drama", "project-a"], { gcTime: Infinity });
        await tap(view.container, "创建剧集");
        await edit(field(view.container, "剧集名称"), "失败后保留的名称");
        await tap(view.container, "新建");
        expect(continued).toBe(0);
        expect(view.container.querySelector('[role="dialog"]')).not.toBeNull();
        expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("设置暂时无法保存");
        expect(field(view.container, "剧集名称").value).toBe("失败后保留的名称");
        expect(view.client.getQueryData<DramaSummary>(["drama", "project-a"])?.production.revision).toBe(5);
        await tap(view.container, "新建");
        expect(sourceWrites.map(({ input }) => input.expectedRevision)).toEqual([4, 5]);
        expect(settingsWrites.map(({ input }) => input.expectedRevision)).toEqual([5, 6]);
        expect(continued).toBe(1);
        expect(view.client.getQueryData<DramaSummary>(["drama", "project-a"])?.production.revision).toBe(7);
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

test("素材类型单独保存，不重传正文或缩减章节范围", async () => {
    resetFixture();
    const view = await mount((props) => createElement(WorkflowSourceReview, props), summaryOf("project-a", 4));
    try {
        const select = view.container.querySelector<HTMLSelectElement>('select[aria-label="素材类型"]')!;
        await act(async () => {
            select.value = "script";
            select.dispatchEvent(new Event("change", { bubbles: true }));
            await settle();
        });
        expect(button(view.container, "保存素材类型").disabled).toBe(false);
        await act(async () => {
            button(view.container, "保存素材类型").click();
            await settle();
        });
        expect(sourceWrites).toEqual([{ projectId: "project-a", input: { expectedRevision: 4, sourceFormat: "script" } }]);
        expect(chapterBodies.get(chapterKey("project-a", "chapter-a"))?.sourceText).toBe("A的服务器正文");
        expect(chapterLists.get("project-a")?.map((chapter) => chapter.reserved)).toEqual([false, false]);
    } finally {
        await view.dispose();
    }
});

test("替换预览全量章节，任一章节过长时必须先拆分再导入", async () => {
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
        expect(view.container.querySelector('input[aria-label^="替换范围 "]')).toBeNull();
        expect(button(view.container, "确认替换正文").disabled).toBe(true);
        await act(async () => {
            button(view.container, "确认替换正文").click();
            await settle();
        });
        expect(sourceWrites).toHaveLength(0);
        expect(view.container.textContent).toContain("请先拆分正文");
        await tap(view.container, "取消替换");
        await act(async () => {
            const input = field(view.container, "替换正文文件");
            Object.defineProperty(input, "files", { configurable: true, value: [new File(["正文"], "split.txt")] });
            input.dispatchEvent(new Event("change", { bubbles: true }));
            await settle();
            fileReads.at(-1)!.resolve("第一章 初见\n林夏推门。\n第二章 后续\n她走进屋里。");
            await settle();
        });
        await act(async () => {
            button(view.container, "确认替换正文").click();
            await settle();
        });
        expect(sourceWrites).toHaveLength(1);
        expect(sourceWrites[0]?.input.selectedChapters).toBeUndefined();
        expect(sourceWrites[0]?.input.chapters).toHaveLength(2);
        expect(chapterLists.get("project-a")?.every((chapter) => !chapter.reserved)).toBe(true);
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

test("StrictMode 创意由独立弹窗打开，采用不展开入口且仍需显式保存", async () => {
    resetFixture();
    const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1), true);
    try {
        expect(view.container.querySelector('[aria-label="独立创意任务"]')).toBeNull();
        const entry = view.container.querySelector(".drama-workflow-idea-entry")!;
        const entryChildren = entry.children.length;
        expect(button(view.container, "一句想法生成正文").getAttribute("aria-haspopup")).toBe("dialog");
        expect(button(view.container, "一句想法生成正文").hasAttribute("aria-expanded")).toBe(false);
        await tap(view.container, "一句想法生成正文");
        const dialog = ideaDialog(view.container);
        expect(dialog.getAttribute("data-app-modal")).toBe("true");
        expect(dialog.classList.contains("drama-entry-idea-modal")).toBe(true);
        expect(dialog.querySelector('[aria-label="独立创意任务"]')).not.toBeNull();
        expect(entry.querySelector('[aria-label="独立创意任务"]')).toBeNull();
        expect(entry.children.length).toBe(entryChildren);
        await closeIdeaDialog(view.container);
        expect(dialog.hidden).toBe(true);
        expect(dialog.querySelector('[aria-label="确认关闭创意窗口"]')).toBeNull();
        await tap(view.container, "一句想法生成正文");
        expect(ideaDialog(view.container)).toBe(dialog);
        expect(createCalls).toHaveLength(0);
        expect(field(view.container, "短剧正文").value).toBe("");
        await tap(dialog, "采用扩写样稿");
        expect(dialog.hidden).toBe(true);
        expect(entry.children.length).toBe(entryChildren);
        expect(field(view.container, "短剧正文").value).toBe("第1集\nAI扩写的完整剧本");
        expect(createCalls).toHaveLength(0);
        expect(field(view.container, "短剧正文").getAttribute("placeholder")).toBe("粘贴剧本");
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
        const dialog = ideaDialog(view.container);
        expect(dialog.querySelector('[aria-label="确认替换为AI正文"]')).not.toBeNull();
        expect(view.container.querySelector(".drama-workflow-idea-entry")?.querySelector('[aria-label="确认替换为AI正文"]')).toBeNull();
        expect(dialog.getAttribute("data-mask-closable")).toBe("false");
        expect(dialog.getAttribute("data-keyboard")).toBe("false");
        await act(async () => {
            dialog.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await settle();
        });
        expect(isActive(dialog)).toBe(true);
        expect(dialog.querySelector('[aria-label="确认替换为AI正文"]')).not.toBeNull();
        expect(field(view.container, "短剧正文").value).toContain("人工原文");
        expect(field(view.container, "短剧正文").disabled).toBe(true);
        expect(button(view.container, "保存并确认正文").disabled).toBe(true);
        await tap(view.container, "保留现有正文");
        expect(field(view.container, "短剧正文").value).toContain("人工原文");
        expect(isActive(dialog)).toBe(true);
        expect(dialog.querySelector('[aria-label="确认替换为AI正文"]')).toBeNull();
        await tap(view.container, "采用扩写样稿");
        await tap(view.container, "确认采用AI正文");
        expect(field(view.container, "短剧正文").value).toContain("AI扩写的完整剧本");
        expect(isActive(dialog)).toBe(false);
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
        expect(view.container.querySelector(".drama-entry-upload-filename")?.textContent).toBe("文件标题.txt");
        await tap(view.container, "采用扩写样稿");
        expect(field(view.container, "短剧正文").value).toContain("已上传的正文");
        await tap(view.container, "确认采用AI正文");
        expect(view.container.querySelector(".drama-entry-upload-filename")).toBeNull();
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
        const dialog = ideaDialog(view.container);
        expect(dialog.getAttribute("data-mask-closable")).toBe("false");
        expect(dialog.getAttribute("data-keyboard")).toBe("false");
        expect(dialog.querySelector('[aria-label="关闭一句想法生成正文"]')).toBeNull();
        await act(async () => {
            dialog.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await settle();
        });
        expect(isActive(dialog)).toBe(true);
        expect(dialog.querySelector('[aria-label="确认关闭创意窗口"]')).toBeNull();
        await tap(view.container, "模拟扩写完成");
        const adopt = ideaAdoptions.at(-1)!;
        await closeIdeaDialog(view.container);
        await tap(view.container, "保留草稿并关闭");
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

test("未采用创意关闭前确认，保留关闭再打开继续同一草稿且不改变导入正文", async () => {
    resetFixture();
    const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1));
    try {
        await edit(field(view.container, "短剧正文"), "导入正文");
        await tap(view.container, "一句想法生成正文");
        await tap(view.container, "填写创意草稿");
        const dialog = ideaDialog(view.container);
        const task = dialog.querySelector('[aria-label="独立创意任务"]');
        const oldAdopt = ideaAdoptions.at(-1)!;
        expect(task?.getAttribute("data-dirty")).toBe("true");
        await closeIdeaDialog(view.container);
        expect(dialog.querySelector('[aria-label="确认关闭创意窗口"]')).not.toBeNull();
        await tap(dialog, "继续创意扩写");
        expect(dialog.querySelector('[aria-label="确认关闭创意窗口"]')).toBeNull();
        expect(isActive(dialog)).toBe(true);
        await act(async () => {
            dialog.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await settle();
        });
        expect(dialog.querySelector('[aria-label="确认关闭创意窗口"]')).not.toBeNull();
        await tap(dialog, "保留草稿并关闭");
        expect(isActive(dialog)).toBe(false);
        expect(task?.isConnected).toBe(true);
        await act(async () => {
            oldAdopt("关闭后的旧采用不能覆盖正文", "script");
            await settle();
        });
        expect(dialog.querySelector('[aria-label="确认替换为AI正文"]')).toBeNull();
        expect(field(view.container, "短剧正文").value).toBe("导入正文");
        await tap(view.container, "一句想法生成正文");
        expect(ideaDialog(view.container)).toBe(dialog);
        expect(dialog.querySelector('[aria-label="独立创意任务"]')).toBe(task);
        expect(task?.getAttribute("data-dirty")).toBe("true");
        expect(dialog.querySelector('[aria-label="确认关闭创意窗口"]')).toBeNull();
        expect(field(view.container, "短剧正文").value).toBe("导入正文");
        expect(createCalls).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

for (const [label, value] of [
    ["精品漫", "comic"],
    ["真人剧", "live_action"],
    ["漫剧解说", "narration"],
] as const) {
    test(`剧集入口${label}将真实类型传给创建并保留原六步`, async () => {
        resetFixture();
        const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1));
        try {
            await tap(view.container, "剧集");
            expect(view.container.querySelector('[aria-label="选择创作方式"]')).toBeNull();
            await tap(view.container, label);
            expect(view.container.querySelector('[aria-label="选择创作方式"]')).not.toBeNull();
            expect(view.container.querySelector(".drama-entry-source")?.getAttribute("aria-hidden")).toBe("true");
            expect(createCalls).toHaveLength(0);
            await tap(view.container, "从剧本开始");
            expect(view.container.querySelector('[aria-label="选择创作方式"]')).toBeNull();
            await edit(field(view.container, "短剧正文"), "第1集\n入口创建的剧本正文");
            expect(view.container.textContent).not.toContain("转绘出海");
            expect(view.container.querySelector(".drama-workflow-entry-steps")?.textContent).toBe("上传剧本剧本格式风格设置角色场景漫剧分镜视频预览");
            await tap(view.container, "保存并确认正文");
            expect(createCalls).toHaveLength(1);
            expect(createCalls[0].settings.dramaType).toBe(value);
            expect(createCalls[0].sourceFormat).toBe("script");
            await act(async () => {
                pendingCreates[0].resolve(summaryOf("created-entry", 1));
                await settle();
            });
            expect(navigations).toEqual(["/projects/created-entry/guide?step=review"]);
        } finally {
            await view.dispose();
        }
    });
}

test("正文只有大上传区一个文件入口，切到粘贴后可返回并保留正文和来源格式", async () => {
    resetFixture();
    const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1));
    try {
        const input = field(view.container, "上传正文文件");
        const openFilePicker = mock(() => {});
        Object.defineProperty(input, "click", { configurable: true, value: openFilePicker });
        const upload = view.container.querySelector<HTMLButtonElement>(".drama-entry-upload")!;
        expect(upload.hidden).toBe(false);
        expect(view.container.querySelectorAll('input[type="file"]')).toHaveLength(1);
        expect(view.container.querySelectorAll('[role="tab"]')).toHaveLength(3);
        expect(view.container.querySelectorAll(".drama-entry-input-actions button")).toHaveLength(1);
        expect(view.container.querySelector('.drama-entry-input-actions [role="tab"]')).toBeNull();
        expect(button(view.container, "手动输入 / 粘贴")).toBeDefined();
        await act(async () => {
            upload.click();
            await settle();
        });
        expect(openFilePicker).toHaveBeenCalledTimes(1);
        expect(fileReads).toHaveLength(0);
        await tap(view.container, "剧集");
        await tap(view.container, "真人剧");
        await tap(view.container, "从剧本开始");
        await tap(view.container, "手动输入 / 粘贴");
        expect(upload.hidden).toBe(true);
        await edit(field(view.container, "短剧正文"), "第1集\n切换仍保留的正文");
        await tap(view.container, "改为上传文件");
        expect(upload.hidden).toBe(false);
        expect(field(view.container, "短剧正文").value).toBe("第1集\n切换仍保留的正文");
        await tap(view.container, "手动输入 / 粘贴");
        expect(field(view.container, "短剧正文").getAttribute("placeholder")).toBe("粘贴剧本");
        expect(field(view.container, "短剧正文").value).toBe("第1集\n切换仍保留的正文");
        expect(openFilePicker).toHaveBeenCalledTimes(1);
        await tap(view.container, "保存并确认正文");
        expect(createCalls).toHaveLength(1);
        expect(createCalls[0].sourceFormat).toBe("script");
        expect(createCalls[0].settings.dramaType).toBe("live_action");
    } finally {
        await view.dispose();
    }
});

test("三个顶层入口复用同一内容容器，仅当前面板可交互且切换保留原节点", async () => {
    resetFixture();
    const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1));
    try {
        const content = view.container.querySelector<HTMLElement>('[role="tabpanel"]')!;
        const panels = [".drama-entry-source", ".drama-entry-types", ".drama-entry-canvas"].map((selector) => content.querySelector<HTMLElement>(selector)!);
        expect(panels.every(Boolean)).toBe(true);
        for (const [index, label] of ["剧本", "剧集", "画布", "剧本"].entries()) {
            await tap(view.container, label);
            expect(view.container.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
            expect(view.container.querySelector('[role="tabpanel"]')).toBe(content);
            const selected = view.container.querySelector<HTMLElement>('.drama-entry-tabs [aria-selected="true"]')!;
            expect(content.getAttribute("aria-labelledby")).toBe(selected.id);
            const activeIndex = index === 3 ? 0 : index;
            panels.forEach((panel, panelIndex) => {
                expect(panel.isConnected).toBe(true);
                expect(panel.parentElement).toBe(content);
                expect(panel.getAttribute("data-active")).toBe(String(panelIndex === activeIndex));
                expect(panel.getAttribute("aria-hidden")).toBe(String(panelIndex !== activeIndex));
                expect(panel.hasAttribute("inert")).toBe(panelIndex !== activeIndex);
            });
        }
        expect(createCalls).toHaveLength(0);
        expect(navigations).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("来源上传区拦截拖放冒泡，读取一次并保留真人剧与剧本来源", async () => {
    resetFixture();
    const ancestorDragOver = mock(() => {});
    const ancestorDrop = mock(() => navigations.push("/projects/new"));
    const view = await mount(() => createElement("div", { onDragOver: ancestorDragOver, onDrop: ancestorDrop }, createElement(DramaWorkflowEntry)), summaryOf("project-a", 1));
    try {
        await tap(view.container, "剧集");
        await tap(view.container, "真人剧");
        await tap(view.container, "从剧本开始");
        const upload = view.container.querySelector<HTMLButtonElement>(".drama-entry-upload");
        expect(upload).not.toBeNull();
        expect(upload!.hidden).toBe(false);
        const transfer = { files: [new File(["第1集\n拖入的真人剧本"], "真人剧本.txt", { type: "text/plain" })], types: ["Files"] };
        await act(async () => {
            for (const type of ["dragover", "drop"]) {
                const event = new Event(type, { bubbles: true, cancelable: true });
                Object.defineProperty(event, "dataTransfer", { value: transfer });
                upload!.dispatchEvent(event);
                expect(event.defaultPrevented).toBe(true);
            }
            await settle();
        });
        expect(fileReads).toHaveLength(1);
        expect(ancestorDragOver).not.toHaveBeenCalled();
        expect(ancestorDrop).not.toHaveBeenCalled();
        expect(navigations).toHaveLength(0);
        expect(createCalls).toHaveLength(0);
        await act(async () => {
            fileReads[0].resolve("第1集\n拖入的真人剧本");
            await settle();
        });
        expect(fileReads).toHaveLength(1);
        expect(field(view.container, "短剧正文").value).toBe("第1集\n拖入的真人剧本");
        expect(navigations).toHaveLength(0);
        await tap(view.container, "保存并确认正文");
        expect(createCalls).toHaveLength(1);
        expect(createCalls[0].settings.dramaType).toBe("live_action");
        expect(createCalls[0].sourceFormat).toBe("script");
        expect(ancestorDragOver).not.toHaveBeenCalled();
        expect(ancestorDrop).not.toHaveBeenCalled();
    } finally {
        await view.dispose();
    }
});

test("顶级入口与来源切换不清正文，上传失败保留草稿和类型，读取中冻结入口", async () => {
    resetFixture();
    const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1));
    try {
        await edit(field(view.container, "短剧正文"), "第一章\n不能丢失的人工原文");
        await tap(view.container, "剧集");
        await tap(view.container, "漫剧解说");
        await tap(view.container, "从分镜开始");
        await tap(view.container, "返回");
        await tap(view.container, "剧本");
        expect(field(view.container, "短剧正文").value).toContain("不能丢失的人工原文");
        await tap(view.container, "剧集");
        expect(view.container.querySelector('[aria-label="剧集类型"] [aria-checked="true"]')?.textContent).toContain("漫剧解说");
        await tap(view.container, "漫剧解说");
        await tap(view.container, "从分镜开始");
        const input = field(view.container, "上传正文文件");
        await act(async () => {
            Object.defineProperty(input, "files", { configurable: true, value: [new File(["损坏"], "broken.docx")] });
            input.dispatchEvent(new Event("change", { bubbles: true }));
            await settle();
        });
        expect(Array.from(view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).every((tab) => tab.disabled)).toBe(true);
        await act(async () => {
            button(view.container, "画布", true).click();
            await settle();
        });
        expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("剧集");
        await act(async () => {
            fileReads[0].reject(new Error("无法读取文档"));
            await settle();
        });
        expect(field(view.container, "短剧正文").value).toContain("不能丢失的人工原文");
        expect(notices.at(-1)?.text).toBe("无法读取文档");
        await tap(view.container, "保存并确认正文");
        expect(createCalls[0].sourceFormat).toBe("storyboard");
        expect(createCalls[0].settings.dramaType).toBe("narration");
    } finally {
        await view.dispose();
    }
});

test("空入口允许新建画布，同帧双点仅通过一次创建确认且不创建短剧", async () => {
    resetFixture();
    const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1));
    try {
        await tap(view.container, "画布");
        expect(button(view.container, "保存并确认正文", true).disabled).toBe(true);
        await act(async () => {
            const create = button(view.container, "新建画布");
            create.click();
            create.click();
            await settle();
        });
        expect(canvasDecisions).toEqual([true]);
        expect(canvasCreationCalls).toBe(1);
        expect(navigations).toEqual(["/canvas/new-draft"]);
        expect(createCalls).toHaveLength(0);
        expect(view.container.querySelector('[aria-label="确认前往画布"]')).toBeNull();
    } finally {
        await view.dispose();
    }
});

test("新建画布前保护正文，取消恢复来源和类型，明确放弃才允许创建", async () => {
    resetFixture();
    const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1));
    try {
        await tap(view.container, "剧集");
        await tap(view.container, "真人剧");
        await tap(view.container, "从剧本开始");
        await edit(field(view.container, "短剧正文"), "第一章\n未保存的正文");
        await tap(view.container, "返回");
        await tap(view.container, "画布");
        await tap(view.container, "新建画布");
        expect(navigations).toHaveLength(0);
        expect(view.container.querySelector('[aria-label="确认前往画布"]')).not.toBeNull();
        await tap(view.container, "继续编辑正文");
        expect(canvasDecisions).toEqual([false]);
        expect(canvasCreationCalls).toBe(0);
        expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("剧集");
        expect(view.container.querySelector('[aria-label="剧集类型"] [aria-checked="true"]')?.textContent).toContain("真人剧");
        await tap(view.container, "真人剧");
        await tap(view.container, "从剧本开始");
        expect(field(view.container, "短剧正文").value).toContain("未保存的正文");
        await tap(view.container, "返回");
        await tap(view.container, "画布");
        await tap(view.container, "新建画布");
        await tap(view.container, "放弃未保存内容并前往画布");
        expect(canvasDecisions).toEqual([false, true]);
        expect(canvasCreationCalls).toBe(1);
        expect(navigations).toEqual(["/canvas/new-draft"]);
        expect(createCalls).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("未采用创意也触发画布离开保护，创意任务运行时不可切换入口", async () => {
    resetFixture();
    const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1));
    try {
        await tap(view.container, "一句想法生成正文");
        await tap(view.container, "填写创意草稿");
        await closeIdeaDialog(view.container);
        await tap(view.container, "保留草稿并关闭");
        await tap(view.container, "画布");
        await tap(view.container, "新建画布");
        expect(navigations).toHaveLength(0);
        expect(view.container.querySelector('[aria-label="确认前往画布"]')).not.toBeNull();
        await tap(view.container, "继续编辑正文");
        expect(view.container.querySelector('[aria-label="独立创意任务"]')).not.toBeNull();
        await tap(view.container, "一句想法生成正文");
        expect(ideaDialog(view.container).querySelector('[aria-label="独立创意任务"]')?.getAttribute("data-dirty")).toBe("true");
        await tap(view.container, "模拟扩写开始");
        expect(Array.from(view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).every((tab) => tab.disabled)).toBe(true);
        await tap(view.container, "画布");
        expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("剧本");
        expect(navigations).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("新建画布确认期间切账号或卸载会取消请求，过期确认回调不能导航", async () => {
    for (const boundary of ["account", "unmount"]) {
        resetFixture();
        const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1));
        let disposed = false;
        try {
            await edit(field(view.container, "短剧正文"), "第一章\n待保留的旧账号正文");
            await tap(view.container, "画布");
            await tap(view.container, "新建画布");
            const oldGuard = canvasGuards.at(-1)!;
            const oldConfirm = button(view.container, "放弃未保存内容并前往画布");
            expect(view.container.querySelector('[aria-label="确认前往画布"]')).not.toBeNull();
            if (boundary === "account") {
                await act(async () => {
                    userStore.getState().setUser({ id: "user-b", username: "b", displayName: "账号B", role: "user", status: "active" });
                    await settle();
                });
            } else {
                await view.dispose();
                disposed = true;
            }
            await act(async () => {
                oldConfirm.click();
                expect(await oldGuard()).toBe(false);
                await settle();
            });
            expect(canvasDecisions).toEqual([false]);
            expect(canvasCreationCalls).toBe(0);
            expect(navigations).toHaveLength(0);
            expect(createCalls).toHaveLength(0);
            if (boundary === "account") {
                expect(field(view.container, "短剧正文").value).toBe("");
                expect(view.container.querySelector('[aria-label="确认前往画布"]')).toBeNull();
            }
        } finally {
            if (!disposed) await view.dispose();
        }
    }
});

test("画布创建忙碌期间冻结入口切换，完成后恢复且不启动短剧任务", async () => {
    resetFixture();
    canvasCreation = deferred<void>();
    const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1));
    try {
        await tap(view.container, "画布");
        await tap(view.container, "新建画布");
        expect(canvasCreationCalls).toBe(1);
        expect(navigations).toHaveLength(0);
        expect(Array.from(view.container.querySelectorAll<HTMLButtonElement>(".drama-entry-tabs [role='tab']")).every((tab) => tab.disabled)).toBe(true);
        expect(button(view.container, "新建画布").disabled).toBe(true);
        await tap(view.container, "剧本");
        expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("画布");
        await act(async () => {
            canvasCreation!.resolve();
            await settle();
        });
        expect(navigations).toEqual(["/canvas/new-draft"]);
        expect(Array.from(view.container.querySelectorAll<HTMLButtonElement>(".drama-entry-tabs [role='tab']")).every((tab) => !tab.disabled)).toBe(true);
        expect(createCalls).toHaveLength(0);
    } finally {
        canvasCreation.resolve();
        await view.dispose();
    }
});

async function submitRenameForm(container: HTMLElement, times = 1) {
    const form = container.querySelector<HTMLFormElement>('[aria-label="修改作品名称"] form');
    expect(form).not.toBeNull();
    await act(async () => {
        for (let index = 0; index < times; index += 1) form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await settle();
    });
}

async function rejectCreation(error: Error) {
    await act(async () => {
        pendingCreates.at(-1)!.reject(error);
        await settle();
    });
}

test("重名改名继续保存仅替换trim名称，空白和忙碌重复提交不创建作品", async () => {
    resetFixture();
    const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1));
    try {
        await tap(view.container, "剧集");
        await tap(view.container, "真人剧");
        await tap(view.container, "从剧本开始");
        await edit(field(view.container, "短剧正文"), "第1集\n第一集人工剧本。\n第2集\n第二集人工剧本。");
        await tap(view.container, "保存并确认正文");
        await rejectCreation(new ApiError("已有同名作品，请换一个名称", { status: 409, reason: "project_name_conflict" }));
        const dialog = view.container.querySelector<HTMLElement>('[aria-label="修改作品名称"]')!;
        const name = field(view.container, "新的作品名称");
        expect(name.value).toBe(createCalls[0].name);
        expect(document.activeElement).toBe(name);
        expect(field(view.container, "短剧正文").disabled).toBe(true);
        expect(field(view.container, "上传正文文件").disabled).toBe(true);
        await edit(name, "   ");
        expect(button(dialog, "继续保存").disabled).toBe(true);
        await submitRenameForm(view.container);
        expect(createCalls).toHaveLength(1);
        await edit(name, "  真人新篇  ");
        await submitRenameForm(view.container, 2);
        expect(createCalls).toHaveLength(2);
        expect(createCalls[1]).toEqual({ ...createCalls[0], name: "真人新篇" });
        expect(createCalls[1].settings.dramaType).toBe("live_action");
        expect(createCalls[1].sourceFormat).toBe("script");
        expect(name.disabled).toBe(true);
        expect(button(dialog, "继续保存").disabled).toBe(true);
        expect(button(dialog, "取消").disabled).toBe(true);
        expect(dialog.querySelector('[aria-label="关闭修改作品名称"]')).toBeNull();
        expect(dialog.dataset.maskClosable).toBe("false");
        expect(dialog.dataset.keyboard).toBe("false");
        await tap(dialog, "取消");
        await act(async () => {
            dialog.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await settle();
        });
        expect(view.container.contains(dialog)).toBe(true);
        expect(navigations).toHaveLength(0);
        await act(async () => {
            pendingCreates[1].resolve(summaryOf("renamed-entry", 1));
            await settle();
        });
        expect(view.container.querySelector('[aria-label="修改作品名称"]')).toBeNull();
        expect(navigations).toEqual(["/projects/renamed-entry/guide?step=review"]);
    } finally {
        await view.dispose();
    }
});

test("重名恢复按80个码点校验，重复重名和普通重试错误保留名称及行内反馈", async () => {
    resetFixture();
    const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1));
    try {
        await edit(field(view.container, "短剧正文"), "第一章\n需要改名的小说原文");
        await tap(view.container, "保存并确认正文");
        await rejectCreation(new ApiError("已有同名作品，请换一个名称", { status: 409, reason: "project_name_conflict" }));
        const name = field(view.container, "新的作品名称");
        await edit(name, "新".repeat(81));
        await submitRenameForm(view.container);
        expect(createCalls).toHaveLength(1);
        expect(view.container.querySelector('[aria-label="修改作品名称"] [role="alert"]')?.textContent).toBe("作品名称不能超过 80 字");
        const accepted = "🎬".repeat(80);
        await edit(name, accepted);
        await submitRenameForm(view.container);
        expect(createCalls.at(-1)?.name).toBe(accepted);
        await rejectCreation(new ApiError("这个名称仍然已存在", { status: 409, reason: "project_name_conflict" }));
        expect(name.value).toBe(accepted);
        expect(view.container.querySelector('[aria-label="修改作品名称"] [role="alert"]')?.textContent).toBe("这个名称仍然已存在");
        await edit(name, "下一次重试名称");
        await submitRenameForm(view.container);
        await rejectCreation(new Error("网络暂时中断"));
        expect(field(view.container, "新的作品名称").value).toBe("下一次重试名称");
        expect(view.container.querySelector('[aria-label="修改作品名称"] [role="alert"]')?.textContent).toBe("网络暂时中断");
        expect(notices).toEqual([]);
        expect(navigations).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("普通409或相同文案的普通错误不会误开改名弹窗", async () => {
    for (const error of [new ApiError("已有同名作品，请换一个名称", { status: 409, reason: "conflict" }), new Error("已有同名作品，请换一个名称")]) {
        resetFixture();
        const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1));
        try {
            await edit(field(view.container, "短剧正文"), "第一章\n保留普通错误后的正文");
            await tap(view.container, "保存并确认正文");
            await rejectCreation(error);
            expect(view.container.querySelector('[aria-label="修改作品名称"]')).toBeNull();
            expect(notices.at(-1)).toEqual({ kind: "error", text: error.message });
            expect(field(view.container, "短剧正文").value).toContain("保留普通错误后的正文");
        } finally {
            await view.dispose();
        }
    }
});

test("取消重名恢复保留上传正文文件及类型来源，重新保存不重复读文件", async () => {
    resetFixture();
    const view = await mount(() => createElement(DramaWorkflowEntry, { initialFile: new File(["原始文件"], "原作品（完结）.docx") }), summaryOf("project-a", 1));
    try {
        await act(async () => {
            fileReads[0].resolve("第1集\n文件中的原始分镜");
            await settle();
        });
        await tap(view.container, "剧集");
        await tap(view.container, "漫剧解说");
        await tap(view.container, "从分镜开始");
        await tap(view.container, "保存并确认正文");
        await rejectCreation(new ApiError("已有同名作品，请换一个名称", { status: 409, reason: "project_name_conflict" }));
        expect(field(view.container, "新的作品名称").value).toBe("原作品");
        await edit(field(view.container, "新的作品名称"), "未提交的新名称");
        await tap(view.container, "取消");
        expect(view.container.querySelector('[aria-label="修改作品名称"]')).toBeNull();
        expect(field(view.container, "短剧正文").value).toBe("第1集\n文件中的原始分镜");
        expect(view.container.querySelector(".drama-entry-upload-filename")?.textContent).toBe("原作品（完结）.docx");
        expect(createCalls).toHaveLength(1);
        expect(navigations).toHaveLength(0);
        await tap(view.container, "保存并确认正文");
        expect(createCalls[1]).toEqual(createCalls[0]);
        expect(createCalls[1].settings.dramaType).toBe("narration");
        expect(createCalls[1].sourceFormat).toBe("storyboard");
        expect(fileReads).toHaveLength(1);
    } finally {
        await view.dispose();
    }
});

test("切账号或卸载后迟到的重名失败不打开恢复窗或产生通知导航", async () => {
    for (const boundary of ["account", "unmount"]) {
        resetFixture();
        const view = await mount(() => createElement(DramaWorkflowEntry), summaryOf("project-a", 1));
        let disposed = false;
        try {
            await edit(field(view.container, "短剧正文"), "第一章\n旧会话的原文");
            await tap(view.container, "保存并确认正文");
            if (boundary === "account") {
                await act(async () => {
                    userStore.getState().setUser({ id: "user-b", username: "b", displayName: "账号B", role: "user", status: "active" });
                    await settle();
                });
            } else {
                await view.dispose();
                disposed = true;
            }
            await rejectCreation(new ApiError("旧会话重名", { status: 409, reason: "project_name_conflict" }));
            expect(view.container.querySelector('[aria-label="修改作品名称"]')).toBeNull();
            expect(notices).toEqual([]);
            expect(navigations).toHaveLength(0);
            if (boundary === "account") expect(field(view.container, "短剧正文").value).toBe("");
        } finally {
            if (!disposed) await view.dispose();
        }
    }
});
