import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";

const browser = new Window({ url: "http://localhost/projects/project?manage=episodes" });
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
}))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const store = create(() => ({ user: { id: "user" } }));
const calls: Array<{ projectId: string; input: Record<string, unknown> }> = [];
const added: string[] = [];
const dirtyStates: Array<[boolean, boolean | undefined]> = [];
const confirms: Array<{ onOk: () => void; onCancel: () => void }> = [];
const messages: string[] = [];
let closes = 0;
let resolveWrite!: (value: any) => void;
let rejectWrite!: (reason: Error) => void;
mock.module("@/stores/use-user-store", () => ({ useUserStore: store }));
mock.module("@/components/ui/product/app-modal", () => ({ AppModal: ({ children }: { children: ReactNode }) => <section role="dialog">{children}</section> }));
mock.module("@/pages/projects/drama-shared", () => ({
    formatCount: String,
    SOURCE_FORMAT_LABEL: Object.fromEntries(["novel", "script", "storyboard"].map((value) => [value, { title: value, guide: [value], placeholder: value }])),
    SourceFormatPicker: ({ value, onChange, disabled }: any) => (
        <select aria-label="素材类型" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
            <option value="novel">小说</option>
            <option value="script">剧本</option>
            <option value="storyboard">分镜</option>
        </select>
    ),
}));
const Input = ({ onChange, ...props }: any) => createElement("input", { ...props, onInput: onChange });
Input.TextArea = ({ onChange, ...props }: any) => createElement("textarea", { ...props, onInput: onChange });
mock.module("antd", () => ({
    App: {
        useApp: () => ({
            message: { success: (value: string) => messages.push(value), warning: () => undefined },
            modal: {
                confirm: (options: any) => {
                    confirms.push(options);
                    return { destroy: () => undefined };
                },
            },
        }),
    },
    Button: ({ children, type: _type, loading: _loading, icon: _icon, block: _block, ...props }: any) => createElement("button", props, children),
    Checkbox: () => null,
    Input,
}));
mock.module("@/services/api/drama", () => ({
    addDramaEpisode: (projectId: string, input: Record<string, unknown>) => {
        calls.push({ projectId, input });
        return new Promise((resolve, reject) => {
            resolveWrite = resolve;
            rejectWrite = reject;
        });
    },
    getDramaChapter: () => undefined,
    updateDramaChapter: () => undefined,
    updateDramaEpisode: () => undefined,
}));
const { AddEpisodeModal } = await import("@/pages/projects/studio/episode-source");
afterAll(() => browser.happyDOM.abort());
function reset() {
    calls.length = added.length = dirtyStates.length = confirms.length = messages.length = closes = 0;
    store.setState({ user: { id: "user" } });
    browser.localStorage.setItem("yingce:active-user-scope", "user");
}
async function settle() {
    await Bun.sleep(2);
}
async function mount(initial: Record<string, any> = {}) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let props: Record<string, any> = { open: true, projectId: "project", expectedRevision: 4, nextNumber: 2, defaultFormat: "novel", ...initial };
    const render = async (patch: Record<string, any> = {}) => {
        props = { ...props, ...patch };
        await act(async () => {
            root.render(
                <AddEpisodeModal
                    {...(props as any)}
                    onClose={() => closes++}
                    onAdded={(id) => added.push(id)}
                    onDirtyChange={(dirty, busy) => {
                        dirtyStates.push([dirty, busy]);
                    }}
                />,
            );
            await settle();
        });
    };
    await render();
    return {
        host,
        render,
        close: async () => {
            await act(async () => {
                root.unmount();
                host.remove();
                await settle();
            });
        },
    };
}
function button(host: HTMLElement, name: string) {
    const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === name || item.getAttribute("aria-label") === name);
    if (!result) throw new Error(`Missing ${name}`);
    return result;
}
async function click(element: HTMLElement) {
    await act(async () => {
        element.click();
        await settle();
    });
}
async function input(host: HTMLElement, label: string, value: string) {
    await act(async () => {
        const element = host.querySelector<HTMLInputElement>(`[aria-label='${label}']`)!;
        element.value = value;
        element.dispatchEvent(new browser.Event("input", { bubbles: true }) as any);
        await settle();
    });
}
async function finish() {
    await act(async () => {
        resolveWrite({ episode: { id: "new-episode", number: 2 } });
        await settle();
    });
}

