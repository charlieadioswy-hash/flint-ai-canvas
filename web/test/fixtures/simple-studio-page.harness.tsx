import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { DramaCast, DramaEpisodeDetail, DramaEpisodeRow, DramaJob, DramaSegment, DramaSummary } from "@/services/api/drama";
import type { SimpleStudioSegmentEditorProps } from "@/pages/projects/simple-studio-segment-editor";
import { dramaKeys } from "@/lib/drama/drama-query-keys";

const browser = new Window({ url: "http://localhost/projects/project" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    SVGElement: browser.SVGElement,
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, Route, Routes, useLocation, useNavigate } = await import("react-router");
const { useGlobalAgentStore } = await import("@/stores/use-global-agent-store");

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & { type?: string; size?: string; icon?: ReactNode; loading?: boolean };
const successMessages = mock((_message: string) => {});
const infoMessages = mock((_message: string) => {});
const downloadResource = mock(async (_resourceId: string, _fileName: string) => {});
mock.module("antd", () => ({
    App: { useApp: () => ({ message: { success: successMessages, info: infoMessages, error: () => {} } }) },
    Button: ({ type: _type, size: _size, loading, icon, children, ...props }: ButtonProps) => (
        <button {...props} type="button" disabled={loading || props.disabled}>
            {icon}
            {children}
        </button>
    ),
    Select: ({ value, options, onChange, ...props }: { value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void; "aria-label": string }) => (
        <select {...props} value={value} onChange={(event) => onChange(event.target.value)}>
            {options.map((option) => (
                <option key={option.value} value={option.value}>
                    {option.label}
                </option>
            ))}
        </select>
    ),
}));
mock.module("@/components/layout/workspace-page", () => ({ WorkspacePage: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("@/components/layout/workspace-state", () => ({
    WorkspaceLoadingState: ({ label }: { label: string }) => <p role="status">{label}</p>,
    WorkspaceErrorState: ({ title, description, onRetry, actionLabel }: { title?: string; description?: string; onRetry: () => void; actionLabel?: string }) => (
        <div role="alert">
            {title}
            {description}
            <button onClick={onRetry}>{actionLabel || "重试"}</button>
        </div>
    ),
}));
mock.module("@/components/ui/base/tooltip/ant-tooltip", () => ({ AntTooltip: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("@/components/ui/product/app-modal", () => ({
    AppModal: ({ open, children, title, onCancel }: { open: boolean; children: ReactNode; title: string; onCancel: () => void }) =>
        open ? (
            <section role="dialog" aria-label={title}>
                {children}
                <button onClick={onCancel}>关闭成片播放</button>
            </section>
        ) : null,
}));
mock.module("@/components/canvas/canvas-agent-reply-options", () => ({ AgentReplyOptionCards: () => null, useAgentChoiceInteraction: () => ({ disabled: false, choose: (action: () => void) => action() }) }));
mock.module("@/pages/projects/drama-shared", () => ({
    mediaBusy: (status: string) => status === "queued" || status === "running",
    MediaThumb: ({ alt }: { alt: string }) => <span>{alt}</span>,
    useResourceMediaUrl: (resourceId?: string) => (resourceId ? `http://localhost/media/${resourceId}.mp4` : undefined),
    downloadResource,
    formatDuration: (durationMs: number) => `${durationMs / 1000} 秒`,
    aspectRatioValue: () => 16 / 9,
    CAST_KIND_LABEL: {},
    formatCredits: (value: number) => String(value / 1_000_000),
}));
mock.module("@/pages/projects/studio/job-detail", () => ({
    JOB_KIND_LABEL: { cast_image: "参考图", segment_video: "段视频", segment_prompt: "段视频提示词" },
    JobStatusIcon: ({ status }: { status: string }) => <span aria-label={status} />,
    formatJobTime: (value?: string) => value || "—",
    JobDetailModal: ({ job, onLocate, onClose }: { job?: DramaJob; onLocate: (job: DramaJob) => void; onClose: () => void }) =>
        job ? (
            <section role="dialog" aria-label="任务详情">
                <strong>{job.label}</strong>
                <button
                    onClick={() => {
                        onLocate(job);
                        onClose();
                    }}
                >
                    定位到镜头
                </button>
                <button onClick={onClose}>关闭任务详情</button>
            </section>
        ) : null,
}));
let editor!: SimpleStudioSegmentEditorProps;
mock.module("@/pages/projects/simple-studio-segment-editor", () => ({
    SimpleStudioSegmentEditor: (props: SimpleStudioSegmentEditorProps) => {
        editor = props;
        return null;
    },
}));
type CastDialogProps = { summary: DramaSummary; cast: DramaCast[]; castId: string; onClose: () => void; onChanged: () => void };
let castDialog!: CastDialogProps;
mock.module("@/pages/projects/studio/cast-editor-dialog", () => ({
    CastEditorDialog: (props: CastDialogProps) => {
        castDialog = props;
        return (
            <section role="dialog" aria-label="资产编辑" data-cast-id={props.castId}>
                <strong>{props.cast.find((item) => item.id === props.castId)?.name}</strong>
                <button onClick={props.onChanged}>保存资产变更</button>
                <button onClick={props.onClose}>关闭资产编辑</button>
            </section>
        );
    },
}));
type JianyingDialogProps = { open: boolean; projectId: string; episodeId: string; episodeLabel: string; onClose: () => void };
let jianyingDialog: JianyingDialogProps | undefined;
mock.module("@/pages/projects/studio/asset-transfer", () => ({
    JianyingDraftModal: (props: JianyingDialogProps) => {
        jianyingDialog = props;
        return props.open ? (
            <section role="dialog" aria-label="剪映草稿导出" data-episode-id={props.episodeId}>
                {props.episodeLabel}
                <button onClick={props.onClose}>关闭草稿导出</button>
            </section>
        ) : null;
    },
}));

function episode(id: string, number: number, failed = false): DramaEpisodeRow {
    return {
        id,
        number,
        title: `故事${number}`,
        error: failed ? "模型没有返回可解析的 JSON" : "",
        stage: failed ? "script" : "review",
        stats: { segments: failed ? 0 : 1, promptReady: failed ? 0 : 1, promptSucceeded: failed ? 0 : 1, failed: 0, videoReady: id === "episode-a" ? 1 : 0, videoGenerated: id === "episode-a" ? 1 : 0 },
        shotCount: failed ? 0 : 1,
        durationMs: failed ? 0 : 5000,
    } as DramaEpisodeRow;
}
function segment(episodeId: string): DramaSegment {
    return {
        id: `segment-${episodeId}`,
        index: 0,
        title: `场景-${episodeId}`,
        revision: 4,
        durationMs: 5000,
        promptStatus: "ready",
        videoStatus: episodeId === "episode-a" ? "ready" : "",
        videoResourceId: episodeId === "episode-a" ? `video-${episodeId}` : undefined,
        videoSeconds: episodeId === "episode-a" ? 5 : 0,
        videoPrompt: "场景内容",
        request: { firstFramePending: false },
    } as DramaSegment;
}
const episodes = [episode("episode-a", 1), episode("episode-b", 2), episode("episode-failed", 9, true)];
const summary = {
    project: { id: "project", name: "我们家小区又穿越了" },
    production: { revision: 20, guideStep: "completed", guideConversationId: "same-conversation", spentMicrocredits: 230_000_000, heldMicrocredits: 0, budgetMicrocredits: 0, settings: { aspectRatio: "9:16", models: { video: {} } } },
    jobCounts: {},
    inbox: [],
    episodes,
} as unknown as DramaSummary;
const details = new Map(
    episodes.map((row) => [
        row.id,
        {
            episode: { ...row, projectId: "project", revision: row.number + 30 },
            segments: row.error ? [] : [segment(row.id)],
            shots: row.error ? [] : [{ id: `shot-${row.id}`, episodeId: row.id, projectId: "project", segmentIndex: 0, speaker: "秦子文", dialogue: `${row.title}台词`, action: "" }],
            jobs: [],
        } as unknown as DramaEpisodeDetail,
    ]),
);
const getEpisode = mock(async (_projectId: string, id: string) => details.get(id)!);
const getSummary = mock(async (_projectId: string) => structuredClone(summary));
let queueJobs: DramaJob[] = [];
const listJobs = mock(async (_projectId: string, _limit: number, _signal?: AbortSignal) => ({ jobs: structuredClone(queueJobs) }));
const retryEpisode = mock(async (..._args: unknown[]) => ({ jobs: 1 }));
const renderEpisode = mock(async (_projectId: string, _episodeId: string, _input: { expectedRevision: number }) => ({ jobs: 1 }));
const preflight = mock(async () => {
    throw new Error("引用不应触发生成预检");
});
const execute = mock(async () => {
    throw new Error("引用不应提交任务");
});
const castById = new Map<string, DramaCast>();
mock.module("@/services/api/drama", () => ({
    getDramaEpisode: getEpisode,
    retryFailedDrama: retryEpisode,
    renderDramaEpisode: renderEpisode,
    getDrama: getSummary,
    listDramaCast: async () => ({ cast: [...castById.values()] }),
    listDramaJobs: listJobs,
    preflightDramaStudioAction: preflight,
    executeDramaStudioAction: execute,
    updateDramaCast: async () => ({}),
    updateDramaSegment: async () => ({}),
    updateDramaShot: async () => ({}),
}));
mock.module("@/services/drama-canvas", () => ({ encodeDramaCanvasFocus: () => "", openDramaCanvasPath: async () => "" }));
const { useDramaInvalidate: useActualDramaInvalidate } = await import("@/pages/projects/studio/use-studio");
const invalidate = mock(async (_episodeId?: string) => {});
mock.module("@/pages/projects/studio/use-studio", () => ({
    dramaKeys,
    useDramaSummary: (projectId: string) => useQuery({ queryKey: dramaKeys.summary(projectId), queryFn: () => getSummary(projectId), enabled: Boolean(projectId) }),
    useDramaCast: () => ({ byId: castById, cast: [...castById.values()] }),
    useDramaInvalidate: (projectId: string) => {
        const invalidateActual = useActualDramaInvalidate(projectId);
        return (episodeId?: string) => {
            void invalidate(episodeId);
            return invalidateActual(episodeId);
        };
    },
}));
const { default: SimpleStudioPage } = await import("@/pages/projects/simple-studio");

function Location() {
    const location = useLocation();
    const navigate = useNavigate();
    return (
        <>
            <output data-location data-location-key={location.key}>
                {location.pathname}
                {location.search}
            </output>
            <button onClick={() => navigate(-1)}>测试后退</button>
        </>
    );
}
async function fixture(url = "/projects/project", jobs: DramaJob[] = []) {
    useGlobalAgentStore.getState().reset();
    renderEpisode.mockClear();
    downloadResource.mockClear();
    jianyingDialog = undefined;
    queueJobs = structuredClone(jobs);
    listJobs.mockClear();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(dramaKeys.summary("project"), structuredClone(summary));
    for (const [id, value] of details) client.setQueryData(dramaKeys.episode("project", id), value);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(() =>
        root.render(
            <QueryClientProvider client={client}>
                <MemoryRouter initialEntries={[url]}>
                    <Routes>
                        <Route path="/projects/:projectId" element={<SimpleStudioPage />} />
                        <Route path="/projects/:projectId/e/:episodeId" element={<SimpleStudioPage />} />
                    </Routes>
                    <Location />
                </MemoryRouter>
            </QueryClientProvider>,
        ),
    );
    return {
        host,
        location: () => new URL(host.querySelector("[data-location]")!.textContent!, "http://localhost"),
        locationKey: () => host.querySelector("[data-location]")!.getAttribute("data-location-key"),
        refreshQueue: async (jobs: DramaJob[]) => {
            queueJobs = structuredClone(jobs);
            await act(async () => {
                await Promise.all([client.invalidateQueries({ queryKey: dramaKeys.summary("project"), exact: true }), client.invalidateQueries({ queryKey: dramaKeys.jobs("project"), exact: true })]);
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        },
        refreshEpisode: async (episodeId: string) => {
            await act(async () => {
                await client.invalidateQueries({ queryKey: dramaKeys.episode("project", episodeId), exact: true });
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        },
        select: async (label: string, value: string) =>
            await act(() => {
                const input = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
                input.value = value;
                input.dispatchEvent(new browser.Event("change", { bubbles: true }));
            }),
        close: async () => {
            await act(() => root.unmount());
            host.remove();
            client.clear();
            useGlobalAgentStore.getState().reset();
        },
    };
}
function button(host: HTMLElement, text: string) {
    const found = [...host.querySelectorAll("button")].find((item) => item.textContent === text);
    expect(found, `找不到按钮 ${text}`).toBeDefined();
    return found!;
}
async function flush() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}
afterAll(() => {
    browser.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

test("默认全部集并绑定原会话，卡片引用不自动发送或预检生成", async () => {
    const view = await fixture();
    try {
        expect(view.host.querySelectorAll(".drama-simple-episode").length).toBe(3);
        expect(useGlobalAgentStore.getState().drama?.guideConversationId).toBe("same-conversation");
        const target = view.host.querySelector<HTMLElement>('[data-segment-id="segment-episode-b"]')!;
        await act(() => button(target, "AI 交流").click());
        expect(useGlobalAgentStore.getState().dramaReference).toMatchObject({ projectId: "project", episodeId: "episode-b", segmentId: "segment-episode-b", segmentIndex: 0, revision: 4 });
        expect(useGlobalAgentStore.getState().drama?.prefillRequest).toBeNull();
        expect(preflight).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
    } finally {
        await view.close();
    }
});

test("两个集的相同段index编辑带各自真实episodeId，保留全部集范围", async () => {
    const view = await fixture();
    try {
        const second = view.host.querySelector<HTMLElement>('[data-segment-id="segment-episode-b"]')!;
        await act(() => second.querySelector<HTMLButtonElement>(".drama-simple-cover")!.click());
        expect(view.location().pathname).toBe("/projects/project/e/episode-b");
        expect(view.location().searchParams.get("segment")).toBe("0");
        expect(view.location().searchParams.get("scope")).toBe("all");
        expect(editor.episodeId).toBe("episode-b");
        expect(editor.detail?.episode.id).toBe("episode-b");
        const first = view.host.querySelector<HTMLElement>('[data-segment-id="segment-episode-a"]')!;
        await act(() => first.querySelector<HTMLButtonElement>(".drama-simple-cover")!.click());
        expect(editor.episodeId).toBe("episode-a");
        expect(editor.detail?.episode.id).toBe("episode-a");
    } finally {
        await view.close();
    }
});

test("每集成片卡位于本集最后一段后，合成只提交所选集的详情版本", async () => {
    const view = await fixture();
    try {
        for (const row of episodes.filter((item) => !item.error)) {
            const section = view.host.querySelector<HTMLElement>(`.drama-simple-episode[aria-label="第 ${row.number} 集"]`)!;
            const card = section.querySelector<HTMLElement>(`[data-episode-final-id="${row.id}"]`)!;
            expect(card).not.toBeNull();
            expect(card.classList.contains("drama-simple-card")).toBe(true);
            expect(section.querySelector(".drama-simple-grid")?.lastElementChild).toBe(card);
            expect(card.previousElementSibling?.getAttribute("data-segment-id")).toBe(`segment-${row.id}`);
            expect(card.textContent).toContain("1 段");
            expect(card.textContent).toContain("5 秒");
            expect(card.textContent).toMatch(/原声|对白与音效/);
            expect(card.querySelector(`[aria-label="下载第 ${row.number} 集成片"]`)).not.toBeNull();
            expect(card.querySelector(`[aria-label="导出第 ${row.number} 集剪映草稿"]`)).not.toBeNull();
        }
        const first = view.host.querySelector<HTMLElement>('[data-episode-final-id="episode-a"]')!;
        const generate = first.querySelector<HTMLButtonElement>('[aria-label="合成第 1 集视频"]')!;
        expect(generate.disabled).toBe(false);
        expect(generate.textContent).toContain("合成本集视频");
        const initialUrl = view.location().href;
        await act(() => generate.click());
        await flush();
        expect(renderEpisode.mock.calls).toEqual([["project", "episode-a", { expectedRevision: 31 }]]);
        expect(view.location().href).toBe(initialUrl);
        expect(preflight).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
    } finally {
        await view.close();
    }
});

test("成片卡播放已有视频，下载与剪映草稿保留所属集且不切换制作台", async () => {
    const previous = details.get("episode-a")!;
    details.set("episode-a", { ...previous, episode: { ...previous.episode, finalResourceId: "final-episode-a" } });
    const view = await fixture();
    try {
        const initialUrl = view.location().href;
        const card = view.host.querySelector<HTMLElement>('[data-episode-final-id="episode-a"]')!;
        const cover = card.querySelector<HTMLVideoElement>("video");
        expect(cover?.src).toBe("http://localhost/media/final-episode-a.mp4#t=0.1");
        expect(cover?.muted).toBe(true);
        await act(() => card.querySelector<HTMLButtonElement>('[aria-label="播放第 1 集成片"]')!.click());
        const video = view.host.querySelector<HTMLVideoElement>('[role="dialog"] video');
        expect(video?.src).toBe("http://localhost/media/final-episode-a.mp4");
        expect(video?.controls).toBe(true);
        await act(() => button(view.host, "关闭成片播放").click());
        expect(view.host.querySelector('[role="dialog"]')).toBeNull();
        const download = card.querySelector<HTMLButtonElement>('[aria-label="下载第 1 集成片"]')!;
        expect(download.disabled).toBe(false);
        await act(() => download.click());
        expect(downloadResource.mock.calls).toEqual([["final-episode-a", "我们家小区又穿越了-第1集.mp4"]]);
        const second = view.host.querySelector<HTMLElement>('[data-episode-final-id="episode-b"]')!;
        expect(second.querySelector<HTMLButtonElement>('[aria-label="下载第 2 集成片"]')?.disabled).toBe(true);
        await act(() => second.querySelector<HTMLButtonElement>('[aria-label="导出第 2 集剪映草稿"]')!.click());
        expect(jianyingDialog).toMatchObject({ open: true, projectId: "project", episodeId: "episode-b", episodeLabel: "第 2 集" });
        expect(view.host.querySelector('[role="dialog"][aria-label="剪映草稿导出"]')?.getAttribute("data-episode-id")).toBe("episode-b");
        await act(() => button(view.host, "关闭草稿导出").click());
        expect(view.host.querySelector('[role="dialog"][aria-label="剪映草稿导出"]')).toBeNull();
        expect(view.location().href).toBe(initialUrl);
        expect(renderEpisode).not.toHaveBeenCalled();
        expect(preflight).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
    } finally {
        await view.close();
        details.set("episode-a", previous);
    }
});

test("缺失或旧版本段视频不能合成本集，详情读取失败也不使用缓存版本提交", async () => {
    const previous = details.get("episode-a")!;
    for (const stale of [false, true]) {
        details.set("episode-a", { ...previous, segments: [{ ...previous.segments[0]!, videoStatus: stale ? "stale" : "ready", videoResourceId: stale ? "old-video" : undefined }] });
        const view = await fixture("/projects/project/e/episode-a?mode=simple");
        try {
            const generate = view.host.querySelector<HTMLButtonElement>('[aria-label="合成第 1 集视频"]')!;
            expect(generate.disabled).toBe(true);
            await act(() => generate.click());
            expect(renderEpisode).not.toHaveBeenCalled();
        } finally {
            await view.close();
            details.set("episode-a", previous);
        }
    }
    const view = await fixture("/projects/project/e/episode-a?mode=simple");
    try {
        getEpisode.mockImplementationOnce(async () => {
            throw new Error("测试详情读取失败");
        });
        await view.refreshEpisode("episode-a");
        expect(view.host.textContent).toContain("本集内容读取失败");
        const generate = view.host.querySelector<HTMLButtonElement>('[aria-label="合成第 1 集视频"]');
        expect(!generate || generate.disabled).toBe(true);
        if (generate) await act(() => generate.click());
        expect(renderEpisode).not.toHaveBeenCalled();
    } finally {
        await view.close();
    }
});

test("成片卡展示本集合成排队与运行状态，不能重复提交且不影响其它集", async () => {
    const previous = details.get("episode-a")!;
    for (const status of ["queued", "running"] as const) {
        details.set("episode-a", { ...previous, jobs: [queueJob({ id: `render-${status}`, kind: "render", episodeId: "episode-a", label: "第 1 集成片", status, taskId: `task-${status}` })] });
        const view = await fixture();
        try {
            const first = view.host.querySelector<HTMLElement>('[data-episode-final-id="episode-a"]')!;
            expect(first.querySelector('[role="status"]')?.textContent).toContain(status === "queued" ? "合成排队中" : "正在合成");
            const generate = first.querySelector<HTMLButtonElement>('[aria-label="合成第 1 集视频"]')!;
            expect(generate.disabled).toBe(true);
            await act(() => generate.click());
            expect(renderEpisode).not.toHaveBeenCalled();
            const second = view.host.querySelector<HTMLElement>('[data-episode-final-id="episode-b"]')!;
            expect(second.querySelector('[role="status"]')?.textContent).toContain("待合成");
            expect(second.textContent).not.toMatch(/合成排队中|正在合成/);
        } finally {
            await view.close();
            details.set("episode-a", previous);
        }
    }
});

test("未绑定任务的排队合成可按本集版本继续提交，段未就绪仍禁止操作", async () => {
    const previous = details.get("episode-a")!;
    const row = episodes[0]!;
    const previousRow = { ...row };
    for (const ready of [true, false]) {
        row.stage = "render";
        details.set("episode-a", {
            ...previous,
            episode: { ...previous.episode, stage: "render" },
            segments: [{ ...previous.segments[0]!, videoStatus: ready ? "ready" : "stale" }],
            jobs: [queueJob({ id: "unbound-render", kind: "render", episodeId: "episode-a", label: "第 1 集成片", status: "queued" })],
        });
        const view = await fixture();
        try {
            const first = view.host.querySelector<HTMLElement>('[data-episode-final-id="episode-a"]')!;
            expect(first.querySelector('[role="status"]')?.textContent).toContain("等待提交合成");
            const generate = first.querySelector<HTMLButtonElement>('[aria-label="合成第 1 集视频"]')!;
            expect(generate.textContent).toContain("继续合成本集");
            expect(generate.disabled).toBe(!ready);
            await act(() => {
                generate.click();
                generate.click();
            });
            await flush();
            expect(renderEpisode.mock.calls).toEqual(ready ? [["project", "episode-a", { expectedRevision: 31 }]] : []);
            expect(view.host.querySelector('[data-episode-final-id="episode-b"] [role="status"]')?.textContent).toContain("待合成");
            expect(preflight).not.toHaveBeenCalled();
            expect(execute).not.toHaveBeenCalled();
        } finally {
            await view.close();
            details.set("episode-a", previous);
            Object.assign(row, previousRow);
        }
    }
});

test("只有过期标记而没有成片资源时仍显示待合成", async () => {
    const previous = details.get("episode-a")!;
    details.set("episode-a", { ...previous, episode: { ...previous.episode, finalStale: true, finalResourceId: undefined } });
    const view = await fixture("/projects/project/e/episode-a?mode=simple");
    try {
        const card = view.host.querySelector<HTMLElement>('[data-episode-final-id="episode-a"]')!;
        expect(card.querySelector('[role="status"]')?.textContent).toContain("待合成");
        expect(card.textContent).not.toMatch(/成片待更新|当前为旧版成片/);
        expect(card.querySelector<HTMLButtonElement>('[aria-label="合成第 1 集视频"]')?.disabled).toBe(false);
        expect(card.querySelector<HTMLButtonElement>('[aria-label="下载第 1 集成片"]')?.disabled).toBe(true);
        expect(renderEpisode).not.toHaveBeenCalled();
    } finally {
        await view.close();
        details.set("episode-a", previous);
    }
});

test("折叠与展开多段分镜时，成片卡始终位于本集可见段末尾", async () => {
    const restore = withEightSegments();
    const view = await fixture("/projects/project/e/episode-b?mode=simple");
    try {
        const section = view.host.querySelector<HTMLElement>('.drama-simple-episode[aria-label="第 2 集"]')!;
        const grid = section.querySelector(".drama-simple-grid")!;
        const card = section.querySelector('[data-episode-final-id="episode-b"]')!;
        expect(grid.lastElementChild).toBe(card);
        expect(card.previousElementSibling?.getAttribute("data-segment-id")).toBe("segment-episode-b-5");
        await act(() => button(section, "展开其余 2 段").click());
        expect(grid.lastElementChild).toBe(card);
        expect(card.previousElementSibling?.getAttribute("data-segment-id")).toBe("segment-episode-b-7");
        expect(section.querySelectorAll('[data-episode-final-id="episode-b"]')).toHaveLength(1);
        await act(() => button(section, "收起本集").click());
        expect(grid.lastElementChild).toBe(card);
        expect(card.previousElementSibling?.getAttribute("data-segment-id")).toBe("segment-episode-b-5");
    } finally {
        await view.close();
        restore();
    }
});

test("失败集没有任何段也能按真实集重试剧本", async () => {
    const view = await fixture("/projects/project/e/episode-failed?mode=simple");
    try {
        expect(view.host.querySelectorAll(".drama-simple-card[data-segment-id]").length).toBe(0);
        expect(view.host.textContent).toContain("模型没有返回可解析的 JSON");
        await act(() => button(view.host, "重试本集剧本").click());
        await flush();
        expect(retryEpisode.mock.calls.at(-1)).toEqual(["project", "episode-failed", "text"]);
    } finally {
        await view.close();
    }
});

test("文字重试零任务回执只刷新状态，不提示已提交", async () => {
    retryEpisode.mockImplementationOnce(async () => ({ jobs: 0 }));
    successMessages.mockClear();
    infoMessages.mockClear();
    invalidate.mockClear();
    const view = await fixture("/projects/project/e/episode-failed?mode=simple");
    try {
        await act(() => button(view.host, "重试本集剧本").click());
        await flush();
        expect(successMessages).not.toHaveBeenCalled();
        expect(infoMessages.mock.calls.at(-1)).toEqual(["本集没有可重试的失败文字任务，已刷新最新状态"]);
        expect(invalidate).toHaveBeenCalledWith("episode-failed");
    } finally {
        await view.close();
    }
});

test("成片失败保留成功分镜，只重试本集成片且识别零任务回执", async () => {
    const row = episodes[0];
    const previous = { ...row };
    row.stage = "render";
    row.error = "合成器读取视频失败";
    successMessages.mockClear();
    infoMessages.mockClear();
    const view = await fixture("/projects/project/e/episode-a?mode=simple");
    try {
        expect(view.host.textContent).toContain("第 1 集成片合成失败");
        expect(view.host.textContent).not.toContain("剧本与分镜未就绪");
        expect(view.host.querySelectorAll(".drama-simple-card[data-segment-id]")).toHaveLength(1);
        await act(() => button(view.host, "重试本集成片").click());
        await flush();
        expect(retryEpisode.mock.calls.at(-1)).toEqual(["project", "episode-a", "render"]);
        expect(successMessages.mock.calls.at(-1)).toEqual(["已提交本集成片合成重试"]);
        successMessages.mockClear();
        retryEpisode.mockImplementationOnce(async () => ({ jobs: 0 }));
        await act(() => button(view.host, "重试本集成片").click());
        await flush();
        expect(successMessages).not.toHaveBeenCalled();
        expect(infoMessages.mock.calls.at(-1)).toEqual(["本集没有可重试的失败合成任务，已刷新最新状态"]);
        expect(preflight).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
    } finally {
        await view.close();
        Object.assign(row, previous);
    }
});

test("全部与单集切换清除旧弹窗定位，状态筛选使用真实视频状态", async () => {
    const view = await fixture("/projects/project/e/episode-a?mode=simple&segment=0&shot=shot-a");
    try {
        await view.select("选择集数", "episode-b");
        expect(view.host.querySelectorAll(".drama-simple-episode").length).toBe(1);
        expect(view.location().pathname).toBe("/projects/project/e/episode-b");
        expect(view.location().searchParams.has("segment")).toBe(false);
        expect(view.location().searchParams.has("shot")).toBe(false);
        await view.select("选择集数", "all");
        expect(view.host.querySelectorAll(".drama-simple-episode").length).toBe(3);
        await view.select("筛选段状态", "ready");
        expect([...view.host.querySelectorAll(".drama-simple-card[data-segment-id]")].map((item) => item.getAttribute("data-segment-id"))).toEqual(["segment-episode-a"]);
        await view.select("筛选段状态", "idle");
        expect([...view.host.querySelectorAll(".drama-simple-card[data-segment-id]")].map((item) => item.getAttribute("data-segment-id"))).toEqual(["segment-episode-b"]);
    } finally {
        await view.close();
    }
});

test("详细设置携带当前集段镜头和筛选范围", async () => {
    const view = await fixture("/projects/project/e/episode-b?mode=simple&scope=all&segment=0&shot=shot-b&status=idle");
    try {
        await act(() => button(view.host, "详细设置").click());
        expect(view.location().pathname).toBe("/projects/project/e/episode-b");
        expect(Object.fromEntries(view.location().searchParams)).toMatchObject({ mode: "advanced", scope: "all", segment: "0", shot: "shot-b", status: "idle" });
    } finally {
        await view.close();
    }
});

test("默认全部集切换详细设置时保留返回简易所需的全部集范围", async () => {
    const view = await fixture();
    try {
        await act(() => button(view.host, "详细设置").click());
        expect(view.location().pathname).toBe("/projects/project/e/episode-a");
        expect(view.location().searchParams.get("scope")).toBe("all");
        expect(view.location().searchParams.get("mode")).toBe("advanced");
    } finally {
        await view.close();
    }
});

test("资产编辑使用当前简易台弹窗，保存刷新各集与队列，关闭后保留原分镜", async () => {
    castById.set("cast-a", { id: "cast-a", projectId: "project", kind: "character", name: "秦子文" } as DramaCast);
    const job = queueJob({ id: "cast-a-job", label: "秦子文参考图", status: "queued" });
    const view = await fixture("/projects/project/e/episode-b?mode=simple&scope=all&segment=0&shot=shot-b&status=idle", [job]);
    try {
        const initialUrl = view.location().href;
        await act(() => button(view.host, "展开队列").click());
        await flush();
        await act(() => editor.onOpenCast("cast-a"));
        const dialog = view.host.querySelector('[role="dialog"][aria-label="资产编辑"]');
        expect(dialog?.getAttribute("data-cast-id")).toBe("cast-a");
        expect(dialog?.textContent).toContain("秦子文");
        expect(castDialog.castId).toBe("cast-a");
        expect(castDialog.summary.project.id).toBe("project");
        expect(castDialog.cast[0]?.id).toBe("cast-a");
        expect(view.location().href).toBe(initialUrl);
        expect(editor.episodeId).toBe("episode-b");
        expect(editor.segmentIndex).toBe(0);
        expect(editor.shotId).toBe("shot-b");

        getEpisode.mockClear();
        getSummary.mockClear();
        listJobs.mockClear();
        invalidate.mockClear();
        queueJobs = [{ ...job, status: "running", providerStage: "参考图生成中" }];
        await act(() => button(view.host, "保存资产变更").click());
        await flush();
        expect(invalidate).toHaveBeenCalledWith(undefined);
        expect(new Set(getEpisode.mock.calls.map(([, id]) => id))).toEqual(new Set(episodes.map((row) => row.id)));
        expect(getSummary).toHaveBeenCalled();
        expect(listJobs).toHaveBeenCalled();
        expect(view.host.querySelector(".drama-queue-panel")?.textContent).toContain("参考图生成中");
        expect(view.location().href).toBe(initialUrl);

        await act(() => button(view.host, "关闭资产编辑").click());
        expect(view.host.querySelector('[role="dialog"][aria-label="资产编辑"]')).toBeNull();
        expect(view.location().href).toBe(initialUrl);
        expect(editor.episodeId).toBe("episode-b");
        expect(editor.segmentIndex).toBe(0);
        expect(editor.shotId).toBe("shot-b");
        expect(view.host.querySelector('[data-segment-id="segment-episode-b"]')).not.toBeNull();
        expect(preflight).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
    } finally {
        await view.close();
        castById.delete("cast-a");
    }
});

function queueJob(patch: Partial<DramaJob> & Pick<DramaJob, "id" | "label">): DramaJob {
    return { kind: "cast_image", status: "queued", costMicrocredits: 0, attempt: 0, createdAt: "2026-11-11T05:20:00Z", updatedAt: "2026-11-11T05:20:00Z", ...patch };
}

function withEightSegments() {
    const previousDetails = new Map(details);
    const previousRows = episodes.map((row) => ({ row, stats: row.stats, shotCount: row.shotCount }));
    for (const row of episodes.filter((item) => !item.error)) {
        const current = details.get(row.id)!;
        const segments = Array.from({ length: 8 }, (_, index) => ({ ...segment(row.id), id: `segment-${row.id}-${index}`, index, title: `场景-${row.id}-${index}` }));
        row.stats = { ...row.stats, segments: 8, promptReady: 8, promptSucceeded: 8, videoReady: row.id === "episode-a" ? 8 : 0, videoGenerated: row.id === "episode-a" ? 8 : 0 };
        row.shotCount = 8;
        details.set(row.id, {
            ...current,
            segments,
            shots: segments.map((item) => ({ ...current.shots[0]!, id: `shot-${row.id}-${item.index}`, segmentIndex: item.index })),
        });
    }
    return () => {
        for (const [id, detail] of previousDetails) details.set(id, detail);
        for (const { row, stats, shotCount } of previousRows) Object.assign(row, { stats, shotCount });
    };
}

test("底部队列展示排队与上游进度，支持筛选和状态刷新，不自动重试或生成", async () => {
    const previous = { jobCounts: summary.jobCounts, inbox: summary.inbox };
    summary.jobCounts = { running: 1, queued: 1, succeeded: 105, failed: 1 };
    summary.inbox = [{ kind: "cast_failed" }] as DramaSummary["inbox"];
    const waiting = queueJob({ id: "cast-job", label: "秦子武参考图", wait: "账号同时任务已满" });
    const running = queueJob({ id: "video-job", kind: "segment_video", label: "第 2 集第 1 段视频", episodeId: "episode-b", status: "running", providerStage: "生成中 · 60%" });
    const failed = queueJob({ id: "failed-job", label: "秦家卧室参考图", status: "failed", error: "上游请求失败" });
    const jobs = [waiting, running, failed];
    const view = await fixture("/projects/project", jobs);
    try {
        const queue = view.host.querySelector<HTMLElement>(".drama-queue")!;
        expect(queue).not.toBeNull();
        expect(view.host.querySelector(".drama-simple-layout")?.nextElementSibling).toBe(queue);
        expect([...queue.querySelectorAll(".drama-queue-stat")].map((item) => item.textContent?.replace(/\s/g, ""))).toEqual(["运行中1", "排队1", "已完成105", "待重试1"]);
        expect(queue.querySelector(".drama-queue-budget")?.textContent).toContain("230");
        expect(queue.querySelector(".drama-queue-budget")?.textContent).toContain("不限预算");
        expect(queue.querySelector(".drama-queue-panel")).toBeNull();
        expect(listJobs).not.toHaveBeenCalled();
        expect(queue.textContent).not.toContain("全部重试");

        await act(() => button(queue, "展开队列").click());
        await flush();
        expect(listJobs.mock.calls[0]?.slice(0, 2)).toEqual(["project", 120]);
        expect(queue.querySelectorAll(".drama-job")).toHaveLength(3);
        expect(queue.textContent).toContain("秦子武参考图");
        expect(queue.textContent).toContain("账号同时任务已满");
        expect(queue.textContent).toContain("生成中 · 60%");
        expect(queue.textContent).toContain("上游请求失败");
        await act(() => button(queue, "失败").click());
        expect([...queue.querySelectorAll(".drama-job-label")].map((item) => item.textContent)).toEqual(["秦家卧室参考图"]);
        await act(() => button(queue, "进行中").click());
        expect(queue.querySelectorAll(".drama-job")).toHaveLength(2);

        summary.jobCounts = { running: 1, queued: 0, succeeded: 106, failed: 1 };
        await view.refreshQueue([{ ...waiting, status: "running", wait: undefined, providerStage: "参考图生成中" }, { ...running, status: "succeeded", providerStage: undefined }, failed]);
        expect(listJobs.mock.calls.length).toBeGreaterThan(1);
        expect([...queue.querySelectorAll(".drama-queue-stat")].map((item) => item.textContent?.replace(/\s/g, ""))).toEqual(["运行中1", "排队0", "已完成106", "待重试1"]);
        expect(queue.querySelectorAll(".drama-job")).toHaveLength(1);
        expect(queue.textContent).toContain("参考图生成中");
        expect(queue.textContent).not.toContain("账号同时任务已满");

        summary.jobCounts = { running: 0, queued: 0, succeeded: 107, failed: 1 };
        await view.refreshQueue([{ ...waiting, status: "succeeded" }, { ...running, status: "succeeded" }, failed]);
        expect(queue.querySelector(".drama-queue-empty")?.textContent).toBe("没有进行中的工作");
        expect(queue.querySelectorAll(".drama-job")).toHaveLength(0);
        expect(queue.querySelectorAll(".drama-queue-stat")[2]?.textContent?.replace(/\s/g, "")).toBe("已完成107");
        expect(preflight).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
    } finally {
        await view.close();
        Object.assign(summary, previous);
    }
});

test("从队列任务详情定位对应集仍留在简易台，清除旧段镜头和状态筛选", async () => {
    const job = queueJob({ id: "video-job", kind: "segment_video", status: "running", label: "第 2 集第 1 段视频", episodeId: "episode-b" });
    const view = await fixture("/projects/project/e/episode-a?mode=simple&segment=0&shot=old-shot&status=idle", [job]);
    try {
        await act(() => button(view.host, "与 Agent 讨论").click());
        await act(() => button(view.host, "展开队列").click());
        await flush();
        await act(() => view.host.querySelector<HTMLButtonElement>(".drama-job")!.click());
        expect(view.host.querySelector('[role="dialog"][aria-label="任务详情"]')?.textContent).toContain(job.label);
        await act(() => button(view.host, "定位到镜头").click());
        expect(view.location().pathname).toBe("/projects/project/e/episode-b");
        expect(view.location().searchParams.get("mode")).toBe("simple");
        for (const key of ["segment", "shot", "status"]) expect(view.location().searchParams.has(key)).toBe(false);
        expect(view.host.querySelector(".drama-simple-layout")?.classList.contains("is-results")).toBe(true);
        expect(view.host.querySelector('[role="dialog"][aria-label="任务详情"]')).toBeNull();
        expect(preflight).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
    } finally {
        await view.close();
    }
});

test("默认全部集视图定位队列任务后仅显示目标集，保留简易模式并清除全部集范围", async () => {
    const job = queueJob({ id: "episode-b-job", kind: "segment_video", status: "running", label: "第 2 集第 1 段视频", episodeId: "episode-b" });
    const view = await fixture("/projects/project?mode=simple", [job]);
    try {
        expect(view.host.querySelectorAll(".drama-simple-episode")).toHaveLength(3);
        expect(view.host.querySelector('[data-segment-id="segment-episode-a"]')).not.toBeNull();
        await act(() => button(view.host, "展开队列").click());
        await flush();
        await act(() => view.host.querySelector<HTMLButtonElement>(".drama-job")!.click());
        await act(() => button(view.host, "定位到镜头").click());
        expect(view.location().pathname).toBe("/projects/project/e/episode-b");
        expect(view.location().searchParams.get("mode")).toBe("simple");
        expect(view.location().searchParams.has("scope")).toBe(false);
        expect(view.host.querySelectorAll(".drama-simple-episode")).toHaveLength(1);
        expect(view.host.querySelector(".drama-simple-episode")?.getAttribute("aria-label")).toBe("第 2 集");
        expect(view.host.querySelector('[data-segment-id="segment-episode-b"]')).not.toBeNull();
        expect(view.host.querySelector('[data-segment-id="segment-episode-a"]')).toBeNull();
        expect(view.host.querySelector<HTMLSelectElement>('select[aria-label="选择集数"]')?.value).toBe("episode-b");
        expect(preflight).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
    } finally {
        await view.close();
    }
});

for (const [kind, index] of [
    ["segment_video", 7],
    ["segment_prompt", 6],
] as const) {
    test(`${kind} 队列定位真实段 ID，展开第六段之后的目标并打开对应段编辑器`, async () => {
        const restore = withEightSegments();
        const target = details.get("episode-b")!.segments[index]!;
        const job = queueJob({ id: `${kind}-job`, kind, status: "running", label: `第 2 集第 ${index + 1} 段`, episodeId: "episode-b", shotId: target.id });
        const view = await fixture("/projects/project/e/episode-a?mode=simple&scope=all&segment=0&shot=old-shot&status=idle", [job]);
        try {
            expect(view.host.querySelector('[aria-label="第 2 集"]')?.querySelectorAll(".drama-simple-card[data-segment-id]")).toHaveLength(6);
            expect(view.host.querySelector(`[data-segment-id="${target.id}"]`)).toBeNull();
            await act(() => button(view.host, "与 Agent 讨论").click());
            await act(() => button(view.host, "展开队列").click());
            await flush();
            await act(() => view.host.querySelector<HTMLButtonElement>(".drama-job")!.click());
            await act(() => button(view.host, "定位到镜头").click());
            await flush();
            expect(view.location().pathname).toBe("/projects/project/e/episode-b");
            expect(view.location().searchParams.get("mode")).toBe("simple");
            expect(view.location().searchParams.get("segment")).toBe(String(target.index));
            for (const key of ["scope", "shot", "status"]) expect(view.location().searchParams.has(key)).toBe(false);
            expect(view.host.querySelectorAll(".drama-simple-episode")).toHaveLength(1);
            expect(view.host.querySelectorAll(".drama-simple-card[data-segment-id]")).toHaveLength(8);
            expect(view.host.querySelector(`[data-segment-id="${target.id}"]`)).not.toBeNull();
            expect(editor.episodeId).toBe("episode-b");
            expect(editor.segmentIndex).toBe(target.index);
            expect(editor.shotId).toBeUndefined();
            expect(editor.detail?.segments.find((item) => item.index === editor.segmentIndex)?.id).toBe(target.id);
            expect(view.host.querySelector(".drama-simple-layout")?.classList.contains("is-results")).toBe(true);
            expect(preflight).not.toHaveBeenCalled();
            expect(execute).not.toHaveBeenCalled();
        } finally {
            await view.close();
            restore();
        }
    });
}

test("队列段目标已删除时回退到目标单集并展开，不误开旧段编辑器或生成媒体", async () => {
    const restore = withEightSegments();
    const job = queueJob({ id: "deleted-segment-job", kind: "segment_video", status: "succeeded", label: "已删除的第 2 集第 8 段", episodeId: "episode-b", shotId: "deleted-segment-id" });
    const view = await fixture("/projects/project/e/episode-a?mode=simple&scope=all&segment=0&shot=old-shot&status=ready", [job]);
    try {
        await act(() => button(view.host, "展开队列").click());
        await flush();
        await act(() => view.host.querySelector<HTMLButtonElement>(".drama-job")!.click());
        await act(() => button(view.host, "定位到镜头").click());
        await flush();
        expect(view.location().pathname).toBe("/projects/project/e/episode-b");
        expect(view.location().searchParams.get("mode")).toBe("simple");
        for (const key of ["scope", "segment", "shot", "status"]) expect(view.location().searchParams.has(key)).toBe(false);
        expect(view.host.querySelectorAll(".drama-simple-episode")).toHaveLength(1);
        expect(view.host.querySelector(".drama-simple-episode")?.getAttribute("aria-label")).toBe("第 2 集");
        expect(view.host.querySelectorAll(".drama-simple-card[data-segment-id]")).toHaveLength(8);
        expect(editor.episodeId).toBe("episode-b");
        expect(editor.segmentIndex).toBeUndefined();
        expect(editor.shotId).toBeUndefined();
        expect(view.host.querySelector('[data-segment-id="deleted-segment-id"]')).toBeNull();
        expect(view.host.querySelector('[role="dialog"][aria-label="任务详情"]')).toBeNull();
        expect(preflight).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
    } finally {
        await view.close();
        restore();
    }
});

test("队列定位读取期间切换集数并后退原历史记录后，迟到回执仍失效", async () => {
    const target = details.get("episode-b")!.segments[0]!;
    const job = queueJob({ id: "delayed-segment-job", kind: "segment_video", status: "running", label: "第 2 集第 1 段", episodeId: "episode-b", shotId: target.id });
    const view = await fixture("/projects/project/e/episode-a?mode=simple", [job]);
    const initialKey = view.locationKey();
    let resolveDetail!: (detail: DramaEpisodeDetail) => void;
    const pendingDetail = new Promise<DramaEpisodeDetail>((resolve) => {
        resolveDetail = resolve;
    });
    let targetRequested = false;
    getEpisode.mockImplementation(async (_projectId, id) => {
        if (id !== "episode-b") return details.get(id)!;
        targetRequested = true;
        return pendingDetail;
    });
    try {
        await act(() => button(view.host, "展开队列").click());
        await flush();
        await act(() => view.host.querySelector<HTMLButtonElement>(".drama-job")!.click());
        await act(() => button(view.host, "定位到镜头").click());
        await flush();
        expect(targetRequested).toBe(true);
        expect(view.location().pathname).toBe("/projects/project/e/episode-a");
        await view.select("选择集数", "episode-failed");
        expect(view.location().pathname).toBe("/projects/project/e/episode-failed");
        expect(view.locationKey()).not.toBe(initialKey);
        await act(() => button(view.host, "测试后退").click());
        expect(view.location().pathname).toBe("/projects/project/e/episode-a");
        expect(view.locationKey()).toBe(initialKey);
        await act(async () => {
            resolveDetail(details.get("episode-b")!);
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(view.location().pathname).toBe("/projects/project/e/episode-a");
        expect(view.location().searchParams.get("mode")).toBe("simple");
        expect(view.location().searchParams.has("segment")).toBe(false);
        expect(view.host.querySelectorAll(".drama-simple-episode")).toHaveLength(1);
        expect(view.host.querySelector(".drama-simple-episode")?.getAttribute("aria-label")).toBe("第 1 集");
        expect(editor.episodeId).toBe("episode-a");
        expect(editor.segmentIndex).toBeUndefined();
        expect(preflight).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
    } finally {
        resolveDetail(details.get("episode-b")!);
        getEpisode.mockImplementation(async (_projectId, id) => details.get(id)!);
        await view.close();
    }
});
