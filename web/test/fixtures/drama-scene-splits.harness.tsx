import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaEpisodeDetail, DramaShot, DramaSummary } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/projects/project-a?step=story" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    Element: browser.Element,
    Node: browser.Node,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { environmentManager } = await import("@tanstack/query-core");
environmentManager.setIsServer(() => false);
function deferred<T = any>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { resolve, reject, promise };
}
const store = create(() => ({ user: { id: "user-a" } }));
const notices: string[] = [];
const confirms: Array<{ onOk: () => unknown }> = [];
const writes: Array<{ kind: string; projectId: string; episodeId: string; input: Record<string, any>; pending: ReturnType<typeof deferred> }> = [];
let history: any[] = [];
const pendingStorage = new Map<string, string>();
mock.module("@/lib/localforage-storage", () => ({
    localForageStorageForScope: (scope: string) => ({
        getItem: async (key: string) => pendingStorage.get(`${scope}:${key}`),
        setItem: async (key: string, value: string) => {
            pendingStorage.set(`${scope}:${key}`, value);
        },
        removeItem: async (key: string) => {
            pendingStorage.delete(`${scope}:${key}`);
        },
    }),
}));
mock.module("@/stores/use-user-store", () => ({ useUserStore: store }));
mock.module("@/pages/projects/drama-shared", () => ({ formatCredits: (value: number) => String(value), useResourceMediaUrl: (id: string) => `/resources/${id}` }));
mock.module("@/services/api/drama-shot-media", () => ({ getDramaShotMedia: async () => ({ status: "idle" }) }));
mock.module("@/components/ui/product/app-modal", () => ({ AppModal: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? createElement("div", { role: "dialog" }, children) : null) }));
mock.module("antd", () => ({
    App: { useApp: () => ({ message: { success: (value: string) => notices.push(value) }, modal: { confirm: (value: { onOk: () => unknown }) => confirms.push(value) } }) },
    Button: ({ children, type: _type, size: _size, loading: _loading, ...props }: Record<string, any>) => createElement("button", props, children),
    Input: { TextArea: (props: Record<string, any>) => createElement("textarea", props) },
    InputNumber: ({ onChange, ...props }: Record<string, any>) => createElement("input", { ...props, type: "number", onChange: (event: any) => onChange(Number(event.target.value)) }),
    Select: ({ options, onChange, ...props }: Record<string, any>) =>
        createElement(
            "select",
            { ...props, onChange: (event: any) => onChange(event.target.value) },
            options.map((option: any) => createElement("option", { key: option.value, value: option.value }, option.label)),
        ),
}));
function shot(id: string, scene: string, position: number, segmentIndex = 0): DramaShot {
    return { id, scene, position, segmentIndex, sceneCastId: scene, projectId: "project-a", episodeId: "episode-a", durationMs: 2000, action: "走向门口" } as DramaShot;
}
function write(kind: string, projectId: string, episodeId: string, input: Record<string, any>) {
    const pending = deferred();
    writes.push({ kind, projectId, episodeId, input: structuredClone(input), pending });
    return pending.promise;
}
mock.module("@/services/api/drama-scene-split", () => ({
    getDramaSceneSplits: async () => history,
    preflightDramaSceneSplit: (p: string, e: string, input: Record<string, any>) => write("preflight", p, e, input),
    executeDramaSceneSplit: (p: string, e: string, input: Record<string, any>) => write("execute", p, e, input),
    adoptDramaSceneSplit: (p: string, e: string, input: Record<string, any>) => write("adopt", p, e, input),
}));
const { WorkflowSceneSplits } = await import("@/pages/projects/workflow-scene-splits");
afterAll(() => {
    browser.happyDOM.abort();
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});
function reset() {
    pendingStorage.clear();
    writes.length = notices.length = confirms.length = 0;
    history = [];
    store.setState({ user: { id: "user-a" } });
    browser.localStorage.setItem("yingce:active-user-scope", "user-a");
}
async function settle() {
    for (let i = 0; i < 4; i++) await Bun.sleep(5);
}
const initialSummary = () =>
    ({ project: { id: "project-a" }, production: { revision: 8, settings: { storyboard: { directorTemplate: "smart_drama" }, models: { text: { logicalModelId: "text-main" }, scriptText: { logicalModelId: "script-model" } } } } }) as DramaSummary;
