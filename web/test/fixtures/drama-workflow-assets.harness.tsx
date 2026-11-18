import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, useState, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaAssetSettings, DramaCast, DramaCastKind, DramaEpisodeDetail, DramaJob, DramaSettings, DramaSourceFormat, DramaStudioBatchRequest, DramaStudioBatchView, DramaSummary, DramaWorkflowImpact } from "@/services/api/drama";
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
type CreateCall = { projectId: string; input: { kind: DramaCastKind; name: string; appearance?: string; description?: string; expectedRevision?: number; episodeId?: string } };
type DeleteCall = { projectId: string; castId: string; expectedRevision: number; deleteScopeToken: string };
type BatchCall = { projectId: string; input: DramaStudioBatchRequest };
type ExtractCall = { projectId: string; input: { expectedRevision: number; kind: DramaCastKind; allChapters?: boolean; episodeIds?: string[] } };

const notices: Array<{ kind: string; text: string }> = [];
const extractCalls: ExtractCall[] = [];
const pendingExtractions: Deferred<{ job: DramaJob; revision: number }>[] = [];
const projectJobs = new Map<string, DramaJob[]>();
const episodeReads: string[] = [];
const episodeDetails = new Map<string, DramaEpisodeDetail>();
let deferEpisodeReads = false;
const pendingEpisodeReads: Deferred<DramaEpisodeDetail>[] = [];
const createCalls: CreateCall[] = [];
const deleteCalls: DeleteCall[] = [];
let deleteImpactOverride: Partial<DramaWorkflowImpact> = {};
let deleteImpactError = false;
const savedToLibrary: DramaCast[] = [];
const pendingDeletes: Deferred<{ deleted: boolean; castId: string }>[] = [];
const configurationReads: string[] = [];
const configurationSummaries = new Map<string, DramaSummary>();
const configurationOverrides = new Map<string, DramaSettings>();
let configurationError = false;
const batchChecks: BatchCall[] = [];
const batchExecutions: BatchCall[] = [];
let deferBatchChecks = false;
let deferBatchExecutions = false;
const pendingBatchChecks: Deferred<DramaStudioBatchView>[] = [];
const pendingBatchExecutions: Deferred<DramaStudioBatchView>[] = [];
const chapterReads: string[] = [];
const pendingCreates: Deferred<{ cast: DramaCast }>[] = [];

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

