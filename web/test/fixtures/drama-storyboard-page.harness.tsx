import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaEpisodeDetail, DramaGenerationConfigurationPatch, DramaModelChoice, DramaModelOption, DramaSettings, DramaShot, DramaSummary } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/projects/p?step=story" });
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const userStore = create(() => ({ user: { id: "user" } }));
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
mock.module("@/stores/use-user-store", () => ({ useUserStore: userStore }));
mock.module("antd", () => ({
    App: { useApp: () => ({ message: { error: () => undefined } }) },
    Button: ({ children, loading: _loading, type: _type, size: _size, icon: _icon, ...props }: Record<string, unknown>) => createElement("button", props, children as ReactNode),
    Select: ({ options, onChange, ...props }: { options: { value: string; label: string }[]; onChange: (value: string) => void }) =>
        createElement(
            "select",
            { ...props, onChange: (event: { target: { value: string } }) => onChange(event.target.value) },
            options.map((option) => createElement("option", { key: option.value, value: option.value }, option.label)),
        ),
    InputNumber: ({ onChange, ...props }: { onChange: (value: number) => void }) => createElement("input", { ...props, type: "number", onInput: (event: { target: { value: string } }) => onChange(Number(event.target.value)) }),
}));
mock.module("@/components/ui/product/app-modal", () => ({
    AppModal: ({ title, children }: { title: string; children: ReactNode }) => (
        <section role="dialog" aria-label={title}>
            {children}
        </section>
    ),
}));
mock.module("@/pages/projects/workflow-scene-splits", () => ({
    WorkflowSceneSplits: ({ initialSegmentIndex, buttonLabel }: { initialSegmentIndex: number; buttonLabel: string }) => <button data-split-segment={initialSegmentIndex}>{buttonLabel}</button>,
}));
mock.module("@/pages/projects/workflow-batch", () => ({
    WorkflowBatch: ({ triggerLabel, targetIds, scopeDescription }: { triggerLabel: string; targetIds: string[]; scopeDescription: string }) => (
        <button data-batch-targets={targetIds.join(",")} title={scopeDescription}>
            {triggerLabel}
        </button>
    ),
}));
mock.module("@/pages/projects/workflow-storyboard-dialog", () => ({
    WorkflowStoryboardDialog: ({ open, title, shots }: { open: boolean; title: string; shots: DramaShot[] }) => (open ? <section role="dialog" aria-label={title} data-board-shots={shots.map((shot) => shot.id).join(",")} /> : null),
}));
mock.module("@/pages/projects/drama-shared", () => ({
    CAST_KIND_LABEL: { character: "角色", scene: "场景", prop: "道具" },
    aspectRatioValue: (ratio: string) => ratio.replace(":", "/"),
    MediaThumb: ({ resourceId }: { resourceId: string }) => <img data-resource={resourceId} />,
    mediaBusy: (status: string) => status === "queued" || status === "running",
    useResourceMediaUrl: (resourceId?: string) => (resourceId ? `/resources/${resourceId}` : ""),
}));
mock.module("@/components/ui/base/tooltip/ant-tooltip", () => ({ AntTooltip: ({ children }: { children: ReactNode }) => children }));
let catalogVideoOptions: DramaModelOption[] = [];
mock.module("@/pages/projects/drama-model-picker", () => ({
    useDramaModelCatalog: () => ({ data: { options: { image: [], video: catalogVideoOptions } } }),
    DramaModelPicker: ({ capability, value, onChange }: { capability: string; value: DramaModelChoice; onChange: (value: DramaModelChoice) => void }) =>
        capability === "video" && catalogVideoOptions.length ? (
            <select
                aria-label="选择分镜视频模型"
                value={value.logicalModelId}
                onChange={(event) => {
                    const next = catalogVideoOptions.find((option) => option.choice.logicalModelId === event.target.value);
                    if (next) onChange(next.choice);
                }}
            >
                {catalogVideoOptions.map((option) => (
                    <option key={option.choice.logicalModelId} value={option.choice.logicalModelId}>
                        {option.label}
                    </option>
                ))}
            </select>
        ) : (
            <button aria-label={`选择分镜${capability === "image" ? "图片" : "视频"}模型`} onClick={() => onChange({ modelKey: `${capability}-new` })}>
                模型选择
            </button>
        ),
}));
const inserted: string[] = [];
const generationWrites: Array<{ expectedRevision?: number; generation?: DramaGenerationConfigurationPatch }> = [];
let generationFailure = false;
let generationHold: Promise<void> | undefined;
let generationBase: DramaSummary | undefined;
mock.module("@/services/api/drama", () => ({
    insertDramaShot: async (_projectId: string, shotId: string) => {
        inserted.push(shotId);
        return { shot: { ...shots[0], id: "inserted", position: 3 } };
    },
    updateDramaSettings: async (_projectId: string, input: { expectedRevision?: number; generation?: DramaGenerationConfigurationPatch }) => {
        generationWrites.push(structuredClone(input));
        await generationHold;
        if (generationFailure) throw new Error("生成配置写入失败");
        const current = generationBase || summary;
        const { models, ...patch } = input.generation!;
        const saved = {
            ...current,
            production: {
                ...current.production,
                revision: input.expectedRevision! + 1,
                settings: { ...current.production.settings, ...patch, videoResolution: patch.videoResolution || undefined, models: { ...current.production.settings.models, ...models } },
            },
        };
        generationBase = saved;
        return saved;
    },
}));
const mediaStates = new Map<string, { status: string; resourceId?: string }>();
mock.module("@/services/api/drama-shot-media", () => ({ getDramaShotMedia: async (_projectId: string, shotId: string, kind: string) => ({ id: "", status: "idle", shotId, kind, takes: [], ...mediaStates.get(`${shotId}:${kind}`) }) }));
const { WorkflowStoryboardPage } = await import("@/pages/projects/workflow-storyboard-page");
const { WorkflowModeDialog } = await import("@/pages/projects/workflow-mode-dialog");
afterAll(() => browser.happyDOM.abort());

