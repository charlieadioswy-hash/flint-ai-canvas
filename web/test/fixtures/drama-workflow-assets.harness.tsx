import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaAssetSettings, DramaCast, DramaCastKind, DramaDrawingConfiguration, DramaEpisodeDetail, DramaSettings, DramaSourceFormat, DramaStudioBatchRequest, DramaStudioBatchView, DramaSummary } from "@/services/api/drama";
import { ApiError } from "@/services/api/request";
import type { LocalUser } from "@/stores/use-user-store";

const browser = new Window({ url: "http://localhost/projects/project-a/guide" });
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
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    InputEvent: browser.InputEvent,
    File: browser.File,
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

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
type UserState = { user: LocalUser | null; setUser: (user: LocalUser | null) => void };
type CreateCall = { projectId: string; input: { kind: DramaCastKind; name: string; appearance?: string; description?: string; expectedRevision?: number } };
type SettingsCall = { projectId: string; input: { expectedRevision: number; styleName: string; stylePrompt: string; drawing?: DramaDrawingConfiguration } };
type BatchCall = { projectId: string; input: DramaStudioBatchRequest };

const notices: Array<{ kind: string; text: string }> = [];
const extractCalls: unknown[] = [];
const episodeReads: string[] = [];
const episodeDetails = new Map<string, DramaEpisodeDetail>();
let deferEpisodeReads = false;
const pendingEpisodeReads: Deferred<DramaEpisodeDetail>[] = [];
const createCalls: CreateCall[] = [];
const settingsCalls: SettingsCall[] = [];
const batchChecks: BatchCall[] = [];
const batchExecutions: BatchCall[] = [];
let deferBatchChecks = false;
let deferBatchExecutions = false;
const pendingBatchChecks: Deferred<DramaStudioBatchView>[] = [];
const pendingBatchExecutions: Deferred<DramaStudioBatchView>[] = [];
const chapterReads: string[] = [];
const pendingCreates: Deferred<{ cast: DramaCast }>[] = [];
const pendingSettings: Deferred<DramaSummary>[] = [];
const schemeCallbacks: Array<(value: DramaAssetSettings) => void> = [];

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

const userStore = create<UserState>((set) => ({
    user: { id: "user-a", username: "a", displayName: "账号A", role: "user", status: "active" },
    setUser: (user) => set({ user }),
}));