mock.module("@/pages/projects/studio/drama-media-action-context", () => ({
    DramaMediaActionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    DramaMediaEpisodeScope: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useDramaMediaContext: () => null,
    QuotedMediaButton: ({ label, onClick, disabled, title, "aria-label": ariaLabel }: { label: string; onClick?: () => void; disabled?: boolean; title?: string; "aria-label"?: string }) => (
        <button disabled={disabled} onClick={onClick} title={title} aria-label={ariaLabel}>
            {label}
        </button>
    ),
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
    Popover: ({ children, content, open }: { children: ReactNode; content?: ReactNode; open?: boolean }) => (
        <>
            {children}
            {open ? content : null}
        </>
    ),
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
    AppModal: ({
        open,
        title,
        children,
        footer,
        onOk,
        onCancel,
        okText,
        cancelText,
        confirmLoading,
        okButtonProps,
        cancelButtonProps,
    }: {
        open: boolean;
        title: string;
        children?: ReactNode;
        footer?: ReactNode;
        onOk?: () => void;
        onCancel?: () => void;
        okText?: string;
        cancelText?: string;
        confirmLoading?: boolean;
        okButtonProps?: { disabled?: boolean };
        cancelButtonProps?: { disabled?: boolean };
    }) =>
        open
            ? createElement(
                  "section",
                  { role: "dialog", "aria-label": title },
                  children,
                  footer === undefined && onOk
                      ? createElement(
                            "footer",
                            null,
                            createElement("button", { type: "button", disabled: cancelButtonProps?.disabled, onClick: onCancel }, cancelText || "取消"),
                            createElement("button", { type: "button", disabled: okButtonProps?.disabled || confirmLoading, onClick: onOk }, okText || "确定"),
                        )
                      : footer,
              )
            : null,
}));
mock.module("@/pages/projects/workflow-impact", () => ({ WorkflowImpact: () => null }));
mock.module("@/components/ui/base/tooltip/tooltip", () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));
mock.module("@/pages/projects/workflow-character-library", () => ({
    WorkflowCharacterLibrary: ({
        summary,
        cast,
        busy,
        children,
        onDirtyChange,
    }: {
        summary: DramaSummary;
        cast: DramaCast[];
        busy?: boolean;
        children?: (controls: { importTrigger: ReactNode; saveToLibrary: (item: DramaCast) => void }) => ReactNode;
        onDirtyChange?: (dirty: boolean, busy: boolean) => void;
    }) => {
        const [open, setOpen] = useState(false);
        const [saved, setSaved] = useState<DramaCast>();
        const importTrigger = createElement("button", { type: "button", "aria-label": "从角色库导入", disabled: busy, onClick: () => setOpen(true) });
        return (
            <>
                <span data-asset-library-controller data-project={summary.project.id} data-cast={cast.map((item) => item.id).join(",")} />
                {children
                    ? children({
                          importTrigger,
                          saveToLibrary: (item) => {
                              savedToLibrary.push(item);
                              setSaved(item);
                          },
                      })
                    : importTrigger}
                {saved ? (
                    <section role="dialog" aria-label="角色另存库" data-cast={saved.id}>
                        <button onClick={() => setSaved(undefined)}>关闭角色另存库</button>
                    </section>
                ) : null}
                {open ? (
                    <section role="dialog" aria-label="角色库导入">
                        <button onClick={() => onDirtyChange?.(true, false)}>修改角色导入</button>
                        <button onClick={() => onDirtyChange?.(false, true)}>开始角色导入</button>
                        <button
                            onClick={() => {
                                onDirtyChange?.(false, false);
                                setOpen(false);
                            }}
                        >
                            关闭角色库
                        </button>
                    </section>
                ) : null}
            </>
        );
    },
}));
mock.module("@/pages/projects/studio/cast-project-import", () => ({
    CastProjectImport: ({ projectId, kind, currentCast, onClose, onStateChange }: { projectId: string; kind: "scene" | "prop"; currentCast: DramaCast[]; onClose: () => void; onStateChange: (dirty: boolean, busy: boolean) => void }) => {
        const label = kind === "scene" ? "场景" : "道具";
        return (
            <section role="dialog" aria-label={`${label}库导入`} data-project={projectId} data-kind={kind} data-cast={currentCast.map((item) => item.id).join(",")}>
                <button onClick={() => onStateChange(true, false)}>修改{label}导入</button>
                <button onClick={() => onStateChange(false, true)}>开始{label}导入</button>
                <button onClick={onClose}>关闭{label}库</button>
            </section>
        );
    },
}));
mock.module("@/pages/projects/studio/use-studio", () => ({
    dramaKeys: { summary: (id: string) => ["drama", id], cast: (id: string) => ["drama", id, "cast"], chapters: (id: string) => ["drama", id, "chapters"], jobs: (id: string) => ["drama", id, "jobs"] },
}));
mock.module("@/pages/projects/guide-panels", () => ({
    GuideAssets: ({
        cast,
        busy,
        loading,
        onEdit,
        onGenerate,
        onDelete,
        onSaveToLibrary,
        selectedIds,
        onSelect,
    }: {
        cast: DramaCast[];
        busy: boolean;
        loading: boolean;
        onEdit: (cast: DramaCast) => void;
        onGenerate: (cast: DramaCast) => void;
        onDelete?: (cast: DramaCast) => void;
        onSaveToLibrary?: (cast: DramaCast) => void;
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
                        createElement("h3", null, createElement("button", { type: "button", "aria-label": `编辑${item.name}`, disabled: busy, onClick: () => onEdit(item) }, item.name)),
                        createElement("button", { type: "button", disabled: busy, onClick: () => onGenerate(item) }, `生成${item.name}`),
                        onDelete ? createElement("button", { type: "button", disabled: busy, onClick: () => onDelete(item) }, `删除${item.name}`) : null,
                        item.kind === "character" && onSaveToLibrary ? createElement("button", { type: "button", disabled: busy, onClick: () => onSaveToLibrary(item) }, `将${item.name}加入角色库`) : null,
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
    CastEditorDialog: ({
        summary,
        episodeId,
        cast,
        castId,
        onClose,
        onChanged,
        onDirtyChange,
    }: {
        summary: DramaSummary;
        episodeId?: string;
        cast: DramaCast[];
        castId?: string;
        onClose: () => void;
        onChanged: () => void;
        onDirtyChange?: (dirty: boolean, busy: boolean) => void;
    }) => {
        if (!castId) return null;
        const current = cast.find((item) => item.id === castId && item.projectId === summary.project.id);
        return createElement(
            "section",
            { "aria-label": "资产设定编辑器", "data-project": summary.project.id, "data-episode": episodeId, "data-cast": current?.id, "data-kind": current?.kind, "data-character-prompt": summary.production.settings.assets.characterPrompt },
            current ? createElement("h2", null, `${current.name} · 资产设定`) : createElement("p", null, "此资产已不存在"),
            createElement("button", { type: "button", onClick: () => onDirtyChange?.(true, false) }, "修改资产设定"),
            createElement("button", { type: "button", onClick: () => onDirtyChange?.(false, true) }, "开始保存资产设定"),
            createElement(
                "button",
                {
                    type: "button",
                    onClick: () => {
                        onDirtyChange?.(false, false);
                        onChanged();
                    },
                },
                "完成保存资产设定",
            ),
            createElement(
                "button",
                {
                    type: "button",
                    onClick: () => {
                        onDirtyChange?.(false, false);
                        onClose();
                    },
                },
                "关闭资产设定",
            ),
        );
    },
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
    listDramaJobs: async (projectId: string) => ({ jobs: structuredClone(projectJobs.get(projectId) || []) }),
    extractDramaCast: async (projectId: string, input: ExtractCall["input"]) => {
        extractCalls.push({ projectId, input: structuredClone(input) });
        const pending = deferred<{ job: DramaJob; revision: number }>();
        pendingExtractions.push(pending);
        return pending.promise;
    },
    createDramaCast: async (projectId: string, input: CreateCall["input"]) => {
        createCalls.push({ projectId, input: structuredClone(input) });
        const pending = deferred<{ cast: DramaCast }>();
        pendingCreates.push(pending);
        const result = await pending.promise;
        if (input.episodeId) {
            const detail = episodeDetails.get(input.episodeId) || episodeWithExtractedAssets(input.episodeId, []);
            const assetIds = JSON.parse(detail.episode.assetIdsJson || "[]") as string[];
            episodeDetails.set(input.episodeId, { ...detail, episode: { ...detail.episode, assetIdsJson: JSON.stringify([...new Set([...assetIds, result.cast.id])]) } });
        }
        return result;
    },
    getDramaCastImpact: async (projectId: string, castId: string): Promise<DramaWorkflowImpact> => {
        if (deleteImpactError) throw new Error("读取暂时失败");
        return {
            kind: "cast",
            revision: configurationSummaries.get(projectId)!.production.revision,
            castId,
            deleteScopeToken: "reviewed-token",
            segments: 0,
            episodes: 0,
            affectedSegments: 0,
            assetIds: [castId],
            directSegments: [],
            continuitySegments: [],
            message: "",
            ...deleteImpactOverride,
        };
    },
    deleteDramaCast: async (projectId: string, castId: string, expectedRevision: number, deleteScopeToken: string) => {
        deleteCalls.push({ projectId, castId, expectedRevision, deleteScopeToken });
        const pending = deferred<{ deleted: boolean; castId: string }>();
        pendingDeletes.push(pending);
        return pending.promise;
    },
    getDramaEpisodeStyle: async (projectId: string, episodeId: string) => {
        configurationReads.push(`${projectId}:${episodeId}`);
        if (configurationError) throw new Error("读取暂时失败");
        const summary = configurationSummaries.get(projectId)!;
        return { projectId, episodeId, revision: summary.production.revision, episodeRevision: 2, settings: configurationOverrides.get(episodeId) || summary.production.settings };
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

function episodeWithAssets(episodeId: string, references = { characters: ["hero"], looks: ["hero-look"], props: ["key"], scene: "room" }): DramaEpisodeDetail {
    return {
        episode: { id: episodeId, assetIdsJson: "[]" },
        shots: [{ castIdsJson: JSON.stringify(references.characters), lookCastIdsJson: JSON.stringify(references.looks), propIdsJson: JSON.stringify(references.props), sceneCastId: references.scene }],
        segments: [],
    } as unknown as DramaEpisodeDetail;
}

function episodeWithExtractedAssets(episodeId: string, assetIds: string[]): DramaEpisodeDetail {
    return { episode: { id: episodeId, assetIdsJson: JSON.stringify(assetIds) }, shots: [], segments: [] } as unknown as DramaEpisodeDetail;
}

function resetFixture() {
    notices.length = 0;
    extractCalls.length = 0;
    pendingExtractions.length = 0;
    projectJobs.clear();
    createCalls.length = 0;
    deleteCalls.length = 0;
    deleteImpactOverride = {};
    deleteImpactError = false;
    pendingDeletes.length = 0;
    savedToLibrary.length = 0;
    configurationReads.length = 0;
    configurationSummaries.clear();
    configurationOverrides.clear();
    configurationError = false;
    batchChecks.length = 0;
    batchExecutions.length = 0;
    deferBatchChecks = false;
    deferBatchExecutions = false;
    pendingBatchChecks.length = 0;
    pendingBatchExecutions.length = 0;
    chapterReads.length = 0;
    episodeReads.length = 0;
    episodeDetails.clear();
    for (const episodeId of ["episode-1", "episode-2", "episode-3"]) episodeDetails.set(episodeId, episodeWithAssets(episodeId));
    episodeDetails.set("episode-other", episodeWithAssets("episode-other", { characters: ["other-hero"], looks: [], props: ["other-prop"], scene: "other-room" }));
    deferEpisodeReads = false;
    pendingEpisodeReads.length = 0;
    pendingCreates.length = 0;
    userStore.setState({ user: { id: "user-a", username: "a", displayName: "账号A", role: "user", status: "active" } });
}

async function settle() {
    for (let index = 0; index < 8; index += 1) await Bun.sleep(10);
}

async function mount(initial: DramaSummary, cast = projectCast(), options: { loading?: boolean; busy?: boolean; variant?: "library" | "episode"; episodeId?: string; controlled?: boolean; advanceRevisionOnChange?: boolean } = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const changed: string[] = [];
    const generated: string[] = [];
    const generatedEpisodes: Array<string | undefined> = [];
    const dirtyStates: Array<[boolean, boolean]> = [];
    const episodeChanges: string[] = [];
    let current = { summary: initial, cast, loading: options.loading ?? false, busy: options.busy ?? false, variant: options.variant ?? "episode", episodeId: options.episodeId };
    const render = () => {
        configurationSummaries.set(current.summary.project.id, current.summary);
        return createElement(
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
                onGenerate: (item, selectedEpisodeId) => {
                    generated.push(`${current.summary.project.id}:${item.id}`);
                    generatedEpisodes.push(selectedEpisodeId);
                },
                onDirtyChange: (dirty, busy) => dirtyStates.push([dirty, busy]),
                onEpisodeChange: options.controlled ? (id) => episodeChanges.push(id) : undefined,
            }),
        );
    };
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
        generatedEpisodes,
        dirtyStates,
        episodeChanges,
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
    const found = Array.from(container.querySelectorAll("button")).find((item) => item.getAttribute("aria-label") === label || item.textContent?.includes(label));
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

async function waitForQuote() {
    await act(async () => {
        await Bun.sleep(220);
        await settle();
    });
}

async function click(node: HTMLElement) {
    if (node instanceof HTMLButtonElement && node.disabled && node.textContent?.includes("计价中")) await waitForQuote();
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
        expect(view.container.textContent).not.toContain("展示作品共享主体");
        expect(view.container.querySelector(".drama-workflow-assets-shared")).toBeNull();
        expect(view.container.querySelector('[aria-label="提取范围"]')).toBeNull();
        expect(view.container.querySelector('[aria-label="按集查看资产"]')).toBeNull();
        expect(view.container.querySelector('[aria-label^="快速新增"]')).toBeNull();
        expect(view.container.textContent).not.toContain("补充提取资产");
        expect(view.container.textContent).not.toContain("批量选择");
    } finally {
        await view.dispose();
    }
});

test("本集提取资产无需分镜即可展示且重载保留，正文关联与段引用均生效且不混入其他集", async () => {
    resetFixture();
    episodeDetails.set("episode-1", { episode: { id: "episode-1" }, shots: [], segments: [] } as unknown as DramaEpisodeDetail);
    const unrelated = [castOf("project-a", "unused-hero", "character", "未关联角色"), castOf("project-a", "unused-room", "scene", "未关联场景"), castOf("project-a", "unused-key", "prop", "未关联道具")];
    let view = await mount(summaryOf("project-a", 4), [...projectCast(), ...unrelated]);
    try {
        for (const label of ["角色", "场景", "道具"]) {
            const column = view.container.querySelector(`[aria-label="${label}资产"]`)!;
            expect(column.textContent).toContain(`本集暂无关联${label}`);
            expect(column.textContent).toContain(`可提取本集全部${label}，或新增资产`);
            expect(column.textContent).not.toContain("编排分镜后会显示本集关联资产");
            expect(column.querySelector('[aria-label="资产卡片"]')).toBeNull();
        }
        expect(view.container.textContent).not.toContain("展示作品共享主体");
        expect(view.container.querySelector(".drama-workflow-assets-shared")).toBeNull();
        episodeDetails.set("episode-1", episodeWithExtractedAssets("episode-1", ["hero-look", "room", "key"]));
        await view.update({ summary: summaryOf("project-a", 5) });
        for (const selector of ['[aria-label="character:林夏"]', '[aria-label="scene:旧宅"]', '[aria-label="prop:铜钥匙"]']) expect(view.container.querySelector(selector)).not.toBeNull();
        expect(view.container.querySelector('[aria-label="选择林夏 · 雨夜"]')).not.toBeNull();
        await view.dispose();
        view = await mount(summaryOf("project-a", 5), [...projectCast(), ...unrelated]);
        for (const selector of ['[aria-label="character:林夏"]', '[aria-label="scene:旧宅"]', '[aria-label="prop:铜钥匙"]']) expect(view.container.querySelector(selector)).not.toBeNull();
        episodeDetails.set("episode-2", { ...episodeWithExtractedAssets("episode-2", []), sourceAssetIds: unrelated.map((item) => item.id) });
        await click(button(view.container, "下一集主体资产"));
        for (const item of unrelated) expect(view.container.querySelector(`[aria-label="${item.kind}:${item.name}"]`)).not.toBeNull();
        for (const selector of ['[aria-label="character:林夏"]', '[aria-label="scene:旧宅"]', '[aria-label="prop:铜钥匙"]']) expect(view.container.querySelector(selector)).toBeNull();
        await view.update({ episodeId: "", summary: { ...summaryOf("project-a", 5), episodes: [] } });
        expect(view.container.querySelector('[aria-label="资产卡片"]')).toBeNull();
        for (const item of [...projectCast(), ...unrelated]) expect(view.container.querySelector(`[aria-label="${item.kind}:${item.name}"]`)).toBeNull();
        episodeDetails.set("episode-1", { episode: { id: "episode-1", assetIdsJson: '["room"]' }, shots: [], segments: [{ request: { references: [{ castId: "key" }], audioReferences: [{ castId: "hero-look" }] } }] } as unknown as DramaEpisodeDetail);
        await view.update({ episodeId: "episode-1", summary: summaryOf("project-a", 6) });
        for (const selector of ['[aria-label="character:林夏"]', '[aria-label="scene:旧宅"]', '[aria-label="prop:铜钥匙"]']) expect(view.container.querySelector(selector)).not.toBeNull();
        expect(view.container.querySelector('[aria-label="选择林夏 · 雨夜"]')).not.toBeNull();
        for (const item of unrelated) expect(view.container.querySelector(`[aria-label="${item.kind}:${item.name}"]`)).toBeNull();
        await view.update({ variant: "library" });
        for (const [label, kind] of [
            ["角色", "character"],
            ["场景", "scene"],
            ["道具", "prop"],
        ] as const) {
            if (kind !== "character") await click(button(view.container.querySelector<HTMLElement>('[aria-label="主体资产分类"]')!, label));
            expect(view.container.querySelector(`[aria-label="${kind}:${unrelated.find((item) => item.kind === kind)!.name}"]`)).not.toBeNull();
        }
        expect(view.container.textContent).not.toContain("其他作品角色");
    } finally {
        await view.dispose();
    }
});

test("单集与资产库保留唯一库控制器，卡片直接编辑且无独立信息或顶部人物工具", async () => {
    for (const variant of ["episode", "library"] as const) {
        resetFixture();
        const view = await mount(summaryOf("project-a", 4), projectCast(), { variant });
        try {
            const controllers = view.container.querySelectorAll("[data-asset-library-controller]");
            expect(controllers).toHaveLength(1);
            expect(controllers[0].getAttribute("data-project")).toBe("project-a");
            expect(controllers[0].getAttribute("data-cast")).toBe("hero,hero-look,room,key");
            expect(view.container.querySelector('[aria-label="人物信息与角色库"]')).toBeNull();
            expect(view.container.querySelector('button[aria-label="人物信息与出镜"]')).toBeNull();
            expect(view.container.textContent).not.toContain("选择人物");
            expect(view.container.textContent).not.toContain("人物信息与出镜");
            expect(button(view.container, "编辑林夏").disabled).toBe(false);
            expect(view.container.querySelector('button[aria-label^="查看"][aria-label$="的资产信息与出镜"]')).toBeNull();
            expect(view.container.querySelector(".drama-workflow-assets-scheme")).toBeNull();
            expect(view.container.textContent).not.toContain("后续参考图方案");
        } finally {
            await view.dispose();
        }
    }
});

test("单集三类卡片和资产库各分类都直接打开对应资产编辑，保留本集配置", async () => {
    for (const variant of ["episode", "library"] as const) {
        resetFixture();
        const cast = projectCast();
        const view = await mount(summaryOf("project-a", 4), cast, { variant });
        try {
            const controller = view.container.querySelector("[data-asset-library-controller]");
            for (const [label, item] of [
                ["角色", cast[0]],
                ["场景", cast[2]],
                ["道具", cast[3]],
            ] as const) {
                if (variant === "library") await click(button(view.container.querySelector<HTMLElement>('[aria-label="主体资产分类"]')!, label));
                await click(button(view.container, `编辑${item.name}`));
                const editor = view.container.querySelector<HTMLElement>('[aria-label="资产设定编辑器"]')!;
                expect(editor?.getAttribute("data-cast")).toBe(item.id);
                expect(editor?.getAttribute("data-kind")).toBe(item.kind);
                expect(editor?.getAttribute("data-project")).toBe("project-a");
                expect(editor?.getAttribute("data-episode")).toBe(variant === "episode" ? "episode-1" : null);
                expect(editor?.textContent).toContain(`${item.name} · 资产设定`);
                expect(view.container.querySelectorAll('[aria-label="资产设定编辑器"]')).toHaveLength(1);
                expect(view.container.querySelectorAll("[data-asset-library-controller]")).toHaveLength(1);
                expect(view.container.querySelector("[data-asset-library-controller]")).toBe(controller);
                expect(view.container.querySelector('[aria-label="资产信息与出镜"]')).toBeNull();
                await click(button(editor, "关闭资产设定"));
                expect(view.container.querySelector('[aria-label="资产设定编辑器"]')).toBeNull();
            }
            expect(savedToLibrary).toEqual([]);
            expect(deleteCalls).toEqual([]);
            expect(view.generated).toEqual([]);
        } finally {
            await view.dispose();
        }
    }
});

test("卡片直接打开的编辑器在修改和保存中冻结选集并阻止删除，关闭后恢复", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4), projectCast(), { controlled: true });
    try {
        await click(button(view.container, "编辑旧宅"));
        const editor = view.container.querySelector<HTMLElement>('[aria-label="资产设定编辑器"]')!;
        for (const [action, state] of [
            ["修改资产设定", [true, false]],
            ["开始保存资产设定", [false, true]],
        ] as const) {
            await click(button(editor, action));
            expect(view.dirtyStates.at(-1)).toEqual([...state]);
            const next = button(view.container, "下一集主体资产");
            expect(next.disabled).toBe(true);
            const select = view.container.querySelector<HTMLSelectElement>('[aria-label="主体管理剧集"]')!;
            expect(select.disabled).toBe(true);
            await click(next);
            await act(async () => {
                select.value = "episode-2";
                select.dispatchEvent(new Event("change", { bubbles: true }));
                await settle();
            });
            await click(button(view.container, "删除林夏"));
            expect(view.episodeChanges).toEqual([]);
            expect(deleteCalls).toEqual([]);
            expect(view.container.querySelector('[role="dialog"][aria-label="删除「林夏」？"]')).toBeNull();
            expect(view.container.querySelector('[aria-label="资产设定编辑器"]')).toBe(editor);
        }
        await click(button(editor, "完成保存资产设定"));
        expect(view.dirtyStates.at(-1)).toEqual([false, false]);
        expect(button(view.container, "下一集主体资产").disabled).toBe(true);
        await click(button(editor, "关闭资产设定"));
        expect(view.dirtyStates.at(-1)).toEqual([false, false]);
        expect(button(view.container, "下一集主体资产").disabled).toBe(false);
        await click(button(view.container, "下一集主体资产"));
        expect(view.episodeChanges).toEqual(["episode-2"]);
    } finally {
        await view.dispose();
    }
});

