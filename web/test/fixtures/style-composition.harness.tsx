import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { CanvasStylePreset } from "../../src/lib/canvas/canvas-style-system";
import type { CreateDramaInput, DramaDraft, DramaModelCatalog, DramaSummary } from "../../src/services/api/drama";

const dom = new Window({ url: "http://localhost/projects/new" });
const globals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    HTMLBodyElement: dom.HTMLBodyElement,
    HTMLHtmlElement: dom.HTMLHtmlElement,
    Element: dom.Element,
    Node: dom.Node,
    SVGElement: dom.SVGElement,
    ShadowRoot: dom.ShadowRoot,
    Event: dom.Event,
    MouseEvent: dom.MouseEvent,
    ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { MemoryRouter } = await import("react-router");
const { App } = await import("antd");
const { DramaStylePicker } = await import("../../src/pages/projects/style-picker");
const { composeDramaStyleId, findDramaStyle, parseDramaStyleId } = await import("../../src/lib/drama/drama-styles");

const catalog: DramaModelCatalog = {
    defaults: { text: { logicalModelId: "text" }, image: { logicalModelId: "image" }, video: { logicalModelId: "video" } },
    options: {
        text: [],
        image: [],
        video: [{ choice: { logicalModelId: "video" }, capability: "video", label: "Video", priceLabel: "", tailFrameChain: true, videoRatios: ["9:16", "16:9"] }],
    },
};
const myPreset = { id: "library-custom", title: "我的手绘风格", prompt: "细腻的纸张纹理，低饱和暖色光" } as CanvasStylePreset;
// 本组只替换无关的模型、技能、参考图控件；真实创建页负责草稿回填、settings 构建和提交。
mock.module("@/components/canvas/canvas-style-picker-modal", () => ({
    CanvasStylePickerModal: ({ open, onSelect }: { open: boolean; onSelect: (preset: CanvasStylePreset) => void }) =>
        open ? (
            <button type="button" onClick={() => onSelect(myPreset)}>
                采用我的手绘风格
            </button>
        ) : null,
}));
mock.module("../../src/pages/projects/drama-model-picker", () => ({ useDramaModelCatalog: () => ({ data: catalog }), DramaModelPicker: () => null }));
mock.module("../../src/pages/projects/asset-scheme", () => ({ useAssetSchemes: () => ({ data: undefined }), defaultAssetSettings: () => undefined, AssetSchemePicker: () => null }));
mock.module("../../src/pages/projects/step-settings", () => ({ DramaAssetImageModels: () => null, DramaTextSteps: () => null, VideoResolutionField: () => null }));
mock.module("../../src/pages/projects/storyboard-rules", () => ({ EpisodeDurationInput: () => null, StoryboardRules: () => null }));
const { default: DramaCreatePage } = await import("../../src/pages/projects/create");
const api = await import("../../src/services/api/drama");
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;

beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    mock.restore();
});
afterAll(() => {
    dom.happyDOM.abort();
    for (const [key, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

async function render(children: ReactNode) {
    await act(async () => root.render(<App>{children}</App>));
}
async function click(label: string, scope: ParentNode = host) {
    const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent?.replace(/\s/g, "") === label.replace(/\s/g, ""));
    expect(button).toBeDefined();
    await act(async () => button!.click());
}

function presetButton(name: string) {
    return [...host.querySelectorAll<HTMLElement>(".drama-style-name")].find((item) => item.textContent === name)?.closest<HTMLButtonElement>("button");
}

test("comic preset picker lists compatible animation formats and removes the composition controls", async () => {
    await render(<DramaStylePicker dramaType="comic" value="3d-guoman" onChange={() => {}} />);
    expect(host.querySelector('[aria-label="表现形式"]')).toBeNull();
    expect(host.querySelector('[aria-label="题材"]')).toBeNull();
    expect(host.querySelector('[aria-label="风格预设"]')).not.toBeNull();
    expect(presetButton("3D 国漫仙侠")?.getAttribute("aria-pressed")).toBe("true");
    expect(presetButton("都市霸总")).toBeUndefined();
});

test("live action preset picker selects complete presets by id", async () => {
    const changed = mock();
    await render(<DramaStylePicker dramaType="live_action" value="live-ceo" onChange={changed} />);
    expect(presetButton("都市霸总")?.getAttribute("aria-pressed")).toBe("true");
    expect(presetButton("3D 国漫仙侠")).toBeUndefined();
    await act(async () => presetButton("甜宠恋爱")!.click());
    expect(changed).toHaveBeenLastCalledWith("live-sweet");
});

test("switching drama type recomputes available preset categories", async () => {
    await render(<DramaStylePicker dramaType="comic" value="" onChange={() => {}} />);
    await click([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((item) => item.textContent?.startsWith("2D 漫剧"))!.textContent!);
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("2D 漫剧");
    await render(<DramaStylePicker dramaType="live_action" value="" onChange={() => {}} />);
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("全部");
    expect(presetButton("校园青春")).toBeDefined();
});

test("preset search cannot expose a preset from the other drama type", async () => {
    await render(<DramaStylePicker dramaType="live_action" value="" onChange={() => {}} />);
    const input = host.querySelector<HTMLInputElement>('[aria-label="搜索风格预设"]')!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, "3D 国漫仙侠");
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(presetButton("3D 国漫仙侠")).toBeUndefined();
});

test("disabled picker cannot apply a preset", async () => {
    const changed = mock();
    await render(<DramaStylePicker dramaType="live_action" value="live-ceo" onChange={changed} disabled />);
    expect(presetButton("甜宠恋爱")?.disabled).toBe(true);
    await act(async () => presetButton("甜宠恋爱")!.click());
    expect(changed).not.toHaveBeenCalled();
});

test("an empty selection emits no style change until an actual preset is selected", async () => {
    const changed = mock();
    await render(<DramaStylePicker dramaType="comic" value="" onChange={changed} />);
    expect(changed).not.toHaveBeenCalled();
    await act(async () => presetButton("3D 国漫仙侠")!.click());
    expect(changed).toHaveBeenCalledWith("3d-guoman");
});

test("historical composition details expose the saved name and prompt", async () => {
    const style = findDramaStyle(composeDramaStyleId("2d", "apocalypse"))!;
    await render(<DramaStylePicker dramaType="comic" value={style.id} onChange={() => {}} />);
    await click("查看风格详情");
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(style.name);
    expect(dialog.textContent).toContain(style.prompt);
    await click("关闭", dialog);
});

const sourceText = `第一章 回家\n${"林溪走进街角的咖啡馆，与许久未见的朋友聊起新的工作。".repeat(12)}`;
function savedDraft(styleId: string): DramaDraft {
    const style = findDramaStyle(styleId)!;
    return {
        projectId: "draft-style",
        name: "组合风格草稿",
        sourceFormat: "novel",
        settings: {
            aspectRatio: "16:9",
            episodeSeconds: 90,
            styleName: style.name,
            stylePrompt: style.prompt,
            language: "中文普通话",
            reviewMode: "sample",
            mediaMode: "manual",
            episodeMode: "chapter",
            chaptersPerEpisode: 1,
            videoContinuity: "parallel",
            models: catalog.defaults,
        } as DramaDraft["settings"],
        budgetMicrocredits: 0,
        selectedChapters: [0],
        chapterCount: 1,
        form: { sourceText, styleId },
    };
}
async function renderDraft(draft: DramaDraft) {
    client.setQueryData(["drama-draft", draft.projectId], draft);
    spyOn(api, "estimateDrama").mockResolvedValue({ episodes: 1, shots: 6, images: 0, videos: 0, textCalls: 1, minMicrocredits: 0, maxMicrocredits: 0, sampleMicrocredits: 0, priced: false, note: "", durationMinutes: 1 });
    await act(async () =>
        root.render(
            <QueryClientProvider client={client}>
                <MemoryRouter initialEntries={[`/projects/new?draft=${draft.projectId}`]}>
                    <App>
                        <DramaCreatePage />
                    </App>
                </MemoryRouter>
            </QueryClientProvider>,
        ),
    );
}

test("opening a historical draft preserves its style and adopting a preset writes a compatible id", async () => {
    const original = savedDraft(composeDramaStyleId("3d", "xuanhuan"));
    original.settings.dramaType = "comic";
    const save = spyOn(api, "saveDramaDraft").mockResolvedValue({ project: { id: original.projectId } } as DramaSummary);
    await renderDraft(original);
    expect(host.textContent).toContain(original.settings.styleName);
    const preset = findDramaStyle("3d-guoman")!;
    await act(async () => presetButton(preset.name)!.click());
    await click("保存为草稿");
    expect(save).toHaveBeenCalledTimes(1);
    const [projectId, input] = save.mock.calls[0];
    expect(projectId).toBe(original.projectId);
    expect(input.draft).toEqual({ sourceText, styleId: preset.id });
    expect(input.settings.styleName).toBe(preset.name);
    expect(input.settings.stylePrompt).toBe(preset.prompt);
    expect(input.settings.styleSelection).toEqual({ mode: "preset", presetId: preset.id });
    expect(input.settings.aspectRatio).toBe("16:9");
    const stored = JSON.parse(JSON.stringify(input)) as CreateDramaInput;
    await act(async () => root.unmount());
    client.clear();
    root = createRoot(host);
    await renderDraft({ ...original, settings: stored.settings as DramaDraft["settings"], form: stored.draft! });
    expect(presetButton(preset.name)?.getAttribute("aria-pressed")).toBe("true");
});

test("starting a restored draft uses the composition in settings", async () => {
    const draft = savedDraft(composeDramaStyleId("semi-realistic", "apocalypse"));
    const save = spyOn(api, "saveDramaDraft").mockResolvedValue({ project: { id: draft.projectId } } as DramaSummary);
    await renderDraft(draft);
    await click("开始改编剧本与分镜");
    expect(save).toHaveBeenCalledTimes(1);
    const input = save.mock.calls[0][1];
    expect(input.start).toBe(true);
    expect(input.draft).toBeUndefined();
    expect(input.settings.styleName).toBe("半写实 · 末日");
    expect(input.settings.stylePrompt).toBe(findDramaStyle(draft.form.styleId!)?.prompt);
    expect(parseDramaStyleId(draft.form.styleId!)).toEqual({ formId: "semi-realistic", themeId: "apocalypse" });
});

test("advanced creation keeps personal styles and saves their original prompt as custom", async () => {
    const draft = savedDraft(composeDramaStyleId("2d", "urban"));
    draft.settings.dramaType = "comic";
    const save = spyOn(api, "saveDramaDraft").mockResolvedValue({ project: { id: draft.projectId } } as DramaSummary);
    await renderDraft(draft);
    await click("风格库 / 我的风格");
    await click("采用我的手绘风格");
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="风格说明"]')?.value).toBe(myPreset.prompt);
    await click("保存为草稿");
    expect(save).toHaveBeenCalledTimes(1);
    const input = save.mock.calls[0][1];
    expect(input.settings).toMatchObject({
        dramaType: "comic",
        styleName: myPreset.title,
        stylePrompt: myPreset.prompt,
        styleSelection: { mode: "custom" },
    });
    expect(input.draft?.styleId).toBeUndefined();
});