const settings = {
    aspectRatio: "16:9",
    videoResolution: "720p",
    models: { text: {}, image: { modelKey: "image" }, video: { modelKey: "video" } },
    storyboard: { generationMode: "reference_video", directorTemplate: "", targetShotCount: 0, segmentMode: "auto", segmentSeconds: 8 },
    assets: {},
} as DramaSettings;
const summary = { project: { id: "p" }, production: { revision: 2, settings } } as DramaSummary;
const shots = [
    { id: "s1", projectId: "p", episodeId: "e", position: 0, scene: "小区边缘 日 外", segmentIndex: 0, durationMs: 3000, action: "主角推门", dialogue: "别走", camera: "推镜头", shotSize: "近景" },
    { id: "s2", projectId: "p", episodeId: "e", position: 1, scene: "秦家卧室 夜 内", segmentIndex: 0, durationMs: 2000, action: "人物回头" },
    { id: "s3", projectId: "p", episodeId: "e", position: 2, scene: "秦家卧室 夜 内", segmentIndex: 1, durationMs: 4000, action: "主角打开灯" },
] as DramaShot[];
const detail = {
    episode: { id: "e", number: 1 },
    shots,
    segments: [
        { id: "segment1", index: 0, title: "推门与回头", durationMs: 5000, shotIds: ["s1", "s2"], promptStatus: "ready", videoStatus: "idle", videoPrompt: "完整段提示词", generated: "", request: { references: [] } },
        { id: "segment2", index: 1, title: "打开灯", durationMs: 4000, shotIds: ["s3"], promptStatus: "ready", videoStatus: "idle", videoPrompt: "后续段提示词", generated: "", request: { references: [] } },
    ],
} as DramaEpisodeDetail;
const segmentActions = { onOpenSegment: () => undefined, onGenerateSegment: () => undefined, onWriteSegmentPrompt: () => undefined, selectedSegmentIds: new Set<string>(), onSelectSegments: () => undefined };
async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 0));
}
async function mount(content: ReactNode) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root.render(<QueryClientProvider client={client}>{content}</QueryClientProvider>);
        await settle();
    });
    await act(settle);
    return {
        host,
        client,
        render: async (content: ReactNode) => {
            await act(async () => {
                root.render(<QueryClientProvider client={client}>{content}</QueryClientProvider>);
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
async function click(host: HTMLElement, label: string) {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === label || element.getAttribute("aria-label") === label);
    if (!button) throw new Error(`找不到 ${label}: ${host.textContent}`);
    await act(async () => {
        button.click();
        await settle();
    });
}
async function choose(host: HTMLElement, label: string, value: string) {
    await act(async () => {
        const select = host.querySelector<HTMLSelectElement>(`[aria-label='${label}']`)!;
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await settle();
    });
}
const waitGeneration = () => act(async () => new Promise((resolve) => setTimeout(resolve, 400)));

test("按真实段导航，段内跨场景仍显示完整镜头，新增定位本段最后镜头", async () => {
    const opened: Array<[string, string | undefined]> = [];
    const edited: string[] = [];
    const view = await mount(
        <WorkflowStoryboardPage
            {...segmentActions}
            summary={summary}
            detail={detail}
            castById={new Map()}
            status="all"
            videoAllowed
            onChanged={() => undefined}
            onOpenShot={(shot, kind) => opened.push([shot.id, kind])}
            onEditShot={(shot) => edited.push(shot.id)}
            onOpenCast={() => undefined}
        />,
    );
    try {
        expect(view.host.textContent).toContain("共 2 段");
        expect(view.host.textContent).not.toContain("幕");
        expect(view.host.textContent).toContain("分镜 1");
        expect(view.host.querySelectorAll(".drama-storyboard-shot")).toHaveLength(2);
        expect(view.host.textContent).toContain("人物回头");
        expect(view.host.querySelector("[data-split-segment='0']")).toBeTruthy();
        expect(view.host.textContent).not.toContain("主角打开灯");
        await click(view.host, "编辑分镜 1 的媒体");
        expect(opened).toEqual([["s1", "video"]]);
        await click(view.host, "编辑分镜 1 文字");
        expect(edited).toEqual(["s1"]);
        await click(view.host, "新增镜头");
        expect(inserted).toEqual(["s2"]);
        expect(edited).toEqual(["s1", "inserted"]);
        await act(async () => {
            view.host.querySelectorAll<HTMLButtonElement>("nav[aria-label*='段列表'] .drama-storyboard-segment-row > button")[1].click();
            await settle();
        });
        expect(view.host.textContent).toContain("主角打开灯");
        expect(view.host.textContent).not.toContain("主角推门");
        expect(view.host.querySelector("[data-split-segment='1']")).toBeTruthy();
        expect(view.host.querySelectorAll(".drama-storyboard-shot")).toHaveLength(1);
    } finally {
        await view.close();
    }
});

test("宫格与故事板保留独立模式入口，只使用当前段的完整镜头", async () => {
    for (const mode of ["grid_image", "storyboard"] as const) {
        const opened: string[] = [];
        const value = { ...summary, production: { ...summary.production, settings: { ...settings, storyboard: { ...settings.storyboard, generationMode: mode } } } };
        const view = await mount(
            <WorkflowStoryboardPage
                {...segmentActions}
                summary={value}
                detail={detail}
                castById={new Map()}
                status="all"
                videoAllowed
                onChanged={() => undefined}
                onOpenShot={(_shot, kind) => opened.push(kind || "")}
                onEditShot={() => undefined}
                onOpenCast={() => undefined}
            />,
        );
        try {
            await click(view.host, "编辑分镜 1 的媒体");
            expect(opened).toEqual(["image"]);
            await click(view.host, mode === "grid_image" ? "生成宫格图" : "生成故事板");
            expect(view.host.querySelector(`[role='dialog'][aria-label='${mode === "grid_image" ? "宫格图" : "故事板"}'][data-board-shots='s1,s2']`)).toBeTruthy();
        } finally {
            await view.close();
        }
    }
});

async function mountVideoFilter(status: string, videoAllowed = true, data = detail) {
    return mount(
        <WorkflowStoryboardPage
            {...segmentActions}
            summary={summary}
            detail={data}
            castById={new Map()}
            status={status}
            videoAllowed={videoAllowed}
            onChanged={() => undefined}
            onOpenShot={() => undefined}
            onEditShot={() => undefined}
            onOpenCast={() => undefined}
        />,
    );
}

test("段视频就绪筛选保留段内全部镜头，不受单镜图片或视频状态影响", async () => {
    for (const [imageStatus, imageLabel] of [
        ["failed", "生成失败"],
        ["queued", "排队中"],
        ["stale", "待更新"],
    ]) {
        mediaStates.set("s1:image", { status: imageStatus, resourceId: "image-1" });
        mediaStates.set("s1:video", { status: "ready", resourceId: "video-1" });
        const view = await mountVideoFilter("ready", true, { ...detail, segments: [{ ...detail.segments[0], videoStatus: "ready", videoResourceId: "segment-video" }, detail.segments[1]] });
        try {
            const cards = view.host.querySelectorAll(".drama-storyboard-shot");
            expect(cards).toHaveLength(2);
            expect(cards[0].getAttribute("data-tone")).toBe("ready");
            expect(cards[0].textContent).toContain("分镜 1");
            expect(cards[0].querySelector(`[aria-label='分镜 1 图片 · ${imageLabel}']`)).toBeTruthy();
            expect(cards[0].querySelector("[data-resource='image-1']")).toBeTruthy();
            expect(cards[0].querySelector("[aria-label='分镜 1 视频 · 已就绪']")).toBeTruthy();
        } finally {
            await view.close();
            mediaStates.clear();
        }
    }
});

test("失败、处理中、过期与待生成筛选依据段状态，独立镜头状态保持各自标注", async () => {
    for (const [videoStatus, tone, videoAllowed] of [
        ["failed", "failed", true],
        ["queued", "busy", true],
        ["running", "busy", true],
        ["stale", "stale", true],
        ["idle", "idle", true],
        ["idle", "ready", false],
    ] as const) {
        mediaStates.set("s1:image", { status: "ready", resourceId: "image-1" });
        mediaStates.set("s1:video", { status: videoStatus });
        mediaStates.set("s2:video", { status: "ready", resourceId: "video-2" });
        const view = await mountVideoFilter(tone, videoAllowed, {
            ...detail,
            segments: [
                { ...detail.segments[0], videoStatus, request: { ...detail.segments[0].request, firstFramePending: false }, videoJob: videoStatus === "queued" ? { status: "running" } : undefined },
                { ...detail.segments[1], promptStatus: "none", videoStatus: "ready" },
            ],
        });
        try {
            const cards = view.host.querySelectorAll(".drama-storyboard-shot");
            expect(cards).toHaveLength(2);
            expect(cards[0].getAttribute("data-tone")).toBe(!videoAllowed ? "blocked" : tone);
            expect(cards[0].textContent).toContain("分镜 1");
        } finally {
            await view.close();
            mediaStates.clear();
        }
    }
});

test("段生成、失败重试、提示词与预览只操作定位的真实段，勾选传真实段ID", async () => {
    const generated: string[] = [];
    const written: string[] = [];
    const edited: number[] = [];
    const navigated: number[] = [];
    const selected: Array<[string[], boolean]> = [];
    const data = { ...detail, segments: [detail.segments[0], { ...detail.segments[1], videoStatus: "failed", videoResourceId: "previous-segment-video", promptStatus: "failed" }] } as DramaEpisodeDetail;
    const view = await mount(
        <WorkflowStoryboardPage
            {...segmentActions}
            summary={summary}
            detail={data}
            castById={new Map()}
            status="all"
            videoAllowed
            segmentIndex={1}
            onChanged={() => undefined}
            onOpenShot={() => undefined}
            onEditShot={() => undefined}
            onOpenCast={() => undefined}
            onGenerateSegment={(segment) => generated.push(segment.id)}
            onWriteSegmentPrompt={(segment) => written.push(segment.id)}
            onOpenSegment={(index) => edited.push(index)}
            onSegmentChange={(index) => navigated.push(index)}
            onSelectSegments={(ids, checked) => selected.push([ids, checked])}
        />,
    );
    try {
        expect(view.host.textContent).toContain("主角打开灯");
        expect(view.host.textContent).not.toContain("主角推门");
        for (const group of ["本段制作", "本段调整", "本段视图"]) expect(view.host.querySelector(`[role="group"][aria-label="${group}"]`)).not.toBeNull();
        expect(view.host.querySelector('[aria-label="本段制作"]')?.textContent).toContain("重试本段视频");
        expect(view.host.querySelector('[aria-label="本段调整"]')?.textContent).toContain("编辑本段");
        expect(view.host.querySelector('[aria-label="本段制作"]')?.textContent).toContain("预览本段");
        expect(view.host.querySelector('[aria-label="本段视图"]')?.textContent).toContain("收起");
        await click(view.host, "重试本段视频");
        await click(view.host, "重试本段提示词");
        await click(view.host, "编辑本段");
        expect(generated).toEqual(["segment2"]);
        expect(written).toEqual(["segment2"]);
        expect(edited).toEqual([1]);
        await click(view.host, "预览本段");
        expect(view.host.querySelector("[aria-label='第 2 段视频预览'] video")?.getAttribute("src")).toBe("/resources/previous-segment-video");
        await act(async () => {
            view.host.querySelector<HTMLInputElement>("[aria-label='选择第 1 集第 2 段']")!.click();
            view.host.querySelector<HTMLInputElement>("[aria-label='选择第 1 集筛选出的 2 段']")!.click();
            await settle();
        });
        expect(selected).toEqual([
            [["segment2"], true],
            [["segment1", "segment2"], true],
        ]);
        await click(view.host, "查看第 1 段：推门与回头");
        expect(navigated).toEqual([0]);
        expect(view.host.querySelector("[aria-label='第 2 段分镜']")).toBeTruthy();
    } finally {
        await view.close();
    }
});

test("没有真实段或筛选无匹配时不退回场景分组，也不显示其他范围生成入口", async () => {
    for (const [data, status, text] of [
        [{ ...detail, segments: [] }, "all", "本集暂无剧情段"],
        [detail, "failed", "没有符合筛选条件的段"],
    ] as const) {
        const view = await mountVideoFilter(status, true, data as DramaEpisodeDetail);
        try {
            expect(view.host.textContent).toContain(text);
            expect(view.host.querySelectorAll(".drama-storyboard-shot")).toHaveLength(0);
            expect(view.host.textContent).not.toContain("生成本段视频");
            expect(view.host.textContent).not.toContain("幕");
        } finally {
            await view.close();
        }
    }
});

test("筛选下轮询使当前段状态变化时，已打开的宫格保留原段镜头快照", async () => {
    const value = { ...summary, production: { ...summary.production, settings: { ...settings, storyboard: { ...settings.storyboard, generationMode: "grid_image" as const } } } };
    const data = { ...detail, segments: detail.segments.map((segment) => ({ ...segment, videoStatus: "running" })) } as DramaEpisodeDetail;
    const page = (current: DramaEpisodeDetail) => (
        <WorkflowStoryboardPage {...segmentActions} summary={value} detail={current} castById={new Map()} status="busy" videoAllowed onChanged={() => undefined} onOpenShot={() => undefined} onEditShot={() => undefined} onOpenCast={() => undefined} />
    );
    const view = await mount(page(data));
    try {
        await click(view.host, "生成宫格图");
        expect(view.host.querySelector("[data-board-shots='s1,s2']")).toBeTruthy();
        await view.render(page({ ...data, segments: [{ ...data.segments[0], videoStatus: "ready" }, data.segments[1]] }));
        expect(view.host.querySelector("[aria-label='第 2 段分镜']")).toBeTruthy();
        expect(view.host.querySelector("[data-board-shots='s1,s2']")).toBeTruthy();
        expect(view.host.querySelector("[data-board-shots='s3']")).toBeNull();
    } finally {
        await view.close();
    }
});

test("四模式同窗切换并统一提交实际设置，模式选择本身不调用生成", async () => {
    const saved: DramaSettings[] = [];
    const view = await mount(
        <WorkflowModeDialog
            open
            summary={summary}
            onCancel={() => undefined}
            onConfirm={async (value) => {
                saved.push(value);
            }}
        />,
    );
    try {
        expect(view.host.querySelectorAll("nav[aria-label='分镜生成默认模式'] button")).toHaveLength(4);
        const options = view.host.querySelectorAll<HTMLButtonElement>("nav[aria-label='分镜生成默认模式'] button");
        await act(async () => {
            options[1].click();
            await settle();
        });
        expect(view.host.textContent).toContain("当前无额外配置项");
        expect(saved).toHaveLength(0);
        await act(async () => {
            options[2].click();
            await settle();
        });
        await click(view.host, "确认并进入漫剧分镜");
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ aspectRatio: "16:9", videoResolution: "720p", models: settings.models, storyboard: { generationMode: "smart_director", directorTemplate: "smart_drama" } });
    } finally {
        await view.close();
    }
});

test("统一确认失败仍保留同一弹窗与所选模式，可修复后重试", async () => {
    let attempts = 0;
    const view = await mount(
        <WorkflowModeDialog
            open
            summary={summary}
            onCancel={() => undefined}
            onConfirm={async () => {
                attempts++;
                throw new Error("当前设置有冲突");
            }}
        />,
    );
    try {
        await click(view.host, "确认并进入漫剧分镜");
        expect(view.host.textContent).toContain("当前设置有冲突");
        expect(view.host.querySelector("[role='dialog']")).toBeTruthy();
        await click(view.host, "确认并进入漫剧分镜");
        expect(attempts).toBe(2);
    } finally {
        await view.close();
    }
});

test("模式同帧重复确认只提交一次，提交未结束不能取消", async () => {
    let calls = 0;
    let cancels = 0;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const view = await mount(
        <WorkflowModeDialog
            open
            summary={summary}
            onCancel={() => {
                cancels++;
            }}
            onConfirm={async () => {
                calls++;
                await pending;
            }}
        />,
    );
    try {
        const buttons = [...view.host.querySelectorAll<HTMLButtonElement>("button")];
        const confirm = buttons.find((button) => button.textContent === "确认并进入漫剧分镜")!;
        const cancel = buttons.find((button) => button.textContent === "取消")!;
        await act(async () => {
            confirm.click();
            confirm.click();
            cancel.click();
            await settle();
        });
        expect(calls).toBe(1);
        expect(cancels).toBe(0);
        await act(async () => {
            finish();
            await settle();
        });
    } finally {
        finish();
        await view.close();
    }
});

test("分镜模式更换视频模型协调分辨率与衔接，保留比例并阻止不兼容确认", async () => {
    catalogVideoOptions = [
        { choice: { logicalModelId: "old" }, capability: "video", label: "旧模型", priceLabel: "", tailFrameChain: true, videoRatios: ["16:9"], videoResolutions: ["1080p"] },
        { choice: { logicalModelId: "new" }, capability: "video", label: "新模型", priceLabel: "", tailFrameChain: false, videoRatios: ["9:16"], videoResolutions: ["720p"] },
    ];
    const saved: DramaSettings[] = [];
    const value = { ...summary, production: { ...summary.production, settings: { ...settings, videoResolution: "1080p", videoContinuity: "tail_frame" as const, models: { ...settings.models, video: { logicalModelId: "old" } } } } };
    const view = await mount(
        <WorkflowModeDialog
            open
            summary={value}
            onCancel={() => undefined}
            onConfirm={async (draft) => {
                saved.push(draft);
            }}
        />,
    );
    const choose = async (label: string, value: string) => {
        await act(async () => {
            const select = view.host.querySelector<HTMLSelectElement>(`[aria-label='${label}']`)!;
            select.value = value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            await settle();
        });
    };
    try {
        await choose("选择分镜视频模型", "new");
        expect(view.host.querySelector<HTMLSelectElement>("[aria-label='分镜视频与生图比例']")!.value).toBe("16:9");
        expect(view.host.querySelector<HTMLSelectElement>("[aria-label='分镜视频分辨率']")!.value).toBe("");
        expect(view.host.querySelector<HTMLSelectElement>("[aria-label='分镜视频衔接']")!.value).toBe("parallel");
        expect(view.host.textContent).toContain("不支持 16:9 画幅");
        expect([...view.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "确认并进入漫剧分镜")!.disabled).toBe(true);
        await choose("分镜视频与生图比例", "9:16");
        await waitGeneration();
        await click(view.host, "确认并进入漫剧分镜");
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ aspectRatio: "9:16", videoContinuity: "parallel", models: { video: { logicalModelId: "new" } } });
        expect(saved[0].videoResolution).toBeUndefined();
    } finally {
        await view.close();
        catalogVideoOptions = [];
    }
});

