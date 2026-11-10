import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { DramaAgentProposal } from "@/services/api/agent";
import type { DramaCast, DramaEpisodeDetail, DramaGuideStep, DramaSettings, DramaSummary } from "@/services/api/drama";
import type { AgentDramaContext } from "@/stores/use-global-agent-store";

const browser = new Window({ url: "http://localhost/projects/project/guide" });
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { environmentManager } = await import("@tanstack/query-core");
environmentManager.setIsServer(() => false);

const videoChoice = { channelId: "video", modelKey: "video" };
const originalSettings = { language: "中文", aspectRatio: "9:16", videoResolution: "720p", styleName: "写实", stylePrompt: "柔和照明", episodeSeconds: 90, mediaMode: "manual", models: { video: videoChoice }, assets: {}, storyboard: {} } as DramaSettings;
let summary: DramaSummary;
let cast: DramaCast[];
let dramaContext: AgentDramaContext | null = null;
let renderSetupChoices: (() => void) | null = null;
let writes: Array<{ kind: string; expectedRevision: number; targetId?: string; input?: unknown }>;
let confirmations: Array<{ onOk: () => unknown }>;
let errors: string[];
let failWrite: boolean;
let failRefresh: boolean;
let readsFail: boolean;
let revisionDelta: number;
let nextStep: DramaGuideStep | undefined;
let routeProject = "project";
let guideConfirms: Array<{ projectId: string; input: { expectedStep: DramaGuideStep; expectedRevision: number; settings?: DramaSettings } }>;
let allowGuideConfirm: boolean;
let episodeRetries: Array<{ projectId: string; episodeId?: string }>;
let allowEpisodeRetry: boolean;
let episodeReads: string[];
let currentEpisodeDetail: DramaEpisodeDetail | undefined;
let unexpectedWrites: number;
let pendingRead: { promise: Promise<void>; resolve: () => void; snapshot: DramaSummary; started: boolean } | null = null;
const silent = () => {};
const forbidden = async () => {
    unexpectedWrites++;
    throw new Error("建议接续不应触发生成或阶段确认");
};
const agentStore = {
    get drama() {
        return dramaContext;
    },
    setDrama(value: AgentDramaContext | null) {
        dramaContext = value;
        renderSetupChoices?.();
    },
};
mock.module("@/stores/use-global-agent-store", () => ({ useGlobalAgentStore: { getState: () => agentStore } }));
mock.module("antd", () => ({
    App: { useApp: () => ({ message: { info: silent, warning: silent, success: silent, error: (value: string) => errors.push(value) }, modal: { confirm: (options: (typeof confirmations)[number]) => confirmations.push(options) } }) },
    Button: ({ children, icon, loading: _loading, type: _type, size: _size, danger: _danger, ...props }: any) => (
        <button {...props}>
            {icon}
            {children}
        </button>
    ),
    Input: (props: any) => <input {...props} />,
}));
mock.module("react-router", () => ({ useParams: () => ({ projectId: routeProject }), useNavigate: () => silent, Link: ({ children }: any) => children, Navigate: () => null }));
mock.module("@/components/layout/workspace-page", () => ({ WorkspacePage: ({ children }: any) => <div>{children}</div> }));
mock.module("@/components/layout/workspace-state", () => ({ WorkspaceErrorState: () => <div>读取失败</div>, WorkspaceLoadingState: () => <div>读取中</div> }));
mock.module("@/components/ui/product/app-modal", () => ({ AppModal: () => null }));
mock.module("@/services/drama-canvas", () => ({ encodeDramaCanvasFocus: () => "", openDramaCanvasPath: async () => "" }));
mock.module("@/pages/projects/drama-shared", () => ({ CAST_KIND_LABEL: { character: "角色", scene: "场景", prop: "道具" }, SourceFormatPicker: () => null }));
mock.module("@/pages/projects/drama-model-picker", () => ({ useDramaModelCatalog: () => ({ data: { options: { video: [{ choice: videoChoice, videoResolutions: ["720p", "1080p"] }] } } }) }));
mock.module("@/pages/projects/guide-panels", () => ({
    GuideConfiguration: ({ settings, onChange, onSave, dirty, busy, stale, editable }: any) => (
        <section>
            <output aria-label="当前配置">{JSON.stringify(settings)}</output>
            <button disabled={!editable} onClick={() => onChange({ ...settings, language: "英语" })}>
                手动更改语言
            </button>
            <button disabled={!editable} onClick={() => onChange({ ...settings, videoResolution: "1080p" })}>
                改为1080P
            </button>
            <button disabled={!editable} onClick={() => onChange({ ...settings, models: { ...settings.models, video: { modelKey: "other" } } })}>
                修改高级模型
            </button>
            <button disabled={!editable} onClick={() => onChange(structuredClone(originalSettings))}>
                恢复原配置
            </button>
            {dirty ? (
                <button disabled={busy || stale} onClick={onSave}>
                    保存调整
                </button>
            ) : null}
        </section>
    ),
    GuideAssets: ({ cast: items }: { cast: DramaCast[] }) => <output aria-label="当前资产">{items.map((item) => item.name).join("、")}</output>,
    GuideStory: ({ episodeId, detail, details, onSelect, onRetryEpisode }: { episodeId: string; detail?: DramaEpisodeDetail; details: DramaEpisodeDetail[]; onSelect: (episodeId: string) => void; onRetryEpisode: (episodeId: string) => void }) => (
        <section>
            <output aria-label="当前分集">{episodeId}</output>
            <output aria-label="当前分集错误">{episodeId === "all" ? details.map((item) => item.episode.error).join("、") : detail?.episode.error}</output>
            <button onClick={() => onSelect("all")}>审阅全部集</button>
            <button onClick={() => onRetryEpisode("episode-9")}>重试第九集剧本</button>
        </section>
    ),
    GuideTextField: () => null,
}));

