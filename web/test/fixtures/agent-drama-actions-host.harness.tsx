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
const { GuideSetupChoices } = await import("@/pages/projects/guide-setup-choices");
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

test("真实聊天把同轮语言候选和说明合为一组消息内选项，直接选择及自定义保留原建议身份", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const proposals: DramaAgentProposal[] = [
        ["中文普通话", "国内观众覆盖面最广。"],
        ["粤语", "适合港风氛围。"],
        ["英语", "适合国际观众。"],
        ["无对白", "依靠画面叙事。"],
    ].map(([language, explanation], index) => ({ kind: "setup", runId: "language-run", toolCallId: `language-${index}`, baseRevision: 7, changes: { language }, explanation }));
    const rawText = "请选择对白语言：\n\n1. **中文普通话（推荐）**：国内观众覆盖面最广。\n2. **粤语**：适合港风氛围。\n3. **英语**：适合国际观众。\n4. **无对白**：依靠画面叙事。\n\n请直接在下方卡片选择语言，也可以填写自己的选择。";
    const messages = [
        { id: "previous", runId: "style-run", role: "assistant" as const, text: "上一轮已确认视觉风格。" },
        { id: "language", runId: "language-run", role: "assistant" as const, text: rawText },
        { id: "error", runId: "language-run", role: "error" as const, text: "服务连接失败，请重试。" },
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
        expect(container.textContent).toContain("下方卡片");
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
            expect(bubble.textContent!.split(String(proposal.changes.language))).toHaveLength(2);
            expect(bubble.textContent!.split(proposal.explanation!)).toHaveLength(2);
        }
        expect(container.textContent).toContain("下方卡片");
        expect(container.textContent).toContain("上一轮已确认视觉风格。");
        expect(container.textContent).toContain("服务连接失败，请重试。");
        expect(messages[1].text).toBe(rawText);
        await act(async () => group.querySelectorAll<HTMLButtonElement>(".drama-guide-setup-choice")[1].click());
        expect(chosen).toHaveLength(1);
        expect(chosen[0]).toBe(proposals[1]);
        expect(genericReplies).toEqual([]);

        const input = group.querySelector<HTMLInputElement>('input[aria-label="自定义对白语言"]')!;
        expect(input.value).toBe("");
        await act(async () => {
            Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, "  四川话  ");
            input.dispatchEvent(new browser.Event("input", { bubbles: true }));
        });
        await act(async () => input.closest("form")!.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })));
        expect(custom).toHaveLength(1);
        expect(custom[0].text).toBe("四川话");
        expect(custom[0].proposal).toBe(proposals[0]);
        expect(chosen).toHaveLength(1);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test.each(["failed", "cancelled"] as const)("最后说明流式输出后进入 %s，已生成的配置选项仍可直接点选", async (status) => {
    const runId = `language-${status}`;
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
    for (const [index, language] of ["中文普通话", "粤语"].entries()) {
        reduce("tool_completed", { toolName: "drama_propose_changes", callId: `language-${index}`, result: { kind: "setup", baseRevision: 7, changes: { language }, explanation: `${language}配音` } });
    }
    reduce("assistant_delta", { messageId: "final-answer", text: "请选择对白语言。" });
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
        expect(choices[1].closest(".agent-message-body")?.textContent).toContain("请选择对白语言。");
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