test("切换作品账号或外部指定剧集会卸载旧资产编辑器，忙碌页面不能打开新编辑器", async () => {
    for (const boundary of ["project", "account", "episode"] as const) {
        resetFixture();
        const view = await mount(summaryOf("project-a", 4));
        try {
            await click(button(view.container, "编辑铜钥匙"));
            const oldEditor = view.container.querySelector('[aria-label="资产设定编辑器"]');
            const oldController = view.container.querySelector("[data-asset-library-controller]");
            await click(button(view.container, "修改资产设定"));
            if (boundary === "project") await view.update({ summary: summaryOf("project-b", 1), cast: [castOf("project-b", "other-prop", "prop", "其他作品道具")] });
            if (boundary === "account")
                await act(async () => {
                    userStore.getState().setUser({ id: "user-b", username: "b", displayName: "账号B", role: "user", status: "active" });
                    await settle();
                });
            if (boundary === "episode") await view.update({ episodeId: "episode-2" });
            expect(view.container.querySelector('[aria-label="资产设定编辑器"]')).toBeNull();
            expect(oldEditor?.isConnected).toBe(false);
            expect(view.container.querySelector("[data-asset-library-controller]")).not.toBe(oldController);
            expect(view.dirtyStates.at(-1)).toEqual([false, false]);
            await view.update({ busy: true });
            const name = boundary === "project" ? "其他作品道具" : "铜钥匙";
            const editButton = button(view.container, `编辑${name}`);
            expect(editButton.disabled).toBe(true);
            await click(editButton);
            expect(view.container.querySelector('[aria-label="资产设定编辑器"]')).toBeNull();
            await view.update({ busy: false });
            await click(button(view.container, `编辑${name}`));
            const editor = view.container.querySelector('[aria-label="资产设定编辑器"]');
            expect(editor?.getAttribute("data-cast")).toBe(boundary === "project" ? "other-prop" : "key");
            expect(editor?.getAttribute("data-project")).toBe(boundary === "project" ? "project-b" : "project-a");
            expect(editor?.getAttribute("data-episode")).toBe(boundary === "project" ? "episode-other" : boundary === "episode" ? "episode-2" : "episode-1");
        } finally {
            await view.dispose();
        }
    }
});

test("三栏列头各自提供唯一库导入入口，并打开对应类型的库", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4));
    try {
        for (const [label, kind] of [
            ["角色", "character"],
            ["场景", "scene"],
            ["道具", "prop"],
        ] as const) {
            const column = view.container.querySelector<HTMLElement>(`[aria-label="${label}资产"]`)!;
            const entries = view.container.querySelectorAll<HTMLButtonElement>(`button[aria-label="从${label}库导入"]`);
            expect(entries).toHaveLength(1);
            expect(column.querySelector(".drama-workflow-assets-column-head")?.contains(entries[0])).toBe(true);
            expect(entries[0].textContent).toBe("");
            await click(entries[0]);
            const dialog = view.container.querySelector<HTMLElement>(`[role="dialog"][aria-label="${label}库导入"]`)!;
            expect(dialog).not.toBeNull();
            expect(view.container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
            if (kind !== "character") {
                expect(dialog.getAttribute("data-kind")).toBe(kind);
                expect(dialog.getAttribute("data-project")).toBe("project-a");
                expect(dialog.getAttribute("data-cast")).toContain(kind === "scene" ? "room" : "key");
                expect(dialog.getAttribute("data-cast")).not.toContain("other-hero");
            }
            await click(button(dialog, `关闭${label}库`));
            expect(view.container.querySelector('[role="dialog"]')).toBeNull();
        }
    } finally {
        await view.dispose();
    }
});

test("任一类型库的草稿和在途导入都冻结选集，关闭后恢复", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4), projectCast(), { controlled: true });
    try {
        for (const label of ["角色", "场景", "道具"]) {
            await click(button(view.container, `从${label}库导入`));
            for (const [action, expectedState] of [
                ["修改", [true, false]],
                ["开始", [false, true]],
            ] as const) {
                await click(button(view.container, `${action}${label}导入`));
                expect(view.dirtyStates.at(-1)).toEqual(expectedState);
                const next = view.container.querySelector<HTMLButtonElement>('[aria-label="下一集主体资产"]')!;
                const select = view.container.querySelector<HTMLSelectElement>('[aria-label="主体管理剧集"]')!;
                expect(next.disabled).toBe(true);
                expect(select.disabled).toBe(true);
                await click(next);
                await act(async () => {
                    select.value = "episode-2";
                    select.dispatchEvent(new Event("change", { bubbles: true }));
                    await settle();
                });
                expect(view.episodeChanges).toEqual([]);
            }
            await click(button(view.container, `关闭${label}库`));
            expect(view.dirtyStates.at(-1)).toEqual([false, false]);
            expect(view.container.querySelector<HTMLSelectElement>('[aria-label="主体管理剧集"]')?.disabled).toBe(false);
        }
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
            await click(button(view.container, "批量生成图片"));
            expect(batchChecks).toHaveLength(index + 1);
            expect(batchChecks[index]).toEqual({ projectId: "project-a", input: { action: "cast_image", targetIds: category.ids, baseRevision: 4 } });
            expect(view.container.querySelector('[role="dialog"]')).toBeNull();
            expect(batchExecutions).toHaveLength(index + 1);
            expect(batchExecutions[index]).toEqual({ projectId: "project-a", input: { action: "cast_image", targetIds: category.ids, baseRevision: 4, confirmationToken: "batch-confirmation" } });
            await click(button(view.container, "清空选择（"));
        }
        expect(view.changed).toEqual(["project-a", "project-a", "project-a"]);
    } finally {
        await view.dispose();
    }
});

