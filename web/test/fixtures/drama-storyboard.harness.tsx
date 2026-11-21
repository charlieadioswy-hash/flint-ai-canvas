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
const historyRanges: string[][] = [];
const shotIds = ["shot-0", "shot-1", "shot-2", "shot-3"];
const historyKey = ["drama-storyboards", "user-a", "project-a", "episode", shotIds];
const draftQuoteInputs: Omit<DramaStoryboardCreate, "clientOperationId">[] = [];
const executions: { boardId: string; request: DramaShotMediaAction; result: Deferred<{ id: string; status: string }> }[] = [];
const splitCalls: { expectedRevision: number }[] = [];
const adoptCalls: { expectedRevision: number; expectedMediaRevision: number; cellId: string }[] = [];
let quoteAmount = 2_000_000;
let nextPreflightAmount: number | undefined;
let quoteFailure = "";
let draftQuotes = 0;
let server: DramaStoryboard;
let closes = 0;
let readsFail = false;
let delayedRead: Deferred<DramaStoryboard> | undefined;
let historyReadsFail = false;
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
            options.some(({ value }) => value === "") ? null : createElement("option", { key: "blank", value: "" }, placeholder || "选择"),
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
mock.module("@/pages/projects/drama-model-picker", () => ({
    DramaModelPicker: ({ onChange }: { onChange: (model: { channelId: string; modelKey: string }) => void }) => <button onClick={() => onChange({ channelId: "channel", modelKey: "image-new" })}>模型选择器</button>,
    useDramaModelCatalog: () => ({
        data: {
            options: {
                image: [
                    {
                        choice: { channelId: "channel", modelKey: "image" },
                        defaultImageResolution: "1k",
                        imageSpecifications: [
                            { aspectRatio: "1:1", resolutions: ["1k", "2k"] },
                            { aspectRatio: "9:16", resolutions: ["2k"] },
                        ],
                    },
                    {
                        choice: { channelId: "channel", modelKey: "image-new" },
                        defaultImageResolution: "1k",
                        imageSpecifications: [
                            { aspectRatio: "4:3", resolutions: ["1k", "2k"] },
                            { aspectRatio: "1:1", resolutions: ["1k"] },
                        ],
                    },
                ],
            },
        },
    }),
}));
mock.module("@/pages/projects/drama-shared", () => ({ MediaThumb: ({ resourceId, alt }: { resourceId: string; alt: string }) => <img data-resource={resourceId} alt={alt} /> }));
mock.module("@/services/api/drama", () => ({ getDrama: async () => ({ production: { settings: { aspectRatio: "9:16", models: { image: { channelId: "channel", modelKey: "image" } } } } }) }));
mock.module("@/services/api/drama-storyboard", () => ({
    listDramaStoryboards: async (_projectId: string, _episodeId: string, shotIds: string[]) => {
        historyRanges.push(shotIds);
        if (historyReadsFail) throw new Error("读取故事板历史失败");
        return server.shotIds.length ? [{ ...structuredClone(server), id: "other-segment", shotIds: ["other-shot"] }, structuredClone(server)] : [];
    },
    createDramaStoryboard: async (_projectId: string, input: DramaStoryboardCreate) => {
        const replay = creations.some((request) => input.clientOperationId === request.clientOperationId);
        creations.push(structuredClone(input));
        if (!replay) {
            server = {
                ...server,
                id: creations.length === 1 ? server.id : `real-board-${creations.length}`,
                revision: 1,
                status: "draft",
                taskId: undefined,
                resourceId: undefined,
                cells: [],
                rows: input.rows,
                columns: input.columns,
                shotIds: input.shotIds,
                config: { ...input.config, prompt: "真实镜头对应的生成提示词" },
            };
        }
        return structuredClone(server);
    },
    getDramaStoryboard: async () => {
        if (readsFail) throw new Error("读取失败");
        if (delayedRead) return delayedRead.promise;
        return structuredClone(server);
    },
    quoteDramaStoryboard: async (_projectId: string, input: Omit<DramaStoryboardCreate, "clientOperationId">) => {
        draftQuotes++;
        draftQuoteInputs.push(structuredClone(input));
        if (quoteFailure) throw new Error(quoteFailure);
        return { boardId: "", revision: 0, baseRevision: 9, ready: true, priced: true, amountMicrocredits: quoteAmount, estimated: false, confirmationToken: "", scopeHash: "same-scope" };
    },
    preflightDramaStoryboard: async () => {
        quoteAmount = nextPreflightAmount ?? quoteAmount;
        return { boardId: server.id, revision: server.revision, baseRevision: 9, ready: !server.taskId, priced: true, amountMicrocredits: quoteAmount, estimated: false, confirmationToken: "quoted", scopeHash: "same-scope" };
    },
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
    draftQuoteInputs.length = historyRanges.length = 0;
    closes = 0;
    readsFail = false;
    delayedRead = undefined;
    historyReadsFail = false;
    quoteAmount = 2_000_000;
    nextPreflightAmount = undefined;
    quoteFailure = "";
    draftQuotes = 0;
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
    const shots = shotIds.map((id, position) => ({ id, projectId: "project-a", episodeId: "episode", position })) as DramaShot[];
    let projectId = "project-a";
    let open = true;
    const render = () =>
        root.render(
            <QueryClientProvider client={client}>
                <WorkflowStoryboardDialog open={open} projectId={projectId} shots={shots} onClose={() => closes++} />
            </QueryClientProvider>,
        );
    await act(async () => {
        render();
        await settle();
    });
    await act(settle);
    await waitPrice(host);
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
        setOpen: async (value: boolean) => {
            open = value;
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
async function waitPrice(host: HTMLElement) {
    for (let attempt = 0; attempt < 80; attempt++) {
        const generate = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.startsWith("生成图片 - "));
        if (generate?.textContent?.includes("积分") && !generate.disabled) return;
        await act(settle);
    }
    throw new Error(`故事板报价未就绪: ${host.textContent}`);
}
async function click(host: HTMLElement, text: string) {
    await act(async () => {
        button(host, text).click();
        await settle();
    });
}
async function finish(index = executions.length - 1) {
    server = { ...server, status: "queued", taskId: "real-task", revision: server.revision + 1 };
    await act(async () => {
        executions[index].result.resolve({ id: "real-task", status: "queued" });
        await settle();
    });
}
afterAll(() => browser.happyDOM.abort());

test("自动报价不创建草稿，点击按真实镜头范围单次生成", async () => {
    const view = await mount();
    try {
        await waitPrice(view.host);
        expect(creations).toHaveLength(0);
        expect(draftQuotes).toBeGreaterThan(0);
        expect(executions).toHaveLength(0);
        expect(view.host.textContent).toContain("生成图片 - 2积分");
        expect(view.host.textContent).not.toContain("确认生成");
        await act(async () => {
            const confirm = button(view.host, "生成图片 - 2积分");
            confirm.click();
            confirm.click();
            await settle();
        });
        expect(executions).toHaveLength(1);
        expect(creations).toHaveLength(1);
        expect(creations[0].shotIds).toEqual(["shot-0", "shot-1", "shot-2", "shot-3"]);
        expect(executions[0]).toMatchObject({ boardId: "real-board", request: { expectedRevision: 1, baseRevision: 9, confirmationToken: "quoted" } });
        await finish();
        expect(view.host.textContent).toContain("2×2 · 排队中");
    } finally {
        await view.close();
    }
});

test("故事板按模型联动画幅与分辨率，报价和生成使用已选择的规格", async () => {
    const view = await mount();
    try {
        const ratio = view.host.querySelector<HTMLSelectElement>('select[aria-label="故事板整图画幅"]')!;
        const resolution = view.host.querySelector<HTMLSelectElement>('select[aria-label="故事板整图分辨率"]')!;
        const values = (select: HTMLSelectElement) => [...select.options].map((option) => option.value).filter(Boolean);
        const select = async (control: HTMLSelectElement, value: string) => {
            await act(async () => {
                control.value = value;
                control.dispatchEvent(new Event("change", { bubbles: true }));
                await settle();
            });
        };
        expect(ratio.value).toBe("9:16");
        expect(values(ratio)).toEqual(["1:1", "9:16"]);
        expect(values(resolution)).toEqual(["2k"]);
        expect(resolution.value).toBe("2k");
        expect(draftQuoteInputs.at(-1)?.config).toMatchObject({ aspectRatio: "9:16", resolution: "2k" });
        await select(ratio, "1:1");
        expect(values(resolution)).toEqual(["1k", "2k"]);
        expect(resolution.value).toBe("2k");
        await select(resolution, "1k");
        await select(ratio, "9:16");
        expect(resolution.value).toBe("2k");
        await click(view.host, "模型选择器");
        expect(values(ratio)).toEqual(["4:3", "1:1"]);
        expect(ratio.value).toBe("4:3");
        expect(resolution.value).toBe("2k");
        await select(ratio, "1:1");
        expect(values(resolution)).toEqual(["1k"]);
        expect(resolution.value).toBe("1k");
        await select(ratio, "4:3");
        await select(resolution, "2k");
        const input = view.host.querySelector<HTMLTextAreaElement>('[aria-label="故事板补充要求"]')!;
        await act(async () => {
            input.value = "保持镜头人物比例与光影一致";
            input.dispatchEvent(new Event("input", { bubbles: true }));
            await settle();
        });
        await waitPrice(view.host);
        expect(creations).toHaveLength(0);
        expect(executions).toHaveLength(0);
        expect(draftQuoteInputs.at(-1)?.config).toMatchObject({
            model: { channelId: "channel", modelKey: "image-new" },
            aspectRatio: "4:3",
            resolution: "2k",
            prompt: "保持镜头人物比例与光影一致",
        });
        expect([...view.host.querySelectorAll("button")].some((item) => item.textContent?.includes("保存配置"))).toBe(false);
        await click(view.host, "生成图片 - 2积分");
        expect(creations).toHaveLength(1);
        expect(creations[0].config).toEqual(draftQuoteInputs.at(-1)!.config);
        expect(executions).toHaveLength(1);
        await finish();
    } finally {
        await view.close();
    }
});

test("未知回执保持同一标识核对并阻止关闭", async () => {
    const view = await mount();
    try {
        await waitPrice(view.host);
        await click(view.host, "生成图片 - 2积分");
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

test("明确拒绝不锁住页面，已提交但刷新失败保留排队状态", async () => {
    const view = await mount();
    try {
        await waitPrice(view.host);
        await click(view.host, "生成图片 - 2积分");
        await act(async () => {
            executions[0].result.reject(new ApiError("报价变化", { status: 409 }));
            await settle();
        });
        expect(view.host.textContent).not.toContain("核对故事板提交");
        expect(button(view.host, "关闭故事板").disabled).toBe(false);
        await waitPrice(view.host);
        await click(view.host, "生成图片 - 2积分");
        readsFail = true;
        await finish();
        expect(view.host.textContent).toContain("故事板最新状态读取失败");
        expect(view.host.textContent).toContain("2×2 · 排队中");
        expect(executions).toHaveLength(2);
    } finally {
        await view.close();
    }
});

test("收到任务回执立即显示排队并更新底部队列，无需等待故事板详情", async () => {
    const view = await mount();
    try {
        await click(view.host, "生成图片 - 2积分");
        const summaryKey = ["drama", "project-a"];
        const jobsKey = [...summaryKey, "jobs", { status: "active" }];
        view.client.setQueryData(summaryKey, {});
        view.client.setQueryData(jobsKey, { jobs: [] });
        delayedRead = deferred<DramaStoryboard>();
        await finish();
        expect(view.host.textContent).toContain("2×2 · 排队中");
        expect(button(view.host, "关闭故事板").disabled).toBe(false);
        expect(view.client.getQueryState(summaryKey)?.isInvalidated).toBe(true);
        expect(view.client.getQueryState(jobsKey)?.isInvalidated).toBe(true);
        await act(async () => {
            delayedRead?.resolve({ ...server, status: "image_ready", resourceId: "real-parent", revision: 3 });
            await settle();
        });
        expect(view.host.textContent).toContain("2×2 · 原图已就绪");
        expect(view.host.querySelector('[data-resource="real-parent"]')).not.toBeNull();
    } finally {
        await view.close();
    }
});

test("重开故事板时恢复本段最近提交，历史缓存为空也能找回", async () => {
    const view = await mount();
    try {
        await click(view.host, "生成图片 - 2积分");
        await finish();
        await view.setOpen(false);
        view.client.setQueryData(historyKey, []);
        server = { ...server, status: "image_ready", resourceId: "real-parent", revision: 3 };
        await view.setOpen(true);
        for (let attempt = 0; attempt < 50 && !view.host.querySelector('[data-resource="real-parent"]'); attempt++) await act(settle);
        expect(view.host.textContent).toContain("2×2 · 原图已就绪");
        expect(view.host.querySelector('[data-resource="real-parent"]')).not.toBeNull();
        expect(view.host.querySelector('option[value="other-segment"]')).toBeNull();
        expect(historyRanges.at(-1)).toEqual(shotIds);
        await click(view.host, "新建故事板");
        await waitPrice(view.host);
        expect(view.host.textContent).toContain("选择本段镜头");
        expect(executions).toHaveLength(1);
    } finally {
        await view.close();
    }
});

test("首次读取故事板历史失败后可刷新恢复排队任务", async () => {
    const view = await mount();
    try {
        await click(view.host, "生成图片 - 2积分");
        await finish();
        await view.setOpen(false);
        view.client.setQueryData(historyKey, []);
        historyReadsFail = true;
        await view.setOpen(true);
        for (let attempt = 0; attempt < 50 && !view.host.textContent?.includes("读取历史故事板失败"); attempt++) await act(settle);
        expect(view.host.textContent).toContain("读取历史故事板失败");
        historyReadsFail = false;
        await click(view.host, "刷新状态");
        expect(view.host.textContent).toContain("2×2 · 排队中");
        expect(executions).toHaveLength(1);
    } finally {
        await view.close();
    }
});

test("同一弹窗按原配置重做会创建独立故事板并提交生成", async () => {
    const view = await mount();
    try {
        await click(view.host, "生成图片 - 2积分");
        await finish();
        await view.update({ status: "image_ready", resourceId: "real-parent", revision: 3 });
        await click(view.host, "新建故事板");
        await waitPrice(view.host);
        await click(view.host, "生成图片 - 2积分");
        expect(creations).toHaveLength(2);
        expect(creations[1].config).toEqual(creations[0].config);
        expect(creations[1].clientOperationId).not.toBe(creations[0].clientOperationId);
        expect(executions.map(({ boardId }) => boardId)).toEqual(["real-board", "real-board-2"]);
        await finish();
    } finally {
        await view.close();
    }
});

test("有旧草稿缓存且详情读取失败时，按历史中的在途任务继续轮询", async () => {
    const view = await mount();
    try {
        await click(view.host, "生成图片 - 2积分");
        const staleDraft = structuredClone(server);
        await finish();
        await view.setOpen(false);
        view.client.setQueryData(["drama-storyboard", "user-a", "project-a", server.id], staleDraft);
        view.client.setQueryData(historyKey, []);
        readsFail = true;
        await view.setOpen(true);
        for (let attempt = 0; attempt < 50 && !view.host.textContent?.includes("故事板最新状态读取失败"); attempt++) await act(settle);
        expect(view.host.querySelector("strong[role=status]")?.textContent).toBe("2×2 · 排队中");
        expect(view.host.textContent).toContain("故事板最新状态读取失败");
        readsFail = false;
        server = { ...server, status: "running" };
        for (let attempt = 0; attempt < 450 && view.host.querySelector("strong[role=status]")?.textContent !== "2×2 · 生成中"; attempt++) await act(settle);
        expect(view.host.querySelector("strong[role=status]")?.textContent).toBe("2×2 · 生成中");
        expect(view.host.textContent).not.toContain("故事板最新状态读取失败");
        expect(executions).toHaveLength(1);
    } finally {
        await view.close();
    }
});

test("真实原图显式裁切后才展示独立资源，采用传递双版本", async () => {
    const view = await mount();
    try {
        await waitPrice(view.host);
        await click(view.host, "生成图片 - 2积分");
        await finish();
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
        await waitPrice(view.host);
        await click(view.host, "生成图片 - 2积分");
        await finish();
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
        await waitPrice(view.host);
        await click(view.host, "生成图片 - 2积分");
        await view.rerender("project-b");
        await finish();
        expect(view.host.textContent).not.toContain("2×2 · 排队中");
        expect(button(view.host, "关闭故事板").disabled).toBe(false);
    } finally {
        await view.close();
    }
});

test("故事板变价先更新按钮，重复点击不按未展示新价执行", async () => {
    const view = await mount();
    try {
        nextPreflightAmount = 3_000_000;
        await click(view.host, "生成图片 - 2积分");
        expect(creations).toHaveLength(1);
        expect(executions).toHaveLength(0);
        expect(view.host.textContent).toContain("费用或生成范围已更新");
        await waitPrice(view.host);
        await click(view.host, "生成图片 - 3积分");
        expect(creations).toHaveLength(1);
        expect(executions).toHaveLength(1);
        await finish();
    } finally {
        await view.close();
    }
});

test("草稿报价失败不给生成入口，也不创建故事板历史", async () => {
    const view = await mount();
    try {
        quoteFailure = "故事板暂无法计价";
        const input = view.host.querySelector<HTMLTextAreaElement>('[aria-label="故事板补充要求"]')!;
        await act(async () => {
            input.value = "待保存的构图要求";
            input.dispatchEvent(new Event("input", { bubbles: true }));
            await settle();
        });
        await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
        expect(button(view.host, "生成图片 - 暂无报价").disabled).toBe(true);
        expect(view.host.textContent).toContain("故事板暂无法计价");
        expect(creations).toHaveLength(0);
        expect(executions).toHaveLength(0);
    } finally {
        await view.close();
    }
});
