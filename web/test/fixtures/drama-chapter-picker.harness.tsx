import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaChapterRef, DramaSummary } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/projects/project/guide" });
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
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { environmentManager } = await import("@tanstack/query-core");
environmentManager.setIsServer(() => false);
const userStore = create(() => ({ user: { id: "user" } }));
const calls: Array<{ projectId: string; input: { chapterIds: string[]; chaptersPerEpisode: number; expectedRevision: number } }> = [];
const produced: string[][] = [];
const dirtyStates: Array<[boolean, boolean | undefined]> = [];
const confirms: Array<{ onOk: () => void }> = [];
let closes = 0;
let outline: DramaChapterRef[] = [];
let outlineFails = false;
let previewFails = false;
let summaryRead: Promise<DramaSummary> | undefined;
let currentSummary: DramaSummary;
let resolveWrite!: (value: { episodeIds: string[]; revision: number }) => void;
let rejectWrite!: (error: Error) => void;
mock.module("@/stores/use-user-store", () => ({ useUserStore: userStore }));
mock.module("@/pages/projects/drama-shared", () => ({ formatCount: (value: number) => String(value) }));
mock.module("@/components/ui/product/app-modal", () => ({ AppModal: ({ children }: { children: ReactNode }) => <section role="dialog">{children}</section> }));
mock.module("antd", () => ({
    App: {
        useApp: () => ({
            message: { success: () => undefined },
            modal: {
                confirm: (options: { onOk: () => void }) => {
                    confirms.push(options);
                    return { destroy: () => undefined };
                },
            },
        }),
    },
    Button: ({ children, type: _type, loading: _loading, icon: _icon, ...props }: Record<string, any>) => createElement("button", props, children),
    InputNumber: ({ onChange, size: _size, ...props }: Record<string, any>) => createElement("input", { type: "number", ...props, onInput: (event: any) => onChange(Number(event.target.value)) }),
}));
mock.module("@/pages/projects/chapter-pick-list", () => ({
    ChapterPickList: ({ items, selected, onChange, onPreview }: any) => (
        <div>
            {items.map((item: any, index: number) => (
                <label key={item.key}>
                    <input
                        type="checkbox"
                        aria-label={`选择 ${item.title}`}
                        checked={selected.has(index)}
                        disabled={item.disabled}
                        onChange={(event) => {
                            const next = new Set<number>(selected);
                            if (event.target.checked) next.add(index);
                            else next.delete(index);
                            onChange(next);
                        }}
                    />
                    <button onClick={() => onPreview(index)}>{item.title}</button>
                    <span>{item.note}</span>
                </label>
            ))}
        </div>
    ),
}));
mock.module("@/services/api/drama", () => ({
    listDramaChapters: async () => {
        if (outlineFails) throw new Error("目录读取失败");
        return { chapters: outline };
    },
    getDramaChapter: async (_projectId: string, id: string) => {
        if (previewFails) throw new Error("原文读取失败");
        return { chapter: { id, sourceText: `正文${id}` } };
    },
    getDrama: async () => summaryRead || currentSummary,
    produceDramaChapters: (projectId: string, input: any) => {
        calls.push({ projectId, input });
        return new Promise((resolve, reject) => {
            resolveWrite = resolve;
            rejectWrite = reject;
        });
    },
}));
const { ChapterPickerModal } = await import("@/pages/projects/studio/chapter-picker");
afterAll(() => browser.happyDOM.abort());
function reset() {
    calls.length = produced.length = dirtyStates.length = confirms.length = closes = 0;
    userStore.setState({ user: { id: "user" } });
    browser.localStorage.setItem("yingce:active-user-scope", "user");
    outlineFails = false;
    previewFails = false;
    summaryRead = undefined;
    currentSummary = { project: { id: "project", sourceType: "novel" }, production: { revision: 4, planDone: true, guideStep: "story", settings: { chaptersPerEpisode: 1 } }, episodes: [{ id: "episode", number: 1, title: "序章" }] } as DramaSummary;
    outline = Array.from({ length: 9 }, (_, index) => ({ id: `c${index}`, title: index ? `第${index}集` : "序章", position: index, wordCount: 1000, reserved: index > 0, episodeNumber: index ? undefined : 1 }));
}
async function settle() {
    for (let i = 0; i < 5; i++) await Bun.sleep(4);
}
async function mount() {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
    let summary = currentSummary;
    const render = async (next = summary, busy = false) => {
        summary = next;
        await act(async () => {
            root.render(
                <QueryClientProvider client={client}>
                    <ChapterPickerModal open summary={summary} busy={busy} onClose={() => closes++} onProduced={(ids) => produced.push(ids)} onDirtyChange={(dirty, working) => dirtyStates.push([dirty, working])} />
                </QueryClientProvider>,
            );
            await settle();
        });
        await act(async () => {
            await settle();
        });
    };
    await render();
    return {
        host,
        client,
        render,
        close: async () => {
            await act(async () => {
                root.unmount();
                client.clear();
                host.remove();
                await settle();
            });
        },
    };
}
function button(host: HTMLElement, label: string) {
    const value = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label || item.getAttribute("aria-label") === label);
    if (!value) throw new Error(`Missing ${label}`);
    return value;
}
async function click(element: HTMLElement) {
    await act(async () => {
        element.click();
        await settle();
    });
    await act(async () => {
        await settle();
    });
}
async function pick(host: HTMLElement, index: number) {
    await click(host.querySelector<HTMLElement>(`[aria-label='选择 第${index}集']`)!);
}
async function finish(value: { episodeIds: string[]; revision: number }) {
    await act(async () => {
        resolveWrite(value);
        await settle();
    });
}

