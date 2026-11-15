import { afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { create } from "zustand";
import type { DramaCast, DramaCastKind, DramaEpisodeDetail, DramaSummary } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/projects/p" });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Node: browser.Node, IS_REACT_ACT_ENVIRONMENT: true });
const store = create<{ user: { id: string } }>(() => ({ user: { id: "a" } }));
const requests = new Map<string, ReturnType<typeof deferred<DramaEpisodeDetail>>>();
const batchCalls: string[][] = [];
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
mock.module("@/stores/use-user-store", () => ({ useUserStore: store }));
mock.module("@/services/api/drama", () => ({
    getDramaEpisode: (_project: string, id: string) => {
        const pending = deferred<DramaEpisodeDetail>();
        requests.set(id, pending);
        return pending.promise;
    },
}));
mock.module("@/pages/projects/workflow-batch", () => ({
    WorkflowBatch: ({ targetIds }: { targetIds: string[] }) => {
        batchCalls.push(targetIds);
        return <output aria-label="已选ID">{targetIds.join(",")}</output>;
    },
}));
mock.module("@/pages/projects/drama-shared", () => ({
    parseList: (raw?: string) => {
        try {
            const ids = JSON.parse(raw || "[]");
            return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
        } catch {
            return [];
        }
    },
    MediaThumb: ({ alt }: { alt: string }) => <span>{alt}</span>,
}));
mock.module("antd", () => ({
    Button: ({ children, onClick, disabled, ...props }: any) => (
        <button aria-pressed={props["aria-pressed"]} onClick={onClick} disabled={disabled}>
            {children}
        </button>
    ),
    Select: ({ options, value, onChange, disabled, ...props }: any) => (
        <select aria-label={props["aria-label"]} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
            {options.map((item: any) => (
                <option key={item.value} value={item.value}>
                    {item.label}
                </option>
            ))}
        </select>
    ),
}));
const { WorkflowAssetScope, episodeAssetIds } = await import("@/pages/projects/workflow-asset-scope");
const cast = [
    { id: "base", name: "主角", kind: "character" },
    { id: "look", name: "主角", lookName: "夜行", parentId: "base", kind: "character" },
    { id: "second", name: "配角", kind: "character" },
    { id: "room", name: "客厅", kind: "scene" },
    { id: "key", name: "钥匙", kind: "prop" },
].map((item) => ({ ...item, projectId: "p" })) as DramaCast[];
const summary = {
    project: { id: "p" },
    production: { revision: 1 },
    jobCounts: {},
    episodes: [
        { id: "e1", number: 1, title: "第一集" },
        { id: "e2", number: 2, title: "第二集" },
    ],
} as DramaSummary;
function episode(id: string, refs: string[] = []) {
    return { episode: { id }, shots: [], segments: [{ request: { references: refs.map((castId) => ({ castId })) } }] } as unknown as DramaEpisodeDetail;
}
let root: Root | undefined;
let container: HTMLElement;
let client: QueryClient;
async function settle() {
    await new Promise((done) => setTimeout(done, 20));
}
async function render(kind: DramaCastKind | null = "character", busy = false, options: { episodeId?: string; showToolbar?: boolean; sharedBeforeStoryboard?: boolean; revision?: number } = {}) {
    if (!root) {
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
        client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    }
    const { revision, ...scopeOptions } = options;
    const currentSummary = revision === undefined ? summary : { ...summary, production: { ...summary.production, revision } };
    await act(async () => {
        root!.render(
            <QueryClientProvider client={client}>
                <WorkflowAssetScope summary={currentSummary} cast={cast} kind={kind ?? undefined} busy={busy} {...scopeOptions} onChanged={() => undefined}>
                    {(items, refreshing, sharedCast) => (
                        <>
                            <output aria-label="可见资产" data-refreshing={String(refreshing)}>
                                {items.map((item) => item.id).join(",")}
                            </output>
                            <output aria-label="共享待引用资产">{sharedCast.map((item) => item.id).join(",")}</output>
                        </>
                    )}
                </WorkflowAssetScope>
            </QueryClientProvider>,
        );
        await settle();
    });
}
async function click(text: string) {
    await act(async () => {
        [...container.querySelectorAll("button")].find((button) => button.textContent === text)!.click();
        await settle();
    });
}
async function choose(id: string) {
    await act(async () => {
        const select = container.querySelector("select")!;
        select.value = id;
        select.dispatchEvent(new browser.Event("change", { bubbles: true }));
        await settle();
    });
}
afterEach(async () => {
    await act(async () => {
        root?.unmount();
        await settle();
    });
    root = undefined;
    container?.remove();
    client?.clear();
    requests.clear();
    batchCalls.length = 0;
    store.setState({ user: { id: "a" } });
});
test("本集真实镜头、段的人工引用和造型本体共同决定资产范围", () => {
    const detail = episode("e1", ["key", "look"]);
    detail.shots = [{ castIdsJson: '["second"]', lookCastIdsJson: "[]", propIdsJson: "[]", sceneCastId: "room" }] as any;
    expect([...episodeAssetIds(detail, cast)].sort()).toEqual(["base", "key", "look", "room", "second"]);
});
test("读集失败时展示失败，不回退为全部资产或扩大批选", async () => {
    await render();
    await choose("e1");
    await act(async () => {
        requests.get("e1")!.reject(new Error("offline"));
        await settle();
    });
    expect(container.textContent).toContain("本集引用资产读取失败");
    expect(container.querySelector('[aria-label="可见资产"]')).toBeNull();
    await click("批量选择");
    expect([...container.querySelectorAll("button")].find((item) => item.textContent === "选择当前范围")!.disabled).toBe(true);
});
test("跨集与跨类型选择保留真实ID，只选当前范围不隐式扩大全集", async () => {
    await render();
    await click("批量选择");
    await choose("e1");
    await act(async () => {
        requests.get("e1")!.resolve(episode("e1", ["look"]));
        await settle();
    });
    await click("选择当前范围");
    expect(batchCalls.at(-1)).toEqual(["base", "look"]);
    await choose("e2");
    await act(async () => {
        requests.get("e2")!.resolve(episode("e2", ["second", "room"]));
        await settle();
    });
    await click("选择当前范围");
    await render("scene");
    await click("选择当前范围");
    expect(batchCalls.at(-1)).toEqual(["base", "look", "second", "room"]);
    expect(batchCalls.at(-1)).not.toContain("key");
});
test("旧集迟到响应不能污染当前集范围", async () => {
    await render();
    await choose("e1");
    const old = requests.get("e1")!;
    await choose("e2");
    await act(async () => {
        requests.get("e2")!.resolve(episode("e2", ["second"]));
        old.resolve(episode("e1", ["base"]));
        await settle();
    });
    expect(container.querySelector('[aria-label="可见资产"]')!.textContent).toBe("second");
});
test("切换账号销毁批量选择与集范围", async () => {
    await render();
    await click("批量选择");
    await click("选择当前范围");
    expect(batchCalls.at(-1)!.length).toBe(3);
    await act(async () => {
        store.setState({ user: { id: "b" } });
        await settle();
    });
    expect(container.querySelector("select")!.value).toBe("");
    expect(container.querySelector('[aria-label="已选ID"]')).toBeNull();
    await click("批量选择");
    expect(batchCalls.at(-1)).toEqual([]);
});
test("忙碌时不允许改范围或批选", async () => {
    await render("character", true);
    expect(container.querySelector("select")!.disabled).toBe(true);
    expect([...container.querySelectorAll("button")].find((item) => item.textContent === "批量选择")!.disabled).toBe(true);
});

test("受控单集隐藏全局工具栏，空分镜展示共享主体并明确说明", async () => {
    const options = { episodeId: "e1", showToolbar: false, sharedBeforeStoryboard: true };
    await render(null, false, options);
    expect(container.textContent).toContain("正在读取本集引用资产");
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[aria-label="可见资产"]')).toBeNull();
    await act(async () => {
        requests.get("e1")!.resolve({ episode: { id: "e1" }, shots: [], segments: [] } as unknown as DramaEpisodeDetail);
        await settle();
    });
    expect(container.querySelector('[aria-label="可见资产"]')?.textContent).toBe("base,look,second,room,key");
    expect(container.textContent).toContain("本集尚未编排分镜，展示作品共享主体。");
    expect(batchCalls).toHaveLength(0);
});

test("已有分镜或人工段时仅展示真实引用，空引用不能扩大为共享主体", async () => {
    const options = { episodeId: "e1", showToolbar: false, sharedBeforeStoryboard: true };
    await render(null, false, options);
    await act(async () => {
        requests.get("e1")!.resolve(episode("e1", ["look", "room"]));
        await settle();
    });
    expect(container.querySelector('[aria-label="可见资产"]')?.textContent).toBe("base,look,room");
    expect(container.querySelector('[aria-label="共享待引用资产"]')?.textContent).toBe("second,key");
    expect(container.textContent).not.toContain("展示作品共享主体");
    await render(null, false, { ...options, episodeId: "e2" });
    await act(async () => {
        requests.get("e2")!.resolve(episode("e2"));
        await settle();
    });
    expect(container.querySelector('[aria-label="可见资产"]')?.textContent).toBe("");
    expect(container.querySelector('[aria-label="共享待引用资产"]')?.textContent).toBe("base,look,second,room,key");
    expect(container.textContent).not.toContain("展示作品共享主体");
});

test("共享回退只适用于已成功读取的空集，读取失败和无效集都保持阻断", async () => {
    const options = { episodeId: "e1", showToolbar: false, sharedBeforeStoryboard: true };
    await render(null, false, options);
    await act(async () => {
        requests.get("e1")!.reject(new Error("offline"));
        await settle();
    });
    expect(container.textContent).toContain("本集引用资产读取失败");
    expect(container.querySelector('[aria-label="可见资产"]')).toBeNull();
    expect(container.textContent).not.toContain("展示作品共享主体");
    await render(null, false, { ...options, episodeId: "removed" });
    expect(container.textContent).toContain("本集已移除");
    expect(container.querySelector('[aria-label="可见资产"]')).toBeNull();
    expect(requests.has("removed")).toBe(false);
});

test("受控切集时旧集的空分镜迟到响应不能把当前引用范围扩大为共享池", async () => {
    const options = { episodeId: "e1", showToolbar: false, sharedBeforeStoryboard: true };
    await render(null, false, options);
    const old = requests.get("e1")!;
    await render(null, false, { ...options, episodeId: "e2" });
    await act(async () => {
        requests.get("e2")!.resolve(episode("e2", ["key"]));
        old.resolve({ episode: { id: "e1" }, shots: [], segments: [] } as unknown as DramaEpisodeDetail);
        await settle();
    });
    expect(container.querySelector('[aria-label="可见资产"]')?.textContent).toBe("key");
    expect(container.textContent).not.toContain("展示作品共享主体");
});

test("同集版本刷新与失败保留已挂载列表并回报只读状态，重试成功后恢复", async () => {
    const options = { episodeId: "e1", showToolbar: false, sharedBeforeStoryboard: true };
    await render(null, false, options);
    await act(async () => {
        requests.get("e1")!.resolve(episode("e1", ["look"]));
        await settle();
    });
    const retained = container.querySelector('[aria-label="可见资产"]')!;
    expect(retained.textContent).toBe("base,look");
    expect(retained.getAttribute("data-refreshing")).toBe("false");
    await render(null, false, { ...options, revision: 2 });
    expect(container.querySelector('[aria-label="可见资产"]')).toBe(retained);
    expect(retained.textContent).toBe("base,look");
    expect(retained.getAttribute("data-refreshing")).toBe("true");
    await act(async () => {
        requests.get("e1")!.reject(new Error("offline"));
        await settle();
    });
    expect(container.textContent).toContain("本集引用资产刷新失败，已保留列表");
    expect(container.querySelector('[aria-label="可见资产"]')).toBe(retained);
    expect(retained.getAttribute("data-refreshing")).toBe("true");
    await click("重试");
    expect(container.querySelector('[aria-label="可见资产"]')).toBe(retained);
    await act(async () => {
        requests.get("e1")!.resolve(episode("e1", ["second"]));
        await settle();
    });
    expect(container.querySelector('[aria-label="可见资产"]')).toBe(retained);
    expect(retained.textContent).toBe("second");
    expect(retained.getAttribute("data-refreshing")).toBe("false");
    expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("跨集读取失败不继承上一集已读取的引用列表", async () => {
    const options = { episodeId: "e1", showToolbar: false, sharedBeforeStoryboard: true };
    await render(null, false, options);
    await act(async () => {
        requests.get("e1")!.resolve(episode("e1", ["look", "room"]));
        await settle();
    });
    expect(container.querySelector('[aria-label="可见资产"]')?.textContent).toBe("base,look,room");
    await render(null, false, { ...options, episodeId: "e2", revision: 2 });
    expect(container.querySelector('[aria-label="可见资产"]')).toBeNull();
    await act(async () => {
        requests.get("e2")!.reject(new Error("offline"));
        await settle();
    });
    expect(container.textContent).toContain("本集引用资产读取失败");
    expect(container.querySelector('[aria-label="可见资产"]')).toBeNull();
    expect(container.textContent).not.toContain("base,look,room");
    expect(container.textContent).not.toContain("展示作品共享主体");
});