test("空原文禁提交，带版本新建并防同帧双击，提交期锁定输入与关闭", async () => {
    reset();
    const view = await mount();
    try {
        expect(button(view.host, "新建分集").disabled).toBe(true);
        await input(view.host, "集标题", "  第二集  ");
        await input(view.host, "本集原文", "本集正文");
        await act(async () => {
            button(view.host, "新建分集").click();
            button(view.host, "新建分集").click();
            button(view.host, "取消").click();
            await settle();
        });
        expect(calls).toEqual([{ projectId: "project", input: { title: "第二集", text: "本集正文", sourceFormat: "novel", expectedRevision: 4 } }]);
        expect(view.host.querySelector<HTMLInputElement>("[aria-label='集标题']")!.disabled).toBe(true);
        expect(button(view.host, "关闭").disabled).toBe(true);
        expect(closes).toBe(0);
        expect(dirtyStates).toContainEqual([true, true]);
        await finish();
        expect(added).toEqual(["new-episode"]);
        expect(messages).toEqual(["已新建第 2 集"]);
    } finally {
        await view.close();
    }
});
test("简易制作台只创建分集草稿，保留后续主体步骤", async () => {
    reset();
    const view = await mount({ createDraft: true });
    try {
        await input(view.host, "本集原文", "待提取主体的正文");
        await act(async () => button(view.host, "新建分集").click());
        expect(calls).toEqual([{ projectId: "project", input: { title: "", text: "待提取主体的正文", sourceFormat: "novel", expectedRevision: 4, createDraft: true } }]);
        await finish();
        expect(added).toEqual(["new-episode"]);
    } finally {
        await view.close();
    }
});

