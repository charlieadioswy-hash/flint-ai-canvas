import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaCast } from "@/services/api/drama";
import type { CastView, CastViewAction, CastViewConfig, CastViewPreflight, CastViewSaveRequest } from "@/services/api/drama-cast-views";

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
const { ApiError } = await import("@/services/api/request");
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
const draftQuotes: CastViewSaveRequest[] = [];
let quoteOverride: ((viewId: string, action: CastViewAction) => Promise<CastViewPreflight>) | undefined;
let saveOverride: (() => Promise<void>) | undefined;
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
mock.module("@/services/api/drama", () => ({
    getDrama: async () => ({ project: { id: "project-a", userId: userStore.getState().user.id }, production: { revision, settings: { models: { image: { channelId: "system", modelKey: "image-new" } } } } }),
    getDramaEpisodeStyle: async () => {
        throw new Error("作品级视图不应读取单集配置");
    },
}));
mock.module("@/services/api/drama-cast-views", () => ({
    listDramaCastViews: async () => ({ views: structuredClone(rows) }),
    saveDramaCastView: async (_projectId: string, _castId: string, viewId: string | undefined, input: { expectedRevision: number; expectedCastRevision: number; viewRevision: number; config: CastViewConfig }) => {
        saves.push({ viewId, input: structuredClone(input) });
        await saveOverride?.();
        const saved = view({ id: viewId || "created-view", revision: input.viewRevision + 1, config: structuredClone(input.config) });
        rows = [...rows.filter((row) => row.id !== saved.id), saved];
        revision++;
        return saved;
    },
    preflightDramaCastView: async (_projectId: string, _castId: string, viewId: string, action: CastViewAction) => {
        checks.push({ viewId, action });
        if (quoteOverride) return quoteOverride(viewId, action);
        return {
            revision,
            viewRevision: rows.find((row) => row.id === viewId)!.revision,
            ready: true,
            priced: true,
            estimated: false,
            amountMicrocredits: 2_000_000,
            scopeHash: JSON.stringify(rows.find((row) => row.id === viewId)!.config),
            confirmationToken: "view-quote",
        };
    },
    quoteDramaCastViewDraft: async (_projectId: string, _castId: string, _viewId: string | undefined, input: CastViewSaveRequest) => {
        draftQuotes.push(structuredClone(input));
        return { revision, viewRevision: input.viewRevision, ready: true, priced: true, estimated: false, amountMicrocredits: 2_000_000, scopeHash: JSON.stringify(input.config), confirmationToken: "" };
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
async function waitForAutoSave() {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
    await act(settle);
}
function view(value: Partial<CastView> = {}): CastView {
    return { id: "view-a", projectId: "project-a", castId: "cast-a", revision: 1, config: { name: "角色背面", direction: "back", prompt: "", imageOptions: { model: {}, ratio: "", resolution: "" } }, status: "idle", takes: [], ...value };
}
async function mount(options: { preserve?: boolean; rows?: CastView[]; cast?: Partial<DramaCast>; quote?: typeof quoteOverride; save?: typeof saveOverride } = {}) {
    if (!options.preserve) storage.clear();
    checks.length = executions.length = saves.length = adoptions.length = deletions.length = 0;
    draftQuotes.length = 0;
    quoteOverride = options.quote;
    saveOverride = options.save;
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
        client,
        close: async () => {
            await act(async () => root.unmount());
            client.clear();
            host.remove();
        },
    };
}
function generationButton(host: HTMLElement) {
    return [...host.querySelectorAll<HTMLButtonElement>("button")].filter((item) => item.textContent?.startsWith("生成图片 - ")).at(-1)!;
}
async function generate(host: HTMLElement) {
    for (let attempt = 0; attempt < 100 && (!generationButton(host) || generationButton(host).disabled); attempt++) await act(settle);
    expect(generationButton(host)?.disabled).toBe(false);
    await act(async () => {
        generationButton(host).click();
        await settle();
    });
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
    await waitForAutoSave();
    expect(saves).toHaveLength(1);
    expect(saves[0].input).toEqual({ expectedRevision: 3, expectedCastRevision: 2, viewRevision: 0, config: { name: "背面视图", direction: "back", prompt: "", imageOptions: { model: {}, ratio: "", resolution: "" } } });
    expect(executions).toHaveLength(0);
    expect(ui.host.textContent).not.toContain("保存视图配置");
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
    await waitForAutoSave();
    expect(saves[0].input.config.imageOptions.subjectReferenceIds).toEqual([]);
    expect(saves[0].input.config.imageOptions.styleReferenceIds).toEqual(["inherited-style", "chosen-风格"]);
    expect(executions).toHaveLength(0);
    await ui.close();
});

test("卡片自动报价后单击直接生成，使用返回的作品和视图双版本", async () => {
    const ui = await mount({ rows: [view()] });
    expect(checks).toEqual([{ viewId: "view-a", action: { viewRevision: 1 } }]);
    expect(executions).toHaveLength(0);
    expect(generationButton(ui.host).textContent).toBe("生成图片 - 2积分");
    await generate(ui.host);
    expect(confirmations).toHaveLength(0);
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

test("新视图草稿自动报价不创建记录，单击才保存并用新令牌生成", async () => {
    const ui = await mount();
    await click(ui.host, "新增视图");
    await input(ui.host, "视图名称", "侧面草稿");
    for (let attempt = 0; attempt < 100 && !draftQuotes.length; attempt++) await act(settle);
    expect(draftQuotes).toHaveLength(1);
    expect(saves).toHaveLength(0);
    expect(executions).toHaveLength(0);
    await generate(ui.host);
    expect(saves).toHaveLength(1);
    expect(executions).toHaveLength(1);
    expect(executions[0].viewId).toBe("created-view");
    expect(executions[0].action).toEqual(expect.objectContaining({ expectedRevision: 4, viewRevision: 1, confirmationToken: "view-quote" }));
    expect(confirmations).toHaveLength(0);
    await act(async () => {
        executions[0].result.resolve({ id: "task" });
        await settle();
    });
    await ui.close();
});

test("配置自动保存后展示新报价，单击按最新已显示价格生成", async () => {
    const ui = await mount({
        quote: async (viewId) => ({
            revision,
            viewRevision: rows.find((row) => row.id === viewId)!.revision,
            ready: true,
            priced: true,
            estimated: false,
            amountMicrocredits: 3_000_000,
            scopeHash: JSON.stringify(rows.find((row) => row.id === viewId)!.config),
            confirmationToken: "new-price",
        }),
    });
    await click(ui.host, "新增视图");
    await input(ui.host, "视图名称", "需要核对新价");
    await waitForAutoSave();
    expect(saves).toHaveLength(1);
    expect(executions).toHaveLength(0);
    for (let attempt = 0; attempt < 100 && generationButton(ui.host)?.textContent !== "生成图片 - 3积分"; attempt++) await act(settle);
    expect(generationButton(ui.host).textContent).toBe("生成图片 - 3积分");
    await generate(ui.host);
    expect(saves).toHaveLength(1);
    expect(executions).toHaveLength(1);
    expect(executions[0].action.confirmationToken).toBe("new-price");
    await act(async () => {
        executions[0].result.resolve({ id: "task" });
        await settle();
    });
    await ui.close();
});

test("版本更新后旧报价迟到不会启用生成，必须展示当前版本报价", async () => {
    const old = deferred<CastViewPreflight>();
    const current = deferred<CastViewPreflight>();
    const ui = await mount({ rows: [view()], quote: async (_id, action) => (action.viewRevision === 1 ? old.promise : current.promise) });
    expect(generationButton(ui.host).disabled).toBe(true);
    rows = [view({ revision: 2 })];
    revision = 4;
    await act(async () => {
        await Promise.all([ui.client.refetchQueries({ queryKey: ["drama-cast-views"] }), ui.client.refetchQueries({ queryKey: ["drama", "project-a"] })]);
        await settle();
    });
    await act(async () => {
        old.resolve({ revision: 3, viewRevision: 1, ready: true, priced: true, estimated: false, amountMicrocredits: 1_000_000, scopeHash: "old", confirmationToken: "old-token" });
        await settle();
    });
    expect(generationButton(ui.host).disabled).toBe(true);
    expect(executions).toHaveLength(0);
    await act(async () => {
        current.resolve({ revision: 4, viewRevision: 2, ready: true, priced: true, estimated: false, amountMicrocredits: 3_000_000, scopeHash: "new", confirmationToken: "current-token" });
        await settle();
    });
    await generate(ui.host);
    expect(generationButton(ui.host).textContent).toBe("生成图片 - 3积分");
    expect(executions[0].action).toEqual(expect.objectContaining({ expectedRevision: 4, viewRevision: 2, confirmationToken: "current-token" }));
    await act(async () => {
        executions[0].result.resolve({ id: "task" });
        await settle();
    });
    await ui.close();
});

for (const outcome of ["rejected", "uncertain"] as const) {
    test(`新视图保存后生成${outcome}仍保留明确反馈，不覆盖成保存成功`, async () => {
        const ui = await mount();
        await click(ui.host, "新增视图");
        await input(ui.host, "视图名称", "保留失败反馈");
        await generate(ui.host);
        await act(async () => {
            executions[0].result.reject(outcome === "rejected" ? new ApiError("模型不可用", { status: 400 }) : new Error("响应断开"));
            await settle();
        });
        expect(saves).toHaveLength(1);
        expect(executions).toHaveLength(1);
        expect(ui.host.textContent).not.toContain("保存视图配置");
        expect(ui.host.textContent).toContain(outcome === "rejected" ? "生成提交失败：模型不可用" : "生成提交结果待核对：响应断开");
        if (outcome === "uncertain") {
            expect(generationButton(ui.host).disabled).toBe(true);
            expect(storage.size).toBe(1);
        } else expect(storage.size).toBe(0);
        await ui.close();
    });
}

test("网络不确定提交重开后仍用原操作标识", async () => {
    const first = await mount({ rows: [view()] });
    await generate(first.host);
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
    expect(generationButton(active.host).disabled).toBe(true);
    expect(active.host.textContent).toContain("排队中");
    await active.close();
});

test("视图修改自动保存且关闭无需确认，换账号后的生成回执隔离", async () => {
    const ui = await mount({ rows: [view()] });
    await click(ui.host, "编辑配置");
    await input(ui.host, "视图名称", "未保存的新名字");
    await waitForAutoSave();
    expect(ui.host.textContent).not.toContain("保存视图配置");
    await click(ui.host, "关闭");
    expect(confirmations).toHaveLength(0);
    expect(saves).toHaveLength(1);
    changed = 0;
    await generate(ui.host);
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

test("视图自动保存失败保留草稿，只在明确重试时再次保存", async () => {
    let failed = true;
    const ui = await mount({
        rows: [view()],
        save: async () => {
            if (failed) throw new Error("保存暂时失败");
        },
    });
    try {
        await click(ui.host, "编辑配置");
        await input(ui.host, "视图名称", "保留并重试的视图");
        await waitForAutoSave();
        expect(ui.host.textContent).toContain("保存暂时失败");
        expect(ui.host.querySelector<HTMLInputElement>('[aria-label="视图名称"]')?.value).toBe("保留并重试的视图");
        await waitForAutoSave();
        expect(saves).toHaveLength(1);
        failed = false;
        await click(ui.host, "重试保存");
        expect(saves).toHaveLength(2);
        expect(rows[0].config.name).toBe("保留并重试的视图");
        expect(ui.host.textContent).not.toContain("保存暂时失败");
        expect(executions).toHaveLength(0);
        expect(confirmations).toHaveLength(0);
    } finally {
        await ui.close();
    }
});

test("视图自动保存冲突后可放弃关闭并重新打开服务器配置", async () => {
    const ui = await mount({
        rows: [view()],
        save: async () => {
            throw new ApiError("视图版本冲突", { status: 409 });
        },
    });
    try {
        await click(ui.host, "编辑配置");
        await input(ui.host, "视图名称", "不能保存的视图草稿");
        await waitForAutoSave();
        expect(ui.host.textContent).toContain("视图版本冲突");
        await click(ui.host, "放弃修改并关闭");
        expect(Boolean(ui.host.querySelector('[aria-label="视图名称"]'))).toBe(false);
        expect(saves).toHaveLength(1);
        expect(confirmations).toHaveLength(0);
        await click(ui.host, "编辑配置");
        expect(ui.host.querySelector<HTMLInputElement>('[aria-label="视图名称"]')?.value).toBe("角色背面");
        expect(executions).toHaveLength(0);
    } finally {
        await ui.close();
    }
});

afterAll(() => browser.close());
