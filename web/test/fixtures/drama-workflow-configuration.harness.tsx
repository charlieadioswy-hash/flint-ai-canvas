import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, createRef, type ReactNode } from "react";
import type { DramaModelOption, DramaSettings, DramaSummary } from "@/services/api/drama";
import { DRAMA_STYLE_PROMPT_MAX_LENGTH } from "@/lib/drama/style-limits";

const browser = new Window({ url: "http://localhost" });
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
}))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
let option: DramaModelOption;
mock.module("antd", () => ({
    App: { useApp: () => ({ modal: { confirm: () => undefined } }) },
    Button: ({ children, type: _type, size: _size, ...props }: Record<string, unknown>) => createElement("button", props, children as ReactNode),
    Input: Object.assign((props: Record<string, unknown>) => createElement("input", props), {
        TextArea: ({ autoSize: _autoSize, count, ...props }: { count?: { max: number; strategy: (value: string) => number }; value: string }) =>
            createElement("textarea", { ...props, "data-count-max": count?.max, "data-count": count?.strategy(props.value) }),
    }),
    Select: ({ options, onChange, ...props }: { options: Array<{ value: string; label: string; disabled?: boolean }>; onChange: (value: string) => void }) =>
        createElement(
            "select",
            { ...props, onChange: (event: Event) => onChange((event.target as HTMLSelectElement).value) },
            options.map((item) => createElement("option", { key: item.value, value: item.value, disabled: item.disabled }, item.label)),
        ),
}));
mock.module("@/components/ui/product/app-modal", () => ({ AppModal: () => null }));
mock.module("@/components/canvas/canvas-style-picker-modal", () => ({ CanvasStylePickerModal: () => null, canvasStylePresets: [], userStylePreset: () => undefined }));
mock.module("@/services/api/style-profiles", () => ({ listStyleProfiles: async () => ({ profiles: [] }) }));
mock.module("@/pages/projects/asset-scheme", () => ({ AssetSchemePicker: () => null, useAssetSchemes: () => ({ data: { schemes: [], sceneSchemes: [] } }) }));
mock.module("@/pages/projects/character-template-picker", () => ({ CharacterTemplatePicker: () => null }));
mock.module("@/pages/projects/drama-model-picker", () => ({ DramaModelPicker: () => null, useDramaModelCatalog: () => ({ data: { options: { video: [option], image: [] } } }) }));
mock.module("@/pages/projects/style-picker", () => ({ DramaStylePicker: () => null }));
mock.module("@/pages/projects/step-settings", () => ({
    DramaAssetImageModels: () => null,
    DramaTextSteps: () => null,
    VideoResolutionField: () => (
        <select aria-label="视频分辨率">
            <option>模型默认</option>
        </select>
    ),
}));
mock.module("@/pages/projects/storyboard-rules", () => ({ EpisodeDurationInput: () => null, StoryboardRules: () => null }));
const { WorkflowConfiguration } = await import("@/pages/projects/workflow-configuration");
import type { WorkflowConfigurationHandle } from "@/pages/projects/workflow-configuration";

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const baseSettings = {
    styleName: "自定义",
    stylePrompt: "明亮画面",
    aspectRatio: "9:16",
    language: "中文",
    videoContinuity: "parallel",
    models: { video: { logicalModelId: "test-video" } },
    assets: { scenePrompt: "", characterPrompt: "" },
} as DramaSettings;
async function mount(settings: DramaSettings, overrides: Partial<DramaModelOption>, styleOnly = false, scope: "project" | "episode" = "project") {
    option = { choice: { logicalModelId: "test-video" }, videoRatios: ["9:16", "16:9"], videoResolutions: ["720p"], tailFrameChain: true, ...overrides } as DramaModelOption;
    const host = document.createElement("div");
    const sentinel = document.createElement("button");
    sentinel.textContent = "原焦点";
    document.body.append(sentinel, host);
    sentinel.focus();
    const root = createRoot(host);
    const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const ref = createRef<WorkflowConfigurationHandle>();
    const changes: DramaSettings[] = [];
    await act(async () => {
        root.render(
            <QueryClientProvider client={query}>
                <button onClick={() => ref.current?.focusIssue()}>定位首项错误</button>
                <WorkflowConfiguration ref={ref} summary={{ production: { chapterCount: 0 } } as DramaSummary} settings={settings} disabled={false} styleOnly={styleOnly} scope={scope} onChange={(next) => changes.push(next)} />
            </QueryClientProvider>,
        );
        await settle();
    });
    await act(settle);
    return {
        host,
        sentinel,
        changes,
        close: async () => {
            await act(async () => root.unmount());
            query.clear();
            host.remove();
            sentinel.remove();
        },
    };
}
async function click(element: HTMLElement) {
    await act(async () => {
        element.click();
        await settle();
    });
}
function parameterSections(host: HTMLElement) {
    const summary = [...host.querySelectorAll<HTMLElement>(".drama-workflow-config-form > details > summary")].find((item) => item.textContent?.trim() === "制作参数");
    if (!summary) throw new Error("未找到制作参数区域");
    const parameters = summary.parentElement as HTMLDetailsElement;
    const advancedSummary = [...parameters.querySelectorAll<HTMLElement>("details > summary")].find((item) => item.textContent?.trim() === "更多参数");
    if (!advancedSummary) throw new Error("未找到更多参数区域");
    return [parameters, advancedSummary.parentElement as HTMLDetailsElement];
}
afterAll(() => browser.happyDOM.abort());

