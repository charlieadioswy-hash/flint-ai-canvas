import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { DramaStudioActionPreflight, DramaStudioActionRequest, DramaSegment } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/projects/project" });
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, IS_REACT_ACT_ENVIRONMENT: true }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const preflightCalls: Array<{ projectId: string; request: DramaStudioActionRequest }> = [];
const executions: Array<{ projectId: string; request: DramaStudioActionRequest }> = [];
const writes: unknown[] = [];
let token = "token-1";
let ready = true;
let productionRevision = 8;
let delay: Promise<void> | undefined;
let writeDelay: Promise<void> | undefined;
let executeDelay: Promise<void> | undefined;
let externalWriteAfterSave = false;
mock.module("antd", () => ({ App: { useApp: () => ({ message: { success() {} } }) }, Button: ({ children, ...props }: Record<string, unknown>) => createElement("button", { ...props, type: "button" }, children as never) }));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module("@/services/api/drama", () => ({
    preflightDramaStudioAction: async (projectId: string, request: DramaStudioActionRequest): Promise<DramaStudioActionPreflight> => {
        preflightCalls.push({ projectId, request });
        await delay;
        return {
            action: request.action,
            targetId: request.targetId,
            episodeId: request.episodeId,
            segmentIndex: 1,
            targetRevision: request.targetRevision || 3,
            baseRevision: productionRevision,
            ready: request.action === "cast_image" || ready,
            message: ready ? "仅生成指定段" : "缺少必需参考图：主角",
            confirmationToken: token,
            missingCasts: ready ? [] : [{ id: "cast-one", name: "主角" }],
            warnings: [],
            canUseText: false,
            reprocessable: false,
            priced: true,
            amountMicrocredits: 500000,
        };
    },
    executeDramaStudioAction: async (projectId: string, request: DramaStudioActionRequest) => {
        executions.push({ projectId, request });
        await executeDelay;
        return { queued: 1 };
    },
    getDrama: async (projectId: string) => ({ project: { id: projectId }, production: { revision: productionRevision, guideStep: "completed" }, episodes: [] }),
    getDramaEpisode: async () => ({ segments: [] }),
    updateDramaShot: async (...args: unknown[]) => {
        writes.push(args);
        await writeDelay;
        productionRevision += externalWriteAfterSave ? 2 : 1;
    },
    updateDramaSegment: async (...args: unknown[]) => {
        writes.push(args);
        productionRevision += 1;
    },
    updateDramaCast: async (...args: unknown[]) => {
        writes.push(args);
        productionRevision += 1;
    },
}));
const { useDramaMediaAgent, confirmDramaMediaAction } = await import("@/pages/projects/studio/use-drama-media-agent");
const { appendDramaAgentReference } = await import("@/lib/canvas/drama-agent-reference");
const { useGlobalAgentStore } = await import("@/stores/use-global-agent-store");
const { useUserStore } = await import("@/stores/use-user-store");
let controls: ReturnType<typeof useDramaMediaAgent>;
function Harness({ projectId = "project" }: { projectId?: string }) {
    controls = useDramaMediaAgent({ projectId, onChanged: () => {} });
    return <>{controls.proposalChoices?.render(controls.proposalChoices.proposals)}</>;
}
const segment = { id: "segment-one", index: 1, title: "森林", revision: 3 } as DramaSegment;
const episode = { id: "episode-one", number: 2 };
const container = document.createElement("div");
document.body.append(container);
let root = createRoot(container);
const settle = async () => {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
};
const click = async (text: string) => {
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
    if (!button) throw new Error(`missing ${text}: ${container.textContent}`);
    await act(async () => {
        button.click();
        await Promise.resolve();
    });
    await settle();
};
beforeEach(async () => {
    await act(async () => root.unmount());
    root = createRoot(container);
    preflightCalls.length = 0;
    executions.length = 0;
    writes.length = 0;
    token = "token-1";
    ready = true;
    productionRevision = 8;
    delay = undefined;
    writeDelay = undefined;
    executeDelay = undefined;
    externalWriteAfterSave = false;
    useGlobalAgentStore.getState().reset();
    await act(async () => root.render(<Harness />));
});
afterAll(async () => {
    await act(async () => root.unmount());
    browser.happyDOM.abort();
});