function write(kind: string, expectedRevision: number, input?: unknown, targetId?: string) {
    writes.push({ kind, expectedRevision, input: structuredClone(input), targetId });
    if (failWrite) throw new Error("模拟保存失败");
    if (expectedRevision !== summary.production.revision) throw new Error("CAS版本冲突");
    summary = { ...summary, production: { ...summary.production, revision: expectedRevision + revisionDelta, guideStep: nextStep || summary.production.guideStep } };
    readsFail = failRefresh;
}
const episodeDetail = () => ({
    episode: { id: "episode", number: 1, title: "第一集", stage: "done" },
    shots: [{ id: "shot-a" }, { id: "shot-b" }],
    segments: [
        { id: "segment-a", index: 1 },
        { id: "segment-b", index: 2 },
    ],
    jobs: [],
});
mock.module("@/services/api/drama", () => ({
    getDrama: async () => {
        if (pendingRead && !pendingRead.started) {
            const read = pendingRead;
            read.started = true;
            await read.promise;
            return structuredClone(read.snapshot);
        }
        if (readsFail) throw new Error("模拟刷新失败");
        return structuredClone(summary);
    },
    listDramaCast: async () => ({ cast: structuredClone(cast) }),
    getDramaEpisode: async (_projectId: string, episodeId: string) => {
        episodeReads.push(episodeId);
        return structuredClone(currentEpisodeDetail || episodeDetail());
    },
    updateDramaSettings: async (_project: string, input: { settings: DramaSettings; expectedRevision: number }) => {
        write("setup", input.expectedRevision, input.settings);
        summary.production.settings = structuredClone(input.settings);
        return structuredClone(summary);
    },
    saveDramaGuideSource: async (_project: string, input: { expectedRevision: number; chapters: unknown[] }) => {
        write("source", input.expectedRevision, input);
        summary.production.chapterCount = input.chapters.length;
        return structuredClone(summary);
    },
    createDramaCast: async (_project: string, input: Record<string, any>) => {
        write("cast_create", input.expectedRevision, input);
        const created = { ...input, id: `new-${writes.length}` } as DramaCast;
        cast.push(created);
        return { cast: structuredClone(created) };
    },
    updateDramaCast: async (_project: string, targetId: string, input: Record<string, any>) => {
        write("cast", input.expectedRevision, input, targetId);
        const target = cast.find((item) => item.id === targetId)!;
        Object.assign(target, input);
        return { cast: structuredClone(target) };
    },
    deleteDramaCast: async (_project: string, targetId: string, expectedRevision: number) => {
        write("cast_delete", expectedRevision, undefined, targetId);
        cast = cast.filter((item) => item.id !== targetId);
        return { deleted: true, castId: targetId };
    },
    updateDramaShot: async (_project: string, targetId: string, input: Record<string, any>) => {
        write("shot", input.expectedRevision, input, targetId);
        return { shot: { id: targetId, ...input } };
    },
    updateDramaSegment: async (_project: string, _episode: string, index: number, prompt: string, expectedRevision: number) => {
        write("segment_prompt", expectedRevision, prompt, `segment-${index}`);
        return { saved: true };
    },
    confirmDramaGuide: async (projectId: string, input: { expectedStep: DramaGuideStep; expectedRevision: number; settings?: DramaSettings }) => {
        guideConfirms.push({ projectId, input: structuredClone(input) });
        if (!allowGuideConfirm) return forbidden();
        if (failWrite) throw new Error("模拟阶段确认失败");
        if (input.expectedStep !== summary.production.guideStep || input.expectedRevision !== summary.production.revision) throw new Error("阶段CAS冲突");
        const next = input.expectedStep === "configuring" ? "assets" : input.expectedStep === "assets" ? "story" : "completed";
        summary = { ...summary, production: { ...summary.production, guideStep: next, revision: input.expectedRevision + 1 }, guide: { step: next, canConfirm: false } };
        return structuredClone(summary);
    },
    regenerateDramaCast: forbidden,
    rescriptDramaEpisode: forbidden,
    retryFailedDrama: async (projectId: string, episodeId?: string) => {
        if (!allowEpisodeRetry) return forbidden();
        episodeRetries.push({ projectId, episodeId });
        return { jobs: 1 };
    },
    writeDramaSegmentPrompts: forbidden,
}));