mock.module("antd", () => ({
    App: {
        useApp: () => ({
            message: {
                success: (text: string) => notices.push({ kind: "success", text }),
                info: (text: string) => notices.push({ kind: "info", text }),
                warning: (text: string) => notices.push({ kind: "warning", text }),
                error: (text: string) => notices.push({ kind: "error", text }),
            },
            modal: { confirm: () => undefined },
        }),
    },
    Button: ({
        children,
        icon,
        loading: _loading,
        size: _size,
        type: _type,
        danger: _danger,
        htmlType = "button",
        ...props
    }: { children?: ReactNode; icon?: ReactNode; loading?: boolean; size?: string; type?: string; danger?: boolean; htmlType?: string } & Record<string, unknown>) => createElement("button", { ...props, type: htmlType }, icon, children),
    Input: Object.assign(({ autoSize: _autoSize, ...props }: Record<string, unknown>) => createElement("input", props), {
        TextArea: ({ autoSize: _autoSize, showCount: _showCount, status: _status, ...props }: Record<string, unknown>) => createElement("textarea", props),
    }),
    Select: ({ options, onChange, ...props }: { options: Array<{ value: string; label: string }>; onChange: (value: string) => void } & Record<string, unknown>) =>
        createElement(
            "select",
            { ...props, onChange: (event: Event) => onChange((event.target as HTMLSelectElement).value) },
            options.map((option) => createElement("option", { key: option.value, value: option.value }, option.label)),
        ),
}));
mock.module("react-router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
    Link: ({ children }: { children?: ReactNode }) => children,
}));
mock.module("@/stores/use-user-store", () => ({ useUserStore: userStore }));
mock.module("@/pages/projects/drama-shared", () => ({
    CAST_KIND_LABEL: { character: "角色", scene: "场景", prop: "道具" },
    parseList: (value?: string) => JSON.parse(value || "[]"),
    MediaThumb: ({ alt }: { alt: string }) => createElement("span", null, alt),
}));
mock.module("@/components/ui/product/app-modal", () => ({
    AppModal: ({ open, title, children, footer }: { open: boolean; title: string; children?: ReactNode; footer?: ReactNode }) => (open ? createElement("section", { role: "dialog", "aria-label": title }, children, footer) : null),
}));
mock.module("@/pages/projects/workflow-impact", () => ({ WorkflowImpact: () => null }));
mock.module("@/pages/projects/workflow-character-library", () => ({ WorkflowCharacterLibrary: () => null }));
mock.module("@/pages/projects/studio/use-studio", () => ({ dramaKeys: { summary: (id: string) => ["drama", id], cast: (id: string) => ["drama", id, "cast"], chapters: (id: string) => ["drama", id, "chapters"] } }));
mock.module("@/pages/projects/guide-panels", () => ({
    GuideAssets: ({
        cast,
        busy,
        loading,
        onEdit,
        onGenerate,
        selectedIds,
        onSelect,
    }: {
        cast: DramaCast[];
        busy: boolean;
        loading: boolean;
        onEdit: (cast: DramaCast) => void;
        onGenerate: (cast: DramaCast) => void;
        selectedIds?: Set<string>;
        onSelect?: (cast: DramaCast, checked: boolean) => void;
    }) =>
        createElement(
            "div",
            { "aria-label": "资产卡片" },
            loading ? createElement("p", null, "卡片加载中") : null,
            cast
                .filter((item) => !item.parentId)
                .map((item) =>
                    createElement(
                        "article",
                        { key: item.id, "aria-label": `${item.kind}:${item.name}` },
                        onSelect
                            ? createElement("input", {
                                  type: "checkbox",
                                  "aria-label": `选择${item.name}`,
                                  checked: selectedIds?.has(item.id) || false,
                                  disabled: busy,
                                  onChange: (event: Event) => onSelect(item, (event.target as HTMLInputElement).checked),
                              })
                            : null,
                        createElement("h3", null, item.name),
                        createElement("button", { type: "button", disabled: busy, onClick: () => onEdit(item) }, `编辑${item.name}`),
                        createElement("button", { type: "button", disabled: busy, onClick: () => onGenerate(item) }, `生成${item.name}`),
                        cast
                            .filter((look) => look.parentId === item.id)
                            .map((look) =>
                                createElement(
                                    "p",
                                    { key: look.id },
                                    onSelect
                                        ? createElement("input", {
                                              type: "checkbox",
                                              "aria-label": `选择${item.name} · ${look.lookName}`,
                                              checked: selectedIds?.has(look.id) || false,
                                              disabled: busy,
                                              onChange: (event: Event) => onSelect(look, (event.target as HTMLInputElement).checked),
                                          })
                                        : null,
                                    `${item.name}造型 ${look.lookName}`,
                                ),
                            ),
                    ),
                ),
            !cast.filter((item) => !item.parentId).length ? createElement("p", null, loading ? "正在提取资产文字设定" : "尚未生成资产文字") : null,
        ),
}));
mock.module("@/pages/projects/studio/cast-editor-dialog", () => ({
    CastEditorDialog: ({ summary, cast, castId, onClose }: { summary: DramaSummary; cast: DramaCast[]; castId?: string; onClose: () => void }) => {
        if (!castId) return null;
        const current = cast.find((item) => item.id === castId && item.projectId === summary.project.id);
        return createElement(
            "section",
            { "aria-label": "资产设定编辑器", "data-project": summary.project.id },
            current ? createElement("h2", null, `${current.name} · 资产设定`) : createElement("p", null, "此资产已不存在"),
            createElement("button", { type: "button", onClick: onClose }, "关闭资产设定"),
        );
    },
}));
mock.module("@/pages/projects/asset-scheme", () => ({
    AssetSchemePicker: ({ value, onChange }: { value?: DramaAssetSettings; onChange: (value: DramaAssetSettings) => void }) => {
        schemeCallbacks.push(onChange);
        return createElement(
            "section",
            { "aria-label": "参考图方案" },
            createElement("p", null, `方案 ${value?.mode || "未选择"}`),
            createElement(
                "button",
                {
                    type: "button",
                    onClick: () => value && onChange({ ...value, mode: value.mode === "closeup_turnaround" ? "closeup_front_no_face" : "closeup_turnaround", characterPrompt: "改后的角色提示词" }),
                },
                "切换参考图方案",
            ),
            createElement("textarea", {
                "aria-label": "角色参考图提示词",
                value: value?.characterPrompt || "",
                onChange: (event: Event) => value && onChange({ ...value, characterPrompt: (event.target as HTMLTextAreaElement).value }),
            }),
        );
    },
    useAssetSchemes: () => ({ data: undefined, isLoading: false, isError: false, refetch: async () => ({ data: undefined }) }),
}));
mock.module("@/services/api/drama", () => ({
    getDramaEpisode: async (projectId: string, episodeId: string) => {
        episodeReads.push(`${projectId}:${episodeId}`);
        if (deferEpisodeReads) {
            const pending = deferred<DramaEpisodeDetail>();
            pendingEpisodeReads.push(pending);
            return pending.promise;
        }
        return episodeDetails.get(episodeId) || ({ episode: { id: episodeId }, shots: [], segments: [] } as unknown as DramaEpisodeDetail);
    },
    preflightDramaStudioBatch: async (projectId: string, input: DramaStudioBatchRequest) => {
        batchChecks.push({ projectId, input: structuredClone(input) });
        if (deferBatchChecks) {
            const pending = deferred<DramaStudioBatchView>();
            pendingBatchChecks.push(pending);
            return pending.promise;
        }
        return batchResponse(input, "ready");
    },
    executeDramaStudioBatch: async (projectId: string, input: DramaStudioBatchRequest) => {
        batchExecutions.push({ projectId, input: structuredClone(input) });
        if (deferBatchExecutions) {
            const pending = deferred<DramaStudioBatchView>();
            pendingBatchExecutions.push(pending);
            return pending.promise;
        }
        return batchResponse(input, "queued");
    },
    listDramaChapters: async (projectId: string) => {
        chapterReads.push(projectId);
        return {
            chapters:
                projectId === "project-a"
                    ? [
                          { id: "chapter-a", title: "第一章", position: 1, wordCount: 20, reserved: false },
                          { id: "chapter-b", title: "第二章", position: 2, wordCount: 20, reserved: true },
                      ]
                    : [{ id: "chapter-other", title: "其他项目章节", position: 1, wordCount: 8, reserved: false }],
        };
    },
    extractDramaCast: async (projectId: string, input: unknown) => {
        extractCalls.push({ projectId, input: structuredClone(input) });
        throw new Error("主体管理不应重新提取资产");
    },
    createDramaCast: async (projectId: string, input: CreateCall["input"]) => {
        createCalls.push({ projectId, input: structuredClone(input) });
        const pending = deferred<{ cast: DramaCast }>();
        pendingCreates.push(pending);
        return pending.promise;
    },
    updateDramaWorkflowStyle: async (projectId: string, input: SettingsCall["input"]) => {
        settingsCalls.push({ projectId, input: structuredClone(input) });
        const pending = deferred<DramaSummary>();
        pendingSettings.push(pending);
        return pending.promise;
    },
}));

const { WorkflowAssets } = await import("@/pages/projects/workflow-assets");

function batchResponse(input: DramaStudioBatchRequest, status: "ready" | "queued"): DramaStudioBatchView {
    const counts: DramaStudioBatchView["counts"] = { ready: 0, queued: 0, already_queued: 0, skipped_ready: 0, blocked: 0, conflict: 0, failed: 0 };
    counts[status] = input.targetIds.length;
    return {
        action: input.action,
        targetIds: [...input.targetIds],
        baseRevision: input.baseRevision || 1,
        ready: status === "ready",
        confirmationToken: "batch-confirmation",
        amountMicrocredits: input.targetIds.length * 1_000_000,
        priced: true,
        counts,
        items: input.targetIds.map((targetId) => ({ targetId, targetKind: "cast", targetRevision: 1, status, amountMicrocredits: 1_000_000, priced: true })),
    };
}

