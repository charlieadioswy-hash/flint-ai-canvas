import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import type { Root } from "react-dom/client";
import type { DramaCast, DramaEpisodeDetail, DramaEpisodeRow, DramaSegment, DramaShot, DramaStudioActionRequest, DramaSummary, DramaWorkflowReadiness } from "@/services/api/drama";

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
    renders: [] as Array<[string, number]>,
    storyboards: [] as string[],
    ensured: [] as Array<[string, string]>,
    allowedMediaNavigation: [] as Array<{ pathname: string; search: string }>,
    warnings: [] as string[],
};
let episodeOverride: ((episodeId: string) => Promise<DramaEpisodeDetail>) | undefined;
let readinessOverride: (() => Promise<DramaWorkflowReadiness>) | undefined;
let ensureOverride: ((episodeId: string) => Promise<DramaEpisodeDetail>) | undefined;
const userStore = create(() => ({ user: { id: "user" } }));
const subject = { id: "cast-1", projectId: "project", kind: "character", name: "林夏" } as DramaCast;
let casts = [subject];
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
mock.module("@/stores/use-user-store", () => ({ useUserStore: userStore }));
mock.module("@/pages/projects/workflow-impact", () => ({ WorkflowImpact: () => null }));
mock.module("@/pages/projects/workflow-scene-splits", () => ({ WorkflowSceneSplits: () => null }));
mock.module("@/pages/projects/workflow-storyboard-dialog", () => ({ WorkflowStoryboardDialog: () => null }));
mock.module("@/components/ui/base/tooltip/ant-tooltip", () => ({ AntTooltip: ({ children }: { children: ReactNode }) => children }));
mock.module("@/components/ui/product/app-modal", () => ({ AppModal: () => null }));
mock.module("@/pages/projects/workflow-shot-media-dialog", () => ({
    WorkflowShotMediaDialog: ({
        shot,
        shots,
        segmentLabel,
        onClose,
        onDirtyChange,
        onSelectShot,
    }: {
        shot?: DramaShot;
        shots?: DramaShot[];
        segmentLabel?: string;
        onClose: () => void;
        onDirtyChange?: (dirty: boolean, busy?: boolean) => void;
        onSelectShot?: (shot: DramaShot, kind: "video") => void;
    }) =>
        shot
            ? createElement(
                  "section",
                  { "data-media-shot": shot.id, "data-media-shots": shots?.map((item) => item.id).join(","), "data-segment-label": segmentLabel },
                  createElement("button", { onClick: () => onDirtyChange?.(true, false) }, "修改镜头媒体"),
                  createElement("button", { onClick: () => onDirtyChange?.(false, true) }, "镜头媒体提交中"),
                  createElement("button", { onClick: onClose }, "媒体确认返回"),
                  ...(shots || []).map((item) => createElement("button", { key: item.id, onClick: () => onSelectShot?.(item, "video") }, `切换媒体 ${item.id}`)),
              )
            : null,
}));

beforeEach(() => {
    userStore.setState({ user: { id: "user" } });
    calls.retried = [];
    calls.videos = [];
    calls.actions = [];
    calls.changed = 0;
    calls.episodes = [];
    calls.renders = [];
    calls.storyboards = [];
    calls.ensured = [];
    calls.allowedMediaNavigation = [];
    calls.warnings = [];
    casts = [subject];
    episodeOverride = undefined;
    readinessOverride = undefined;
    ensureOverride = undefined;
    details.clear();
    for (const [id, value] of initialDetails) details.set(id, value);
});

