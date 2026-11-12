import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { CloudAgentChatMessage } from "@/components/canvas/canvas-cloud-agent-chat-ui";
import type { DramaSegment, DramaStudioActionPreflight, DramaStudioActionRequest } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/projects/project" });
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    SVGElement: browser.SVGElement,
    ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
}))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { App } = await import("antd");
const preflights: DramaStudioActionRequest[] = [];
const executions: DramaStudioActionRequest[] = [];
let token = "quote-1";
let preflightFailure: Error | undefined;
let executeFailure: Error | undefined;
let preflightDelay: Promise<void> | undefined;
mock.module("@/services/api/drama", () => ({
    preflightDramaStudioAction: async (_projectId: string, request: DramaStudioActionRequest): Promise<DramaStudioActionPreflight> => {
        preflights.push(request);
        await preflightDelay;
        if (preflightFailure) throw preflightFailure;
        return {
            action: request.action,
            targetId: request.targetId,
            episodeId: request.episodeId,
            segmentIndex: 1,
            targetRevision: 3,
            baseRevision: 8,
            ready: true,
            message: "仅生成指定段",
            confirmationToken: token,
            missingCasts: [],
            warnings: [],
            canUseText: false,
            reprocessable: false,
            priced: true,
            amountMicrocredits: 500000,
        };
    },
    executeDramaStudioAction: async (_projectId: string, request: DramaStudioActionRequest) => {
        if (executeFailure) throw executeFailure;
        executions.push(request);
        return { queued: 1 };
    },
    getDrama: async () => {
        throw new Error("媒体确认不应写入文字");
    },
    getDramaEpisode: async () => {
        throw new Error("媒体确认不应读取文字建议目标");
    },
    updateDramaCast: async () => {
        throw new Error("媒体确认不应修改资产文字");
    },
    updateDramaSegment: async () => {
        throw new Error("媒体确认不应修改段提示词");
    },
    updateDramaShot: async () => {
        throw new Error("媒体确认不应修改镜头文字");
    },
}));
const { useDramaMediaAgent } = await import("@/pages/projects/studio/use-drama-media-agent");
const { AgentConversation } = await import("@/components/canvas/canvas-cloud-agent-panel-parts");
const { canvasThemes } = await import("@/lib/canvas-theme");
const { createAgentChoiceHistory } = await import("@/lib/canvas/agent-reply-options");
const { useGlobalAgentStore } = await import("@/stores/use-global-agent-store");

let controls: ReturnType<typeof useDramaMediaAgent>;
let messages: CloudAgentChatMessage[];
let history = createAgentChoiceHistory();
function Harness() {
    controls = useDramaMediaAgent({ projectId: "project", onChanged: () => {} });
    return (
        <AgentConversation
            guideMode
            dramaStudio
            theme={canvasThemes.light}
            messages={messages}
            choiceHistoryState={history}
            proposalChoices={controls.proposalChoices}
            references={[]}
            busy={false}
            approval={null}
            approvalSubmitting={false}
            nodeCount={null}
            installedSkillCount={null}
            onChooseSkill={() => {}}
            onOpenSkillRecommendations={() => {}}
            onDraftPrompt={() => {}}
            onApprovalReasonChange={() => {}}
            onApprove={() => {}}
            onReject={() => {}}
        />
    );
}
const episode = { id: "episode-one", number: 1 };
const segment = { id: "segment-one", index: 1, title: "森林", revision: 3 } as DramaSegment;
const container = document.createElement("div");
document.body.append(container);
let root = createRoot(container);
const render = () =>
    act(async () => {
        root.render(
            <App>
                <Harness />
            </App>,
        );
    });
const settle = () =>
    act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(label));
const click = async (label: string) => {
    const target = button(label);
    expect(target, `缺少操作：${label}`).toBeDefined();
    await act(async () => {
        target!.click();
        await Promise.resolve();
    });
    await settle();
};
const requestVideo = () => act(async () => controls.requestVideo(episode, segment));
const remount = async () => {
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
};

beforeEach(async () => {
    await act(async () => root.unmount());
    root = createRoot(container);
    useGlobalAgentStore.getState().reset();
    history = createAgentChoiceHistory();
    messages = [{ id: "initial-reply", role: "assistant", text: "请从段卡发起制作请求。" }];
    preflights.length = 0;
    executions.length = 0;
    preflightFailure = undefined;
    executeFailure = undefined;
    preflightDelay = undefined;
    token = "quote-1";
    await render();
});
afterAll(async () => {
    await act(async () => root.unmount());
    browser.happyDOM.abort();
});