afterAll(() => {
    browser.happyDOM.abort();
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function assets(): DramaAssetSettings {
    return { mode: "closeup_turnaround", characterPrompt: "角色提示", scenePrompt: "场景提示", characterRatio: "16:9" };
}

function settings(assetSettings = assets()): DramaSettings {
    return {
        aspectRatio: "9:16",
        episodeSeconds: 90,
        stylePrompt: "写实",
        styleName: "写实",
        language: "中文普通话",
        assets: assetSettings,
        storyboard: { segmentMode: "auto", segmentSeconds: 8, segmentMinSeconds: 4, segmentMaxSeconds: 12, pacing: "fast", dialogue: "standard", transition: "auto", transitionMs: 0, performance: 5, cameraMotion: 5 },
        reviewMode: "sample",
        mediaMode: "manual",
        concurrency: 2,
        models: { text: { modelKey: "text" }, image: { modelKey: "image" }, video: { modelKey: "video" } },
        referenceLimit: 3,
        episodeMode: "chapter",
        chaptersPerEpisode: 1,
        videoContinuity: "tail_frame",
    };
}

function summaryOf(projectId: string, revision: number, assetSettings = assets()): DramaSummary {
    return {
        project: {
            id: projectId,
            userId: "user-a",
            name: projectId === "project-a" ? "资产回归" : "另一个作品",
            type: "drama",
            aspectRatio: "9:16",
            sourceType: "novel" as DramaSourceFormat,
            description: "",
            stylePresetId: "",
            status: "active",
            revision: 1,
            createdAt: "2026-11-13T00:00:00Z",
            updatedAt: "2026-11-13T00:00:00Z",
        },
        production: {
            revision,
            guideStep: "assets",
            status: "draft",
            stage: "bible",
            pauseReason: "",
            settings: settings(assetSettings),
            budgetMicrocredits: 0,
            spentMicrocredits: 0,
            canvasSpentMicrocredits: 0,
            heldMicrocredits: 0,
            planDone: false,
            planCursor: 0,
            sampleApproved: false,
            assetsReleased: false,
            logline: "",
            tone: "",
            chapterCount: 1,
            wordCount: 20,
            reservedChapterCount: 1,
            reservedWordCount: 20,
        },
        episodes:
            projectId === "project-a"
                ? [
                      {
                          id: "episode-1",
                          number: 1,
                          title: "第一集",
                          synopsis: "",
                          stage: "queued",
                          sourceFormat: "novel",
                          error: "",
                          shotCount: 0,
                          durationMs: 0,
                          approved: false,
                          mediaReleased: false,
                          awaitingMedia: false,
                          finalStale: false,
                          stats: { segments: 0, promptReady: 0, promptSucceeded: 0, videoReady: 0, videoGenerated: 0, failed: 0 },
                      },
                      {
                          id: "episode-2",
                          number: 2,
                          title: "第二集",
                          synopsis: "",
                          stage: "queued",
                          sourceFormat: "novel",
                          error: "",
                          shotCount: 0,
                          durationMs: 0,
                          approved: false,
                          mediaReleased: false,
                          awaitingMedia: false,
                          finalStale: false,
                          stats: { segments: 0, promptReady: 0, promptSucceeded: 0, videoReady: 0, videoGenerated: 0, failed: 0 },
                      },
                  ]
                : [
                      {
                          id: "episode-other",
                          number: 1,
                          title: "其他作品第一集",
                          synopsis: "",
                          stage: "queued",
                          sourceFormat: "novel",
                          error: "",
                          shotCount: 0,
                          durationMs: 0,
                          approved: false,
                          mediaReleased: false,
                          awaitingMedia: false,
                          finalStale: false,
                          stats: { segments: 0, promptReady: 0, promptSucceeded: 0, videoReady: 0, videoGenerated: 0, failed: 0 },
                      },
                  ],
        jobCounts: {},
        inbox: [],
        castCount: 0,
        guide: { step: "assets", canConfirm: false },
    } as unknown as DramaSummary;
}

function castOf(projectId: string, id: string, kind: DramaCastKind, name: string, extra: Partial<DramaCast> = {}): DramaCast {
    return {
        id,
        projectId,
        kind,
        name,
        aliasesJson: "[]",
        role: "",
        description: "",
        appearance: `${name}设定`,
        voiceInstructions: "",
        importance: 1,
        imageStatus: "",
        imageVersion: 0,
        locked: false,
        position: 1,
        ...extra,
    };
}

function projectCast() {
    return [
        castOf("project-a", "hero", "character", "林夏"),
        castOf("project-a", "hero-look", "character", "林夏", { parentId: "hero", lookName: "雨夜" }),
        castOf("project-a", "room", "scene", "旧宅"),
        castOf("project-a", "key", "prop", "铜钥匙"),
        castOf("project-b", "other-hero", "character", "其他作品角色"),
    ];
}

function resetFixture() {
    notices.length = 0;
    extractCalls.length = 0;
    createCalls.length = 0;
    settingsCalls.length = 0;
    batchChecks.length = 0;
    batchExecutions.length = 0;
    deferBatchChecks = false;
    deferBatchExecutions = false;
    pendingBatchChecks.length = 0;
    pendingBatchExecutions.length = 0;
    chapterReads.length = 0;
    episodeReads.length = 0;
    episodeDetails.clear();
    deferEpisodeReads = false;
    pendingEpisodeReads.length = 0;
    pendingCreates.length = 0;
    pendingSettings.length = 0;
    schemeCallbacks.length = 0;
    userStore.setState({ user: { id: "user-a", username: "a", displayName: "账号A", role: "user", status: "active" } });
}

async function settle() {
    for (let index = 0; index < 8; index += 1) await Bun.sleep(10);
}

async function mount(initial: DramaSummary, cast = projectCast(), options: { loading?: boolean; busy?: boolean; variant?: "library" | "episode"; episodeId?: string; controlled?: boolean; advanceRevisionOnChange?: boolean; pickable?: boolean } = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const changed: string[] = [];
    const generated: string[] = [];
    const dirtyStates: Array<[boolean, boolean]> = [];
    const episodeChanges: string[] = [];
    const pickedChapters: string[] = [];
    let current = { summary: initial, cast, loading: options.loading ?? false, busy: options.busy ?? false, variant: options.variant ?? "episode", episodeId: options.episodeId };
    const render = () =>
        createElement(
            QueryClientProvider,
            { client },
            createElement(WorkflowAssets, {
                ...current,
                onChanged: () => {
                    changed.push(current.summary.project.id);
                    if (options.advanceRevisionOnChange) {
                        current = { ...current, summary: { ...current.summary, production: { ...current.summary.production, revision: current.summary.production.revision + 1 } } };
                        root.render(render());
                    }
                },
                onGenerate: (item) => generated.push(`${current.summary.project.id}:${item.id}`),
                onDirtyChange: (dirty, busy) => dirtyStates.push([dirty, busy]),
                onEpisodeChange: options.controlled ? (id) => episodeChanges.push(id) : undefined,
                onPickChapters: options.pickable ? () => pickedChapters.push(current.summary.project.id) : undefined,
            }),
        );
    const update = async (patch: Partial<typeof current>) => {
        current = { ...current, ...patch };
        await act(async () => {
            root.render(render());
            await settle();
        });
        await act(async () => {
            await settle();
        });
    };
    await update({});
    return {
        container,
        changed,
        generated,
        dirtyStates,
        episodeChanges,
        pickedChapters,
        client,
        update,
        dispose: async () => {
            await act(async () => root.unmount());
            container.remove();
            client.clear();
            client.unmount();
        },
    };
}

function button(container: HTMLElement, label: string) {
    const found = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes(label));
    expect(found, `未找到按钮 ${label}`).toBeDefined();
    return found!;
}

function field(container: HTMLElement, label: string) {
    const found = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
    expect(found, `未找到 ${label}`).not.toBeNull();
    return found!;
}

async function edit(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
    await act(async () => {
        const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        setter?.call(node, value);
        node.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
        await settle();
    });
}

async function click(node: HTMLElement) {
    await act(async () => {
        node.click();
        await settle();
    });
}

test("三列同时展示类型和角色造型，不展示其他作品资产", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4));
    try {
        for (const kind of ["角色", "场景", "道具"]) expect(view.container.querySelector(`[aria-label="${kind}资产"]`)?.textContent).toContain("共 1 项");
        expect(view.container.querySelector('[aria-label="character:林夏"]')?.textContent).toContain("林夏造型 雨夜");
        expect(view.container.textContent).not.toContain("其他作品角色");
        expect(view.container.querySelector('[aria-label="scene:旧宅"]')).not.toBeNull();
        expect(view.container.querySelector('[aria-label="character:林夏"]')).not.toBeNull();
        expect(view.container.textContent).toContain("林夏造型 雨夜");
        expect(view.container.querySelector('[aria-label="prop:铜钥匙"]')).not.toBeNull();
        await click(button(view.container, "生成旧宅"));
        expect(view.generated).toEqual(["project-a:room"]);
        expect(extractCalls).toHaveLength(0);
        expect(createCalls).toHaveLength(0);
        expect(chapterReads).toHaveLength(0);
        expect(view.container.textContent).toContain("本集尚未编排分镜，展示作品共享主体。");
        expect(view.container.querySelector('[aria-label="提取范围"]')).toBeNull();
        expect(view.container.querySelector('[aria-label="按集查看资产"]')).toBeNull();
        expect(view.container.querySelector('[aria-label^="快速新增"]')).toBeNull();
        expect(view.container.textContent).not.toContain("补充提取资产");
        expect(view.container.textContent).not.toContain("批量选择");
    } finally {
        await view.dispose();
    }
});