test("画幅错误自动展开外层但保留原焦点，用户定位后才聚焦画幅", async () => {
    const view = await mount(baseSettings, { videoRatios: ["16:9"] });
    try {
        expect(parameterSections(view.host).map((item) => item.open)).toEqual([true, false]);
        expect(document.activeElement).toBe(view.sentinel);
        const alert = [...view.host.querySelectorAll('[role="alert"]')].find((item) => item.textContent?.includes("画幅"));
        await click(alert!.querySelector<HTMLButtonElement>("button")!);
        expect(view.host.querySelector('[role="radiogroup"]')?.contains(document.activeElement)).toBe(true);
    } finally {
        await view.close();
    }
});

test("尾帧能力错误展开两层不抢焦点，点击对应错误定位视频衔接", async () => {
    const view = await mount({ ...baseSettings, videoContinuity: "tail_frame" }, { tailFrameChain: false });
    try {
        expect(parameterSections(view.host).map((item) => item.open)).toEqual([true, true]);
        expect(document.activeElement).toBe(view.sentinel);
        const alert = [...view.host.querySelectorAll('[role="alert"]')].find((item) => item.textContent?.includes("尾帧续接"));
        await click(alert!.querySelector<HTMLButtonElement>("button")!);
        expect(document.activeElement?.getAttribute("aria-label")).toBe("视频衔接");
    } finally {
        await view.close();
    }
});

test("分辨率错误只展开外层，错误旁定位到对应分辨率控件", async () => {
    const view = await mount({ ...baseSettings, videoResolution: "1080p" }, {});
    try {
        expect(parameterSections(view.host).map((item) => item.open)).toEqual([true, false]);
        expect(document.activeElement).toBe(view.sentinel);
        const alert = [...view.host.querySelectorAll('[role="alert"]')].find((item) => item.textContent?.includes("分辨率"));
        await click(alert!.querySelector<HTMLButtonElement>("button")!);
        expect(document.activeElement?.getAttribute("aria-label")).toBe("视频分辨率");
    } finally {
        await view.close();
    }
});

test("本集对白语言置顶且制作参数默认收起，完整长提示词按统一Unicode上限计数", async () => {
    const prompt = "🎨".repeat(DRAMA_STYLE_PROMPT_MAX_LENGTH);
    const view = await mount({ ...baseSettings, stylePrompt: prompt }, {}, false, "episode");
    try {
        const [parameters] = parameterSections(view.host);
        expect(parameterSections(view.host).map((item) => item.open)).toEqual([false, false]);
        expect(view.host.textContent).not.toContain("绘图配置（本集）");
        expect(view.host.textContent).not.toContain("绘图配置（作品）");
        const language = view.host.querySelector<HTMLSelectElement>('[aria-label="对白语言"]')!;
        expect(language.disabled).toBe(false);
        expect(view.host.querySelector(".drama-workflow-drawing-form label")?.contains(language)).toBe(true);
        expect(parameters.contains(language)).toBe(false);
        await act(async () => {
            language.value = "日语";
            language.dispatchEvent(new Event("change", { bubbles: true }));
            await settle();
        });
        expect(view.changes.at(-1)?.language).toBe("日语");
        await click(parameters.querySelector<HTMLElement>("summary")!);
        expect(parameters.open).toBe(true);
        const ratio = view.host.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="false"]')!;
        expect(ratio.disabled).toBe(false);
        await click(ratio);
        expect(view.changes.at(-1)?.aspectRatio).toBe("16:9");
        const custom = [...view.host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "自定义风格");
        await click(custom!);
        const input = view.host.querySelector<HTMLTextAreaElement>("textarea");
        expect(input?.value).toBe(prompt);
        expect(input?.dataset.countMax).toBe(String(DRAMA_STYLE_PROMPT_MAX_LENGTH));
        expect(input?.dataset.count).toBe(String(DRAMA_STYLE_PROMPT_MAX_LENGTH));
        expect(input?.hasAttribute("maxlength")).toBe(false);
    } finally {
        await view.close();
    }
});
