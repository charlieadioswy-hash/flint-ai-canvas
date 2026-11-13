import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";
import type { CreateTaskInput, GenerationTask } from "@/services/api/task-center";
import type { DramaModelChoice } from "@/services/api/drama";
import type { AiConfig } from "@/stores/use-config-store";
import type { LocalUser } from "@/stores/use-user-store";

const browser = new Window({ url: "http://localhost/projects/create" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    InputEvent: browser.InputEvent,
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
const { setActiveUserScope } = await import("@/lib/user-scope");
const { ApiError } = await import("@/services/api/request");

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}
const user = (id: string): LocalUser => ({ id, username: id, displayName: id, role: "user", status: "active" });
const userStore = create<{ user: LocalUser | null }>(() => ({ user: user("user-a") }));
const config = { model: "m1" } as AiConfig;
const choice: DramaModelChoice = { logicalModelId: "m1", label: "文本模型1" };
const otherChoice: DramaModelChoice = { logicalModelId: "m2", label: "文本模型2" };
const disk = new Map<string, string>();
const writes: Array<{ owner: string; state: Record<string, unknown> }> = [];
const creates: CreateTaskInput[] = [];
const retries: string[] = [];
const cancels: string[] = [];
const queries: string[] = [];
const quotes: string[] = [];
const pickerCallbacks: Array<(value: DramaModelChoice) => void> = [];
const notices: string[] = [];
let createImpl: (input: CreateTaskInput) => Promise<GenerationTask>;
let queryImpl: (id: string) => Promise<GenerationTask>;
let historyImpl: () => Promise<GenerationTask[]>;
let quoteImpl: () => Promise<{ quote: { amountMicrocredits: number; estimated: boolean } }>;
let retryImpl: (id: string) => Promise<GenerationTask>;
let readImpl: ((owner: string) => Promise<string | null>) | undefined;
let failWrites = false;
let privateChannel = false;
const tasks = new Map<string, GenerationTask>();

mock.module("antd", () => ({
    App: { useApp: () => ({ message: { success: (text: string) => notices.push(text) } }) },
    Button: ({ children, type: _type, htmlType = "button", loading: _loading, size: _size, ...props }: { children?: ReactNode; type?: string; htmlType?: string; loading?: boolean; size?: string } & Record<string, unknown>) =>
        createElement("button", { ...props, type: htmlType }, children),
    Input: { TextArea: ({ autoSize: _autoSize, ...props }: Record<string, unknown>) => createElement("textarea", props) },
    Progress: ({ percent }: { percent: number }) => createElement("progress", { value: percent, max: 100 }),
}));
mock.module("react-router", () => ({ Link: ({ children, to }: { children?: ReactNode; to: string }) => createElement("a", { href: to }, children) }));
mock.module("@/stores/use-user-store", () => ({ useUserStore: userStore }));
mock.module("@/stores/use-config-store", () => ({ useEffectiveConfig: () => config, resolveModelChannel: () => ({ scope: privateChannel ? "user" : "system" }) }));
mock.module("@/lib/drama/model-choice", () => ({ dramaChoiceToModel: (_config: AiConfig, _capability: string, value?: DramaModelChoice) => value?.logicalModelId || value?.modelKey || "" }));
mock.module("@/lib/model-pricing", () => ({
    systemModelQuoteRequest: (_config: AiConfig, model: string) => (model ? { logicalModelID: model, intent: { capability: "text", inputs: {}, options: {} } } : undefined),
    modelQuoteDescription: () => "预计费用，按实际用量结算",
}));
mock.module("@/services/api/logical-models", () => ({
    quoteModel: async (input: { logicalModelID: string }) => {
        quotes.push(input.logicalModelID);
        return quoteImpl();
    },
}));
mock.module("@/pages/projects/drama-model-picker", () => ({
    useDramaModelCatalog: () => ({ data: { defaults: { text: choice } }, isError: false, refetch: async () => undefined }),
    DramaModelPicker: ({ onChange, value }: { onChange: (value: DramaModelChoice) => void; value?: DramaModelChoice }) => {
        pickerCallbacks.push(onChange);
        return createElement("button", { onClick: () => onChange(otherChoice) }, `模型 ${value?.label || "未选择"}`);
    },
}));
mock.module("@/lib/localforage-storage", () => ({
    localForageStorageForScope: (owner: string) => ({
        getItem: async () => (readImpl ? readImpl(owner) : disk.get(owner) || null),
        setItem: async (_key: string, value: string) => {
            if (failWrites) throw new Error("磁盘不可写");
            writes.push({ owner, state: JSON.parse(value) });
            disk.set(owner, value);
        },
    }),
}));
mock.module("@/services/api/generation-task", () => ({
    prepareBackendGenerationTask: async (input: { prompt: string; mode: string; config: AiConfig; metadata: Record<string, unknown>; clientOperationId: string }) => ({
        type: `canvas_${input.mode}`,
        operation: input.mode,
        prompt: input.prompt,
        model: input.config.model,
        logicalModelId: input.config.model,
        input: {
            mode: input.mode,
            prompt: input.prompt,
            config: { apiKey: "fixture-private-key", secretKey: "fixture-private-secret", headers: { authorization: "fixture" }, model: input.config.model },
            metadata: { ...input.metadata, clientOperationId: input.clientOperationId },
        },
    }),
    parseBackendGenerationResult: (task: GenerationTask) => JSON.parse(task.resultJson || "{}"),
}));
mock.module("@/services/api/task-center", () => ({
    createGenerationTask: async (input: CreateTaskInput) => {
        creates.push(structuredClone(input));
        return createImpl(input);
    },
    queryGenerationTask: async (id: string) => {
        queries.push(id);
        return queryImpl(id);
    },
    listGenerationTasks: async () => historyImpl(),
    retryGenerationTask: async (id: string) => {
        retries.push(id);
        return retryImpl(id);
    },
    cancelGenerationTask: async (id: string) => {
        cancels.push(id);
        const task = { ...tasks.get(id)!, status: "cancelled" as const };
        tasks.set(id, task);
        return task;
    },
}));
const { WorkflowIdea } = await import("@/pages/projects/workflow-idea");
const { emptyIdeaWorkspace, prepareIdeaSubmission, readIdeaWorkspace, writeIdeaWorkspace, ideaTaskSource } = await import("@/pages/projects/workflow-idea-task");

afterAll(() => {
    browser.happyDOM.abort();
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function taskOf(id: string, status: GenerationTask["status"] = "queued", request?: CreateTaskInput): GenerationTask {
    const operationId = request?.clientOperationId || `op-${id}`;
    return {
        id,
        type: "canvas_text",
        status,
        prompt: request?.prompt || "正文扩写",
        attempts: 0,
        createdAt: "2026-11-13T00:00:00Z",
        updatedAt: "2026-11-13T00:00:00Z",
        inputJson: JSON.stringify(request?.input || { metadata: { source: "drama_idea", clientOperationId: operationId, nodeId: `drama-idea:${operationId}`, dramaIdea: { idea: `创意 ${id}`, format: "script", choice } } }),
        resultJson: status === "succeeded" ? JSON.stringify({ text: `第1集\n${id}生成的剧本` }) : undefined,
    };
}
function reset() {
    disk.clear();
    writes.length = 0;
    creates.length = 0;
    retries.length = 0;
    cancels.length = 0;
    queries.length = 0;
    quotes.length = 0;
    notices.length = 0;
    pickerCallbacks.length = 0;
    tasks.clear();
    readImpl = undefined;
    failWrites = false;
    privateChannel = false;
    setActiveUserScope("user-a");
    userStore.setState({ user: user("user-a") });
    createImpl = async (input) => {
        const task = taskOf("new-task", "queued", input);
        tasks.set(task.id, task);
        return task;
    };
    queryImpl = async (id) => {
        const task = tasks.get(id);
        if (!task) throw new Error("任务不存在");
        return structuredClone(task);
    };
    historyImpl = async () =>
        Array.from(tasks.values()).map((task) => {
            const { inputJson, resultJson: _result, textDraft: _draft, ...summary } = structuredClone(task);
            return { ...summary, clientContext: { nodeId: JSON.parse(inputJson || "{}").metadata?.nodeId } };
        });
    quoteImpl = async () => ({ quote: { amountMicrocredits: 100, estimated: true } });
    retryImpl = async (id) => {
        const task = { ...tasks.get(id)!, status: "queued" as const, attempts: tasks.get(id)!.attempts + 1 };
        tasks.set(id, task);
        return task;
    };
}
async function settle() {
    for (let i = 0; i < 4; i += 1) await Bun.sleep(5);
}
async function run(action: () => unknown) {
    await act(async () => {
        action();
        await settle();
    });
    await act(settle);
}
async function mount(disabled = false) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const adopted: Array<[string, string]> = [];
    const dirty: Array<[boolean, boolean]> = [];
    let locked = disabled;
    const render = () => root.render(createElement(QueryClientProvider, { client }, createElement(WorkflowIdea, { disabled: locked, onAdopt: (text, format) => adopted.push([text, format]), onDirtyChange: (value, busy) => dirty.push([value, busy]) })));
    await run(render);
    return {
        container,
        client,
        adopted,
        dirty,
        update: async (value: boolean) => {
            locked = value;
            await run(render);
        },
        dispose: async () => {
            await act(() => root.unmount());
            container.remove();
            client.clear();
            client.unmount();
        },
    };
}
function button(container: HTMLElement, label: string) {
    const found = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === label);
    expect(found, `未找到按钮 ${label}`).toBeDefined();
    return found!;
}
function field(container: HTMLElement, label: string) {
    const found = container.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${label}"]`);
    expect(found, `未找到字段 ${label}`).not.toBeNull();
    return found!;
}
async function click(container: HTMLElement, label: string) {
    await run(() => button(container, label).click());
}
async function input(container: HTMLElement, label: string, value: string) {
    await run(() => {
        const element = field(container, label);
        const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
        element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    });
}
async function saveTask(task: GenerationTask, patch: Record<string, unknown> = {}) {
    tasks.set(task.id, task);
    await writeIdeaWorkspace("user-a", { ...emptyIdeaWorkspace(), idea: ideaTaskSource(task)!.idea, choice, taskId: task.id, ...patch });
}

test("请求只有独立平台文字任务，持久请求无渠道密钥并校验恢复协议", async () => {
    reset();
    const prepared = await prepareIdeaSubmission(config, choice, "秦子文，26岁，冷静谨慎", "script");
    expect(prepared.request.projectId).toBeUndefined();
    expect(prepared.request.type).toBe("canvas_text");
    expect(prepared.request.operation).toBe("text");
    expect(prepared.request.clientOperationId).toBeTruthy();
    expect(prepared.request.input?.metadata).toEqual({
        source: "drama_idea",
        nodeId: `drama-idea:${prepared.request.clientOperationId}`,
        dramaIdea: { idea: prepared.idea, format: "script", choice },
        clientOperationId: prepared.request.clientOperationId,
    });
    expect(JSON.stringify(prepared)).not.toContain("fixture-private");
    expect(prepared.request.prompt).toContain("保留用户明确给出的人物定义");
    await writeIdeaWorkspace("user-a", { ...emptyIdeaWorkspace(), pending: prepared });
    expect((await readIdeaWorkspace("user-a")).pending).toEqual(prepared);
    expect((await readIdeaWorkspace("user-b")).pending).toBeUndefined();
    const invalid = structuredClone(prepared);
    invalid.request.projectId = "other-project";
    disk.set("user-a", JSON.stringify({ ...emptyIdeaWorkspace(), pending: invalid }));
    await expect(readIdeaWorkspace("user-a")).rejects.toThrow("无法读取");
    privateChannel = true;
    await expect(prepareIdeaSubmission(config, choice, "想法", "script")).rejects.toThrow("平台文本模型");
});

test("报价与明确确认后才创建，进度正文可编辑且刷新不覆盖人工修改，采用不自动发生", async () => {
    reset();
    const ui = await mount();
    try {
        await input(ui.container, "创作想法", "小区穿越森林");
        expect(creates).toHaveLength(0);
        await click(ui.container, "扩写正文");
        expect(quotes).toEqual(["m1"]);
        expect(creates).toHaveLength(0);
        await click(ui.container, "确认并生成");
        expect(creates).toHaveLength(1);
        expect(writes.some((item) => (item.state.pending as { request?: CreateTaskInput })?.request?.clientOperationId === creates[0]!.clientOperationId)).toBe(true);
        expect(ui.container.textContent).toContain("排队中");
        expect(ui.adopted).toHaveLength(0);
        const running = { ...tasks.get("new-task")!, status: "running" as const, progress: 42, textDraft: "正在形成正文" };
        tasks.set(running.id, running);
        await run(() => ui.client.setQueryData(["drama-idea-task", "user-a", running.id], running));
        expect(ui.container.querySelector("progress")?.value).toBe(42);
        expect(field(ui.container, "扩写正文草稿").value).toBe("正在形成正文");
        const succeeded = { ...running, status: "succeeded" as const, resultJson: JSON.stringify({ text: "第1集\n模型正文" }) };
        tasks.set(succeeded.id, succeeded);
        await run(() => ui.client.setQueryData(["drama-idea-task", "user-a", succeeded.id], succeeded));
        await input(ui.container, "扩写正文草稿", "第1集\n人工修改正文");
        await run(() => ui.client.setQueryData(["drama-idea-task", "user-a", succeeded.id], { ...succeeded, updatedAt: "later" }));
        expect(field(ui.container, "扩写正文草稿").value).toBe("第1集\n人工修改正文");
        expect(ui.adopted).toHaveLength(0);
        await input(ui.container, "扩写正文类型", "novel");
        await click(ui.container, "采用为正文");
        expect(ui.adopted).toEqual([["第1集\n人工修改正文", "script"]]);
    } finally {
        await ui.dispose();
    }
});

test("创建回执未知保持原始id和请求，刷新后只读核对再由用户重放", async () => {
    reset();
    createImpl = async () => {
        throw new Error("连接中断");
    };
    let ui = await mount();
    await input(ui.container, "创作想法", "森林求生");
    await click(ui.container, "扩写正文");
    await click(ui.container, "确认并生成");
    const original = structuredClone(creates[0]!);
    expect(ui.container.textContent).toContain("提交回执尚未确认");
    await ui.dispose();
    ui = await mount();
    try {
        expect(creates).toHaveLength(1);
        await click(ui.container, "核对提交");
        expect(creates).toHaveLength(1);
        createImpl = async (request) => {
            const task = taskOf("received", "queued", request);
            tasks.set(task.id, task);
            return task;
        };
        await click(ui.container, "继续原提交");
        expect(creates).toHaveLength(1);
        await click(ui.container, "确认并生成");
        expect(creates).toHaveLength(2);
        expect(creates[1]).toEqual(original);
    } finally {
        await ui.dispose();
    }
});

test("原提交可从任务列表核对恢复，不产生新任务", async () => {
    reset();
    const pending = await prepareIdeaSubmission(config, choice, "原想法", "novel");
    await writeIdeaWorkspace("user-a", { ...emptyIdeaWorkspace(), pending });
    tasks.set("receipt", taskOf("receipt", "succeeded", pending.request));
    const ui = await mount();
    try {
        await click(ui.container, "核对提交");
        expect(creates).toHaveLength(0);
        expect(ui.container.textContent).not.toContain("提交回执尚未确认");
        expect(field(ui.container, "扩写正文草稿").value).toContain("receipt生成的剧本");
        await click(ui.container, "采用为正文");
        expect(ui.adopted[0]?.[1]).toBe("novel");
    } finally {
        await ui.dispose();
    }
});

test("明确拒绝可重新编辑，不能持久化待提交请求时禁止付费创建", async () => {
    reset();
    createImpl = async () => {
        throw new ApiError("模型参数不支持", { status: 400, reason: "invalid_model" });
    };
    const ui = await mount();
    try {
        await input(ui.container, "创作想法", "原创意");
        await click(ui.container, "扩写正文");
        await click(ui.container, "确认并生成");
        expect(ui.container.textContent).not.toContain("提交回执尚未确认");
        expect(field(ui.container, "创作想法").disabled).toBe(false);
        await input(ui.container, "创作想法", "修改创意");
        failWrites = true;
        await click(ui.container, "扩写正文");
        await click(ui.container, "确认并生成");
        expect(creates).toHaveLength(1);
        expect(ui.container.textContent).toContain("磁盘不可写");
    } finally {
        failWrites = false;
        await ui.dispose();
    }
});

test("页面刷新恢复服务器任务与手改正文，账号切换不读取其他账号草稿", async () => {
    reset();
    await saveTask(taskOf("done", "succeeded"), { result: "手动正文", resultTaskId: "done", resultEdited: true });
    let ui = await mount();
    try {
        expect(field(ui.container, "扩写正文草稿").value).toBe("手动正文");
        expect(creates).toHaveLength(0);
        await run(() => {
            setActiveUserScope("user-b");
            userStore.setState({ user: user("user-b") });
        });
        expect(field(ui.container, "创作想法").value).toBe("");
        expect(ui.container.textContent).not.toContain("手动正文");
        expect(writes.filter((item) => item.owner === "user-b").every((item) => !JSON.stringify(item.state).includes("手动正文"))).toBe(true);
    } finally {
        await ui.dispose();
    }
    setActiveUserScope("user-a");
    userStore.setState({ user: user("user-a") });
    ui = await mount();
    try {
        expect(field(ui.container, "扩写正文草稿").value).toBe("手动正文");
    } finally {
        await ui.dispose();
    }
});

test("迟到的hydration、报价、创建、任务查询均不能影响新账号或已卸载页面", async () => {
    for (const kind of ["hydrate", "quote", "create", "query"] as const)
        for (const leave of ["account", "scope", "unmount"] as const) {
            reset();
            const oldRead = deferred<string | null>();
            const oldQuote = deferred<{ quote: { amountMicrocredits: number; estimated: boolean } }>();
            const oldCreate = deferred<GenerationTask>();
            const oldQuery = deferred<GenerationTask>();
            if (kind === "hydrate") readImpl = async (owner) => (owner === "user-a" ? oldRead.promise : null);
            if (kind === "quote") quoteImpl = () => oldQuote.promise;
            if (kind === "create") createImpl = () => oldCreate.promise;
            if (kind === "query") {
                await saveTask(taskOf("old", "succeeded"));
                queryImpl = (id) => (id === "old" ? oldQuery.promise : Promise.reject(new Error("不存在")));
            }
            const ui = await mount();
            if (kind === "quote" || kind === "create") {
                await input(ui.container, "创作想法", "旧账号创意");
                await click(ui.container, "扩写正文");
                if (kind === "create") await click(ui.container, "确认并生成");
            }
            if (leave === "account")
                await run(() => {
                    setActiveUserScope("user-b");
                    userStore.setState({ user: user("user-b") });
                });
            else if (leave === "scope") {
                setActiveUserScope("user-b");
                await ui.update(false);
            } else await ui.dispose();
            await run(() => {
                if (kind === "hydrate") oldRead.resolve(JSON.stringify({ ...emptyIdeaWorkspace(), idea: "旧账号草稿" }));
                if (kind === "quote") oldQuote.resolve({ quote: { amountMicrocredits: 10, estimated: true } });
                if (kind === "create") oldCreate.resolve(taskOf("old-receipt", "succeeded", creates[0]));
                if (kind === "query") oldQuery.resolve(taskOf("old", "succeeded"));
            });
            expect(ui.adopted).toHaveLength(0);
            expect(notices).toHaveLength(0);
            expect(writes.filter((item) => item.owner === "user-b").every((item) => !JSON.stringify(item.state).includes("旧账号"))).toBe(true);
            if (leave !== "unmount") {
                expect(field(ui.container, "创作想法").value).toBe("");
                expect(ui.container.textContent).not.toContain("确认扩写费用");
                expect(ui.client.getQueryData(["drama-idea-task", "user-b", "old-receipt"])).toBeUndefined();
                await ui.dispose();
            }
        }
});

test("失败任务先按原模型报价，明确重试后入队，可取消，未知重试必须核对", async () => {
    reset();
    await saveTask(taskOf("failed", "failed"), { choice: otherChoice });
    const ui = await mount();
    try {
        await click(ui.container, "重试扩写");
        expect(quotes).toEqual(["m1"]);
        expect(retries).toHaveLength(0);
        await click(ui.container, "确认并重试");
        expect(retries).toEqual(["failed"]);
        expect(ui.container.textContent).toContain("排队中");
        await click(ui.container, "取消任务");
        expect(cancels).toEqual(["failed"]);
        retryImpl = async () => {
            throw new Error("重试连接中断");
        };
        await click(ui.container, "重试扩写");
        await click(ui.container, "确认并重试");
        expect(ui.container.textContent).toContain("重试回执尚未确认");
        expect(button(ui.container, "重试扩写").disabled).toBe(true);
        const count = retries.length;
        await click(ui.container, "核对重试状态");
        expect(retries).toHaveLength(count);
        expect(button(ui.container, "重试扩写").disabled).toBe(true);
        tasks.set("failed", { ...tasks.get("failed")!, attempts: 2, status: "failed", error: "新的尝试失败" });
        await click(ui.container, "核对重试状态");
        expect(ui.container.textContent).not.toContain("重试回执尚未确认");
        expect(button(ui.container, "重试扩写").disabled).toBe(false);
    } finally {
        await ui.dispose();
    }
});

test("回执身份或来源不符时保留待核对请求，不展示可采用的结果", async () => {
    reset();
    createImpl = async () => taskOf("unrelated", "succeeded");
    const ui = await mount();
    try {
        await input(ui.container, "创作想法", "新创意");
        await click(ui.container, "扩写正文");
        await click(ui.container, "确认并生成");
        expect(ui.container.textContent).toContain("回执与本次创意扩写不匹配");
        expect(ui.container.textContent).toContain("提交回执尚未确认");
        expect(ui.container.querySelector('[aria-label="扩写正文草稿"]')).toBeNull();
        expect(ui.adopted).toHaveLength(0);
    } finally {
        await ui.dispose();
    }
});

test("损坏缓存不被空稿自动覆盖，可从历史任务显式恢复；切换历史保护手改结果", async () => {
    reset();
    disk.set("user-a", "{broken");
    tasks.set("saved", taskOf("saved", "succeeded"));
    tasks.set("other", taskOf("other", "succeeded"));
    const ui = await mount();
    try {
        expect(button(ui.container, "扩写正文").disabled).toBe(true);
        expect(disk.get("user-a")).toBe("{broken");
        await input(ui.container, "恢复扩写任务", "saved");
        expect(field(ui.container, "扩写正文草稿").value).toContain("saved生成的剧本");
        await input(ui.container, "扩写正文草稿", "手改正文");
        await input(ui.container, "恢复扩写任务", "other");
        expect(field(ui.container, "扩写正文草稿").value).toBe("手改正文");
        await click(ui.container, "放弃修改并切换");
        expect(field(ui.container, "扩写正文草稿").value).toContain("other生成的剧本");
    } finally {
        await ui.dispose();
    }
});

test("真实摘要仅筛候选并读详情，错误来源及其他项目不会被当成扩写记录", async () => {
    reset();
    tasks.set("mine", taskOf("mine", "succeeded"));
    const unrelated = taskOf("unrelated", "succeeded");
    unrelated.inputJson = JSON.stringify({ metadata: { source: "other-feature", nodeId: "drama-idea:op-unrelated", clientOperationId: "op-unrelated", dramaIdea: { idea: "不能误恢复", format: "script", choice } } });
    tasks.set(unrelated.id, unrelated);
    const another = { ...taskOf("another", "succeeded"), projectId: "project-a" };
    tasks.set(another.id, another);
    const canvas = taskOf("canvas", "succeeded");
    canvas.inputJson = JSON.stringify({ metadata: { source: "canvas", nodeId: "real-canvas-node" } });
    tasks.set(canvas.id, canvas);
    const ui = await mount();
    try {
        expect(queries).toContain("mine");
        expect(queries).toContain("unrelated");
        expect(queries).not.toContain("another");
        expect(queries).not.toContain("canvas");
        const options = Array.from(field(ui.container, "恢复扩写任务").querySelectorAll("option")).map((item) => item.value);
        expect(options).toEqual(["", "mine"]);
        expect(creates).toHaveLength(0);
    } finally {
        await ui.dispose();
    }
});

test("报价后父流程冻结不留下可确认报价，旧模型选择回调不能改新会话", async () => {
    reset();
    const pending = deferred<{ quote: { amountMicrocredits: number; estimated: boolean } }>();
    quoteImpl = () => pending.promise;
    const ui = await mount();
    try {
        const oldPicker = pickerCallbacks.at(-1)!;
        await input(ui.container, "创作想法", "创意");
        await click(ui.container, "扩写正文");
        await ui.update(true);
        await run(() => pending.resolve({ quote: { amountMicrocredits: 1, estimated: true } }));
        expect(ui.container.querySelector('[aria-label="确认扩写费用"]')).toBeNull();
        expect(creates).toHaveLength(0);
        await run(() => {
            setActiveUserScope("user-b");
            userStore.setState({ user: user("user-b") });
        });
        await ui.update(false);
        await run(() => oldPicker(otherChoice));
        expect(ui.container.textContent).not.toContain("模型 文本模型2");
        expect(creates).toHaveLength(0);
    } finally {
        await ui.dispose();
    }
});

test("费用确认后报价变化时不建单也不重试，重新确认使用新的费用", async () => {
    reset();
    let amount = 100;
    quoteImpl = async () => ({ quote: { amountMicrocredits: amount, estimated: true } });
    const ui = await mount();
    try {
        await input(ui.container, "创作想法", "创意");
        await click(ui.container, "扩写正文");
        amount = 200;
        await click(ui.container, "确认并生成");
        expect(creates).toHaveLength(0);
        expect(retries).toHaveLength(0);
        expect(ui.container.textContent).toContain("模型报价已变化");
        await click(ui.container, "扩写正文");
        await click(ui.container, "确认并生成");
        expect(creates).toHaveLength(1);
    } finally {
        await ui.dispose();
    }
});