test("主体资产库批量选择只显示当前分类，选择当前范围后按真实 ID 预检并提交", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4), projectCast(), { variant: "library" });
    const categories = [
        { label: "角色", names: ["选择林夏", "选择林夏 · 雨夜"], ids: ["hero", "hero-look"] },
        { label: "场景", names: ["选择旧宅"], ids: ["room"] },
        { label: "道具", names: ["选择铜钥匙"], ids: ["key"] },
    ];
    try {
        await click(button(view.container, "批量选择"));
        for (const [index, category] of categories.entries()) {
            const tabs = view.container.querySelector<HTMLElement>('[aria-label="主体资产分类"]')!;
            await click(button(tabs, category.label));
            expect(Array.from(view.container.querySelectorAll('.drama-workflow-asset-selection input[type="checkbox"]'), (item) => item.getAttribute("aria-label"))).toEqual(category.names);
            await click(button(view.container, "选择当前范围"));
            await click(button(view.container, "批量生成参考图"));
            expect(batchChecks).toHaveLength(index + 1);
            expect(batchChecks[index]).toEqual({ projectId: "project-a", input: { action: "cast_image", targetIds: category.ids, baseRevision: 4 } });
            await click(button(view.container, "确认提交本批次"));
            expect(batchExecutions).toHaveLength(index + 1);
            expect(batchExecutions[index]).toEqual({ projectId: "project-a", input: { action: "cast_image", targetIds: category.ids, baseRevision: 4, confirmationToken: "batch-confirmation" } });
            await click(button(view.container, "关闭"));
            await click(button(view.container, "清空选择（"));
        }
        expect(view.changed).toEqual(["project-a", "project-a", "project-a"]);
    } finally {
        await view.dispose();
    }
});

test("单集三栏分别全选与提交真实类型范围，角色包含造型且不串入其他类型或作品", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4));
    try {
        const columns = [
            { label: "角色", ids: ["hero", "hero-look"] },
            { label: "场景", ids: ["room"] },
            { label: "道具", ids: ["key"] },
        ];
        for (const [index, column] of columns.entries()) {
            await click(field(view.container, `选择本集全部${column.label}`));
            await click(button(view.container, `生成${column.label}图片`));
            expect(batchChecks[index]).toEqual({ projectId: "project-a", input: { action: "cast_image", targetIds: column.ids, baseRevision: 4 } });
            expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain(`范围：当前列表已选 ${column.ids.length} 项${column.label}及造型`);
            await click(button(view.container, "确认提交本批次"));
            expect(batchExecutions[index]).toEqual({ projectId: "project-a", input: { action: "cast_image", targetIds: column.ids, baseRevision: 4, confirmationToken: "batch-confirmation" } });
            await click(button(view.container, "关闭"));
        }
        expect(view.changed).toEqual(["project-a", "project-a", "project-a"]);
        await click(field(view.container, "选择林夏 · 雨夜"));
        expect(view.container.querySelector<HTMLInputElement>('[aria-label="选择本集全部角色"]')?.indeterminate).toBe(true);
        expect(view.container.querySelector<HTMLInputElement>('[aria-label="选择本集全部场景"]')?.checked).toBe(true);
        await click(button(view.container, "生成角色图片"));
        expect(batchChecks.at(-1)?.input.targetIds).toEqual(["hero"]);
        await click(button(view.container, "取消"));
        await click(view.container.querySelector<HTMLButtonElement>('[aria-label="下一集主体资产"]')!);
        expect(view.container.querySelector<HTMLInputElement>('[aria-label="选择本集全部角色"]')?.checked).toBe(false);
        expect(view.container.querySelector<HTMLInputElement>('[aria-label="选择本集全部场景"]')?.checked).toBe(false);
        expect(button(view.container, "生成角色图片").disabled).toBe(true);
    } finally {
        await view.dispose();
    }
});

