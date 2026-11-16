import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, StrictMode, useState } from "react";

import type { DramaAssetMode, DramaAssetScheme } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/projects", width: 1280, height: 800 });
for (const key of [
    "window",
    "document",
    "navigator",
    "Window",
    "Document",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLButtonElement",
    "HTMLInputElement",
    "HTMLSelectElement",
    "HTMLOptionElement",
    "HTMLTextAreaElement",
    "SVGElement",
    "ShadowRoot",
    "MutationObserver",
    "ResizeObserver",
    "IntersectionObserver",
    "Event",
    "CustomEvent",
    "KeyboardEvent",
    "MouseEvent",
    "PointerEvent",
    "FocusEvent",
    "NodeFilter",
    "DOMRect",
    "CSS",
] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "window" ? browser : browser[key] });
}
Object.assign(globalThis, { getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CharacterTemplatePicker } = await import("@/pages/projects/character-template-picker");

const modes: Exclude<DramaAssetMode, "custom">[] = [
    "none",
    "closeup_turnaround",
    "closeup_front_no_face",
    "closeup_turnaround_no_head",
    "closeup_fullbody",
    "dual_closeup_front_back_no_head",
    "triple_closeup_front_no_face",
    "turnaround_triple_closeup",
    "turnaround_five_angle_halfbody",
    "headshot_fullbody",
];
const schemes: DramaAssetScheme[] = modes.map((mode, index) => ({ mode, name: `模板${index}`, ratio: index === 5 ? "9:16" : "16:9", description: "", frameHint: "", characterPrompt: mode }));
let columns = 3;
const rect = (x: number, y: number, width: number, height: number) => new browser.DOMRect(x, y, width, height);
// HappyDOM 没有布局引擎，只提供两种真实网格几何；导航与滚动使用未 mock 的产品组件和 React Aria。
browser.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("drama-character-template-list")) return rect(20, 100, columns * 200, 300);
    if (this.getAttribute("role") === "option") {
        const list = this.closest<HTMLElement>('[role="listbox"]')!;
        const index = Array.from(list.querySelectorAll('[role="option"]')).indexOf(this);
        return rect(20 + (index % columns) * 200, 100 + Math.floor(index / columns) * 180 - list.scrollTop, 200, 180);
    }
    if (this.classList.contains("drama-character-template-popup")) return rect(20, 100, columns * 200, 308);
    return rect(20, 60, 280, 32);
};
// 原生最近位置滚动需要浏览器布局；在相同几何中补齐此 DOM 原语，保持产品与库的导航代码真实。
browser.HTMLElement.prototype.scrollIntoView = function () {
    const list = this.closest<HTMLElement>(".drama-character-template-list");
    if (!list || list === this) return;
    const area = list.getBoundingClientRect();
    const item = this.getBoundingClientRect();
    if (item.top < area.top) list.scrollTop -= area.top - item.top;
    else if (item.bottom > area.bottom) list.scrollTop += item.bottom - area.bottom;
};
for (const name of ["clientHeight", "offsetHeight", "clientWidth", "offsetWidth", "scrollHeight", "scrollWidth"] as const) {
    Object.defineProperty(browser.HTMLElement.prototype, name, {
        configurable: true,
        get() {
            if (this === document.documentElement || this === document.body) return name.includes("Width") ? 1280 : 800;
            if (this.classList.contains("drama-character-template-list")) return name.includes("Width") ? columns * 200 : name === "scrollHeight" ? Math.ceil(modes.length / columns) * 180 : 300;
            return name.includes("Width") ? 280 : 32;
        },
    });
}
const settle = async () => {
    for (let index = 0; index < 4; index += 1) await Bun.sleep(10);
};
async function call(callback: () => void) {
    await act(async () => {
        callback();
        await settle();
    });
}
async function key(value: string) {
    await call(() => {
        const target = document.activeElement!;
        for (const type of ["keydown", "keyup"]) target.dispatchEvent(new KeyboardEvent(type, { key: value, code: value, bubbles: true, cancelable: true }));
    });
}
async function mount(options: { columns?: number; disabled?: boolean; schemes?: DramaAssetScheme[]; value?: DramaAssetMode } = {}) {
    columns = options.columns || 3;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const changes: DramaAssetMode[] = [];
    function Editor() {
        const [value, setValue] = useState(options.value || "closeup_turnaround");
        return createElement(CharacterTemplatePicker, {
            value,
            schemes: options.schemes || schemes,
            disabled: options.disabled,
            onChange: (mode) => {
                changes.push(mode);
                setValue(mode);
            },
        });
    }
    await act(async () => {
        root.render(createElement(StrictMode, null, createElement(Editor)));
        await settle();
    });
    const trigger = container.querySelector<HTMLButtonElement>(".drama-character-template-trigger")!;
    return {
        trigger,
        changes,
        open: async () => {
            await call(() => {
                trigger.focus();
                trigger.click();
            });
            const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
            expect(list).not.toBeNull();
            list.style.overflow = "auto";
            list.style.direction = "ltr";
            await call(() => {});
            return list;
        },
        close: async () => {
            await act(async () => root.unmount());
            container.remove();
        },
    };
}
function focusedMode() {
    return document.activeElement?.querySelector<HTMLElement>("[data-template]")?.dataset.template;
}
function expectLastVisible(list: HTMLElement) {
    const last = list.querySelector('[data-template="headshot_fullbody"]')!.closest<HTMLElement>('[role="option"]')!;
    const area = list.getBoundingClientRect();
    const item = last.getBoundingClientRect();
    expect(item.top).toBeGreaterThanOrEqual(area.top);
    expect(item.bottom).toBeLessThanOrEqual(area.bottom);
    expect(list.scrollTop).toBeGreaterThan(0);
}
afterAll(() => browser.happyDOM.abort());

