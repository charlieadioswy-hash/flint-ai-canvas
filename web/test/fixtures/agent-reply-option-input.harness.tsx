import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { CloudAgentChatMessage, CloudAgentUserQuestion } from "@/components/canvas/canvas-cloud-agent-chat-ui";
import type { AgentReplyOptions } from "@/lib/canvas/agent-reply-options";

const browser = new Window({ url: "http://localhost/" });
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    SVGElement: browser.SVGElement,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
}))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AgentChatMessage, AgentQuestionBar } = await import("@/components/canvas/canvas-cloud-agent-chat-ui");
const { useAgentReplyOptionDrafts } = await import("@/components/canvas/canvas-agent-reply-options");
const { extractAgentReplyOptions } = await import("@/lib/canvas/agent-reply-options");
const { canvasThemes } = await import("@/lib/canvas-theme");
afterAll(() => browser.happyDOM.abort());

test("父容器保留问题卸载期间的填写内容，并按账号、会话及问题隔离", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const question: CloudAgentUserQuestion = { questionId: "question", question: "如何继续？", options: [{ label: "查看角色" }, { label: "其他（请直接描述）" }] };
    function QuestionLifecycle({ visible, account, conversation, question }: { visible: boolean; account: string; conversation: string; question: CloudAgentUserQuestion }) {
        const drafts = useAgentReplyOptionDrafts(JSON.stringify([account, conversation, visible ? question.questionId : undefined, visible ? question.question : undefined]));
        return visible ? <AgentQuestionBar question={question} theme={canvasThemes.light} inlineFreeform replyOptionDrafts={drafts} onAnswer={() => {}} /> : null;
    }
    const render = async (visible = true, account = "first-account", conversation = "first-conversation", current = question) => {
        await act(async () => root.render(<QuestionLifecycle visible={visible} account={account} conversation={conversation} question={current} />));
    };
    try {
        await render();
        await fill(host.querySelector<HTMLInputElement>("input")!, "明确失败后仍保留");
        await render(false);
        expect(host.querySelector("input")).toBeNull();
        await render();
        expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("明确失败后仍保留");
        await render(true, "first-account", "second-conversation");
        expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("");
        await render(true, "second-account");
        expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("");
        await render(true, "first-account", "first-conversation", { ...question, questionId: "second-question" });
        expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("");
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

const source = "你想先做哪一项？\n\n1. 查看角色\n2. 其他问题（请直接描述）";
const options = extractAgentReplyOptions(source)!;
async function messageFixture() {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const selected: string[] = [];
    const render = async (settings: { id?: string; disabled?: boolean; choices?: AgentReplyOptions | null } = {}) => {
        const item: CloudAgentChatMessage = { id: settings.id || "reply", runId: "test-run", role: "assistant", text: source };
        await act(async () =>
            root.render(<AgentChatMessage item={item} theme={canvasThemes.light} replyOptions={settings.choices === undefined ? options : settings.choices} replyOptionsDisabled={settings.disabled} onReplyOption={(text) => selected.push(text)} />),
        );
    };
    await render();
    return {
        host,
        selected,
        render,
        async dispose() {
            await act(async () => root.unmount());
            host.remove();
        },
    };
}
async function fill(input: HTMLInputElement, value: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
}
async function enter(input: HTMLInputElement, options: { isComposing?: boolean; keyCode?: number } = {}) {
    await act(async () => input.dispatchEvent(new browser.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", ...options })));
}

test("模型回复输入项在原位置填写，点击不提交标签，回车仅发送真实内容", async () => {
    const ui = await messageFixture();
    try {
        const items = ui.host.querySelectorAll(".agent-reply-option");
        expect(items).toHaveLength(2);
        expect(items[0].tagName).toBe("BUTTON");
        expect(items[1].tagName).toBe("FORM");
        const input = items[1].querySelector<HTMLInputElement>("input")!;
        await act(async () => input.click());
        await enter(input);
        await fill(input, "   ");
        await enter(input);
        expect(ui.selected).toEqual([]);
        expect(items[1].querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
        await fill(input, "  第九集为何没有生成分镜？  ");
        await enter(input);
        expect(ui.selected).toEqual(["第九集为何没有生成分镜？"]);
        await act(async () => (items[0] as HTMLButtonElement).click());
        expect(ui.selected).toEqual(["第九集为何没有生成分镜？", "查看角色"]);
    } finally {
        await ui.dispose();
    }
});

test("输入法确认、229键码及禁用状态不发送，重新启用保留草稿", async () => {
    const ui = await messageFixture();
    try {
        const input = ui.host.querySelector<HTMLInputElement>("input")!;
        await fill(input, "保留这段要求");
        await enter(input, { isComposing: true });
        await enter(input, { keyCode: 229 });
        await act(async () => input.dispatchEvent(new browser.Event("compositionstart", { bubbles: true })));
        await enter(input);
        expect(ui.selected).toEqual([]);
        await act(async () => input.dispatchEvent(new browser.Event("compositionend", { bubbles: true })));
        await ui.render({ disabled: true });
        expect(input.disabled).toBe(true);
        await enter(input);
        expect(ui.selected).toEqual([]);
        await ui.render();
        expect(input.value).toBe("保留这段要求");
        await enter(input);
        expect(ui.selected).toEqual(["保留这段要求"]);
    } finally {
        await ui.dispose();
    }
});

test("发送期间隐藏选项，失败恢复与重渲染保留输入；新消息或新选项清空", async () => {
    const ui = await messageFixture();
    try {
        await fill(ui.host.querySelector<HTMLInputElement>("input")!, "保存失败后还要重试");
        await enter(ui.host.querySelector<HTMLInputElement>("input")!);
        await ui.render({ choices: null });
        expect(ui.host.querySelector("input")).toBeNull();
        await ui.render({ choices: { ...options, options: options.options.map((option) => ({ ...option })) } });
        expect(ui.host.querySelector<HTMLInputElement>("input")!.value).toBe("保存失败后还要重试");
        await ui.render({ id: "new-reply" });
        expect(ui.host.querySelector<HTMLInputElement>("input")!.value).toBe("");
        await fill(ui.host.querySelector<HTMLInputElement>("input")!, "不串到另一选项");
        await ui.render({ id: "new-reply", choices: extractAgentReplyOptions("请选择：\n1. 查看场景\n2. 补充要求（请填写）") });
        expect(ui.host.querySelector<HTMLInputElement>("input")!.value).toBe("");
    } finally {
        await ui.dispose();
    }
});

async function questionFixture() {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const selected: string[] = [];
    const initial: CloudAgentUserQuestion = { questionId: "question", question: "你想如何继续？", options: [{ label: "查看角色" }, { label: "其他（请直接描述）" }] };
    const render = async (question = initial, disabled = false) => {
        await act(async () => root.render(<AgentQuestionBar question={question} theme={canvasThemes.light} inlineFreeform disabled={disabled} onAnswer={(text) => selected.push(text)} />));
    };
    await render();
    return {
        host,
        selected,
        initial,
        render,
        async dispose() {
            await act(async () => root.unmount());
            host.remove();
        },
    };
}

test("ask_user简单选项同样原位输入，不重复其他想法；无输入项时保留原入口", async () => {
    const ui = await questionFixture();
    try {
        expect(ui.host.querySelectorAll("input")).toHaveLength(1);
        expect(ui.host.textContent).not.toContain("其他想法");
        const input = ui.host.querySelector<HTMLInputElement>("input")!;
        await enter(input);
        await fill(input, "  请检查第九集的失败任务  ");
        await enter(input);
        expect(ui.selected).toEqual(["请检查第九集的失败任务"]);
        expect(ui.selected).not.toContain("其他（请直接描述）");
        await act(async () => ui.host.querySelector<HTMLButtonElement>("button.agent-reply-option")!.click());
        expect(ui.selected.at(-1)).toBe("查看角色");
        await ui.render({ ...ui.initial, options: [{ label: "查看角色" }, { label: "查看场景" }] });
        expect(ui.host.querySelectorAll("input")).toHaveLength(1);
        expect(ui.host.textContent).toContain("其他想法");
    } finally {
        await ui.dispose();
    }
});

test("ask_user输入按问题身份隔离，同题禁用或失败重渲染保留文字", async () => {
    const ui = await questionFixture();
    try {
        await fill(ui.host.querySelector<HTMLInputElement>("input")!, "保留问题草稿");
        await ui.render({ ...ui.initial }, true);
        const input = ui.host.querySelector<HTMLInputElement>("input")!;
        await enter(input);
        expect(ui.selected).toEqual([]);
        expect(input.value).toBe("保留问题草稿");
        await ui.render({ ...ui.initial });
        expect(ui.host.querySelector<HTMLInputElement>("input")!.value).toBe("保留问题草稿");
        await ui.render({ ...ui.initial, questionId: "next-question" });
        expect(ui.host.querySelector<HTMLInputElement>("input")!.value).toBe("");
    } finally {
        await ui.dispose();
    }
});

test("ask_user裸英文Other和Custom仍为输入项，不发送标签或隐藏唯一填写入口", async () => {
    const ui = await questionFixture();
    try {
        for (const [label, detail] of [["Other"], ["Custom"], ["Other", "Write your own request"]]) {
            await ui.render({ ...ui.initial, questionId: `${label}:${detail || ""}`, options: [{ label: "View characters" }, { label, detail }] });
            expect(ui.host.querySelectorAll("input")).toHaveLength(1);
            expect(ui.host.textContent).not.toContain("其他想法");
            const input = ui.host.querySelector<HTMLInputElement>("input")!;
            expect(input.placeholder).toBe(label);
            await fill(input, "  Review episode nine  ");
            await enter(input);
            expect(ui.selected.at(-1)).toBe("Review episode nine");
            expect(ui.selected).not.toContain(label);
        }
    } finally {
        await ui.dispose();
    }
});

test("回复和单选提问中的普通说明请求仍可直接选择，只有明确填写项显示输入框", async () => {
    const message = await messageFixture();
    const question = await questionFixture();
    const choices = ["请说明分镜审核后的流程", "请提供一套推荐配置", "其他问题（请直接描述）"];
    try {
        await message.render({ choices: extractAgentReplyOptions(`你想先了解哪一项？\n${choices.map((text, index) => `${index + 1}. ${text}`).join("\n")}`) });
        await question.render({ ...question.initial, options: choices.map((label) => ({ label })) });
        for (const ui of [message, question]) {
            const buttons = [...ui.host.querySelectorAll<HTMLButtonElement>("button.agent-reply-option")];
            expect(buttons).toHaveLength(2);
            expect(ui.host.querySelectorAll("input")).toHaveLength(1);
            await act(async () => buttons[0].click());
            await act(async () => buttons[1].click());
            expect(ui.selected).toEqual(choices.slice(0, 2));
        }
    } finally {
        await message.dispose();
        await question.dispose();
    }
});
