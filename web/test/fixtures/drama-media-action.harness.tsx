import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { DramaModelChoice, DramaSegment, DramaStudioActionPreflight, DramaStudioActionRequest, DramaWorkflowAffectedSegment, DramaWorkflowImpact } from "../../src/services/api/drama";
import type { DramaMediaActionController } from "../../src/pages/projects/studio/use-drama-media-action";
import { generationLabel } from "../../src/pages/projects/workflow-generation";

const dom = new Window({ url: "http://localhost/projects/drama", settings: { disableJavaScriptEvaluation: true, disableCSSFileLoading: true } });
const globals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    HTMLButtonElement: dom.HTMLButtonElement,
    Element: dom.Element,
    Node: dom.Node,
    Event: dom.Event,
    MouseEvent: dom.MouseEvent,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const { act, useEffect, useLayoutEffect } = await import("react");
const { createRoot } = await import("react-dom/client");
mock.module("antd", () => ({
    App: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
        <button type="button" disabled={disabled} onClick={onClick}>
            {children}
        </button>
    ),
}));
mock.module("../../src/components/ui/product/app-modal", () => ({
    AppModal: ({
        open,
        title,
        children,
        onOk,
        onCancel,
        okText,
        cancelText,
        okButtonProps,
        footer,
    }: {
        open: boolean;
        title: string;
        children: React.ReactNode;
        onOk: () => void;
        onCancel: () => void;
        okText: string;
        cancelText: string;
        okButtonProps: { disabled: boolean };
        footer?: React.ReactNode;
    }) =>
        open ? (
            <section role="dialog">
                <h2>{title}</h2>
                {children}
                {footer || (
                    <>
                        <button type="button" disabled={okButtonProps?.disabled} onClick={onOk}>
                            {okText}
                        </button>
                    </>
                )}
                <button type="button" onClick={onCancel}>
                    {cancelText}
                </button>
            </section>
        ) : null,
}));
const { App } = await import("antd");
const { setActiveUserScope } = await import("../../src/lib/user-scope");
const { useUserStore } = await import("../../src/stores/use-user-store");
const api = await import("../../src/services/api/drama");
const { DramaMediaActionDialog } = await import("../../src/pages/projects/studio/drama-media-action-dialog");
const { useDramaMediaAction } = await import("../../src/pages/projects/studio/use-drama-media-action");
const { DramaMediaActionProvider, QuotedMediaButton } = await import("../../src/pages/projects/studio/drama-media-action-context");