test("桌面三列方向键保持同列并滚动末项，Enter只提交当前高亮模板并归还焦点", async () => {
    const view = await mount();
    try {
        const list = await view.open();
        expect(list.querySelectorAll('[role="option"]')).toHaveLength(10);
        expect(focusedMode()).toBe("closeup_turnaround");
        await key("ArrowDown");
        expect(focusedMode()).toBe("closeup_fullbody");
        await key("ArrowRight");
        expect(focusedMode()).toBe("dual_closeup_front_back_no_head");
        expect(view.changes).toHaveLength(0);
        await key("ArrowLeft");
        await key("ArrowLeft");
        await key("ArrowDown");
        await key("ArrowDown");
        expect(focusedMode()).toBe("headshot_fullbody");
        expectLastVisible(list);
        await key("Enter");
        expect(view.changes).toEqual(["headshot_fullbody"]);
        expect(document.querySelector('[role="listbox"]')).toBeNull();
        expect(document.activeElement).toBe(view.trigger);
        expect(view.trigger.textContent).toContain("模板9");
    } finally {
        await view.close();
    }
});

test("窄屏两列按实际行列导航，末项可见，Escape取消且再次打开仍选原模板", async () => {
    const view = await mount({ columns: 2 });
    try {
        const list = await view.open();
        await key("ArrowDown");
        expect(focusedMode()).toBe("closeup_turnaround_no_head");
        await key("ArrowLeft");
        expect(focusedMode()).toBe("closeup_front_no_face");
        await key("End");
        expectLastVisible(list);
        await key("Escape");
        expect(view.changes).toHaveLength(0);
        expect(document.querySelector('[role="listbox"]')).toBeNull();
        expect(document.activeElement).toBe(view.trigger);
        const reopened = await view.open();
        expect(reopened.querySelector('[aria-selected="true"] [data-template]')?.getAttribute("data-template")).toBe("closeup_turnaround");
        expect(view.trigger.textContent).toContain("模板1");
    } finally {
        await view.close();
    }
});

test("鼠标滚动后点击末项仍提交该模板，不依赖先前键盘焦点", async () => {
    const view = await mount();
    try {
        const list = await view.open();
        await call(() => {
            list.scrollTop = list.scrollHeight - list.clientHeight;
            list.querySelector('[data-template="headshot_fullbody"]')!.closest<HTMLElement>('[role="option"]')!.click();
        });
        expect(view.changes).toEqual(["headshot_fullbody"]);
        expect(document.querySelector('[role="listbox"]')).toBeNull();
    } finally {
        await view.close();
    }
});

test("自定义模板切换内置模板立即更新名称与选中项，重新打开保持新选择", async () => {
    const view = await mount({ value: "custom" });
    try {
        expect(view.trigger.textContent).toContain("自定义模板");
        const list = await view.open();
        await call(() => list.querySelector('[data-template="closeup_turnaround"]')!.closest<HTMLElement>('[role="option"]')!.click());
        expect(view.changes).toEqual(["closeup_turnaround"]);
        expect(view.trigger.textContent).toContain("模板1");
        expect(document.querySelector('[role="listbox"]')).toBeNull();
        const reopened = await view.open();
        expect(reopened.querySelector('[aria-selected="true"] [data-template]')?.getAttribute("data-template")).toBe("closeup_turnaround");
    } finally {
        await view.close();
    }
});

test("初始已选末项打开时直接可见，三列与两列均无需额外导航", async () => {
    for (const columns of [3, 2]) {
        const view = await mount({ columns, value: "headshot_fullbody" });
        try {
            const list = await view.open();
            expect(focusedMode()).toBe("headshot_fullbody");
            expectLastVisible(list);
            expect(view.changes).toHaveLength(0);
        } finally {
            await view.close();
        }
    }
});

test("选中末项后重复打开均保持选项可见，Escape不改变已选值", async () => {
    const view = await mount();
    try {
        await view.open();
        await key("End");
        await key("Enter");
        expect(view.changes).toEqual(["headshot_fullbody"]);
        for (let opening = 0; opening < 2; opening += 1) {
            const list = await view.open();
            expect(focusedMode()).toBe("headshot_fullbody");
            expectLastVisible(list);
            await key("Escape");
            expect(document.activeElement).toBe(view.trigger);
            expect(view.changes).toEqual(["headshot_fullbody"]);
        }
    } finally {
        await view.close();
    }
});

test("禁用或目录为空不能打开选项，已有自定义值保持可读且不会被替换", async () => {
    for (const options of [{ disabled: true }, { schemes: [], value: "custom" as const }]) {
        const view = await mount(options);
        try {
            expect(view.trigger.disabled).toBe(true);
            await call(() => view.trigger.click());
            expect(document.querySelector('[role="listbox"]')).toBeNull();
            expect(view.changes).toHaveLength(0);
            if (options.value === "custom") expect(view.trigger.textContent).toContain("自定义模板");
        } finally {
            await view.close();
        }
    }
});
