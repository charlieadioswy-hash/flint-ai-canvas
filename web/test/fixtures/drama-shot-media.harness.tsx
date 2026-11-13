import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaShot } from "@/services/api/drama";
import type { DramaShotMedia, DramaShotMediaAction, DramaShotMediaConfig, DramaShotMediaKind, DramaShotMediaPreflight } from "@/services/api/drama-shot-media";

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
type ExecuteCall = { projectId: string; shotId: string; kind: DramaShotMediaKind; input: DramaShotMediaAction; result: Deferred<{ id: string; status: string }> };
const saves: { projectId: string; shotId: string; kind: DramaShotMediaKind; input: { expectedRevision: number; config: DramaShotMediaConfig } }[] = [];
const checks: { projectId: string; shotId: string; kind: DramaShotMediaKind; input: DramaShotMediaAction }[] = [];
const executions: ExecuteCall[] = [];
const adoptions: { expectedRevision: number; takeId: string }[] = [];
let confirmations: { onOk: () => void }[] = [];
let readsFail = false;
let closes = 0;
let changed = 0;
let server: Record<DramaShotMediaKind, DramaShotMedia>;
const Input = Object.assign(({ onChange, ...props }: Record<string, unknown>) => createElement("input", { ...props, onInput: onChange }), {
    TextArea: ({ onChange, autoSize: _autoSize, ...props }: Record<string, unknown>) => createElement("textarea", { ...props, onInput: onChange }),
});
mock.module("antd", () => ({
    App: { useApp: () => ({ modal: { confirm: (props: { onOk: () => void }) => confirmations.push(props) } }) },
    Button: ({ children, loading: _loading, type: _type, size: _size, icon: _icon, ...props }: Record<string, unknown>) => createElement("button", props, children as ReactNode),
    Input,
    InputNumber: ({ onChange, ...props }: { onChange: (value: number) => void }) => createElement("input", { ...props, type: "number", onInput: (event: { target: { value: string } }) => onChange(Number(event.target.value)) }),
    Select: ({ options, onChange, ...props }: { options: { value: string; label: string }[]; onChange: (value: string) => void }) =>
        createElement(
            "select",
            { ...props, onChange: (event: { target: { value: string } }) => onChange(event.target.value) },
            options.map((option) => createElement("option", { key: option.value, value: option.value }, option.label)),
        ),
    Switch: ({ checked, onChange, ...props }: { checked: boolean; onChange: (value: boolean) => void }) =>
        createElement("input", { ...props, type: "checkbox", checked, onChange: (event: { target: { checked: boolean } }) => onChange(event.target.checked) }),
}));
mock.module("@/components/ui/product/app-modal", () => ({
    AppModal: ({ title, children, onCancel, closable }: { title: string; children: ReactNode; onCancel: () => void; closable: boolean }) => (
        <section role="dialog" aria-label={title}>
            <button disabled={!closable} onClick={onCancel}>
                关闭媒体
            </button>
            {children}
        </section>
    ),
}));
mock.module("@/components/assets/asset-library-picker-modal", () => ({
    AssetLibraryPickerModal: ({ open, title, onConfirm, onClose }: { open: boolean; title: string; onConfirm: (ids: string[], items: unknown[]) => void; onClose: () => void }) =>
        open ? (
            <section role="dialog" aria-label={title}>
                <button onClick={() => onConfirm(["chosen"], [{ asset: { kind: "image", data: { storageKey: "resource:arbitrary-image" } } }])}>选择库中图片</button>
                <button onClick={onClose}>取消选择</button>
            </section>
        ) : null,
}));
mock.module("@/stores/use-user-store", () => ({ useUserStore: userStore }));
const userScope = await import("@/lib/user-scope");
mock.module("@/lib/user-scope", () => ({ ...userScope, getActiveUserScope: () => userStore.getState().user.id }));
mock.module("@/pages/projects/drama-model-picker", () => ({ useDramaModelCatalog: () => ({ data: { options: { image: [], video: [] } } }), DramaModelPicker: () => <button>模型选择器</button> }));
mock.module("@/pages/projects/drama-shared", () => ({
    MediaThumb: ({ resourceId, alt }: { resourceId: string; alt: string }) => <img data-resource={resourceId} alt={alt} />,
    useResourceMediaUrl: (id: string) => (id ? `https://test.invalid/${id}` : ""),
}));
mock.module("@/services/api/drama-shot-media", () => ({
    getDramaShotMedia: async (_projectId: string, _shotId: string, kind: DramaShotMediaKind) => {
        if (readsFail) throw new Error("状态读取失败");
        return structuredClone(server[kind]);
    },
    saveDramaShotMedia: async (projectId: string, shotId: string, kind: DramaShotMediaKind, input: { expectedRevision: number; config: DramaShotMediaConfig }) => {
        saves.push({ projectId, shotId, kind, input: structuredClone(input) });
        server[kind] = { ...server[kind], id: `media-${kind}`, revision: input.expectedRevision + 1, config: structuredClone(input.config) };
        return structuredClone(server[kind]);
    },
    preflightDramaShotMedia: async (projectId: string, shotId: string, kind: DramaShotMediaKind, input: DramaShotMediaAction): Promise<DramaShotMediaPreflight> => {
        checks.push({ projectId, shotId, kind, input: structuredClone(input) });
        return { shotId, kind, revision: server[kind].revision, baseRevision: 9, ready: true, amountMicrocredits: 1_000_000, priced: true, estimated: false, confirmationToken: "quoted", config: structuredClone(server[kind].config) };
    },
    executeDramaShotMedia: (projectId: string, shotId: string, kind: DramaShotMediaKind, input: DramaShotMediaAction) => {
        const result = deferred<{ id: string; status: string }>();
        executions.push({ projectId, shotId, kind, input: structuredClone(input), result });
        return result.promise;
    },
    adoptDramaShotMedia: async (_projectId: string, _shotId: string, kind: DramaShotMediaKind, input: { expectedRevision: number; takeId: string }) => {
        adoptions.push(input);
        const selected = server[kind].takes.find((take) => take.id === input.takeId)!;
        server[kind] = { ...server[kind], revision: server[kind].revision + 1, currentTakeId: selected.id, resourceId: selected.resourceId, takes: server[kind].takes.map((take) => ({ ...take, current: take.id === selected.id })) };
        return structuredClone(server[kind]);
    },
}));
const { ApiError } = await import("@/services/api/request");
const { WorkflowShotMediaDialog } = await import("@/pages/projects/workflow-shot-media-dialog");
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
function media(kind: DramaShotMediaKind): DramaShotMedia {
    return {
        id: `media-${kind}`,
        projectId: "project-a",
        episodeId: "episode",
        shotId: "real-shot",
        kind,
        revision: 3,
        status: "idle",
        takes: [],
        config: {
            model: { channelId: "channel", modelKey: "model" },
            prompt: `${kind} 原始提示词`,
            operation: kind === "image" ? "text_to_image" : "text_to_video",
            aspectRatio: "9:16",
            resolution: kind === "image" ? "1K" : "720p",
            seconds: 5,
            generateAudio: false,
            referenceResourceIds: [],
        },
    };
}
async function mount() {
    saves.length = checks.length = executions.length = adoptions.length = 0;
    confirmations = [];
    readsFail = false;
    closes = changed = 0;
    server = { image: media("image"), video: media("video") };
    userStore.setState({ user: { id: "user-a" } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    let projectId = "project-a";
    const render = () =>
        root.render(
            <QueryClientProvider client={client}>
                <WorkflowShotMediaDialog open projectId={projectId} shot={{ id: "real-shot", projectId, episodeId: "episode", position: 1 } as DramaShot} onClose={() => closes++} onChanged={() => changed++} />
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
    const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === text);
    if (!found) throw new Error(`没有按钮 ${text}: ${host.textContent}`);
    return found;
}
async function click(host: HTMLElement, text: string) {
    await act(async () => {
        button(host, text).click();
        await settle();
    });
}
async function prompt(host: HTMLElement, value: string) {
    const input = host.querySelector<HTMLTextAreaElement>('[aria-label="镜头媒体提示词"]')!;
    await act(async () => {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await settle();
    });
}
async function rejectExecution(error: unknown, index = executions.length - 1) {
    await act(async () => {
        executions[index].result.reject(error);
        await settle();
    });
}
async function resolveExecution(index = executions.length - 1) {
    await act(async () => {
        executions[index].result.resolve({ id: "real-task", status: "queued" });
        await settle();
    });
}
afterAll(() => browser.happyDOM.abort());

test("保存预检不生成，确认以真实镜头和单次标识提交", async () => {
    const view = await mount();
    try {
        await prompt(view.host, "修改后的镜头提示词");
        await click(view.host, "预检生成");
        expect(saves).toHaveLength(1);
        expect(saves[0]).toMatchObject({ projectId: "project-a", shotId: "real-shot", kind: "image", input: { expectedRevision: 3, config: { prompt: "修改后的镜头提示词" } } });
        expect(checks[0].input).toEqual({ expectedRevision: 4 });
        expect(executions).toHaveLength(0);
        expect(view.host.textContent).toContain("预计 1 积分");
        await act(async () => {
            const confirm = button(view.host, "确认生成当前镜头");
            confirm.click();
            confirm.click();
            await settle();
        });
        expect(executions).toHaveLength(1);
        expect(executions[0]).toMatchObject({ projectId: "project-a", shotId: "real-shot", kind: "image", input: { expectedRevision: 4, baseRevision: 9, confirmationToken: "quoted" } });
        expect(executions[0].input.clientOperationId).toStartWith("shot-media:");
        await resolveExecution();
        expect(changed).toBe(1);
    } finally {
        await view.close();
    }
});

test("回执不确定保留提交标识并阻止关闭，版本变化仍能核对同次提交", async () => {
    const view = await mount();
    try {
        await click(view.host, "预检生成");
        await click(view.host, "确认生成当前镜头");
        await rejectExecution(new Error("连接中断"));
        const original = structuredClone(executions[0].input);
        expect(button(view.host, "关闭媒体").disabled).toBe(true);
        expect(button(view.host, "镜头视频").disabled).toBe(true);
        await act(async () => {
            view.client.setQueryData(["drama-shot-media", "user-a", "project-a", "real-shot", "image"], { ...server.image, revision: 4, status: "queued" });
            await settle();
        });
        expect(button(view.host, "核对提交结果").disabled).toBe(false);
        await click(view.host, "核对提交结果");
        expect(executions[1].input).toEqual(original);
        await resolveExecution();
        expect(button(view.host, "关闭媒体").disabled).toBe(false);
    } finally {
        await view.close();
    }
});

test("明确拒绝释放编辑锁，重新预检使用新的提交标识", async () => {
    const view = await mount();
    try {
        await click(view.host, "预检生成");
        await click(view.host, "确认生成当前镜头");
        await rejectExecution(new ApiError("报价已变化", { status: 409 }));
        expect(view.host.textContent).toContain("报价已变化");
        expect(view.host.textContent).not.toContain("核对提交结果");
        expect(button(view.host, "关闭媒体").disabled).toBe(false);
        await click(view.host, "预检生成");
        await click(view.host, "确认生成当前镜头");
        expect(executions[1].input.clientOperationId).not.toBe(executions[0].input.clientOperationId);
        await resolveExecution();
    } finally {
        await view.close();
    }
});

test("已收到任务回执而刷新失败时保留入队提示，不提供重复提交", async () => {
    const view = await mount();
    try {
        await click(view.host, "预检生成");
        await click(view.host, "确认生成当前镜头");
        readsFail = true;
        await resolveExecution();
        expect(view.host.textContent).toContain("已提交镜头图片，排队中");
        expect(view.host.textContent).toContain("任务已提交，最新进度暂未刷新");
        expect(view.host.textContent).not.toContain("确认生成当前镜头");
        expect(view.host.textContent).not.toContain("核对提交结果");
        expect(executions).toHaveLength(1);
    } finally {
        await view.close();
    }
});

test("脏配置切换类型先确认放弃，取消不会保存或生成", async () => {
    const view = await mount();
    try {
        await prompt(view.host, "尚未保存");
        await click(view.host, "镜头视频");
        expect(confirmations).toHaveLength(1);
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("尚未保存");
        expect(saves).toHaveLength(0);
        expect(executions).toHaveLength(0);
        await act(async () => {
            confirmations[0].onOk();
            await settle();
        });
        await act(settle);
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("video 原始提示词");
    } finally {
        await view.close();
    }
});

test("一次重新载入即采用新版本，后台更新保留脏草稿并阻止覆盖", async () => {
    const view = await mount();
    try {
        server.image = { ...server.image, revision: 4, config: { ...server.image.config, prompt: "远端新配置" } };
        await click(view.host, "重新载入");
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("远端新配置");
        await prompt(view.host, "本地未保存草稿");
        await act(async () => {
            view.client.setQueryData(["drama-shot-media", "user-a", "project-a", "real-shot", "image"], { ...server.image, revision: 5 });
            await settle();
        });
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("本地未保存草稿");
        expect(button(view.host, "保存配置").disabled).toBe(true);
        expect(button(view.host, "预检生成").disabled).toBe(true);
    } finally {
        await view.close();
    }
});

test("任意资产库图片可选作首尾帧，保存绑定当前真实镜头", async () => {
    const view = await mount();
    try {
        await click(view.host, "镜头视频");
        await act(settle);
        await click(view.host, "选择首帧");
        await click(view.host, "选择库中图片");
        await click(view.host, "选择尾帧");
        await click(view.host, "选择库中图片");
        await click(view.host, "保存配置");
        expect(saves[0]).toMatchObject({ projectId: "project-a", shotId: "real-shot", kind: "video", input: { config: { operation: "image_to_video", firstFrameResourceId: "arbitrary-image", lastFrameResourceId: "arbitrary-image" } } });
        expect(executions).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("切换作品后迟到提交不操作新作品或触发刷新", async () => {
    const view = await mount();
    try {
        await click(view.host, "预检生成");
        await click(view.host, "确认生成当前镜头");
        await view.rerender("project-b");
        await resolveExecution();
        expect(changed).toBe(0);
        expect(view.host.textContent).not.toContain("已提交镜头图片");
        expect(button(view.host, "关闭媒体").disabled).toBe(false);
    } finally {
        await view.close();
    }
});