const { dramaKeys } = await import("@/pages/projects/studio/use-studio");
const { default: DramaGuidePage } = await import("@/pages/projects/guide");
const settle = async () => {
    for (let index = 0; index < 6; index++) await Bun.sleep(10);
};
const findButton = (scope: HTMLElement, label: string) => Array.from(scope.querySelectorAll("button")).find((item) => item.textContent?.trim() === label || item.querySelector("strong")?.textContent?.trim() === label);
afterAll(() => browser.happyDOM.abort());
function proposal(kind: DramaAgentProposal["kind"], call: string, changes: Record<string, unknown>, targetId?: string, overrides: Partial<DramaAgentProposal> = {}): DramaAgentProposal {
    return { kind, toolCallId: call, runId: "run", baseRevision: 7, changes, targetId, ...overrides };
}
const source = (call = "source") => proposal("source", call, { chapters: [{ title: "第一章", text: "雨夜的小青回到了旧车站。" }], sourceFormat: "novel" });
const recommendedConfiguration = { aspectRatio: "9:16", videoResolution: "720p", language: "粤语", episodeSeconds: 90 };
const setup = (call = "setup", changes: Record<string, unknown> = recommendedConfiguration) => proposal("setup", call, changes);

async function withGuide(
    step: DramaGuideStep,
    check: (ui: {
        receive: (...items: DramaAgentProposal[]) => Promise<void>;
        apply: (call: string, label?: string) => Promise<void>;
        disabled: (call: string) => boolean;
        click: (label: string) => Promise<void>;
        refresh: () => Promise<void>;
        switchProject: () => Promise<void>;
        startSlowRead: () => Promise<() => Promise<void>>;
        container: HTMLElement;
        chatHost: HTMLDivElement;
    }) => Promise<void>,
    stageLabels?: { confirm: string; adjust: string },
) {
    routeProject = "project";
    pendingRead = null;
    summary = {
        project: { id: "project", name: "同轮建议测试" },
        production: { guideStep: step, revision: 7, status: "draft", stage: "bible", settings: structuredClone(originalSettings), chapterCount: 1 },
        episodes: step === "story" ? [{ id: "episode", number: 1, title: "第一集", stage: "done" }] : [],
        jobCounts: {},
        inbox: [],
        castCount: 2,
        guide: { step, canConfirm: false },
    } as DramaSummary;
    cast = [
        { id: "cast-a", kind: "character", name: "小青", imageStatus: "", locked: false },
        { id: "cast-b", kind: "scene", name: "旧车站", imageStatus: "", locked: false },
    ] as DramaCast[];
    writes = [];
    guideConfirms = [];
    allowGuideConfirm = false;
    episodeRetries = [];
    allowEpisodeRetry = false;
    episodeReads = [];
    currentEpisodeDetail = undefined;
    unexpectedWrites = 0;
    confirmations = [];
    errors = [];
    failWrite = false;
    failRefresh = false;
    readsFail = false;
    revisionDelta = 1;
    nextStep = undefined;
    dramaContext = null;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    client.setQueryData(dramaKeys.summary("project"), structuredClone(summary));
    client.setQueryData(dramaKeys.cast("project"), { cast: structuredClone(cast) });
    const container = document.createElement("div");
    const chatHost = document.createElement("div");
    chatHost.setAttribute("aria-label", "创作对话操作");
    const choicesHost = document.createElement("div");
    const actionsHost = document.createElement("div");
    chatHost.append(choicesHost, actionsHost);
    document.body.append(container);
    const root = createRoot(container);
    const choicesRoot = createRoot(choicesHost);
    renderSetupChoices = () => {
        const choices = dramaContext?.setupChoices;
        const proposals = dramaContext?.proposalChoices;
        const stage = dramaContext?.stageChoices;
        choicesRoot.render(
            <>
                {choices ? choices.render(choices.proposals) : null}
                {proposals ? proposals.render(proposals.proposals) : null}
                {stage?.render(stageLabels) || null}
            </>,
        );
    };
    const cards = new Map<string, HTMLElement>();
    const button = (scope: HTMLElement, label: string) => {
        const found = findButton(scope, label);
        expect(found, `未找到按钮：${label}`).toBeDefined();
        return found!;
    };
    const click = async (target: HTMLButtonElement) => {
        await act(async () => {
            target.click();
            await settle();
        });
    };
    try {
        await act(async () => {
            root.render(
                <QueryClientProvider client={client}>
                    <DramaGuidePage />
                </QueryClientProvider>,
            );
            await settle();
        });
        await act(settle);
        expect(dramaContext?.onActionsHost).toBeFunction();
        container.querySelector(".drama-guide-agent-host")!.append(chatHost);
        await act(async () => {
            dramaContext!.onActionsHost!(actionsHost);
            await settle();
        });
        await check({
            container,
            chatHost,
            receive: async (...items) => {
                for (const item of items) {
                    const previous = new Set(chatHost.querySelectorAll<HTMLElement>(".drama-guide-proposal, .drama-guide-setup-choice"));
                    await act(async () => {
                        dramaContext!.onProposal!(item);
                        await settle();
                    });
                    expect(actionsHost.querySelector(".drama-guide-setup-choice")).toBeNull();
                    const card = Array.from(chatHost.querySelectorAll<HTMLElement>(".drama-guide-proposal, .drama-guide-setup-choice")).find((entry) => !previous.has(entry));
                    if (!card) {
                        // 同轮完整配置始终只有一份推荐；后续备选不再增加单独的配置按钮。
                        expect(item.kind).toBe("setup");
                        expect(findButton(chatHost, "采用推荐配置")).toBeDefined();
                    }
                    expect(container.querySelector('[aria-label="创作产物"] .drama-guide-proposal')).toBeNull();
                    cards.set(item.toolCallId, card || document.createElement("div"));
                }
            },
            apply: (call, label) =>
                click(
                    cards.get(call)!.matches("button.drama-guide-setup-choice")
                        ? (cards.get(call)! as HTMLButtonElement)
                        : label
                          ? button(cards.get(call)!, label)
                          : Array.from(cards.get(call)!.querySelectorAll<HTMLButtonElement>("button")).find((item) => !item.disabled && !item.getAttribute("aria-label"))!,
                ),
            disabled: (call) =>
                !chatHost.contains(cards.get(call)!) ||
                (cards.get(call)!.matches("button.drama-guide-setup-choice")
                    ? (cards.get(call)! as HTMLButtonElement).disabled
                    : Array.from(cards.get(call)!.querySelectorAll("button"))
                          .filter((item) => ["采用这份正文", "保存资产设定", "保存分镜修改", "保存段提示词", "新增此资产", "删除此资产"].includes(item.textContent?.trim() || ""))
                          .every((item) => item.disabled)),
            click: (label) => click(button(findButton(chatHost, label) ? chatHost : container, label)),
            refresh: async () => {
                await act(async () => {
                    await client.invalidateQueries({ queryKey: dramaKeys.summary("project"), exact: true });
                    await settle();
                });
            },
            switchProject: async () => {
                await act(async () => {
                    routeProject = "other-project";
                    summary = { ...summary, project: { ...summary.project, id: routeProject } };
                    client.setQueryData(dramaKeys.summary(routeProject), structuredClone(summary));
                    client.setQueryData(dramaKeys.cast(routeProject), { cast: structuredClone(cast) });
                    root.render(
                        <QueryClientProvider client={client}>
                            <DramaGuidePage />
                        </QueryClientProvider>,
                    );
                    await settle();
                });
                await act(settle);
                expect(dramaContext?.projectId).toBe(routeProject);
                await act(async () => {
                    dramaContext!.onActionsHost!(actionsHost);
                    await settle();
                });
            },
            startSlowRead: async () => {
                let resolveRead!: () => void;
                const promise = new Promise<void>((resolve) => {
                    resolveRead = resolve;
                });
                pendingRead = { promise, resolve: resolveRead, snapshot: structuredClone(summary), started: false };
                await act(async () => {
                    void client.refetchQueries({ queryKey: dramaKeys.summary("project"), exact: true }, { cancelRefetch: false });
                    await settle();
                });
                expect(pendingRead.started).toBe(true);
                return async () => {
                    await act(async () => {
                        resolveRead();
                        await settle();
                    });
                };
            },
        });
    } finally {
        pendingRead?.resolve();
        renderSetupChoices = null;
        await act(async () => {
            root.unmount();
            choicesRoot.unmount();
        });
        client.clear();
        container.remove();
    }
}