type PreviewInput = Partial<DramaStudioActionPreflight> & Pick<DramaStudioActionPreflight, "action" | "targetId" | "confirmationToken">;
function preview(input: PreviewInput): DramaStudioActionPreflight {
    return {
        episodeId: "episode-1",
        targetRevision: 3,
        baseRevision: 8,
        ready: true,
        message: "可以生成",
        missingCasts: [],
        warnings: [],
        canUseText: true,
        reprocessable: false,
        amountMicrocredits: 2_500_000,
        priced: true,
        ...input,
    };
}
function segment(revision = 3): DramaSegment {
    return { id: "segment-1", revision, index: 2, title: "雨夜追车" } as DramaSegment;
}
function affectedSegment(id: string, input: Partial<DramaWorkflowAffectedSegment> = {}): DramaWorkflowAffectedSegment {
    return { id, episodeId: `episode-${id}`, episodeNumber: 1, episodeTitle: "已生成剧集", segmentIndex: 0, revision: 3, videoStatus: "ready", hasVideo: true, ...input };
}
function impact(castId: string, input: Partial<DramaWorkflowImpact> = {}): DramaWorkflowImpact {
    return { kind: "cast", castId, revision: 8, segments: 0, episodes: 0, affectedSegments: 0, assetIds: [castId], directSegments: [], continuitySegments: [], message: "资产影响范围", ...input };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((accept, fail) => {
        resolve = accept;
        reject = fail;
    });
    return { promise, resolve, reject };
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let controller: DramaMediaActionController | null;
let changed: ReturnType<typeof deferred<void>>;
let changedCalls = 0;
let projectId = "project-1";
let revision = 8;
let shownRequests: DramaStudioActionRequest[] = [];
let refreshKey = "idle";
let autoQuoteButton = false;

function Probe({ id }: { id: string }) {
    const value = useDramaMediaAction({
        projectId: id,
        revision,
        refreshKey,
        onChanged: () => {
            changedCalls += 1;
            return changed.promise;
        },
    });
    useEffect(() => {
        controller = value;
    });
    useLayoutEffect(() => {
        if (!autoQuoteButton)
            for (const request of shownRequests) {
                const quote = value.quoteAction(request);
                if (quote.preview) value.acknowledgeQuote(request, quote.preview);
            }
    });
    if (autoQuoteButton)
        return (
            <DramaMediaActionProvider controller={value} projectId={id} revision={revision}>
                <QuotedMediaButton request={shownRequests[0]!} label="生成视频" onClick={() => value.requestAction(shownRequests[0]!)} />
                <DramaMediaActionDialog controller={value} />
            </DramaMediaActionProvider>
        );
    return (
        <>
            {shownRequests.map((request, index) => {
                const quote = value.quoteAction(request);
                return (
                    <button key={index} disabled={quote.disabled} onClick={() => value.requestAction(request)}>
                        {generationLabel("生成", quote.preview, quote.loading)}
                    </button>
                );
            })}
            <DramaMediaActionDialog controller={value} />
        </>
    );
}

beforeEach(() => {
    setActiveUserScope("scope-a");
    useUserStore.setState({ user: { id: "user-a", username: "a", displayName: "甲", role: "user", status: "active" } });
    projectId = "project-1";
    revision = 8;
    refreshKey = "idle";
    autoQuoteButton = false;
    shownRequests = [{ action: "segment_video", targetId: "segment-1", episodeId: "episode-1", targetRevision: 3 }];
    controller = null;
    changedCalls = 0;
    changed = deferred();
    changed.resolve();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    spyOn(api, "getDramaCastImpact").mockImplementation(async (_projectId, castId) => impact(castId));
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.body.replaceChildren();
    mock.restore();
});
afterAll(() => {
    dom.happyDOM.abort();
    for (const [key, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

async function render() {
    await act(async () =>
        root.render(
            <App>
                <Probe id={projectId} />
            </App>,
        ),
    );
}
async function flush() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}
async function click(label: string) {
    const button = [...document.body.querySelectorAll("button")].find((item) => item.textContent?.replace(/\s/g, "") === label);
    expect(button, label).toBeTruthy();
    await act(async () => {
        button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}
function dialogText() {
    return document.body.textContent || "";
}

const videoRequest = (): DramaStudioActionRequest => ({ action: "segment_video", targetId: "segment-1", episodeId: "episode-1", targetRevision: 3 });
const installQuote = () => spyOn(api, "preflightDramaStudioAction").mockImplementation(async (_id, request) => preview({ action: request.action, targetId: request.targetId, episodeId: request.episodeId, confirmationToken: "token-1" }));
const installExecute = (queued = 1) => spyOn(api, "executeDramaStudioAction").mockImplementation(async (_id, request) => ({ queued, action: request.action, targetId: request.targetId }));
async function prepare(request = videoRequest()) {
    await act(async () => {
        await controller!.prepareAction(request);
    });
    await flush();
}
async function request(input = videoRequest()) {
    await act(async () => controller!.requestAction(input));
    await flush();
}

test("段提示词保留原确认，打开仅预检，确认后才提交", async () => {
    shownRequests = [];
    const preflight = installQuote();
    const execute = installExecute();
    await render();
    await request({ ...videoRequest(), action: "segment_prompt" });
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(dialogText()).toContain("确认撰写提示词");
    expect(dialogText()).toContain("预计 2.5 积分");
    await click("确认提交");
    await flush();
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(dialogText()).toContain("已提交提示词撰写");
});

test("段提示词复检费用变化仍留在确认窗口，不直接提交", async () => {
    shownRequests = [];
    const first = preview({ action: "segment_prompt", targetId: "segment-1", confirmationToken: "first" });
    const latest = preview({ ...first, confirmationToken: "latest", amountMicrocredits: 4_000_000 });
    spyOn(api, "preflightDramaStudioAction").mockResolvedValueOnce(first).mockResolvedValue(latest);
    const execute = installExecute();
    await render();
    await request({ ...videoRequest(), action: "segment_prompt" });
    await click("确认提交");
    expect(execute).not.toHaveBeenCalled();
    expect(dialogText()).toContain("条件或费用已变化");
    expect(dialogText()).toContain("预计 4 积分");
    await click("确认提交");
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1].confirmationToken).toBe("latest");
});

test("段提示词无法估算费用时沿用原确认语义", async () => {
    shownRequests = [];
    spyOn(api, "preflightDramaStudioAction").mockImplementation(async (_id, input) => preview({ action: input.action, targetId: input.targetId, confirmationToken: "text-token", priced: false }));
    const execute = installExecute();
    await render();
    await request({ ...videoRequest(), action: "segment_prompt" });
    expect(dialogText()).toContain("暂无法估算费用，以实际扣费为准");
    expect(execute).not.toHaveBeenCalled();
    await click("确认提交");
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
});

test("自动预检只读、缓存去重，按钮显示报价且正常不打开弹窗", async () => {
    const preflight = installQuote();
    const execute = installExecute();
    await render();
    await prepare();
    await prepare();
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(dialogText()).toContain("生成 - 2.5积分");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("真实共用按钮自动报价，切换模型更新积分且只点击一次直接生成", async () => {
    autoQuoteButton = true;
    const preflight = spyOn(api, "preflightDramaStudioAction").mockImplementation(async (_id, input) =>
        preview({ action: input.action, targetId: input.targetId, episodeId: input.episodeId, confirmationToken: input.videoModel?.modelKey || "default", amountMicrocredits: input.videoModel ? 5_000_000 : 2_500_000 }),
    );
    const execute = installExecute();
    await render();
    await flush();
    expect(dialogText()).toContain("生成视频 - 2.5积分");
    expect(execute).not.toHaveBeenCalled();
    shownRequests = [{ ...videoRequest(), videoModel: { channelId: "channel", modelKey: "new-model" } }];
    await render();
    await flush();
    expect(dialogText()).toContain("生成视频 - 5积分");
    await click("生成视频-5积分");
    await flush();
    expect(preflight).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1].videoModel?.modelKey).toBe("new-model");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("任务状态更新后重新报价，之前因缺少参考图被阻断的按钮可恢复", async () => {
    const blocked = preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "blocked", ready: false, reason: "参考图正在生成" });
    const ready = preview({ ...blocked, confirmationToken: "ready", ready: true, reason: undefined });
    const preflight = spyOn(api, "preflightDramaStudioAction").mockResolvedValueOnce(blocked).mockResolvedValue(ready);
    installExecute();
    autoQuoteButton = true;
    await render();
    await flush();
    expect(controller!.quoteAction(videoRequest()).disabled).toBe(true);
    refreshKey = "image-finished";
    await render();
    await flush();
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(controller!.quoteAction(videoRequest()).disabled).toBe(false);
});

test("已显示有效报价后一次点击复检并执行，正常不再确认费用", async () => {
    const preflight = installQuote();
    const execute = installExecute();
    await render();
    await prepare();
    await click("生成-2.5积分");
    await flush();
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1]).toEqual({ ...videoRequest(), baseRevision: 8, targetRevision: 3, confirmationToken: "token-1" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(changedCalls).toBe(1);
    await request();
    expect(execute).toHaveBeenCalledTimes(1);
});

test("没有已显示报价的点击只读取价格，不自动按新价执行", async () => {
    const preflight = installQuote();
    const execute = installExecute();
    await render();
    await request();
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(dialogText()).toContain("2.5积分");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await request();
    expect(execute).toHaveBeenCalledTimes(1);
});

test("只读取报价数据不等于价格已显示，未提交到页面的报价不能执行", async () => {
    shownRequests = [];
    installQuote();
    const execute = installExecute();
    await render();
    await prepare();
    expect(controller!.quoteAction(videoRequest()).preview?.priced).toBe(true);
    await request();
    expect(execute).not.toHaveBeenCalled();
});

test("缺失资产入口先展示自身费用，点击只生成参考图而不自动生成视频", async () => {
    spyOn(api, "preflightDramaStudioAction").mockImplementation(async (_id, input) =>
        preview({
            action: input.action,
            targetId: input.targetId,
            episodeId: input.episodeId,
            confirmationToken: input.action,
            ready: input.action !== "segment_video",
            missingCasts: input.action === "segment_video" ? [{ id: "cast-1", name: "林夏" }] : [],
            reason: input.action === "segment_video" ? "缺少参考图" : undefined,
        }),
    );
    const execute = installExecute();
    await render();
    await prepare();
    await act(async () => controller!.requestVideo({ id: "episode-1", number: 1 }, segment()));
    await flush();
    expect(dialogText()).toContain("生成缺失参考图 - 2.5积分");
    expect(execute).not.toHaveBeenCalled();
    await click("生成缺失参考图-2.5积分");
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1].action).toBe("segment_assets");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("金额或令牌变化更新按钮并停止本次，下一次明确点击才执行", async () => {
    const before = preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "old", amountMicrocredits: 1_000_000 });
    const after = preview({ ...before, confirmationToken: "new", amountMicrocredits: 9_000_000 });
    const preflight = spyOn(api, "preflightDramaStudioAction").mockResolvedValueOnce(before).mockResolvedValue(after);
    const execute = installExecute();
    await render();
    await prepare();
    await request();
    expect(execute).not.toHaveBeenCalled();
    expect(dialogText()).toContain("生成 - 9积分");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await request();
    expect(preflight).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1].confirmationToken).toBe("new");
});

