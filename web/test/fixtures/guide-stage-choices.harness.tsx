import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { GuideStageChoice } from "../../src/pages/projects/guide-setup-choices";

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
const { GuideStageChoices } = await import("../../src/pages/projects/guide-setup-choices");

afterAll(() => {
    browser.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

const confirm: GuideStageChoice = { key: "confirm", title: "确认资产，开始改编剧本与分镜", detail: "使用当前文字资产进入下一阶段" };
const adjust: GuideStageChoice = { key: "adjust", title: "继续调整", detail: "说明希望修改的内容", input: true };

async function fixture() {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const chosen: Array<{ choice: GuideStageChoice; text?: string }> = [];
    const render = async (busy = false, title = "下一步：开始改编") => {
        await act(async () => {
            root.render(<GuideStageChoices title={title} choices={[confirm, adjust]} busy={busy} onChoose={(choice, text) => chosen.push({ choice, text })} />);
        });
    };
    const dispose = async () => {
        await act(async () => root.unmount());
        host.remove();
    };
    try {
        await render();
        return { host, chosen, render, dispose };
    } catch (error) {
        await dispose();
        throw error;
    }
}

async function fill(input: HTMLInputElement, value: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
}

async function enter(input: HTMLInputElement, options: { isComposing?: boolean; keyCode?: number } = {}) {
    const event = new browser.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", ...options });
    await act(async () => input.dispatchEvent(event));
    return event;
}

async function submit(input: HTMLInputElement) {
    await act(async () => input.closest("form")!.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })));
}

test("确认按钮直接推进，调整选项原位填写并通过回车发送真实要求", async () => {
    const ui = await fixture();
    try {
        const input = ui.host.querySelector<HTMLInputElement>('input[aria-label="继续调整"]')!;
        expect(input).not.toBeNull();
        expect(input.closest("form")).not.toBeNull();
        const ordinaryButtons = [...ui.host.querySelectorAll<HTMLButtonElement>('button[type="button"]')];
        expect(ordinaryButtons).toHaveLength(1);
        expect(ordinaryButtons[0].textContent).toContain(confirm.title);
        expect(ordinaryButtons.some((button) => button.textContent?.trim() === adjust.title)).toBe(false);
        await act(async () => ordinaryButtons[0].click());
        expect(ui.chosen).toEqual([{ choice: confirm, text: undefined }]);

        await fill(input, "  保留角色原文，把客厅场景改为夜晚  ");
        await enter(input);
        expect(ui.chosen).toEqual([
            { choice: confirm, text: undefined },
            { choice: adjust, text: "保留角色原文，把客厅场景改为夜晚" },
        ]);
    } finally {
        await ui.dispose();
    }
});

test("空白不发送，忙碌时不能确认或调整并保留输入，恢复后可以提交", async () => {
    const ui = await fixture();
    try {
        const input = ui.host.querySelector<HTMLInputElement>("input")!;
        await fill(input, " \n  ");
        expect(ui.host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
        await enter(input);
        await submit(input);
        expect(ui.chosen).toEqual([]);

        await fill(input, "  第三集节奏加快，其余保持不变  ");
        await ui.render(true);
        expect(input.disabled).toBe(true);
        expect([...ui.host.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled)).toBe(true);
        await act(async () => ui.host.querySelector<HTMLButtonElement>('button[type="button"]')!.click());
        await enter(input);
        await submit(input);
        expect(ui.chosen).toEqual([]);
        expect(input.value).toBe("  第三集节奏加快，其余保持不变  ");

        await ui.render(false);
        expect(input.disabled).toBe(false);
        await submit(input);
        expect(ui.chosen).toEqual([{ choice: adjust, text: "第三集节奏加快，其余保持不变" }]);
    } finally {
        await ui.dispose();
    }
});

test("中文输入法确认候选词的回车不会误发送，结束输入后才允许发送", async () => {
    const ui = await fixture();
    try {
        const input = ui.host.querySelector<HTMLInputElement>("input")!;
        await fill(input, "把风格改为水墨动画");
        await enter(input, { isComposing: true });
        expect(ui.chosen).toEqual([]);
        await act(async () => input.dispatchEvent(new browser.Event("compositionstart", { bubbles: true })));
        await enter(input);
        await submit(input);
        expect(ui.chosen).toEqual([]);
        await act(async () => input.dispatchEvent(new browser.Event("compositionend", { bubbles: true })));
        await enter(input);
        expect(ui.chosen).toEqual([{ choice: adjust, text: "把风格改为水墨动画" }]);
    } finally {
        await ui.dispose();
    }
});

test("同阶段重渲染保留调整草稿，进入下一阶段不携带上一阶段的草稿", async () => {
    const ui = await fixture();
    try {
        await fill(ui.host.querySelector<HTMLInputElement>("input")!, "给秦子文增加照顾弟弟的背景");
        await ui.render();
        expect(ui.host.querySelector<HTMLInputElement>("input")!.value).toBe("给秦子文增加照顾弟弟的背景");
        await ui.render(false, "下一步：进入制作台");
        expect(ui.host.querySelector<HTMLInputElement>("input")!.value).toBe("");
        expect(ui.chosen).toEqual([]);
    } finally {
        await ui.dispose();
    }
});