test("正文与配置双向连续应用，第三条晚到同轮建议也使用最新CAS", async () => {
    for (const sourceFirst of [true, false])
        await withGuide("configuring", async ({ receive, apply, disabled, container }) => {
            const first = sourceFirst ? source() : setup();
            const second = sourceFirst ? setup() : source();
            await receive(first, second);
            await apply(first.toolCallId);
            expect(disabled(second.toolCallId)).toBe(false);
            await apply(second.toolCallId);
            await receive(setup("late", { styleName: "国风动画", stylePrompt: "水墨线条" }));
            expect(disabled("late")).toBe(false);
            await apply("late");
            expect(writes.map((item) => item.expectedRevision)).toEqual([7, 8, 9]);
            expect(summary.production.settings.language).toBe("粤语");
            expect(summary.production.settings.styleName).toBe("国风动画");
            expect(container.querySelectorAll(".drama-guide-proposal")).toHaveLength(0);
            expect(first.baseRevision).toBe(7);
            expect(second.baseRevision).toBe(7);
            expect(errors).toEqual([]);
        });
});

test("独立资产与创建可连续，同资产和同名创建及改名撞名被阻断", async () => {
    await withGuide("assets", async ({ receive, apply, disabled }) => {
        await receive(proposal("cast", "edit-a", { appearance: "红衣" }, "cast-a"), proposal("cast", "conflict-a", { description: "另一设定" }, "cast-a"), proposal("cast", "edit-b", { description: "雨夜站台" }, "cast-b"));
        await apply("edit-a");
        expect(disabled("conflict-a")).toBe(true);
        expect(disabled("edit-b")).toBe(false);
        await apply("edit-b");
        await receive(proposal("cast_create", "create-a", { kind: "character", name: " 小红 " }), proposal("cast_create", "duplicate", { kind: "character", name: "小红" }), proposal("cast_create", "create-b", { kind: "scene", name: "街口" }));
        await apply("create-a", "新增此资产");
        expect(disabled("duplicate")).toBe(true);
        await apply("create-b", "新增此资产");
        await receive(proposal("cast", "rename", { name: "小红" }, "cast-a"));
        expect(disabled("rename")).toBe(true);
        expect(writes.map((item) => item.expectedRevision)).toEqual([7, 8, 9, 10]);
        expect(errors).toEqual([]);
    });
});