test("报价不可用或阻断时按钮不可执行，恢复弹窗没有确认提交", async () => {
    spyOn(api, "preflightDramaStudioAction").mockResolvedValue(preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "", ready: false, priced: false, reason: "积分不足" }));
    const execute = installExecute();
    await render();
    await prepare();
    expect(controller!.quoteAction(videoRequest()).disabled).toBe(true);
    await request();
    expect(execute).not.toHaveBeenCalled();
    expect(dialogText()).toContain("积分不足");
    expect(dialogText()).not.toContain("确认提交");
    expect(dialogText()).not.toContain("以实际扣费为准");
});

test("复检与执行期间连点只发一个写请求", async () => {
    const gate = deferred<DramaStudioActionPreflight>();
    const quote = preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-1" });
    spyOn(api, "preflightDramaStudioAction")
        .mockResolvedValueOnce(quote)
        .mockImplementation(() => gate.promise);
    const execute = installExecute();
    await render();
    await prepare();
    await request();
    await request();
    expect(execute).not.toHaveBeenCalled();
    await act(async () => {
        gate.resolve(quote);
        await new Promise((r) => setTimeout(r, 0));
    });
    expect(execute).toHaveBeenCalledTimes(1);
});

test("关闭复检会取消尚未发出的写请求", async () => {
    const gate = deferred<DramaStudioActionPreflight>();
    const quote = preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-1" });
    spyOn(api, "preflightDramaStudioAction")
        .mockResolvedValueOnce(quote)
        .mockImplementation(() => gate.promise);
    const execute = installExecute();
    await render();
    await prepare();
    await request();
    await act(async () => controller!.close());
    await act(async () => {
        gate.resolve(quote);
        await new Promise((r) => setTimeout(r, 0));
    });
    expect(execute).not.toHaveBeenCalled();
    expect(controller!.state.open).toBe(false);
});

