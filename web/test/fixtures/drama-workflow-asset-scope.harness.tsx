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
async function render(kind: DramaCastKind = "character", busy = false) {
    if (!root) {
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
        client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    }
    await act(async () => {
        root!.render(
            <QueryClientProvider client={client}>
                <WorkflowAssetScope summary={summary} cast={cast} kind={kind} busy={busy} onChanged={() => undefined}>
                    {(items) => <output aria-label="可见资产">{items.map((item) => item.id).join(",")}</output>}
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