test("模式窗口的图片与视频配置自动生效，模式与镜头数量仍待确认", async () => {
    generationWrites.length = 0;
    const saved: DramaSettings[] = [];
    const view = await mount(
        <WorkflowModeDialog
            open
            summary={summary}
            onCancel={() => undefined}
            onConfirm={(value) => {
                saved.push(value);
            }}
        />,
    );
    try {
        await act(async () => {
            view.host.querySelectorAll<HTMLButtonElement>("nav[aria-label='分镜生成默认模式'] button")[3].click();
            await settle();
        });
        await choose(view.host, "分镜数量方式", "custom");
        await click(view.host, "选择分镜图片模型");
        await choose(view.host, "分镜视频与生图比例", "9:16");
        await choose(view.host, "分镜视频衔接", "parallel");
        await waitGeneration();
        expect(generationWrites).toHaveLength(1);
        expect(generationWrites[0]).toEqual({ expectedRevision: 2, generation: { models: { image: { modelKey: "image-new" }, video: settings.models.video }, aspectRatio: "9:16", videoResolution: "720p", videoContinuity: "parallel" } });
        expect(saved).toHaveLength(0);
        expect(view.host.textContent).not.toContain("作品设置已有更新");
        await click(view.host, "确认并进入漫剧分镜");
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ storyboard: { generationMode: "storyboard", directorTemplate: "storyboard_detail", targetShotCount: 24 }, models: { image: { modelKey: "image-new" } }, aspectRatio: "9:16" });
    } finally {
        await view.close();
    }
});