test("风格互斥、整套配置互斥、重复正文与其他run或原始版本不接续", async () => {
    await withGuide("configuring", async ({ receive, apply, disabled }) => {
        await receive(setup("first", { styleName: "电影" }), setup("style", { stylePrompt: "高反差" }), setup("configuration"), setup("alternative-configuration", { ...recommendedConfiguration, language: "英语" }));
        // 其他run必须真的来自另一轮，且不能由本轮记录抬升。
        await receive(proposal("setup", "another-run", { ...recommendedConfiguration, language: "英语" }, undefined, { runId: "other" }), proposal("setup", "old-base", { ...recommendedConfiguration, language: "英语" }, undefined, { baseRevision: 6 }));
        await apply("first");
        expect(disabled("style")).toBe(true);
        expect(disabled("configuration")).toBe(false);
        await apply("configuration");
        expect(disabled("alternative-configuration")).toBe(true);
        expect(disabled("another-run")).toBe(true);
        expect(disabled("old-base")).toBe(true);
        await receive(source(), source("duplicate-source"));
        await apply("source");
        expect(disabled("duplicate-source")).toBe(true);
        expect(writes.map((item) => item.expectedRevision)).toEqual([7, 8, 9]);
        await receive(proposal("setup", "new-base", { ...recommendedConfiguration, language: "日语" }, undefined, { baseRevision: 10 }), proposal("setup", "new-base-style", { stylePrompt: "水墨" }, undefined, { baseRevision: 10 }));
        await apply("new-base");
        expect(disabled("alternative-configuration")).toBe(true);
        expect(disabled("new-base-style")).toBe(false);
        await apply("new-base-style");
        expect(writes.map((item) => item.expectedRevision)).toEqual([7, 8, 9, 10, 11]);
    });
});

test("外部更新、写后跳版或阶段回退均不抬升剩余建议", async () => {
    await withGuide("configuring", async ({ receive, apply, disabled, startSlowRead }) => {
        await receive(source(), setup());
        const releaseRead = await startSlowRead();
        await apply("source");
        expect(disabled("setup")).toBe(false);
        await releaseRead();
        expect(disabled("setup")).toBe(false);
        await apply("setup");
        expect(writes.map((item) => item.expectedRevision)).toEqual([7, 8]);
    });
    await withGuide("configuring", async ({ receive, disabled, refresh }) => {
        await receive(source(), setup());
        summary.production.revision = 8;
        await refresh();
        expect(disabled("source")).toBe(true);
        expect(disabled("setup")).toBe(true);
        expect(writes).toEqual([]);
    });
    await withGuide("configuring", async ({ receive, apply, disabled }) => {
        await receive(source(), setup());
        revisionDelta = 2;
        await apply("source");
        expect(disabled("setup")).toBe(true);
        expect(writes).toHaveLength(1);
    });
    await withGuide("story", async ({ receive, apply, disabled, refresh }) => {
        await receive(proposal("cast", "edit-a", { appearance: "红衣" }, "cast-a"), proposal("cast", "edit-b", { description: "站台" }, "cast-b"));
        nextStep = "assets";
        await apply("edit-a");
        expect(disabled("edit-b")).toBe(true);
        summary.production.guideStep = "story";
        await refresh();
        expect(disabled("edit-b")).toBe(true);
    });
});

