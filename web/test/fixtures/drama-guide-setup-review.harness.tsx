import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { DramaAgentProposal } from "@/services/api/agent";
import type { DramaModelCatalog, DramaSettings, DramaSummary } from "@/services/api/drama";
import type { AgentDramaContext } from "@/stores/use-global-agent-store";

const browser = new Window({ url: "http://localhost/projects/project/guide" });
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { environmentManager } = await import("@tanstack/query-core");
environmentManager.setIsServer(() => false);

const videoChoice = { channelId: "video-channel", modelKey: "video-model", label: "测试视频模型" };
const catalog = {
    defaults: { text: {}, image: {}, video: videoChoice },
    options: { text: [], image: [], video: [{ choice: videoChoice, capability: "video", label: "测试视频模型", priceLabel: "", videoResolutions: ["480p", "720p", "1080p"], defaultVideoResolution: "720p", videoRatios: ["9:16", "16:9"] }] },
} as DramaModelCatalog;
const originalSettings = {
    aspectRatio: "9:16",
    episodeSeconds: 90,
    stylePrompt: "原有柔和写实风格",
    styleName: "原有风格",
    language: "中文普通话",
    videoResolution: "720p",
    reviewMode: "manual",
    mediaMode: "manual",
    concurrency: 2,
    referenceLimit: 3,
    episodeMode: "chapter",
    videoContinuity: "tail_frame",
    assets: { mode: "portrait", characterPrompt: "原有角色提示词", scenePrompt: "原有场景提示词", characterRatio: "9:16" },
    storyboard: {},
    models: { text: { channelId: "text-channel", modelKey: "text-model" }, image: { channelId: "image-channel", modelKey: "image-model" }, video: videoChoice },
} as DramaSettings;
let summary: DramaSummary;
let dramaContext: AgentDramaContext | null = null;
let settingsWrites: Array<{ projectId: string; input: { settings: DramaSettings; expectedRevision: number } }> = [];
let notices: string[] = [];
let otherWrites = 0;
const silent = () => {};
const forbidden = async () => {
    otherWrites++;
    throw new Error("配置草稿操作不应调用其他业务写入");
};
const agentStore = {
    get drama() {
        return dramaContext;
    },
    setDrama(value: AgentDramaContext | null) {
        dramaContext = value;
    },
};
mock.module("@/stores/use-global-agent-store", () => ({ useGlobalAgentStore: { getState: () => agentStore } }));
mock.module("antd", () => ({
    App: { useApp: () => ({ message: { info: (value: string) => notices.push(value), warning: (value: string) => notices.push(value), success: silent, error: (value: string) => notices.push(value) }, modal: { confirm: forbidden } }) },
    Button: ({ children, icon, loading: _loading, type: _type, size: _size, danger: _danger, ...props }: any) => (
        <button {...props}>
            {icon}
            {children}
        </button>
    ),
    Input: (props: any) => <input {...props} />,
    Select: ({ options, onChange, loading: _loading, ...props }: any) => (
        <select {...props} onChange={(event) => onChange(event.target.value)}>
            {options?.map((option: { value: string; label: string }) => (
                <option key={option.value} value={option.value}>
                    {option.label}
                </option>
            ))}
        </select>
    ),
}));
mock.module("react-router", () => ({ useParams: () => ({ projectId: "project" }), useNavigate: () => silent, Link: ({ children }: any) => children, Navigate: () => null }));
mock.module("@/components/layout/workspace-page", () => ({ WorkspacePage: ({ children }: any) => <div>{children}</div> }));
mock.module("@/components/layout/workspace-state", () => ({ WorkspaceErrorState: () => <div>读取失败</div>, WorkspaceLoadingState: () => <div>读取中</div> }));
mock.module("@/components/ui/product/app-modal", () => ({ AppModal: () => null }));
mock.module("@/services/drama-canvas", () => ({ encodeDramaCanvasFocus: () => "", openDramaCanvasPath: async () => "" }));
mock.module("@/pages/projects/drama-model-picker", () => ({ DramaModelPicker: () => null, useDramaModelCatalog: () => ({ data: catalog, isLoading: false, isError: false }) }));
mock.module("@/pages/projects/drama-shared", () => ({ CAST_KIND_LABEL: { character: "角色", scene: "场景", prop: "道具" }, SourceFormatPicker: () => null, mediaBusy: () => false, MediaThumb: () => null }));
mock.module("@/pages/projects/asset-scheme", () => ({ AssetSchemePicker: () => null }));
mock.module("@/pages/projects/style-picker", () => ({ DramaStylePicker: () => null }));
mock.module("@/pages/projects/prompt-skill", () => ({ PromptSkillField: () => null }));
mock.module("@/pages/projects/storyboard-rules", () => ({ EpisodeDurationInput: ({ value }: { value: number }) => <output aria-label="单集时长">{value}</output>, StoryboardRules: () => null }));
mock.module("@/pages/projects/studio/segment-parts", () => ({ secondsLabel: (value: number) => `${value} 秒`, SegmentStatus: () => null }));
mock.module("@/pages/projects/studio/segment-dialog", () => ({ ShotEditor: () => null }));
mock.module("@/services/api/drama", () => ({
    getDrama: async () => structuredClone(summary),
    listDramaCast: async () => ({ cast: [] }),
    getDramaEpisode: async () => ({}),
    listDramaChapters: async () => ({ chapters: [] }),
    getDramaChapter: async () => ({}),
    updateDramaSettings: async (projectId: string, input: { settings: DramaSettings; expectedRevision: number }) => {
        settingsWrites.push({ projectId, input: structuredClone(input) });
        summary = { ...summary, production: { ...summary.production, revision: summary.production.revision + 1, settings: structuredClone(input.settings) } };
        return structuredClone(summary);
    },
    confirmDramaGuide: forbidden,
    createDramaCast: forbidden,
    deleteDramaCast: forbidden,
    regenerateDramaCast: forbidden,
    rescriptDramaEpisode: forbidden,
    retryFailedDrama: forbidden,
    saveDramaGuideSource: forbidden,
    updateDramaCast: forbidden,
    updateDramaSegment: forbidden,
    updateDramaShot: forbidden,
    writeDramaSegmentPrompts: forbidden,
}));

