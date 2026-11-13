import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { DramaModelChoice, DramaSegment, DramaStudioActionPreflight, DramaStudioActionRequest } from "../../src/services/api/drama";
import type { DramaMediaActionController } from "../../src/pages/projects/studio/use-drama-media-action";

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

const { act, useEffect } = await import("react");
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
    }: {
        open: boolean;
        title: string;
        children: React.ReactNode;
        onOk: () => void;
        onCancel: () => void;
        okText: string;
        cancelText: string;
        okButtonProps: { disabled: boolean };
    }) =>
        open ? (
            <section role="dialog">
                <h2>{title}</h2>
                {children}
                <button type="button" disabled={okButtonProps.disabled} onClick={onOk}>
                    {okText}
                </button>
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

function Probe({ id }: { id: string }) {
    const value = useDramaMediaAction({
        projectId: id,
        onChanged: () => {
            changedCalls += 1;
            return changed.promise;
        },
    });
    useEffect(() => {
        controller = value;
    });
    return <DramaMediaActionDialog controller={value} />;
}

beforeEach(() => {
    setActiveUserScope("scope-a");
    useUserStore.setState({ user: { id: "user-a", username: "a", displayName: "甲", role: "user", status: "active" } });
    projectId = "project-1";
    controller = null;
    changedCalls = 0;
    changed = deferred();
    changed.resolve();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
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

test("打开只预检，确认前不会执行", async () => {
    const preflight = spyOn(api, "preflightDramaStudioAction").mockResolvedValue(preview({ action: "segment_prompt", targetId: "segment-1", confirmationToken: "token-1" }));
    const execute = spyOn(api, "executeDramaStudioAction").mockResolvedValue({ queued: 1, action: "segment_prompt", targetId: "segment-1" });
    await render();
    await act(async () => controller!.requestAction({ action: "segment_prompt", targetId: "segment-1", episodeId: "episode-1", episodeNumber: 4, targetRevision: 3 }));
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(dialogText()).toContain("重新撰写本段提示词");
    expect(dialogText()).toContain("第 4 集");
    expect(dialogText()).toContain("2.5 积分");
});

test("确认时重新预检，令牌或报价变化后不执行", async () => {
    const accepted = preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-1", amountMicrocredits: 1_000_000 });
    const changedQuote = preview({ ...accepted, confirmationToken: "token-2", amountMicrocredits: 9_000_000, message: "费用已更新" });
    const preflight = spyOn(api, "preflightDramaStudioAction").mockResolvedValueOnce(accepted).mockResolvedValueOnce(changedQuote);
    const execute = spyOn(api, "executeDramaStudioAction").mockResolvedValue({ queued: 1, action: "segment_video", targetId: "segment-1" });
    await render();
    await act(async () => controller!.requestVideo({ id: "episode-1", number: 1 }, segment(), { logicalModelId: "video-a", label: "视频甲" }));
    await click("确认提交");
    expect(execute).not.toHaveBeenCalled();
    expect(dialogText()).toContain("费用已更新");
    expect(dialogText()).toContain("9 积分");
    expect(dialogText()).toContain("请查看最新结果后重新确认");
    expect(controller!.state.submitted).toBe(false);
});

test("确认通过后用最新令牌执行，并报告真实排队数", async () => {
    const accepted = preview({ action: "segment_reprocess", targetId: "segment-1", confirmationToken: "token-1" });
    const preflight = spyOn(api, "preflightDramaStudioAction").mockResolvedValue(accepted);
    const execute = spyOn(api, "executeDramaStudioAction").mockResolvedValue({ queued: 1, action: "segment_reprocess", targetId: "segment-1" });
    await render();
    await act(async () => controller!.requestAction({ action: "segment_reprocess", targetId: "segment-1", episodeId: "episode-1", videoModel: { modelKey: "keep" } }));
    await click("确认提交");
    expect(preflight).toHaveBeenCalledTimes(2);
    const sent = execute.mock.calls[0]?.[1] as DramaStudioActionRequest;
    expect(sent.confirmationToken).toBe("token-1");
    expect(sent.baseRevision).toBe(8);
    expect(sent.targetRevision).toBe(3);
    expect(sent.videoModel).toEqual({ modelKey: "keep" });
    expect(dialogText()).toContain("已提交 1 个任务");
    expect(dialogText()).toContain("可在下方制作队列查看进度");
    changed.resolve();
    await act(async () => {});
});

test("排队数为 0 也如实展示，不算成功提交了任务", async () => {
    spyOn(api, "preflightDramaStudioAction").mockResolvedValue(preview({ action: "cast_image", targetId: "cast-1", confirmationToken: "token-1", episodeId: undefined }));
    spyOn(api, "executeDramaStudioAction").mockResolvedValue({ queued: 0, action: "cast_image", targetId: "cast-1" });
    await render();
    await act(async () => controller!.requestCastImage({ id: "cast-1", name: "林夏" }));
    await click("确认提交");
    expect(controller!.state.queued).toBe(0);
    expect(controller!.state.submitted).toBe(false);
    expect(dialogText()).toContain("本次没有新增任务");
    expect(dialogText()).not.toContain("已提交 0 个任务");
    expect(dialogText()).toContain("林夏");
});

test("缺失资产只切换到参考图预检，不会自动提交视频", async () => {
    const video = preview({
        action: "segment_video",
        targetId: "segment-1",
        confirmationToken: "video-token",
        ready: false,
        reason: "参考图还没准备好",
        missingCasts: [{ id: "cast-1", name: "林夏" }],
        warnings: ["本段会等待参考图"],
    });
    const assets = preview({ action: "segment_assets", targetId: "segment-1", confirmationToken: "asset-token", message: "将生成 1 张缺失参考图", amountMicrocredits: 500_000 });
    const preflight = spyOn(api, "preflightDramaStudioAction").mockImplementation(async (_projectId, request) => (request.action === "segment_assets" ? assets : video));
    const execute = spyOn(api, "executeDramaStudioAction").mockResolvedValue({ queued: 1, action: "segment_assets", targetId: "segment-1" });
    const model: DramaModelChoice = { logicalModelId: "video-a" };
    await render();
    await act(async () => controller!.requestVideo({ id: "episode-1", number: 2 }, segment(), model));
    expect(dialogText()).toContain("林夏");
    expect(dialogText()).toContain("参考图还没准备好");
    expect(dialogText()).toContain("本段会等待参考图");
    await click("只生成缺失的参考图");
    expect(execute).not.toHaveBeenCalled();
    expect(controller!.state.request?.action).toBe("segment_assets");
    expect(controller!.state.request?.videoModel).toEqual(model);
    expect(dialogText()).toContain("生成视频需另行确认");
    await click("确认提交");
    expect(execute).toHaveBeenCalledTimes(1);
    expect((execute.mock.calls[0]?.[1] as DramaStudioActionRequest).action).toBe("segment_assets");
    expect(dialogText()).toContain("视频还没有提交");
    await click("重新检查本段视频");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(preflight.mock.calls.at(-1)?.[1].action).toBe("segment_video");
    expect(controller!.state.submitted).toBe(false);
});

test("确认按钮连点只执行一次", async () => {
    const gate = deferred<DramaStudioActionPreflight>();
    spyOn(api, "preflightDramaStudioAction")
        .mockResolvedValueOnce(preview({ action: "segment_prompt", targetId: "segment-1", confirmationToken: "token-1" }))
        .mockImplementationOnce(() => gate.promise);
    const execute = spyOn(api, "executeDramaStudioAction").mockResolvedValue({ queued: 1, action: "segment_prompt", targetId: "segment-1" });
    await render();
    await act(async () => controller!.requestAction({ action: "segment_prompt", targetId: "segment-1", episodeId: "episode-1" }));
    let pending!: Promise<void>;
    await act(async () => {
        pending = controller!.confirm();
        await controller!.confirm();
    });
    expect(execute).not.toHaveBeenCalled();
    gate.resolve(preview({ action: "segment_prompt", targetId: "segment-1", confirmationToken: "token-1" }));
    await act(async () => {
        await pending;
    });
    expect(execute).toHaveBeenCalledTimes(1);
});

test("切换目标后，旧目标晚到的预检不能覆盖新弹窗", async () => {
    const first = deferred<DramaStudioActionPreflight>();
    const second = preview({ action: "cast_image", targetId: "cast-2", confirmationToken: "new-token", episodeId: undefined, message: "新的角色检查" });
    const preflight = spyOn(api, "preflightDramaStudioAction")
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValueOnce(second);
    await render();
    await act(async () => controller!.requestAction({ action: "segment_video", targetId: "segment-old", episodeId: "episode-1", segmentTitle: "旧段" }));
    await act(async () => controller!.requestCastImage({ id: "cast-2", name: "新角色" }));
    first.resolve(preview({ action: "segment_video", targetId: "segment-old", confirmationToken: "old-token", message: "旧段可以生成" }));
    await act(async () => {
        await preflight.mock.results[0]?.value;
    });
    await flush();
    expect(controller!.state.request?.targetId).toBe("cast-2");
    expect(controller!.state.preview?.confirmationToken).toBe("new-token");
    expect(dialogText()).not.toContain("旧段可以生成");
    expect(dialogText()).toContain("新的角色检查");
});

test("重新检查期间切换账号或项目后，旧确认不能执行", async () => {
    const gate = deferred<DramaStudioActionPreflight>();
    spyOn(api, "preflightDramaStudioAction")
        .mockResolvedValueOnce(preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-1" }))
        .mockImplementationOnce(() => gate.promise);
    const execute = spyOn(api, "executeDramaStudioAction").mockResolvedValue({ queued: 1, action: "segment_video", targetId: "segment-1" });
    await render();
    await act(async () => controller!.requestVideo({ id: "episode-1", number: 1 }, segment()));
    let pending!: Promise<void>;
    await act(async () => {
        pending = controller!.confirm();
    });
    projectId = "project-2";
    await render();
    gate.resolve(preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-1" }));
    await act(async () => {
        await pending;
    });
    expect(execute).not.toHaveBeenCalled();
    expect(controller!.state.open).toBe(false);
});

test("重新检查期间切换登录范围后，旧确认不能执行", async () => {
    const gate = deferred<DramaStudioActionPreflight>();
    spyOn(api, "preflightDramaStudioAction")
        .mockResolvedValueOnce(preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-1" }))
        .mockImplementationOnce(() => gate.promise);
    const execute = spyOn(api, "executeDramaStudioAction").mockResolvedValue({ queued: 1, action: "segment_video", targetId: "segment-1" });
    await render();
    await act(async () => controller!.requestVideo({ id: "episode-1", number: 1 }, segment()));
    let pending!: Promise<void>;
    await act(async () => {
        pending = controller!.confirm();
        useUserStore.setState({ user: { id: "user-b", username: "b", displayName: "乙", role: "user", status: "active" } });
        setActiveUserScope("scope-b");
    });
    gate.resolve(preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-1" }));
    await act(async () => {
        await pending;
    });
    await flush();
    expect(execute).not.toHaveBeenCalled();
    expect(controller!.state.open).toBe(false);
});

test("执行失败会清掉旧确认，重试只重新预检", async () => {
    const failed = preview({ action: "segment_prompt", targetId: "segment-1", confirmationToken: "token-1" });
    const retried = preview({ ...failed, confirmationToken: "token-2", message: "重新检查完成" });
    const preflight = spyOn(api, "preflightDramaStudioAction").mockResolvedValueOnce(failed).mockResolvedValueOnce(failed).mockResolvedValueOnce(retried);
    spyOn(api, "executeDramaStudioAction").mockRejectedValueOnce(new Error("余额不足"));
    await render();
    await act(async () => controller!.requestAction({ action: "segment_prompt", targetId: "segment-1", episodeId: "episode-1" }));
    await click("确认提交");
    expect(controller!.state.preview).toBeNull();
    expect(dialogText()).toContain("余额不足");
    await click("重试");
    expect(preflight).toHaveBeenCalledTimes(3);
    expect(controller!.state.preview?.confirmationToken).toBe("token-2");
    expect(controller!.state.submitted).toBe(false);
});

test("关闭或同步换目标后，旧确认不能预检或执行", async () => {
    const gate = deferred<DramaStudioActionPreflight>();
    const preflight = spyOn(api, "preflightDramaStudioAction").mockImplementation(async (_projectId, request) => (request.targetId === "cast-9" ? gate.promise : preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-1" })));
    const execute = spyOn(api, "executeDramaStudioAction").mockResolvedValue({ queued: 1, action: "segment_video", targetId: "segment-1" });
    await render();
    await act(async () => controller!.requestVideo({ id: "episode-1", number: 1 }, segment()));
    const staleConfirm = controller!.confirm;
    const staleRetry = controller!.retry;
    const staleMissing = controller!.requestMissingAssets;
    const staleRecheck = controller!.recheckVideo;
    await act(async () => {
        controller!.close();
        await staleConfirm();
        staleRetry();
        staleMissing();
        staleRecheck();
    });
    await flush();
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(controller!.state.open).toBe(false);

    await act(async () => controller!.requestVideo({ id: "episode-1", number: 1 }, segment()));
    const replacedConfirm = controller!.confirm;
    const replacedRetry = controller!.retry;
    const replacedMissing = controller!.requestMissingAssets;
    const replacedRecheck = controller!.recheckVideo;
    await act(async () => {
        controller!.requestCastImage({ id: "cast-9", name: "新角色" });
        await replacedConfirm();
        replacedRetry();
        replacedMissing();
        replacedRecheck();
    });
    await flush();
    expect(execute).not.toHaveBeenCalled();
    expect(controller!.state.request?.targetId).toBe("cast-9");
    expect(controller!.state.request?.action).toBe("cast_image");
    expect(preflight).toHaveBeenCalledTimes(3);
    gate.resolve(preview({ action: "cast_image", targetId: "cast-9", confirmationToken: "new-token", episodeId: undefined }));
    await flush();
    expect(controller!.state.preview?.targetId).toBe("cast-9");
    expect(execute).not.toHaveBeenCalled();
});

test("版本冲突后重试丢掉旧修订和界面字段，确认时用新报价执行", async () => {
    const stale = preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-old", targetRevision: 3, baseRevision: 8, message: "旧报价" });
    const currentQuote = preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-new", targetRevision: 11, baseRevision: 20, amountMicrocredits: 4_000_000, message: "当前报价", episodeId: "episode-1" });
    const preflight = spyOn(api, "preflightDramaStudioAction").mockResolvedValueOnce(stale).mockResolvedValueOnce(stale).mockResolvedValueOnce(currentQuote).mockResolvedValueOnce(currentQuote);
    const execute = spyOn(api, "executeDramaStudioAction").mockRejectedValueOnce(new Error("内容版本冲突，请重新检查")).mockResolvedValueOnce({ queued: 1, action: "segment_video", targetId: "segment-1" });
    await render();
    const model: DramaModelChoice = { logicalModelId: "video-a", label: "视频甲" };
    await act(async () =>
        controller!.requestAction({ action: "segment_video", targetId: "segment-1", episodeId: "episode-1", episodeNumber: 6, segmentTitle: "雨夜追车", videoModel: model, baseRevision: 8, targetRevision: 3, confirmationToken: "input-old" }),
    );
    await click("确认提交");
    expect(dialogText()).toContain("内容版本冲突");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(controller!.state.preview).toBeNull();
    await click("重试");
    const retried = preflight.mock.calls[2]?.[1] as DramaStudioActionRequest;
    expect(retried.action).toBe("segment_video");
    expect(retried.targetId).toBe("segment-1");
    expect(retried.episodeId).toBe("episode-1");
    expect(retried.videoModel).toEqual(model);
    expect(retried.baseRevision).toBeUndefined();
    expect(retried.targetRevision).toBeUndefined();
    expect(retried.confirmationToken).toBeUndefined();
    expect(retried).not.toHaveProperty("episodeNumber");
    expect(retried).not.toHaveProperty("segmentTitle");
    expect(dialogText()).toContain("当前报价");
    expect(dialogText()).toContain("第 6 集");
    expect(dialogText()).toContain("雨夜追车");
    await click("确认提交");
    const recheck = preflight.mock.calls[3]?.[1] as DramaStudioActionRequest;
    expect(recheck.baseRevision).toBeUndefined();
    expect(recheck.targetRevision).toBeUndefined();
    expect(recheck.confirmationToken).toBeUndefined();
    expect(recheck).not.toHaveProperty("episodeNumber");
    expect(recheck).not.toHaveProperty("segmentTitle");
    expect(recheck.videoModel).toEqual(model);
    const sent = execute.mock.calls.at(-1)?.[1] as DramaStudioActionRequest;
    expect(sent.confirmationToken).toBe("token-new");
    expect(sent.baseRevision).toBe(20);
    expect(sent.targetRevision).toBe(11);
    expect(sent.videoModel).toEqual(model);
    expect(dialogText()).toContain("已提交 1 个任务");
});

test("提交成功后刷新失败仍保留回执，不能再执行一次", async () => {
    const pendingChange = deferred<void>();
    changed = pendingChange;
    spyOn(api, "preflightDramaStudioAction").mockResolvedValue(preview({ action: "segment_prompt", targetId: "segment-1", confirmationToken: "token-1" }));
    const execute = spyOn(api, "executeDramaStudioAction").mockResolvedValue({ queued: 2, action: "segment_prompt", targetId: "segment-1" });
    await render();
    await act(async () => controller!.requestAction({ action: "segment_prompt", targetId: "segment-1", episodeId: "episode-1", episodeNumber: 1 }));
    let pending!: Promise<void>;
    await act(async () => {
        pending = controller!.confirm();
    });
    await flush();
    pendingChange.reject(new Error("刷新失败"));
    await act(async () => {
        await pending;
    });
    expect(controller!.state.submitted).toBe(true);
    expect(controller!.state.queued).toBe(2);
    expect(dialogText()).toContain("已提交 2 个任务");
    expect(dialogText()).toContain("页面刷新失败");
    expect(dialogText()).not.toContain("提交失败");
    expect(dialogText()).not.toContain("重试");
    await act(async () => controller!.retry());
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(controller!.state.submitted).toBe(true);
    expect(controller!.state.queued).toBe(2);
});

test("重新检查期间同步登出再登回同一账号，旧确认不能执行", async () => {
    const gate = deferred<DramaStudioActionPreflight>();
    spyOn(api, "preflightDramaStudioAction")
        .mockResolvedValueOnce(preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-1" }))
        .mockImplementationOnce(() => gate.promise);
    const execute = spyOn(api, "executeDramaStudioAction").mockResolvedValue({ queued: 1, action: "segment_video", targetId: "segment-1" });
    await render();
    await act(async () => controller!.requestVideo({ id: "episode-1", number: 1 }, segment()));
    let pending!: Promise<void>;
    await act(async () => {
        pending = controller!.confirm();
    });
    await flush();
    expect(controller!.state.submitting).toBe(true);
    await act(async () => {
        useUserStore.setState({ user: null });
        useUserStore.setState({ user: { id: "user-a", username: "a", displayName: "甲", role: "user", status: "active" } });
    });
    gate.resolve(preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-1" }));
    await act(async () => {
        await pending;
    });
    await flush();
    expect(execute).not.toHaveBeenCalled();
    expect(controller!.state.open).toBe(false);
});

test("卸载或执行开始后关闭，晚到结果不能重开弹窗或刷新新目标", async () => {
    const recheck = deferred<DramaStudioActionPreflight>();
    const preflight = spyOn(api, "preflightDramaStudioAction")
        .mockResolvedValueOnce(preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-1" }))
        .mockImplementationOnce(() => recheck.promise);
    const execute = spyOn(api, "executeDramaStudioAction").mockResolvedValue({ queued: 1, action: "segment_video", targetId: "segment-1" });
    await render();
    await act(async () => controller!.requestVideo({ id: "episode-1", number: 1 }, segment()));
    let pendingRecheck!: Promise<void>;
    await act(async () => {
        pendingRecheck = controller!.confirm();
    });
    await act(async () => root.unmount());
    recheck.resolve(preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-1" }));
    await act(async () => {
        await pendingRecheck;
    });
    expect(execute).not.toHaveBeenCalled();

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const execution = deferred<{ queued: number; action: "segment_video"; targetId: string }>();
    preflight.mockResolvedValue(preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-2" }));
    execute.mockImplementation(() => execution.promise);
    await render();
    await act(async () => controller!.requestVideo({ id: "episode-1", number: 1 }, segment()));
    let pendingExecute!: Promise<void>;
    await act(async () => {
        pendingExecute = controller!.confirm();
    });
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    await act(async () => controller!.close());
    await act(async () => controller!.requestCastImage({ id: "cast-new", name: "后来的角色" }));
    execution.resolve({ queued: 1, action: "segment_video", targetId: "segment-1" });
    await act(async () => {
        await pendingExecute;
    });
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(changedCalls).toBe(0);
    expect(controller!.state.request?.targetId).toBe("cast-new");
    expect(controller!.state.submitted).toBe(false);
    expect(dialogText()).not.toContain("已提交 1 个任务");
    expect(dialogText()).toContain("后来的角色");
});

test("第 0 段显示为第 1 段，异常排队数不能当成已提交再付费执行", async () => {
    changed = deferred();
    spyOn(api, "preflightDramaStudioAction").mockResolvedValue(preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "token-1", segmentIndex: 0, message: "可以生成" }));
    const execute = spyOn(api, "executeDramaStudioAction").mockResolvedValue({ queued: Number.NaN, action: "segment_video", targetId: "segment-1" });
    await render();
    await act(async () => controller!.requestVideo({ id: "episode-1", number: 1 }, segment()));
    expect(dialogText()).toContain("第 1 段");
    let pending!: Promise<void>;
    await act(async () => {
        pending = controller!.confirm();
    });
    await act(async () => {
        changed.reject(new Error("刷新失败"));
        await pending;
    });
    expect(controller!.state.queued).toBe(0);
    expect(controller!.state.submitted).toBe(true);
    expect(dialogText()).toContain("任务回执异常");
    expect(dialogText()).toContain("页面刷新失败");
    expect(dialogText()).not.toContain("本次没有新增任务");
    expect(dialogText()).not.toContain("已提交");
    expect(dialogText()).not.toContain("重试");
    await act(async () => controller!.retry());
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(controller!.state.submitted).toBe(true);
});

test("费用不可用和阻塞原因都原样展示", async () => {
    spyOn(api, "preflightDramaStudioAction").mockResolvedValue(
        preview({ action: "segment_video", targetId: "segment-1", confirmationToken: "", ready: false, priced: false, amountMicrocredits: 0, reason: "预算已用完", message: "当前不能生成", warnings: ["等待上一段"] }),
    );
    await render();
    await act(async () => controller!.requestVideo({ id: "episode-1", number: 3 }, segment()));
    expect(dialogText()).toContain("暂无法估算费用");
    expect(dialogText()).toContain("预算已用完");
    expect(dialogText()).toContain("等待上一段");
    expect(controller!.state.preview?.ready).toBe(false);
});