test("保存失败不伪造接续；成功写入但强刷新失败保留阻断记录", async () => {
    await withGuide("configuring", async ({ receive, apply, disabled }) => {
        await receive(source(), setup());
        failWrite = true;
        await apply("source");
        expect(summary.production.revision).toBe(7);
        expect(disabled("setup")).toBe(false);
        expect(errors).toContain("模拟保存失败");
    });
    await withGuide("configuring", async ({ receive, apply, disabled }) => {
        await receive(setup(), source());
        failWrite = true;
        await apply("setup");
        expect(summary.production.revision).toBe(7);
        expect(disabled("setup")).toBe(false);
        expect(dramaContext?.prefillRequest).toBeNull();
        expect(errors).toContain("模拟保存失败");
    });
    await withGuide("configuring", async ({ receive, apply, disabled, refresh }) => {
        await receive(source(), setup());
        failRefresh = true;
        await apply("source");
        expect(summary.production.revision).toBe(8);
        expect(disabled("setup")).toBe(true);
        expect(errors).toContain("模拟刷新失败");
        readsFail = false;
        await refresh();
        expect(disabled("setup")).toBe(true);
    });
    await withGuide("configuring", async ({ receive, apply, disabled, refresh }) => {
        await receive(setup(), source());
        failRefresh = true;
        await apply("setup");
        expect(summary.production.revision).toBe(8);
        expect(dramaContext?.prefillRequest).toBeNull();
        expect(disabled("source")).toBe(true);
        readsFail = false;
        await refresh();
        expect(disabled("setup")).toBe(true);
        expect(dramaContext?.prefillRequest).toBeNull();
    });
});

test("点选只保存当前配置，手动或高级草稿保留且保存后仍执行版本保护", async () => {
    await withGuide("configuring", async ({ receive, apply, disabled, click }) => {
        await click("改为1080P");
        await receive(setup(), source(), setup("language", { ...recommendedConfiguration, language: "日语" }));
        await apply("setup");
        expect(summary.production.settings.videoResolution).toBe("720p");
        expect(summary.production.settings.language).toBe("粤语");
        expect(disabled("source")).toBe(false);
        expect(disabled("language")).toBe(true);
        await apply("source");
        expect(writes.map((item) => item.expectedRevision)).toEqual([7, 8]);
    });
    await withGuide("configuring", async ({ receive, disabled, click }) => {
        await receive(source());
        await click("手动更改语言");
        await click("保存调整");
        expect(disabled("source")).toBe(true);
        expect(writes).toHaveLength(1);
    });
    await withGuide("configuring", async ({ receive, apply, disabled, click, container }) => {
        await receive(setup(), source());
        await click("修改高级模型");
        await apply("setup");
        expect(summary.production.settings.models).toEqual(originalSettings.models);
        expect(JSON.parse(container.querySelector('[aria-label="当前配置"]')!.textContent!).models.video.modelKey).toBe("other");
        await click("保存调整");
        expect(disabled("source")).toBe(true);
        expect(writes.map((item) => item.expectedRevision)).toEqual([7, 8]);
    });
});

test("独立镜头或段提示词连续可用，混合种类和同目标仍冲突", async () => {
    for (const kind of ["shot", "segment_prompt"] as const)
        await withGuide("story", async ({ receive, apply, disabled }) => {
            const prefix = kind === "shot" ? "shot" : "segment";
            const changes = kind === "shot" ? { dialogue: "你好" } : { videoPromptOverride: "雨夜远景" };
            await receive(
                proposal(kind, "a", changes, `${prefix}-a`),
                proposal(kind, "b", changes, `${prefix}-b`),
                proposal(kind, "same", changes, `${prefix}-a`),
                proposal(kind === "shot" ? "segment_prompt" : "shot", "mixed", kind === "shot" ? { videoPromptOverride: "提示词" } : { dialogue: "你好" }, kind === "shot" ? "segment-a" : "shot-a"),
            );
            await apply("a");
            expect(disabled("same")).toBe(true);
            expect(disabled("mixed")).toBe(true);
            expect(disabled("b")).toBe(false);
            await apply("b");
            expect(writes.map((item) => item.expectedRevision)).toEqual([7, 8]);
            expect(errors).toEqual([]);
        });
});