test("首次预检失败也能重新检查，检查成功前不提供执行确认", async () => {
    preflightFailure = new Error("首次预检失败");
    await requestVideo();
    expect(container.textContent).toContain("首次预检失败");
    expect(button("确认生成本段视频")).toBeUndefined();
    expect(button("重新检查当前条件")?.disabled).toBe(false);
    preflightFailure = undefined;
    await click("重新检查当前条件");
    expect(preflights).toHaveLength(2);
    expect(button("确认生成本段视频")?.disabled).toBe(false);
    expect(executions).toHaveLength(0);
    await click("确认生成本段视频");
    expect(executions).toHaveLength(1);
});

test.each(["refresh", "confirm-preflight", "confirm-execute"] as const)("%s 失败后提供独立重试，重挂和再次失败均不恢复旧报价确认", async (action) => {
    await requestVideo();
    const proposal = controls.proposalChoices!.proposals[0]!;
    const originalKey = controls.proposalChoices!.interactionKey(proposal);
    const originalConfirm = button("确认生成本段视频")!;
    if (action === "confirm-execute") executeFailure = new Error("临时提交失败");
    else preflightFailure = new Error("临时预检失败");
    await click(action === "refresh" ? "重新检查当前条件" : "确认生成本段视频");
    const retryKey = controls.proposalChoices!.interactionKey(proposal);
    expect(retryKey).toBe(`${originalKey}:retry:1`);
    expect(button("确认生成本段视频")).toBeUndefined();
    expect(button("重新检查当前条件")?.disabled).toBe(false);
    expect(executions).toHaveLength(0);
    await act(async () => originalConfirm.click());
    expect(executions).toHaveLength(0);

    await remount();
    expect(button("确认生成本段视频")).toBeUndefined();
    expect(button("重新检查当前条件")?.disabled).toBe(false);
    preflightFailure = new Error("重试时预检仍失败");
    await click("重新检查当前条件");
    expect(controls.proposalChoices!.interactionKey(proposal)).toBe(`${originalKey}:retry:2`);
    expect(button("确认生成本段视频")).toBeUndefined();
    expect(button("重新检查当前条件")?.disabled).toBe(false);

    preflightFailure = undefined;
    executeFailure = undefined;
    token = "quote-2";
    await click("重新检查当前条件");
    expect(button("确认生成本段视频")?.disabled).toBe(false);
    expect(executions).toHaveLength(0);
    await click("确认生成本段视频");
    expect(executions).toEqual([expect.objectContaining({ targetId: segment.id, episodeId: episode.id, confirmationToken: "quote-2" })]);
    expect(controls.proposalChoices).toBeUndefined();
});

test("确认时新报价保留独立的再次确认，不自动执行", async () => {
    await requestVideo();
    token = "quote-2";
    await click("确认生成本段视频");
    expect(executions).toHaveLength(0);
    expect(container.textContent).toContain("条件或费用已变化");
    expect(button("确认生成本段视频")?.disabled).toBe(false);
    await click("确认生成本段视频");
    expect(executions).toEqual([expect.objectContaining({ confirmationToken: "quote-2" })]);
});

test.each(["failure", "success"] as const)("新用户消息淘汰旧建议后，迟到的 %s 不恢复重试或确认，新段卡请求仍可操作", async (outcome) => {
    await requestVideo();
    let finish!: () => void;
    preflightDelay = new Promise<void>((resolve) => {
        finish = resolve;
    });
    if (outcome === "failure") preflightFailure = new Error("迟到的预检失败");
    await click("重新检查当前条件");
    messages = [...messages, { id: "new-user-input", role: "user", text: "先讨论一下角色设定。" }];
    await render();
    await act(async () => finish());
    await settle();
    const calls = preflights.length;
    expect(button("重新检查当前条件")?.disabled).toBe(true);
    if (button("确认生成本段视频")) expect(button("确认生成本段视频")?.disabled).toBe(true);
    await click("重新检查当前条件");
    expect(preflights).toHaveLength(calls);
    await remount();
    expect(button("重新检查当前条件")?.disabled).toBe(true);
    expect(executions).toHaveLength(0);

    preflightDelay = undefined;
    preflightFailure = undefined;
    await requestVideo();
    const confirmations = [...container.querySelectorAll<HTMLButtonElement>("button")].filter((item) => item.textContent?.includes("确认生成本段视频"));
    expect(confirmations.some((item) => !item.disabled)).toBe(true);
    expect(executions).toHaveLength(0);
});