test("9章1集显示8章待加入，默认零选择，按真实章ID和版本提交且防同帧双击", async () => {
    reset();
    const view = await mount();
    try {
        expect(view.host.textContent).toContain("原文 9 章 · 已建 1 集 · 待加入 8 章");
        expect(button(view.host, "加入制作").disabled).toBe(true);
        expect(view.host.querySelector<HTMLInputElement>("[aria-label='选择 序章']")!.disabled).toBe(true);
        await pick(view.host, 1);
        await pick(view.host, 2);
        await act(async () => {
            button(view.host, "加入制作").click();
            button(view.host, "加入制作").click();
            button(view.host, "关闭选章").click();
            await settle();
        });
        expect(calls).toEqual([{ projectId: "project", input: { chapterIds: ["c1", "c2"], chaptersPerEpisode: 1, expectedRevision: 4 } }]);
        expect(closes).toBe(0);
        await finish({ episodeIds: ["e2", "e3"], revision: 5 });
        expect(produced).toEqual([["e2", "e3"]]);
    } finally {
        await view.close();
    }
});

test("版本变化保留选择，重新载入过滤已加入章节并使用新版本", async () => {
    reset();
    const view = await mount();
    try {
        await pick(view.host, 1);
        await pick(view.host, 2);
        currentSummary = { ...currentSummary, production: { ...currentSummary.production, revision: 5 } };
        await view.render(currentSummary);
        expect(button(view.host, "加入制作").disabled).toBe(true);
        outline = outline.map((chapter) => (chapter.id === "c1" ? { ...chapter, reserved: false, episodeNumber: 2 } : chapter));
        await click(button(view.host, "重新载入"));
        expect(view.host.querySelector<HTMLInputElement>("[aria-label='选择 第1集']")!.checked).toBe(false);
        expect(view.host.querySelector<HTMLInputElement>("[aria-label='选择 第2集']")!.checked).toBe(true);
        await click(button(view.host, "加入制作"));
        expect(calls[0].input).toEqual({ chapterIds: ["c2"], chaptersPerEpisode: 1, expectedRevision: 5 });
        await finish({ episodeIds: ["e3"], revision: 6 });
    } finally {
        await view.close();
    }
});

test("提交结果不确定时禁止重发，重新载入已加入结果后不再重复添加", async () => {
    reset();
    const view = await mount();
    try {
        await pick(view.host, 1);
        await click(button(view.host, "加入制作"));
        await act(async () => {
            rejectWrite(new Error("网络中断"));
            await settle();
        });
        expect(view.host.textContent).toContain("网络中断");
        await click(button(view.host, "加入制作"));
        expect(calls).toHaveLength(1);
        outline = outline.map((chapter) => (chapter.id === "c1" ? { ...chapter, reserved: false, episodeNumber: 2 } : chapter));
        currentSummary = { ...currentSummary, production: { ...currentSummary.production, revision: 5 } };
        await click(button(view.host, "重新载入"));
        await view.render(currentSummary);
        expect(button(view.host, "加入制作").disabled).toBe(true);
        expect(calls).toHaveLength(1);
    } finally {
        await view.close();
    }
});