test("删除确认框跨外部版本变化后仍拒绝写入", async () => {
    await withGuide("assets", async ({ receive, apply, refresh }) => {
        await receive(proposal("cast_delete", "delete", { reason: "多余" }, "cast-a"));
        await apply("delete", "删除此资产");
        expect(confirmations).toHaveLength(1);
        summary.production.revision = 8;
        await refresh();
        await act(async () => {
            await confirmations[0].onOk();
            await settle();
        });
        expect(writes).toEqual([]);
        expect(errors.join(" ")).toMatch(/过期|更新/);
    });
    await withGuide("assets", async ({ receive, apply, switchProject }) => {
        await receive(proposal("cast_delete", "delete", { reason: "多余" }, "cast-a"));
        await apply("delete", "删除此资产");
        await switchProject();
        await act(async () => {
            await confirmations[0].onOk();
            await settle();
        });
        expect(writes).toEqual([]);
        expect(errors.join(" ")).toMatch(/过期|更新/);
    });
});

test("聊天内单击保存建议，再明确确认才推进原阶段；失败保留当前阶段且不生成媒体", async () => {
    await withGuide("configuring", async ({ receive, apply, refresh, click, chatHost, container }) => {
        await receive(setup());
        expect(writes).toEqual([]);
        expect(guideConfirms).toEqual([]);
        await apply("setup");
        expect(writes.map((item) => item.kind)).toEqual(["setup"]);
        expect(dramaContext?.prefillRequest?.autoSubmit).toBe(true);
        expect(dramaContext?.prefillRequest?.requireIdle).toBe(true);
        expect(dramaContext?.prefillRequest?.text).toContain("当前制作版本：8");
        expect(summary.production.settings.language).toBe("粤语");
        expect(guideConfirms).toEqual([]);
        expect(summary.production.guideStep).toBe("configuring");
        expect(Array.from(chatHost.querySelectorAll('[role="status"]')).some((item) => item.textContent?.includes("已保存本次选择"))).toBe(true);
        allowGuideConfirm = true;
        summary.guide!.canConfirm = true;
        await refresh();
        const confirm = findButton(chatHost, "确认配置，开始提取资产");
        expect(confirm).toBeDefined();
        expect(confirm?.disabled).toBe(false);
        expect(container.querySelector('[aria-label="创作产物"]')?.textContent).not.toContain("确认配置，开始提取资产");
        await click("确认配置，开始提取资产");
        expect(guideConfirms).toEqual([{ projectId: "project", input: { expectedStep: "configuring", expectedRevision: 8, settings: { ...originalSettings, language: "粤语", mediaMode: "manual" } } }]);
        expect(summary.production.guideStep).toBe("assets");
        expect(dramaContext?.prefillRequest).toBeNull();
        expect(chatHost.textContent).toContain("确认资产，开始改编剧本与分镜");
        expect(unexpectedWrites).toBe(0);
        expect(errors).toEqual([]);
    });
    await withGuide("configuring", async ({ refresh, click, chatHost }) => {
        allowGuideConfirm = true;
        summary.guide!.canConfirm = true;
        await refresh();
        failWrite = true;
        await click("确认配置，开始提取资产");
        expect(guideConfirms).toHaveLength(1);
        expect(summary.production.guideStep).toBe("configuring");
        expect(summary.production.revision).toBe(7);
        expect(chatHost.textContent).toContain("确认配置，开始提取资产");
        expect(errors).toContain("模拟阶段确认失败");
        expect(writes).toEqual([]);
        expect(unexpectedWrites).toBe(0);
    });
});

test("剧本与分镜阶段在对话内提供确认选项，确认后进入制作台", async () => {
    await withGuide("story", async ({ refresh, click, chatHost, container }) => {
        allowGuideConfirm = true;
        summary.guide!.canConfirm = true;
        await refresh();

        const confirm = findButton(chatHost, "确认剧本与分镜，进入制作台");
        expect(confirm).toBeDefined();
        expect(confirm?.disabled).toBe(false);
        expect(findButton(chatHost, "继续调整")).toBeDefined();
        expect(container.querySelector('[aria-label="创作产物"]')?.textContent).not.toMatch(/确认剧本与分镜.*进入制作台|确认并进入制作台/);

        await click("确认剧本与分镜，进入制作台");
        expect(guideConfirms).toEqual([{ projectId: "project", input: { expectedStep: "story", expectedRevision: 7 } }]);
        expect(summary.production.guideStep).toBe("completed");
        expect(unexpectedWrites).toBe(0);
        expect(errors).toEqual([]);
    });
});

test("刷新失败时阶段确认选项保持禁用", async () => {
    await withGuide("configuring", async ({ refresh, chatHost }) => {
        summary.guide!.canConfirm = true;
        readsFail = true;
        await refresh();

        const confirm = findButton(chatHost, "确认配置，开始提取资产");
        expect(confirm).toBeDefined();
        expect(confirm?.disabled).toBe(true);
        expect(guideConfirms).toEqual([]);
    });
});

