import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaAssetSettings, DramaCast, DramaCastKind, DramaSettings, DramaSourceFormat, DramaSummary } from "@/services/api/drama";
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
type ExtractCall = { projectId: string; input: { expectedRevision: number; kind: DramaCastKind; episodeIds?: string[]; chapterIds?: string[] } };
type CreateCall = { projectId: string; input: { kind: DramaCastKind; name: string; appearance?: string; description?: string; expectedRevision?: number } };
type SettingsCall = { projectId: string; input: { expectedRevision?: number; settings?: DramaSettings } };

const notices: Array<{ kind: string; text: string }> = [];
const extractCalls: ExtractCall[] = [];
const createCalls: CreateCall[] = [];
const settingsCalls: SettingsCall[] = [];
const chapterReads: string[] = [];
const pendingExtracts: Deferred<{ job: { id: string; kind: "bible"; status: "queued"; label: string; costMicrocredits: number; attempt: number; createdAt: string; updatedAt: string }; revision: number }>[] = [];
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
}));
mock.module("react-router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
    Link: ({ children }: { children?: ReactNode }) => children,
}));
mock.module("@/stores/use-user-store", () => ({ useUserStore: userStore }));
mock.module("@/pages/projects/drama-shared", () => ({ CAST_KIND_LABEL: { character: "角色", scene: "场景", prop: "道具" } }));
mock.module("@/pages/projects/workflow-asset-scope", () => ({ WorkflowAssetScope: ({ cast, kind, children }: any) => children(cast.filter((item: any) => item.kind === kind)) }));
mock.module("@/pages/projects/studio/use-studio", () => ({ dramaKeys: { summary: (id: string) => ["drama", id], cast: (id: string) => ["drama", id, "cast"], chapters: (id: string) => ["drama", id, "chapters"] } }));
mock.module("@/pages/projects/guide-panels", () => ({
    GuideAssets: ({ cast, busy, loading, onEdit, onGenerate }: { cast: DramaCast[]; busy: boolean; loading: boolean; onEdit: (cast: DramaCast) => void; onGenerate: (cast: DramaCast) => void }) =>
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
                        createElement("h3", null, item.name),
                        createElement("button", { type: "button", onClick: () => onEdit(item) }, `编辑${item.name}`),
                        createElement("button", { type: "button", disabled: busy, onClick: () => onGenerate(item) }, `生成${item.name}`),
                        cast.filter((look) => look.parentId === item.id).map((look) => createElement("p", { key: look.id }, `${item.name}造型 ${look.lookName}`)),
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
                    onClick: () => value && onChange({ ...value, mode: value.mode === "turnaround" ? "portrait" : "turnaround", characterPrompt: "改后的角色提示词" }),
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
    extractDramaCast: async (projectId: string, input: ExtractCall["input"]) => {
        extractCalls.push({ projectId, input: structuredClone(input) });
        const pending = deferred<{ job: { id: string; kind: "bible"; status: "queued"; label: string; costMicrocredits: number; attempt: number; createdAt: string; updatedAt: string }; revision: number }>();
        pendingExtracts.push(pending);
        return pending.promise;
    },
    createDramaCast: async (projectId: string, input: CreateCall["input"]) => {
        createCalls.push({ projectId, input: structuredClone(input) });
        const pending = deferred<{ cast: DramaCast }>();
        pendingCreates.push(pending);
        return pending.promise;
    },
    updateDramaSettings: async (projectId: string, input: SettingsCall["input"]) => {
        settingsCalls.push({ projectId, input: structuredClone(input) });
        const pending = deferred<DramaSummary>();
        pendingSettings.push(pending);
        return pending.promise;
    },
}));

const { WorkflowAssets } = await import("@/pages/projects/workflow-assets");

