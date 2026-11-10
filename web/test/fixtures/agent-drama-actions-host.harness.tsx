import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { CloudAgentChatMessage } from "@/components/canvas/canvas-cloud-agent-chat-ui";
import type { AgentEvent, DramaAgentProposal } from "@/services/api/agent";

const browser = new Window({ url: "http://localhost/projects/project/guide" });
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

const { act, Profiler, StrictMode, useCallback, useState } = await import("react");
const { createPortal } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { AgentConversation } = await import("@/components/canvas/canvas-cloud-agent-panel-parts");
const { GuideSetupChoices, GuideStageChoices } = await import("@/pages/projects/guide-setup-choices");
const { canvasThemes } = await import("@/lib/canvas-theme");
const { applyAgentEvent } = await import("@/lib/canvas/cloud-agent-events");
const { dramaProposalFromToolDetail } = await import("@/services/api/agent");
const silent = () => {};
const conversationDefaults = {
    theme: canvasThemes.light,
    references: [],
    busy: false,
    approval: null,
    approvalSubmitting: false,
    nodeCount: null,
    installedSkillCount: null,
    onChooseSkill: silent,
    onOpenSkillRecommendations: silent,
    onDraftPrompt: silent,
    onApprovalReasonChange: silent,
    onApprove: silent,
    onReject: silent,
};

afterAll(() => browser.happyDOM.abort());

test("操作位于消息滚动区，稳定重渲染不反复设置 host，切换会话和项目后使用新 host", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const hosts: Array<HTMLDivElement | null> = [];
    const root = createRoot(container);
    let commits = 0;
    let applied = 0;
    function Harness({ scope, guideMode }: { scope: string; guideMode: boolean }) {
        const [host, setHost] = useState<HTMLDivElement | null>(null);
        const onActionsHost = useCallback((element: HTMLDivElement | null) => {
            hosts.push(element);
            setHost(element);
        }, []);
        return (
            <>
                <AgentConversation
                    key={scope}
                    guideMode={guideMode}
                    onActionsHost={onActionsHost}
                    theme={canvasThemes.light}
                    messages={[{ id: "assistant", role: "assistant", text: "请确认创作配置" }]}
                    references={[]}
                    busy={false}
                    approval={null}
                    approvalSubmitting={false}
                    nodeCount={null}
                    installedSkillCount={null}
                    onChooseSkill={silent}
                    onOpenSkillRecommendations={silent}
                    onDraftPrompt={silent}
                    onApprovalReasonChange={silent}
                    onApprove={silent}
                    onReject={silent}
                />
                {host
                    ? createPortal(
                          <button type="button" onClick={() => applied++}>
                              应用建议并继续
                          </button>,
                          host,
                      )
                    : null}
            </>
        );
    }
    const render = async (scope: string, guideMode = true) => {
        commits = 0;
        await act(async () => {
            root.render(
                <StrictMode>
                    <Profiler
                        id="chat-actions"
                        onRender={() => {
                            if (++commits > 12) throw new Error("聊天操作挂载点持续重复更新");
                        }}
                    >
                        <Harness scope={scope} guideMode={guideMode} />
                    </Profiler>
                </StrictMode>,
            );
        });
    };
    try {
        await render("drama:project-a:conversation-a");
        const first = container.querySelector<HTMLDivElement>("[data-drama-agent-actions]")!;
        expect(first).toBeTruthy();
        expect(first.parentElement?.classList.contains("agent-conversation-messages")).toBe(true);
        expect(container.querySelector("[data-agent-conversation]")?.contains(first)).toBe(true);
        expect(first.textContent).toContain("应用建议并继续");
        await act(async () => first.querySelector("button")!.click());
        expect(applied).toBe(1);
        const notifications = hosts.length;
        await render("drama:project-a:conversation-a");
        expect(hosts).toHaveLength(notifications);
        expect(container.querySelector("[data-drama-agent-actions]")).toBe(first);
        for (const scope of ["drama:project-a:conversation-b", "drama:project-b:conversation-b"]) {
            const previous = container.querySelector<HTMLDivElement>("[data-drama-agent-actions]")!;
            const start = hosts.length;
            await render(scope);
            const current = container.querySelector<HTMLDivElement>("[data-drama-agent-actions]")!;
            expect(current).not.toBe(previous);
            expect(previous.isConnected).toBe(false);
            expect(hosts.slice(start)).toContain(null);
            expect(current.textContent).toContain("应用建议并继续");
            expect(container.querySelectorAll("[data-drama-agent-actions]")).toHaveLength(1);
        }
        await render("canvas:conversation-b", false);
        expect(container.querySelector("[data-drama-agent-actions]")).toBeNull();
        expect(hosts.at(-1)).toBeNull();
        expect(container.textContent).not.toContain("应用建议并继续");
        await render("drama:project-b:conversation-c");
        expect(hosts.at(-1)).not.toBeNull();
    } finally {
        await act(async () => root.unmount());
        expect(hosts.at(-1)).toBeNull();
        container.remove();
    }
});

