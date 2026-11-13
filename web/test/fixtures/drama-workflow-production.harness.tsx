import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { DramaEpisodeDetail, DramaEpisodeRow, DramaSegment, DramaShot, DramaStudioActionRequest, DramaSummary } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/projects/project/guide?step=story&mode=simple" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    SVGElement: browser.SVGElement,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { MemoryRouter, Route, Routes, useLocation, useSearchParams } = await import("react-router");

const calls = {
    retried: [] as Array<[string, string | undefined]>,
    videos: [] as Array<[string, string, string | undefined]>,
    actions: [] as DramaStudioActionRequest[],
    changed: 0,
    episodes: [] as string[],
};
let episodeOverride: ((episodeId: string) => Promise<DramaEpisodeDetail>) | undefined;

beforeEach(() => {
    calls.retried = [];
    calls.videos = [];
    calls.actions = [];
    calls.changed = 0;
    calls.episodes = [];
    episodeOverride = undefined;
    details.clear();
    for (const [id, value] of initialDetails) details.set(id, value);
});

mock.module("lucide-react", () => Object.fromEntries(["ChevronDown", "Clapperboard", "Film", "Package", "RefreshCw", "Pencil", "Play"].map((name) => [name, () => createElement("svg", { "data-icon": name })])));

mock.module("antd", () => ({
    App: {
        useApp: () => ({
            message: { success: () => undefined, info: () => undefined, error: () => undefined },
        }),
    },
    Button: ({ children, icon, loading: _loading, size: _size, type: _type, ...props }: { children?: ReactNode; icon?: ReactNode; loading?: boolean; size?: string; type?: string } & Record<string, unknown>) =>
        createElement("button", props, icon, children),
    Select: ({ "aria-label": label, value, options, onChange }: { "aria-label"?: string; value?: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) =>
        createElement(
            "select",
            { "aria-label": label, value, onChange: (event: Event) => onChange((event.target as HTMLSelectElement).value) },
            options.map((option) => createElement("option", { key: option.value, value: option.value }, option.label)),
        ),
}));
mock.module("@/components/layout/workspace-state", () => ({
    WorkspaceErrorState: ({ title, description, actionLabel }: { title?: string; description?: string; actionLabel?: string }) => createElement("div", { role: "alert" }, title, description, actionLabel),
    WorkspaceLoadingState: ({ label }: { label: string }) => createElement("div", null, label),
}));
mock.module("@/services/api/drama", () => ({
    getDramaEpisode: async (_projectId: string, episodeId: string) => {
        calls.episodes.push(episodeId);
        if (episodeOverride) return episodeOverride(episodeId);
        const result = details.get(episodeId);
        if (!result) throw new Error("该集不存在");
        return result;
    },
    retryFailedDrama: async (_projectId: string, episodeId: string, target?: "text" | "render") => {
        calls.retried.push([episodeId, target]);
        return { jobs: 1 };
    },
}));
mock.module("@/pages/projects/studio/use-studio", () => ({
    dramaKeys: {
        summary: (projectId: string) => ["drama", projectId],
        episode: (projectId: string, episodeId: string) => ["drama", projectId, "episode", episodeId],
        episodes: (projectId: string) => ["drama", projectId, "episode"],
        cast: (projectId: string) => ["drama", projectId, "cast"],
        jobs: (projectId: string) => ["drama", projectId, "jobs"],
    },
    useDramaCast: () => ({ cast: [], byId: new Map() }),
    useDramaInvalidate: () => async () => undefined,
}));
mock.module("@/pages/projects/studio/use-drama-media-action", () => ({
    useDramaMediaAction: () => ({
        state: { open: false, request: null, preview: null, loading: false, submitting: false, submitted: false, queued: 0, pendingVideo: null },
        requestAction: (request: DramaStudioActionRequest) => calls.actions.push(request),
        requestVideo: (episode: { id: string }, segment: { id: string }, model?: { modelKey?: string }) => calls.videos.push([episode.id, segment.id, model?.modelKey]),
        requestCastImage: () => undefined,
        requestMissingAssets: () => undefined,
        recheckVideo: () => undefined,
        close: () => undefined,
        retry: () => undefined,
        confirm: async () => undefined,
    }),
}));
mock.module("@/pages/projects/studio/drama-media-action-dialog", () => ({
    DramaMediaActionDialog: () => null,
}));
mock.module("@/pages/projects/studio/queue-bar", () => ({
    QueueBar: ({ onJump }: { onJump: (job: { id: string; episodeId?: string; shotId?: string; kind: string }) => void }) =>
        createElement(
            "button",
            {
                type: "button",
                "aria-label": "定位队列任务",
                onClick: () => onJump({ id: "job-1", episodeId: "ep-ready", shotId: "segment-2", kind: "segment_video" }),
            },
            "队列",
        ),
}));
mock.module("@/pages/projects/simple-studio-segment-editor", () => ({
    SimpleStudioSegmentEditor: ({ episodeId, segmentIndex, onGenerate, onOpenCast }: { episodeId: string; segmentIndex?: number; onGenerate: (segment: DramaSegment, model?: { modelKey: string }) => void; onOpenCast: (id: string) => void }) =>
        segmentIndex === undefined
            ? null
            : createElement(
                  "div",
                  { "data-editor": `${episodeId}:${segmentIndex}` },
                  createElement("button", { type: "button", onClick: () => onGenerate(segment("segment-editor", segmentIndex), { modelKey: "video-a" }) }, "编辑器生成"),
                  createElement("button", { type: "button", onClick: () => onOpenCast("cast-1") }, "打开资产"),
              ),
}));
mock.module("@/pages/projects/studio/cast-editor-dialog", () => ({
    CastEditorDialog: ({ castId }: { castId: string }) => createElement("div", { role: "dialog", "aria-label": "资产设定" }, castId),
}));
mock.module("@/pages/projects/studio/asset-transfer", () => ({
    AssetPackageModal: ({ projectId, episodes, onClose }: { projectId: string; episodes: DramaEpisodeRow[]; onClose: () => void }) =>
        createElement("section", { role: "dialog", "aria-label": "导出资产包", "data-project": projectId, "data-episodes": episodes.map((episode) => episode.id).join(",") }, createElement("button", { onClick: onClose }, "关闭导出")),
}));
mock.module("@/pages/projects/simple-studio-final-card", () => ({
    SimpleEpisodeFinalCard: ({ episode }: { episode: DramaEpisodeRow }) => createElement("article", { "data-final": episode.id }, `第 ${episode.number} 集成片`),
}));
mock.module("@/pages/projects/drama-shared", () => ({
    MediaThumb: () => createElement("span", null, "缩略图"),
    mediaBusy: (status: string) => status === "queued" || status === "running",
    useResourceMediaUrl: () => "",
}));
mock.module("@/pages/projects/studio/segment-parts", () => ({
    secondsLabel: (ms: number) => `${ms / 1000}s`,
    segmentState: (segment: DramaSegment, phase: "video" | "prompt" = "video") => ({
        tone: segment.promptStatus === "failed" || segment.videoStatus === "failed" ? "failed" : (phase === "prompt" && (segment.custom || segment.promptStatus === "ready")) || segment.videoStatus === "ready" ? "ready" : "idle",
        label: segment.videoStatus || "待生成",
    }),
    SegmentStatus: ({ segment }: { segment: DramaSegment }) => createElement("span", null, segment.videoStatus || "待生成"),
}));

const { WorkflowProduction } = await import("@/pages/projects/workflow-production");

afterAll(() => {
    browser.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function episode(id: string, number: number, patch: Partial<DramaEpisodeRow> = {}): DramaEpisodeRow {
    return {
        id,
        number,
        title: `故事${number}`,
        synopsis: "",
        stage: "prompts",
        sourceFormat: "script",
        error: "",
        shotCount: 1,
        durationMs: 5000,
        approved: false,
        mediaReleased: false,
        awaitingMedia: true,
        finalStale: false,
        stats: { segments: 1, promptReady: 1, promptSucceeded: 1, videoReady: 0, videoGenerated: 0, failed: 0 },
        ...patch,
    };
}

function segment(id: string, index: number, patch: Partial<DramaSegment> = {}): DramaSegment {
    return {
        id,
        revision: 3,
        index,
        title: `场景${index + 1}`,
        shotIds: [`shot-${id}`],
        durationMs: 5000,
        videoPrompt: `${id}的真实提示词`,
        generated: `${id}的真实提示词`,
        custom: false,
        promptStatus: "ready",
        videoStatus: "",
        videoModel: { modelKey: "video" },
        referenceMode: "auto",
        audioReferenceMode: "auto",
        request: { operation: "text_to_video", seconds: 5, maxVideoSeconds: 10, aspectRatio: "16:9", generateAudio: false, firstFramePending: false, references: [], referenceCapacity: 0, modelMaxImages: 0, header: "" },
        ...patch,
    };
}

function shot(id: string, segmentIndex: number): DramaShot {
    return {
        id,
        projectId: "project",
        episodeId: "ep-ready",
        position: 0,
        segmentIndex,
        segmentTitle: "",
        scene: "街口",
        castIdsJson: "[]",
        lookCastIdsJson: "[]",
        propIdsJson: "[]",
        speaker: "林夏",
        dialogue: "别回头。",
        action: "",
        shotSize: "中景",
        camera: "固定",
        transition: "",
        durationMs: 5000,
        imagePrompt: "",
        videoPrompt: "",
        sourceQuote: "",
    };
}

function detail(row: DramaEpisodeRow, segments: DramaSegment[]): DramaEpisodeDetail {
    return {
        episode: { ...row, projectId: "project", hook: "", cliffhanger: "", chapterIdsJson: "[]", subtitleSrt: "", revision: 2 },
        shots: segments.map((item) => shot(item.shotIds[0] || item.id, item.index)),
        segments,
        chapters: [],
        jobs: [],
    };
}

const failed = episode("ep-failed", 2, { stage: "script", error: "分镜模型超时", shotCount: 0, stats: { segments: 0, promptReady: 0, promptSucceeded: 0, videoReady: 0, videoGenerated: 0, failed: 1 } });
const ready = episode("ep-ready", 1, { stage: "video", stats: { segments: 2, promptReady: 2, promptSucceeded: 2, videoReady: 0, videoGenerated: 0, failed: 0 }, shotCount: 2 });
const preview = episode("ep-preview", 3, { stage: "render", error: "封装失败", stats: { segments: 2, promptReady: 2, promptSucceeded: 2, videoReady: 1, videoGenerated: 1, failed: 1 } });
const initialDetails = new Map<string, DramaEpisodeDetail>([
    [failed.id, detail(failed, [])],
    [ready.id, detail(ready, [segment("segment-1", 0), segment("segment-2", 1, { videoResourceId: "video-2", videoStatus: "ready", videoSeconds: 5 })])],
    [preview.id, detail(preview, [segment("preview-1", 0, { videoStatus: "ready", videoResourceId: "video-preview", videoSeconds: 5 }), segment("preview-2", 1)])],
]);
const details = new Map(initialDetails);

function summary(step: DramaSummary["production"]["guideStep"], episodes: DramaEpisodeRow[]): DramaSummary {
    return {
        project: {
            id: "project",
            userId: "user",
            name: "真实短剧",
            type: "drama",
            aspectRatio: "16:9",
            sourceType: "drama",
            description: "",
            stylePresetId: "",
            status: "active",
            revision: 1,
            createdAt: "",
            updatedAt: "",
        },
        production: {
            revision: 4,
            guideStep: step,
            status: "paused",
            stage: "produce",
            pauseReason: "",
            settings: {
                aspectRatio: "16:9",
                episodeSeconds: 60,
                stylePrompt: "",
                styleName: "",
                language: "zh",
                assets: { mode: "portrait", characterPrompt: "", scenePrompt: "", characterRatio: "1:1" },
                storyboard: { segmentMode: "auto", segmentSeconds: 8, segmentMinSeconds: 4, segmentMaxSeconds: 12, pacing: "fast", dialogue: "standard", transition: "auto", transitionMs: 0, performance: 5, cameraMotion: 5 },
                reviewMode: "auto",
                mediaMode: "manual",
                concurrency: 1,
                models: { text: {}, image: {}, video: { modelKey: "video" } },
                referenceLimit: 0,
            },
            budgetMicrocredits: 0,
            spentMicrocredits: 0,
            canvasSpentMicrocredits: 0,
            heldMicrocredits: 0,
            planDone: true,
            planCursor: 0,
            sampleApproved: false,
            assetsReleased: false,
            logline: "",
            tone: "",
            chapterCount: episodes.length,
            wordCount: 100,
            reservedChapterCount: 0,
            reservedWordCount: 0,
        },
        episodes,
        jobCounts: {},
        inbox: [],
        castCount: 0,
    };
}

function LocationProbe() {
    const location = useLocation();
    return createElement("output", { "data-location": `${location.pathname}${location.search}` });
}

async function renderProduction(step: "story" | "preview", data: DramaSummary, path = "/projects/project/guide") {
    const host = document.createElement("div");
    document.body.append(host);
    const root: Root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    function ProductionRoute() {
        const [search] = useSearchParams();
        const active = search.get("step");
        return createElement(WorkflowProduction, {
            summary: data,
            step: active === "story" || active === "preview" ? active : step,
            onChanged: () => {
                calls.changed += 1;
            },
        });
    }
    await act(async () => {
        root.render(
            createElement(
                QueryClientProvider,
                { client },
                createElement(
                    MemoryRouter,
                    { initialEntries: [path] },
                    createElement(LocationProbe),
                    createElement(
                        Routes,
                        null,
                        createElement(Route, { path: "/projects/:projectId", element: createElement(ProductionRoute) }),
                        createElement(Route, { path: "/projects/:projectId/guide", element: createElement(ProductionRoute) }),
                        createElement(Route, { path: "/projects/:projectId/e/:episodeId", element: createElement(ProductionRoute) }),
                    ),
                ),
            ),
        );
    });
    await waitFor(() => client.isFetching() === 0);
    await settle();
    return {
        host,
        async dispose() {
            await act(async () => root.unmount());
            client.clear();
            host.remove();
        },
    };
}

async function settle() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((accept) => {
        resolve = accept;
    });
    return { promise, resolve };
}

async function waitFor(condition: () => boolean) {
    const deadline = Date.now() + 1000;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error("界面状态未按预期更新");
        await settle();
    }
}

async function click(host: ParentNode, label: string) {
    const button = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(label) || item.getAttribute("aria-label")?.includes(label));
    if (!button) throw new Error(`找不到 ${label}`);
    await act(async () => {
        button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

async function select(host: ParentNode, label: string, value: string) {
    const input = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
    expect(input).toBeTruthy();
    await act(async () => {
        input!.value = value;
        input!.dispatchEvent(new window.Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

test("失败且没有分镜的集保留错误和重试本集文字", async () => {
    const view = await renderProduction("story", summary("story", [failed, ready]));
    try {
        expect(view.host.textContent).toContain("分镜模型超时");
        expect(view.host.textContent).toContain("重试本集文字");
        await click(view.host, "重试本集文字");
        expect(calls.retried).toEqual([["ep-failed", "text"]]);
        expect(view.host.textContent).toContain("1 集剧本失败（第 2 集）");
        expect(view.host.textContent).toContain("剧本与分镜：1/2 集就绪");
        expect(view.host.textContent).not.toContain("AI 交流");
    } finally {
        await view.dispose();
    }
});

test("卡片编辑打开真实段，生成把该段交给媒体确认", async () => {
    const view = await renderProduction("story", summary("completed", [ready]));
    try {
        expect(view.host.textContent).toContain("segment-1的真实提示词");
        expect(view.host.textContent).toContain("林夏：别回头。");
        await click(view.host, "编辑第 1 集第 1 段");
        expect(view.host.querySelector("[data-editor]")?.getAttribute("data-editor")).toBe("ep-ready:0");
        await click(view.host, "打开资产");
        expect(view.host.querySelector("[role='dialog']")?.textContent).toContain("cast-1");
        await click(view.host, "编辑器生成");
        expect(calls.videos).toEqual([["ep-ready", "segment-editor", "video-a"]]);
        expect(view.host.querySelector("[data-editor]")).toBeNull();
        await click(view.host, "重新生成第 1 集第 2 段");
        expect(calls.videos.at(-1)?.[1]).toBe("segment-2");
    } finally {
        await view.dispose();
    }
});

test("文字尚未确认时视频按钮不绕过后台", async () => {
    const view = await renderProduction("story", summary("story", [ready]));
    try {
        const button = [...view.host.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === "生成视频第 1 集第 1 段");
        expect(button?.hasAttribute("disabled")).toBe(true);
        expect(button?.getAttribute("title")).toBe("需要先确认文字");
        await click(view.host, "编辑第 1 集第 1 段");
        await click(view.host, "编辑器生成");
        expect(calls.videos).toEqual([]);
    } finally {
        await view.dispose();
    }
});

test("预览缺视频时说明数量且不显示全剧已完成", async () => {
    const view = await renderProduction("preview", summary("completed", [preview]));
    try {
        expect(view.host.textContent).toContain("还有 1 段视频未就绪");
        expect(view.host.textContent).toContain("封装失败");
        expect(view.host.textContent).toContain("重试本集成片");
        expect(view.host.textContent).not.toContain("全剧已完成");
        await click(view.host, "重试本集成片");
        expect(calls.retried).toEqual([["ep-preview", "render"]]);
        await click(view.host, "回到分镜");
        expect(view.host.querySelector("[data-location]")?.getAttribute("data-location")).toContain("step=story");
        expect(view.host.querySelector("[data-location]")?.getAttribute("data-location")).toContain("mode=simple");
    } finally {
        await view.dispose();
    }
});

test("队列定位保留简易流程并打开对应段", async () => {
    const view = await renderProduction("preview", summary("completed", [ready]));
    try {
        await click(view.host, "定位队列任务");
        await waitFor(() => Boolean(view.host.querySelector("[data-editor]")));
        const location = view.host.querySelector("[data-location]")?.getAttribute("data-location") || "";
        expect(location).toContain("/projects/project?");
        expect(location).toContain("episode=ep-ready");
        expect(location).toContain("step=story");
        expect(location).toContain("mode=simple");
        expect(location).toContain("segment=1");
        expect(location).not.toContain("mode=advanced");
    } finally {
        await view.dispose();
    }
});

test("提示词进度保留失败红段，文字阶段筛选并可单段重新撰写", async () => {
    details.set(ready.id, detail(ready, [segment("segment-1", 0), segment("segment-2", 1, { promptStatus: "failed", promptError: "提示词模型超时" })]));
    const view = await renderProduction("story", summary("story", [ready]));
    try {
        expect(view.host.textContent).toContain("1 段已完成");
        expect(view.host.textContent).toContain("1 段失败");
        const progress = view.host.querySelector("[role='progressbar']");
        expect(progress?.getAttribute("aria-valuenow")).toBe("100");
        expect((progress?.querySelector(".is-success") as HTMLElement)?.style.width).toBe("50%");
        expect((progress?.querySelector(".is-failed") as HTMLElement)?.style.width).toBe("50%");
        await select(view.host, "筛选段状态", "ready");
        expect(view.host.querySelector("[data-segment-id='segment-1']")).toBeTruthy();
        expect(view.host.querySelector("[data-segment-id='segment-2']")).toBeNull();
        await select(view.host, "筛选段状态", "failed");
        expect(view.host.querySelector("[data-segment-id='segment-1']")).toBeNull();
        await click(view.host, "重新撰写第 1 集第 2 段提示词");
        expect(calls.actions).toEqual([{ action: "segment_prompt", targetId: "segment-2", episodeId: "ep-ready", episodeNumber: 1, segmentTitle: "场景2", targetRevision: 3 }]);
        expect(calls.videos).toEqual([]);
    } finally {
        await view.dispose();
    }
});

test("传统作品未设置guideStep也能生成，预览复用全剧资产包导出", async () => {
    const view = await renderProduction("story", summary(undefined, [ready, failed]));
    try {
        const generate = view.host.querySelector<HTMLButtonElement>("button[aria-label='生成视频第 1 集第 1 段']");
        expect(generate?.disabled).toBe(false);
        await click(view.host, "生成视频第 1 集第 1 段");
        expect(calls.videos).toEqual([["ep-ready", "segment-1", undefined]]);
        await click(view.host, "视频预览");
        expect(view.host.querySelector("[data-location]")?.getAttribute("data-location")).toContain("step=preview");
        await click(view.host, "导出资产包");
        const dialog = view.host.querySelector("[role='dialog'][aria-label='导出资产包']");
        expect(dialog?.getAttribute("data-project")).toBe("project");
        expect(dialog?.getAttribute("data-episodes")).toBe("ep-ready,ep-failed");
        await click(view.host, "关闭导出");
        expect(view.host.querySelector("[aria-label='导出资产包'][role='dialog']")).toBeNull();
    } finally {
        await view.dispose();
    }
});

test("读取失败在预览和文字进度中均可见", async () => {
    episodeOverride = async () => {
        throw new Error("读取失败");
    };
    const view = await renderProduction("story", summary("completed", [ready]));
    try {
        expect(view.host.textContent).toContain("1 集读取失败");
        expect(view.host.textContent).toContain("本集内容读取失败");
        await click(view.host, "视频预览");
        expect(view.host.textContent).toContain("本集内容读取失败");
        expect(view.host.querySelector("[data-segment-id]")).toBeNull();
    } finally {
        await view.dispose();
    }
});

test("分集详情的新失败不会被旧的成功摘要掩盖", async () => {
    const latest = detail(ready, []);
    latest.episode = { ...latest.episode, stage: "script", error: "最新剧本改编失败" };
    details.set(ready.id, latest);
    const view = await renderProduction("story", summary("story", [ready]));
    try {
        expect(view.host.textContent).toContain("最新剧本改编失败");
        expect(view.host.textContent).toContain("1 集剧本失败（第 1 集）");
        expect(view.host.textContent).toContain("剧本与分镜：0/1 集就绪");
        await click(view.host, "重试本集文字");
        expect(calls.retried).toEqual([["ep-ready", "text"]]);
    } finally {
        await view.dispose();
    }
});

test("队列定位的迟到详情不能覆盖用户新选中的集", async () => {
    const view = await renderProduction("preview", summary("completed", [ready, failed]));
    const pending = deferred<DramaEpisodeDetail>();
    try {
        episodeOverride = async (episodeId) => (episodeId === ready.id ? pending.promise : details.get(episodeId)!);
        await click(view.host, "定位队列任务");
        await select(view.host, "选择集数", failed.id);
        pending.resolve(details.get(ready.id)!);
        await settle();
        const location = view.host.querySelector("[data-location]")?.getAttribute("data-location") || "";
        expect(location).toContain("/e/ep-failed");
        expect(location).toContain("step=preview");
        expect(location).not.toContain("segment=");
        expect(view.host.querySelector("[data-editor]")).toBeNull();
    } finally {
        pending.resolve(details.get(ready.id)!);
        await view.dispose();
    }
});