mock.module("antd", () => ({
    App: {
        useApp: () => ({
            message: { success: () => undefined, info: () => undefined, error: () => undefined, warning: (value: string) => calls.warnings.push(value) },
        }),
    },
    Button: ({ children, icon, loading: _loading, size: _size, type: _type, ...props }: { children?: ReactNode; icon?: ReactNode; loading?: boolean; size?: string; type?: string } & Record<string, unknown>) =>
        createElement("button", props, icon, children),
    Input: () => null,
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
    updateDramaShot: async () => {
        throw new Error("此测试不应修改分镜");
    },
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
    getDramaWorkflowReadiness: async () => (readinessOverride ? readinessOverride() : workflowReadiness()),
    ensureDramaEpisodeStoryboard: async (projectId: string, episodeId: string) => {
        calls.ensured.push([projectId, episodeId]);
        if (ensureOverride) return ensureOverride(episodeId);
        const current = details.get(episodeId)!;
        const next = { ...current, episode: { ...current.episode, stage: "script" as const }, jobs: [{ id: `script-${episodeId}`, status: "queued" }] as DramaEpisodeDetail["jobs"] };
        details.set(episodeId, next);
        return next;
    },
    rescriptDramaEpisode: async (_projectId: string, episodeId: string) => {
        calls.storyboards.push(episodeId);
        const current = details.get(episodeId)!;
        const next = { ...current, episode: { ...current.episode, stage: "script" as const }, jobs: [{ id: "new-script", status: "queued" }] as DramaEpisodeDetail["jobs"] };
        details.set(episodeId, next);
        return next;
    },
    renderDramaEpisode: async (_projectId: string, episodeId: string, input: { expectedRevision: number }) => {
        calls.renders.push([episodeId, input.expectedRevision]);
        return { jobs: 1 };
    },
    insertDramaShot: async () => {
        throw new Error("本专项不执行插镜");
    },
}));
mock.module("@/services/api/drama-shot-media", () => ({ getDramaShotMedia: async () => ({ status: "idle", takes: [], config: {} }) }));
mock.module("@/pages/projects/studio/use-studio", () => ({
    dramaKeys: {
        summary: (projectId: string) => ["drama", projectId],
        episode: (projectId: string, episodeId: string) => ["drama", projectId, "episode", episodeId],
        episodes: (projectId: string) => ["drama", projectId, "episode"],
        cast: (projectId: string) => ["drama", projectId, "cast"],
        jobs: (projectId: string) => ["drama", projectId, "jobs"],
    },
    useDramaCast: () => ({ cast: casts, byId: new Map(casts.map((cast) => [cast.id, cast])) }),
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
mock.module("@/pages/projects/workflow-batch", () => ({
    WorkflowBatch: ({ targetIds, actions, onClearSelection, noticeMount }: { targetIds: string[]; actions: string[]; onClearSelection?: () => void; noticeMount?: HTMLElement | null }) =>
        createElement(
            "section",
            { "data-batch-targets": [...targetIds].sort().join(","), "data-batch-actions": actions.join(",") },
            createElement("button", { onClick: onClearSelection }, "清空批量选择"),
            noticeMount && targetIds.length ? createPortal(createElement("span", { role: "status" }, "等待上一段视频生成（需要它的最后一帧）"), noticeMount) : null,
        ),
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
    SimpleStudioSegmentEditor: ({
        episodeId,
        segmentIndex,
        onGenerate,
        onOpenCast,
        onClose,
    }: {
        episodeId: string;
        segmentIndex?: number;
        onGenerate: (segment: DramaSegment, model?: { modelKey: string }) => void;
        onOpenCast: (id: string) => void;
        onClose: () => void;
    }) =>
        segmentIndex === undefined
            ? null
            : createElement(
                  "div",
                  { "data-editor": `${episodeId}:${segmentIndex}` },
                  createElement("button", { type: "button", onClick: () => onGenerate(segment("segment-editor", segmentIndex), { modelKey: "video-a" }) }, "编辑器生成"),
                  createElement("button", { type: "button", onClick: () => onOpenCast("cast-1") }, "打开资产"),
                  createElement("button", { type: "button", onClick: onClose }, "关闭段编辑"),
              ),
}));
mock.module("@/pages/projects/studio/cast-editor-dialog", () => ({
    CastEditorDialog: ({ castId, episodeId }: { castId: string; episodeId?: string }) => createElement("div", { role: "dialog", "aria-label": "资产设定", "data-episode": episodeId }, castId),
}));
mock.module("@/pages/projects/studio/asset-transfer", () => ({
    AssetPackageModal: ({ projectId, episodes, onClose }: { projectId: string; episodes: DramaEpisodeRow[]; onClose: () => void }) =>
        createElement("section", { role: "dialog", "aria-label": "导出资产包", "data-project": projectId, "data-episodes": episodes.map((episode) => episode.id).join(",") }, createElement("button", { onClick: onClose }, "关闭导出")),
}));
mock.module("@/pages/projects/simple-studio-final-card", () => ({
    SimpleEpisodeFinalCard: ({ episode, blockingReason, readiness }: { episode: DramaEpisodeRow; blockingReason?: string; readiness?: { renderSource?: string } }) =>
        createElement("article", { "data-final": episode.id, "data-blocking-reason": blockingReason, "data-render-source": readiness?.renderSource }, `第 ${episode.number} 集成片`),
}));
mock.module("@/pages/projects/drama-shared", () => ({
    MediaThumb: () => createElement("span", null, "缩略图"),
    mediaBusy: (status: string) => status === "queued" || status === "running",
    useResourceMediaUrl: () => "",
    aspectRatioValue: () => "16 / 9",
    CAST_KIND_LABEL: { character: "角色", scene: "场景", prop: "道具", look: "造型" },
    parseList: (value?: string) => JSON.parse(value || "[]"),
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
        assetsReady: true,
        storyboardReady: true,
        videoReady: false,
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

function draftEpisode(id: string, number: number) {
    return episode(id, number, { stage: "draft", shotCount: 0, stats: { segments: 0, promptReady: 0, promptSucceeded: 0, videoReady: 0, videoGenerated: 0, failed: 0 } });
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

function workflowReadiness(readyIds: string[] = []): DramaWorkflowReadiness {
    return {
        revision: 4,
        guideStep: "story",
        episodes: [...details.values()].map(({ episode, segments }) => ({
            episodeId: episode.id,
            number: episode.number,
            title: episode.title,
            revision: episode.revision,
            textReady: readyIds.includes(episode.id),
            canGenerateVideo: readyIds.includes(episode.id),
            canRender: false,
            blockingReason: readyIds.includes(episode.id) ? undefined : "本集文字与提示词尚未就绪",
            segmentCount: segments.length,
            readyVideos: 0,
        })),
    };
}

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
                assets: { mode: "closeup_turnaround", characterPrompt: "", scenePrompt: "", characterRatio: "16:9" },
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

async function renderProduction(step: "story" | "preview", data: DramaSummary, path = "/projects/project/guide", waitForQueries = true, options: { busy?: boolean; headerActions?: ReactNode; onConfirmPreview?: (episodeId: string) => void } = {}) {
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
            onAllowMediaNavigation: (next) => calls.allowedMediaNavigation.push(next),
            ...options,
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
    if (waitForQueries) await waitFor(() => client.isFetching() === 0);
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

function actionButton(host: ParentNode, label: string) {
    return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
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
    const view = await renderProduction("story", summary("story", [failed, ready]), "/projects/project/guide?step=story&episode=ep-failed");
    try {
        expect(view.host.textContent).toContain("分镜模型超时");
        expect(view.host.textContent).toContain("重试本集文字");
        await click(view.host, "重试本集文字");
        expect(calls.retried).toEqual([["ep-failed", "text"]]);
        expect(calls.ensured).toEqual([]);
        expect(calls.storyboards).toEqual([]);
        expect(view.host.textContent).not.toContain("AI 交流");
    } finally {
        await view.dispose();
    }
});

test("分镜默认选中首集并保留真实分集选项，状态筛选不隐藏标题引导或固定队列", async () => {
    const data = summary("story", [failed, ready]);
    data.production.chapterCount = 2;
    data.production.reservedChapterCount = 7;
    const confirmed: string[] = [];
    const view = await renderProduction("story", data, "/projects/project/guide?step=story&status=ready", true, {
        headerActions: <span role="status">确认后完成本次分镜编排</span>,
        onConfirmPreview: (episodeId) => confirmed.push(episodeId),
    });
    try {
        expect(view.host.textContent).not.toContain("继续选章");
        const guidance = view.host.querySelectorAll('[aria-label="制作流程引导"]');
        expect(guidance).toHaveLength(1);
        expect(guidance[0].closest(".drama-workflow-production-toolbar")).not.toBeNull();
        expect(guidance[0].textContent).toContain("确认后完成本次分镜编排");
        const toolbar = guidance[0].closest(".drama-workflow-production-toolbar")!;
        expect(view.host.querySelector(".drama-workflow-production-episode > header")).toBeNull();
        expect([...view.host.querySelectorAll("button")].filter((item) => item.textContent === "视频预览")).toEqual([actionButton(toolbar, "视频预览")]);
        await click(toolbar, "视频预览");
        expect(confirmed).toEqual([ready.id]);
        const queue = view.host.querySelector('[aria-label="定位队列任务"]');
        expect(queue?.parentElement?.classList.contains("drama-workflow-production")).toBe(true);
        expect(queue?.closest(".drama-workflow-production-scroll")).toBeNull();
        const options = [...view.host.querySelectorAll('[aria-label="选择集数"] option')].map((option) => option.getAttribute("value"));
        expect(options).toEqual([failed.id, ready.id]);
        expect(view.host.querySelector<HTMLSelectElement>('[aria-label="选择集数"]')?.value).toBe(ready.id);
        expect(view.host.querySelector('[aria-label="第 2 集"]')).toBeNull();
        expect(calls.actions).toHaveLength(0);
        expect(calls.retried).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("继承选中的待制作集，载入详情后自动确保本集分镜且不调用重新生成", async () => {
    const draft = draftEpisode("ep-draft", 9);
    details.set(draft.id, detail(draft, []));
    const view = await renderProduction("story", summary("story", [ready, draft]), "/projects/project/guide?step=story&episode=ep-draft");
    try {
        await waitFor(() => calls.ensured.length === 1);
        expect([...new Set(calls.episodes)]).toEqual([draft.id]);
        expect(calls.ensured).toEqual([["project", draft.id]]);
        expect(calls.storyboards).toEqual([]);
        expect(calls.changed).toBe(1);
        expect(calls.retried).toHaveLength(0);
        expect(calls.actions).toHaveLength(0);
        expect(view.host.textContent).toContain("正在准备本集剧本与分镜");
        expect(view.host.querySelector<HTMLSelectElement>('[aria-label="选择集数"]')?.value).toBe(draft.id);
        await settle();
        expect(calls.ensured).toHaveLength(1);
    } finally {
        await view.dispose();
    }
});

test("已完成集实际没有镜头或段时自动确保分镜，旧镜头计数不阻止启动", async () => {
    const emptyDone = episode("ep-empty-done", 4, { stage: "done", shotCount: 7 });
    details.set(emptyDone.id, detail(emptyDone, []));
    const view = await renderProduction("story", summary("story", [emptyDone]));
    try {
        await waitFor(() => calls.ensured.length === 1);
        expect(calls.ensured).toEqual([["project", emptyDone.id]]);
        expect(calls.storyboards).toEqual([]);
        expect(calls.retried).toEqual([]);
        expect(view.host.textContent).toContain("正在准备本集剧本与分镜");
        await settle();
        expect(calls.ensured).toHaveLength(1);
    } finally {
        await view.dispose();
    }
});

test("分镜继承路由或查询集，旧全部集范围仍只显示当前集", async () => {
    for (const [path, expectedId] of [
        ["/projects/project/guide?step=story&episode=ep-preview", preview.id],
        ["/projects/project/e/ep-preview?step=story&episode=ep-ready&scope=all", preview.id],
        ["/projects/project/guide?step=story&scope=all", ready.id],
    ]) {
        const view = await renderProduction("story", summary("completed", [ready, preview]), path);
        try {
            expect(view.host.querySelector<HTMLSelectElement>('[aria-label="选择集数"]')?.value).toBe(expectedId);
            expect(view.host.querySelectorAll(".drama-workflow-production-episode")).toHaveLength(1);
            expect(view.host.querySelector(`[aria-label="第 ${expectedId === ready.id ? 1 : 3} 集"]`)).toBeTruthy();
            expect(view.host.querySelector('[aria-label="选择集数"] option[value="all"]')).toBeNull();
            expect(calls.ensured).toEqual([]);
            expect(calls.storyboards).toEqual([]);
        } finally {
            await view.dispose();
        }
    }
});

test("明确指定的集失效时显示不存在，不自动切到其他空集开工", async () => {
    const draft = draftEpisode("ep-draft", 4);
    details.set(draft.id, detail(draft, []));
    for (const path of ["/projects/project/e/deleted?step=story&episode=ep-draft", "/projects/project/guide?step=story&episode=deleted"]) {
        const view = await renderProduction("story", summary("story", [draft]), path);
        try {
            expect(view.host.textContent).toContain("所选集不存在");
            expect(calls.ensured).toEqual([]);
            expect(calls.storyboards).toEqual([]);
        } finally {
            await view.dispose();
        }
    }
});

test("分镜等待详情读取后才启动，迟到详情不启动旧集且切集只启动当前集", async () => {
    const first = draftEpisode("ep-first", 4);
    const second = draftEpisode("ep-second", 5);
    const firstDetail = detail(first, []);
    details.set(first.id, firstDetail);
    details.set(second.id, detail(second, []));
    const pending = deferred<DramaEpisodeDetail>();
    episodeOverride = async (episodeId) => (episodeId === first.id ? pending.promise : details.get(episodeId)!);
    const view = await renderProduction("story", summary("story", [first, second]), undefined, false);
    try {
        expect(calls.ensured).toEqual([]);
        await select(view.host, "选择集数", second.id);
        await waitFor(() => calls.ensured.length === 1);
        expect(calls.ensured).toEqual([["project", second.id]]);
        await act(async () => pending.resolve(firstDetail));
        await settle();
        expect(calls.ensured).toHaveLength(1);
        await select(view.host, "选择集数", first.id);
        await waitFor(() => calls.ensured.length === 2);
        expect(calls.ensured).toEqual([
            ["project", second.id],
            ["project", first.id],
        ]);
        await select(view.host, "选择集数", second.id);
        await settle();
        expect(calls.ensured).toHaveLength(2);
        expect(calls.storyboards).toEqual([]);
    } finally {
        pending.resolve(firstDetail);
        await view.dispose();
    }
});

test("已有镜头或段、正在处理、失败及异常空状态的集均不自动生成分镜", async () => {
    const draft = draftEpisode("ep-draft", 4);
    const onlyShots = detail(draft, []);
    onlyShots.shots = [shot("existing-shot", 0)];
    const onlySegments = detail(draft, [segment("existing-segment", 0)]);
    onlySegments.shots = [];
    const queued = detail(draft, []);
    queued.jobs = [{ id: "script-queued", kind: "script", status: "queued" }] as DramaEpisodeDetail["jobs"];
    const running = detail(draft, []);
    running.scriptJob = { id: "script-running", kind: "script", status: "running" } as NonNullable<DramaEpisodeDetail["scriptJob"]>;
    const failedJob = detail(draft, []);
    failedJob.scriptJob = { id: "script-failed", kind: "script", status: "failed", error: "分镜模型失败" } as NonNullable<DramaEpisodeDetail["scriptJob"]>;
    const failedEpisode = detail({ ...draft, error: "本集编排失败" }, []);
    const processing = (["queued", "script", "render", "prompts", "review", "video"] as const).map((stage) => detail({ ...draft, stage }, []));
    for (const value of [onlyShots, onlySegments, queued, running, failedJob, failedEpisode, ...processing]) {
        details.set(draft.id, value);
        const view = await renderProduction("story", summary("story", [draft]));
        try {
            await settle();
            expect(calls.ensured).toEqual([]);
            expect(calls.storyboards).toEqual([]);
            expect(calls.retried).toEqual([]);
        } finally {
            await view.dispose();
        }
    }
});

test("自动启动失败不循环提交，可手动只重试当前集的非破坏性确保接口", async () => {
    const draft = draftEpisode("ep-draft", 4);
    details.set(draft.id, detail(draft, []));
    ensureOverride = async () => {
        throw new Error("分镜提交失败，请重试");
    };
    const view = await renderProduction("story", summary("story", [draft, ready]), "/projects/project/guide?step=story&episode=ep-draft");
    try {
        await waitFor(() => calls.ensured.length === 1 && actionButton(view.host, "生成分镜")?.disabled === false);
        await settle();
        await click(view.host, "刷新制作进度");
        await settle();
        expect(calls.ensured).toEqual([["project", draft.id]]);
        ensureOverride = undefined;
        await click(view.host, "生成分镜");
        await waitFor(() => calls.ensured.length === 2);
        expect(calls.ensured).toEqual([
            ["project", draft.id],
            ["project", draft.id],
        ]);
        expect(calls.storyboards).toEqual([]);
        expect(calls.retried).toEqual([]);
        expect(view.host.textContent).toContain("正在准备本集剧本与分镜");
    } finally {
        await view.dispose();
    }
});

test("视频预览只列出分镜就绪的集，切换可预览集不自动生成分镜", async () => {
    const first = draftEpisode("ep-first", 4);
    const second = draftEpisode("ep-second", 5);
    const draft = { ...draftEpisode("ep-unstarted", 6), storyboardReady: false };
    details.set(first.id, detail(first, []));
    details.set(second.id, detail(second, []));
    const view = await renderProduction("preview", summary("preview", [first, second, draft]));
    try {
        expect(view.host.querySelector<HTMLSelectElement>('[aria-label="选择集数"]')?.value).toBe("all");
        expect(view.host.querySelector('[aria-label="选择集数"] option[value="all"]')).toBeTruthy();
        expect(view.host.querySelector(`[aria-label="选择集数"] option[value="${draft.id}"]`)).toBeNull();
        expect(view.host.querySelectorAll("[data-final]")).toHaveLength(2);
        await select(view.host, "选择集数", second.id);
        expect(view.host.querySelectorAll("[data-final]")).toHaveLength(1);
        expect(view.host.querySelector(`[data-final="${second.id}"]`)).toBeTruthy();
        expect(calls.ensured).toEqual([]);
        expect(calls.storyboards).toEqual([]);
    } finally {
        await view.dispose();
    }
});

test("主工作区编辑真实段，段生成传真实目标且不重复展示连续视频卡片", async () => {
    const view = await renderProduction("story", summary("completed", [ready]));
    try {
        expect(view.host.querySelector("[aria-label='第 1 段分镜']")).toBeTruthy();
        expect(view.host.textContent).toContain("【林夏】别回头。");
        expect(view.host.textContent).not.toContain("本集连续视频");
        expect(view.host.textContent).not.toContain("幕");
        const segmentCounts = view.host.querySelector('[aria-label="第 1 集段列表"] header');
        expect(segmentCounts?.querySelector("strong")?.textContent).toBe("共 2 段");
        expect(segmentCounts?.querySelector("span")?.textContent).toBe("2 镜");
        await click(view.host, "编辑本段");
        expect(view.host.querySelector("[data-editor]")?.getAttribute("data-editor")).toBe("ep-ready:0");
        await click(view.host, "打开资产");
        expect(view.host.querySelector("[role='dialog']")?.textContent).toContain("cast-1");
        expect(view.host.querySelector("[aria-label='资产设定']")?.getAttribute("data-episode")).toBe(ready.id);
        await click(view.host, "编辑器生成");
        expect(calls.videos).toEqual([["ep-ready", "segment-editor", "video-a"]]);
        expect(view.host.querySelector("[data-editor]")).toBeNull();
        await click(view.host, "查看第 2 段");
        expect(view.host.querySelector("[data-editor]")).toBeNull();
        await click(view.host, "重新生成本段视频");
        expect(calls.videos.at(-1)?.[1]).toBe("segment-2");
    } finally {
        await view.dispose();
    }
});

test("分镜逐集打开主体使用镜头所属集，切集或切账号后关闭旧主体窗口", async () => {
    for (const row of [ready, preview]) {
        const current = details.get(row.id)!;
        details.set(row.id, { ...current, shots: current.shots.map((item) => ({ ...item, castIdsJson: JSON.stringify([subject.id]) })) });
    }
    const view = await renderProduction("story", summary("completed", [ready, preview]), "/projects/project/e/ep-ready?step=story&scope=all");
    try {
        expect(view.host.querySelector('[aria-label="第 3 集"]')).toBeNull();
        await click(view.host.querySelector('[aria-label="第 1 集"]')!, subject.name);
        expect(view.host.querySelector("[aria-label='资产设定']")?.getAttribute("data-episode")).toBe(ready.id);
        await select(view.host, "选择集数", preview.id);
        expect(view.host.querySelector("[aria-label='资产设定']")).toBeNull();
        await waitFor(() => view.host.querySelector('[aria-label="第 3 集"]')?.textContent?.includes(subject.name) === true);
        await click(view.host.querySelector('[aria-label="第 3 集"]')!, subject.name);
        expect(view.host.querySelector("[aria-label='资产设定']")?.getAttribute("data-episode")).toBe(preview.id);
        await select(view.host, "选择集数", ready.id);
        expect(view.host.querySelector("[aria-label='资产设定']")).toBeNull();
        await click(view.host.querySelector('[aria-label="第 1 集"]')!, subject.name);
        expect(view.host.querySelector("[aria-label='资产设定']")?.getAttribute("data-episode")).toBe(ready.id);
        await act(async () => userStore.setState({ user: { id: "other-user" } }));
        expect(view.host.querySelector("[aria-label='资产设定']")).toBeNull();
    } finally {
        await view.dispose();
    }
});

test("文字尚未确认时视频按钮不绕过后台", async () => {
    const view = await renderProduction("story", summary("story", [ready]));
    try {
        const button = actionButton(view.host, "生成本段视频");
        expect(button?.hasAttribute("disabled")).toBe(true);
        expect(button?.getAttribute("title")).toBe("请先确认文字与提示词");
        expect(view.host.textContent).toContain("本集文字与提示词尚未就绪");
        await click(view.host, "编辑本段");
        await click(view.host, "编辑器生成");
        expect(calls.videos).toEqual([]);
    } finally {
        await view.dispose();
    }
});

test("story 中就绪集可直接请求视频和编辑器生成，不等待另一失败集", async () => {
    readinessOverride = async () => workflowReadiness([ready.id]);
    const view = await renderProduction("story", summary("story", [ready, failed]));
    try {
        expect(actionButton(view.host, "生成本段视频")?.disabled).toBe(false);
        const notice = view.host.querySelector(".drama-workflow-production-episode-notice");
        expect(notice?.textContent).toBe("本集文字已就绪，可独立生成视频；其他集可继续处理。");
        expect(notice?.parentElement?.previousElementSibling?.textContent).toBe("下载全部素材");
        await act(async () => view.host.querySelector<HTMLInputElement>('input[aria-label="选择第 1 集第 1 段"]')!.click());
        expect([...notice!.parentElement!.querySelectorAll('[role="status"]')].map((item) => item.textContent)).toEqual(["本集文字已就绪，可独立生成视频；其他集可继续处理。", "等待上一段视频生成（需要它的最后一帧）"]);
        expect(view.host.textContent).not.toContain("分镜模型超时");
        expect(calls.episodes).toEqual([ready.id]);
        expect(view.host.querySelector("[data-batch-actions]")?.getAttribute("data-batch-actions")).toContain("segment_video");
        await click(view.host, "生成本段视频");
        await click(view.host, "编辑本段");
        await click(view.host, "编辑器生成");
        expect(calls.videos.map((call) => call[0])).toEqual([ready.id, ready.id]);
        await click(view.host, "视频预览");
        expect(view.host.querySelector("[data-location]")?.getAttribute("data-location")).toContain(`/e/${ready.id}?step=preview`);
        expect(view.host.querySelector('[aria-label="第 1 集预览"]')).not.toBeNull();
    } finally {
        await view.dispose();
    }
});

test("本集 readiness 读取失败或 production/episode 版本过期均不放行视频", async () => {
    for (const invalid of ["failed", "production-version", "episode-version"]) {
        readinessOverride = async () => {
            if (invalid === "failed") throw new Error("readiness unavailable");
            const result = workflowReadiness([ready.id]);
            if (invalid === "production-version") result.revision--;
            else result.episodes.find((row) => row.episodeId === ready.id)!.revision--;
            return result;
        };
        const view = await renderProduction("story", summary("story", [ready]));
        try {
            expect(actionButton(view.host, "生成本段视频")?.disabled).toBe(true);
            await click(view.host, "编辑本段");
            await click(view.host, "编辑器生成");
            expect(calls.videos).toEqual([]);
            expect(view.host.querySelector("[data-editor]")).not.toBeNull();
        } finally {
            await view.dispose();
        }
    }
});

test("readiness 加载时保持禁用，返回当前本集版本后才启用", async () => {
    const pending = deferred<DramaWorkflowReadiness>();
    readinessOverride = () => pending.promise;
    const view = await renderProduction("story", summary("story", [ready]), undefined, false);
    try {
        expect(actionButton(view.host, "生成本段视频")?.disabled).toBe(true);
        await act(async () => {
            pending.resolve(workflowReadiness([ready.id]));
            await new Promise((resolve) => setTimeout(resolve, 10));
        });
        await waitFor(() => actionButton(view.host, "生成本段视频")?.disabled === false);
    } finally {
        pending.resolve(workflowReadiness([ready.id]));
        await view.dispose();
    }
});

test("story 已就绪集失败合成按本集版本重试，不调用受全局阶段限制的旧重试", async () => {
    readinessOverride = async () => {
        const result = workflowReadiness([preview.id]);
        result.episodes.find((row) => row.episodeId === preview.id)!.canRender = true;
        return result;
    };
    const view = await renderProduction("preview", summary("story", [preview, failed]));
    try {
        expect(view.host.querySelector("[data-final='ep-preview']")?.getAttribute("data-blocking-reason")).toBe("");
        await click(view.host, "重试本集成片");
        expect(calls.renders).toEqual([[preview.id, 2]]);
        expect(calls.retried).toEqual([]);
    } finally {
        await view.dispose();
    }
});

test("跨集批量选择使用真实段 ID，切筛选与集数保留选择，清空只影响勾选", async () => {
    const view = await renderProduction("story", summary("completed", [ready, preview]));
    const batchTargets = () => view.host.querySelector("[data-batch-targets]")?.getAttribute("data-batch-targets");
    const check = async (label: string) => {
        const input = view.host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
        expect(input).toBeTruthy();
        await act(async () => {
            input!.click();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    };
    try {
        const batch = view.host.querySelector('[aria-label="已选剧情段批量操作"]');
        expect(batch).not.toBeNull();
        expect(batch?.closest(".drama-workflow-production-toolbar")).not.toBeNull();
        expect(view.host.querySelectorAll("[data-batch-targets]")).toHaveLength(1);
        expect(batchTargets()).toBe("");
        const list = view.host.querySelector('[aria-label="第 1 集段列表"]');
        expect(list).not.toBeNull();
        expect(Boolean(batch!.compareDocumentPosition(list!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
        await check("选择第 1 集第 2 段");
        await select(view.host, "选择集数", preview.id);
        await waitFor(() => Boolean(view.host.querySelector('input[aria-label="选择第 3 集第 2 段"]')));
        await check("选择第 3 集第 2 段");
        expect(batchTargets()).toBe("preview-2,segment-2");
        await select(view.host, "筛选段状态", "ready");
        expect(batchTargets()).toBe("preview-2,segment-2");
        await select(view.host, "选择集数", "ep-ready");
        expect(batchTargets()).toBe("preview-2,segment-2");
        await click(view.host, "清空批量选择");
        expect(batchTargets()).toBe("");
        expect(calls.actions).toHaveLength(0);
        expect(calls.videos).toHaveLength(0);
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

test("队列定位保留简易流程并选中对应段，不自动打开编辑器", async () => {
    const view = await renderProduction("preview", summary("completed", [ready]));
    try {
        await click(view.host, "定位队列任务");
        await waitFor(() => Boolean(view.host.querySelector("[aria-label='第 2 段分镜']")));
        expect(view.host.querySelector("[data-editor]")).toBeNull();
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

test("提示词生成失败后可筛选和重试对应段", async () => {
    details.set(ready.id, detail(ready, [segment("segment-1", 0), segment("segment-2", 1, { promptStatus: "failed", promptError: "提示词模型超时" })]));
    const view = await renderProduction("story", summary("story", [ready]));
    try {
        await select(view.host, "筛选段状态", "ready");
        expect(view.host.querySelector("[aria-label='查看第 1 段：场景1']")).toBeTruthy();
        expect(view.host.querySelector("[aria-label='查看第 2 段：场景2']")).toBeNull();
        await select(view.host, "筛选段状态", "failed");
        expect(view.host.querySelector("[aria-label='查看第 1 段：场景1']")).toBeNull();
        await click(view.host, "重试本段提示词");
        expect(calls.actions).toEqual([{ action: "segment_prompt", targetId: "segment-2", episodeId: "ep-ready", episodeNumber: 1, segmentTitle: "场景2", targetRevision: 3 }]);
        expect(calls.videos).toEqual([]);
    } finally {
        await view.dispose();
    }
});

test("传统作品未设置guideStep也能生成，预览复用全剧资产包导出", async () => {
    const view = await renderProduction("story", summary(undefined, [ready, failed]));
    try {
        const generate = actionButton(view.host, "生成本段视频");
        expect(generate?.disabled).toBe(false);
        await click(view.host, "生成本段视频");
        expect(calls.videos).toEqual([["ep-ready", "segment-1", undefined]]);
        await click(view.host, "视频预览");
        expect(view.host.querySelector("[data-location]")?.getAttribute("data-location")).toContain("step=preview");
        await click(view.host, "下载全部素材");
        const dialog = view.host.querySelector("[role='dialog'][aria-label='导出资产包']");
        expect(dialog?.getAttribute("data-project")).toBe("project");
        expect(dialog?.getAttribute("data-episodes")).toBe("ep-ready,ep-failed");
        await click(view.host, "关闭导出");
        expect(view.host.querySelector("[aria-label='导出资产包'][role='dialog']")).toBeNull();
    } finally {
        await view.dispose();
    }
});

test("读取失败在分镜和视频预览中均可见", async () => {
    episodeOverride = async () => {
        throw new Error("读取失败");
    };
    const view = await renderProduction("story", summary("completed", [ready]));
    try {
        expect(view.host.textContent).toContain("本集内容读取失败");
        expect(calls.ensured).toEqual([]);
        expect(calls.storyboards).toEqual([]);
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
        await click(view.host, "重试本集文字");
        expect(calls.retried).toEqual([["ep-ready", "text"]]);
    } finally {
        await view.dispose();
    }
});

test("全镜头采用结果就绪时预览采用镜头计数，不再按缺失段视频阻塞", async () => {
    readinessOverride = async () => ({
        ...workflowReadiness([ready.id]),
        guideStep: "completed",
        episodes: workflowReadiness([ready.id]).episodes.map((row) => ({ ...row, canRender: true, renderSource: "shots", renderVideoCount: 2, renderReadyVideos: 2 })),
    });
    const view = await renderProduction("preview", summary("completed", [ready]));
    try {
        await waitFor(() => view.host.querySelector("[data-render-source='shots']") !== null);
        expect(view.host.textContent).toContain("2/2 镜视频就绪");
        expect(view.host.textContent).not.toContain("段视频未就绪");
        expect(view.host.querySelector("[data-final]")?.getAttribute("data-blocking-reason")).toBe("");
    } finally {
        await view.dispose();
    }
});

test("分镜卡片进入视频前检查当前镜头的造型、场景和道具图片", async () => {
    const readyDetail = details.get(ready.id)!;
    const look = { ...subject, id: "work-look", parentId: subject.id, lookName: "工作装", imageResourceId: "look-image" };
    const scene = { ...subject, id: "street", kind: "scene", name: "街口" } as DramaCast;
    const prop = { ...subject, id: "key", kind: "prop", name: "钥匙" } as DramaCast;
    casts = [subject, look, scene, prop, { ...subject, id: "unrelated", name: "其他角色" }];
    details.set(ready.id, {
        ...readyDetail,
        shots: readyDetail.shots.map((item) => ({ ...item, castIdsJson: '["cast-1"]', lookCastIdsJson: '["work-look"]', propIdsJson: '["key"]', sceneCastId: "street" })),
    });
    const path = "/projects/project/guide?step=story&episode=ep-ready";
    const data = summary("completed", [ready]);
    const view = await renderProduction("story", data, path);
    try {
        await click(view.host, "编辑分镜 1 的媒体");
        expect(calls.warnings).toEqual(["请先生成这些资产的图片：钥匙、街口"]);
        expect(view.host.querySelector("[data-location]")?.getAttribute("data-location")).toBe(path);
        expect(view.host.querySelector("[data-media-shot]")).toBeNull();
    } finally {
        await view.dispose();
    }
    casts = [subject, look, { ...scene, imageResourceId: "street-image" }, { ...prop, imageResourceId: "key-image" }];
    const readyView = await renderProduction("story", data, path);
    try {
        await click(readyView.host, "编辑分镜 1 的媒体");
        await waitFor(() => Boolean(readyView.host.querySelector("[data-media-shot]")));
        expect(readyView.host.querySelector("[data-location]")?.getAttribute("data-location")).toContain("media=video");
        expect(calls.warnings).toHaveLength(1);
    } finally {
        await readyView.dispose();
    }
});

test("镜头媒体草稿或提交中阻止队列定位，明确内部返回给出准确单次目标", async () => {
    const path = "/projects/project/guide?step=story&episode=ep-ready&editor=media&shot=shot-segment-1&media=video";
    const view = await renderProduction("story", summary("completed", [ready]), path, true, { headerActions: <span>分镜流程提示</span> });
    try {
        expect(view.host.querySelector("[data-media-shot='shot-segment-1']")).toBeTruthy();
        expect(view.host.querySelector('[aria-label="制作流程引导"]')).toBeNull();
        expect(view.host.querySelector('[aria-label="定位队列任务"]')?.closest(".drama-workflow-production-scroll")).toBeNull();
        await click(view.host, "修改镜头媒体");
        await click(view.host, "定位队列任务");
        expect(view.host.querySelector("[data-location]")?.getAttribute("data-location")).toBe(path);
        await click(view.host, "镜头媒体提交中");
        await click(view.host, "定位队列任务");
        expect(calls.allowedMediaNavigation).toHaveLength(0);
        expect(view.host.querySelector("[data-location]")?.getAttribute("data-location")).toBe(path);
        await click(view.host, "媒体确认返回");
        expect(calls.allowedMediaNavigation).toHaveLength(1);
        const allowed = calls.allowedMediaNavigation[0];
        expect(allowed.pathname).toBe("/projects/project/e/ep-ready");
        expect(allowed.search).not.toContain("editor=");
        expect(`${allowed.pathname}${allowed.search}`).toBe(view.host.querySelector("[data-location]")?.getAttribute("data-location"));
        expect(view.host.querySelector('[aria-label="制作流程引导"]')?.textContent).toContain("分镜流程提示");
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

test("URL段仅定位，旧全部集范围收敛为选中单集，编辑关闭后仍停在原段", async () => {
    const view = await renderProduction("story", summary("completed", [ready, preview]), "/projects/project/guide?step=story&scope=all&episode=ep-ready&segment=1");
    try {
        const selected = () => view.host.querySelector("[aria-label='第 1 集段列表'] [aria-pressed='true']")?.getAttribute("aria-label");
        expect(selected()).toBe("查看第 2 段：场景2");
        expect(view.host.querySelector("[aria-label='第 3 集段列表']")).toBeNull();
        expect(view.host.querySelector("[data-editor]")).toBeNull();
        await click(view.host.querySelector("[aria-label='第 1 集段列表']")!, "查看第 1 段");
        expect(selected()).toBe("查看第 1 段：场景1");
        expect(view.host.querySelector("[data-location]")?.getAttribute("data-location")).toContain("segment=0");
        expect(view.host.querySelector("[data-location]")?.getAttribute("data-location")).not.toContain("scope=all");
        expect(view.host.querySelector("[aria-label='第 3 集段列表']")).toBeNull();
        expect(view.host.querySelector("[data-editor]")).toBeNull();
        await click(view.host, "编辑本段");
        expect(view.host.querySelector("[data-editor]")?.getAttribute("data-editor")).toBe("ep-ready:0");
        expect(view.host.querySelector("[data-location]")?.getAttribute("data-location")).toContain("editor=segment");
        await click(view.host, "关闭段编辑");
        expect(view.host.querySelector("[data-editor]")).toBeNull();
        expect(selected()).toBe("查看第 1 段：场景1");
    } finally {
        await view.dispose();
    }
});

test("媒体条按真实segmentIndex隔离同场景异段镜头，切镜和返回校正URL段", async () => {
    const value = detail(ready, [segment("source-3", 3), segment("source-8", 8)]);
    value.shots = [shot("source-8a", 8), shot("source-3a", 3), shot("source-8b", 8)];
    details.set(ready.id, value);
    const view = await renderProduction("story", summary("completed", [ready]), "/projects/project/guide?step=story&episode=ep-ready&segment=3&editor=media&shot=source-8a&media=image");
    try {
        const panel = () => view.host.querySelector("[data-media-shot]");
        expect(panel()?.getAttribute("data-segment-label")).toBe("第 9 段");
        expect(panel()?.getAttribute("data-media-shots")).toBe("source-8a,source-8b");
        expect(view.host.textContent).not.toContain("切换媒体 source-3a");
        await click(view.host, "切换媒体 source-8b");
        expect(panel()?.getAttribute("data-media-shot")).toBe("source-8b");
        expect(view.host.querySelector("[data-location]")?.getAttribute("data-location")).toContain("segment=8");
        expect(view.host.querySelector("[data-location]")?.getAttribute("data-location")).toContain("media=video");
        await click(view.host, "媒体确认返回");
        expect(panel()).toBeNull();
        expect(view.host.querySelector("[aria-label='第 9 段分镜']")).toBeTruthy();
        expect(view.host.querySelector("[data-editor]")).toBeNull();
    } finally {
        await view.dispose();
    }
});

test("段失败重试仅传当前真实段，后处理重试不调用整集或重新生成", async () => {
    details.set(ready.id, detail(ready, [segment("recoverable", 4, { videoStatus: "failed", videoReprocessable: true }), segment("failed-video", 9, { videoStatus: "failed" })]));
    const view = await renderProduction("story", summary("completed", [ready]));
    try {
        await click(view.host, "重试本段后处理");
        expect(calls.actions).toEqual([{ action: "segment_reprocess", targetId: "recoverable", episodeId: ready.id, episodeNumber: ready.number, segmentTitle: "场景5", targetRevision: 3 }]);
        expect(calls.videos).toHaveLength(0);
        await click(view.host, "查看第 10 段");
        await click(view.host, "重试本段视频");
        expect(calls.videos).toEqual([[ready.id, "failed-video", undefined]]);
        expect(calls.retried).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});