const initialDetail = () => ({ episode: { id: "episode-a", number: 1, revision: 4 }, shots: [shot("a1", "卧室", 0), shot("a2", "卧室", 1), shot("b1", "院子", 2, 1)], segments: [] }) as unknown as DramaEpisodeDetail;
async function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let summary = initialSummary();
    let detail = initialDetail();
    let disposed = false;
    let changed = 0;
    const update = async (next?: DramaSummary, nextDetail?: DramaEpisodeDetail) => {
        if (next) summary = next;
        if (nextDetail) detail = nextDetail;
        await act(async () => {
            root.render(createElement(QueryClientProvider, { client }, createElement(WorkflowSceneSplits, { summary, detail, onChanged: () => changed++, onOpenSegment: () => {} })));
            await settle();
        });
    };
    await update();
    return {
        container,
        update,
        get changed() {
            return changed;
        },
        dispose: async () => {
            if (disposed) return;
            disposed = true;
            await act(async () => {
                root.unmount();
                client.clear();
                container.remove();
                await settle();
            });
        },
    };
}
function button(container: HTMLElement, label: string) {
    const found = Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.trim() === label);
    if (!found) throw new Error(`未找到按钮${label}: ${container.textContent}`);
    return found as HTMLButtonElement;
}
async function click(node: HTMLElement) {
    await act(async () => {
        node.click();
        await settle();
    });
}
async function resolveWrite(value: unknown) {
    await act(async () => {
        writes.at(-1)!.pending.resolve(value);
        await settle();
    });
}
const quote = { ready: true, priced: true, estimated: true, amountMicrocredits: 100, confirmationToken: "quote-current" };
const completed = () => ({ takeId: "take-scene", taskId: "task-scene", shotIds: ["a1", "a2"], status: "succeeded", progress: 100, text: '{"shots":[{"scene":"卧室"}]}', stale: false, applied: false });

test("显示实际连续场景与镜头，预检只使用当前组和真实模型", async () => {
    reset();
    const fixture = await mount();
    try {
        await click(button(fixture.container, "场景分镜"));
        expect(fixture.container.textContent).toContain("2 个连续场景组");
        await click(button(fixture.container, "预检重拆"));
        expect(writes[0].input).toEqual({ expectedRevision: 8, episodeRevision: 4, shotIds: ["a1", "a2"], targetShotCount: 2, directorTemplate: "smart_drama", instruction: "", model: { logicalModelId: "script-model" } });
        expect(writes).toHaveLength(1);
    } finally {
        await fixture.dispose();
    }
});

test("报价确认只提交一次，成功文字仍需用户采用", async () => {
    reset();
    const fixture = await mount();
    try {
        await click(button(fixture.container, "场景分镜"));
        await click(button(fixture.container, "预检重拆"));
        await resolveWrite(quote);
        const submit = button(fixture.container, "确认并生成文字方案");
        await act(async () => {
            submit.click();
            submit.click();
            await settle();
        });
        expect(writes).toHaveLength(2);
        expect(writes[1].kind).toBe("execute");
        expect(writes[1].input.confirmationToken).toBe("quote-current");
        expect(writes[1].input.clientOperationId).toBeTruthy();
        history = [completed()];
        await resolveWrite({ id: "task-scene" });
        expect(fixture.changed).toBe(0);
        expect(writes.filter((row) => row.kind === "adopt")).toHaveLength(0);
        await click(button(fixture.container, "采用此方案"));
        expect(confirms).toHaveLength(1);
        await act(async () => {
            void confirms[0].onOk();
            await settle();
        });
        expect(writes.at(-1)!.kind).toBe("adopt");
        expect(writes.at(-1)!.input).toEqual({ expectedRevision: 8, episodeRevision: 4, takeId: "take-scene" });
        await resolveWrite(initialSummary());
        expect(fixture.changed).toBe(1);
    } finally {
        await fixture.dispose();
    }
});

test("未知提交回执冻结新报价，重开后复用原请求标识核对", async () => {
    reset();
    const fixture = await mount();
    let replay: Awaited<ReturnType<typeof mount>> | undefined;
    try {
        await click(button(fixture.container, "场景分镜"));
        await click(button(fixture.container, "预检重拆"));
        await resolveWrite(quote);
        await click(button(fixture.container, "确认并生成文字方案"));
        const original = structuredClone(writes.at(-1)!.input);
        await act(async () => {
            writes.at(-1)!.pending.reject(new Error("网络连接中断，回执未知"));
            await settle();
        });
        expect(button(fixture.container, "预检重拆").disabled).toBe(true);
        expect(fixture.container.querySelector('textarea[aria-label="场景重拆要求"]')?.hasAttribute("disabled")).toBe(true);
        expect(fixture.container.textContent).toContain("核对重拆提交结果");
        await fixture.dispose();
        replay = await mount();
        await click(button(replay.container, "场景分镜"));
        expect(button(replay.container, "预检重拆").disabled).toBe(true);
        await click(button(replay.container, "核对重拆提交结果"));
        expect(writes.at(-1)!.kind).toBe("execute");
        expect(writes.at(-1)!.input).toEqual(original);
        await resolveWrite({ id: "original-task" });
        expect(replay.container.textContent).not.toContain("核对重拆提交结果");
        expect(pendingStorage.size).toBe(0);
    } finally {
        await fixture.dispose();
        await replay?.dispose();
    }
});

