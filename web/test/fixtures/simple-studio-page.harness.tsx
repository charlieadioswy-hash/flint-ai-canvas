import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { DramaEpisodeDetail, DramaEpisodeRow, DramaSegment, DramaSummary } from "@/services/api/drama";
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
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router");
const { useGlobalAgentStore } = await import("@/stores/use-global-agent-store");

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & { type?: string; size?: string; icon?: ReactNode; loading?: boolean };
const successMessages = mock((_message: string) => {});
const infoMessages = mock((_message: string) => {});
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
mock.module("@/components/canvas/canvas-agent-reply-options", () => ({ AgentReplyOptionCards: () => null }));
mock.module("@/pages/projects/drama-shared", () => ({
    mediaBusy: (status: string) => status === "queued" || status === "running",
    MediaThumb: ({ alt }: { alt: string }) => <span>{alt}</span>,
    useResourceMediaUrl: () => undefined,
    aspectRatioValue: () => 16 / 9,
    CAST_KIND_LABEL: {},
}));
let editor!: SimpleStudioSegmentEditorProps;
mock.module("@/pages/projects/simple-studio-segment-editor", () => ({
    SimpleStudioSegmentEditor: (props: SimpleStudioSegmentEditorProps) => {
        editor = props;
        return null;
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
        videoPrompt: "场景内容",
        request: { firstFramePending: false },
    } as DramaSegment;
}
const episodes = [episode("episode-a", 1), episode("episode-b", 2), episode("episode-failed", 9, true)];
const summary = {
    project: { id: "project", name: "我们家小区又穿越了" },
    production: { revision: 20, guideStep: "completed", guideConversationId: "same-conversation", settings: { aspectRatio: "9:16", models: { video: {} } } },
    jobCounts: {},
    episodes,
} as unknown as DramaSummary;
const details = new Map(
    episodes.map((row) => [
        row.id,
        {
            episode: { ...row, projectId: "project" },
            segments: row.error ? [] : [segment(row.id)],
            shots: row.error ? [] : [{ id: `shot-${row.id}`, episodeId: row.id, projectId: "project", segmentIndex: 0, speaker: "秦子文", dialogue: `${row.title}台词`, action: "" }],
            jobs: [],
        } as unknown as DramaEpisodeDetail,
    ]),
);
const getEpisode = mock(async (_projectId: string, id: string) => details.get(id)!);
const retryEpisode = mock(async (..._args: unknown[]) => ({ jobs: 1 }));
const preflight = mock(async () => {
    throw new Error("引用不应触发生成预检");
});
const execute = mock(async () => {
    throw new Error("引用不应提交任务");
});
mock.module("@/services/api/drama", () => ({
    getDramaEpisode: getEpisode,
    retryFailedDrama: retryEpisode,
    getDrama: async () => summary,
    preflightDramaStudioAction: preflight,
    executeDramaStudioAction: execute,
    updateDramaCast: async () => ({}),
    updateDramaSegment: async () => ({}),
    updateDramaShot: async () => ({}),
}));
const invalidate = mock(async () => {});
const castById = new Map();
mock.module("@/pages/projects/studio/use-studio", () => ({
    dramaKeys,
    useDramaSummary: () => ({ data: summary, isLoading: false, isFetching: false, isError: false, refetch: async () => summary }),
    useDramaCast: () => ({ byId: castById }),
    useDramaInvalidate: () => invalidate,
}));
const { default: SimpleStudioPage } = await import("@/pages/projects/simple-studio");

function Location() {
    const location = useLocation();
    return (
        <output data-location>
            {location.pathname}
            {location.search}
        </output>
    );
}
async function fixture(url = "/projects/project") {
    useGlobalAgentStore.getState().reset();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
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

test("失败集没有任何段也能按真实集重试剧本", async () => {
    const view = await fixture("/projects/project/e/episode-failed?mode=simple");
    try {
        expect(view.host.querySelectorAll(".drama-simple-card").length).toBe(0);
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
        expect(view.host.querySelectorAll(".drama-simple-card")).toHaveLength(1);
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
        expect([...view.host.querySelectorAll(".drama-simple-card")].map((item) => item.getAttribute("data-segment-id"))).toEqual(["segment-episode-a"]);
        await view.select("筛选段状态", "idle");
        expect([...view.host.querySelectorAll(".drama-simple-card")].map((item) => item.getAttribute("data-segment-id"))).toEqual(["segment-episode-b"]);
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

test("资产精调路由保持当前集并清除段弹窗，进入详细资产面板", async () => {
    const view = await fixture("/projects/project/e/episode-b?mode=simple&segment=0&shot=shot-b");
    try {
        await act(() => editor.onOpenAdvancedCast("cast-a"));
        expect(view.location().pathname).toBe("/projects/project/e/episode-b");
        expect(Object.fromEntries(view.location().searchParams)).toMatchObject({ mode: "advanced", view: "cast", cast: "cast-a" });
        expect(view.location().searchParams.has("segment")).toBe(false);
        expect(view.location().searchParams.has("shot")).toBe(false);
    } finally {
        await view.close();
    }
});