test("真实聊天把同轮风格候选和说明合为一组消息内选项，直接选择及自定义保留原建议身份", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const proposals: DramaAgentProposal[] = [
        ["写实电影", "强调现实生活质感。"],
        ["港风复古", "适合霓虹都市氛围。"],
        ["国风动画", "突出传统线条与色彩。"],
        ["黏土定格", "保留手工材质。"],
    ].map(([styleName, explanation], index) => ({ kind: "setup", runId: "style-run", toolCallId: `style-${index}`, baseRevision: 7, changes: { styleName, stylePrompt: `${styleName}视觉设定` }, explanation }));
    const rawText = "请选择视觉风格：\n\n1. **写实电影（推荐）**：强调现实生活质感。\n2. **港风复古**：适合霓虹都市氛围。\n3. **国风动画**：突出传统线条与色彩。\n4. **黏土定格**：保留手工材质。\n\n请直接在回复中选择风格，也可以填写自己的选择。";
    const messages = [
        { id: "previous", runId: "source-run", role: "assistant" as const, text: "上一轮已确认故事正文。" },
        { id: "style", runId: "style-run", role: "assistant" as const, text: rawText },
        { id: "error", runId: "style-run", role: "error" as const, text: "服务连接失败，请重试。" },
    ];
    const chosen: DramaAgentProposal[] = [];
    const custom: Array<{ text: string; proposal: DramaAgentProposal }> = [];
    const genericReplies: string[] = [];
    const setupChoices = {
        proposals,
        render: (items: DramaAgentProposal[]) => <GuideSetupChoices proposals={items} busy={false} isValid={() => true} issue={() => ""} onChoose={(proposal) => chosen.push(proposal)} onCustom={(text, proposal) => custom.push({ text, proposal })} />,
    };
    const render = async (busy = false) => {
        await act(async () => root.render(<AgentConversation {...conversationDefaults} messages={messages} guideMode setupChoices={setupChoices} busy={busy} onReplyOption={(text) => genericReplies.push(text)} />));
    };
    try {
        await render(true);
        expect(container.querySelector(".drama-guide-setup-choices")).toBeNull();
        expect(container.textContent).toContain("写实电影（推荐）");
        await render();
        const group = container.querySelector<HTMLElement>(".drama-guide-setup-choices")!;
        expect(group).toBeTruthy();
        expect(container.querySelectorAll(".drama-guide-setup-choices")).toHaveLength(1);
        const bubble = group.closest(".agent-message-body")!;
        expect(bubble).toBeTruthy();
        expect(bubble.querySelector("ol")).toBeNull();
        expect(bubble.querySelectorAll(".drama-guide-setup-choice")).toHaveLength(4);
        expect(container.querySelector("[data-drama-agent-actions] .drama-guide-setup-choices")).toBeNull();
        for (const proposal of proposals) {
            expect(bubble.textContent!.split(String(proposal.changes.styleName))).toHaveLength(2);
            expect(bubble.textContent!.split(proposal.explanation!)).toHaveLength(2);
        }
        expect(container.textContent).toContain("请直接在回复中选择风格");
        expect(container.textContent).toContain("上一轮已确认故事正文。");
        expect(container.textContent).toContain("服务连接失败，请重试。");
        expect(messages[1].text).toBe(rawText);
        await act(async () => group.querySelectorAll<HTMLButtonElement>(".drama-guide-setup-choice")[1].click());
        expect(chosen).toHaveLength(1);
        expect(chosen[0]).toBe(proposals[1]);
        expect(genericReplies).toEqual([]);

        const input = group.querySelector<HTMLInputElement>('input[aria-label="自定义视觉风格"]')!;
        expect(input.value).toBe("");
        await act(async () => {
            Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, "  低饱和水彩  ");
            input.dispatchEvent(new browser.Event("input", { bubbles: true }));
        });
        await act(async () => input.closest("form")!.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })));
        expect(custom).toHaveLength(1);
        expect(custom[0].text).toBe("低饱和水彩");
        expect(custom[0].proposal).toBe(proposals[0]);
        expect(chosen).toHaveLength(1);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test.each(["failed", "cancelled"] as const)("最后说明流式输出后进入 %s，已生成的风格选项仍可直接点选", async (status) => {
    const runId = `style-${status}`;
    let messages: CloudAgentChatMessage[] = [];
    let seq = 0;
    const reduce = (type: AgentEvent["type"], payload: AgentEvent["payload"]) => {
        applyAgentEvent(
            { eventId: `${runId}-${++seq}`, runId, seq, type, payload, createdAt: "2026-11-08T00:00:00Z" },
            (update) => {
                messages = typeof update === "function" ? update(messages) : update;
            },
            silent,
            silent,
        );
    };
    for (const [index, styleName] of ["写实电影", "国风动画"].entries()) {
        reduce("tool_completed", { toolName: "drama_propose_changes", callId: `style-${index}`, result: { kind: "setup", baseRevision: 7, changes: { styleName, stylePrompt: `${styleName}视觉设定` }, explanation: `${styleName}方案` } });
    }
    reduce("assistant_delta", { messageId: "final-answer", text: "请选择视觉风格。" });
    const proposals = messages.map((item) => dramaProposalFromToolDetail(item.detail)).filter((proposal): proposal is DramaAgentProposal => Boolean(proposal));
    expect(proposals).toHaveLength(2);
    expect(messages.find((item) => item.id === "final-answer")?.streaming).toBe(true);

    const terminalText = status === "failed" ? "模型输出超时" : "已停止本轮";
    reduce(status === "failed" ? "run_failed" : "run_cancelled", { text: terminalText });
    reduce("run_status", { status, ...(status === "failed" ? { failureMessage: terminalText } : {}) });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const applied: DramaAgentProposal[] = [];
    try {
        await act(async () =>
            root.render(
                <AgentConversation
                    {...conversationDefaults}
                    messages={messages}
                    guideMode
                    setupChoices={{
                        proposals,
                        render: (items) => <GuideSetupChoices proposals={items} busy={false} isValid={() => true} issue={() => ""} onChoose={(proposal) => applied.push(proposal)} onCustom={silent} />,
                    }}
                />,
            ),
        );
        const choices = container.querySelectorAll<HTMLButtonElement>(".drama-guide-setup-choice");
        expect(choices).toHaveLength(2);
        expect(choices[1].closest(".agent-message-body")?.textContent).toContain("请选择视觉风格。");
        expect(choices[1].disabled).toBe(false);
        expect(container.textContent).toContain(terminalText);
        await act(async () => choices[1].click());
        expect(applied).toHaveLength(1);
        expect(applied[0]).toBe(proposals[1]);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test("整组推荐配置的模型正文仅保留一组采用与修改操作", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const proposal: DramaAgentProposal = { kind: "setup", runId: "config-run", toolCallId: "configuration", baseRevision: 7, changes: { aspectRatio: "9:16", videoResolution: "720p", language: "中文普通话", episodeSeconds: 60 } };
    const chosen: DramaAgentProposal[] = [];
    const genericReplies: string[] = [];
    try {
        await act(async () =>
            root.render(
                <AgentConversation
                    {...conversationDefaults}
                    messages={[{ id: "configuration", runId: "config-run", role: "assistant", text: "风格已保存，以下是整组创作配置。\n\n1. 采用推荐配置\n2. 在推荐配置基础上修改\n\n保存配置后再确认是否提取资产。" }]}
                    guideMode
                    onReplyOption={(text) => genericReplies.push(text)}
                    setupChoices={{
                        proposals: [proposal],
                        render: (proposals) => <GuideSetupChoices proposals={proposals} busy={false} isValid={() => true} issue={() => ""} onChoose={(item) => chosen.push(item)} onCustom={silent} />,
                    }}
                />,
            ),
        );
        const group = container.querySelector<HTMLElement>('.drama-guide-setup-choices[aria-label="创作配置选项"]')!;
        const bubble = group.closest(".agent-message-body")!;
        const buttons = group.querySelectorAll<HTMLButtonElement>("button");
        expect(buttons).toHaveLength(2);
        expect(buttons[0].querySelector("strong")?.textContent).toBe("采用推荐配置");
        expect(buttons[1].querySelector("strong")?.textContent).toBe("在推荐配置基础上修改");
        expect(bubble.querySelector("ol")).toBeNull();
        expect(bubble.querySelector(".agent-reply-options")).toBeNull();
        expect(bubble.textContent!.split("采用推荐配置")).toHaveLength(2);
        expect(bubble.textContent!.split("在推荐配置基础上修改")).toHaveLength(2);
        expect(bubble.textContent).toContain("风格已保存");
        expect(bubble.textContent).toContain("保存配置后再确认是否提取资产");
        for (const value of ["9:16", "720p", "中文普通话", "60 秒"]) expect(bubble.textContent).toContain(value);
        await act(async () => buttons[0].click());
        expect(chosen).toEqual([proposal]);
        expect(genericReplies).toEqual([]);
        expect(group.querySelector("input")).toBeNull();
        await act(async () => buttons[1].click());
        expect(group.querySelector('input[aria-label="自定义创作配置"]')).toBeTruthy();
        expect(chosen).toHaveLength(1);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test("模型回复的确认与调整选项原位可点击，保留前后正文且不叠加阶段卡片", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const before = "四项配置现已齐全，是否按当前配置推进？";
    const after = "图片可在制作台按需生成。";
    const confirm = "确认，进入下一阶段";
    const adjust = "继续调整（可说明想改哪一项）";
    const messages: CloudAgentChatMessage[] = [{ id: "assistant", role: "assistant", text: `${before}\n\n1. ${confirm}\n2. ${adjust}\n\n${after}` }];
    const selected: string[] = [];
    const genericReplies: string[] = [];
    try {
        await act(async () =>
            root.render(
                <AgentConversation
                    {...conversationDefaults}
                    messages={messages}
                    guideMode
                    onReplyOption={(text) => genericReplies.push(text)}
                    stageChoices={{
                        pending: false,
                        render: (labels) => (
                            <GuideStageChoices
                                title="下一步：开始改编"
                                busy={false}
                                choices={[
                                    { key: "confirm", title: labels?.confirm || "确认资产，开始改编剧本与分镜", detail: "使用已保存资产。" },
                                    { key: "adjust", title: labels?.adjust || "继续调整", detail: "修改当前资产。" },
                                ]}
                                onChoose={(choice) => selected.push(choice.key)}
                            />
                        ),
                    }}
                />,
            ),
        );
        const groups = container.querySelectorAll<HTMLElement>('.drama-guide-setup-choices[aria-label="下一步：开始改编"]');
        expect(groups).toHaveLength(1);
        const group = groups[0];
        const bubble = group.closest(".agent-message-body")!;
        const buttons = group.querySelectorAll<HTMLButtonElement>("button");
        expect(buttons).toHaveLength(2);
        expect(buttons[0].querySelector("strong")?.textContent).toBe(confirm);
        expect(buttons[1].querySelector("strong")?.textContent).toBe(adjust);
        expect(bubble.querySelector("ol")).toBeNull();
        expect(bubble.querySelector("h3")).toBeNull();
        expect(bubble.querySelector(".drama-guide-setup-choice-heading")).toBeNull();
        expect(bubble.querySelector(".agent-reply-options")).toBeNull();
        expect(bubble.textContent!.split(confirm)).toHaveLength(2);
        expect(bubble.textContent!.split(adjust)).toHaveLength(2);
        expect(bubble.textContent!.indexOf(before)).toBeLessThan(bubble.textContent!.indexOf(confirm));
        expect(bubble.textContent!.indexOf(adjust)).toBeLessThan(bubble.textContent!.indexOf(after));
        expect(bubble.textContent).not.toContain("下一步：开始改编");
        expect(bubble.textContent).not.toContain("选择后继续当前创作流程");
        await act(async () => buttons[0].click());
        await act(async () => buttons[1].click());
        expect(selected).toEqual(["confirm", "adjust"]);
        expect(genericReplies).toEqual([]);
        expect(messages[0].text).toContain(`1. ${confirm}`);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test.each(["setup", "proposal"] as const)("有待选的 %s 建议时不叠加阶段确认选项", async (kind) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const proposal: DramaAgentProposal =
        kind === "setup"
            ? { kind: "setup", runId: "run", toolCallId: "style", baseRevision: 7, changes: { styleName: "写实电影", stylePrompt: "真实光影" } }
            : { kind: "cast", runId: "run", toolCallId: "cast", baseRevision: 7, targetId: "cast-1", changes: { description: "保留原始角色小传" } };
    let renderedStage = 0;
    const selected: DramaAgentProposal[] = [];
    const candidateChoices = {
        proposals: [proposal],
        render: (proposals: DramaAgentProposal[]) => (
            <button type="button" data-pending-drama-proposal onClick={() => selected.push(proposals[0])}>
                保存当前建议
            </button>
        ),
    };
    try {
        await act(async () =>
            root.render(
                <AgentConversation
                    {...conversationDefaults}
                    messages={[{ id: "assistant", runId: "run", role: "assistant", text: "请先选择当前建议。" }]}
                    guideMode
                    {...(kind === "setup" ? { setupChoices: candidateChoices } : { proposalChoices: candidateChoices })}
                    stageChoices={{
                        pending: true,
                        render: () => {
                            renderedStage++;
                            return <GuideStageChoices title="下一阶段" busy={false} choices={[{ key: "confirm", title: "确认资产，开始改编剧本与分镜", detail: "" }]} onChoose={silent} />;
                        },
                    }}
                />,
            ),
        );
        expect(renderedStage).toBe(0);
        expect(container.textContent).not.toContain("确认资产，开始改编剧本与分镜");
        const button = container.querySelector<HTMLButtonElement>("[data-pending-drama-proposal]")!;
        expect(button.closest(".agent-message-body")).toBeTruthy();
        await act(async () => button.click());
        expect(selected).toEqual([proposal]);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test.each([false, true])("过期配置候选与最新回复同轮=%s 时不阻挡阶段确认", async (sameRun) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const proposal: DramaAgentProposal = { kind: "setup", runId: "old-run", toolCallId: "old-style", baseRevision: 3, changes: { styleName: "国风动画", stylePrompt: "旧版风格设定" } };
    const selected: string[] = [];
    const latest: CloudAgentChatMessage = { id: "assistant", runId: sameRun ? "old-run" : "latest-run", role: "assistant", text: "当前配置已经保存。\n\n1. 确认配置，开始提取资产\n2. 继续调整" };
    const messages: CloudAgentChatMessage[] = sameRun ? [latest] : [{ id: "old-assistant", runId: "old-run", role: "assistant", text: "先前的风格推荐。" }, latest];
    try {
        await act(async () =>
            root.render(
                <AgentConversation
                    {...conversationDefaults}
                    messages={messages}
                    guideMode
                    setupChoices={{
                        proposals: [proposal],
                        render: (proposals) => <GuideSetupChoices proposals={proposals} busy={false} isValid={() => false} issue={() => ""} onChoose={() => selected.push("stale")} onCustom={silent} />,
                    }}
                    stageChoices={{
                        pending: false,
                        render: (labels) => (
                            <GuideStageChoices
                                title="阶段确认"
                                busy={false}
                                choices={[
                                    { key: "confirm", title: labels?.confirm || "确认配置，开始提取资产", detail: "" },
                                    { key: "adjust", title: labels?.adjust || "继续调整", detail: "" },
                                ]}
                                onChoose={(choice) => selected.push(choice.key)}
                            />
                        ),
                    }}
                />,
            ),
        );
        const stale = container.querySelector<HTMLButtonElement>('[aria-label="视觉风格选项"] button');
        if (sameRun) expect(stale).toBeNull();
        else {
            expect(stale?.disabled).toBe(true);
            expect(stale?.closest(".agent-message-body")?.textContent).toContain("此选项已过期");
        }
        const stage = container.querySelector<HTMLElement>('.drama-guide-setup-choices[aria-label="阶段确认"]')!;
        expect(stage).toBeTruthy();
        expect(stage.closest(".agent-message-body")?.textContent).toContain("当前配置已经保存");
        const confirm = stage.querySelector<HTMLButtonElement>("button")!;
        expect(confirm.disabled).toBe(false);
        await act(async () => confirm.click());
        expect(selected).toEqual(["confirm"]);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test("普通画布仍保留模型原文列表和错误，不消费短剧配置选项", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const proposals: DramaAgentProposal[] = [{ kind: "setup", runId: "run", toolCallId: "call", baseRevision: 7, changes: { language: "中文普通话" }, explanation: "推荐说明" }];
    let renderedChoices = 0;
    try {
        await act(async () =>
            root.render(
                <AgentConversation
                    {...conversationDefaults}
                    messages={[
                        { id: "assistant", runId: "run", role: "assistant", text: "1. 中文普通话\n2. 粤语\n\n请在下方卡片选择。" },
                        { id: "error", runId: "run", role: "error", text: "原始失败信息需要保留" },
                    ]}
                    guideMode={false}
                    setupChoices={{
                        proposals,
                        render: () => {
                            renderedChoices++;
                            return <span>不应出现的短剧选项</span>;
                        },
                    }}
                />,
            ),
        );
        expect(renderedChoices).toBe(0);
        expect(container.querySelectorAll("ol li")).toHaveLength(2);
        expect(container.textContent).toContain("下方卡片");
        expect(container.textContent).toContain("原始失败信息需要保留");
        expect(container.textContent).not.toContain("不应出现的短剧选项");
        expect(container.querySelector(".drama-guide-setup-choices")).toBeNull();
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});