test("从资产库批选返回单集时恢复三栏，清除全局批选模式与跨范围选择", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4), projectCast(), { variant: "library" });
    try {
        await click(button(view.container, "批量选择"));
        await click(button(view.container, "选择当前范围"));
        expect(view.container.querySelectorAll('.drama-workflow-asset-selection input[type="checkbox"]')).toHaveLength(2);
        expect(view.container.textContent).toContain("清空选择（2）");
        await view.update({ variant: "episode" });
        expect(view.container.querySelector('[aria-label="按集查看资产"]')).toBeNull();
        expect(view.container.querySelector(".drama-workflow-asset-selection")).toBeNull();
        expect(view.container.textContent).not.toContain("批量选择");
        expect(view.container.textContent).not.toContain("清空选择（2）");
        expect(view.container.querySelectorAll(".drama-workflow-assets-column")).toHaveLength(3);
        for (const label of ["角色", "场景", "道具"]) {
            expect(view.container.querySelector<HTMLInputElement>(`[aria-label="选择本集全部${label}"]`)?.checked).toBe(false);
            expect(button(view.container, `生成${label}图片`).disabled).toBe(true);
        }
        expect(batchChecks).toHaveLength(0);
        expect(batchExecutions).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("主体管理默认第一集，左右和下拉切换同一集范围且不额外提取", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4));
    try {
        const select = view.container.querySelector<HTMLSelectElement>('[aria-label="主体管理剧集"]')!;
        expect(select.value).toBe("episode-1");
        expect(view.container.querySelector<HTMLButtonElement>('[aria-label="上一集主体资产"]')?.disabled).toBe(true);
        expect(episodeReads).toEqual(["project-a:episode-1"]);
        await click(view.container.querySelector<HTMLButtonElement>('[aria-label="下一集主体资产"]')!);
        expect(select.value).toBe("episode-2");
        expect(view.container.querySelector<HTMLButtonElement>('[aria-label="下一集主体资产"]')?.disabled).toBe(true);
        expect(episodeReads.at(-1)).toBe("project-a:episode-2");
        await click(view.container.querySelector<HTMLButtonElement>('[aria-label="上一集主体资产"]')!);
        expect(select.value).toBe("episode-1");
        await act(async () => {
            select.value = "episode-2";
            select.dispatchEvent(new Event("change", { bubbles: true }));
            await settle();
        });
        expect(select.value).toBe("episode-2");
        expect(extractCalls).toHaveLength(0);
        expect(chapterReads).toHaveLength(0);
        expect(createCalls).toHaveLength(0);
        expect(settingsCalls).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("主体管理区分原文章节与制作集，继续选章只通知父层且草稿或忙碌时禁用", async () => {
    resetFixture();
    const data = summaryOf("project-a", 4);
    data.production.chapterCount = 1;
    data.production.reservedChapterCount = 8;
    data.episodes = data.episodes.slice(0, 1);
    const view = await mount(data, projectCast(), { pickable: true });
    try {
        expect(view.container.textContent).toContain("原文 9 章 · 制作 1 集 · 待制作 8 章");
        expect(view.container.querySelectorAll('[aria-label="主体管理剧集"] option')).toHaveLength(1);
        await click(button(view.container, "继续选章"));
        expect(view.pickedChapters).toEqual(["project-a"]);
        expect(chapterReads).toHaveLength(0);
        expect(createCalls).toHaveLength(0);
        expect(extractCalls).toHaveLength(0);
        await view.update({ busy: true });
        expect(button(view.container, "继续选章").disabled).toBe(true);
        await view.update({ busy: false });
        await click(view.container.querySelector<HTMLButtonElement>('[aria-label="新增角色"]')!);
        await edit(field(view.container, "资产名称"), "尚未保存的角色");
        expect(button(view.container, "继续选章").disabled).toBe(true);
        await view.update({ summary: { ...data, production: { ...data.production, reservedChapterCount: 0 } } });
        expect(view.container.textContent).not.toContain("继续选章");
    } finally {
        await view.dispose();
    }
});

test("图片批次预检与提交未返回时冻结选集并回报忙状态，收到回执后恢复", async () => {
    resetFixture();
    deferBatchChecks = true;
    deferBatchExecutions = true;
    const initial = summaryOf("project-a", 4);
    initial.episodes.push({ ...initial.episodes[1]!, id: "episode-3", number: 3 });
    const view = await mount(initial);
    const previous = () => view.container.querySelector<HTMLButtonElement>('[aria-label="上一集主体资产"]')!;
    const next = () => view.container.querySelector<HTMLButtonElement>('[aria-label="下一集主体资产"]')!;
    const select = () => view.container.querySelector<HTMLSelectElement>('[aria-label="主体管理剧集"]')!;
    try {
        await click(next());
        expect(select().value).toBe("episode-2");
        expect(previous().disabled).toBe(false);
        expect(next().disabled).toBe(false);
        await click(field(view.container, "选择本集全部角色"));
        await click(button(view.container, "生成角色图片"));
        expect(pendingBatchChecks).toHaveLength(1);
        expect(view.dirtyStates.at(-1)).toEqual([false, true]);
        expect(previous().disabled).toBe(true);
        expect(next().disabled).toBe(true);
        expect(select().disabled).toBe(true);
        await click(previous());
        await click(next());
        expect(select().value).toBe("episode-2");
        await act(async () => {
            pendingBatchChecks[0]!.resolve(batchResponse(batchChecks[0]!.input, "ready"));
            await settle();
        });
        expect(view.dirtyStates.at(-1)).toEqual([false, false]);
        expect(previous().disabled).toBe(false);
        expect(next().disabled).toBe(false);
        expect(select().disabled).toBe(false);
        await click(button(view.container, "确认提交本批次"));
        expect(pendingBatchExecutions).toHaveLength(1);
        expect(view.dirtyStates.at(-1)).toEqual([false, true]);
        expect(previous().disabled).toBe(true);
        expect(next().disabled).toBe(true);
        expect(select().disabled).toBe(true);
        await click(next());
        expect(select().value).toBe("episode-2");
        await act(async () => {
            pendingBatchExecutions[0]!.resolve(batchResponse(batchExecutions[0]!.input, "queued"));
            await settle();
        });
        expect(view.dirtyStates.at(-1)).toEqual([false, false]);
        expect(previous().disabled).toBe(false);
        expect(next().disabled).toBe(false);
        expect(select().disabled).toBe(false);
        expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain("已加入队列 2 项");
        expect(batchChecks).toHaveLength(1);
        expect(batchExecutions).toHaveLength(1);
        expect(view.changed).toEqual(["project-a"]);
    } finally {
        await view.dispose();
    }
});

test("批次成功推进版本后刷新同集引用，保留已提交弹窗与原列并禁止旧范围继续生成", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4), projectCast(), { advanceRevisionOnChange: true });
    try {
        await click(field(view.container, "选择本集全部角色"));
        await click(button(view.container, "生成角色图片"));
        const column = view.container.querySelector('[aria-label="角色资产"]')!;
        deferEpisodeReads = true;
        await click(button(view.container, "确认提交本批次"));
        expect(view.changed).toEqual(["project-a"]);
        expect(pendingEpisodeReads).toHaveLength(1);
        expect(view.container.querySelector('[aria-label="角色资产"]')).toBe(column);
        expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain("已加入队列 2 项");
        expect(view.container.querySelector<HTMLInputElement>('[aria-label="选择本集全部角色"]')?.disabled).toBe(true);
        expect(view.container.querySelector<HTMLInputElement>('[aria-label="选择林夏"]')?.disabled).toBe(true);
        expect(button(view.container, "生成角色图片").disabled).toBe(true);
        await act(async () => {
            pendingEpisodeReads[0]!.reject(new Error("引用刷新失败"));
            await settle();
        });
        expect(view.container.textContent).toContain("本集引用资产刷新失败，已保留列表");
        expect(view.container.querySelector('[aria-label="角色资产"]')).toBe(column);
        expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain("已加入队列 2 项");
        expect(button(view.container, "生成角色图片").disabled).toBe(true);
        await click(button(view.container, "重试"));
        expect(pendingEpisodeReads).toHaveLength(2);
        await act(async () => {
            pendingEpisodeReads[1]!.resolve({ episode: { id: "episode-1" }, shots: [], segments: [] } as unknown as DramaEpisodeDetail);
            await settle();
        });
        expect(view.container.querySelector('[aria-label="角色资产"]')).toBe(column);
        expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain("已加入队列 2 项");
        expect(view.container.querySelector<HTMLInputElement>('[aria-label="选择本集全部角色"]')?.disabled).toBe(false);
        expect(button(view.container, "生成角色图片").disabled).toBe(false);
        expect(batchChecks).toHaveLength(1);
        expect(batchExecutions).toHaveLength(1);
        await click(button(view.container, "关闭"));
        expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    } finally {
        await view.dispose();
    }
});