test("账号切换后迟到的成功回执不通知新会话", async () => {
    reset();
    const view = await mount();
    try {
        await pick(view.host, 1);
        await click(button(view.host, "加入制作"));
        await act(async () => {
            browser.localStorage.setItem("yingce:active-user-scope", "other");
            userStore.setState({ user: { id: "other" } });
            await settle();
        });
        await finish({ episodeIds: ["old-episode"], revision: 5 });
        expect(produced).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("切换作品后旧请求不影响新作品且不沿用选择", async () => {
    reset();
    const view = await mount();
    try {
        await pick(view.host, 1);
        await click(button(view.host, "加入制作"));
        await view.render({ ...currentSummary, project: { ...currentSummary.project, id: "other-project" } });
        await finish({ episodeIds: ["old-episode"], revision: 5 });
        expect(produced).toHaveLength(0);
        expect(button(view.host, "加入制作").disabled).toBe(true);
    } finally {
        await view.close();
    }
});

test("配置中和未完成规划不能追加，剧本按每章一集展示", async () => {
    reset();
    currentSummary = { ...currentSummary, project: { ...currentSummary.project, sourceType: "script" }, production: { ...currentSummary.production, guideStep: "configuring", settings: { ...currentSummary.production.settings, chaptersPerEpisode: 5 } } };
    const view = await mount();
    try {
        await pick(view.host, 1);
        expect(view.host.textContent).toContain("每章一集");
        expect(view.host.querySelector("[aria-label='每集章数']")).toBeNull();
        expect(button(view.host, "加入制作").disabled).toBe(true);
        await view.render({ ...currentSummary, production: { ...currentSummary.production, guideStep: "story", planDone: false } });
        expect(view.host.textContent).toContain("前面的章节还在分集规划");
        expect(button(view.host, "加入制作").disabled).toBe(true);
        expect(calls).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("关闭有选择时确认放弃，外部忙碌禁止提交且离开清理dirty", async () => {
    reset();
    const view = await mount();
    await pick(view.host, 1);
    await click(button(view.host, "取消"));
    expect(closes).toBe(0);
    expect(confirms).toHaveLength(1);
    await view.render(currentSummary, true);
    await click(button(view.host, "加入制作"));
    expect(calls).toHaveLength(0);
    expect(dirtyStates.some(([dirty]) => dirty)).toBe(true);
    await view.close();
    expect(dirtyStates.at(-1)).toEqual([false, false]);
});

test("目录读取失败不能提交，重新载入后恢复并允许修正过大的分组", async () => {
    reset();
    outlineFails = true;
    const view = await mount();
    try {
        expect(view.host.textContent).toContain("目录读取失败");
        expect(button(view.host, "加入制作").disabled).toBe(true);
        outlineFails = false;
        outline = outline.map((chapter) => ({ ...chapter, wordCount: 11000 }));
        await click(button(view.host, "重新载入"));
        await pick(view.host, 1);
        await pick(view.host, 2);
        await pick(view.host, 3);
        await pick(view.host, 4);
        const input = view.host.querySelector<HTMLInputElement>("[aria-label='每集章数']")!;
        await act(async () => {
            input.value = "4";
            input.dispatchEvent(new browser.Event("input", { bubbles: true }));
            await settle();
        });
        expect(button(view.host, "加入制作").disabled).toBe(true);
        expect(input.disabled).toBe(false);
        await act(async () => {
            input.value = "1";
            input.dispatchEvent(new browser.Event("input", { bubbles: true }));
            await settle();
        });
        expect(button(view.host, "加入制作").disabled).toBe(false);
    } finally {
        await view.close();
    }
});

test("原文读取失败后同一版本重新载入会真正重试原文", async () => {
    reset();
    previewFails = true;
    const view = await mount();
    try {
        expect(view.host.textContent).toContain("原文读取失败");
        previewFails = false;
        await click(button(view.host, "重新载入"));
        await act(async () => {
            await settle();
        });
        expect(view.host.textContent).toContain("正文c1");
        expect(view.host.textContent).not.toContain("原文读取失败");
    } finally {
        await view.close();
    }
});

test("迟到的关闭确认不能关闭其他作品或绕过忙碌保护", async () => {
    for (const switchProject of [true, false]) {
        reset();
        const view = await mount();
        try {
            await pick(view.host, 1);
            await click(button(view.host, "取消"));
            const confirm = confirms[0];
            await view.render(switchProject ? { ...currentSummary, project: { ...currentSummary.project, id: "other-project" } } : currentSummary, !switchProject);
            await act(async () => {
                confirm.onOk();
                await settle();
            });
            expect(closes).toBe(0);
            expect(view.host.querySelector("[role='dialog']")).toBeTruthy();
        } finally {
            await view.close();
        }
    }
});

test("重新载入的旧版本晚到不会覆盖已刷新的摘要", async () => {
    reset();
    const view = await mount();
    try {
        await pick(view.host, 1);
        let resolveSummary!: (value: DramaSummary) => void;
        summaryRead = new Promise((resolve) => {
            resolveSummary = resolve;
        });
        await click(button(view.host, "重新载入"));
        const newer = { ...currentSummary, production: { ...currentSummary.production, revision: 6 } };
        view.client.setQueryData(["drama", "project"], newer);
        await view.render(newer);
        await act(async () => {
            resolveSummary({ ...currentSummary, production: { ...currentSummary.production, revision: 5 } });
            await settle();
        });
        expect(view.client.getQueryData<DramaSummary>(["drama", "project"])?.production.revision).toBe(6);
        expect(view.host.textContent).toContain("载入期间内容再次更新");
        expect(button(view.host, "加入制作").disabled).toBe(true);
    } finally {
        await view.close();
    }
});