test("提交传输失败按结果未知处理，关闭或修订变化后都不能重复提交", async () => {
    installQuote();
    const execute = spyOn(api, "executeDramaStudioAction").mockRejectedValue(new Error("连接中断"));
    await render();
    await prepare();
    await request();
    expect(controller!.state.submitted).toBe(true);
    expect(dialogText()).toContain("提交结果暂不明确");
    await act(async () => controller!.close());
    revision = 9;
    await render();
    await prepare();
    await request();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(controller!.quoteAction(videoRequest()).disabled).toBe(true);
});

test("确定的409拒绝可以重新读报价，但不会重试写请求", async () => {
    installQuote();
    const { ApiError } = await import("../../src/services/api/request");
    const execute = spyOn(api, "executeDramaStudioAction").mockRejectedValue(new ApiError("内容已更新", { status: 409, reason: "conflict" }));
    await render();
    await prepare();
    await request();
    expect(controller!.state.submitted).toBe(false);
    await act(async () => controller!.retry());
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(controller!.state.open).toBe(false);
    expect(controller!.quoteAction(videoRequest()).preview?.confirmationToken).toBe("token-1");
});

test("切换账号或作品后迟到的复检不能提交或更新新界面", async () => {
    const gate = deferred<DramaStudioActionPreflight>();
    const quote = preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-1" });
    spyOn(api, "preflightDramaStudioAction")
        .mockResolvedValueOnce(quote)
        .mockImplementation(() => gate.promise);
    const execute = installExecute();
    await render();
    await prepare();
    await request();
    await act(async () => useUserStore.setState({ user: { id: "user-b" } as never }));
    projectId = "project-2";
    await render();
    await act(async () => {
        gate.resolve(quote);
        await new Promise((r) => setTimeout(r, 0));
    });
    expect(execute).not.toHaveBeenCalled();
    expect(controller!.state.open).toBe(false);
    expect(changedCalls).toBe(0);
});