test("AI引用只聚焦且保持真实ID，详细视图切换保留引用并走同一入口", async () => {
    act(() => controls.referenceSegment(episode, segment));
    const reference = useGlobalAgentStore.getState().dramaReference!;
    expect(reference).toMatchObject({ projectId: "project", episodeId: "episode-one", segmentId: "segment-one", segmentIndex: 1, revision: 3 });
    expect(executions).toHaveLength(0);
    expect(preflightCalls).toHaveLength(0);
    const outgoing = appendDramaAgentReference("慢一点", reference);
    expect(outgoing.text).toContain('"segmentId":"segment-one"');
    expect(outgoing.displayText).toContain("第 2 集 · 第 2 段");
    let opened = 0;
    useGlobalAgentStore.getState().setDrama({ projectId: "project", guideConversationId: "same-chat", onOpenStudio: () => opened++ });
    useGlobalAgentStore.getState().openAgent();
    expect(opened).toBe(1);
    useGlobalAgentStore.getState().setDrama(null);
    expect(useGlobalAgentStore.getState().dramaReference).toEqual(reference);
    useGlobalAgentStore.getState().setDramaReference(null);
    expect(appendDramaAgentReference("慢一点", useGlobalAgentStore.getState().dramaReference)).toEqual({ text: "慢一点" });
});

test("卡片仅预检，报价变化后要再次确认且只执行原指定对象", async () => {
    await act(async () => {
        await controls.requestVideo(episode, segment, { logicalModelId: "chosen" });
    });
    expect(executions).toHaveLength(0);
    token = "token-2";
    await click("确认生成本段视频");
    expect(executions).toHaveLength(0);
    expect(container.textContent).toContain("条件或费用已变化");
    await click("确认生成本段视频");
    expect(executions).toHaveLength(1);
    expect(controls.proposalChoices).toBeUndefined();
    expect(executions[0]).toEqual({
        projectId: "project",
        request: { action: "segment_video", targetId: "segment-one", episodeId: "episode-one", targetRevision: 3, baseRevision: 8, confirmationToken: "token-2", videoModel: { logicalModelId: "chosen" } },
    });
});

test("缺图不自动创建图片，点击缺图选项仍需确认具体资产", async () => {
    ready = false;
    await act(async () => {
        await controls.requestVideo(episode, segment);
    });
    expect(container.textContent).toContain("缺少必需参考图");
    expect(container.textContent).not.toContain("确认生成本段视频");
    await click("生成「主角」参考图");
    expect(executions).toHaveLength(0);
    await click("确认生成这张参考图");
    expect(executions).toHaveLength(1);
    expect(executions[0]?.request.targetId).toBe("cast-one");
    expect(executions[0]?.request.action).toBe("cast_image");
});

test("制作阶段文字建议仍可保存并拒绝过期版本", async () => {
    act(() => controls.onProposal({ kind: "shot", targetId: "shot-one", baseRevision: 8, runId: "run", toolCallId: "shot", changes: { dialogue: "别怕" } }));
    await click("确认保存分镜修改");
    expect(writes).toEqual([["project", "shot-one", { dialogue: "别怕", expectedRevision: 8 }]]);
    act(() => controls.onProposal({ kind: "cast", targetId: "cast-one", baseRevision: 7, runId: "run", toolCallId: "cast", changes: { appearance: "白衣" } }));
    await click("确认保存资产设定");
    expect(writes).toHaveLength(1);
    expect(container.textContent).toContain("作品内容已变化");
});

test("预检期间已离开原作品时不提交旧作品任务", async () => {
    const accepted = { action: "segment_video", targetId: "segment-one", episodeId: "episode-one", baseRevision: 8, targetRevision: 3, ready: true, confirmationToken: token } as DramaStudioActionPreflight;
    const result = await confirmDramaMediaAction("project", { action: "segment_video", targetId: "segment-one", episodeId: "episode-one" }, accepted, () => false);
    expect(result.submitted).toBe(false);
    expect(executions).toHaveLength(0);
});

const shotProposal = (targetId: string, toolCallId = targetId) => ({ kind: "shot" as const, targetId, baseRevision: 8, runId: "same-run", toolCallId, changes: { dialogue: "别怕" } });
const remount = async (projectId = "project") => {
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Harness projectId={projectId} />));
};

test("同轮独立建议接续本地版本，目标冲突和外部版本变化仍拒绝", async () => {
    act(() => {
        controls.onProposal(shotProposal("shot-one"));
        controls.onProposal(shotProposal("shot-two"));
        controls.onProposal(shotProposal("shot-one", "conflict"));
        controls.onProposal(shotProposal("shot-three"));
    });
    await click("确认保存分镜修改");
    await click("确认保存分镜修改");
    expect(writes).toEqual([
        ["project", "shot-one", { dialogue: "别怕", expectedRevision: 8 }],
        ["project", "shot-two", { dialogue: "别怕", expectedRevision: 9 }],
    ]);
    await click("确认保存分镜修改");
    expect(writes).toHaveLength(2);
    expect(container.textContent).toContain("作品内容已变化");
    productionRevision += 1;
    const last = [...container.querySelectorAll("button")].filter((button) => button.textContent?.includes("确认保存分镜修改")).at(-1)!;
    await act(async () => last.click());
    await settle();
    expect(writes).toHaveLength(2);
});