afterAll(() => {
    browser.happyDOM.abort();
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function assets(): DramaAssetSettings {
    return { mode: "portrait", characterPrompt: "角色提示", scenePrompt: "场景提示", characterRatio: "9:16" };
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
    chapterReads.length = 0;
    pendingExtracts.length = 0;
    pendingCreates.length = 0;
    pendingSettings.length = 0;
    schemeCallbacks.length = 0;
    userStore.setState({ user: { id: "user-a", username: "a", displayName: "账号A", role: "user", status: "active" } });
}

async function settle() {
    for (let index = 0; index < 8; index += 1) await Bun.sleep(10);
}

async function mount(initial: DramaSummary, cast = projectCast(), options: { loading?: boolean; busy?: boolean } = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const changed: string[] = [];
    const generated: string[] = [];
    const dirtyStates: Array<[boolean, boolean]> = [];
    let current = { summary: initial, cast, loading: options.loading ?? false, busy: options.busy ?? false };
    const render = () =>
        createElement(
            QueryClientProvider,
            { client },
            createElement(WorkflowAssets, {
                ...current,
                onChanged: () => changed.push(current.summary.project.id),
                onGenerate: (item) => generated.push(`${current.summary.project.id}:${item.id}`),
                onDirtyChange: (dirty, busy) => dirtyStates.push([dirty, busy]),
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

test("按类型统计并保留角色造型，不展示其他作品资产", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4));
    try {
        expect(button(view.container, "角色").textContent).toContain("1");
        expect(button(view.container, "场景").textContent).toContain("1");
        expect(button(view.container, "道具").textContent).toContain("1");
        expect(view.container.querySelector('[aria-label="character:林夏"]')?.textContent).toContain("林夏造型 雨夜");
        expect(view.container.textContent).not.toContain("其他作品角色");
        await click(button(view.container, "场景"));
        expect(view.container.querySelector('[aria-label="scene:旧宅"]')).not.toBeNull();
        expect(view.container.querySelector('[aria-label="character:林夏"]')).toBeNull();
        expect(view.container.textContent).not.toContain("林夏造型 雨夜");
        await click(button(view.container, "生成旧宅"));
        expect(view.generated).toEqual(["project-a:room"]);
        expect(extractCalls).toHaveLength(0);
        expect(createCalls).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("增量提取使用点击时的类型、范围和版本，空选不调用接口", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4));
    try {
        await click(button(view.container, "道具"));
        const episode = field(view.container, "提取范围").parentElement ? view.container.querySelector<HTMLInputElement>('input[value="episodes"]')! : null;
        expect(episode).not.toBeNull();
        await click(episode!);
        await click(button(view.container, "提取道具文字"));
        expect(extractCalls).toHaveLength(0);
        expect(notices.at(-1)?.text).toContain("请至少选择一集");
        await click(field(view.container, "提取 第一集"));
        await click(field(view.container, "提取 第二集"));
        await act(async () => {
            button(view.container, "提取道具文字").click();
            button(view.container, "提取道具文字").click();
            await settle();
        });
        expect(extractCalls).toEqual([{ projectId: "project-a", input: { expectedRevision: 4, kind: "prop", episodeIds: ["episode-1", "episode-2"] } }]);
        expect(view.container.textContent).toContain("仅新增正文中遗漏的资产，保留已有设定和图片");
        expect(createCalls).toHaveLength(0);
        expect(settingsCalls).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("当前制作章节不传范围，失败后保留已选范围", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 7));
    try {
        await click(button(view.container, "场景"));
        expect(view.container.textContent).toContain("使用已加入制作的 1 章");
        await click(button(view.container, "提取场景文字"));
        expect(extractCalls).toEqual([{ projectId: "project-a", input: { expectedRevision: 7, kind: "scene" } }]);
        expect(extractCalls[0]?.input).not.toHaveProperty("episodeIds");
        expect(extractCalls[0]?.input).not.toHaveProperty("chapterIds");
        await act(async () => {
            pendingExtracts[0]!.reject(new Error("提取服务暂时不可用"));
            await settle();
        });
        expect(notices.at(-1)).toEqual({ kind: "error", text: "提取服务暂时不可用" });
        expect(view.container.querySelector<HTMLInputElement>('input[value="current"]')?.checked).toBe(true);
        expect(view.changed).toEqual([]);
    } finally {
        await view.dispose();
    }
});

test("快速新增只提交用户字段，成功后打开真实编辑器边界", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4));
    try {
        await click(button(view.container, "快速新增"));
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

test("新增失败保留已填名称", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4));
    try {
        await click(button(view.container, "快速新增"));
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

test("参考图方案草稿遇到新版本时阻止保存并保留字段", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4));
    try {
        await click(view.container.querySelector("summary")!);
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

test("切换作品、账号或卸载后，迟到的提取、新增和方案保存不能刷新当前页或打开旧编辑器", async () => {
    for (const action of ["extract", "create", "scheme"] as const) {
        for (const boundary of ["project", "account", "unmount"] as const) {
            resetFixture();
            const view = await mount(summaryOf("project-a", 4));
            let disposed = false;
            try {
                if (action === "extract") await click(button(view.container, "提取角色文字"));
                if (action === "create") {
                    await click(button(view.container, "快速新增"));
                    await edit(field(view.container, "资产名称"), "旧账号资产");
                    await click(button(view.container, "保存资产"));
                }
                if (action === "scheme") {
                    await click(view.container.querySelector("summary")!);
                    await click(button(view.container, "切换参考图方案"));
                    await click(button(view.container, "保存后续参考图方案"));
                }
                expect(action === "extract" ? pendingExtracts.length : action === "create" ? pendingCreates.length : pendingSettings.length).toBe(1);
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
                    if (action === "extract") pendingExtracts[0].resolve({ job: { id: "job-old", kind: "bible", status: "queued", label: "旧提取", costMicrocredits: 0, attempt: 1, createdAt: "", updatedAt: "" }, revision: 5 });
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

test("忙碌时不能开始提取、新增或保存方案，加载和空态可见", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4), [], { loading: true, busy: true });
    try {
        expect(view.container.textContent).toContain("正在读取本作品资产");
        expect(view.container.textContent).not.toContain("尚未生成资产文字");
        expect(button(view.container, "提取角色文字").disabled).toBe(true);
        expect(button(view.container, "快速新增").disabled).toBe(true);
        await click(view.container.querySelector("summary")!);
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
        await click(view.container.querySelector("summary")!);
        await click(button(view.container, "切换参考图方案"));
        expect(settingsCalls).toHaveLength(0);
        expect(view.dirtyStates.at(-1)).toEqual([true, false]);
        await click(button(view.container, "保存后续参考图方案"));
        expect(settingsCalls).toEqual([{ projectId: "project-a", input: { expectedRevision: 4, settings: { ...initial.production.settings, assets: { ...assets(), mode: "turnaround", characterPrompt: "改后的角色提示词" } } } }]);
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
        const saved = summaryOf("project-a", 5, settingsCalls[1].input.settings!.assets);
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
        expect(view.container.textContent).toContain("尚未生成资产文字");
        expect(view.container.textContent).not.toContain("生成后会停在这里");
        await click(button(view.container, "快速新增"));
        await edit(field(view.container, "资产名称"), "待补设定的角色");
        expect(view.dirtyStates.at(-1)).toEqual([true, false]);
        await click(button(view.container, "取消"));
        expect(view.dirtyStates.at(-1)).toEqual([false, false]);
        await click(view.container.querySelector("summary")!);
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