test("受控选集只通知父路由，父属性更新后再切换真实引用范围", async () => {
    resetFixture();
    episodeDetails.set("episode-2", { episode: { id: "episode-2" }, shots: [{ castIdsJson: '["hero"]', lookCastIdsJson: "[]", propIdsJson: "[]" }], segments: [] } as unknown as DramaEpisodeDetail);
    const view = await mount(summaryOf("project-a", 7), projectCast(), { controlled: true, episodeId: "episode-1" });
    try {
        await click(view.container.querySelector<HTMLButtonElement>('[aria-label="下一集主体资产"]')!);
        expect(view.episodeChanges).toEqual(["episode-2"]);
        expect(view.container.querySelector<HTMLSelectElement>('[aria-label="主体管理剧集"]')?.value).toBe("episode-1");
        expect(episodeReads).toEqual(["project-a:episode-1"]);
        await view.update({ episodeId: "episode-2" });
        expect(episodeReads.at(-1)).toBe("project-a:episode-2");
        expect(view.container.querySelector('[aria-label="character:林夏"]')).not.toBeNull();
        expect(view.container.querySelector('[aria-label="scene:旧宅"]')).toBeNull();
        expect(view.container.querySelector('[aria-label="prop:铜钥匙"]')).toBeNull();
        expect(view.container.textContent).not.toContain("展示作品共享主体");
    } finally {
        await view.dispose();
    }
});

test("新增草稿、保存忙碌及编辑器打开时阻止切集，关闭后恢复", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4));
    const next = () => view.container.querySelector<HTMLButtonElement>('[aria-label="下一集主体资产"]')!;
    const select = () => view.container.querySelector<HTMLSelectElement>('[aria-label="主体管理剧集"]')!;
    try {
        await click(view.container.querySelector<HTMLButtonElement>('[aria-label="新增角色"]')!);
        await edit(field(view.container, "资产名称"), "未保存角色");
        expect(next().disabled).toBe(true);
        expect(select().disabled).toBe(true);
        await click(next());
        expect(select().value).toBe("episode-1");
        await click(button(view.container, "取消"));
        expect(next().disabled).toBe(false);
        await view.update({ busy: true });
        expect(next().disabled).toBe(true);
        expect(select().disabled).toBe(true);
        await view.update({ busy: false });
        await click(button(view.container, "编辑林夏"));
        expect(next().disabled).toBe(true);
        expect(select().disabled).toBe(true);
        await click(button(view.container, "关闭资产设定"));
        expect(next().disabled).toBe(false);
        await click(next());
        expect(select().value).toBe("episode-2");
    } finally {
        await view.dispose();
    }
});

test("快速新增只提交用户字段，成功后打开真实编辑器边界", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4));
    try {
        await click(view.container.querySelector<HTMLButtonElement>('[aria-label="新增角色"]')!);
        await edit(field(view.container, "资产名称"), "新道具");
        await click(button(view.container, "保存资产"));
        expect(createCalls).toEqual([{ projectId: "project-a", input: { kind: "character", name: "新道具", expectedRevision: 4 } }]);
        expect(createCalls[0]?.input).not.toHaveProperty("appearance");
        expect(createCalls[0]?.input).not.toHaveProperty("description");
        expect(extractCalls).toHaveLength(0);
        const created = castOf("project-a", "created-1", "character", "新道具", { appearance: "" });
        await act(async () => {
            pendingCreates[0]!.resolve({ cast: created });
            await settle();
        });
        expect(view.container.querySelector('[aria-label="资产设定编辑器"]')?.textContent).toContain("新道具 · 资产设定");
        expect(view.container.textContent).not.toContain("此资产已不存在");
        expect(view.changed).toEqual(["project-a"]);
        expect(notices.some((item) => item.kind === "success")).toBe(true);
        await view.update({ cast: [...projectCast(), created] });
        await view.update({ cast: projectCast() });
        expect(view.container.querySelector('[aria-label="资产设定编辑器"]')?.textContent).toContain("此资产已不存在");
    } finally {
        await view.dispose();
    }
});

test("本体已引用的未引用造型仍可从角色卡找到并单独生成", async () => {
    resetFixture();
    episodeDetails.set("episode-1", { episode: { id: "episode-1" }, shots: [{ castIdsJson: '["hero"]', lookCastIdsJson: "[]", propIdsJson: "[]" }], segments: [] } as unknown as DramaEpisodeDetail);
    const view = await mount(summaryOf("project-a", 4));
    try {
        expect(view.container.querySelector('[aria-label="character:林夏"]')?.textContent).toContain("林夏造型 雨夜");
        await click(field(view.container, "选择林夏 · 雨夜"));
        expect(field(view.container, "选择本集全部角色")).toHaveProperty("checked", false);
        await click(button(view.container, "生成角色图片"));
        expect(batchChecks.at(-1)?.input.targetIds).toEqual(["hero-look"]);
    } finally {
        await view.dispose();
    }
});

test("新增失败保留已填名称", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4));
    try {
        await click(view.container.querySelector<HTMLButtonElement>('[aria-label="新增角色"]')!);
        await edit(field(view.container, "资产名称"), "失败道具");
        await click(button(view.container, "保存资产"));
        await act(async () => {
            pendingCreates[0]!.reject(new Error("名称已被占用"));
            await settle();
        });
        expect(field(view.container, "资产名称").value).toBe("失败道具");
        expect(view.container.querySelector('[aria-label="资产设定编辑器"]')).toBeNull();
        expect(view.changed).toEqual([]);
    } finally {
        await view.dispose();
    }
});