test("单集三栏分别全选与提交真实类型范围，角色包含造型且不串入其他类型或作品", async () => {
    resetFixture();
    const extraCast = [castOf("project-a", "guest", "character", "第二集角色"), castOf("project-a", "yard", "scene", "第二集庭院"), castOf("project-a", "lantern", "prop", "第二集灯笼")];
    episodeDetails.set("episode-2", episodeWithAssets("episode-2", { characters: ["guest"], looks: [], props: ["lantern"], scene: "yard" }));
    const view = await mount(summaryOf("project-a", 4), [...projectCast(), ...extraCast]);
    try {
        const columns = [
            { label: "角色", ids: ["hero", "hero-look"] },
            { label: "场景", ids: ["room"] },
            { label: "道具", ids: ["key"] },
        ];
        for (const [index, column] of columns.entries()) {
            await click(field(view.container, `选择本集全部${column.label}`));
            await click(button(view.container, `生成${column.label}图片`));
            expect(batchChecks).toContainEqual({ projectId: "project-a", input: { action: "cast_image", targetIds: column.ids, baseRevision: 4, episodeId: "episode-1" } });
            expect(view.container.querySelector('[role="dialog"]')).toBeNull();
            expect(batchExecutions[index]).toEqual({ projectId: "project-a", input: { action: "cast_image", targetIds: column.ids, baseRevision: 4, confirmationToken: "batch-confirmation", episodeId: "episode-1" } });
        }
        expect(view.changed).toEqual(["project-a", "project-a", "project-a"]);
        await click(field(view.container, "选择林夏 · 雨夜"));
        expect(view.container.querySelector<HTMLInputElement>('[aria-label="选择本集全部角色"]')?.indeterminate).toBe(true);
        expect(view.container.querySelector<HTMLInputElement>('[aria-label="选择本集全部场景"]')?.checked).toBe(true);
        await click(button(view.container, "生成角色图片"));
        expect(batchChecks.at(-1)?.input.targetIds).toEqual(["hero"]);
        expect(view.container.querySelector('[role="dialog"]')).toBeNull();
        await click(view.container.querySelector<HTMLButtonElement>('[aria-label="下一集主体资产"]')!);
        expect(view.container.querySelector<HTMLInputElement>('[aria-label="选择本集全部角色"]')?.checked).toBe(false);
        expect(view.container.querySelector<HTMLInputElement>('[aria-label="选择本集全部场景"]')?.checked).toBe(false);
        expect(button(view.container, "生成角色图片").disabled).toBe(true);
        for (const [label, name, id] of [
            ["角色", "第二集角色", "guest"],
            ["场景", "第二集庭院", "yard"],
            ["道具", "第二集灯笼", "lantern"],
        ] as const) {
            expect(view.container.textContent).toContain(name);
            await click(field(view.container, `选择本集全部${label}`));
            await click(button(view.container, `生成${label}图片`));
            expect(batchExecutions.at(-1)?.input).toMatchObject({ targetIds: [id], episodeId: "episode-2" });
        }
        for (const selector of ['[aria-label="character:林夏"]', '[aria-label="scene:旧宅"]', '[aria-label="prop:铜钥匙"]']) expect(view.container.querySelector(selector)).toBeNull();
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
    } finally {
        await view.dispose();
    }
});

test("主体管理直接选择完整九集目录，待制作集无需继续选章，忙碌或编辑时保持选集保护", async () => {
    resetFixture();
    const data = summaryOf("project-a", 4);
    data.production.chapterCount = 9;
    data.production.reservedChapterCount = 0;
    data.episodes = Array.from({ length: 9 }, (_, index) => ({ ...data.episodes[0]!, id: `episode-${index + 1}`, number: index + 1, title: `第${index + 1}集`, stage: index ? "draft" : "queued" }));
    episodeDetails.set("episode-9", episodeWithAssets("episode-9"));
    const view = await mount(data);
    try {
        const select = view.container.querySelector<HTMLSelectElement>('[aria-label="主体管理剧集"]')!;
        expect(select.querySelectorAll("option")).toHaveLength(9);
        expect(view.container.textContent).not.toContain("继续选章");
        expect(view.container.textContent).not.toContain("原文 9 章 · 制作 1 集");
        await act(async () => {
            select.value = "episode-9";
            select.dispatchEvent(new Event("change", { bubbles: true }));
            await settle();
        });
        expect(select.value).toBe("episode-9");
        expect(episodeReads.at(-1)).toBe("project-a:episode-9");
        expect(chapterReads).toHaveLength(0);
        expect(createCalls).toHaveLength(0);
        expect(extractCalls).toHaveLength(0);
        await view.update({ busy: true });
        expect(select.disabled).toBe(true);
        await view.update({ busy: false });
        await click(view.container.querySelector<HTMLButtonElement>('[aria-label="新增角色"]')!);
        await edit(field(view.container, "资产名称"), "尚未保存的角色");
        expect(select.disabled).toBe(true);
    } finally {
        await view.dispose();
    }
});

test("图片自动报价不冻结选集，点击直接提交时冻结且回执后恢复", async () => {
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
        await click(field(view.container, "选择本集全部角色"));
        await waitForQuote();
        expect(pendingBatchChecks).toHaveLength(1);
        expect(view.dirtyStates.at(-1)).toEqual([false, false]);
        expect(previous().disabled).toBe(false);
        expect(next().disabled).toBe(false);
        expect(select().disabled).toBe(false);
        await act(async () => {
            pendingBatchChecks[0]!.resolve(batchResponse(batchChecks[0]!.input, "ready"));
            await settle();
        });
        await click(button(view.container, "生成角色图片"));
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
        expect(view.container.querySelector('[role="dialog"]')).toBeNull();
        expect(batchChecks).toHaveLength(1);
        expect(batchExecutions).toHaveLength(1);
        expect(view.changed).toEqual(["project-a"]);
    } finally {
        await view.dispose();
    }
});

