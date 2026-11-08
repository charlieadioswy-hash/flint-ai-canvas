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
let renderSetupChoices: (() => void) | null = null;
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
        renderSetupChoices?.();
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
    const chatHost = document.createElement("div");
    chatHost.setAttribute("aria-label", "创作对话操作");
    const choicesHost = document.createElement("div");
    const actionsHost = document.createElement("div");
    chatHost.append(choicesHost, actionsHost);
    const choicesRoot = createRoot(choicesHost);
    renderSetupChoices = () => {
        const choices = dramaContext?.setupChoices;
        choicesRoot.render(choices ? choices.render(choices.proposals) : null);
    };
    const button = (label: string) => {
        const found =
            Array.from(container.querySelector('[aria-label="创作对话操作"]')?.querySelectorAll("button") || []).find((item) => item.textContent?.trim() === label) ||
            Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === label) ||
            Array.from(container.querySelectorAll<HTMLButtonElement>(".drama-guide-setup-choice")).find((item) => item.querySelector("strong")?.textContent?.trim() === label);
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
        container.querySelector(".drama-guide-agent-host")!.append(chatHost);
        await act(async () => {
            dramaContext!.onActionsHost!(actionsHost);
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
                expect(actionsHost.querySelector(".drama-guide-setup-choice")).toBeNull();
            },
            click: async (label) => {
                await act(async () => {
                    button(label).click();
                    await settle();
                });
            },
        });
    } finally {
        renderSetupChoices = null;
        await act(async () => {
            root.unmount();
            choicesRoot.unmount();
        });
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

test("旧像素尺寸选项显示不支持原因和重新推荐，不能误写配置", async () => {
    await withGuide(async ({ container, chatHost, receive, click }) => {
        await receive(persistedSetup());
        expect(settingsWrites).toEqual([]);
        expect(chatHost.querySelectorAll(".drama-guide-setup-choice")).toHaveLength(1);
        expect(container.querySelector('[aria-label="创作产物"] .drama-guide-setup-choice')).toBeNull();
        expect(chatHost.textContent).not.toContain("应用此建议");
        expect(chatHost.textContent).not.toContain("调整建议");
        const choice = chatHost.querySelector<HTMLButtonElement>(".drama-guide-setup-choice")!;
        expect(choice.disabled).toBe(true);
        expect(choice.getAttribute("aria-describedby")).toBeTruthy();
        expect(chatHost.querySelector(".drama-guide-setup-choice-problem")?.textContent).toContain("不支持");
        await act(async () => choice.click());
        expect(settingsWrites).toEqual([]);
        expect(otherWrites).toBe(0);
        expect(dramaContext?.prefillRequest ?? null).toBeNull();
        expect(summary.production.settings).toEqual(originalSettings);
        expect(container.textContent).not.toContain("有尚未保存的调整");
        await click("重新推荐创作方案");
        expect(dramaContext?.prefillRequest?.autoSubmit).toBe(true);
        expect(dramaContext?.prefillRequest?.text).toContain("读取当前真实配置与版本");
        expect(settingsWrites).toEqual([]);
        expect(otherWrites).toBe(0);
    });
});

test("点选可用方案立即携带CAS保存白名单配置并通知Agent继续", async () => {
    await withGuide(async ({ container, chatHost, receive, click }) => {
        const proposal = persistedSetup();
        proposal.changes.videoResolution = "1080p";
        await receive(proposal);
        expect(settingsWrites).toEqual([]);
        expect(chatHost.querySelectorAll(".drama-guide-setup-choice")).toHaveLength(1);
        await click("雨夜电影风格 · 9:16 · 1080p · 粤语 · 120 秒");
        expect(settingsWrites).toEqual([
            {
                projectId: "project",
                input: { expectedRevision: 7, settings: { ...originalSettings, aspectRatio: "9:16", videoResolution: "1080p", styleName: "雨夜电影风格", stylePrompt: "冷色雨幕与高反差电影照明", language: "粤语", episodeSeconds: 120 } },
            },
        ]);
        expect(chatHost.querySelectorAll(".drama-guide-setup-choice")).toHaveLength(0);
        expect(container.textContent).not.toContain("有尚未保存的调整");
        expect(otherWrites).toBe(0);
        expect(dramaContext?.prefillRequest?.autoSubmit).toBe(true);
        expect(dramaContext?.prefillRequest?.requireIdle).toBe(true);
        expect(dramaContext?.prefillRequest?.text).toContain("当前制作版本：8");
        expect(dramaContext?.prefillRequest?.text).toContain("继续下一项尚未确认的配置选择");
        expect(dramaContext?.prefillRequest?.text).not.toContain("untrusted");
        expect(notices).toEqual([]);
    });
});

test("有无关手动草稿时仍可直接选风格，保留草稿并以新版本继续保存", async () => {
    await withGuide(async ({ container, chatHost, receive, button, click }) => {
        await click("横屏 16:9");
        await receive({ ...persistedSetup(), changes: { styleName: "雨夜电影风格", stylePrompt: "冷色雨幕与高反差电影照明" } });
        await receive({ ...persistedSetup(), toolCallId: "other-style", changes: { styleName: "国风动画", stylePrompt: "水墨线条" } });
        expect(button("雨夜电影风格").disabled).toBe(false);
        await click("雨夜电影风格");
        const chosen = { ...originalSettings, styleName: "雨夜电影风格", stylePrompt: "冷色雨幕与高反差电影照明" };
        expect(settingsWrites).toEqual([{ projectId: "project", input: { expectedRevision: 7, settings: chosen } }]);
        expect(button("横屏 16:9").getAttribute("aria-checked")).toBe("true");
        expect(container.querySelector(".drama-guide-style-description")?.textContent).toBe(chosen.stylePrompt);
        expect(container.querySelector<HTMLSelectElement>('select[aria-label="对白语言"]')?.value).toBe(originalSettings.language);
        expect(container.textContent).toContain("有尚未保存的调整");
        expect(container.textContent).not.toContain("配置已有更新");
        expect(chatHost.querySelectorAll(".drama-guide-setup-choice")).toHaveLength(0);
        await click("保存调整");
        expect(settingsWrites).toEqual([
            { projectId: "project", input: { expectedRevision: 7, settings: chosen } },
            { projectId: "project", input: { expectedRevision: 8, settings: { ...chosen, aspectRatio: "16:9" } } },
        ]);
        expect(container.textContent).not.toContain("有尚未保存的调整");
        expect(otherWrites).toBe(0);
        expect(notices).toEqual([]);
    });
});

test("选择同组视频配置覆盖画幅和清晰度草稿，不遗留待保存状态", async () => {
    await withGuide(async ({ container, receive, button, click }) => {
        await click("横屏 16:9");
        await click("1080P");
        await receive({ ...persistedSetup(), changes: { videoResolution: "480p" } });
        expect(button("480p").disabled).toBe(false);
        await click("480p");
        expect(settingsWrites).toEqual([{ projectId: "project", input: { expectedRevision: 7, settings: { ...originalSettings, videoResolution: "480p" } } }]);
        expect(button("竖屏 9:16").getAttribute("aria-checked")).toBe("true");
        expect(button("480P").getAttribute("aria-checked")).toBe("true");
        expect(container.textContent).not.toContain("有尚未保存的调整");
        expect(notices).toEqual([]);
        expect(otherWrites).toBe(0);
    });
});

test("旧版本选项显示过期原因和重新推荐，不改草稿也不写后端", async () => {
    await withGuide(async ({ container, chatHost, receive, click }) => {
        await receive(persistedSetup(6));
        const choice = chatHost.querySelector<HTMLButtonElement>(".drama-guide-setup-choice")!;
        expect(choice.disabled).toBe(true);
        expect(chatHost.querySelector(".drama-guide-setup-choice-problem")?.textContent).toContain("此选项已过期");
        await act(async () => choice.click());
        expect(settingsWrites).toEqual([]);
        expect(otherWrites).toBe(0);
        expect(container.querySelector(".drama-guide-style-description")?.textContent).toBe(originalSettings.stylePrompt);
        expect(container.textContent).not.toContain("有尚未保存的调整");
        await click("重新推荐创作方案");
        expect(dramaContext?.prefillRequest?.autoSubmit).toBe(true);
        expect(settingsWrites).toEqual([]);
    });
});

test("每组可填写其他内容，发送真实偏好给Agent后由它返回可保存选项", async () => {
    await withGuide(async ({ chatHost, receive }) => {
        await receive({ ...persistedSetup(), changes: { styleName: "电影写实", stylePrompt: "自然光与真实材质" } });
        const input = chatHost.querySelector<HTMLInputElement>('input[aria-label="自定义视觉风格"]')!;
        expect(input.value).toBe("");
        const form = input.closest("form")!;
        expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
        await act(async () => {
            Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, "  怀旧港片，暖色胶片  ");
            input.dispatchEvent(new browser.Event("input", { bubbles: true }));
        });
        expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
        await act(async () => {
            form.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
            await settle();
        });
        expect(dramaContext?.prefillRequest?.autoSubmit).toBe(true);
        expect(dramaContext?.prefillRequest?.displayText).toBe("怀旧港片，暖色胶片");
        expect(dramaContext?.prefillRequest?.text).toContain("当前讨论项：风格名称、视觉风格");
        expect(dramaContext?.prefillRequest?.text).toContain("怀旧港片，暖色胶片");
        expect(dramaContext?.prefillRequest?.text).toContain("不声称已保存");
        expect(settingsWrites).toEqual([]);
        expect(otherWrites).toBe(0);
    });
});
