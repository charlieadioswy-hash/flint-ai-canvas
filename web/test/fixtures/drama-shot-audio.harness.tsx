import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, StrictMode, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaJob, DramaJobDetail, DramaShot } from "@/services/api/drama";
import type { DramaShotMedia, DramaShotMediaAction, DramaShotMediaConfig } from "@/services/api/drama-shot-media";

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
const saves: { kind: string; input: { expectedRevision: number; config: DramaShotMediaConfig } }[] = [];
const checks: { kind: string; action: DramaShotMediaAction }[] = [];
const executions: { kind: string; action: DramaShotMediaAction; result: Deferred<unknown> }[] = [];
const adoptions: { kind: string; input: { expectedRevision: number; takeId: string } }[] = [];
const downloads: { id: string; name: string }[] = [];
let server: DramaShotMedia;
let available = true;
let changed = 0;
let paused = 0;
browser.HTMLMediaElement.prototype.pause = function () {
    paused++;
};
browser.HTMLMediaElement.prototype.load = function () {};
const Input = { TextArea: ({ onChange, ...props }: Record<string, unknown>) => createElement("textarea", { ...props, onInput: onChange }) };
mock.module("antd", () => ({
    App: { useApp: () => ({ message: {} }) },
    Button: ({ children, loading: _loading, type: _type, ...props }: Record<string, unknown>) => createElement("button", props, children as ReactNode),
    Input,
    Select: ({ options, onChange, ...props }: { options: { value: string; label: string }[]; onChange: (value: string) => void }) =>
        createElement(
            "select",
            { ...props, onChange: (event: { target: { value: string } }) => onChange(event.target.value) },
            createElement("option", { value: "" }, "选择音色"),
            options.map((option) => createElement("option", { key: option.value, value: option.value }, option.label)),
        ),
}));
mock.module("@/components/ui/product/app-modal", () => ({
    AppModal: ({ open, children, onCancel }: { open: boolean; children: ReactNode; onCancel: () => void }) =>
        open ? (
            <section role="dialog">
                <button onClick={onCancel}>关闭任务详情</button>
                {children}
            </section>
        ) : null,
}));
mock.module("@/components/ui/base/tooltip/ant-tooltip", () => ({ AntTooltip: ({ children }: { children: ReactNode }) => children }));
mock.module("@/components/model-picker", () => ({ ModelPicker: ({ onChange }: { onChange: (model: string) => void }) => <button onClick={() => onChange("audio-system")}>选择语音模型</button> }));
mock.module("@/lib/drama/model-choice", () => ({
    dramaChoiceToModel: (_config: unknown, _mode: string, choice: { modelKey?: string }) => choice.modelKey || "",
    modelToDramaChoice: (_config: unknown, model: string) => (model === "audio-system" ? { channelId: "system", modelKey: model } : undefined),
}));
mock.module("@/lib/audio-generation", () => ({ audioVoiceOptionsForConfig: () => [{ value: "alloy", label: "Alloy" }] }));
mock.module("@/stores/use-config-store", () => ({ useEffectiveConfig: () => ({}), selectableModelsByCapability: () => (available ? ["audio-system"] : []) }));
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
mock.module("@/pages/projects/drama-shared", () => ({
    formatCredits: String,
    MediaThumb: () => null,
    useResourceMediaUrl: (id: string) => (id ? `https://test.invalid/${id}.mp3` : ""),
    downloadResource: async (id: string, name: string) => {
        downloads.push({ id, name });
    },
}));
mock.module("@/services/api/resources", () => ({ getResource: async (id: string) => ({ id, mimeType: "audio/wav" }) }));
mock.module("@/services/api/drama-shot-media", () => ({
    getDramaShotMedia: async () => structuredClone(server),
    saveDramaShotMedia: async (_projectId: string, _shotId: string, kind: string, input: { expectedRevision: number; config: DramaShotMediaConfig }) => {
        saves.push({ kind, input: structuredClone(input) });
        server = { ...server, id: "slot-audio", revision: input.expectedRevision + 1, config: structuredClone(input.config) };
        return structuredClone(server);
    },
    preflightDramaShotMedia: async (_projectId: string, _shotId: string, kind: string, action: DramaShotMediaAction) => {
        checks.push({ kind, action });
        return { ready: true, priced: true, estimated: false, amountMicrocredits: 25, revision: server.revision, baseRevision: 3, confirmationToken: "audio-quote" };
    },
    executeDramaShotMedia: (_projectId: string, _shotId: string, kind: string, action: DramaShotMediaAction) => {
        const item = { kind, action: structuredClone(action), result: deferred<unknown>() };
        executions.push(item);
        return item.result.promise;
    },
    adoptDramaShotMedia: async (_projectId: string, _shotId: string, kind: string, input: { expectedRevision: number; takeId: string }) => {
        adoptions.push({ kind, input });
        const take = server.takes.find((item) => item.id === input.takeId)!;
        server = { ...server, revision: server.revision + 1, resourceId: take.resourceId, currentTakeId: take.id, status: "ready", takes: server.takes.map((item) => ({ ...item, current: item.id === take.id })) };
        return structuredClone(server);
    },
}));
const { WorkflowShotAudioEditor } = await import("@/pages/projects/workflow-shot-audio");
const { JobDetailModal } = await import("@/pages/projects/studio/job-detail");
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
function audioMedia(value: Partial<DramaShotMedia> = {}): DramaShotMedia {
    return {
        id: "",
        projectId: "project-a",
        episodeId: "episode-a",
        shotId: "shot-a",
        kind: "audio",
        revision: 0,
        status: "idle",
        config: { model: {}, prompt: "你好，我们出发吧。", operation: "audio", aspectRatio: "", resolution: "", generateAudio: false, referenceResourceIds: [] },
        takes: [],
        ...value,
    };
}
async function mount(options: { preserve?: boolean; media?: DramaShotMedia; noModels?: boolean } = {}) {
    if (!options.preserve) storage.clear();
    saves.length = checks.length = executions.length = adoptions.length = downloads.length = 0;
    changed = 0;
    paused = 0;
    available = !options.noModels;
    server = options.media || audioMedia();
    userStore.setState({ user: { id: "user-a" } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    let projectId = "project-a",
        shotId = "shot-a",
        userId = "user-a";
    const render = () =>
        root.render(
            <QueryClientProvider client={client}>
                <WorkflowShotAudioEditor
                    key={`${userId}:${projectId}:${shotId}`}
                    projectId={projectId}
                    shot={{ id: shotId, projectId, episodeId: "episode-a", position: 0 } as DramaShot}
                    userId={userId}
                    onChanged={() => changed++}
                    onDirtyChange={() => {}}
                    onBusyChange={() => {}}
                />
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
        switchScope: async () => {
            await act(async () => {
                projectId = "project-b";
                shotId = "shot-b";
                userId = "user-b";
                userStore.setState({ user: { id: userId } });
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
    const item = [...host.querySelectorAll<HTMLButtonElement>("button")].find((value) => value.textContent === text);
    if (!item) throw new Error(`未找到 ${text}: ${host.textContent}`);
    return item;
}
async function click(host: HTMLElement, text: string) {
    await act(async () => {
        button(host, text).click();
        await settle();
    });
}
async function chooseVoice(host: HTMLElement) {
    const input = host.querySelector<HTMLSelectElement>('[aria-label="镜头音频音色"]')!;
    await act(async () => {
        input.value = "alloy";
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await settle();
    });
}
async function prepare(host: HTMLElement) {
    await click(host, "选择语音模型");
    await chooseVoice(host);
    await click(host, "预检生成音频");
}

test("未配置语音模型时明确阻止生成", async () => {
    const ui = await mount({ noModels: true });
    expect(ui.host.textContent).toContain("当前没有可用的平台语音模型");
    expect(button(ui.host, "预检生成音频").disabled).toBe(true);
    expect(executions).toHaveLength(0);
    await ui.close();
});

test("任务详情切换音源和关闭时停止旧播放器，StrictMode 下仍可试听", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const job = { id: "shot-media:audio", kind: "shot_audio", status: "succeeded", label: "原分镜已移除", costMicrocredits: 0, attempt: 0, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" } satisfies DramaJob;
    const key = ["drama", "project-a", "job", job.id];
    const result = (id: string): DramaJobDetail => ({
        job,
        target: job.label,
        attempts: [
            {
                taskId: "audio",
                status: "succeeded",
                costMicrocredits: 0,
                at: job.createdAt,
                task: { id: "audio", status: "succeeded", params: {}, resourceIds: [id], resultMode: "audio", createdAt: job.createdAt },
            },
        ],
    });
    const render = (open: boolean) =>
        root.render(
            <StrictMode>
                <QueryClientProvider client={client}>
                    <JobDetailModal projectId="project-a" job={open ? job : undefined} onClose={() => render(false)} onLocate={() => {}} />
                </QueryClientProvider>
            </StrictMode>,
        );
    try {
        client.setQueryData(key, result("audio-first"));
        await act(async () => render(true));
        const first = host.querySelector("audio")!;
        expect(first.getAttribute("src")).toBe("https://test.invalid/audio-first.mp3");
        const beforeReplacement = paused;
        await act(async () => {
            client.setQueryData(key, result("audio-second"));
            await settle();
        });
        expect(paused).toBeGreaterThan(beforeReplacement);
        expect(first.hasAttribute("src")).toBe(false);
        const current = host.querySelector("audio")!;
        expect(current.getAttribute("src")).toBe("https://test.invalid/audio-second.mp3");
        const beforeClose = paused;
        await click(host, "关闭任务详情");
        expect(paused).toBeGreaterThan(beforeClose);
        expect(current.hasAttribute("src")).toBe(false);
        expect(host.querySelector("audio")).toBeNull();
    } finally {
        await act(async () => root.unmount());
        client.clear();
        host.remove();
    }
});

test("选择真实模型和音色后先保存与报价，再确认生成音频", async () => {
    const ui = await mount();
    await prepare(ui.host);
    expect(saves).toHaveLength(1);
    expect(saves[0].kind).toBe("audio");
    expect(saves[0].input.config.audioVoice).toBe("alloy");
    expect(saves[0].input.config.prompt).toBe("你好，我们出发吧。");
    expect(checks).toEqual([{ kind: "audio", action: { expectedRevision: 1 } }]);
    expect(executions).toHaveLength(0);
    await click(ui.host, "确认生成镜头音频");
    expect(executions[0].kind).toBe("audio");
    expect(executions[0].action.expectedRevision).toBe(1);
    expect(executions[0].action.baseRevision).toBe(3);
    expect(executions[0].action.confirmationToken).toBe("audio-quote");
    await act(async () => {
        executions[0].result.resolve({ id: "task-audio" });
        await settle();
    });
    expect(adoptions).toHaveLength(0);
    expect(ui.host.textContent).toContain("完成后请试听并手动采用");
    await ui.close();
});

test("音频历史可试听，只有显式采用后才成为当前音频", async () => {
    const current = audioMedia({ id: "audio-slot", revision: 2, status: "awaiting_adoption", takes: [{ id: "audio-take", taskId: "audio-task", version: 1, resourceId: "real-audio", status: "ready", current: false }] as DramaShotMedia["takes"] });
    const ui = await mount({ media: current });
    expect(ui.host.querySelector('audio[aria-label="试听镜头音频"]')?.getAttribute("src")).toContain("real-audio");
    expect(adoptions).toHaveLength(0);
    expect(ui.host.textContent).toContain("尚未采用镜头音频");
    await click(ui.host, "采用此音频版本");
    expect(adoptions).toEqual([{ kind: "audio", input: { expectedRevision: 2, takeId: "audio-take" } }]);
    await click(ui.host, "下载独立音频");
    expect(downloads).toEqual([{ id: "real-audio", name: "镜头1-音频.wav" }]);
    expect(ui.host.textContent).toContain("不会自动混入成片或剪映时间线");
    await ui.close();
});

test("音频提交回执不确定时重开仍复用原操作标识", async () => {
    const first = await mount();
    await prepare(first.host);
    await click(first.host, "确认生成镜头音频");
    const original = structuredClone(executions[0].action);
    await act(async () => {
        executions[0].result.reject(new Error("网络超时"));
        await settle();
    });
    await first.close();
    const second = await mount({ preserve: true });
    expect(button(second.host, "预检生成音频").disabled).toBe(true);
    await click(second.host, "核对音频提交结果");
    expect(executions[0].action).toEqual(original);
    await act(async () => {
        executions[0].result.resolve({ id: "same-audio-task" });
        await settle();
    });
    expect(storage.size).toBe(0);
    await second.close();
});

test("排队音频展示真实状态，不能重复提交", async () => {
    const ui = await mount({ media: audioMedia({ id: "audio-slot", revision: 2, status: "queued" }) });
    expect(ui.host.textContent).toContain("排队中");
    expect(button(ui.host, "预检生成音频").disabled).toBe(true);
    expect(executions).toHaveLength(0);
    await ui.close();
});

test("切换账号和镜头后迟到生成结果不能刷新新范围", async () => {
    const ui = await mount();
    await prepare(ui.host);
    await click(ui.host, "确认生成镜头音频");
    await ui.switchScope();
    await act(async () => {
        executions[0].result.resolve({ id: "old-audio-task" });
        await settle();
    });
    expect(changed).toBe(0);
    expect(ui.host.textContent).not.toContain("镜头音频已提交");
    expect(adoptions).toHaveLength(0);
    await ui.close();
});

test("退出音频编辑器停止试听播放器", async () => {
    const ui = await mount({ media: audioMedia({ id: "audio-slot", revision: 2, resourceId: "playing-audio" }) });
    expect(ui.host.querySelectorAll("audio")).toHaveLength(1);
    await ui.close();
    expect(paused).toBeGreaterThan(0);
});

afterAll(() => browser.close());