for (const [kind, label] of [
    ["character", "角色"],
    ["scene", "场景"],
    ["prop", "道具"],
] as const) {
    test(`已编排集新增${label}保留在共享区，可编辑选择生成且重载后仍可找到`, async () => {
        resetFixture();
        const detail = { episode: { id: "episode-1" }, shots: [{ castIdsJson: '["hero"]', lookCastIdsJson: "[]", propIdsJson: '["key"]', sceneCastId: "room" }], segments: [] } as unknown as DramaEpisodeDetail;
        episodeDetails.set("episode-1", detail);
        const created = castOf("project-a", `new-${kind}`, kind, `新${label}`);
        let view = await mount(summaryOf("project-a", 4));
        try {
            await click(view.container.querySelector<HTMLButtonElement>(`[aria-label="新增${label}"]`)!);
            await edit(field(view.container, "资产名称"), created.name);
            await click(button(view.container, "保存资产"));
            await act(async () => {
                pendingCreates[0]!.resolve({ cast: created });
                await settle();
            });
            await view.update({ cast: [...projectCast(), created], summary: summaryOf("project-a", 5) });
            await click(button(view.container, "关闭资产设定"));
            const column = view.container.querySelector(`[aria-label="${label}资产"]`)!;
            const shared = column.querySelector<HTMLDetailsElement>(".drama-workflow-assets-shared")!;
            expect(shared.open).toBe(true);
            expect(shared.querySelector(`[aria-label="${kind}:${created.name}"]`)).not.toBeNull();
            expect(column.querySelector(`:scope > [aria-label="资产卡片"] [aria-label="${kind}:${created.name}"]`)).toBeNull();
            await click(button(shared, `编辑${created.name}`));
            expect(view.container.querySelector('[aria-label="资产设定编辑器"]')?.textContent).toContain(created.name);
            await click(button(view.container, "关闭资产设定"));
            await click(button(shared, `生成${created.name}`));
            expect(view.generated).toEqual([`project-a:${created.id}`]);
            await click(field(shared, `选择${created.name}`));
            await click(field(column, `选择本集全部${label}`));
            await click(field(column, `选择本集全部${label}`));
            expect(field(shared, `选择${created.name}`)).toHaveProperty("checked", true);
            await click(button(column, `生成${label}图片`));
            expect(batchChecks.at(-1)?.input.targetIds).toEqual([created.id]);
            expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain("当前列表已选 1 项");
            await click(button(view.container, "取消"));

            await view.dispose();
            view = await mount(summaryOf("project-a", 5), [...projectCast(), created]);
            const reloadedColumn = view.container.querySelector(`[aria-label="${label}资产"]`)!;
            const reloaded = reloadedColumn.querySelector<HTMLDetailsElement>(".drama-workflow-assets-shared")!;
            expect(reloaded.open).toBe(false);
            expect(reloaded.querySelector("summary")?.textContent).toContain("本集未引用（1）");
            await click(reloaded.querySelector("summary")!);
            expect(reloaded.querySelector(`[aria-label="${kind}:${created.name}"]`)).not.toBeNull();
            await view.update({ cast: projectCast() });
            expect(reloadedColumn.querySelector(".drama-workflow-assets-shared")).toBeNull();
            expect(view.container.querySelector(`[aria-label="${kind}:${created.name}"]`)).toBeNull();
        } finally {
            await view.dispose();
        }
    });
}

test("风格配置阶段禁止新增、编辑与生成，资产库分类仍可切换", async () => {
    resetFixture();
    const initial = summaryOf("project-a", 4);
    initial.production.guideStep = "configuring";
    initial.guide = { step: "configuring", canConfirm: true };
    const view = await mount(initial, projectCast(), { variant: "library" });
    try {
        expect(view.container.textContent).toContain("请先完成风格设置，进入角色场景后再新增或编辑资产。");
        expect(button(view.container, "新增角色").disabled).toBe(true);
        expect(view.container.querySelector<HTMLButtonElement>('[aria-label="新增角色"]')?.disabled).toBe(true);
        expect(button(view.container, "编辑林夏").disabled).toBe(true);
        expect(button(view.container, "生成林夏").disabled).toBe(true);
        await click(button(view.container, "新增角色"));
        await click(button(view.container, "编辑林夏"));
        await click(button(view.container, "生成林夏"));
        expect(view.container.querySelector('[aria-label="资产设定编辑器"]')).toBeNull();
        expect(view.container.querySelector('[aria-label="资产名称"]')).toBeNull();
        const sceneCategory = button(view.container, "场景");
        expect(sceneCategory.disabled).toBe(false);
        await click(sceneCategory);
        expect(sceneCategory.getAttribute("aria-pressed")).toBe("true");
        expect(button(view.container, "新增场景").disabled).toBe(true);
        expect(extractCalls).toHaveLength(0);
        expect(createCalls).toHaveLength(0);
        expect(settingsCalls).toHaveLength(0);
        expect(view.generated).toEqual([]);
    } finally {
        await view.dispose();
    }
});

