import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaCast, DramaShot, DramaTake } from "@/services/api/drama";
import type { CastView } from "@/services/api/drama-cast-views";
import type { ImageCropRect } from "@/components/image-crop-dialog";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
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
const draftChecks: { expectedRevision: number; config: DramaShotMediaConfig }[] = [];
let quoteAmount = 1_000_000;
let nextPreflightAmount: number | undefined;
let quoteFailure = "";
let quoteBlocked = "";
let nextSave: Deferred<void> | undefined;
let nextDraftCheck: Deferred<void> | undefined;
let quoteConfig: ((config: DramaShotMediaConfig) => DramaShotMediaConfig) | undefined;
let preflightConfig: ((config: DramaShotMediaConfig) => DramaShotMediaConfig) | undefined;
const executions: ExecuteCall[] = [];
const adoptions: { expectedRevision: number; takeId: string }[] = [];
let confirmations: { onOk: () => void }[] = [];
let readsFail = false;
let closes = 0;
let changed = 0;
let selectedShots: Array<{ id: string; kind: DramaShotMediaKind }> = [];
let editingStates: Array<{ dirty: boolean; busy: boolean; automatic: boolean }> = [];
let server: Record<DramaShotMediaKind, DramaShotMedia>;
let casts: DramaCast[] = [];
let castTakes: DramaTake[] = [];
let castViews: CastView[] = [];
let libraryImage = { id: "arbitrary-image", name: "素材库图片" };
const uploads: { file: File; kind: string }[] = [];
const downloads: { storageKey: string; fileName: string; signal?: AbortSignal }[] = [];
let nextResourceRead: Deferred<{ id: string; mimeType: string; objectKey: string }> | undefined;
const blobReads: string[] = [];
const crops: { source: string; selection: ImageCropRect }[] = [];
const deletions: string[] = [];
let promptReferences: CanvasResourceReference[] = [];
const Input = Object.assign(({ onChange, ...props }: Record<string, unknown>) => createElement("input", { ...props, onInput: onChange }), {
    TextArea: ({ onChange, autoSize: _autoSize, ...props }: Record<string, unknown>) => createElement("textarea", { ...props, onInput: onChange }),
});
mock.module("antd", () => ({
    App: { useApp: () => ({ modal: { confirm: (props: { onOk: () => void }) => confirmations.push(props) } }) },
    Button: ({ children, loading: _loading, type: _type, size: _size, icon: _icon, ...props }: Record<string, unknown>) => createElement("button", props, children as ReactNode),
    Input,
    Tooltip: ({ children }: { children: ReactNode }) => children,
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
                <button onClick={() => onConfirm(["chosen"], [{ title: libraryImage.name, asset: { kind: "image", data: { storageKey: `resource:${libraryImage.id}` } } }])}>选择库中图片</button>
                <button onClick={onClose}>取消选择</button>
            </section>
        ) : null,
}));
mock.module("@/components/image-crop-dialog", () => ({
    ImageCropDialog: ({ open, title, confirmLoading, onConfirm, onClose }: { open: boolean; title: string; confirmLoading: boolean; onConfirm: (selection: ImageCropRect) => void; onClose: () => void }) =>
        open ? (
            <section role="dialog" aria-label={title}>
                <button disabled={confirmLoading} onClick={() => onConfirm({ x: 0.1, y: 0.2, width: 0.5, height: 0.6 })}>
                    应用裁剪
                </button>
                <button disabled={confirmLoading} onClick={onClose}>
                    取消裁剪
                </button>
            </section>
        ) : null,
}));
mock.module("@/components/canvas/canvas-resource-mention-textarea", () => ({
    CanvasResourceMentionTextarea: ({ value, references, disabled, onChange, "aria-label": label }: { value: string; references: CanvasResourceReference[]; disabled?: boolean; onChange: (value: string) => void; "aria-label"?: string }) => {
        promptReferences = structuredClone(references);
        return <textarea aria-label={label} disabled={disabled} value={value} onInput={(event) => onChange(event.currentTarget.value)} />;
    },
}));
mock.module("@/lib/canvas/canvas-image-data", () => ({
    cropDataUrl: async (source: string, selection: ImageCropRect) => {
        crops.push({ source, selection });
        return "data:image/png;base64,Y3JvcHBlZA==";
    },
}));
mock.module("@/services/resource-blob-cache", () => ({
    getCachedResourceBlob: async (storageKey: string) => {
        blobReads.push(storageKey);
        return new Blob(["original image"], { type: "image/png" });
    },
}));
mock.module("@/services/browser-download", () => ({
    downloadBrowserMedia: async (input: { storageKey: string; fileName: string; signal?: AbortSignal }) => {
        downloads.push(input);
    },
}));
const dramaApi = await import("@/services/api/drama");
mock.module("@/services/api/drama", () => ({
    ...dramaApi,
    listDramaCast: async () => ({ cast: structuredClone(casts) }),
    listDramaTakes: async () => ({ takes: structuredClone(castTakes), currentResourceId: "" }),
}));
mock.module("@/services/api/drama-cast-views", () => ({ listDramaCastViews: async () => ({ views: structuredClone(castViews) }) }));
const resourceApi = await import("@/services/api/resources");
mock.module("@/services/api/resources", () => ({
    ...resourceApi,
    getResource: async (id: string) => {
        const pending = nextResourceRead;
        nextResourceRead = undefined;
        return pending ? pending.promise : { id, mimeType: "image/webp", objectKey: `${id}.webp` };
    },
    uploadResourceFile: async (file: File, kind: string) => {
        uploads.push({ file, kind });
        return { id: `uploaded-${uploads.length}`, status: "ready", mimeType: file.type };
    },
}));
mock.module("@/stores/use-user-store", () => ({ useUserStore: userStore }));
const userScope = await import("@/lib/user-scope");
mock.module("@/lib/user-scope", () => ({ ...userScope, getActiveUserScope: () => userStore.getState().user.id }));
mock.module("@/pages/projects/drama-model-picker", () => ({
    useDramaModelCatalog: () => ({ data: { options: { image: [], video: [{ choice: { channelId: "channel", modelKey: "model" }, videoResolutions: ["720p", "1080p"], defaultVideoResolution: "720p" }] } } }),
    DramaModelPicker: () => <button>模型选择器</button>,
}));
mock.module("@/pages/projects/drama-shared", () => ({
    parseList: (value?: string) => {
        try {
            const parsed: unknown = JSON.parse(value || "[]");
            return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
        } catch {
            return [];
        }
    },
    MediaThumb: ({ resourceId, alt }: { resourceId: string; alt: string }) => <img data-resource={resourceId} alt={alt} />,
    useResourceMediaUrl: (id: string) => (id ? `https://test.invalid/${id}` : ""),
}));
mock.module("@/pages/projects/workflow-shot-audio", () => ({ WorkflowShotAudioEditor: () => <p>独立镜头音频编辑器</p> }));
mock.module("@/services/api/drama-shot-media", () => ({
    getDramaShotMedia: async (_projectId: string, _shotId: string, kind: DramaShotMediaKind) => {
        if (readsFail) throw new Error("状态读取失败");
        return structuredClone(server[kind]);
    },
    saveDramaShotMedia: async (projectId: string, shotId: string, kind: DramaShotMediaKind, input: { expectedRevision: number; config: DramaShotMediaConfig }) => {
        saves.push({ projectId, shotId, kind, input: structuredClone(input) });
        const pending = nextSave;
        nextSave = undefined;
        if (pending) await pending.promise;
        server[kind] = { ...server[kind], id: `media-${kind}`, revision: input.expectedRevision + 1, config: structuredClone(input.config) };
        return structuredClone(server[kind]);
    },
    preflightDramaShotMedia: async (projectId: string, shotId: string, kind: DramaShotMediaKind, input: DramaShotMediaAction): Promise<DramaShotMediaPreflight> => {
        checks.push({ projectId, shotId, kind, input: structuredClone(input) });
        const amountMicrocredits = nextPreflightAmount ?? quoteAmount;
        quoteAmount = amountMicrocredits;
        const config = structuredClone(preflightConfig?.(server[kind].config) ?? server[kind].config);
        return {
            shotId,
            kind,
            revision: server[kind].revision,
            baseRevision: 9,
            ready: true,
            amountMicrocredits,
            priced: true,
            estimated: false,
            confirmationToken: "quoted",
            scopeHash: JSON.stringify(config),
            config,
        };
    },
    quoteDramaShotMedia: async (_projectId: string, shotId: string, kind: DramaShotMediaKind, input: { expectedRevision: number; config: DramaShotMediaConfig }): Promise<DramaShotMediaPreflight> => {
        draftChecks.push(structuredClone(input));
        const pending = nextDraftCheck;
        nextDraftCheck = undefined;
        if (pending) await pending.promise;
        if (quoteFailure) throw new Error(quoteFailure);
        const config = structuredClone(quoteConfig?.(input.config) ?? input.config);
        return {
            shotId,
            kind,
            revision: input.expectedRevision,
            baseRevision: 9,
            ready: !quoteBlocked,
            reason: quoteBlocked,
            amountMicrocredits: quoteAmount,
            priced: true,
            estimated: false,
            confirmationToken: "",
            scopeHash: JSON.stringify(config),
            config,
        };
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
const { ApiError, http } = await import("@/services/api/request");
spyOn(http, "delete").mockImplementation(async (path) => {
    deletions.push(path);
    return undefined as never;
});
spyOn(http, "deleteWithBody").mockImplementation(async (path) => {
    deletions.push(path);
    return undefined as never;
});
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
async function mount(page = false, configure?: () => void, initialKind?: DramaShotMediaKind, canOpenVideo?: (shot: DramaShot) => boolean, shotOverrides?: Partial<DramaShot>) {
    saves.length = checks.length = executions.length = adoptions.length = draftChecks.length = 0;
    uploads.length = downloads.length = blobReads.length = crops.length = deletions.length = 0;
    casts = [];
    castTakes = [];
    castViews = [];
    libraryImage = { id: "arbitrary-image", name: "素材库图片" };
    nextResourceRead = undefined;
    promptReferences = [];
    quoteAmount = 1_000_000;
    nextPreflightAmount = undefined;
    quoteFailure = quoteBlocked = "";
    nextSave = undefined;
    nextDraftCheck = undefined;
    quoteConfig = preflightConfig = undefined;
    confirmations = [];
    readsFail = false;
    closes = changed = 0;
    selectedShots = [];
    editingStates = [];
    server = { image: media("image"), video: media("video") };
    configure?.();
    userStore.setState({ user: { id: "user-a" } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    let projectId = "project-a";
    const render = () =>
        root.render(
            <QueryClientProvider client={client}>
                <WorkflowShotMediaDialog
                    open
                    initialKind={initialKind}
                    canOpenVideo={canOpenVideo}
                    projectId={projectId}
                    shot={{ id: "real-shot", projectId, episodeId: "episode", position: 1, segmentIndex: 2, scene: "同一房间", durationMs: 5000, ...shotOverrides } as DramaShot}
                    presentation={page ? "page" : "dialog"}
                    segmentLabel="第 3 段"
                    shots={
                        page
                            ? ([
                                  { id: "real-shot", projectId, episodeId: "episode", position: 1, segmentIndex: 2, scene: "同一房间" },
                                  { id: "next-shot", projectId, episodeId: "episode", position: 2, segmentIndex: 2, scene: "另一场景" },
                                  { id: "other-segment-shot", projectId, episodeId: "episode", position: 3, segmentIndex: 3, scene: "同一房间" },
                                  { id: "other-episode-shot", projectId, episodeId: "other-episode", position: 4, segmentIndex: 2, scene: "同一房间" },
                              ] as DramaShot[])
                            : undefined
                    }
                    onSelectShot={(shot, kind) => {
                        selectedShots.push({ id: shot.id, kind });
                        closes++;
                    }}
                    onClose={() => closes++}
                    onChanged={() => changed++}
                    onDirtyChange={(dirty, busy = false, automatic = false) => {
                        editingStates.push({ dirty, busy, automatic });
                    }}
                />
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
async function waitPrice(host: HTMLElement) {
    for (let attempt = 0; attempt < 80; attempt++) {
        const generate = host.querySelector<HTMLButtonElement>(".drama-shot-media-generate");
        if (generate?.textContent?.includes("积分") && !generate.disabled) return;
        await act(settle);
    }
    throw new Error(`报价尚未就绪: ${host.textContent}`);
}
async function click(host: HTMLElement, text: string) {
    await act(async () => {
        button(host, text).click();
        await settle();
    });
}
async function clickLabel(host: HTMLElement, label: string) {
    const target = [...host.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.getAttribute("aria-label") === label);
    if (!target) throw new Error(`没有按钮 ${label}: ${host.textContent}`);
    await act(async () => {
        target.click();
        await settle();
    });
}
async function clickImage(host: HTMLElement, resourceId: string) {
    const target = host.querySelector<HTMLImageElement>(`.shot-reference-picker-grid img[data-resource="${resourceId}"]`)?.closest("button");
    if (!target) throw new Error(`没有可选图片 ${resourceId}: ${host.textContent}`);
    await act(async () => {
        target.click();
        await settle();
    });
}
async function uploadImage(host: HTMLElement, name: string) {
    const input = host.querySelector<HTMLInputElement>('[aria-label="上传镜头参考图片"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["uploaded image"], name, { type: "image/png" })] });
    await act(async () => {
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await settle();
    });
}
function cast(overrides: Partial<DramaCast> = {}): DramaCast {
    return {
        id: "cast-one",
        projectId: "project-a",
        kind: "character",
        name: "苏晚",
        aliasesJson: "[]",
        role: "主角",
        description: "",
        appearance: "",
        voiceInstructions: "",
        importance: 1,
        imageResourceId: "cast-current",
        imageStatus: "ready",
        imageVersion: 2,
        locked: false,
        position: 0,
        ...overrides,
    };
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
    server[executions[index].kind].status = "queued";
    await act(async () => {
        executions[index].result.resolve({ id: "real-task", status: "queued" });
        await settle();
    });
}
afterAll(() => browser.happyDOM.abort());

test("镜头配置自动同步并重新计价，单击以真实镜头和单次标识提交", async () => {
    const view = await mount();
    try {
        await prompt(view.host, "修改后的镜头提示词");
        await waitPrice(view.host);
        expect(saves).toHaveLength(1);
        expect(draftChecks.at(-1)).toMatchObject({ expectedRevision: 4, config: { prompt: "修改后的镜头提示词" } });
        expect(executions).toHaveLength(0);
        expect(view.host.textContent).toContain("生成图片 - 1积分");
        expect(view.host.textContent).not.toContain("确认生成");
        expect(view.host.textContent).not.toContain("保存配置");
        await act(async () => {
            const confirm = button(view.host, "生成图片 - 1积分");
            confirm.click();
            confirm.click();
            await settle();
        });
        expect(executions).toHaveLength(1);
        expect(saves).toHaveLength(1);
        expect(saves[0]).toMatchObject({ projectId: "project-a", shotId: "real-shot", kind: "image", input: { expectedRevision: 3, config: { prompt: "修改后的镜头提示词" } } });
        expect(checks[0].input).toEqual({ expectedRevision: 4 });
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
        await waitPrice(view.host);
        await click(view.host, "生成图片 - 1积分");
        await rejectExecution(new Error("连接中断"));
        const original = structuredClone(executions[0].input);
        expect(button(view.host, "关闭媒体").disabled).toBe(true);
        expect(button(view.host, "视频").disabled).toBe(true);
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

test("生成提交与回执不确定向主壳报告普通忙状态，核对仍复用同次提交", async () => {
    const view = await mount();
    try {
        await click(view.host, "生成图片 - 1积分");
        expect(editingStates.at(-1)).toEqual({ dirty: false, busy: true, automatic: false });
        await rejectExecution(new Error("连接中断"));
        expect(editingStates.at(-1)).toEqual({ dirty: false, busy: true, automatic: false });
        expect(executions).toHaveLength(1);
        await click(view.host, "核对提交结果");
        expect(executions[1].input).toEqual(executions[0].input);
        await resolveExecution();
        expect(editingStates.at(-1)).toEqual({ dirty: false, busy: false, automatic: true });
    } finally {
        await view.close();
    }
});

test("明确拒绝释放编辑锁，重新预检使用新的提交标识", async () => {
    const view = await mount();
    try {
        await waitPrice(view.host);
        await click(view.host, "生成图片 - 1积分");
        await rejectExecution(new ApiError("报价已变化", { status: 409 }));
        expect(view.host.textContent).toContain("报价已变化");
        expect(view.host.textContent).not.toContain("核对提交结果");
        expect(button(view.host, "关闭媒体").disabled).toBe(false);
        await waitPrice(view.host);
        await click(view.host, "生成图片 - 1积分");
        expect(executions[1].input.clientOperationId).not.toBe(executions[0].input.clientOperationId);
        await resolveExecution();
    } finally {
        await view.close();
    }
});

test("已收到任务回执而刷新失败时保留入队提示，不提供重复提交", async () => {
    const view = await mount();
    try {
        await waitPrice(view.host);
        await click(view.host, "生成图片 - 1积分");
        readsFail = true;
        await resolveExecution();
        expect(view.host.textContent).toContain("已提交镜头图片，排队中");
        expect(view.host.textContent).toContain("任务已提交，最新进度暂未刷新");
        expect(view.host.querySelector<HTMLButtonElement>(".drama-shot-media-generate")!.disabled).toBe(true);
        expect(view.host.textContent).not.toContain("核对提交结果");
        expect(executions).toHaveLength(1);
    } finally {
        await view.close();
    }
});

test("修改后切换类型先同步配置，不确认放弃也不触发生成", async () => {
    const view = await mount();
    try {
        await prompt(view.host, "尚未保存");
        await click(view.host, "视频");
        expect(confirmations).toHaveLength(0);
        expect(saves).toHaveLength(1);
        expect(server.image.config.prompt).toBe("尚未保存");
        expect(executions).toHaveLength(0);
        await act(settle);
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("video 原始提示词");
    } finally {
        await view.close();
    }
});

test("本镜视频入口未通过时保留图片标签，通过后可切换视频", async () => {
    let allowed = false;
    const canOpenVideo = mock((_shot: DramaShot) => allowed);
    const view = await mount(true, undefined, "image", canOpenVideo);
    try {
        await click(view.host, "视频");
        expect(canOpenVideo).toHaveBeenCalledWith(expect.objectContaining({ id: "real-shot" }));
        expect(button(view.host, "图片").getAttribute("aria-pressed")).toBe("true");
        expect(button(view.host, "视频").getAttribute("aria-pressed")).toBe("false");

        allowed = true;
        await click(view.host, "视频");
        await waitPrice(view.host);
        expect(button(view.host, "视频").getAttribute("aria-pressed")).toBe("true");
    } finally {
        await view.close();
    }
});

test("自动同步串行提交，保存期间继续修改不被旧回执覆盖", async () => {
    const view = await mount();
    try {
        const pending = deferred<void>();
        nextSave = pending;
        await prompt(view.host, "先提交的配置");
        for (let i = 0; i < 50 && !saves.length; i++) await act(settle);
        expect(saves).toHaveLength(1);
        await prompt(view.host, "保存期间继续输入的配置");
        expect(saves).toHaveLength(1);
        await act(async () => {
            pending.resolve();
            await settle();
        });
        await waitPrice(view.host);
        expect(saves.map((save) => save.input.expectedRevision)).toEqual([3, 4]);
        expect(server.image.config.prompt).toBe("保存期间继续输入的配置");
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("保存期间继续输入的配置");
        expect(executions).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("自动同步失败保留当前配置，局部重新同步成功后无需保存按钮", async () => {
    const view = await mount();
    try {
        const pending = deferred<void>();
        nextSave = pending;
        await prompt(view.host, "保留此配置");
        for (let i = 0; i < 50 && !saves.length; i++) await act(settle);
        await act(async () => {
            pending.reject(new Error("连接暂不可用"));
            await settle();
        });
        expect(view.host.textContent).toContain("配置未同步：连接暂不可用");
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("保留此配置");
        expect(server.image.config.prompt).toBe("image 原始提示词");
        await click(view.host, "重新同步配置");
        await waitPrice(view.host);
        expect(server.image.config.prompt).toBe("保留此配置");
        expect(saves).toHaveLength(2);
        expect(view.host.textContent).not.toContain("保存配置");
        expect(executions).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("离开作品后迟到的自动同步不覆盖新作品配置", async () => {
    const view = await mount();
    try {
        const pending = deferred<void>();
        nextSave = pending;
        await prompt(view.host, "旧作品输入");
        for (let i = 0; i < 50 && !saves.length; i++) await act(settle);
        await view.rerender("project-b");
        await act(async () => {
            pending.resolve();
            await settle();
        });
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("image 原始提示词");
        expect(changed).toBe(0);
        expect(saves).toHaveLength(1);
        expect(saves[0].projectId).toBe("project-a");
    } finally {
        await view.close();
    }
});

test("关闭媒体先完成同步，连续点击只关闭一次且不丢配置", async () => {
    const view = await mount();
    try {
        const pending = deferred<void>();
        nextSave = pending;
        await prompt(view.host, "关闭前的最后修改");
        await act(async () => {
            const close = button(view.host, "关闭媒体");
            close.click();
            close.click();
            await settle();
        });
        expect(saves).toHaveLength(1);
        expect(closes).toBe(0);
        expect(editingStates.at(-1)).toEqual({ dirty: false, busy: true, automatic: true });
        await act(async () => {
            pending.resolve();
            await settle();
        });
        expect(closes).toBe(1);
        expect(confirmations).toHaveLength(0);
        expect(server.image.config.prompt).toBe("关闭前的最后修改");
        expect(executions).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("正常状态不显示重新载入，版本更新后可重新读取且不覆盖脏草稿", async () => {
    const view = await mount();
    try {
        expect(view.host.textContent).not.toContain("重新载入");
        expect(view.host.textContent).not.toContain("重新读取");
        server.image = { ...server.image, revision: 4, config: { ...server.image.config, prompt: "远端新配置" } };
        await act(async () => {
            await view.client.refetchQueries({ queryKey: ["drama-shot-media", "user-a", "project-a", "real-shot", "image"] });
            await settle();
        });
        await click(view.host, "重新读取");
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("远端新配置");
        expect(view.host.textContent).not.toContain("重新读取");
        await prompt(view.host, "本地未保存草稿");
        await act(async () => {
            view.client.setQueryData(["drama-shot-media", "user-a", "project-a", "real-shot", "image"], { ...server.image, revision: 5 });
            await settle();
        });
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("本地未保存草稿");
        expect(view.host.textContent).not.toContain("保存配置");
        expect(saves).toHaveLength(0);
        expect(view.host.querySelector<HTMLButtonElement>(".drama-shot-media-generate")!.disabled).toBe(true);
    } finally {
        await view.close();
    }
});

test("任意资产库图片可选作首尾帧，保存绑定当前真实镜头", async () => {
    const view = await mount();
    try {
        await click(view.host, "视频");
        await act(settle);
        await click(view.host, "首尾帧");
        await clickLabel(view.host, "选择首帧");
        expect(view.host.querySelector('[role="dialog"][aria-label="选择主体图片"]')).toBeTruthy();
        await click(view.host, "素材库");
        await click(view.host, "选择库中图片");
        await clickLabel(view.host, "选择尾帧");
        await click(view.host, "素材库");
        await click(view.host, "选择库中图片");
        await waitPrice(view.host);
        expect(saves.at(-1)).toMatchObject({ projectId: "project-a", shotId: "real-shot", kind: "video", input: { config: { operation: "image_to_video", firstFrameResourceId: "arbitrary-image", lastFrameResourceId: "arbitrary-image" } } });
        expect(executions).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("文生图与参考生视频显示参考内容，首尾帧模式仅显示两个帧槽位", async () => {
    const view = await mount(false, () => {
        server.video.config.operation = "reference_to_video";
        server.video.config.referenceResourceIds = ["video-reference"];
    });
    try {
        expect(view.host.querySelector('section[aria-label="参考内容"]')).toBeTruthy();
        expect(view.host.querySelector(".shot-reference-frames")).toBeNull();
        await click(view.host, "视频");
        await waitPrice(view.host);
        expect(button(view.host, "参考生视频").getAttribute("aria-pressed")).toBe("true");
        expect(view.host.querySelector(".shot-reference-grid img")?.getAttribute("data-resource")).toBe("video-reference");
        expect(view.host.querySelector(".shot-reference-frames")).toBeNull();
        await click(view.host, "首尾帧");
        await waitPrice(view.host);
        expect(view.host.querySelector('section[aria-label="首尾帧图片"]')).toBeTruthy();
        expect(view.host.querySelectorAll(".shot-reference-card.is-frame")).toHaveLength(2);
        expect(view.host.querySelector(".shot-reference-grid")).toBeNull();
        expect(server.video.config.referenceResourceIds).toEqual([]);
        await click(view.host, "参考生视频");
        await waitPrice(view.host);
        expect(view.host.querySelector('section[aria-label="参考内容"]')).toBeTruthy();
        expect(view.host.querySelector(".shot-reference-frames")).toBeNull();
        expect(executions).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("重开旧的混合首尾帧配置会自动清理隐藏参考图，再点当前模式不重复保存", async () => {
    const view = await mount(
        false,
        () => {
            server.video.config.operation = "image_to_video";
            server.video.config.referenceResourceIds = ["legacy-reference"];
            server.video.config.firstFrameResourceId = "first-frame";
            server.video.config.lastFrameResourceId = "last-frame";
        },
        "video",
    );
    try {
        for (let i = 0; i < 80 && !saves.length; i++) await act(settle);
        await waitPrice(view.host);
        expect(saves).toHaveLength(1);
        expect(saves[0]).toMatchObject({
            projectId: "project-a",
            shotId: "real-shot",
            kind: "video",
            input: { expectedRevision: 3, config: { operation: "image_to_video", referenceResourceIds: [], firstFrameResourceId: "first-frame", lastFrameResourceId: "last-frame" } },
        });
        expect(server.video.config.referenceResourceIds).toEqual([]);
        expect(draftChecks.every((check) => check.config.referenceResourceIds.length === 0)).toBe(true);
        expect(view.host.querySelector(".shot-reference-grid")).toBeNull();
        expect([...view.host.querySelectorAll(".shot-reference-card img")].map((image) => image.getAttribute("data-resource"))).toEqual(["first-frame", "last-frame"]);
        await click(view.host, "首尾帧");
        for (let i = 0; i < 40; i++) await act(settle);
        expect(saves).toHaveLength(1);
        await click(view.host, "生成视频 - 1积分");
        expect(executions).toHaveLength(1);
        expect(executions[0].input.expectedRevision).toBe(4);
        expect(deletions).toHaveLength(0);
        await resolveExecution();
    } finally {
        await view.close();
    }
});

test("本地上传完成后绑定当前镜头并自动同步图片名称", async () => {
    const view = await mount();
    try {
        await click(view.host, "本地上传");
        await uploadImage(view.host, "房间参考.png");
        await waitPrice(view.host);
        expect(uploads).toHaveLength(1);
        expect(uploads[0].kind).toBe("image");
        expect(uploads[0].file.name).toBe("房间参考.png");
        expect(saves).toHaveLength(1);
        expect(saves[0]).toMatchObject({ projectId: "project-a", shotId: "real-shot", kind: "image", input: { config: { operation: "image_to_image", referenceResourceIds: ["uploaded-1"], referenceNames: { "uploaded-1": "房间参考" } } } });
        expect(view.host.querySelector(".shot-reference-name")?.textContent).toBe("房间参考");
        expect(promptReferences).toContainEqual(expect.objectContaining({ label: "参考图1", storageKey: "resource:uploaded-1" }));
        expect(executions).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("替换指定参考图保留其他参考图及其顺序", async () => {
    const view = await mount(false, () => {
        server.image.config.operation = "image_to_image";
        server.image.config.referenceResourceIds = ["reference-one", "reference-two"];
        server.image.config.referenceNames = { "reference-one": "房间", "reference-two": "窗外" };
        libraryImage = { id: "replacement", name: "新房间" };
    });
    try {
        await clickLabel(view.host, "切换房间");
        await click(view.host, "素材库");
        await click(view.host, "选择库中图片");
        await waitPrice(view.host);
        expect(server.image.config.referenceResourceIds).toEqual(["replacement", "reference-two"]);
        expect(server.image.config.referenceNames).toMatchObject({ replacement: "新房间", "reference-two": "窗外" });
        expect(saves).toHaveLength(1);
        expect([...view.host.querySelectorAll(".shot-reference-name")].map((name) => name.textContent)).toEqual(["新房间", "窗外"]);
        expect(deletions).toHaveLength(0);
        expect(executions).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("下载保留绑定，移除仅取消镜头引用而不删除主体原图", async () => {
    const view = await mount(false, () => {
        casts = [cast({ imageResourceId: "reference-one" })];
        server.image.config.operation = "image_to_image";
        server.image.config.referenceResourceIds = ["reference-one", "reference-two"];
        server.image.config.referenceNames = { "reference-one": "人物", "reference-two": "房间" };
    });
    try {
        await clickLabel(view.host, "下载参考图 1");
        expect(downloads).toHaveLength(1);
        expect(downloads[0]).toMatchObject({ storageKey: "resource:reference-one", fileName: "人物.webp" });
        expect(saves).toHaveLength(0);
        await clickLabel(view.host, "移除参考图 1");
        await waitPrice(view.host);
        expect(server.image.config.referenceResourceIds).toEqual(["reference-two"]);
        expect(casts[0].imageResourceId).toBe("reference-one");
        expect(deletions).toHaveLength(0);
        expect(uploads).toHaveLength(0);
        expect(saves).toHaveLength(1);
        expect(executions).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("下载读取元数据期间切换作品会忽略迟到回执，不启动旧作品下载", async () => {
    const view = await mount(false, () => {
        server.image.config.operation = "image_to_image";
        server.image.config.referenceResourceIds = ["reference-one"];
    });
    const pending = deferred<{ id: string; mimeType: string; objectKey: string }>();
    try {
        nextResourceRead = pending;
        await clickLabel(view.host, "下载参考图 1");
        expect(downloads).toHaveLength(0);
        await view.rerender("project-b");
        await act(async () => {
            pending.resolve({ id: "reference-one", mimeType: "image/webp", objectKey: "reference-one.webp" });
            await settle();
        });
        expect(downloads).toHaveLength(0);
        expect(saves).toHaveLength(0);
        expect(button(view.host, "关闭媒体").disabled).toBe(false);
        expect(executions).toHaveLength(0);
    } finally {
        pending.resolve({ id: "reference-one", mimeType: "image/webp", objectKey: "reference-one.webp" });
        await view.close();
    }
});

for (const removedIndex of [0, 1]) {
    test(`删除第 ${removedIndex + 1} 张参考图后手工提示词仍绑定原图片`, async () => {
        const view = await mount(false, () => {
            server.image.config.operation = "image_to_image";
            server.image.config.referenceResourceIds = ["ref-a", "ref-b", "ref-c"];
            server.image.config.prompt = "参考图1的人物拿着@参考图2，走进参考图 3。";
        });
        try {
            await clickLabel(view.host, `移除参考图 ${removedIndex + 1}`);
            await waitPrice(view.host);
            expect(server.image.config.prompt).toBe("@[shot-image:ref-a]的人物拿着@[shot-image:ref-b]，走进@[shot-image:ref-c]。");
            expect(promptReferences).toContainEqual(expect.objectContaining({ storageKey: "resource:ref-c", label: "参考图2", mentionToken: "@[shot-image:ref-c]" }));
            expect(promptReferences).toContainEqual(expect.objectContaining({ label: "已移除图片", mentionToken: `@[shot-image:${removedIndex ? "ref-b" : "ref-a"}]`, mentionMenuHidden: true }));
            expect(view.host.textContent).toContain("提示词引用的图片已移除");
            expect(confirmations).toHaveLength(0);
            expect(executions).toHaveLength(0);
        } finally {
            await view.close();
        }
    });
}

test("自动视频稿手工编辑后立即删图也按原附图绑定", async () => {
    const view = await mount(
        false,
        () => {
            server.video.config.operation = "reference_to_video";
            server.video.config.referenceResourceIds = ["ref-a", "ref-b"];
            server.video.config.promptSourceHash = "automatic-source";
        },
        "video",
    );
    try {
        await prompt(view.host, "参考图2中的人物走近。");
        await clickLabel(view.host, "移除参考图 1");
        await waitPrice(view.host);
        expect(server.video.config.prompt).toBe("@[shot-image:ref-b]中的人物走近。");
        expect(server.video.config.promptSourceHash).toBe("");
        expect(promptReferences).toContainEqual(expect.objectContaining({ storageKey: "resource:ref-b", label: "参考图1", mentionToken: "@[shot-image:ref-b]" }));
        expect(executions).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("交换首尾帧一次自动同步两个绑定", async () => {
    const view = await mount(
        false,
        () => {
            server.video.config.operation = "image_to_video";
            server.video.config.firstFrameResourceId = "first-frame";
            server.video.config.lastFrameResourceId = "last-frame";
        },
        "video",
    );
    try {
        await clickLabel(view.host, "交换首尾帧");
        await waitPrice(view.host);
        expect(saves).toHaveLength(1);
        expect(server.video.config).toMatchObject({ operation: "image_to_video", firstFrameResourceId: "last-frame", lastFrameResourceId: "first-frame", referenceResourceIds: [] });
        expect([...view.host.querySelectorAll(".shot-reference-card img")].map((image) => image.getAttribute("data-resource"))).toEqual(["last-frame", "first-frame"]);
        expect(executions).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("裁剪上传新图片只替换当前帧，确认前保留原图并锁住离开操作", async () => {
    const view = await mount(
        false,
        () => {
            server.video.config.operation = "image_to_video";
            server.video.config.firstFrameResourceId = "first-frame";
            server.video.config.lastFrameResourceId = "last-frame";
            server.video.config.referenceNames = { "first-frame": "人物首帧", "last-frame": "人物尾帧" };
            server.video.config.referenceSubjects = { "first-frame": "cast-one", "last-frame": "cast-one" };
            casts = [cast()];
        },
        "video",
    );
    try {
        await clickLabel(view.host, "裁剪首帧图");
        expect(view.host.querySelector('[role="dialog"][aria-label="裁剪参考图片"]')).toBeTruthy();
        expect(server.video.config.firstFrameResourceId).toBe("first-frame");
        expect(button(view.host, "关闭媒体").disabled).toBe(true);
        expect(button(view.host, "图片").disabled).toBe(true);
        expect(saves).toHaveLength(0);
        await click(view.host, "应用裁剪");
        await waitPrice(view.host);
        expect(blobReads).toEqual(["resource:first-frame"]);
        expect(crops).toHaveLength(1);
        expect(uploads).toHaveLength(1);
        expect(uploads[0].file.name).toBe("人物首帧 · 裁剪.png");
        expect(await uploads[0].file.text()).toBe("cropped");
        expect(server.video.config).toMatchObject({ firstFrameResourceId: "uploaded-1", lastFrameResourceId: "last-frame", referenceResourceIds: [], referenceNames: { "uploaded-1": "人物首帧 · 裁剪" } });
        expect(server.video.config.referenceSubjects).toEqual({ "uploaded-1": "cast-one", "last-frame": "cast-one" });
        expect(saves).toHaveLength(1);
        expect(deletions).toHaveLength(0);
        expect(view.host.querySelector('[role="dialog"][aria-label="裁剪参考图片"]')).toBeNull();
        expect(button(view.host, "关闭媒体").disabled).toBe(false);
    } finally {
        await view.close();
    }
});

test("单镜视频在资产换图后刷新参考图和报价，保留引用顺序与分辨率", async () => {
    const view = await mount(
        true,
        () => {
            casts = [
                cast(),
                cast({ id: "night-look", parentId: "cast-one", lookName: "夜行衣", imageResourceId: "cast-night" }),
                cast({ id: "living-room", kind: "scene", name: "客厅", imageResourceId: "room-current" }),
                cast({ id: "key", kind: "prop", name: "钥匙", imageResourceId: "key-current" }),
                cast({ id: "other-prop", kind: "prop", name: "无关道具", imageResourceId: "other-current" }),
            ];
            server.video = {
                ...server.video,
                id: "",
                revision: 0,
                config: {
                    ...server.video.config,
                    operation: "reference_to_video",
                    resolution: "1080p",
                    referenceResourceIds: ["cast-night", "key-current", "room-current"],
                    referenceSubjects: { "cast-night": "night-look", "key-current": "key", "room-current": "living-room" },
                },
            };
        },
        "video",
        undefined,
        { castIdsJson: '["cast-one"]', lookCastIdsJson: '["night-look"]', sceneCastId: "living-room", propIdsJson: '["key"]' },
    );
    try {
        const referencePanel = view.host.querySelector('[aria-label="参考内容"]');
        expect(referencePanel?.textContent).not.toContain("本镜头资产");
        expect(referencePanel?.querySelector('img[data-resource="cast-night"]')).toBeTruthy();
        expect(referencePanel?.querySelector('img[data-resource="key-current"]')).toBeTruthy();
        expect(referencePanel?.querySelector('img[data-resource="room-current"]')).toBeTruthy();
        expect(referencePanel?.querySelector('img[data-resource="cast-current"]')).toBeNull();
        expect(referencePanel?.querySelector('img[data-resource="other-current"]')).toBeNull();
        expect(view.host.querySelector<HTMLSelectElement>('[aria-label="镜头分辨率"]')?.value).toBe("1080p");
        expect(saves).toHaveLength(1);
        expect(saves[0]).toMatchObject({
            shotId: "real-shot",
            kind: "video",
            input: { expectedRevision: 0, config: { resolution: "1080p", referenceResourceIds: ["cast-night", "key-current", "room-current"] } },
        });
        expect(executions).toHaveLength(0);

        casts = casts.map((item) => (item.id === "night-look" ? { ...item, imageResourceId: "cast-newest" } : item));
        server.video.config = {
            ...server.video.config,
            referenceResourceIds: ["cast-newest", "key-current", "room-current"],
            referenceSubjects: { "cast-newest": "night-look", "key-current": "key", "room-current": "living-room" },
            prompt: "@[shot-image:cast-newest] 开门",
        };
        await act(async () => {
            await view.client.invalidateQueries({ queryKey: ["drama-shot-reference-cast"] });
            await settle();
        });
        for (let i = 0; i < 50 && !view.host.querySelector('[aria-label="参考内容"] img[data-resource="cast-newest"]'); i++) await act(settle);
        await waitPrice(view.host);
        expect(view.host.querySelector('[aria-label="参考内容"] img[data-resource="cast-night"]')).toBeNull();
        expect(view.host.querySelector('[aria-label="参考内容"] img[data-resource="cast-newest"]')).toBeTruthy();
        expect(view.host.querySelector<HTMLTextAreaElement>('[aria-label="镜头媒体提示词"]')?.value).toBe("@[shot-image:cast-newest] 开门");
        expect(draftChecks.at(-1)?.config.referenceResourceIds).toEqual(["cast-newest", "key-current", "room-current"]);
        expect(saves).toHaveLength(1);
        await click(view.host, "主体");
        expect(view.host.querySelector('[aria-label="选择主体图片"]')?.textContent).not.toContain("查看其他设定图");
    } finally {
        await view.close();
    }
});

test("已保存的空参考内容不回填，只显示并保存具体视频规格", async () => {
    const view = await mount(
        true,
        () => {
            casts = [cast()];
            server.video.config.operation = "reference_to_video";
            server.video.config.resolution = "1080p";
        },
        "video",
        undefined,
        { castIdsJson: '["cast-one"]' },
    );
    try {
        const panel = view.host.querySelector('[aria-label="参考内容"]');
        expect(panel?.textContent).toContain("添加参考内容");
        expect(panel?.querySelector('img[data-resource="cast-current"]')).toBeNull();
        const ratios = view.host.querySelector<HTMLSelectElement>('[aria-label="镜头画幅"]')!;
        const resolutions = view.host.querySelector<HTMLSelectElement>('[aria-label="镜头分辨率"]')!;
        expect(ratios.value).toBe("9:16");
        expect(resolutions.value).toBe("1080p");
        expect(Array.from(resolutions.options, (option) => option.value)).toEqual(["720p", "1080p"]);
        expect(saves).toHaveLength(0);
        await act(async () => {
            resolutions.value = "720p";
            resolutions.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await waitPrice(view.host);
        expect(saves[0]?.input.config.resolution).toBe("720p");
    } finally {
        await view.close();
    }
});

test("主体当前图与历史设定图可绑定镜头，切换不改变主体采用版本", async () => {
    const view = await mount(false, () => {
        casts = [cast()];
        castTakes = [{ id: "take-old", ownerId: "cast-one", kind: "cast", version: 1, resourceId: "cast-history", prompt: "", source: "pipeline", current: false, createdAt: "" }];
        castViews = [
            {
                id: "left-view",
                projectId: "project-a",
                castId: "cast-one",
                revision: 1,
                config: { name: "左侧", direction: "left", prompt: "", imageOptions: { model: { channelId: "channel", modelKey: "model" }, ratio: "1:1", resolution: "1K", subjectReferenceIds: [], styleReferenceIds: [] } },
                resourceId: "cast-left",
                status: "ready",
                takes: [{ ...castTakes[0], id: "view-failed", resourceId: "failed-view", status: "failed" }],
            },
        ];
    });
    try {
        await click(view.host, "主体");
        await clickImage(view.host, "cast-current");
        await waitPrice(view.host);
        expect(server.image.config.referenceResourceIds).toEqual(["cast-current"]);
        expect(server.image.config.referenceNames?.["cast-current"]).toBe("苏晚 · 版本 2");
        expect(server.image.config.referenceSubjects).toEqual({ "cast-current": "cast-one" });
        await clickLabel(view.host, "切换苏晚 · 版本 2");
        for (let i = 0; i < 50 && !view.host.querySelector('.shot-reference-picker-grid img[data-resource="cast-history"]'); i++) await act(settle);
        expect(view.host.querySelector('.shot-reference-picker-grid img[data-resource="cast-left"]')).toBeTruthy();
        expect(view.host.querySelector('.shot-reference-picker-grid img[data-resource="failed-view"]')).toBeNull();
        await clickImage(view.host, "cast-history");
        await waitPrice(view.host);
        expect(server.image.config.referenceResourceIds).toEqual(["cast-history"]);
        expect(server.image.config.referenceNames?.["cast-history"]).toBe("苏晚 · 版本 1");
        expect(server.image.config.referenceSubjects).toEqual({ "cast-history": "cast-one" });
        await clickLabel(view.host, "切换苏晚 · 版本 1");
        await clickImage(view.host, "cast-left");
        await waitPrice(view.host);
        expect(server.image.config.referenceSubjects).toEqual({ "cast-left": "cast-one" });
        await clickLabel(view.host, "裁剪参考图 1");
        await click(view.host, "应用裁剪");
        await waitPrice(view.host);
        expect(server.image.config.referenceSubjects).toEqual({ "uploaded-1": "cast-one" });
        await clickLabel(view.host, "切换苏晚 · 左侧 · 裁剪");
        await click(view.host, "素材库");
        await click(view.host, "选择库中图片");
        await waitPrice(view.host);
        expect(server.image.config.referenceSubjects).toEqual({});
        expect(casts[0]).toMatchObject({ imageResourceId: "cast-current", imageVersion: 2 });
        expect(saves).toHaveLength(5);
        expect(adoptions).toHaveLength(0);
        expect(executions).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("切换作品后迟到提交不操作新作品或触发刷新", async () => {
    const view = await mount();
    try {
        await waitPrice(view.host);
        await click(view.host, "生成图片 - 1积分");
        await view.rerender("project-b");
        await resolveExecution();
        expect(changed).toBe(0);
        expect(view.host.textContent).not.toContain("已提交镜头图片");
        expect(button(view.host, "关闭媒体").disabled).toBe(false);
    } finally {
        await view.close();
    }
});

test("镜头媒体音频标签打开独立音频编辑器", async () => {
    const ui = await mount();
    try {
        await click(ui.host, "音频");
        expect(ui.host.textContent).toContain("独立镜头音频编辑器");
        expect(executions).toHaveLength(0);
    } finally {
        await ui.close();
    }
});

test("镜头页面只展示当前真实段镜头，切镜头先同步配置且无需确认", async () => {
    const view = await mount(true);
    try {
        expect(view.host.querySelector("[role='dialog']")).toBeNull();
        expect(view.host.querySelector("[aria-label='镜头媒体预览']")).toBeTruthy();
        const strip = view.host.querySelector("[aria-label='本段镜头']");
        expect(strip).toBeTruthy();
        expect(strip?.querySelectorAll("button")).toHaveLength(2);
        expect(view.host.textContent).toContain("第 3 段 · 共 2 镜");
        expect(view.host.textContent).not.toContain("幕");
        expect(strip?.querySelector("[aria-label='切换分镜 4']")).toBeNull();
        expect(strip?.querySelector("[aria-label='切换分镜 5']")).toBeNull();
        await prompt(view.host, "尚未保存");
        await act(async () => {
            view.host.querySelector<HTMLButtonElement>("[aria-label='切换分镜 3']")!.click();
            await settle();
        });
        expect(confirmations).toHaveLength(0);
        expect(saves).toHaveLength(1);
        expect(saves[0].input.config.prompt).toBe("尚未保存");
        expect(closes).toBe(1);
        expect(selectedShots).toEqual([{ id: "next-shot", kind: "image" }]);
    } finally {
        await view.close();
    }
});

test("视频页检查目标镜头并在未通过时保持当前镜头", async () => {
    let allowed = false;
    const canOpenVideo = mock((_shot: DramaShot) => allowed);
    const view = await mount(true, undefined, "video", canOpenVideo);
    try {
        await clickLabel(view.host, "切换分镜 3");
        expect(canOpenVideo).toHaveBeenCalledWith(expect.objectContaining({ id: "next-shot" }));
        expect(selectedShots).toHaveLength(0);
        expect(button(view.host, "视频").getAttribute("aria-pressed")).toBe("true");

        allowed = true;
        await clickLabel(view.host, "切换分镜 3");
        expect(selectedShots).toEqual([{ id: "next-shot", kind: "video" }]);
    } finally {
        await view.close();
    }
});

test("镜头页面提交期间禁止同段切镜且不触发重复确认或生成", async () => {
    const view = await mount(true);
    try {
        await waitPrice(view.host);
        await click(view.host, "生成图片 - 1积分");
        const next = view.host.querySelector<HTMLButtonElement>("[aria-label='切换分镜 3']")!;
        expect(next.disabled).toBe(true);
        await act(async () => next.click());
        expect(selectedShots).toHaveLength(0);
        expect(confirmations).toHaveLength(0);
        expect(executions).toHaveLength(1);
        await resolveExecution();
    } finally {
        await view.close();
    }
});

test("最新报价变价先更新按钮，第二次点击才按已展示新价生成", async () => {
    const view = await mount();
    try {
        nextPreflightAmount = 2_000_000;
        await click(view.host, "生成图片 - 1积分");
        expect(executions).toHaveLength(0);
        expect(view.host.textContent).toContain("费用或生成范围已更新");
        await waitPrice(view.host);
        expect(view.host.textContent).toContain("生成图片 - 2积分");
        await click(view.host, "生成图片 - 2积分");
        expect(executions).toHaveLength(1);
        expect(confirmations).toHaveLength(0);
        await resolveExecution();
    } finally {
        await view.close();
    }
});

test("报价阻断或读取失败不影响配置自动同步，也不自动生成", async () => {
    const view = await mount();
    try {
        quoteBlocked = "参考图未就绪";
        await prompt(view.host, "等待参考图的草稿");
        for (let i = 0; i < 75 && !view.host.textContent?.includes("参考图未就绪"); i++) await act(settle);
        expect(view.host.querySelector<HTMLButtonElement>(".drama-shot-media-generate")!.disabled).toBe(true);
        expect(view.host.textContent).toContain("参考图未就绪");
        quoteBlocked = "";
        await click(view.host, "重新读取");
        await waitPrice(view.host);
        expect(view.host.querySelector<HTMLButtonElement>(".drama-shot-media-generate")!.disabled).toBe(false);
        expect(view.host.textContent).not.toContain("重新读取");
        quoteFailure = "报价服务暂不可用";
        await prompt(view.host, "另一个未保存草稿");
        for (let i = 0; i < 75 && !view.host.textContent?.includes("报价服务暂不可用"); i++) await act(settle);
        expect(view.host.textContent).toContain("生成图片 - 暂无报价");
        expect(view.host.textContent).toContain("报价服务暂不可用");
        expect(view.host.querySelector<HTMLButtonElement>(".drama-shot-media-generate")!.disabled).toBe(true);
        expect(saves).toHaveLength(2);
        quoteFailure = "";
        await click(view.host, "重新读取");
        await waitPrice(view.host);
        expect(view.host.querySelector<HTMLButtonElement>(".drama-shot-media-generate")!.disabled).toBe(false);
        expect(view.host.textContent).not.toContain("重新读取");
        expect(saves).toHaveLength(2);
        expect(executions).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("只读报价补齐自动视频稿后同步显示，不写配置或重复计价并可直接生成", async () => {
    const canonical = (config: DramaShotMediaConfig) => ({ ...config, prompt: "【00.00—05.00秒｜镜头一：中景·跟】\n完整自动视频稿", promptSourceHash: "automatic-prompt" });
    const view = await mount(
        false,
        () => {
            quoteConfig = preflightConfig = canonical;
        },
        "video",
    );
    try {
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(canonical(server.video.config).prompt);
        expect(view.client.getQueryData<DramaShotMedia>(["drama-shot-media", "user-a", "project-a", "real-shot", "video"])?.config.promptSourceHash).toBe("automatic-prompt");
        for (let i = 0; i < 40; i++) await act(settle);
        expect(draftChecks).toHaveLength(1);
        expect(saves).toHaveLength(0);
        expect(editingStates.at(-1)?.dirty).toBe(false);
        await click(view.host, "生成视频 - 1积分");
        expect(checks).toHaveLength(1);
        expect(executions).toHaveLength(1);
        expect(confirmations).toHaveLength(0);
        await resolveExecution();
    } finally {
        await view.close();
    }
});

test("重新预检发现自动稿更新时先同步编辑框和报价，再次点击直接生成且不产生保存循环", async () => {
    const view = await mount(false, undefined, "video");
    try {
        preflightConfig = (config) => ({ ...config, prompt: "段落上下文更新后的完整视频稿", promptSourceHash: "updated-prompt" });
        await click(view.host, "生成视频 - 1积分");
        expect(executions).toHaveLength(0);
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("段落上下文更新后的完整视频稿");
        expect(view.host.textContent).toContain("费用或生成范围已更新");
        await waitPrice(view.host);
        for (let i = 0; i < 40; i++) await act(settle);
        expect(draftChecks).toHaveLength(1);
        expect(saves).toHaveLength(0);
        expect(editingStates.at(-1)?.dirty).toBe(false);
        await click(view.host, "生成视频 - 1积分");
        expect(executions).toHaveLength(1);
        expect(confirmations).toHaveLength(0);
        await resolveExecution();
    } finally {
        await view.close();
    }
});

test("迟到的补齐报价不覆盖保存期间继续输入的手工稿", async () => {
    const view = await mount(false, undefined, "video");
    const pendingQuote = deferred<void>();
    const pendingSave = deferred<void>();
    try {
        nextDraftCheck = pendingQuote;
        nextSave = pendingSave;
        quoteConfig = (config) => (config.prompt === "第一版草稿" ? { ...config, prompt: "第一版的服务端补齐稿", promptSourceHash: "first-prompt" } : config);
        await prompt(view.host, "第一版草稿");
        for (let i = 0; i < 80 && (!saves.length || draftChecks.length < 2); i++) await act(settle);
        expect(saves).toHaveLength(1);
        expect(draftChecks).toHaveLength(2);
        await prompt(view.host, "保存期间输入的第二版手工稿");
        await act(async () => {
            pendingQuote.resolve();
            await settle();
        });
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("保存期间输入的第二版手工稿");
        await act(async () => {
            pendingSave.resolve();
            await settle();
        });
        await waitPrice(view.host);
        expect(saves).toHaveLength(2);
        expect(saves[1].input.config.prompt).toBe("保存期间输入的第二版手工稿");
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("保存期间输入的第二版手工稿");
        expect(server.video.config.prompt).toBe("保存期间输入的第二版手工稿");
    } finally {
        pendingQuote.resolve();
        pendingSave.resolve();
        await view.close();
    }
});

test("手工稿的空来源标记在报价刷新与自动保存中保留，报价不能把脏稿当成已保存", async () => {
    const view = await mount(
        false,
        () => {
            server.video.config.promptSourceHash = "";
        },
        "video",
    );
    try {
        quoteConfig = (config) => ({ ...config, prompt: config.prompt.trim(), promptSourceHash: "" });
        await prompt(view.host, "  手工调整后的镜头稿  ");
        await waitPrice(view.host);
        expect(saves).toHaveLength(1);
        expect(saves[0].input.config.prompt.trim()).toBe("手工调整后的镜头稿");
        expect(saves[0].input.config.promptSourceHash).toBe("");
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("手工调整后的镜头稿");
        expect(view.client.getQueryData<DramaShotMedia>(["drama-shot-media", "user-a", "project-a", "real-shot", "video"])?.config.promptSourceHash).toBe("");
        for (let i = 0; i < 40; i++) await act(settle);
        expect(saves).toHaveLength(1);
        quoteAmount = 2_000_000;
        await click(view.host, "图片");
        await click(view.host, "视频");
        await waitPrice(view.host);
        expect(view.host.textContent).toContain("生成视频 - 2积分");
        expect(saves).toHaveLength(1);
    } finally {
        await view.close();
    }
});
