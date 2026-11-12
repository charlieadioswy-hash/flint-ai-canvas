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
let missingCasts: DramaStudioActionPreflight["missingCasts"] = [];
let productionRevision = 8;
let delay: Promise<void> | undefined;
let writeDelay: Promise<void> | undefined;
let executeDelay: Promise<void> | undefined;
let preflightFailure: Error | undefined;
let externalWriteAfterSave = false;
mock.module("antd", () => ({ App: { useApp: () => ({ message: { success() {} } }) }, Button: ({ children, ...props }: Record<string, unknown>) => createElement("button", { ...props, type: "button" }, children as never) }));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module("@/services/api/drama", () => ({
    preflightDramaStudioAction: async (projectId: string, request: DramaStudioActionRequest): Promise<DramaStudioActionPreflight> => {
        preflightCalls.push({ projectId, request });
        await delay;
        if (preflightFailure) throw preflightFailure;
        const assetBatch = request.action === "segment_assets";
        const missingBase = request.action === "cast_image" && request.targetId === "look-one";
        return {
            action: request.action,
            targetId: request.targetId,
            episodeId: request.episodeId,
            segmentIndex: 1,
            targetRevision: request.targetRevision || 3,
            baseRevision: productionRevision,
            ready: assetBatch ? missingCasts.length > 0 : request.action === "cast_image" ? !missingBase : ready,
            message: assetBatch ? `仅生成本段缺失的 ${missingCasts.length} 个资产参考图，不生成视频` : missingBase ? "请先生成角色本体参考图" : ready ? "仅生成指定段" : "缺少必需参考图：主角",
            confirmationToken: token,
            missingCasts: request.action === "cast_image" ? (missingBase ? [{ id: "cast-one", name: "主角" }] : []) : missingCasts,
            warnings: [],
            canUseText: request.action === "segment_video" && ready && missingCasts.length > 0,
            reprocessable: false,
            priced: true,
            amountMicrocredits: assetBatch ? missingCasts.length * 500000 : 500000,
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
const { useDramaMediaAgent, confirmDramaMediaAction, dramaMediaProposalRequest } = await import("@/pages/projects/studio/use-drama-media-agent");
const { appendDramaAgentReference } = await import("@/lib/canvas/drama-agent-reference");
const { useGlobalAgentStore } = await import("@/stores/use-global-agent-store");
const { useUserStore } = await import("@/stores/use-user-store");
const { dramaMediaAccountKey, dramaMediaSession } = await import("@/pages/projects/studio/drama-media-agent-session");
const { dramaProposalKey } = await import("@/pages/projects/guide-state");
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
    missingCasts = [];
    productionRevision = 8;
    delay = undefined;
    writeDelay = undefined;
    executeDelay = undefined;
    preflightFailure = undefined;
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
    const proposal = controls.proposalChoices!.proposals[0]!;
    const originalChoice = controls.proposalChoices!.interactionKey(proposal);
    token = "token-2";
    await click("确认生成本段视频");
    expect(executions).toHaveLength(0);
    expect(container.textContent).toContain("条件或费用已变化");
    expect(controls.proposalChoices!.interactionKey(proposal)).not.toBe(originalChoice);
    await click("确认生成本段视频");
    expect(executions).toHaveLength(1);
    expect(controls.proposalChoices).toBeUndefined();
    expect(executions[0]).toEqual({
        projectId: "project",
        request: { action: "segment_video", targetId: "segment-one", episodeId: "episode-one", targetRevision: 3, baseRevision: 8, confirmationToken: "token-2", videoModel: { logicalModelId: "chosen" } },
    });
});

test("新预检才恢复确认，失败提供独立重试且不保留旧报价", async () => {
    let finish!: () => void;
    delay = new Promise<void>((resolve) => {
        finish = resolve;
    });
    let pending!: Promise<void>;
    act(() => {
        pending = controls.requestVideo(episode, segment);
    });
    const proposal = controls.proposalChoices!.proposals[0]!;
    const loadingChoice = controls.proposalChoices!.interactionKey(proposal);
    expect(loadingChoice).toEndWith(":0");
    await act(async () => {
        finish();
        await pending;
    });
    const originalChoice = controls.proposalChoices!.interactionKey(proposal);
    expect(originalChoice).toEndWith(":1");
    expect(originalChoice).not.toBe(loadingChoice);

    delay = new Promise<void>((resolve) => {
        finish = resolve;
    });
    await click("重新检查当前条件");
    expect(container.textContent).toContain("正在检查当前对象");
    expect(controls.proposalChoices!.interactionKey(proposal)).toBe(originalChoice);
    preflightFailure = new Error("临时预检失败");
    await act(async () => finish());
    await settle();
    expect(container.textContent).toContain("临时预检失败");
    expect(controls.proposalChoices!.interactionKey(proposal)).toBe(`${originalChoice}:retry:1`);
    expect(container.textContent).not.toContain("确认生成本段视频");

    delay = undefined;
    preflightFailure = undefined;
    await click("重新检查当前条件");
    expect(controls.proposalChoices!.interactionKey(proposal)).toEndWith(":2");
    expect(controls.proposalChoices!.interactionKey(proposal)).not.toBe(originalChoice);
    expect(executions).toHaveLength(0);
});

test("多个缺图合并为一个选项，确认后只执行原段的资产批量生成", async () => {
    ready = false;
    missingCasts = [
        { id: "cast-one", name: "主角" },
        { id: "cast-two", name: "房间" },
        { id: "cast-three", name: "钥匙" },
    ];
    await act(async () => {
        await controls.requestVideo(episode, segment);
    });
    expect(container.textContent).toContain("缺少必需参考图");
    expect(container.textContent).not.toContain("确认生成本段视频");
    expect([...container.querySelectorAll("button")].filter((button) => button.textContent?.includes("生成缺失的资产"))).toHaveLength(1);
    for (const cast of missingCasts) expect(container.textContent).not.toContain(`生成「${cast.name}」参考图`);
    expect(executions).toHaveLength(0);

    await click("生成缺失的资产");
    expect(preflightCalls.at(-1)).toEqual({ projectId: "project", request: { action: "segment_assets", targetId: "segment-one", episodeId: "episode-one", targetRevision: 3 } });
    expect(container.textContent).toContain("3 个资产参考图");
    expect(container.textContent).toContain("预计 1.5 积分");
    expect([...container.querySelectorAll("button")].filter((button) => button.textContent?.includes("确认生成缺失的资产"))).toHaveLength(1);
    expect(executions).toHaveLength(0);

    await click("确认生成缺失的资产");
    expect(executions).toEqual([{ projectId: "project", request: { action: "segment_assets", targetId: "segment-one", episodeId: "episode-one", targetRevision: 3, baseRevision: 8, confirmationToken: "token-1" } }]);
    expect(writes).toEqual([]);
});

test("允许按文字生成视频时仍提供唯一缺失资产选项，不自动生成图片或视频", async () => {
    missingCasts = [
        { id: "cast-one", name: "主角" },
        { id: "cast-two", name: "房间" },
    ];
    await act(async () => {
        await controls.requestVideo(episode, segment);
    });
    expect(container.textContent).toContain("确认生成本段视频");
    expect([...container.querySelectorAll("button")].filter((button) => button.textContent?.includes("生成缺失的资产"))).toHaveLength(1);
    expect(container.textContent).not.toContain("生成「主角」参考图");
    expect(container.textContent).not.toContain("生成「房间」参考图");
    expect(executions).toHaveLength(0);
    await click("生成缺失的资产");
    expect(preflightCalls.at(-1)?.request.action).toBe("segment_assets");
    expect(container.textContent).toContain("确认生成缺失的资产");
    expect(executions).toHaveLength(0);
});

test("缺失资产的统一报价变化后再次确认，仅提交当前段的最新报价", async () => {
    ready = false;
    missingCasts = [
        { id: "cast-one", name: "主角" },
        { id: "cast-two", name: "房间" },
    ];
    await act(async () => {
        await controls.requestVideo(episode, segment);
    });
    await click("生成缺失的资产");
    token = "assets-token-2";
    await click("确认生成缺失的资产");
    expect(executions).toHaveLength(0);
    expect(container.textContent).toContain("条件或费用已变化");
    await click("确认生成缺失的资产");
    expect(executions).toEqual([{ projectId: "project", request: { action: "segment_assets", targetId: "segment-one", episodeId: "episode-one", targetRevision: 3, baseRevision: 8, confirmationToken: "assets-token-2" } }]);
});

test("造型参考图缺本体时保留单个本体生成入口，仍须明确确认", async () => {
    await act(async () => {
        await controls.requestAction({ action: "cast_image", targetId: "look-one", targetRevision: 2 });
    });
    expect(container.textContent).toContain("请先生成角色本体参考图");
    expect(container.textContent).toContain("生成「主角」参考图");
    expect(container.textContent).not.toContain("生成缺失的资产");
    expect(container.textContent).not.toContain("确认生成这张参考图");
    await click("生成「主角」参考图");
    expect(preflightCalls.at(-1)).toEqual({ projectId: "project", request: { action: "cast_image", targetId: "cast-one" } });
    expect(executions).toHaveLength(0);
    await click("确认生成这张参考图");
    expect(executions).toEqual([{ projectId: "project", request: { action: "cast_image", targetId: "cast-one", targetRevision: 3, baseRevision: 8, confirmationToken: "token-1" } }]);
});

test("Agent的缺失资产建议通过相同预检入口，不接受缺少剧集的批量建议", async () => {
    missingCasts = [
        { id: "cast-one", name: "主角" },
        { id: "cast-two", name: "房间" },
    ];
    const proposal = { kind: "media" as const, targetId: "segment-one", baseRevision: 8, runId: "agent-run", toolCallId: "assets-call", changes: { action: "segment_assets", episodeId: "episode-one", targetRevision: 3 } };
    const request = { action: "segment_assets", targetId: "segment-one", episodeId: "episode-one", targetRevision: 3, baseRevision: 8 };
    expect(dramaMediaProposalRequest(proposal)).toEqual(request);
    expect(dramaMediaProposalRequest({ ...proposal, changes: { action: "segment_assets", targetRevision: 3 } })).toBeNull();
    act(() => controls.onProposal(proposal));
    await settle();
    expect(preflightCalls).toEqual([{ projectId: "project", request }]);
    expect(container.textContent).toContain("确认生成缺失的资产");
    expect(executions).toHaveLength(0);
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

test("继续对话清理发送前全部建议，随后新增媒体保留且旧建议重放不恢复", async () => {
    const previousShot = shotProposal("shot-one");
    act(() => controls.onProposal(previousShot));
    await act(async () => {
        await controls.requestVideo(episode, segment);
    });
    const previousMedia = controls.proposalChoices!.proposals.find((proposal) => proposal.kind === "media")!;
    const continueConversation = controls.proposalChoices!.onContinueConversation;
    expect(typeof continueConversation).toBe("function");
    const second = { ...segment, id: "segment-two", index: 2, revision: 4 };
    await act(async () => {
        await controls.requestVideo(episode, second);
    });
    await act(async () => continueConversation!());
    const remaining = controls.proposalChoices!.proposals;
    expect(remaining.map((proposal) => [proposal.kind, proposal.targetId])).toEqual([["media", "segment-two"]]);
    expect(executions).toHaveLength(0);
    await remount();
    act(() => {
        controls.onProposal(previousMedia);
        controls.onProposal(previousShot);
    });
    expect(controls.proposalChoices!.proposals.map((proposal) => proposal.targetId)).toEqual(["segment-two"]);
    expect(preflightCalls).toHaveLength(2);
    expect(container.textContent).not.toContain("确认保存分镜修改");
    await click("确认生成本段视频");
    expect(executions).toHaveLength(1);
    expect(executions[0]!.request).toMatchObject({ targetId: "segment-two", episodeId: "episode-one", targetRevision: 4 });
    expect(writes).toEqual([]);
    expect(controls.proposalChoices).toBeUndefined();
    await remount();
    expect(controls.proposalChoices).toBeUndefined();
});

test("继续对话后迟到的旧媒体预检与会话重放不恢复确认，新请求仍可用", async () => {
    let finishPreview!: () => void;
    delay = new Promise<void>((resolve) => {
        finishPreview = resolve;
    });
    let pendingPreview!: Promise<void>;
    act(() => {
        pendingPreview = controls.requestVideo(episode, segment);
    });
    const previousMedia = controls.proposalChoices!.proposals[0]!;
    const session = dramaMediaSession(dramaMediaAccountKey(), "project");
    const previousKey = dramaProposalKey(previousMedia);
    expect(session.getState().previews[previousKey]?.choiceRevision).toBe(0);
    const continueConversation = controls.proposalChoices!.onContinueConversation;
    expect(typeof continueConversation).toBe("function");
    expect(container.textContent).toContain("正在检查当前对象");
    await act(async () => continueConversation!());
    expect(controls.proposalChoices).toBeUndefined();
    await remount();
    expect(controls.proposalChoices).toBeUndefined();
    await act(async () => {
        finishPreview();
        await pendingPreview;
    });
    expect(session.getState().previews[previousKey]?.choiceRevision).toBe(0);
    expect(session.getState().previews[previousKey]?.preview).toBeUndefined();
    await remount();
    act(() => controls.onProposal(previousMedia));
    expect(controls.proposalChoices).toBeUndefined();
    expect(container.textContent).not.toContain("确认生成本段视频");
    expect(preflightCalls).toHaveLength(1);
    expect(executions).toHaveLength(0);
    delay = undefined;
    await act(async () => {
        await controls.requestVideo(episode, segment);
    });
    expect(container.textContent).toContain("确认生成本段视频");
    expect(preflightCalls).toHaveLength(2);
    await click("确认生成本段视频");
    expect(executions).toHaveLength(1);
    expect(executions[0]!.request.targetId).toBe("segment-one");
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