test("新增重名资产的 409 保留后端原文与名称草稿，不误报版本过期", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4));
    const conflictMessage = "同类型资产中已存在这个名称，请修改后重试";
    try {
        await click(view.container.querySelector<HTMLButtonElement>('[aria-label="新增角色"]')!);
        await edit(field(view.container, "资产名称"), "林夏");
        await click(button(view.container, "保存资产"));
        expect(createCalls).toHaveLength(1);
        await act(async () => {
            pendingCreates[0]!.reject(new ApiError(conflictMessage, { status: 409, reason: "conflict" }));
            await settle();
        });
        expect(notices.at(-1)).toEqual({ kind: "error", text: conflictMessage });
        expect(notices.some((notice) => notice.text.includes("作品已有更新"))).toBe(false);
        expect(field(view.container, "资产名称").value).toBe("林夏");
        expect(button(view.container, "保存资产").disabled).toBe(false);
        expect(view.dirtyStates.at(-1)).toEqual([true, false]);
        expect(view.container.querySelector('[aria-label="资产设定编辑器"]')).toBeNull();
        expect(view.changed).toEqual([]);
        expect(view.generated).toEqual([]);
        expect(extractCalls).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("参考图方案草稿遇到新版本时阻止保存并保留字段", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4));
    try {
        await click(view.container.querySelector(".drama-workflow-assets-scheme > summary")!);
        await click(button(view.container, "切换参考图方案"));
        await edit(field(view.container, "角色参考图提示词"), "用户改过的角色提示词");
        await view.update({ summary: summaryOf("project-a", 9, { ...assets(), characterPrompt: "服务器新提示词" }) });
        expect(view.container.textContent).toContain("参考图方案已有更新");
        expect(view.container.textContent).toContain("当前修改已保留");
        expect(view.container.querySelector('[aria-label="参考图方案"]')).toBeNull();
        expect(settingsCalls).toHaveLength(0);
        expect(view.container.textContent).toContain("本地修改未保存");
        await view.update({ summary: summaryOf("project-a", 4) });
        expect(field(view.container, "角色参考图提示词").value).toBe("用户改过的角色提示词");
        await view.update({ summary: summaryOf("project-a", 9, { ...assets(), characterPrompt: "服务器新提示词" }) });
        await click(button(view.container, "重新载入"));
        expect(field(view.container, "角色参考图提示词").value).toBe("服务器新提示词");
        expect(settingsCalls).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("切换作品、账号或卸载后，迟到的新增和方案保存不能刷新当前页或打开旧编辑器", async () => {
    for (const action of ["create", "scheme"] as const) {
        for (const boundary of ["project", "account", "unmount"] as const) {
            resetFixture();
            const view = await mount(summaryOf("project-a", 4));
            let disposed = false;
            try {
                if (action === "create") {
                    await click(view.container.querySelector<HTMLButtonElement>('[aria-label="新增角色"]')!);
                    await edit(field(view.container, "资产名称"), "旧账号资产");
                    await click(button(view.container, "保存资产"));
                }
                if (action === "scheme") {
                    await click(view.container.querySelector(".drama-workflow-assets-scheme > summary")!);
                    await click(button(view.container, "切换参考图方案"));
                    await click(button(view.container, "保存后续参考图方案"));
                }
                expect(action === "create" ? pendingCreates.length : pendingSettings.length).toBe(1);
                if (boundary === "project") await view.update({ summary: summaryOf("project-b", 1), cast: [castOf("project-b", "other-hero", "character", "其他作品角色")] });
                if (boundary === "account")
                    await act(async () => {
                        userStore.getState().setUser({ id: "user-b", username: "b", displayName: "账号B", role: "user", status: "active" });
                        await settle();
                    });
                if (boundary === "unmount") {
                    await view.dispose();
                    disposed = true;
                }
                const changedBefore = view.changed.length;
                const noticesBefore = notices.length;
                await act(async () => {
                    if (action === "create") pendingCreates[0].resolve({ cast: castOf("project-a", "late-created", "character", "迟到的旧资产") });
                    if (action === "scheme") pendingSettings[0].resolve(summaryOf("project-a", 5));
                    await settle();
                });
                expect(view.changed.length).toBe(changedBefore);
                expect(notices.slice(noticesBefore)).toEqual([]);
                expect(view.container.querySelector('[aria-label="资产设定编辑器"]')).toBeNull();
                expect(view.container.textContent).not.toContain("迟到的旧资产");
                if (boundary === "project") expect(view.container.textContent).toContain("其他作品角色");
            } finally {
                if (!disposed) await view.dispose();
            }
        }
    }
}, 20_000);

test("忙碌时不能新增、批选或保存方案，加载状态可见", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4), [], { loading: true, busy: true });
    try {
        expect(view.container.textContent).toContain("正在读取本作品资产");
        expect(view.container.textContent).not.toContain("尚未生成资产文字");
        expect(view.container.querySelector<HTMLButtonElement>('[aria-label="新增角色"]')?.disabled).toBe(true);
        expect(view.container.querySelector<HTMLInputElement>('[aria-label="选择本集全部角色"]')?.disabled).toBe(true);
        expect(button(view.container, "生成角色图片").disabled).toBe(true);
        await click(view.container.querySelector(".drama-workflow-assets-scheme > summary")!);
        expect(view.container.querySelector('[aria-label="参考图方案"]')).toBeNull();
        expect(view.container.querySelector('[aria-label="参考图方案只读预览"]')).not.toBeNull();
        expect(extractCalls).toHaveLength(0);
        expect(createCalls).toHaveLength(0);
        expect(settingsCalls).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("方案明确保存并保留其它配置，失败保留草稿且不会触发生图", async () => {
    resetFixture();
    const initial = summaryOf("project-a", 4);
    const view = await mount(initial);
    try {
        await click(view.container.querySelector(".drama-workflow-assets-scheme > summary")!);
        await click(button(view.container, "切换参考图方案"));
        expect(settingsCalls).toHaveLength(0);
        expect(view.dirtyStates.at(-1)).toEqual([true, false]);
        await click(button(view.container, "保存后续参考图方案"));
        expect(settingsCalls).toEqual([
            {
                projectId: "project-a",
                input: {
                    expectedRevision: 4,
                    styleName: initial.production.settings.styleName,
                    stylePrompt: initial.production.settings.stylePrompt,
                    drawing: {
                        assets: { ...assets(), mode: "closeup_front_no_face", characterPrompt: "改后的角色提示词" },
                        models: { image: { modelKey: "image" }, characterImage: {}, sceneImage: {} },
                    },
                },
            },
        ]);
        expect(settingsCalls[0].input).not.toHaveProperty("settings");
        expect(view.generated).toEqual([]);
        expect(extractCalls).toHaveLength(0);
        await act(async () => {
            pendingSettings[0].reject(new Error("保存暂时失败"));
            await settle();
        });
        expect(field(view.container, "角色参考图提示词").value).toBe("改后的角色提示词");
        expect(view.dirtyStates.at(-1)).toEqual([true, false]);
        expect(view.changed).toEqual([]);
        await click(button(view.container, "保存后续参考图方案"));
        const saved = summaryOf("project-a", 5, settingsCalls[1].input.drawing!.assets);
        await act(async () => {
            pendingSettings[1].resolve(saved);
            await settle();
        });
        await view.update({ summary: saved });
        expect(view.changed).toEqual(["project-a"]);
        expect(view.dirtyStates.at(-1)).toEqual([false, false]);
        expect(field(view.container, "角色参考图提示词").value).toBe("改后的角色提示词");
    } finally {
        await view.dispose();
    }
    expect(view.dirtyStates.at(-1)).toEqual([false, false]);
});

test("新增名称参与离开保护，取消还原；旧方案弹层回调不能修改忙碌或新版本页面", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4), []);
    try {
        expect(view.container.textContent).toContain("暂无角色资产");
        expect(view.container.textContent).not.toContain("生成后会停在这里");
        await click(view.container.querySelector<HTMLButtonElement>('[aria-label="新增角色"]')!);
        await edit(field(view.container, "资产名称"), "待补设定的角色");
        expect(view.dirtyStates.at(-1)).toEqual([true, false]);
        await click(button(view.container, "取消"));
        expect(view.dirtyStates.at(-1)).toEqual([false, false]);
        await click(view.container.querySelector(".drama-workflow-assets-scheme > summary")!);
        const delayedChange = schemeCallbacks.at(-1)!;
        await view.update({ busy: true });
        await act(async () => {
            delayedChange({ ...assets(), characterPrompt: "不该应用的旧弹层" });
            await settle();
        });
        await view.update({ busy: false });
        expect(field(view.container, "角色参考图提示词").value).toBe("角色提示");
        await view.update({ summary: summaryOf("project-a", 5, { ...assets(), characterPrompt: "新版本角色提示" }) });
        await act(async () => {
            delayedChange({ ...assets(), characterPrompt: "更旧的弹层" });
            await settle();
        });
        expect(field(view.container, "角色参考图提示词").value).toBe("新版本角色提示");
        expect(view.dirtyStates.at(-1)).toEqual([false, false]);
        expect(settingsCalls).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});