test("轮询版本变化保留原文但不自动抬高提交版本，重新打开才取新版本", async () => {
    reset();
    const view = await mount();
    try {
        await input(view.host, "本集原文", "待保存草稿");
        await view.render({ expectedRevision: 5 });
        expect(view.host.textContent).toContain("作品已有更新");
        expect(button(view.host, "新建分集").disabled).toBe(true);
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("待保存草稿");
        await view.render({ open: false });
        await view.render({ open: true });
        await input(view.host, "本集原文", "核对后的新集");
        await click(button(view.host, "新建分集"));
        expect(calls[0].input.expectedRevision).toBe(5);
        await finish();
    } finally {
        await view.close();
    }
});
test("结果不确定时显示错误并禁止直接重发，需回列表核对", async () => {
    reset();
    const view = await mount();
    try {
        await input(view.host, "本集原文", "正文");
        await click(button(view.host, "新建分集"));
        await act(async () => {
            rejectWrite(new Error("网络断开"));
            await settle();
        });
        expect(view.host.textContent).toContain("网络断开");
        expect(view.host.textContent).toContain("核对分集列表");
        expect(button(view.host, "新建分集").disabled).toBe(true);
        await click(button(view.host, "新建分集"));
        expect(calls).toHaveLength(1);
        expect(button(view.host, "取消").disabled).toBe(false);
    } finally {
        await view.close();
    }
});
test("切作品与账号后迟到写回不触发新页面回调，草稿按会话隔离", async () => {
    for (const switchAccount of [false, true]) {
        reset();
        const view = await mount();
        try {
            await input(view.host, "本集原文", "旧项目正文");
            await click(button(view.host, "新建分集"));
            if (switchAccount) {
                browser.localStorage.setItem("yingce:active-user-scope", "other");
                await act(async () => {
                    store.setState({ user: { id: "other" } });
                    await settle();
                });
            } else await view.render({ projectId: "other-project" });
            expect(view.host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
            await finish();
            expect(added).toEqual([]);
            expect(messages).toEqual([]);
        } finally {
            await view.close();
        }
    }
});
test("脏草稿关闭要确认，提交后迟到的关闭确认不能绕过锁", async () => {
    reset();
    const view = await mount();
    try {
        await click(button(view.host, "关闭"));
        expect(closes).toBe(1);
        await input(view.host, "本集原文", "草稿");
        await click(button(view.host, "取消"));
        expect(confirms).toHaveLength(1);
        expect(closes).toBe(1);
        const pending = confirms[0];
        await click(button(view.host, "新建分集"));
        await act(async () => {
            pending.onOk();
            await settle();
        });
        expect(closes).toBe(1);
        await finish();
        await view.render({ open: false });
        await view.render({ open: true });
        await input(view.host, "集标题", "另一个草稿");
        await click(button(view.host, "取消"));
        await act(async () => {
            confirms.at(-1)!.onOk();
            await settle();
        });
        expect(closes).toBe(2);
    } finally {
        await view.close();
    }
});
test("关闭重开后旧文件读取回执不能覆盖新草稿", async () => {
    reset();
    const view = await mount();
    try {
        let resolveRead!: (value: ArrayBuffer) => void;
        const file = {
            name: "旧正文.txt",
            size: 8,
            arrayBuffer: () =>
                new Promise<ArrayBuffer>((resolve) => {
                    resolveRead = resolve;
                }),
        };
        await act(async () => {
            const picker = view.host.querySelector<HTMLInputElement>("input[type=file]")!;
            Object.defineProperty(picker, "files", { configurable: true, value: [file] });
            picker.dispatchEvent(new browser.Event("change", { bubbles: true }) as any);
            await settle();
        });
        await view.render({ open: false });
        await view.render({ open: true });
        await input(view.host, "本集原文", "新草稿");
        await act(async () => {
            resolveRead(new TextEncoder().encode("旧文件").buffer);
            await settle();
        });
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("新草稿");
        expect(view.host.querySelector<HTMLInputElement>("[aria-label='集标题']")!.value).toBe("");
    } finally {
        await view.close();
    }
});
test("插入保持锚点位置与素材类型，受规划门禁和单集长度限制", async () => {
    reset();
    const view = await mount({ placement: { anchorId: "e1", anchorNumber: 1, position: "after" }, defaultFormat: "script", blockedReason: "仍在分集规划" });
    try {
        await input(view.host, "本集原文", "剧本");
        expect(button(view.host, "插入分集").disabled).toBe(true);
        await view.render({ blockedReason: undefined });
        await input(view.host, "本集原文", "长".repeat(12_001));
        expect(button(view.host, "插入分集").disabled).toBe(true);
        await input(view.host, "本集原文", "剧本");
        await click(button(view.host, "插入分集"));
        expect(calls[0].input).toEqual({ title: "", text: "剧本", sourceFormat: "script", expectedRevision: 4, anchorEpisodeId: "e1", position: "after" });
        await finish();
    } finally {
        await view.close();
    }
});
test("连续选文件只采纳最新读取，人工改文后不被迟到文件覆盖", async () => {
    reset();
    const view = await mount();
    try {
        const reads: Array<(value: ArrayBuffer) => void> = [];
        const choose = async (name: string) => {
            await act(async () => {
                const picker = view.host.querySelector<HTMLInputElement>("input[type=file]")!;
                Object.defineProperty(picker, "files", { configurable: true, value: [{ name, size: 8, arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => reads.push(resolve)) }] });
                picker.dispatchEvent(new browser.Event("change", { bubbles: true }) as any);
                await settle();
            });
        };
        const resolve = async (index: number, text: string) => {
            await act(async () => {
                reads[index](new TextEncoder().encode(text).buffer);
                await settle();
            });
        };
        await choose("A.txt");
        await choose("B.txt");
        await resolve(1, "B正文");
        await resolve(0, "A正文");
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("B正文");
        expect(view.host.querySelector<HTMLInputElement>("[aria-label='集标题']")!.value).toBe("B");
        await choose("C.txt");
        await input(view.host, "本集原文", "手动新正文");
        await resolve(2, "C正文");
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("手动新正文");
    } finally {
        await view.close();
    }
});