test("登出再登回同账号也不能恢复旧复检授权", async () => {
    const gate = deferred<DramaStudioActionPreflight>();
    const quote = preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-1" });
    spyOn(api, "preflightDramaStudioAction")
        .mockResolvedValueOnce(quote)
        .mockImplementation(() => gate.promise);
    const execute = installExecute();
    await render();
    await prepare();
    await request();
    await act(async () => {
        const previous = useUserStore.getState().user;
        useUserStore.setState({ user: null });
        useUserStore.setState({ user: previous });
    });
    await act(async () => {
        gate.resolve(quote);
        await new Promise((r) => setTimeout(r, 0));
    });
    expect(execute).not.toHaveBeenCalled();
});

test("切换登录持久化范围后旧预检不能执行", async () => {
    const gate = deferred<DramaStudioActionPreflight>();
    const quote = preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-1" });
    spyOn(api, "preflightDramaStudioAction")
        .mockResolvedValueOnce(quote)
        .mockImplementation(() => gate.promise);
    const execute = installExecute();
    await render();
    await prepare();
    await request();
    setActiveUserScope("scope-b");
    await act(async () => {
        gate.resolve(quote);
        await new Promise((r) => setTimeout(r, 0));
    });
    expect(execute).not.toHaveBeenCalled();
});

test("作品修订改变会隔离缓存，旧价格不能直接执行", async () => {
    const preflight = installQuote();
    const execute = installExecute();
    await render();
    await prepare();
    revision = 9;
    await render();
    await request();
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
});

test("分集与视频模型拥有独立报价键，切换回来复用对应报价", async () => {
    const preflight = installQuote();
    const execute = installExecute();
    const otherEpisode = { ...videoRequest(), episodeId: "episode-2" };
    const otherModel = { ...videoRequest(), videoModel: { logicalModelId: "model-b" } };
    await render();
    await prepare();
    await prepare(otherEpisode);
    await prepare(otherModel);
    await prepare();
    expect(preflight).toHaveBeenCalledTimes(3);
    expect(execute).not.toHaveBeenCalled();
    expect(controller!.quoteAction(otherEpisode).preview?.episodeId).toBe("episode-2");
    expect(preflight.mock.calls[2][1].videoModel).toEqual({ logicalModelId: "model-b" });
});