const { dramaKeys } = await import("@/pages/projects/studio/use-studio");
const { default: DramaGuidePage } = await import("@/pages/projects/guide");
const settle = async () => {
    for (let i = 0; i < 6; i++) await Bun.sleep(10);
};
afterAll(() => browser.happyDOM.abort());

function persistedSetup(baseRevision = 7): DramaAgentProposal {
    return {
        kind: "setup",
        baseRevision,
        runId: "restored-run",
        toolCallId: "restored-setup",
        changes: {
            aspectRatio: "9:16",
            videoResolution: "1080x1920",
            styleName: "雨夜电影风格",
            stylePrompt: "冷色雨幕与高反差电影照明",
            language: "粤语",
            episodeSeconds: 120,
            models: { video: { channelId: "untrusted-channel", modelKey: "untrusted-model" } },
            assets: { characterPrompt: "不应覆盖" },
            concurrency: 99,
            mediaMode: "auto",
        },
    };
}

async function withGuide(
    check: (ui: { container: HTMLElement; chatHost: HTMLDivElement; receive: (value: DramaAgentProposal) => Promise<void>; button: (label: string) => HTMLButtonElement; click: (label: string) => Promise<void> }) => Promise<void>,
    production: Partial<DramaSummary["production"]> = {},
) {
    summary = {
        project: { id: "project", name: "持久化配置建议测试" },
        production: { guideStep: "configuring", revision: 7, status: "draft", stage: "bible", settings: structuredClone(originalSettings), chapterCount: 0, wordCount: 0, ...production },
        episodes: [],
        jobCounts: {},
        inbox: [],
        castCount: 0,
        guide: { step: "configuring", canConfirm: false },
    } as DramaSummary;
    settingsWrites = [];
    notices = [];
    otherWrites = 0;
    dramaContext = null;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    client.setQueryData(dramaKeys.summary("project"), structuredClone(summary));
    client.setQueryData(dramaKeys.cast("project"), { cast: [] });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const button = (label: string) => {
        const found =
            Array.from(container.querySelector('[aria-label="创作对话操作"]')?.querySelectorAll("button") || []).find((item) => item.textContent?.trim() === label) ||
            Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);
        expect(found, `未找到按钮：${label}`).toBeDefined();
        return found!;
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
        expect(dramaContext?.onProposal).toBeFunction();
        expect(dramaContext?.onActionsHost).toBeFunction();
        const chatHost = document.createElement("div");
        chatHost.setAttribute("aria-label", "创作对话操作");
        container.querySelector(".drama-guide-agent-host")!.append(chatHost);
        await act(async () => {
            dramaContext!.onActionsHost!(chatHost);
            await settle();
        });
        await check({
            container,
            chatHost,
            button,
            receive: async (value) => {
                await act(async () => {
                    dramaContext!.onProposal!(value);
                    await settle();
                });
            },
            click: async (label) => {
                await act(async () => {
                    button(label).click();
                    await settle();
                });
            },
        });
    } finally {
        await act(async () => root.unmount());
        client.clear();
        container.remove();
    }
}