test("配置改变清除旧报价，作品版本改变阻止旧方案采用", async () => {
    reset();
    history = [completed()];
    const fixture = await mount();
    try {
        await click(button(fixture.container, "场景分镜"));
        await click(button(fixture.container, "预检重拆"));
        await resolveWrite(quote);
        const input = fixture.container.querySelector('textarea[aria-label="场景重拆要求"]') as HTMLTextAreaElement;
        await act(async () => {
            Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!.call(input, "增加反应镜头");
            input.dispatchEvent(new browser.Event("input", { bubbles: true }));
            input.dispatchEvent(new browser.Event("change", { bubbles: true }));
            await settle();
        });
        expect(fixture.container.textContent).not.toContain("确认并生成文字方案");
        const next = initialSummary();
        next.production.revision = 9;
        await fixture.update(next);
        expect(button(fixture.container, "采用此方案").disabled).toBe(true);
        expect(fixture.container.textContent).toContain("作品或分镜已有更新");
    } finally {
        await fixture.dispose();
    }
});

for (const lifecycle of ["account", "scope", "project", "unmount"]) {
    test(`预检晚到回执隔离${lifecycle}`, async () => {
        reset();
        const fixture = await mount();
        try {
            await click(button(fixture.container, "场景分镜"));
            await click(button(fixture.container, "预检重拆"));
            if (lifecycle === "account")
                await act(async () => {
                    browser.localStorage.setItem("yingce:active-user-scope", "user-b");
                    store.setState({ user: { id: "user-b" } });
                    await settle();
                });
            if (lifecycle === "scope") browser.localStorage.setItem("yingce:active-user-scope", "other-scope");
            if (lifecycle === "project") {
                const next = initialSummary();
                next.project.id = "project-b";
                await fixture.update(next);
            }
            if (lifecycle === "unmount") await fixture.dispose();
            await resolveWrite(quote);
            expect(fixture.container.textContent).not.toContain("确认并生成文字方案");
            expect(notices).toHaveLength(0);
            expect(fixture.changed).toBe(0);
        } finally {
            await fixture.dispose();
        }
    });
}

test("异常模型输出不能采用，带代码围栏的完整方案可审阅", async () => {
    reset();
    history = [{ ...completed(), text: '```json\n{"shots":[{"action":"走向门口","camera":"推镜头"}]}\n```' }];
    const fixture = await mount();
    try {
        await click(button(fixture.container, "场景分镜"));
        expect(fixture.container.textContent).toContain("走向门口");
        expect(button(fixture.container, "采用此方案").disabled).toBe(false);
        history = [{ ...completed(), text: '{"shots":[{"action":{"bad":true}}]}' }];
        await click(button(fixture.container, "刷新方案"));
        expect(button(fixture.container, "采用此方案").disabled).toBe(true);
        expect(fixture.container.textContent).toContain("未返回可展示的完整镜头");
    } finally {
        await fixture.dispose();
    }
});

for (const kind of ["execute", "adopt"] as const) {
    test(`${kind}晚到回执隔离账号scope作品与卸载`, async () => {
        for (const lifecycle of ["account", "scope", "project", "unmount"]) {
            reset();
            if (kind === "adopt") history = [completed()];
            const fixture = await mount();
            try {
                await click(button(fixture.container, "场景分镜"));
                if (kind === "execute") {
                    await click(button(fixture.container, "预检重拆"));
                    await resolveWrite(quote);
                    await click(button(fixture.container, "确认并生成文字方案"));
                } else {
                    await click(button(fixture.container, "采用此方案"));
                    await act(async () => {
                        void confirms[0].onOk();
                        await settle();
                    });
                }
                if (lifecycle === "account")
                    await act(async () => {
                        browser.localStorage.setItem("yingce:active-user-scope", "user-b");
                        store.setState({ user: { id: "user-b" } });
                        await settle();
                    });
                if (lifecycle === "scope") browser.localStorage.setItem("yingce:active-user-scope", "other-scope");
                if (lifecycle === "project") {
                    const next = initialSummary();
                    next.project.id = "project-b";
                    await fixture.update(next);
                }
                if (lifecycle === "unmount") await fixture.dispose();
                await resolveWrite(kind === "execute" ? { id: "task-late" } : initialSummary());
                expect(fixture.changed, `${kind}:${lifecycle}`).toBe(0);
                expect(notices, `${kind}:${lifecycle}`).toHaveLength(0);
            } finally {
                await fixture.dispose();
            }
        }
    });
}
