import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaShot } from "@/services/api/drama";
import type { DramaStoryboard, DramaStoryboardCreate } from "@/services/api/drama-storyboard";
import type { DramaShotMediaAction } from "@/services/api/drama-shot-media";

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
const creations: DramaStoryboardCreate[] = [];
const executions: { boardId: string; request: DramaShotMediaAction; result: Deferred<{ id: string; status: string }> }[] = [];
const splitCalls: { expectedRevision: number }[] = [];
const adoptCalls: { expectedRevision: number; expectedMediaRevision: number; cellId: string }[] = [];
let server: DramaStoryboard;
let closes = 0;
let readsFail = false;
const Input = Object.assign(({ onChange, ...props }: Record<string, unknown>) => createElement("input", { ...props, onInput: onChange }), {
    TextArea: ({ onChange, autoSize: _autoSize, ...props }: Record<string, unknown>) => createElement("textarea", { ...props, onInput: onChange }),
});
mock.module("antd", () => ({
    Button: ({ children, loading: _loading, type: _type, size: _size, ...props }: Record<string, unknown>) => createElement("button", props, children as ReactNode),
    Input,
    Checkbox: ({ children, ...props }: Record<string, unknown>) => (
        <label>
            <input type="checkbox" {...props} />
            {children as ReactNode}
        </label>
    ),
    Select: ({ options, onChange, placeholder, ...props }: { options: { value: string; label: string }[]; onChange: (value: string) => void; placeholder?: string }) =>
        createElement("select", { ...props, onChange: (event: { target: { value: string } }) => onChange(event.target.value) }, [
            createElement("option", { key: "blank", value: "" }, placeholder || "选择"),
            ...options.map((option) => createElement("option", { key: option.value, value: option.value }, option.label)),
        ]),
}));
mock.module("@/components/ui/product/app-modal", () => ({
    AppModal: ({ children, onCancel, closable }: { children: ReactNode; onCancel: () => void; closable: boolean }) => (
        <section role="dialog" aria-label="宫格故事板">
            <button disabled={!closable} onClick={onCancel}>
                关闭故事板
            </button>
            {children}
        </section>
    ),
}));
mock.module("@/components/assets/asset-library-picker-modal", () => ({ AssetLibraryPickerModal: () => null }));
mock.module("@/stores/use-user-store", () => ({ useUserStore: userStore }));
const userScope = await import("@/lib/user-scope");
mock.module("@/lib/user-scope", () => ({ ...userScope, getActiveUserScope: () => userStore.getState().user.id }));
mock.module("@/pages/projects/drama-model-picker", () => ({ DramaModelPicker: () => <button>模型选择器</button> }));
mock.module("@/pages/projects/drama-shared", () => ({ MediaThumb: ({ resourceId, alt }: { resourceId: string; alt: string }) => <img data-resource={resourceId} alt={alt} /> }));
mock.module("@/services/api/drama", () => ({ getDrama: async () => ({ production: { settings: { aspectRatio: "16:9", models: { image: { channelId: "channel", modelKey: "image" } } } } }) }));
mock.module("@/services/api/drama-storyboard", () => ({
    listDramaStoryboards: async () => [],
    createDramaStoryboard: async (_projectId: string, input: DramaStoryboardCreate) => {
        creations.push(structuredClone(input));
        server = { ...server, rows: input.rows, columns: input.columns, shotIds: input.shotIds, config: { ...input.config, prompt: "真实镜头对应的生成提示词" } };
        return structuredClone(server);
    },
    getDramaStoryboard: async () => {
        if (readsFail) throw new Error("读取失败");
        return structuredClone(server);
    },
    preflightDramaStoryboard: async () => ({ boardId: server.id, revision: server.revision, baseRevision: 9, ready: true, priced: true, amountMicrocredits: 2_000_000, estimated: false, confirmationToken: "quoted" }),
    executeDramaStoryboard: (_projectId: string, boardId: string, request: DramaShotMediaAction) => {
        const result = deferred<{ id: string; status: string }>();
        executions.push({ boardId, request: structuredClone(request), result });
        return result.promise;
    },
    splitDramaStoryboard: async (_projectId: string, _boardId: string, input: { expectedRevision: number }) => {
        splitCalls.push(input);
        server = {
            ...server,
            status: "split",
            revision: server.revision + 1,
            cells: server.shotIds.map((id, index) => ({
                id: `cell-${index}`,
                projectId: "project-a",
                boardId: server.id,
                index,
                row: Math.floor(index / server.columns),
                column: index % server.columns,
                shotId: id,
                parentResourceId: "real-parent",
                resourceId: `real-crop-${index}`,
                x: index * 10,
                y: 0,
                width: 100,
                height: 100,
                mediaRevision: 7,
                current: false,
            })),
        };
        return structuredClone(server);
    },
    adoptDramaStoryboardCell: async (_projectId: string, _boardId: string, input: { expectedRevision: number; expectedMediaRevision: number; cellId: string }) => {
        adoptCalls.push(input);
        server.cells = server.cells.map((cell) => ({ ...cell, current: cell.id === input.cellId }));
        return {};
    },
}));
const { ApiError } = await import("@/services/api/request");
const { WorkflowStoryboardDialog } = await import("@/pages/projects/workflow-storyboard-dialog");
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
async function mount() {
    creations.length = executions.length = splitCalls.length = adoptCalls.length = 0;
    closes = 0;
    readsFail = false;
    server = {
        id: "real-board",
        projectId: "project-a",
        episodeId: "episode",
        rows: 2,
        columns: 2,
        revision: 1,
        status: "draft",
        sourceWidth: 0,
        sourceHeight: 0,
        createdAt: "",
        shotIds: [],
        cells: [],
        config: { model: {}, prompt: "", operation: "text_to_image", aspectRatio: "1:1", resolution: "1K", generateAudio: false, referenceResourceIds: [] },
    };
    userStore.setState({ user: { id: "user-a" } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const shots = Array.from({ length: 4 }, (_, position) => ({ id: `shot-${position}`, projectId: "project-a", episodeId: "episode", position })) as DramaShot[];
    let projectId = "project-a";
    const render = () =>
        root.render(
            <QueryClientProvider client={client}>
                <WorkflowStoryboardDialog open projectId={projectId} shots={shots} onClose={() => closes++} />
            </QueryClientProvider>,
        );
    await act(async () => {
        render();
        await settle();
    });
    await act(settle);
    return {
        host,
        client,
        update: async (patch: Partial<DramaStoryboard>) => {
            server = { ...server, ...patch };
            await act(async () => {
                client.setQueryData(["drama-storyboard", "user-a", "project-a", server.id], structuredClone(server));
                await settle();
            });
        },
        rerender: async (id: string) => {
            projectId = id;
            await act(async () => {
                render();
                await settle();
            });
        },
        close: async () => {
            await act(async () => root.unmount());
            client.clear();
            host.remove();
        },
    };
}
function button(host: HTMLElement, text: string) {
    const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text);
    if (!result) throw new Error(`找不到 ${text}: ${host.textContent}`);
    return result;
}
async function click(host: HTMLElement, text: string) {
    await act(async () => {
        button(host, text).click();
        await settle();
    });
}
async function finish(index = executions.length - 1) {
    server.status = "queued";
    await act(async () => {
        executions[index].result.resolve({ id: "real-task", status: "queued" });
        await settle();
    });
}
afterAll(() => browser.happyDOM.abort());

test("预检只创建真实镜头范围草稿，明确确认才单次生成", async () => {
    const view = await mount();
    try {
        await click(view.host, "预检生成故事板");
        expect(creations).toHaveLength(1);
        expect(creations[0].shotIds).toEqual(["shot-0", "shot-1", "shot-2", "shot-3"]);
        expect(executions).toHaveLength(0);
        expect(view.host.textContent).toContain("预计 2 积分");
        await act(async () => {
            const confirm = button(view.host, "确认生成故事板");
            confirm.click();
            confirm.click();
            await settle();
        });
        expect(executions).toHaveLength(1);
        expect(executions[0]).toMatchObject({ boardId: "real-board", request: { expectedRevision: 1, baseRevision: 9, confirmationToken: "quoted" } });
        await finish();
        expect(view.host.textContent).toContain("故事板已提交，排队中");
    } finally {
        await view.close();
    }
});

test("未知回执保持同一标识核对并阻止关闭", async () => {
    const view = await mount();
    try {
        await click(view.host, "预检生成故事板");
        await click(view.host, "确认生成故事板");
        await act(async () => {
            executions[0].result.reject(new Error("连接中断"));
            await settle();
        });
        expect(button(view.host, "关闭故事板").disabled).toBe(true);
        await click(view.host, "核对故事板提交");
        expect(executions[1].request).toEqual(executions[0].request);
        await finish();
        expect(button(view.host, "关闭故事板").disabled).toBe(false);
    } finally {
        await view.close();
    }
});

test("明确拒绝不锁住页面，已提交但刷新失败保留入队提示", async () => {
    const view = await mount();
    try {
        await click(view.host, "预检生成故事板");
        await click(view.host, "确认生成故事板");
        await act(async () => {
            executions[0].result.reject(new ApiError("报价变化", { status: 409 }));
            await settle();
        });
        expect(view.host.textContent).not.toContain("核对故事板提交");
        expect(button(view.host, "关闭故事板").disabled).toBe(false);
        await click(view.host, "预检当前故事板");
        await click(view.host, "确认生成故事板");
        readsFail = true;
        await finish();
        expect(view.host.textContent).toContain("任务已提交，状态暂未刷新");
        expect(view.host.textContent).toContain("故事板已提交，排队中");
        expect(executions).toHaveLength(2);
    } finally {
        await view.close();
    }
});

test("真实原图显式裁切后才展示独立资源，采用传递双版本", async () => {
    const view = await mount();
    try {
        await click(view.host, "预检生成故事板");
        await view.update({ status: "image_ready", resourceId: "real-parent", revision: 3, sourceWidth: 200, sourceHeight: 200 });
        expect(splitCalls).toHaveLength(0);
        expect(adoptCalls).toHaveLength(0);
        await click(view.host, "裁切为独立图片");
        expect(splitCalls).toEqual([{ expectedRevision: 3 }]);
        expect(view.host.querySelectorAll('[data-resource^="real-crop-"]')).toHaveLength(4);
        await click(view.host, "采用到此镜头");
        expect(adoptCalls).toEqual([{ expectedRevision: 4, expectedMediaRevision: 7, cellId: "cell-0" }]);
        expect(button(view.host, "已采用").disabled).toBe(true);
    } finally {
        await view.close();
    }
});

test("原稿过期时保留可见分图并禁止继续采用", async () => {
    const view = await mount();
    try {
        await click(view.host, "预检生成故事板");
        await view.update({ status: "image_ready", resourceId: "real-parent", revision: 3 });
        await click(view.host, "裁切为独立图片");
        await view.update({ status: "stale", error: "镜头原稿已变化" });
        expect(view.host.querySelectorAll('[data-resource^="real-crop-"]')).toHaveLength(4);
        expect(button(view.host, "采用到此镜头").disabled).toBe(true);
        expect(view.host.textContent).toContain("镜头原稿已变化");
        expect(adoptCalls).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("切换作品后旧生成响应不会更新新作品", async () => {
    const view = await mount();
    try {
        await click(view.host, "预检生成故事板");
        await click(view.host, "确认生成故事板");
        await view.rerender("project-b");
        await finish();
        expect(view.host.textContent).not.toContain("故事板已提交");
        expect(button(view.host, "关闭故事板").disabled).toBe(false);
    } finally {
        await view.close();
    }
});