test("批次直接提交后刷新同集引用，保留原列并禁止旧范围继续生成", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4), projectCast(), { advanceRevisionOnChange: true });
    try {
        await click(field(view.container, "选择本集全部角色"));
        const column = view.container.querySelector('[aria-label="角色资产"]')!;
        deferEpisodeReads = true;
        await click(button(view.container, "生成角色图片"));
        expect(view.changed).toEqual(["project-a"]);
        expect(pendingEpisodeReads).toHaveLength(1);
        expect(view.container.querySelector('[aria-label="角色资产"]')).toBe(column);
        expect(view.container.querySelector('[role="dialog"]')).toBeNull();
        expect(view.container.querySelector<HTMLInputElement>('[aria-label="选择本集全部角色"]')?.disabled).toBe(true);
        expect(view.container.querySelector<HTMLInputElement>('[aria-label="选择林夏"]')?.disabled).toBe(true);
        expect(button(view.container, "生成角色图片").disabled).toBe(true);
        await act(async () => {
            pendingEpisodeReads[0]!.reject(new Error("引用刷新失败"));
            await settle();
        });
        expect(view.container.textContent).toContain("本集引用资产刷新失败，已保留列表");
        expect(view.container.querySelector('[aria-label="角色资产"]')).toBe(column);
        expect(view.container.querySelector('[role="dialog"]')).toBeNull();
        expect(button(view.container, "生成角色图片").disabled).toBe(true);
        await click(button(view.container, "重试"));
        expect(pendingEpisodeReads).toHaveLength(2);
        await act(async () => {
            pendingEpisodeReads[1]!.resolve(episodeWithAssets("episode-1", { characters: ["hero"], looks: [], props: [], scene: "" }));
            await settle();
        });
        expect(view.container.querySelector('[aria-label="角色资产"]')).toBe(column);
        expect(view.container.querySelector('[role="dialog"]')).toBeNull();
        expect(view.container.querySelector<HTMLInputElement>('[aria-label="选择本集全部角色"]')?.disabled).toBe(false);
        await waitForQuote();
        expect(button(view.container, "生成角色图片").disabled).toBe(false);
        expect(batchChecks.at(-1)?.input.targetIds).toEqual(["hero"]);
        expect(batchChecks.length).toBeGreaterThanOrEqual(1);
        expect(batchExecutions).toHaveLength(1);
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
        expect(createCalls).toEqual([{ projectId: "project-a", input: { kind: "character", name: "新道具", expectedRevision: 4, episodeId: "episode-1" } }]);
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

test("只显示本集引用的角色造型，引用造型时同时显示其本体", async () => {
    resetFixture();
    episodeDetails.set("episode-1", { episode: { id: "episode-1" }, shots: [{ castIdsJson: '["hero"]', lookCastIdsJson: "[]", propIdsJson: "[]" }], segments: [] } as unknown as DramaEpisodeDetail);
    const view = await mount(summaryOf("project-a", 4));
    try {
        expect(view.container.querySelector('[aria-label="character:林夏"]')).not.toBeNull();
        expect(view.container.querySelector('[aria-label="选择林夏 · 雨夜"]')).toBeNull();
        expect(view.container.textContent).not.toContain("林夏造型 雨夜");
        episodeDetails.set("episode-1", episodeWithAssets("episode-1", { characters: [], looks: ["hero-look"], props: [], scene: "" }));
        await view.update({ summary: summaryOf("project-a", 5) });
        expect(view.container.querySelector('[aria-label="character:林夏"]')?.textContent).toContain("林夏造型 雨夜");
        await click(field(view.container, "选择林夏 · 雨夜"));
        expect(field(view.container, "选择本集全部角色")).toHaveProperty("checked", false);
        await click(button(view.container, "生成角色图片"));
        expect(batchChecks.at(-1)?.input.targetIds).toEqual(["hero-look"]);
    } finally {
        await view.dispose();
    }
});

test("本集新增造型保存回调后留在卡片与批量范围，重载保留且同一本体的其他集不混入", async () => {
    resetFixture();
    episodeDetails.set("episode-1", episodeWithExtractedAssets("episode-1", ["hero"]));
    episodeDetails.set("episode-2", episodeWithExtractedAssets("episode-2", ["hero"]));
    const created = castOf("project-a", "new-hero-look", "character", "林夏", { parentId: "hero", lookName: "晚宴" });
    const savedCast = [...projectCast(), created];
    let view = await mount(summaryOf("project-a", 4), projectCast(), { advanceRevisionOnChange: true });
    try {
        await click(button(view.container, "编辑林夏"));
        expect(view.container.querySelector('[aria-label="资产设定编辑器"]')?.getAttribute("data-episode")).toBe("episode-1");
        episodeDetails.set("episode-1", episodeWithExtractedAssets("episode-1", ["hero", created.id]));
        await view.update({ cast: savedCast });
        expect(view.container.querySelector('[aria-label="选择林夏 · 晚宴"]')).toBeNull();
        await click(button(view.container, "完成保存资产设定"));
        await click(button(view.container, "关闭资产设定"));
        expect(view.changed).toEqual(["project-a"]);
        expect(view.container.querySelector('[aria-label="character:林夏"]')?.textContent).toContain("林夏造型 晚宴");
        expect(view.container.querySelector('[aria-label="选择林夏 · 雨夜"]')).toBeNull();
        await click(field(view.container, "选择本集全部角色"));
        await click(button(view.container, "生成角色图片"));
        expect(batchExecutions.at(-1)?.input).toMatchObject({ targetIds: ["hero", created.id], episodeId: "episode-1" });

        await view.dispose();
        view = await mount(summaryOf("project-a", 5), savedCast);
        expect(view.container.querySelector('[aria-label="选择林夏 · 晚宴"]')).not.toBeNull();
        await click(button(view.container, "下一集主体资产"));
        expect(view.container.querySelector('[aria-label="character:林夏"]')).not.toBeNull();
        expect(view.container.querySelector('[aria-label="选择林夏 · 晚宴"]')).toBeNull();
        expect(view.container.querySelector('[aria-label="选择林夏 · 雨夜"]')).toBeNull();
        await click(button(view.container, "上一集主体资产"));
        expect(view.container.querySelector('[aria-label="选择林夏 · 晚宴"]')).not.toBeNull();
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
    test(`无分镜时本集新增${label}直接关联并展示，重载保留且不混入其他集`, async () => {
        resetFixture();
        episodeDetails.set("episode-1", episodeWithExtractedAssets("episode-1", []));
        episodeDetails.set("episode-2", episodeWithExtractedAssets("episode-2", []));
        const created = castOf("project-a", `new-${kind}`, kind, `新${label}`);
        let view = await mount(summaryOf("project-a", 4));
        try {
            await click(view.container.querySelector<HTMLButtonElement>(`[aria-label="新增${label}"]`)!);
            await edit(field(view.container, "资产名称"), created.name);
            await click(button(view.container, "保存资产"));
            expect(createCalls.at(-1)?.input).toEqual({ kind, name: created.name, expectedRevision: 4, episodeId: "episode-1" });
            await act(async () => {
                pendingCreates[0]!.resolve({ cast: created });
                await settle();
            });
            await view.update({ cast: [...projectCast(), created], summary: summaryOf("project-a", 5) });
            await click(button(view.container, "关闭资产设定"));
            expect(view.container.querySelector(`[aria-label="${kind}:${created.name}"]`)).not.toBeNull();
            expect(view.container.querySelector(".drama-workflow-assets-shared")).toBeNull();
            expect(view.generated).toEqual([]);
            expect(batchExecutions).toEqual([]);

            await view.dispose();
            view = await mount(summaryOf("project-a", 5), [...projectCast(), created]);
            expect(view.container.querySelector(`[aria-label="${kind}:${created.name}"]`)).not.toBeNull();
            await click(button(view.container, "下一集主体资产"));
            expect(view.container.querySelector(`[aria-label="${kind}:${created.name}"]`)).toBeNull();
            await click(button(view.container, "上一集主体资产"));
            expect(view.container.querySelector(`[aria-label="${kind}:${created.name}"]`)).not.toBeNull();
            await view.update({ variant: "library" });
            if (kind !== "character") await click(button(view.container.querySelector<HTMLElement>('[aria-label="主体资产分类"]')!, label));
            expect(view.container.querySelector(`[aria-label="${kind}:${created.name}"]`)).not.toBeNull();
            await view.update({ variant: "episode" });
            expect(view.container.querySelector(`[aria-label="${kind}:${created.name}"]`)).not.toBeNull();
            await click(button(view.container, `生成${created.name}`));
            expect(view.generated).toEqual([`project-a:${created.id}`]);
            await click(field(view.container, `选择${created.name}`));
            await click(button(view.container, `生成${label}图片`));
            expect(batchExecutions.at(-1)?.input.targetIds).toEqual([created.id]);
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
        expect(button(view.container, "删除林夏").disabled).toBe(true);
        expect(button(view.container, "将林夏加入角色库").disabled).toBe(true);
        await click(button(view.container, "新增角色"));
        await click(button(view.container, "编辑林夏"));
        await click(button(view.container, "生成林夏"));
        await click(button(view.container, "删除林夏"));
        await click(button(view.container, "将林夏加入角色库"));
        expect(view.container.querySelector('[aria-label="资产设定编辑器"]')).toBeNull();
        expect(view.container.querySelector('[aria-label="资产名称"]')).toBeNull();
        const sceneCategory = button(view.container, "场景");
        expect(sceneCategory.disabled).toBe(false);
        await click(sceneCategory);
        expect(sceneCategory.getAttribute("aria-pressed")).toBe("true");
        expect(button(view.container, "新增场景").disabled).toBe(true);
        expect(extractCalls).toHaveLength(0);
        expect(createCalls).toHaveLength(0);
        expect(view.generated).toEqual([]);
        expect(deleteCalls).toHaveLength(0);
        expect(savedToLibrary).toHaveLength(0);
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

test("切换作品、账号或卸载后，迟到的新增不能刷新当前页或打开旧编辑器", async () => {
    for (const boundary of ["project", "account", "unmount"] as const) {
        resetFixture();
        const view = await mount(summaryOf("project-a", 4));
        let disposed = false;
        try {
            await click(view.container.querySelector<HTMLButtonElement>('[aria-label="新增角色"]')!);
            await edit(field(view.container, "资产名称"), "旧账号资产");
            await click(button(view.container, "保存资产"));
            expect(pendingCreates).toHaveLength(1);
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
                pendingCreates[0].resolve({ cast: castOf("project-a", "late-created", "character", "迟到的旧资产") });
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
}, 20_000);

test("忙碌时不能新增、批选或操作角色库，加载状态可见", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4), [], { loading: true, busy: true });
    try {
        expect(view.container.textContent).toContain("正在读取本作品资产");
        expect(view.container.textContent).not.toContain("尚未生成资产文字");
        expect(view.container.querySelector<HTMLButtonElement>('[aria-label="新增角色"]')?.disabled).toBe(true);
        expect(view.container.querySelector<HTMLInputElement>('[aria-label="选择本集全部角色"]')?.disabled).toBe(true);
        expect(button(view.container, "生成角色图片").disabled).toBe(true);
        expect(view.container.querySelector('[aria-label="人物信息与角色库"]')).toBeNull();
        expect(button(view.container, "从角色库导入").disabled).toBe(true);
        expect(extractCalls).toHaveLength(0);
        expect(createCalls).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("主体管理切集读取对应配置且单图和批量生成携带本集", async () => {
    resetFixture();
    configurationOverrides.set("episode-2", { ...settings(), assets: { ...assets(), characterPrompt: "第二集模板" } });
    const view = await mount(summaryOf("project-a", 4));
    try {
        await act(async () => {
            const select = view.container.querySelector<HTMLSelectElement>('[aria-label="主体管理剧集"]')!;
            select.value = "episode-2";
            select.dispatchEvent(new Event("change", { bubbles: true }));
            await settle();
        });
        await act(async () => {
            await settle();
        });
        await click(button(view.container, "生成林夏"));
        expect(view.generatedEpisodes).toEqual(["episode-2"]);
        expect(configurationReads).toContain("project-a:episode-2");
        await click(button(view.container, "编辑林夏"));
        const editor = view.container.querySelector('[aria-label="资产设定编辑器"]');
        expect(editor?.getAttribute("data-episode")).toBe("episode-2");
        expect(editor?.getAttribute("data-character-prompt")).toBe("第二集模板");
        await click(button(view.container, "关闭资产设定"));
        await click(view.container.querySelector('[aria-label="选择本集全部角色"]')!);
        await click(button(view.container, "生成角色图片"));
        expect(batchChecks.at(-1)?.input.episodeId).toBe("episode-2");
    } finally {
        await view.dispose();
    }
});

test("本集配置读取失败时暂停单图、批量生成和编辑，重新读取后恢复", async () => {
    resetFixture();
    configurationError = true;
    const view = await mount(summaryOf("project-a", 4));
    try {
        expect(view.container.textContent).toContain("本集配置读取失败");
        expect(button(view.container, "生成角色图片").disabled).toBe(true);
        expect(field(view.container, "选择本集全部角色")).toHaveProperty("disabled", true);
        expect(button(view.container, "生成林夏").disabled).toBe(true);
        expect(button(view.container, "编辑林夏").disabled).toBe(true);
        await click(button(view.container, "生成林夏"));
        expect(view.generated).toEqual([]);
        configurationError = false;
        await click(button(view.container, "重新读取"));
        expect(view.container.textContent).not.toContain("本集配置读取失败");
        expect(field(view.container, "选择本集全部角色")).toHaveProperty("disabled", false);
        await click(field(view.container, "选择本集全部角色"));
        await waitForQuote();
        expect(button(view.container, "生成角色图片").disabled).toBe(false);
        expect(button(view.container, "生成林夏").disabled).toBe(false);
        expect(button(view.container, "编辑林夏").disabled).toBe(false);
    } finally {
        await view.dispose();
    }
});

test("新增名称参与离开保护，取消后恢复干净状态", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4), []);
    try {
        expect(view.container.textContent).toContain("本集暂无关联角色");
        expect(view.container.textContent).not.toContain("生成后会停在这里");
        await click(view.container.querySelector<HTMLButtonElement>('[aria-label="新增角色"]')!);
        await edit(field(view.container, "资产名称"), "待补设定的角色");
        expect(view.dirtyStates.at(-1)).toEqual([true, false]);
        await click(button(view.container, "取消"));
        expect(view.dirtyStates.at(-1)).toEqual([false, false]);
    } finally {
        await view.dispose();
    }
});

test("单集与资产库的角色快捷存库共用唯一控制器并传递真实角色", async () => {
    for (const variant of ["episode", "library"] as const) {
        resetFixture();
        const cast = projectCast();
        const view = await mount(summaryOf("project-a", 4), cast, { variant });
        try {
            await click(button(view.container, "将林夏加入角色库"));
            expect(savedToLibrary).toHaveLength(1);
            expect(savedToLibrary[0]).toBe(cast[0]);
            const dialog = view.container.querySelector('[role="dialog"][aria-label="角色另存库"]');
            expect(dialog?.getAttribute("data-cast")).toBe("hero");
            expect(view.container.querySelectorAll("[data-asset-library-controller]")).toHaveLength(1);
            expect(view.container.textContent).not.toContain("将旧宅加入角色库");
            expect(view.container.textContent).not.toContain("将铜钥匙加入角色库");
            expect(deleteCalls).toHaveLength(0);
            expect(view.generated).toEqual([]);
        } finally {
            await view.dispose();
        }
    }
});

test("删除显示关联范围且可取消，确认提交目标和核对过的范围，在途冻结并防止重复提交", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 7));
    deleteImpactOverride = { revision: 7, castId: "room", segments: 2, shots: 3 };
    try {
        await click(button(view.container, "删除旧宅"));
        let dialog = view.container.querySelector<HTMLElement>('[role="dialog"][aria-label="删除「旧宅」？"]')!;
        expect(dialog).not.toBeNull();
        expect(dialog.textContent).toContain("从整个作品中移除此资产");
        expect(dialog.textContent).toContain("已关联 2 个剧情段、3 个镜头");
        expect(dialog.textContent).toContain("提示词和已生成的媒体保留");
        expect(deleteCalls).toHaveLength(0);
        expect(view.dirtyStates.at(-1)).toEqual([false, true]);
        expect(view.container.querySelector<HTMLSelectElement>('[aria-label="主体管理剧集"]')?.disabled).toBe(true);
        await click(button(dialog, "取消"));
        expect(view.container.querySelector('[role="dialog"]')).toBeNull();
        expect(deleteCalls).toHaveLength(0);
        expect(view.dirtyStates.at(-1)).toEqual([false, false]);
        await click(button(view.container, "删除旧宅"));
        dialog = view.container.querySelector<HTMLElement>('[role="dialog"][aria-label="删除「旧宅」？"]')!;
        await click(button(dialog, "确认删除"));
        expect(deleteCalls).toEqual([{ projectId: "project-a", castId: "room", expectedRevision: 7, deleteScopeToken: "reviewed-token" }]);
        expect(button(dialog, "确认删除").disabled).toBe(true);
        expect(button(dialog, "取消").disabled).toBe(true);
        await click(button(dialog, "确认删除"));
        expect(deleteCalls).toHaveLength(1);
        expect(view.changed).toEqual([]);
        expect(notices.some((notice) => notice.kind === "success")).toBe(false);
        await act(async () => {
            pendingDeletes[0].resolve({ deleted: true, castId: "room" });
            await settle();
        });
        expect(view.changed).toEqual(["project-a"]);
        expect(notices.at(-1)).toEqual({ kind: "success", text: "已删除场景「旧宅」" });
        expect(view.container.querySelector('[role="dialog"]')).toBeNull();
        expect(view.dirtyStates.at(-1)).toEqual([false, false]);
        expect(view.generated).toEqual([]);
        expect(createCalls).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("删除前读取版本失败可以重试，并且不能通过过期的引用结果继续", async () => {
    resetFixture();
    deleteImpactError = true;
    const view = await mount(summaryOf("project-a", 4));
    try {
        await click(button(view.container, "删除旧宅"));
        let dialog = view.container.querySelector<HTMLElement>('[role="dialog"][aria-label="删除「旧宅」？"]')!;
        expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("无法检查资产引用");
        expect(button(dialog, "确认删除").disabled).toBe(true);
        await click(button(dialog, "确认删除"));
        expect(deleteCalls).toEqual([]);

        deleteImpactError = false;
        deleteImpactOverride = { revision: 5, segments: 2, shots: 3 };
        await click(button(dialog, "重试"));
        expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("作品内容已更新");
        expect(button(dialog, "确认删除").disabled).toBe(true);
        await click(button(dialog, "确认删除"));
        expect(deleteCalls).toEqual([]);

        await click(button(dialog, "取消"));
        await view.update({ summary: summaryOf("project-a", 5) });
        await click(button(view.container, "删除旧宅"));
        dialog = view.container.querySelector<HTMLElement>('[role="dialog"][aria-label="删除「旧宅」？"]')!;
        expect(dialog.textContent).toContain("已关联 2 个剧情段、3 个镜头");
        expect(button(dialog, "确认删除").disabled).toBe(false);
    } finally {
        await view.dispose();
    }
});

test("确认后镜头关联变化时更新影响范围，重新确认才提交新的范围", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4));
    try {
        await click(button(view.container, "删除旧宅"));
        const dialog = view.container.querySelector<HTMLElement>('[role="dialog"][aria-label="删除「旧宅」？"]')!;
        await click(button(dialog, "确认删除"));
        deleteImpactOverride = { shots: 1, deleteScopeToken: "fresh-token" };
        await act(async () => {
            pendingDeletes[0].reject(new ApiError("资产的关联范围已更新，请重新核对后确认删除", { status: 409, reason: "drama_cast_delete_scope_changed" }));
            await settle();
        });
        expect(dialog.textContent).toContain("已关联 1 个镜头");
        expect(deleteCalls.map((call) => call.deleteScopeToken)).toEqual(["reviewed-token"]);
        await click(button(dialog, "确认删除"));
        expect(deleteCalls.map((call) => call.deleteScopeToken)).toEqual(["reviewed-token", "fresh-token"]);
        await act(async () => {
            pendingDeletes[1].resolve({ deleted: true, castId: "room" });
            await settle();
        });
        expect(view.container.querySelector('[role="dialog"][aria-label="删除「旧宅」？"]')).toBeNull();
    } finally {
        await view.dispose();
    }
});

test("生成任务在途的删除冲突保留真实后端信息和原卡片，不误报成功或改写为版本提示", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4));
    const conflict = "该资产的生成任务尚未结束，请完成后再删除";
    try {
        await click(button(view.container, "删除旧宅"));
        const dialog = view.container.querySelector<HTMLElement>('[role="dialog"][aria-label="删除「旧宅」？"]')!;
        await click(button(dialog, "确认删除"));
        await act(async () => {
            pendingDeletes[0].reject(new ApiError(conflict, { status: 409, reason: "conflict" }));
            await settle();
        });
        expect(notices.at(-1)).toEqual({ kind: "error", text: conflict });
        expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(conflict);
        expect(view.container.querySelector('[aria-label="scene:旧宅"]')).not.toBeNull();
        expect(view.changed).toEqual([]);
        expect(notices.some((notice) => notice.kind === "success" || notice.text.includes("作品已有更新"))).toBe(false);
        expect(button(dialog, "确认删除").disabled).toBe(false);
        expect(button(dialog, "取消").disabled).toBe(false);
        await click(button(dialog, "取消"));
        expect(view.container.querySelector('[role="dialog"]')).toBeNull();
        expect(deleteCalls).toHaveLength(1);
    } finally {
        await view.dispose();
    }
});

