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
const { AgentReplyOptionCards, useAgentReplyOptionDrafts } = await import("@/components/canvas/canvas-agent-reply-options");
const { createAgentChoiceHistory } = await import("@/lib/canvas/agent-reply-options");
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

test("作品卡片请求把回复内确认带入视野，阅读旧消息后也可看到新确认", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const messages: CloudAgentChatMessage[] = [{ id: "old-reply", role: "assistant", text: "原会话内容" }];
    const render = (focusLatestRequest?: number) => <AgentConversation {...conversationDefaults} guideMode messages={messages} focusLatestRequest={focusLatestRequest} />;
    try {
        await act(async () => root.render(render()));
        const scroll = host.querySelector<HTMLElement>("[data-agent-conversation]")!;
        Object.defineProperty(scroll, "scrollHeight", { configurable: true, value: 1000 });
        Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 100 });
        scroll.scrollTop = 0;
        await act(async () => scroll.dispatchEvent(new browser.Event("scroll", { bubbles: true }) as unknown as Event));
        await act(async () => root.render(render(1)));
        expect(scroll.scrollTop).toBe(1000);
        expect(host.querySelector(".agent-back-to-bottom")).toBeNull();
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

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

test("真实聊天合并同轮风格候选，选择后整组及自定义输入不再提交", async () => {
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
        expect(input.disabled).toBe(true);
        await act(async () => {
            Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, "  低饱和水彩  ");
            input.dispatchEvent(new browser.Event("input", { bubbles: true }));
        });
        await act(async () => input.closest("form")!.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })));
        expect(custom).toHaveLength(0);
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
        expect(group.querySelector("input")).toBeNull();
        await act(async () => buttons[1].click());
        const input = group.querySelector<HTMLInputElement>('input[aria-label="自定义创作配置"]')!;
        expect(input).toBeTruthy();
        expect(input.disabled).toBe(false);
        await act(async () => buttons[0].click());
        expect(chosen).toEqual([proposal]);
        expect(genericReplies).toEqual([]);
        await act(async () => buttons[1].click());
        expect(input.disabled).toBe(true);
        expect(chosen).toHaveLength(1);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test("制作台保留历史及新回复的引导阶段列表正文，不转换为普通回复按钮", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const text = "四项配置齐全，请选择下一步：\n\n1. 确认资产，开始改编剧本与分镜\n2. 继续调整";
    const previous: CloudAgentChatMessage = { id: "old-guide", runId: "old-run", role: "assistant", text };
    const genericReplies: string[] = [];
    try {
        for (const messages of [[previous], [previous, { id: "user", role: "user" as const, text: "现在哪一步？" }, { id: "latest", runId: "studio-run", role: "assistant" as const, text }]]) {
            await act(async () => root.render(<AgentConversation {...conversationDefaults} messages={messages} guideMode onReplyOption={(reply) => genericReplies.push(reply)} />));
            expect(container.textContent).toContain("四项配置齐全");
            expect(container.textContent).toContain("确认资产，开始改编剧本与分镜");
            expect(container.textContent).toContain("继续调整");
            expect(container.querySelectorAll("ol li")).toHaveLength(messages.length === 1 ? 2 : 4);
            expect(container.querySelector(".agent-reply-options")).toBeNull();
            expect(container.querySelector(".drama-guide-setup-choices")).toBeNull();
            expect(genericReplies).toEqual([]);
        }
        expect(previous.text).toBe(text);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test.each([false, true])("短剧上下文=%s 时普通创意编号选项仍可直接回复", async (guideMode) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const selected: string[] = [];
    try {
        await act(async () =>
            root.render(
                <AgentConversation {...conversationDefaults} messages={[{ id: "creative-options", role: "assistant", text: "请选择创意方向：\n\n1. 加强兄弟冲突\n2. 补充森林环境" }]} guideMode={guideMode} onReplyOption={(text) => selected.push(text)} />,
            ),
        );
        const buttons = container.querySelectorAll<HTMLButtonElement>(".agent-reply-option");
        expect(buttons).toHaveLength(guideMode ? 3 : 2);
        expect(container.querySelectorAll(".agent-reply-option-input")).toHaveLength(guideMode ? 1 : 0);
        expect(container.querySelector(".drama-guide-setup-choices")).toBeNull();
        await act(async () => buttons[1].click());
        expect(selected).toEqual(["补充森林环境"]);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test("制作台的确认对白与修改镜头是普通选择，仍能直接点击回复", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const selected: string[] = [];
    const labels = ["确认这版对白", "修改第 3 镜头的台词"];
    try {
        await act(async () =>
            root.render(<AgentConversation {...conversationDefaults} messages={[{ id: "dialogue-options", role: "assistant", text: `请选择对白处理方式：\n\n1. ${labels[0]}\n2. ${labels[1]}` }]} guideMode onReplyOption={(text) => selected.push(text)} />),
        );
        const buttons = container.querySelectorAll<HTMLButtonElement>(".agent-reply-option");
        expect(buttons).toHaveLength(3);
        expect(container.querySelectorAll(".agent-reply-option-input")).toHaveLength(1);
        expect(container.querySelector(".drama-guide-setup-choices")).toBeNull();
        await act(async () => buttons[0].click());
        await act(async () => buttons[1].click());
        expect(selected).toEqual([labels[0]]);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test("新轮对话禁用旧媒体提案，最新创作选项选定后自定义输入也不可再次提交", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const labels = ["先补齐缺少的参考图", "调整第 1 段对白", "检查剩余剧情段", "继续生成下一段"];
    const media: DramaAgentProposal = { kind: "media", runId: "old-media-run", toolCallId: "media-call", baseRevision: 8, targetId: "segment-one", changes: { action: "segment_video", episodeId: "episode-one", targetRevision: 3 } };
    const saved: DramaAgentProposal[] = [];
    const selected: string[] = [];
    try {
        await act(async () =>
            root.render(
                <AgentConversation
                    {...conversationDefaults}
                    guideMode
                    messages={[
                        { id: "old-media-reply", runId: "old-media-run", role: "assistant", text: "已检查第 1 段，等待确认当前操作。" },
                        { id: "user", role: "user", text: "接下来应该做什么？" },
                        { id: "latest", runId: "new-run", role: "assistant", text: `请选择下一步：\n\n${labels.map((label, index) => `${index + 1}. ${label}`).join("\n")}` },
                    ]}
                    proposalChoices={{
                        proposals: [media],
                        render: (proposals) => (
                            <div data-old-media-confirm>
                                <AgentReplyOptionCards options={[{ marker: "1", title: "确认生成本段视频", text: "confirm" }]} onSelect={() => saved.push(proposals[0])} />
                            </div>
                        ),
                    }}
                    onReplyOption={(text) => selected.push(text)}
                />,
            ),
        );
        const old = container.querySelector<HTMLButtonElement>("[data-old-media-confirm] button");
        if (old) {
            expect(old.disabled).toBe(true);
            expect(old.closest(".agent-message-body")?.textContent).toContain("已检查第 1 段");
        }
        const replies = [...container.querySelectorAll<HTMLElement>(".agent-reply-options")].find((group) => group.textContent?.includes(labels[0]))!;
        expect(replies).toBeTruthy();
        expect(replies.closest(".agent-message-body")?.querySelector("ol")).toBeNull();
        if (old) expect(replies.contains(old)).toBe(false);
        const options = replies.querySelectorAll<HTMLButtonElement>("button.agent-reply-option");
        expect(options).toHaveLength(4);
        expect([...options].map((option) => option.querySelector(".agent-reply-option-title")?.textContent)).toEqual(labels);
        expect(replies.querySelectorAll(".agent-reply-option-input")).toHaveLength(1);
        expect(replies.querySelectorAll("input")).toHaveLength(1);
        await act(async () => options[2].click());
        expect(selected).toEqual([labels[2]]);
        expect(saved).toEqual([]);
        const input = replies.querySelector<HTMLInputElement>("input")!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, "  先核对角色原文说明  ");
            input.dispatchEvent(new browser.Event("input", { bubbles: true }));
        });
        await act(async () => input.dispatchEvent(new browser.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })));
        expect(input.disabled).toBe(true);
        expect(selected).toEqual([labels[2]]);
        await act(async () => old?.click());
        expect(saved).toHaveLength(0);
        expect(selected).toHaveLength(1);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test.each([
    ["只生成第 1 段视频", "先补齐缺失参考图", "重新撰写当前段提示词", "检查所有剧情段"],
    ["确认不生成视频，先调整对白", "先检查第 2 段提示词"],
])("制作台同轮选择方向时不猜测媒体确认，原引导场景保留结构化建议：%s", async (...labels) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const media: DramaAgentProposal = { kind: "media", runId: "same-run", toolCallId: "media-call", baseRevision: 8, targetId: "segment-one", changes: { action: "segment_video", episodeId: "episode-one", targetRevision: 3 } };
    const selected: string[] = [];
    const saved: DramaAgentProposal[] = [];
    let renderedMedia = 0;
    const render = (dramaStudio: boolean) => (
        <AgentConversation
            {...conversationDefaults}
            guideMode
            dramaStudio={dramaStudio}
            messages={[{ id: "same-run-reply", runId: "same-run", role: "assistant", text: `请选择接下来的方向：\n\n${labels.map((label, index) => `${index + 1}. ${label}`).join("\n")}` }]}
            proposalChoices={{
                proposals: [media],
                render: (proposals) => {
                    renderedMedia++;
                    return (
                        <div data-same-run-media-confirm>
                            <AgentReplyOptionCards options={[{ marker: "1", title: "确认生成本段视频", text: "confirm" }]} onSelect={() => saved.push(proposals[0])} />
                        </div>
                    );
                },
            }}
            onReplyOption={(text) => selected.push(text)}
        />
    );
    try {
        await act(async () => root.render(render(true)));
        expect(renderedMedia).toBe(0);
        expect(container.querySelector("[data-same-run-media-confirm]")).toBeNull();
        expect(container.textContent).not.toContain("确认生成本段视频");
        expect(container.querySelector("ol")).toBeNull();
        const options = container.querySelectorAll<HTMLButtonElement>("button.agent-reply-option");
        expect(options).toHaveLength(labels.length);
        expect([...options].map((option) => option.querySelector(".agent-reply-option-title")?.textContent)).toEqual(labels);
        expect(container.querySelectorAll(".agent-reply-option-input")).toHaveLength(1);
        await act(async () => options[0].click());
        expect(selected).toEqual([labels[0]]);
        expect(saved).toEqual([]);
        await act(async () => root.render(render(false)));
        const confirmation = container.querySelector<HTMLButtonElement>("[data-same-run-media-confirm] button");
        if (confirmation) expect(confirmation.disabled).toBe(true);
        await act(async () => confirmation?.click());
        expect(saved).toHaveLength(0);
        expect(selected).toHaveLength(1);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test.each(["确认生成本段视频", "是，按当前报价生成本段视频", "使用当前费用执行本段生成"])("制作台按明确选项关联保留真实预检与回调，不依赖确认措辞：%s", async (confirmationOption) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const media: DramaAgentProposal = { kind: "media", runId: "confirm-run", toolCallId: "media-call", baseRevision: 8, targetId: "segment-one", confirmationOption, changes: { action: "segment_video", episodeId: "episode-one", targetRevision: 3 } };
    const unrelated: DramaAgentProposal = { ...media, toolCallId: "unrelated-media-call", targetId: "segment-two", confirmationOption: "确认另一段视频" };
    const saved: DramaAgentProposal[] = [];
    const selected: string[] = [];
    let presented: DramaAgentProposal[] = [];
    try {
        await act(async () =>
            root.render(
                <AgentConversation
                    {...conversationDefaults}
                    guideMode
                    dramaStudio
                    messages={[{ id: "confirmation", runId: "confirm-run", role: "assistant", text: `当前对象和费用已检查，请选择：\n\n1. ${confirmationOption}\n2. 暂不生成，继续修改` }]}
                    proposalChoices={{
                        proposals: [unrelated, media],
                        render: (proposals) => {
                            presented = proposals;
                            return (
                                <>
                                    <p>仅生成本段视频 · 预计 19.5 积分</p>
                                    <button type="button" data-execute-media-confirm onClick={() => saved.push(proposals[0])}>
                                        确认生成本段视频
                                    </button>
                                </>
                            );
                        },
                    }}
                    onReplyOption={(text) => selected.push(text)}
                />,
            ),
        );
        const confirmation = container.querySelector<HTMLButtonElement>("[data-execute-media-confirm]")!;
        expect(confirmation).toBeTruthy();
        expect(presented).toEqual([media]);
        expect(container.textContent).toContain("预计 19.5 积分");
        expect(container.querySelector("ol")).toBeNull();
        expect(container.querySelector(".agent-reply-options")).toBeNull();
        expect(container.querySelector(".agent-reply-option-input")).toBeNull();
        await act(async () => confirmation.click());
        expect(saved).toHaveLength(1);
        expect(saved[0]).toBe(media);
        expect(selected).toEqual([]);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test.each([
    { option: "其他，自己填写", title: "其他，自己填写" },
    { option: "继续调整：填写想修改的内容", title: "继续调整" },
    { option: "继续调整：请直接描述你的要求", title: "继续调整" },
])("短剧模型已给自定义填写选项时只展示一个输入项：$option", async ({ option, title }) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const selected: string[] = [];
    try {
        await act(async () =>
            root.render(
                <AgentConversation {...conversationDefaults} guideMode messages={[{ id: "creative-options", role: "assistant", text: `请选择下一步：\n\n1. 检查人物小传\n2. 补充场景设定\n3. ${option}` }]} onReplyOption={(text) => selected.push(text)} />,
            ),
        );
        expect(container.querySelectorAll("button.agent-reply-option")).toHaveLength(2);
        expect(container.querySelectorAll(".agent-reply-option-input")).toHaveLength(1);
        expect(container.querySelectorAll(".agent-reply-option")).toHaveLength(3);
        expect(container.querySelector("ol")).toBeNull();
        const input = container.querySelector<HTMLInputElement>(".agent-reply-option-input input")!;
        expect(input.getAttribute("aria-label")).toBe(title);
        await act(async () => {
            Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, "保留当前对白，先改镜头顺序");
            input.dispatchEvent(new browser.Event("input", { bubbles: true }));
        });
        await act(async () => input.dispatchEvent(new browser.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })));
        expect(selected).toEqual(["保留当前对白，先改镜头顺序"]);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test("真实对话忙碌时临时卸载阶段输入，恢复后保留父层草稿且作品与阶段隔离", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const chosen: string[] = [];
    function Harness({ busy, scope }: { busy: boolean; scope: string }) {
        const drafts = useAgentReplyOptionDrafts(scope);
        return (
            <AgentConversation
                {...conversationDefaults}
                busy={busy}
                guideMode
                messages={[{ id: "current-stage", role: "assistant", text: "请选择下一步：\n\n1. 确认资产，开始改编剧本与分镜\n2. 继续调整" }]}
                stageChoices={{
                    key: scope,
                    pending: false,
                    render: () => <GuideStageChoices title="下一步：开始改编" drafts={drafts} choices={[{ key: "adjust", title: "继续调整", detail: "", input: true }]} busy={false} onChoose={(_choice, text) => text && chosen.push(text)} />,
                }}
            />
        );
    }
    const render = (busy: boolean, scope = "project:assets") => act(async () => root.render(<Harness busy={busy} scope={scope} />));
    try {
        await render(false);
        const input = container.querySelector<HTMLInputElement>("input")!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, "保留秦子文原文定义");
            input.dispatchEvent(new browser.Event("input", { bubbles: true }));
        });
        await render(true);
        expect(container.querySelector("input")).toBeNull();
        await render(false);
        const restored = container.querySelector<HTMLInputElement>("input")!;
        expect(restored.value).toBe("保留秦子文原文定义");
        await act(async () => restored.dispatchEvent(new browser.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })));
        expect(chosen).toEqual(["保留秦子文原文定义"]);
        await render(true);
        await render(false);
        const consumed = container.querySelector<HTMLInputElement>("input");
        if (consumed) {
            expect(consumed.value).toBe("保留秦子文原文定义");
            expect(consumed.disabled).toBe(true);
        }
        await render(false, "project:story");
        expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("");
        await render(false, "other-project:assets");
        expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("");
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test.each(["确认，进入下一阶段", "确认", "确认资产"])("真实阶段回调的%s与调整选项原位可点击，保留前后正文且不重复", async (confirm) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const before = "四项配置现已齐全，是否按当前配置推进？";
    const after = "图片可在制作台按需生成。";
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
        expect(selected).toEqual(["confirm"]);
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

test.each(["reply", "setup", "proposal", "stage"] as const)("新的用户输入使历史 %s 选项失效，回放旧消息也不能重新操作", async (kind) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const selected: string[] = [];
    const proposal: DramaAgentProposal = {
        kind: kind === "setup" ? "setup" : "cast",
        runId: "previous-run",
        toolCallId: "previous-choice",
        baseRevision: 1,
        targetId: "cast-one",
        changes: kind === "setup" ? { styleName: "写实电影", stylePrompt: "真实光影" } : { appearance: "保持原文设定" },
    };
    const previous: CloudAgentChatMessage = {
        id: "previous-choice-message",
        runId: "previous-run",
        role: "assistant",
        text: kind === "stage" ? "请选择下一步：\n\n1. 确认资产，开始改编剧本与分镜\n2. 继续调整" : "请选择接下来的操作：\n\n1. 检查角色\n2. 补充场景\n3. 其他问题（请直接描述）",
    };
    const newUser: CloudAgentChatMessage = { id: "new-input", role: "user", text: "先保留当前设定，我想讨论别的内容。" };
    const render = (messages: CloudAgentChatMessage[]) =>
        act(async () =>
            root.render(
                <AgentConversation
                    {...conversationDefaults}
                    guideMode
                    messages={messages}
                    onReplyOption={(text) => selected.push(text)}
                    {...(kind === "setup"
                        ? {
                              setupChoices: {
                                  proposals: [proposal],
                                  render: (items: DramaAgentProposal[]) => <GuideSetupChoices proposals={items} busy={false} isValid={() => true} issue={() => ""} onChoose={() => selected.push("setup")} onCustom={(text) => selected.push(text)} />,
                              },
                          }
                        : {})}
                    {...(kind === "proposal"
                        ? {
                              proposalChoices: {
                                  proposals: [proposal],
                                  render: () => (
                                      <AgentReplyOptionCards
                                          options={[
                                              { marker: "1", title: "保存当前建议", text: "save" },
                                              { marker: "✎", title: "调整要求", text: "输入调整要求", input: true },
                                          ]}
                                          onSelect={(option) => selected.push(option.text)}
                                      />
                                  ),
                              },
                          }
                        : {})}
                    {...(kind === "stage"
                        ? {
                              stageChoices: {
                                  key: "assets:1",
                                  pending: false,
                                  render: () => (
                                      <GuideStageChoices
                                          title="确认当前阶段"
                                          busy={false}
                                          choices={[
                                              { key: "confirm", title: "确认资产，开始改编剧本与分镜", detail: "" },
                                              { key: "adjust", title: "继续调整", detail: "", input: true },
                                          ]}
                                          onChoose={(choice, text) => selected.push(text || choice.key)}
                                      />
                                  ),
                              },
                          }
                        : {})}
                />,
            ),
        );
    try {
        await render([previous]);
        const original = container.querySelector<HTMLButtonElement>(".agent-reply-option, .drama-guide-setup-choice")!;
        expect(original).toBeTruthy();
        expect(original.disabled).toBe(false);
        await render([previous, newUser]);
        for (const element of container.querySelectorAll<HTMLButtonElement | HTMLInputElement>(".agent-reply-options button, .agent-reply-options input, .drama-guide-setup-choices button, .drama-guide-setup-choices input"))
            expect(element.disabled).toBe(true);
        await act(async () => original.click());
        expect(selected).toEqual([]);
        // 历史同步回退或失败请求撤掉气泡，不能把已经失效的旧选项再启用。
        await render([previous]);
        for (const element of container.querySelectorAll<HTMLButtonElement | HTMLInputElement>(".agent-reply-options button, .agent-reply-options input, .drama-guide-setup-choices button, .drama-guide-setup-choices input"))
            expect(element.disabled).toBe(true);
        await act(async () => original.click());
        expect(selected).toEqual([]);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test("同一轮选项的连续点击同步拦截，真正的新回复仍可选择", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const selected: string[] = [];
    const first: CloudAgentChatMessage = { id: "first-options", runId: "first-run", role: "assistant", text: "请选择：\n\n1. 检查角色\n2. 检查场景" };
    const render = (messages: CloudAgentChatMessage[], busy = false) => act(async () => root.render(<AgentConversation {...conversationDefaults} guideMode messages={messages} busy={busy} onReplyOption={(text) => selected.push(text)} />));
    try {
        await render([first]);
        const buttons = container.querySelectorAll<HTMLButtonElement>("button.agent-reply-option");
        await act(async () => {
            buttons[0].click();
            buttons[1].click();
            buttons[0].click();
        });
        expect(selected).toEqual(["检查角色"]);
        await render([first], true);
        await render([first]);
        await act(async () => container.querySelector<HTMLButtonElement>("button.agent-reply-option")?.click());
        expect(selected).toEqual(["检查角色"]);
        await render([first, { id: "user-choice", role: "user", text: "检查角色" }, { id: "new-options", runId: "new-run", role: "assistant", text: "角色已检查，请选择：\n\n1. 保留角色\n2. 修改角色" }]);
        const current = container.querySelector<HTMLButtonElement>("button.agent-reply-option")!;
        expect(current.disabled).toBe(false);
        await act(async () => current.click());
        expect(selected).toEqual(["检查角色", "保留角色"]);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test.each(["reply", "setup", "stage"] as const)("%s 自定义输入回车后，同轮再次回车、提交和其他按钮不能重复操作", async (kind) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const selected: string[] = [];
    const proposal: DramaAgentProposal = { kind: "setup", runId: "custom-run", toolCallId: "custom-style", baseRevision: 1, changes: { styleName: "写实电影", stylePrompt: "真实光影" } };
    try {
        await act(async () =>
            root.render(
                <AgentConversation
                    {...conversationDefaults}
                    guideMode
                    messages={[{ id: "custom-options", runId: "custom-run", role: "assistant", text: "请选择下一步：\n\n1. 保留当前方案\n2. 其他问题（请直接描述）" }]}
                    onReplyOption={(text) => selected.push(text)}
                    {...(kind === "setup"
                        ? {
                              setupChoices: {
                                  proposals: [proposal],
                                  render: (items: DramaAgentProposal[]) => (
                                      <GuideSetupChoices
                                          proposals={items}
                                          busy={false}
                                          isValid={() => true}
                                          issue={() => ""}
                                          onChoose={() => selected.push("chosen-style")}
                                          onCustom={(text, item) => {
                                              expect(item).toBe(proposal);
                                              selected.push(text);
                                          }}
                                      />
                                  ),
                              },
                          }
                        : {})}
                    {...(kind === "stage"
                        ? {
                              stageChoices: {
                                  key: "assets:custom",
                                  pending: false,
                                  render: () => (
                                      <GuideStageChoices
                                          title="继续当前阶段"
                                          busy={false}
                                          choices={[
                                              { key: "confirm", title: "确认资产", detail: "" },
                                              { key: "adjust", title: "继续调整", detail: "", input: true },
                                          ]}
                                          onChoose={(choice, text) => selected.push(text || choice.key)}
                                      />
                                  ),
                              },
                          }
                        : {})}
                />,
            ),
        );
        const input = container.querySelector<HTMLInputElement>("input")!;
        expect(input).toBeTruthy();
        await act(async () => {
            Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, "  保留角色原文说明  ");
            input.dispatchEvent(new browser.Event("input", { bubbles: true }));
        });
        const form = input.closest("form")!;
        const other = container.querySelector<HTMLButtonElement>("button.agent-reply-option, button.drama-guide-setup-choice")!;
        await act(async () => {
            input.dispatchEvent(new browser.CompositionEvent("compositionstart", { bubbles: true }));
            input.dispatchEvent(new browser.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", isComposing: true }));
        });
        expect(selected).toEqual([]);
        await act(async () => input.dispatchEvent(new browser.CompositionEvent("compositionend", { bubbles: true })));
        await act(async () => {
            input.dispatchEvent(new browser.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
            input.dispatchEvent(new browser.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
            form.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
            other.click();
        });
        expect(selected).toEqual(["保留角色原文说明"]);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test("本地制作请求消费后不复活，新卡片请求和明确刷新后的预检可重新确认", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const selected: string[] = [];
    const old: DramaAgentProposal = { kind: "media", runId: "studio-old-request", toolCallId: "old-call", baseRevision: 1, targetId: "old-segment", changes: { action: "segment_video", episodeId: "episode", targetRevision: 1 } };
    const fresh: DramaAgentProposal = { ...old, runId: "studio-new-request", toolCallId: "new-call", targetId: "fresh-segment" };
    let messages: CloudAgentChatMessage[] = [{ id: "conversation", runId: "agent-run", role: "assistant", text: "可以继续制作当前作品。" }];
    const render = (proposals: DramaAgentProposal[], revision = 1) =>
        act(async () =>
            root.render(
                <AgentConversation
                    {...conversationDefaults}
                    guideMode
                    dramaStudio
                    messages={messages}
                    proposalChoices={{
                        proposals,
                        interactionKey: (proposal) => `${proposal.runId}:${proposal.toolCallId}:${revision}`,
                        render: (items) =>
                            items.map((proposal) => (
                                <div key={proposal.toolCallId} data-local-request={proposal.toolCallId}>
                                    <AgentReplyOptionCards options={[{ marker: "1", title: `生成${proposal.targetId}`, text: proposal.targetId! }]} onSelect={(option) => selected.push(option.text)} />
                                </div>
                            )),
                    }}
                />,
            ),
        );
    try {
        await render([old]);
        await act(async () => container.querySelector<HTMLButtonElement>('[data-local-request="old-call"] button')!.click());
        expect(selected).toEqual(["old-segment"]);
        await render([old]);
        const prior = container.querySelector<HTMLButtonElement>('[data-local-request="old-call"] button');
        if (prior) expect(prior.disabled).toBe(true);
        await render([old, fresh]);
        const current = container.querySelector<HTMLButtonElement>('[data-local-request="new-call"] button')!;
        expect(current.disabled).toBe(false);
        await act(async () => current.click());
        expect(selected).toEqual(["old-segment", "fresh-segment"]);
        await render([fresh], 2);
        const updated = container.querySelector<HTMLButtonElement>('[data-local-request="new-call"] button')!;
        expect(updated.disabled).toBe(false);
        await act(async () => updated.click());
        expect(selected).toEqual(["old-segment", "fresh-segment", "fresh-segment"]);
        messages = [...messages, { id: "new-conversation-input", role: "user", text: "先不要生成，讨论一下角色设定。" }];
        // 原预检的迟到响应即使带新报价版本，也不能跨用户轮次恢复执行权限。
        await render([fresh], 3);
        const late = container.querySelector<HTMLButtonElement>('[data-local-request="new-call"] button');
        if (late) {
            expect(late.disabled).toBe(true);
            await act(async () => late.click());
        }
        expect(selected).toEqual(["old-segment", "fresh-segment", "fresh-segment"]);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test("已消费的阶段回复不因阶段版本刷新重新启用，新助手回复仍可继续确认", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const selected: string[] = [];
    const previous: CloudAgentChatMessage = { id: "consumed-stage-reply", runId: "assets-run", role: "assistant", text: "角色与场景已经就绪，请确认后继续。" };
    const next: CloudAgentChatMessage = { id: "new-stage-reply", runId: "story-run", role: "assistant", text: "新的剧本与分镜已经就绪，请确认后继续。" };
    const render = (messages: CloudAgentChatMessage[], stageKey: string) =>
        act(async () =>
            root.render(
                <AgentConversation
                    {...conversationDefaults}
                    guideMode
                    messages={messages}
                    stageChoices={{
                        key: stageKey,
                        pending: false,
                        render: () => <GuideStageChoices title="确认当前阶段" busy={false} choices={[{ key: "confirm", title: "确认当前阶段", detail: "" }]} onChoose={() => selected.push(stageKey)} />,
                    }}
                />,
            ),
        );
    try {
        await render([previous], "assets:1");
        const original = container.querySelector<HTMLButtonElement>("button.drama-guide-setup-choice")!;
        expect(original.disabled).toBe(false);
        await act(async () => original.click());
        expect(selected).toEqual(["assets:1"]);
        await render([previous], "story:2");
        const refreshed = container.querySelector<HTMLButtonElement>("button.drama-guide-setup-choice");
        if (refreshed) {
            expect(refreshed.disabled).toBe(true);
            await act(async () => refreshed.click());
        }
        expect(selected).toEqual(["assets:1"]);
        await render([previous, next], "story:2");
        const current = container.querySelector<HTMLButtonElement>("button.drama-guide-setup-choice")!;
        expect(current.disabled).toBe(false);
        expect(current.closest(".agent-message-body")?.textContent).toContain("新的剧本与分镜已经就绪");
        await act(async () => current.click());
        expect(selected).toEqual(["assets:1", "story:2"]);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test("复用会话历史时卸载重挂不恢复已选选项，独立会话历史不串状态", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    let root = createRoot(container);
    const history = createAgentChoiceHistory();
    const selected: string[] = [];
    const messages: CloudAgentChatMessage[] = [{ id: "same-options", runId: "same-run", role: "assistant", text: "请选择下一步：\n\n1. 检查角色\n2. 检查场景\n3. 其他问题（请直接描述）" }];
    const render = (choiceHistoryState = history) => act(async () => root.render(<AgentConversation {...conversationDefaults} guideMode messages={messages} choiceHistoryState={choiceHistoryState} onReplyOption={(text) => selected.push(text)} />));
    try {
        await render();
        await act(async () => container.querySelector<HTMLButtonElement>("button.agent-reply-option")!.click());
        expect(selected).toEqual(["检查角色"]);
        // 两种制作视图共用同一份历史，即使消息组件重新挂载也保留消费状态。
        await act(async () => root.unmount());
        root = createRoot(container);
        await render();
        for (const element of container.querySelectorAll<HTMLButtonElement | HTMLInputElement>(".agent-reply-options button, .agent-reply-options input")) expect(element.disabled).toBe(true);
        await act(async () => container.querySelector<HTMLButtonElement>("button.agent-reply-option")?.click());
        expect(selected).toEqual(["检查角色"]);
        await act(async () => root.unmount());
        root = createRoot(container);
        await render(createAgentChoiceHistory());
        const independent = container.querySelector<HTMLButtonElement>("button.agent-reply-option")!;
        expect(independent.disabled).toBe(false);
        expect(container.querySelector<HTMLInputElement>(".agent-reply-options input")!.disabled).toBe(false);
        await act(async () => independent.click());
        expect(selected).toEqual(["检查角色", "检查角色"]);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});
