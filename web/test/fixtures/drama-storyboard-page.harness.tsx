import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaEpisodeDetail, DramaModelChoice, DramaModelOption, DramaSettings, DramaShot, DramaSummary } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/projects/p?step=story" });
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const userStore = create(() => ({ user: { id: "user" } }));
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
mock.module("@/pages/projects/workflow-scene-splits", () => ({ WorkflowSceneSplits: ({ initialShotId, buttonLabel }: { initialShotId: string; buttonLabel: string }) => <button data-scene-shot={initialShotId}>{buttonLabel}</button> }));
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
mock.module("@/pages/projects/drama-shared", () => ({ MediaThumb: ({ resourceId }: { resourceId: string }) => <img data-resource={resourceId} />, useResourceMediaUrl: () => "" }));
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
            <button>模型选择</button>
        ),
}));
const inserted: string[] = [];
mock.module("@/services/api/drama", () => ({
    insertDramaShot: async (_projectId: string, shotId: string) => {
        inserted.push(shotId);
        return { shot: { ...shots[0], id: "inserted", position: 3 } };
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
    { id: "s2", projectId: "p", episodeId: "e", position: 1, scene: "小区边缘 日 外", segmentIndex: 0, durationMs: 2000, action: "人物回头" },
    { id: "s3", projectId: "p", episodeId: "e", position: 2, scene: "秦家卧室 夜 内", segmentIndex: 1, durationMs: 4000, action: "主角打开灯" },
] as DramaShot[];
const detail = {
    episode: { id: "e", number: 1 },
    shots,
    segments: [
        { id: "segment1", index: 0, shotIds: ["s1", "s2"] },
        { id: "segment2", index: 1, shotIds: ["s3"] },
    ],
} as DramaEpisodeDetail;
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

test("幕导航展示单镜，镜头直接打开真实媒体入口，新增定位本幕最后镜头", async () => {
    const opened: Array<[string, string | undefined]> = [];
    const edited: string[] = [];
    const view = await mount(
        <WorkflowStoryboardPage
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
        expect(view.host.textContent).toContain("共 2 幕");
        expect(view.host.textContent).toContain("分镜 1");
        expect(view.host.querySelector("[data-batch-targets='segment1']")?.getAttribute("title")).toContain("当前幕 2 镜");
        expect(view.host.textContent).not.toContain("主角打开灯");
        await click(view.host, "编辑分镜 1 的媒体");
        expect(opened).toEqual([["s1", "video"]]);
        await click(view.host, "编辑分镜 1 文字");
        expect(edited).toEqual(["s1"]);
        await click(view.host, "新增镜头");
        expect(inserted).toEqual(["s2"]);
        expect(edited).toEqual(["s1", "inserted"]);
        await act(async () => {
            view.host.querySelectorAll<HTMLButtonElement>("nav[aria-label*='幕列表'] > button")[1].click();
            await settle();
        });
        expect(view.host.textContent).toContain("主角打开灯");
        expect(view.host.textContent).not.toContain("主角推门");
        expect(view.host.querySelector("[data-scene-shot='s3']")).toBeTruthy();
    } finally {
        await view.close();
    }
});

test("宫格与故事板保留独立模式入口，按当前幕范围调用已有故事板能力", async () => {
    for (const mode of ["grid_image", "storyboard"] as const) {
        const opened: string[] = [];
        const value = { ...summary, production: { ...summary.production, settings: { ...settings, storyboard: { ...settings.storyboard, generationMode: mode } } } };
        const view = await mount(
            <WorkflowStoryboardPage
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

async function mountVideoFilter(status: string, videoAllowed = true) {
    return mount(
        <WorkflowStoryboardPage summary={summary} detail={detail} castById={new Map()} status={status} videoAllowed={videoAllowed} onChanged={() => undefined} onOpenShot={() => undefined} onEditShot={() => undefined} onOpenCast={() => undefined} />,
    );
}

test("视频已就绪筛选与着色不受独立图片失败、排队或过期影响", async () => {
    for (const [imageStatus, imageLabel] of [
        ["failed", "生成失败"],
        ["queued", "排队中"],
        ["stale", "待更新"],
    ]) {
        mediaStates.set("s1:image", { status: imageStatus, resourceId: "image-1" });
        mediaStates.set("s1:video", { status: "ready", resourceId: "video-1" });
        const view = await mountVideoFilter("ready");
        try {
            const cards = view.host.querySelectorAll(".drama-storyboard-shot");
            expect(cards).toHaveLength(1);
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

test("镜头视频失败、处理中、过期与待生成状态仍按视频槽筛选", async () => {
    for (const [videoStatus, tone, videoAllowed] of [
        ["failed", "failed", true],
        ["queued", "busy", true],
        ["running", "busy", true],
        ["stale", "stale", true],
        ["idle", "idle", true],
        ["idle", "blocked", false],
    ] as const) {
        mediaStates.set("s1:image", { status: "ready", resourceId: "image-1" });
        mediaStates.set("s1:video", { status: videoStatus });
        mediaStates.set("s2:video", { status: "ready", resourceId: "video-2" });
        const view = await mountVideoFilter(tone, videoAllowed);
        try {
            const cards = view.host.querySelectorAll(".drama-storyboard-shot");
            expect(cards).toHaveLength(1);
            expect(cards[0].getAttribute("data-tone")).toBe(tone);
            expect(cards[0].textContent).toContain("分镜 1");
        } finally {
            await view.close();
            mediaStates.clear();
        }
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
        await click(view.host, "确认并进入漫剧分镜");
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ aspectRatio: "9:16", videoContinuity: "parallel", models: { video: { logicalModelId: "new" } } });
        expect(saved[0].videoResolution).toBeUndefined();
    } finally {
        await view.close();
        catalogVideoOptions = [];
    }
});