test("删除确认中的作品版本或目标改变后禁用提交，不能用旧确认删除更新后的资产", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4));
    try {
        await click(button(view.container, "删除旧宅"));
        await view.update({ summary: summaryOf("project-a", 5) });
        let dialog = view.container.querySelector<HTMLElement>('[role="dialog"][aria-label="删除「旧宅」？"]')!;
        expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("作品内容已更新");
        expect(button(dialog, "确认删除").disabled).toBe(true);
        await click(button(dialog, "确认删除"));
        expect(deleteCalls).toHaveLength(0);
        await click(button(dialog, "取消"));
        await click(button(view.container, "删除旧宅"));
        dialog = view.container.querySelector<HTMLElement>('[role="dialog"][aria-label="删除「旧宅」？"]')!;
        expect(button(dialog, "确认删除").disabled).toBe(false);
        await view.update({ cast: projectCast().filter((item) => item.id !== "room") });
        expect(button(dialog, "确认删除").disabled).toBe(true);
        await click(button(dialog, "确认删除"));
        expect(deleteCalls).toHaveLength(0);
        expect(view.changed).toEqual([]);
    } finally {
        await view.dispose();
    }
});

test("新增草稿、打开编辑器、库草稿或页面忙碌时不能删除，取消修改后恢复", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4));
    try {
        await click(button(view.container, "编辑林夏"));
        await click(button(view.container, "删除旧宅"));
        expect(view.container.querySelector('[role="dialog"]')).toBeNull();
        expect(notices.at(-1)).toEqual({ kind: "info", text: "请先保存或取消当前修改，再删除资产" });
        await click(button(view.container, "关闭资产设定"));
        await click(button(view.container, "新增角色"));
        await edit(field(view.container, "资产名称"), "尚未保存的角色");
        await click(button(view.container, "删除旧宅"));
        expect(view.container.querySelector('[role="dialog"][aria-label="删除「旧宅」？"]')).toBeNull();
        expect(field(view.container, "资产名称").value).toBe("尚未保存的角色");
        await click(button(view.container, "取消"));
        await click(button(view.container, "从角色库导入"));
        await click(button(view.container, "修改角色导入"));
        await click(button(view.container, "删除旧宅"));
        expect(view.container.querySelector('[role="dialog"][aria-label="删除「旧宅」？"]')).toBeNull();
        await click(button(view.container, "关闭角色库"));
        await view.update({ busy: true });
        expect(button(view.container, "删除旧宅").disabled).toBe(true);
        await click(button(view.container, "删除旧宅"));
        expect(view.container.querySelector('[role="dialog"]')).toBeNull();
        await view.update({ busy: false });
        await click(button(view.container, "删除旧宅"));
        const dialog = view.container.querySelector<HTMLElement>('[role="dialog"][aria-label="删除「旧宅」？"]')!;
        expect(dialog).not.toBeNull();
        await view.update({ busy: true });
        expect(button(dialog, "确认删除").disabled).toBe(true);
        await click(button(dialog, "确认删除"));
        expect(deleteCalls).toHaveLength(0);
        expect(view.changed).toEqual([]);
    } finally {
        await view.dispose();
    }
});