test("取消模式选择会先同步已改媒体配置，不确认模式或生成", async () => {
    generationWrites.length = 0;
    let cancels = 0;
    const saved: DramaSettings[] = [];
    const view = await mount(
        <WorkflowModeDialog
            open
            summary={summary}
            onCancel={() => {
                cancels++;
            }}
            onConfirm={(value) => {
                saved.push(value);
            }}
        />,
    );
    try {
        await choose(view.host, "分镜视频与生图比例", "9:16");
        await click(view.host, "取消");
        expect(generationWrites).toHaveLength(1);
        expect(generationWrites[0].generation?.aspectRatio).toBe("9:16");
        expect(cancels).toBe(1);
        expect(saved).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("模式窗口自动同步失败保留配置，可原位重试", async () => {
    generationWrites.length = 0;
    generationFailure = true;
    const view = await mount(<WorkflowModeDialog open summary={summary} onCancel={() => undefined} onConfirm={() => undefined} />);
    try {
        await choose(view.host, "分镜视频衔接", "parallel");
        await waitGeneration();
        expect(view.host.textContent).toContain("生成配置写入失败");
        expect(view.host.querySelector<HTMLSelectElement>("[aria-label='分镜视频衔接']")!.value).toBe("parallel");
        await waitGeneration();
        expect(generationWrites).toHaveLength(1);
        generationFailure = false;
        await click(view.host, "重新应用生成配置");
        expect(generationWrites).toHaveLength(2);
        expect(view.host.textContent).not.toContain("生成配置写入失败");
    } finally {
        generationFailure = false;
        await view.close();
    }
});

test("模式窗口配置回执晚于其他更新时不覆盖更新，关闭后可重进", async () => {
    generationWrites.length = 0;
    let finish!: () => void;
    generationHold = new Promise<void>((resolve) => {
        finish = resolve;
    });
    let cancels = 0;
    const content = (value: DramaSummary) => (
        <WorkflowModeDialog
            open
            summary={value}
            onCancel={() => {
                cancels++;
            }}
            onConfirm={() => undefined}
        />
    );
    const view = await mount(content(summary));
    try {
        await choose(view.host, "分镜视频衔接", "parallel");
        await waitGeneration();
        const newer = { ...summary, production: { ...summary.production, revision: 4 } };
        await view.render(content(newer));
        await act(async () => {
            finish();
            await settle();
        });
        expect(view.host.textContent).toContain("作品设置已有更新");
        await click(view.host, "取消");
        expect(cancels).toBe(1);
    } finally {
        finish();
        generationHold = undefined;
        await view.close();
    }
});