test("引导页重试只绑定卡片目标集，不使用当前选择集或全项目重试", async () => {
    await withGuide("story", async ({ refresh, click, container }) => {
        allowEpisodeRetry = true;
        summary.episodes.push({ id: "episode-9", number: 9, title: "第九集", stage: "script", error: "分镜脚本解析失败：模型没有返回可解析的 JSON" } as DramaSummary["episodes"][number]);
        await refresh();
        expect(container.querySelector('[aria-label="当前分集"]')?.textContent).toBe("episode");

        await click("重试第九集剧本");

        expect(episodeRetries).toEqual([{ projectId: "project", episodeId: "episode-9" }]);
        expect(guideConfirms).toEqual([]);
        expect(confirmations).toEqual([]);
        expect(unexpectedWrites).toBe(0);
        expect(errors).toEqual([]);
    });
});

test("最后文字任务结束后，单集和全部集详情都刷新失败终态", async () => {
    for (const all of [false, true]) {
        await withGuide("story", async ({ refresh, click, container }) => {
            if (all) await click("审阅全部集");
            summary = { ...summary, jobCounts: { running: 1 } };
            await refresh();
            const before = episodeReads.length;
            const error = "分镜脚本解析失败：模型没有返回可解析的 JSON";
            currentEpisodeDetail = { ...episodeDetail(), episode: { ...episodeDetail().episode, stage: "script", error } } as DramaEpisodeDetail;
            summary = { ...summary, jobCounts: {}, episodes: [{ ...summary.episodes[0], stage: "script", error }] };

            await refresh();

            expect(episodeReads.length).toBeGreaterThan(before);
            expect(container.querySelector('[aria-label="当前分集错误"]')?.textContent).toBe(error);
            expect(errors).toEqual([]);
        });
    }
});

test("两次摘要读取间已结束的短任务也刷新详情，未变化摘要不重复刷新", async () => {
    await withGuide("story", async ({ refresh, container }) => {
        const before = episodeReads.length;
        const error = "分镜脚本解析失败：分镜脚本没有可用镜头";
        currentEpisodeDetail = { ...episodeDetail(), episode: { ...episodeDetail().episode, stage: "script", error } } as DramaEpisodeDetail;
        summary = { ...summary, episodes: [{ ...summary.episodes[0], stage: "script", error }] };

        await refresh();

        expect(episodeReads.length).toBeGreaterThan(before);
        expect(container.querySelector('[aria-label="当前分集错误"]')?.textContent).toBe(error);
        const settledReads = episodeReads.length;
        await refresh();
        expect(episodeReads).toHaveLength(settledReads);
        expect(errors).toEqual([]);
    });
});

test("新一轮推荐保存后旧候选仍保留但不再阻塞阶段确认", async () => {
    await withGuide("configuring", async ({ receive, apply, disabled, refresh, click }) => {
        allowGuideConfirm = true;
        summary.guide!.canConfirm = true;
        await refresh();
        await receive(setup("original-recommendation"));
        const revised = proposal("setup", "revised-recommendation", { ...recommendedConfiguration, aspectRatio: "16:9", episodeSeconds: 120 }, undefined, { runId: "revised-run" });
        await receive(revised);
        expect(disabled("revised-recommendation")).toBe(false);
        expect(dramaContext?.stageChoices?.pending).toBe(true);

        await apply("revised-recommendation");
        expect(summary.production.revision).toBe(8);
        expect(summary.production.settings.aspectRatio).toBe("16:9");
        expect(summary.production.settings.episodeSeconds).toBe(120);
        expect(dramaContext?.setupChoices?.proposals.some((item) => item.toolCallId === "original-recommendation")).toBe(true);
        expect(disabled("original-recommendation")).toBe(true);
        expect(dramaContext?.stageChoices?.pending).toBe(false);

        await click("确认配置，开始提取资产");
        expect(guideConfirms).toHaveLength(1);
        expect(guideConfirms[0].input.expectedRevision).toBe(8);
        expect(guideConfirms[0].input.expectedStep).toBe("configuring");
        expect(summary.production.guideStep).toBe("assets");
        expect(unexpectedWrites).toBe(0);
        expect(errors).toEqual([]);
    });
});

test("资产阶段不会沿用上一阶段确认文案，仍调用当前资产确认流程", async () => {
    await withGuide(
        "assets",
        async ({ refresh, click, chatHost }) => {
            allowGuideConfirm = true;
            summary.guide!.canConfirm = true;
            await refresh();
            expect(findButton(chatHost, "确认配置，开始提取资产")).toBeUndefined();
            expect(findButton(chatHost, "确认资产，开始改编剧本与分镜")?.disabled).toBe(false);
            expect(findButton(chatHost, "继续调整")).toBeDefined();

            await click("确认资产，开始改编剧本与分镜");
            expect(guideConfirms).toEqual([{ projectId: "project", input: { expectedStep: "assets", expectedRevision: 7 } }]);
            expect(summary.production.guideStep).toBe("story");
            expect(unexpectedWrites).toBe(0);
            expect(errors).toEqual([]);
        },
        { confirm: "确认配置，开始提取资产", adjust: "继续调整" },
    );
});