test("跨作品、账号、集或卸载后隔离迟到的删除成功及失败，不能刷新新范围或弹旧消息", async () => {
    for (const boundary of ["project", "account", "episode", "unmount"] as const) {
        for (const outcome of ["success", "failure"] as const) {
            resetFixture();
            const view = await mount(summaryOf("project-a", 4));
            let disposed = false;
            try {
                await click(button(view.container, "删除旧宅"));
                const dialog = view.container.querySelector<HTMLElement>('[role="dialog"][aria-label="删除「旧宅」？"]')!;
                await click(button(dialog, "确认删除"));
                expect(deleteCalls).toEqual([{ projectId: "project-a", castId: "room", expectedRevision: 4, deleteScopeToken: "reviewed-token" }]);
                if (boundary === "project") await view.update({ summary: summaryOf("project-b", 1), cast: [castOf("project-b", "other-room", "scene", "其他作品场景")] });
                if (boundary === "account")
                    await act(async () => {
                        userStore.getState().setUser({ id: "user-b", username: "b", displayName: "账号B", role: "user", status: "active" });
                        await settle();
                    });
                if (boundary === "episode") await view.update({ episodeId: "episode-2" });
                if (boundary === "unmount") {
                    await view.dispose();
                    disposed = true;
                }
                const changedBefore = view.changed.length;
                const noticesBefore = notices.length;
                await act(async () => {
                    if (outcome === "success") pendingDeletes[0].resolve({ deleted: true, castId: "room" });
                    else pendingDeletes[0].reject(new ApiError("旧范围的删除冲突", { status: 409, reason: "conflict" }));
                    await settle();
                });
                expect(view.changed.length).toBe(changedBefore);
                expect(notices.slice(noticesBefore)).toEqual([]);
                expect(view.container.querySelector('[role="dialog"][aria-label="删除「旧宅」？"]')).toBeNull();
                expect(deleteCalls).toHaveLength(1);
            } finally {
                if (!disposed) await view.dispose();
            }
        }
    }
}, 20_000);

function extractionSummary(projectId = "project-a", revision = 4): DramaSummary {
    const summary = summaryOf(projectId, revision);
    return { ...summary, production: { ...summary.production, stage: "produce" } };
}

function extractionJob(kind: DramaCastKind, status: DramaJob["status"] = "queued"): DramaJob {
    return {
        id: `extract-${kind}`,
        kind: "bible",
        status,
        assetKind: kind,
        label: `提取${kind}`,
        sourceChapterIds: ["chapter-a"],
        sourceEpisodeIds: ["episode-1"],
        costMicrocredits: 0,
        attempt: 0,
        createdAt: "2026-11-17T03:00:00Z",
        updatedAt: "2026-11-17T03:00:00Z",
    };
}