test("进入真实引导页即提供首次工作请求，已有正文与创作想法走不同预设且手动重推荐独立", async () => {
    for (const production of [{ creativeBrief: "虚构的雨夜侦探故事" }, { chapterCount: 1 }]) {
        await withGuide(async ({ click }) => {
            const request = dramaContext?.startupRequest;
            expect(request?.autoSubmit).toBe(true);
            expect(request?.text).toContain("先读取当前阶段、现有正文和配置");
            expect(request?.text).toContain("每个阶段都等待我确认，不自动生成图片或视频");
            expect(request?.text).toContain(production.chapterCount ? "直接读取已保存的正文" : "虚构的雨夜侦探故事");
            expect(dramaContext?.prefillRequest ?? null).toBeNull();
            expect(settingsWrites).toEqual([]);
            expect(otherWrites).toBe(0);
            await click("横屏 16:9");
            await click("保存调整");
            expect(dramaContext?.startupRequest).toBe(request);
            expect(dramaContext?.prefillRequest ?? null).toBeNull();
            await click(production.chapterCount ? "重新推荐方案" : "重新起草正文与方案");
            expect(dramaContext?.prefillRequest?.text).toBe(request?.text);
            expect(dramaContext?.prefillRequest?.id).not.toBe(request?.id);
            expect(otherWrites).toBe(0);
        }, production);
    }
});

test("资产、分镜和完成阶段不提供自动开始请求", async () => {
    for (const guideStep of ["assets", "story", "completed"] as const) {
        await withGuide(
            async () => {
                expect(dramaContext?.startupRequest ?? null).toBeNull();
                expect(dramaContext?.prefillRequest ?? null).toBeNull();
                expect(settingsWrites).toEqual([]);
                expect(otherWrites).toBe(0);
            },
            { guideStep, chapterCount: 1 },
        );
    }
});

test("旧像素尺寸建议可进入真实配置草稿，选1080P后仅保存白名单修改并携带CAS", async () => {
    await withGuide(async ({ container, chatHost, receive, button, click }) => {
        await receive(persistedSetup());
        expect(settingsWrites).toEqual([]);
        expect(chatHost.querySelectorAll(".drama-guide-proposal")).toHaveLength(1);
        expect(container.querySelector('[aria-label="创作产物"] .drama-guide-proposal')).toBeNull();
        expect(button("应用此建议").disabled).toBe(true);
        expect(button("调整建议").disabled).toBe(false);
        await click("应用此建议");
        expect(settingsWrites).toEqual([]);
        await click("调整建议");
        expect(settingsWrites).toEqual([]);
        expect(otherWrites).toBe(0);
        expect(dramaContext?.prefillRequest ?? null).toBeNull();
        expect(summary.production.settings).toEqual(originalSettings);
        expect(chatHost.querySelector(".drama-guide-style-description")?.textContent).toBe("冷色雨幕与高反差电影照明");
        expect(chatHost.querySelector<HTMLSelectElement>('select[aria-label="对白语言"]')?.value).toBe("粤语");
        expect(chatHost.querySelector('output[aria-label="单集时长"]')?.textContent).toBe("120");
        expect(chatHost.querySelector('[role="radiogroup"][aria-label="视频分辨率"]')).not.toBeNull();
        expect(button("1080P").getAttribute("aria-checked")).toBe("false");
        await click("1080P");
        expect(button("1080P").getAttribute("aria-checked")).toBe("true");
        expect(settingsWrites).toEqual([]);
        await click("保存调整");
        expect(settingsWrites).toEqual([
            {
                projectId: "project",
                input: { expectedRevision: 7, settings: { ...originalSettings, aspectRatio: "9:16", videoResolution: "1080p", styleName: "雨夜电影风格", stylePrompt: "冷色雨幕与高反差电影照明", language: "粤语", episodeSeconds: 120 } },
            },
        ]);
        expect(otherWrites).toBe(0);
        expect(dramaContext?.prefillRequest ?? null).toBeNull();
        expect(notices).toEqual([]);
    });
});

test("已有未保存配置时禁止用建议覆盖，保留用户手动草稿", async () => {
    await withGuide(async ({ container, receive, button, click }) => {
        await click("横屏 16:9");
        await receive(persistedSetup());
        expect(button("调整建议").disabled).toBe(true);
        await click("调整建议");
        expect(settingsWrites).toEqual([]);
        expect(button("横屏 16:9").getAttribute("aria-checked")).toBe("true");
        expect(container.querySelector(".drama-guide-style-description")?.textContent).toBe(originalSettings.stylePrompt);
        expect(container.querySelector<HTMLSelectElement>('select[aria-label="对白语言"]')?.value).toBe(originalSettings.language);
        await click("保存调整");
        expect(settingsWrites).toEqual([{ projectId: "project", input: { expectedRevision: 7, settings: { ...originalSettings, aspectRatio: "16:9" } } }]);
        expect(otherWrites).toBe(0);
    });
});

test("旧版本配置建议禁用调整与直接应用，不改草稿也不写后端", async () => {
    await withGuide(async ({ container, receive, button, click }) => {
        await receive(persistedSetup(6));
        expect(button("调整建议").disabled).toBe(true);
        expect(button("应用此建议").disabled).toBe(true);
        await click("调整建议");
        await click("应用此建议");
        expect(settingsWrites).toEqual([]);
        expect(otherWrites).toBe(0);
        expect(container.querySelector(".drama-guide-style-description")?.textContent).toBe(originalSettings.stylePrompt);
        expect(container.textContent).not.toContain("有尚未保存的调整");
    });
});