test("主体按所选集报价并直接提交，已有视频依赖不再二次确认", async () => {
    const input = { action: "cast_image" as const, targetId: "cast-1", episodeId: "episode-2" };
    shownRequests = [input];
    installQuote();
    spyOn(api, "getDramaCastImpact").mockResolvedValue(impact("cast-1", { directSegments: [affectedSegment("one")] }));
    const execute = installExecute();
    await render();
    await prepare(input);
    await request(input);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1].episodeId).toBe("episode-2");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("主体影响读取失败或身份畸形不能当成可执行报价", async () => {
    const input = { action: "cast_image" as const, targetId: "cast-1" };
    shownRequests = [input];
    installQuote();
    const execute = installExecute();
    spyOn(api, "getDramaCastImpact").mockResolvedValue(impact("another-cast"));
    await render();
    await prepare(input);
    await request(input);
    expect(execute).not.toHaveBeenCalled();
    expect(dialogText()).toContain("资产影响范围");
    expect(controller!.quoteAction(input).disabled).toBe(true);
});

test("免费后处理自动显示0积分，一次点击使用最新令牌执行", async () => {
    const input = { ...videoRequest(), action: "segment_reprocess" as const };
    shownRequests = [input];
    spyOn(api, "preflightDramaStudioAction").mockResolvedValue(preview({ action: "segment_reprocess", targetId: "segment-1", confirmationToken: "free-token", priced: false, amountMicrocredits: 0 }));
    const execute = installExecute();
    await render();
    await prepare(input);
    expect(dialogText()).toContain("生成 - 0积分");
    await request(input);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1].confirmationToken).toBe("free-token");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("无新增任务或畸形回执如实提示，畸形回执不会允许重复执行", async () => {
    installQuote();
    const execute = installExecute(-1);
    await render();
    await prepare();
    await request();
    expect(controller!.state.submitted).toBe(true);
    expect(dialogText()).toContain("任务回执异常");
    await act(async () => controller!.retry());
    await request();
    expect(execute).toHaveBeenCalledTimes(1);
});

test("排队为零保留真实结果而不冒充生成成功", async () => {
    installQuote();
    installExecute(0);
    await render();
    await prepare();
    await request();
    expect(controller!.state.submitted).toBe(false);
    expect(controller!.state.queued).toBe(0);
    expect(dialogText()).toContain("本次没有新增任务");
});

test("提交成功后刷新失败保留回执，不允许重发任务", async () => {
    installQuote();
    const execute = installExecute();
    changed = deferred<void>();
    changed.reject(new Error("刷新失败"));
    changed.promise.catch(() => undefined);
    await render();
    await prepare();
    await request();
    expect(controller!.state.submitted).toBe(true);
    expect(controller!.state.queued).toBe(1);
    expect(dialogText()).toContain("页面刷新失败");
    await act(async () => controller!.retry());
    await request();
    expect(execute).toHaveBeenCalledTimes(1);
});

test("复检期间切换目标不会串用另一对象报价", async () => {
    installQuote();
    const execute = installExecute();
    const other = { ...videoRequest(), targetId: "segment-2" };
    await render();
    await prepare();
    await prepare(other);
    shownRequests = [other];
    await render();
    await request(other);
    expect(execute.mock.calls[0][1].targetId).toBe("segment-2");
});

test("卸载后迟到预检不执行也不刷新其他页面", async () => {
    const gate = deferred<DramaStudioActionPreflight>();
    const quote = preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-1" });
    spyOn(api, "preflightDramaStudioAction")
        .mockResolvedValueOnce(quote)
        .mockImplementation(() => gate.promise);
    const execute = installExecute();
    await render();
    await prepare();
    await request();
    await act(async () => root.unmount());
    await act(async () => {
        gate.resolve(quote);
        await new Promise((r) => setTimeout(r, 0));
    });
    expect(execute).not.toHaveBeenCalled();
    expect(changedCalls).toBe(0);
});