test("首次资产提取时当前集三个按钮持续转圈，任务结束后停止", async () => {
    resetFixture();
    const initialJob = { ...extractionJob("character"), id: "initial-assets", assetKind: undefined, label: "首次资产提取：第 1 集" };
    projectJobs.set("project-a", [initialJob]);
    const summary = summaryOf("project-a", 4);
    summary.production.status = "running";
    summary.jobCounts = { queued: 1 };
    const view = await mount(summary, [], { episodeId: "episode-1" });
    const expectSpinners = (busy: boolean) => {
        for (const label of ["角色", "场景", "道具"]) {
            const trigger = button(view.container, `提取全部${label}`);
            expect(trigger.getAttribute("aria-busy")).toBe(String(busy));
            expect(Boolean(trigger.querySelector('[class~="motion-safe:animate-spin"]'))).toBe(busy);
            if (busy) expect(trigger.disabled).toBe(true);
        }
    };
    const updateJob = async (status: DramaJob["status"]) => {
        projectJobs.set("project-a", [{ ...initialJob, status }]);
        await act(async () => {
            await view.client.invalidateQueries({ queryKey: ["drama", "project-a", "jobs"] });
            await settle();
        });
    };
    try {
        expectSpinners(true);
        await updateJob("running");
        expectSpinners(true);
        await view.update({ episodeId: "episode-2" });
        expectSpinners(false);
        await view.update({ episodeId: "episode-1" });
        expectSpinners(true);
        await updateJob("failed");
        expectSpinners(false);
        expect(extractCalls).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("单集三类资产直接按当前集提取，空列表可提交且在途不重复、不清空已有资产", async () => {
    for (const [kind, label] of [
        ["character", "角色"],
        ["scene", "场景"],
        ["prop", "道具"],
    ] as const) {
        resetFixture();
        const originalCast = kind === "character" ? projectCast() : projectCast().filter((item) => item.kind !== kind);
        const view = await mount(extractionSummary(), originalCast);
        try {
            const targetEpisodeId = kind === "prop" ? "episode-2" : "episode-1";
            if (targetEpisodeId === "episode-2") await click(button(view.container, "下一集主体资产"));
            const trigger = button(view.container, `提取全部${label}`);
            expect(trigger.disabled).toBe(false);
            await act(async () => {
                trigger.click();
                trigger.click();
                await settle();
            });
            expect(extractCalls).toEqual([{ projectId: "project-a", input: { expectedRevision: 4, kind, episodeIds: [targetEpisodeId] } }]);
            expect(view.container.querySelector('[role="dialog"]')).toBeNull();
            expect(button(view.container, `提取全部${label}`).textContent).toContain(`正在提取${label}`);
            expect(button(view.container, `提取全部${label}`).querySelector('[class~="motion-safe:animate-spin"]')).not.toBeNull();
            for (const other of ["角色", "场景", "道具"]) expect(button(view.container, `提取全部${other}`).disabled).toBe(other === label);
            expect(view.container.querySelector('[aria-label="character:林夏"]')).not.toBeNull();
            const job = { ...extractionJob(kind), sourceEpisodeIds: [targetEpisodeId] };
            projectJobs.set("project-a", [job]);
            await act(async () => {
                pendingExtractions[0].resolve({ job, revision: 4 });
                await settle();
            });
            expect(view.changed).toEqual(["project-a"]);
            expect(button(view.container, `提取全部${label}`).textContent).toContain(`正在提取${label}`);
            expect(button(view.container, `提取全部${label}`).querySelector('[class~="motion-safe:animate-spin"]')).not.toBeNull();
            for (const other of ["角色", "场景", "道具"]) expect(button(view.container, `提取全部${other}`).disabled).toBe(other === label);
            expect(extractCalls).toHaveLength(1);
            expect(createCalls).toHaveLength(0);
            expect(view.generated).toEqual([]);
            expect(chapterReads).toHaveLength(0);
        } finally {
            await view.dispose();
        }
    }
}, 10_000);

test("单集提取默认按集号选首集，目录倒序仍只发送本集来源", async () => {
    resetFixture();
    const summary = extractionSummary();
    summary.episodes.reverse();
    const view = await mount(summary);
    try {
        expect(view.container.querySelector<HTMLSelectElement>('[aria-label="主体管理剧集"]')?.value).toBe("episode-1");
        await click(button(view.container, "提取全部角色"));
        expect(extractCalls).toEqual([{ projectId: "project-a", input: { expectedRevision: 4, kind: "character", episodeIds: ["episode-1"] } }]);
        expect(extractCalls[0].input.allChapters).toBeUndefined();
    } finally {
        await view.dispose();
    }
});

test("单集缺失或选择已失效时不回退全剧提取，恢复有效选集后只提取该集", async () => {
    for (const episodeId of ["", "removed-episode"] as const) {
        resetFixture();
        const summary = extractionSummary();
        const view = await mount(episodeId ? summary : { ...summary, episodes: [] }, projectCast(), { episodeId });
        try {
            expect(view.container.querySelector('[aria-label="资产卡片"]')).toBeNull();
            for (const trigger of view.container.querySelectorAll<HTMLButtonElement>('[aria-label^="提取全部"]')) {
                expect(trigger.disabled).toBe(true);
                await click(trigger);
            }
            expect(extractCalls).toHaveLength(0);
            await view.update({ summary, episodeId: "episode-2" });
            await click(button(view.container, "提取全部场景"));
            expect(extractCalls).toEqual([{ projectId: "project-a", input: { expectedRevision: 4, kind: "scene", episodeIds: ["episode-2"] } }]);
            expect(extractCalls[0].input.allChapters).toBeUndefined();
        } finally {
            await view.dispose();
        }
    }
});

test("作品资产库只展示当前分类的提取入口，提交对应种类而非当前集", async () => {
    resetFixture();
    const view = await mount(extractionSummary(), projectCast(), { variant: "library" });
    const kinds = [
        ["character", "角色"],
        ["scene", "场景"],
        ["prop", "道具"],
    ] as const;
    try {
        const tabs = view.container.querySelector<HTMLElement>('[aria-label="主体资产分类"]')!;
        for (const [index, [, label]] of kinds.entries()) {
            if (index) {
                expect(button(tabs, label).disabled).toBe(false);
                await click(button(tabs, label));
            }
            expect(view.container.querySelectorAll('[aria-label^="提取全部"]')).toHaveLength(1);
            expect(button(view.container, `提取全部${label}`).disabled).toBe(false);
            await click(button(view.container, `提取全部${label}`));
            expect(extractCalls).toEqual(kinds.slice(0, index + 1).map(([kind]) => ({ projectId: "project-a", input: { expectedRevision: 4, kind, allChapters: true } })));
            expect(button(view.container, `提取全部${label}`).textContent).toContain(`正在提取${label}`);
            expect(view.container.querySelector('[role="dialog"]')).toBeNull();
        }
        await click(button(tabs, "角色"));
        expect(button(view.container, "提取全部角色").disabled).toBe(true);
        expect(button(view.container, "提取全部角色").textContent).toContain("正在提取角色");
        expect(pendingExtractions).toHaveLength(3);
    } finally {
        await view.dispose();
    }
}, 10_000);

test("重进页面只禁用正在提取的类型，任务完成后恢复，其他文字任务仍阻止全部提取", async () => {
    resetFixture();
    projectJobs.set("project-a", [extractionJob("scene", "running")]);
    const view = await mount(extractionSummary());
    try {
        expect(button(view.container, "提取全部场景").textContent).toContain("正在提取场景");
        for (const label of ["角色", "场景", "道具"]) expect(button(view.container, `提取全部${label}`).disabled).toBe(label === "场景");
        expect(extractCalls).toHaveLength(0);
        projectJobs.set("project-a", [extractionJob("scene", "succeeded")]);
        await act(async () => {
            await view.client.invalidateQueries({ queryKey: ["drama", "project-a", "jobs"] });
            await settle();
        });
        expect(button(view.container, "提取全部场景").textContent).not.toContain("正在提取");
        expect(button(view.container, "提取全部场景").disabled).toBe(false);
        projectJobs.set("project-a", [{ ...extractionJob("prop"), id: "writing-script", kind: "script", assetKind: undefined }]);
        await act(async () => {
            await view.client.invalidateQueries({ queryKey: ["drama", "project-a", "jobs"] });
            await settle();
        });
        for (const label of ["角色", "场景", "道具"]) expect(button(view.container, `提取全部${label}`).disabled).toBe(true);
        await click(button(view.container, "提取全部角色"));
        expect(extractCalls).toHaveLength(0);
    } finally {
        await view.dispose();
    }
});

test("单类提取失败不影响其他类型运行，保留资产并能用最新作品版本重试", async () => {
    resetFixture();
    projectJobs.set("project-a", [extractionJob("character", "running")]);
    const view = await mount(extractionSummary());
    try {
        await click(button(view.container, "提取全部道具"));
        await act(async () => {
            pendingExtractions[0].reject(new Error("道具提取暂时不可用"));
            await settle();
        });
        expect(notices.at(-1)).toEqual({ kind: "error", text: "道具提取暂时不可用" });
        expect(view.container.querySelector('[aria-label="prop:铜钥匙"]')).not.toBeNull();
        expect(view.changed).toEqual(["project-a"]);
        expect(notices.some((notice) => notice.kind === "success")).toBe(false);
        expect(button(view.container, "提取全部道具").disabled).toBe(false);
        expect(button(view.container, "提取全部场景").disabled).toBe(false);
        expect(button(view.container, "提取全部角色").disabled).toBe(true);
        expect(button(view.container, "提取全部角色").textContent).toContain("正在提取角色");
        await view.update({ summary: extractionSummary("project-a", 6) });
        await click(button(view.container, "提取全部道具"));
        expect(extractCalls.at(-1)).toEqual({ projectId: "project-a", input: { expectedRevision: 6, kind: "prop", episodeIds: ["episode-1"] } });
        expect(view.generated).toEqual([]);
    } finally {
        await view.dispose();
    }
});

test("三类资产可同一版本同时提取，每类防重且并发回执不丢任务，刷新恢复各自状态", async () => {
    resetFixture();
    episodeDetails.set("episode-1", episodeWithExtractedAssets("episode-1", []));
    const view = await mount(extractionSummary());
    const kinds = [
        ["character", "角色"],
        ["scene", "场景"],
        ["prop", "道具"],
    ] as const;
    try {
        await act(async () => {
            for (const [, label] of kinds) {
                const trigger = button(view.container, `提取全部${label}`);
                trigger.click();
                trigger.click();
            }
            await settle();
        });
        expect(extractCalls).toEqual(kinds.map(([kind]) => ({ projectId: "project-a", input: { expectedRevision: 4, kind, episodeIds: ["episode-1"] } })));
        for (const [, label] of kinds) {
            expect(button(view.container, `提取全部${label}`).disabled).toBe(true);
            expect(button(view.container, `提取全部${label}`).textContent).toContain(`正在提取${label}`);
        }
        const jobs = kinds.map(([kind]) => extractionJob(kind));
        projectJobs.set("project-a", jobs);
        await act(async () => {
            pendingExtractions[1].resolve({ job: jobs[1], revision: 4 });
            await settle();
        });
        expect(view.changed).toEqual(["project-a"]);
        for (const [, label] of kinds) expect(button(view.container, `提取全部${label}`).disabled).toBe(true);
        await act(async () => {
            pendingExtractions[2].resolve({ job: jobs[2], revision: 4 });
            pendingExtractions[0].resolve({ job: jobs[0], revision: 4 });
            await settle();
        });
        const queued = view.client.getQueryData<{ jobs: DramaJob[] }>(["drama", "project-a", "jobs"]);
        expect(queued?.jobs.map((job) => job.id).sort()).toEqual(jobs.map((job) => job.id).sort());
        expect(view.changed).toEqual(["project-a", "project-a", "project-a"]);
        expect(extractCalls).toHaveLength(3);
        expect(view.container.querySelector('[aria-label="character:林夏"]')).toBeNull();
        episodeDetails.set("episode-1", episodeWithExtractedAssets("episode-1", ["hero"]));
        projectJobs.set("project-a", [extractionJob("character", "succeeded"), extractionJob("scene", "running"), extractionJob("prop", "failed")]);
        await act(async () => {
            await view.client.invalidateQueries({ queryKey: ["drama", "project-a", "jobs"] });
            await settle();
        });
        expect(button(view.container, "提取全部角色").disabled).toBe(false);
        expect(button(view.container, "提取全部角色").textContent).not.toContain("正在提取");
        expect(button(view.container, "提取全部场景").disabled).toBe(true);
        expect(button(view.container, "提取全部场景").textContent).toContain("正在提取场景");
        expect(button(view.container, "提取全部道具").disabled).toBe(false);
        expect(button(view.container, "提取全部道具").textContent).not.toContain("正在提取");
        expect(view.container.querySelector('[aria-label="character:林夏"]')).not.toBeNull();
        expect(view.container.querySelector('[aria-label="scene:旧宅"]')).toBeNull();
        expect(view.container.querySelector('[aria-label="prop:铜钥匙"]')).toBeNull();
        const changedBeforeFinal = view.changed.length;
        episodeDetails.set("episode-1", episodeWithExtractedAssets("episode-1", ["hero", "room"]));
        projectJobs.set("project-a", [extractionJob("character", "succeeded"), extractionJob("scene", "succeeded"), extractionJob("prop", "failed")]);
        await act(async () => {
            await view.client.invalidateQueries({ queryKey: ["drama", "project-a", "jobs"] });
            await settle();
        });
        expect(view.changed.length).toBeGreaterThan(changedBeforeFinal);
        expect(view.container.querySelector('[aria-label="scene:旧宅"]')).not.toBeNull();
        expect(view.container.querySelector('[aria-label="prop:铜钥匙"]')).toBeNull();
        for (const [, label] of kinds) expect(button(view.container, `提取全部${label}`).disabled).toBe(false);
        await click(button(view.container, "提取全部角色"));
        const fastJob = { ...extractionJob("character"), id: "extract-character-fast" };
        projectJobs.set("project-a", [...(projectJobs.get("project-a") || []), { ...fastJob, status: "succeeded" }]);
        const changedBeforeFast = view.changed.length;
        let completedBeforeRender = false;
        const unsubscribe = view.client.getQueryCache().subscribe((event) => {
            if (event.type !== "updated" || event.query.queryKey.join(":") !== "drama:project-a:jobs" || completedBeforeRender) return;
            const data = event.query.state.data as { jobs: DramaJob[] } | undefined;
            if (!data?.jobs.some((job) => job.id === fastJob.id && job.status === "queued")) return;
            completedBeforeRender = true;
            view.client.setQueryData(["drama", "project-a", "jobs"], { jobs: data.jobs.map((job) => (job.id === fastJob.id ? { ...job, status: "succeeded" } : job)) });
        });
        try {
            await act(async () => {
                pendingExtractions[3].resolve({ job: fastJob, revision: 4 });
                await settle();
            });
            expect(completedBeforeRender).toBe(true);
            expect(view.client.getQueryData<{ jobs: DramaJob[] }>(["drama", "project-a", "jobs"])?.jobs.find((job) => job.id === fastJob.id)?.status).toBe("succeeded");
            expect(button(view.container, "提取全部角色").disabled).toBe(false);
            expect(view.changed.length - changedBeforeFast).toBeGreaterThanOrEqual(2);
        } finally {
            unsubscribe();
        }
        expect(view.generated).toEqual([]);
    } finally {
        await view.dispose();
    }
});

test("未完成首次建档、风格配置中、草稿或页面忙碌时不能提交全部资产提取", async () => {
    resetFixture();
    const view = await mount(summaryOf("project-a", 4));
    try {
        expect(button(view.container, "提取全部角色").disabled).toBe(true);
        await view.update({ summary: { ...extractionSummary(), guide: { step: "configuring", canConfirm: false } } });
        expect(button(view.container, "提取全部角色").disabled).toBe(true);
        await view.update({ summary: extractionSummary(), busy: true });
        expect(button(view.container, "提取全部角色").disabled).toBe(true);
        await view.update({ busy: false });
        expect(button(view.container, "提取全部角色").disabled).toBe(false);
        await click(button(view.container, "新增角色"));
        await edit(field(view.container, "资产名称"), "未完成的新增角色");
        expect(button(view.container, "提取全部角色").disabled).toBe(true);
        await click(button(view.container, "提取全部角色"));
        expect(extractCalls).toHaveLength(0);
        expect(field(view.container, "资产名称").value).toBe("未完成的新增角色");
        await click(button(view.container, "取消"));
        expect(button(view.container, "提取全部角色").disabled).toBe(false);
    } finally {
        await view.dispose();
    }
});

test("切换作品或账号后隔离迟到的提取成功和失败，不污染当前队列或弹出旧提示", async () => {
    for (const boundary of ["project", "account"] as const) {
        for (const outcome of ["success", "failure"] as const) {
            resetFixture();
            const view = await mount(extractionSummary());
            try {
                await click(button(view.container, "提取全部场景"));
                expect(extractCalls).toHaveLength(1);
                if (boundary === "project") await view.update({ summary: extractionSummary("project-b", 1), cast: [castOf("project-b", "other-room", "scene", "其他作品场景")] });
                else
                    await act(async () => {
                        userStore.getState().setUser({ id: "user-b", username: "b", displayName: "账号B", role: "user", status: "active" });
                        await settle();
                    });
                const changedBefore = view.changed.length;
                const noticesBefore = notices.length;
                const jobsBefore = structuredClone(view.client.getQueryData(["drama", boundary === "project" ? "project-b" : "project-a", "jobs"]));
                await act(async () => {
                    if (outcome === "success") pendingExtractions[0].resolve({ job: extractionJob("scene"), revision: 4 });
                    else pendingExtractions[0].reject(new ApiError("旧范围提取失败", { status: 409, reason: "conflict" }));
                    await settle();
                });
                expect(view.changed.length).toBe(changedBefore);
                expect(notices.slice(noticesBefore)).toEqual([]);
                expect(view.client.getQueryData(["drama", boundary === "project" ? "project-b" : "project-a", "jobs"])).toEqual(jobsBefore);
                expect(view.container.textContent).not.toContain("正在提取场景");
            } finally {
                await view.dispose();
            }
        }
    }
}, 15_000);
