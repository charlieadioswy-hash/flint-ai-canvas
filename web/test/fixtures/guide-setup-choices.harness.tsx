import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { DramaAgentProposal } from "../../src/services/api/agent";

const browser = new Window({ url: "http://localhost/" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    Element: browser.Element,
    Node: browser.Node,
    SVGElement: browser.SVGElement,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { GuideSetupChoices } = await import("../../src/pages/projects/guide-setup-choices");

afterAll(() => {
    browser.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function option(id: string, changes: Record<string, unknown>, runId = "run", baseRevision = 7): DramaAgentProposal {
    return { kind: "setup", runId, baseRevision, toolCallId: id, changes };
}

async function fixture(proposals: DramaAgentProposal[], blocked: { invalid?: string[]; issue?: string[]; busy?: boolean } = {}) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const chosen: DramaAgentProposal[] = [];
    const custom: Array<{ text: string; proposal: DramaAgentProposal }> = [];
    const refreshed: DramaAgentProposal[] = [];
    const render = async (next: DramaAgentProposal[], busy = Boolean(blocked.busy)) => {
        await act(async () => {
            root.render(
                <GuideSetupChoices
                    proposals={next}
                    busy={busy}
                    isValid={(proposal) => !blocked.invalid?.includes(proposal.toolCallId)}
                    issue={(proposal) => (blocked.issue?.includes(proposal.toolCallId) ? "当前模型不支持这个清晰度" : "")}
                    onChoose={(proposal) => chosen.push(proposal)}
                    onCustom={(text, proposal) => custom.push({ text, proposal })}
                    onRefresh={(proposal) => refreshed.push(proposal)}
                />,
            );
        });
    };
    const dispose = async () => {
        await act(async () => root.unmount());
        host.remove();
    };
    try {
        await render(proposals);
        return { host, chosen, custom, refreshed, render, dispose };
    } catch (error) {
        await dispose();
        throw error;
    }
}

test("同轮风格备选成为直接选择按钮，不包含应用或确认步骤", async () => {
    const choices = [option("real", { styleName: "电影写实", stylePrompt: "自然光与真实材质", models: { video: "不应展示" } }), { ...option("anime", { styleName: "国风动画", stylePrompt: "细腻线条" }), explanation: "适合东方奇幻故事" }];
    const ui = await fixture(choices);
    try {
        expect(ui.host.querySelectorAll("section")).toHaveLength(1);
        expect(ui.host.textContent).not.toContain("应用此建议");
        expect(ui.host.textContent).not.toContain("不应展示");
        const buttons = ui.host.querySelectorAll<HTMLButtonElement>(".drama-guide-setup-choice");
        expect(buttons).toHaveLength(2);
        expect(buttons[0].textContent).toContain("自然光与真实材质");
        expect(buttons[1].textContent).toContain("适合东方奇幻故事");
        await act(async () => buttons[1].click());
        expect(ui.chosen).toEqual([choices[1]]);
        expect(ui.custom).toEqual([]);
    } finally {
        await ui.dispose();
    }
});

test("分组隔离不同决策、运行与版本，并为每组保留空白自定义输入", async () => {
    const ui = await fixture([
        option("style", { styleName: "写实" }),
        option("style2", { styleName: "动画" }),
        option("language", { language: "粤语" }),
        option("style3", { styleName: "手绘" }, "another-run"),
        option("style4", { styleName: "胶片" }, "run", 8),
        { ...option("other", { name: "角色" }), kind: "cast" },
        option("unknown", { arbitrary: "不支持" }),
    ]);
    try {
        const inputs = ui.host.querySelectorAll<HTMLInputElement>("input");
        expect(inputs).toHaveLength(4);
        expect([...inputs].every((input) => input.value === "")).toBe(true);
        expect([...ui.host.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].every((button) => button.disabled)).toBe(true);
        expect(ui.host.textContent).toContain("选择对白语言");
        expect(ui.host.textContent).not.toContain("不支持");
    } finally {
        await ui.dispose();
    }
});

test("填写其他选项按主题提交且不会在失败或重渲染后丢失", async () => {
    const choices = [option("style", { styleName: "写实" }), option("language", { language: "中文普通话" })];
    const ui = await fixture(choices);
    try {
        const input = ui.host.querySelector<HTMLInputElement>('input[aria-label="自定义视觉风格"]')!;
        const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!;
        await act(async () => {
            setter.call(input, "  怀旧港片，暖色胶片  ");
            input.dispatchEvent(new browser.Event("input", { bubbles: true }));
        });
        const form = input.closest("form")!;
        expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
        await act(async () => form.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })));
        expect(ui.custom).toEqual([{ text: "怀旧港片，暖色胶片", proposal: choices[0] }]);
        await ui.render([...choices]);
        expect(ui.host.querySelector<HTMLInputElement>('input[aria-label="自定义视觉风格"]')!.value).toBe("  怀旧港片，暖色胶片  ");
        expect(ui.host.querySelector<HTMLInputElement>('input[aria-label="自定义对白语言"]')!.value).toBe("");
        await ui.render([option("new", { styleName: "动画" }, "new-run")]);
        expect(ui.host.querySelector<HTMLInputElement>("input")!.value).toBe("");
    } finally {
        await ui.dispose();
    }
});

test("过期和不支持选项给出原因及重新推荐入口，自定义仍可填写", async () => {
    const choices = [option("old", { language: "粤语" }), option("unsupported", { aspectRatio: "16:9", videoResolution: "4k" })];
    const ui = await fixture(choices, { invalid: ["old"], issue: ["unsupported"] });
    try {
        const buttons = ui.host.querySelectorAll<HTMLButtonElement>(".drama-guide-setup-choice");
        expect([...buttons].every((button) => button.disabled)).toBe(true);
        expect([...buttons].every((button) => Boolean(button.getAttribute("aria-describedby")))).toBe(true);
        expect(ui.host.textContent).toContain("此选项已过期");
        expect(ui.host.textContent).toContain("当前模型不支持这个清晰度");
        await act(async () => ui.host.querySelector<HTMLButtonElement>(".drama-guide-setup-refresh")!.click());
        expect(ui.refreshed).toEqual([choices[0]]);
        expect([...ui.host.querySelectorAll<HTMLInputElement>("input")].every((input) => !input.disabled)).toBe(true);
        expect(ui.chosen).toEqual([]);
    } finally {
        await ui.dispose();
    }
});

test("保存期间禁用选项和自定义提交，整套历史配置以创作方案显示", async () => {
    const choices = [option("bundle", { styleName: "电影感", stylePrompt: "光影", aspectRatio: "16:9", language: "英语", episodeSeconds: 90 })];
    const ui = await fixture(choices, { busy: true });
    try {
        expect(ui.host.textContent).toContain("选择创作方案");
        expect([...ui.host.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled)).toBe(true);
        expect(ui.host.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
        await act(async () => ui.host.querySelector<HTMLButtonElement>(".drama-guide-setup-choice")!.click());
        expect(ui.chosen).toEqual([]);
    } finally {
        await ui.dispose();
    }
});