test("同时选择不同建议时串行保存，外部并发不能借本地批次接续", async () => {
    let finish!: () => void;
    writeDelay = new Promise<void>((resolve) => {
        finish = resolve;
    });
    act(() => {
        controls.onProposal(shotProposal("shot-one"));
        controls.onProposal(shotProposal("shot-two"));
    });
    const choices = [...container.querySelectorAll("button")].filter((button) => button.textContent?.includes("确认保存分镜修改"));
    await act(async () => {
        choices[0]!.click();
        choices[1]!.click();
    });
    expect(writes).toHaveLength(1);
    externalWriteAfterSave = true;
    await act(async () => finish());
    await settle();
    expect(writes).toHaveLength(1);
    expect(container.textContent).toContain("作品内容已变化");
});

test("并发选择独立建议按服务端确认版本依次保存", async () => {
    let finish!: () => void;
    writeDelay = new Promise<void>((resolve) => {
        finish = resolve;
    });
    act(() => {
        controls.onProposal(shotProposal("shot-one"));
        controls.onProposal(shotProposal("shot-two"));
    });
    const choices = [...container.querySelectorAll("button")].filter((button) => button.textContent?.includes("确认保存分镜修改"));
    await act(async () => {
        choices[0]!.click();
        choices[1]!.click();
    });
    expect(writes).toHaveLength(1);
    await act(async () => finish());
    await settle();
    expect(writes).toEqual([
        ["project", "shot-one", { dialogue: "别怕", expectedRevision: 8 }],
        ["project", "shot-two", { dialogue: "别怕", expectedRevision: 9 }],
    ]);
    expect(controls.proposalChoices).toBeUndefined();
});

test("已开始的文字保存跨视图收尾，恢复后独立建议仍可接续", async () => {
    let finish!: () => void;
    writeDelay = new Promise<void>((resolve) => {
        finish = resolve;
    });
    act(() => {
        controls.onProposal(shotProposal("shot-one"));
        controls.onProposal(shotProposal("shot-two"));
    });
    await click("确认保存分镜修改");
    await remount();
    await act(async () => finish());
    await settle();
    await click("确认保存分镜修改");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(["project", "shot-two", { dialogue: "别怕", expectedRevision: 9 }]);
    expect(controls.proposalChoices).toBeUndefined();
});

test("往返视图恢复待确认操作，已应用或忽略的建议不再出现", async () => {
    act(() => controls.onProposal(shotProposal("shot-one")));
    await act(async () => {
        await controls.requestVideo(episode, segment);
    });
    await remount();
    expect(container.textContent).toContain("确认保存分镜修改");
    expect(container.textContent).toContain("确认生成本段视频");
    expect(preflightCalls).toHaveLength(1);
    await click("确认保存分镜修改");
    await click("暂不操作");
    await remount();
    act(() => controls.onProposal(shotProposal("shot-one")));
    expect(controls.proposalChoices).toBeUndefined();
    expect(executions).toHaveLength(0);
});

test("预检和已提交请求在视图切换后正常收尾，不重复执行", async () => {
    let finishPreview!: () => void;
    delay = new Promise<void>((resolve) => {
        finishPreview = resolve;
    });
    let pendingPreview!: Promise<void>;
    act(() => {
        pendingPreview = controls.requestVideo(episode, segment);
    });
    await remount();
    expect(container.textContent).toContain("正在检查当前对象");
    await act(async () => {
        finishPreview();
        await pendingPreview;
    });
    expect(container.textContent).toContain("确认生成本段视频");
    let finishExecution!: () => void;
    executeDelay = new Promise<void>((resolve) => {
        finishExecution = resolve;
    });
    await click("确认生成本段视频");
    expect(executions).toHaveLength(1);
    await remount();
    await act(async () => finishExecution());
    await settle();
    expect(controls.proposalChoices).toBeUndefined();
    await remount();
    expect(controls.proposalChoices).toBeUndefined();
    expect(executions).toHaveLength(1);
});

test("不同作品与账号隔离待确认状态，重置后旧回执不能恢复选项", async () => {
    act(() => controls.onProposal(shotProposal("shot-one")));
    await remount("another-project");
    expect(controls.proposalChoices).toBeUndefined();
    await remount();
    expect(container.textContent).toContain("确认保存分镜修改");
    await act(async () => useUserStore.setState({ user: { id: "another-account" } as never }));
    expect(controls.proposalChoices).toBeUndefined();
    let finishPreview!: () => void;
    delay = new Promise<void>((resolve) => {
        finishPreview = resolve;
    });
    let pendingPreview!: Promise<void>;
    act(() => {
        pendingPreview = controls.requestVideo(episode, segment);
    });
    await act(async () => useGlobalAgentStore.getState().reset());
    await act(async () => {
        finishPreview();
        await pendingPreview;
    });
    expect(controls.proposalChoices).toBeUndefined();
    expect(executions).toHaveLength(0);
    await act(async () => useUserStore.setState({ user: null }));
});
