import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaCast } from "@/services/api/drama";
import type { CastView, CastViewAction, CastViewConfig } from "@/services/api/drama-cast-views";

const browser = new Window({ url: "http://localhost/projects/project-a" });
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
}))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const userStore = create(() => ({ user: { id: "user-a" } }));
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
    let resolve!: Deferred<T>["resolve"];
    let reject!: Deferred<T>["reject"];
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
const storage = new Map<string, string>();
const checks: { viewId: string; action: CastViewAction }[] = [];
const executions: { viewId: string; action: CastViewAction; result: Deferred<unknown> }[] = [];
const saves: { viewId?: string; input: { expectedRevision: number; expectedCastRevision: number; viewRevision: number; config: CastViewConfig } }[] = [];
const adoptions: { viewId: string; input: { expectedRevision: number; viewRevision: number; takeId: string } }[] = [];
const deletions: string[] = [];
let confirmations: { onOk: () => unknown }[] = [];
let rows: CastView[] = [];
let revision = 3;
let changed = 0;
const Input = Object.assign(({ onChange, ...props }: Record<string, unknown>) => createElement("input", { ...props, onInput: onChange }), {
    TextArea: ({ onChange, ...props }: Record<string, unknown>) => createElement("textarea", { ...props, onInput: onChange }),
});
mock.module("antd", () => ({
    App: {
        useApp: () => ({
            modal: {
                confirm: (props: { onOk: () => unknown }) => {
                    confirmations.push(props);
                },
            },
        }),
    },
    Button: ({ children, loading: _loading, type: _type, size: _size, icon: _icon, danger: _danger, ...props }: Record<string, unknown>) => createElement("button", props, children as ReactNode),
    Input,
    Select: ({ options, onChange, ...props }: { options: { value: string; label: string }[]; onChange: (value: string) => void }) =>
        createElement(
            "select",
            { ...props, onChange: (event: { target: { value: string } }) => onChange(event.target.value) },
            options.map((option) => createElement("option", { key: option.value, value: option.value }, option.label)),
        ),
}));
mock.module("@/components/ui/product/app-modal", () => ({
    AppModal: ({ title, children, onCancel, closable }: { title: string; children: ReactNode; onCancel: () => void; closable: boolean }) => (
        <section role="dialog" aria-label={title}>
            <button disabled={!closable} onClick={onCancel}>
                关闭{title}
            </button>
            {children}
        </section>
    ),
}));
mock.module("@/pages/projects/drama-model-picker", () => ({
    DramaModelPicker: ({ onChange }: { onChange: (choice: unknown) => void }) => <button onClick={() => onChange({ channelId: "system", modelKey: "image-new" })}>选择视图模型</button>,
    useDramaModelCatalog: () => ({ data: { options: { image: [{ choice: { channelId: "system", modelKey: "image-new" }, imageRatios: ["9:16", "1:1"], imageResolutions: ["1K", "2K"] }] } } }),
}));
mock.module("@/pages/projects/drama-shared", () => ({ MediaThumb: ({ resourceId, alt }: { resourceId: string; alt: string }) => <img data-resource={resourceId} alt={alt} /> }));
mock.module("@/pages/projects/studio/cast-library-picker", () => ({
    CastLibraryPicker: ({ referenceGroup, onPick, onClose }: { referenceGroup: string; onPick: (id: string) => Promise<void>; onClose: () => void }) => (
        <button onClick={() => void onPick(`chosen-${referenceGroup}`).then(onClose)}>选择{referenceGroup}图片</button>
    ),
}));
mock.module("@/pages/projects/studio/cast-image-options", () => ({ readCastImageOptions: () => ({ model: {}, ratio: "", resolution: "", subjectReferenceIds: ["inherited-subject"], styleReferenceIds: ["inherited-style"] }) }));
mock.module("@/stores/use-user-store", () => ({ useUserStore: userStore }));
const scope = await import("@/lib/user-scope");
mock.module("@/lib/user-scope", () => ({ ...scope, getActiveUserScope: () => userStore.getState().user.id }));
mock.module("@/lib/localforage-storage", () => ({
    localForageStorageForScope: (id: string) => ({
        getItem: async (key: string) => storage.get(`${id}:${key}`) || null,
        setItem: async (key: string, value: string) => {
            storage.set(`${id}:${key}`, value);
        },
        removeItem: async (key: string) => {
            storage.delete(`${id}:${key}`);
        },
    }),
}));
mock.module("@/services/api/drama", () => ({ getDrama: async () => ({ project: { id: "project-a", userId: userStore.getState().user.id }, production: { revision, settings: { models: { image: { channelId: "system", modelKey: "image-new" } } } } }) }));
mock.module("@/services/api/drama-cast-views", () => ({
    listDramaCastViews: async () => ({ views: structuredClone(rows) }),
    saveDramaCastView: async (_projectId: string, _castId: string, viewId: string | undefined, input: { expectedRevision: number; expectedCastRevision: number; viewRevision: number; config: CastViewConfig }) => {
        saves.push({ viewId, input: structuredClone(input) });
        const saved = view({ id: viewId || "created-view", revision: input.viewRevision + 1, config: structuredClone(input.config) });
        rows = [...rows.filter((row) => row.id !== saved.id), saved];
        revision++;
        return saved;
    },
    preflightDramaCastView: async (_projectId: string, _castId: string, viewId: string, action: CastViewAction) => {
        checks.push({ viewId, action });
        return { revision, viewRevision: rows.find((row) => row.id === viewId)!.revision, ready: true, priced: true, estimated: false, amountMicrocredits: 50, confirmationToken: "view-quote" };
    },
    executeDramaCastView: (_projectId: string, _castId: string, viewId: string, action: CastViewAction) => {
        const item = { viewId, action: structuredClone(action), result: deferred<unknown>() };
        executions.push(item);
        return item.result.promise;
    },
    adoptDramaCastView: async (_projectId: string, _castId: string, viewId: string, input: { expectedRevision: number; viewRevision: number; takeId: string }) => {
        adoptions.push({ viewId, input });
        revision++;
        return view();
    },
    deleteDramaCastView: async (_projectId: string, _castId: string, viewId: string) => {
        deletions.push(viewId);
        rows = rows.filter((row) => row.id !== viewId);
        revision++;
        return { deleted: true };
    },
}));
const { CastViews } = await import("@/pages/projects/studio/cast-views");
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
function view(value: Partial<CastView> = {}): CastView {
    return { id: "view-a", projectId: "project-a", castId: "cast-a", revision: 1, config: { name: "角色背面", direction: "back", prompt: "", imageOptions: { model: {}, ratio: "", resolution: "" } }, status: "idle", takes: [], ...value };
}
async function mount(options: { preserve?: boolean; rows?: CastView[]; cast?: Partial<DramaCast> } = {}) {
    if (!options.preserve) storage.clear();
    checks.length = executions.length = saves.length = adoptions.length = deletions.length = 0;
    confirmations = [];
    changed = 0;
    revision = 3;
    rows = options.rows || [];
    userStore.setState({ user: { id: "user-a" } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const cast = { id: "cast-a", projectId: "project-a", kind: "character", name: "秦子文", appearance: "26岁", revision: 2, ...options.cast } as DramaCast;
    await act(async () => {
        root.render(
            <QueryClientProvider client={client}>
                <CastViews projectId="project-a" cast={cast} disabled={false} onChanged={() => changed++} />
            </QueryClientProvider>,
        );
        await settle();
    });
    await click(host, "多视图");
    await act(settle);
    return {
        host,
        close: async () => {
            await act(async () => root.unmount());
            client.clear();
            host.remove();
        },
    };
}
function button(host: HTMLElement, text: string) {
    const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text);
    if (!found) throw new Error(`未找到按钮 ${text}: ${host.textContent}`);
    return found;
}
async function click(host: HTMLElement, text: string) {
    await act(async () => {
        button(host, text).click();
        await settle();
    });
}
async function input(host: HTMLElement, label: string, value: string, select = false) {
    const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
    await act(async () => {
        element.value = value;
        element.dispatchEvent(new Event(select ? "change" : "input", { bubbles: true }));
        await settle();
    });
}

test("角色、造型、场景和道具均有独立视图入口", async () => {
    for (const cast of [{ kind: "character" }, { kind: "character", parentId: "base", lookName: "雨衣造型" }, { kind: "scene" }, { kind: "prop" }] as Partial<DramaCast>[]) {
        const ui = await mount({ cast });
        expect(button(ui.host, "新增视图").disabled).toBe(false);
        await ui.close();
    }
});

test("保存新配置不生成，空规格和未指定参考沿用资产", async () => {
    const ui = await mount();
    await click(ui.host, "新增视图");
    await input(ui.host, "视图名称", "背面视图");
    await input(ui.host, "视图方向", "back", true);
    await click(ui.host, "保存视图配置");
    expect(saves).toHaveLength(1);
    expect(saves[0].input).toEqual({ expectedRevision: 3, expectedCastRevision: 2, viewRevision: 0, config: { name: "背面视图", direction: "back", prompt: "", imageOptions: { model: {}, ratio: "", resolution: "" } } });
    expect(executions).toHaveLength(0);
    expect(checks).toHaveLength(0);
    expect(ui.host.textContent).toContain("视图配置已保存");
    await ui.close();
});

test("单独设置参考可明确清空，资产库图片真实保存", async () => {
    const ui = await mount();
    await click(ui.host, "新增视图");
    await input(ui.host, "视图名称", "局部视图");
    await input(ui.host, "主体参考来源", "custom", true);
    await click(ui.host, "清空主体参考");
    await click(ui.host, "从资产库添加风格参考");
    await click(ui.host, "选择风格图片");
    await click(ui.host, "保存视图配置");
    expect(saves[0].input.config.imageOptions.subjectReferenceIds).toEqual([]);
    expect(saves[0].input.config.imageOptions.styleReferenceIds).toEqual(["inherited-style", "chosen-风格"]);
    expect(executions).toHaveLength(0);
    await ui.close();
});

test("卡片预检后确认才生成，使用返回的作品和视图双版本", async () => {
    const ui = await mount({ rows: [view()] });
    await click(ui.host, "预检生成");
    expect(checks).toEqual([{ viewId: "view-a", action: { viewRevision: 1 } }]);
    expect(executions).toHaveLength(0);
    await click(ui.host, "确认生成此视图");
    expect(executions).toHaveLength(1);
    expect(executions[0].action.expectedRevision).toBe(3);
    expect(executions[0].action.viewRevision).toBe(1);
    expect(executions[0].action.confirmationToken).toBe("view-quote");
    await act(async () => {
        executions[0].result.resolve({ id: "task", status: "queued" });
        await settle();
    });
    expect(storage.size).toBe(0);
    expect(ui.host.textContent).toContain("视图生成已提交");
    await ui.close();
});

test("网络不确定提交重开后仍用原操作标识", async () => {
    const first = await mount({ rows: [view()] });
    await click(first.host, "预检生成");
    await click(first.host, "确认生成此视图");
    const original = structuredClone(executions[0].action);
    await act(async () => {
        executions[0].result.reject(new Error("网络超时"));
        await settle();
    });
    await first.close();
    const second = await mount({ preserve: true, rows: [view()] });
    expect(button(second.host, "新增视图").disabled).toBe(true);
    await click(second.host, "确认提交结果");
    expect(executions[0].action).toEqual(original);
    await act(async () => {
        executions[0].result.resolve({ id: "same-task" });
        await settle();
    });
    expect(storage.size).toBe(0);
    await second.close();
});

test("采用视图真实历史版本只发送视图与结果归属", async () => {
    const ui = await mount({ rows: [view({ resourceId: "current-image", takes: [{ id: "take-real", resourceId: "history-image", taskId: "history-task", version: 1, status: "ready", current: false }] as CastView["takes"] })] });
    await click(ui.host, "采用此版本");
    expect(adoptions).toEqual([{ viewId: "view-a", input: { expectedRevision: 3, viewRevision: 1, takeId: "take-real" } }]);
    expect(saves).toHaveLength(0);
    expect(ui.host.textContent).toContain("已采用该视图历史图片");
    await ui.close();
});

test("删除须确认，排队中的视图禁用配置与重复生成", async () => {
    const ui = await mount({ rows: [view()] });
    await click(ui.host, "删除视图");
    expect(deletions).toHaveLength(0);
    await act(async () => {
        await confirmations[0].onOk();
        await settle();
    });
    expect(deletions).toEqual(["view-a"]);
    await ui.close();
    const active = await mount({ rows: [view({ status: "queued" })] });
    expect(button(active.host, "编辑配置").disabled).toBe(true);
    expect(button(active.host, "预检生成").disabled).toBe(true);
    expect(active.host.textContent).toContain("排队中");
    await active.close();
});

test("编辑草稿离开须确认，换账号后的生成回执隔离", async () => {
    const ui = await mount({ rows: [view()] });
    await click(ui.host, "编辑配置");
    await input(ui.host, "视图名称", "未保存的新名字");
    await click(ui.host, "取消");
    expect(confirmations).toHaveLength(1);
    expect(saves).toHaveLength(0);
    await act(async () => {
        await confirmations[0].onOk();
        await settle();
    });
    await click(ui.host, "预检生成");
    await click(ui.host, "确认生成此视图");
    await act(async () => {
        userStore.setState({ user: { id: "user-b" } });
        await settle();
    });
    await act(async () => {
        executions[0].result.resolve({ id: "old-task" });
        await settle();
    });
    expect(changed).toBe(0);
    expect(ui.host.textContent).not.toContain("视图生成已提交");
    await ui.close();
});

afterAll(() => browser.close());
