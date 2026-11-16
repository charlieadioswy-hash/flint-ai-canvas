import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { DramaCast, DramaModelChoice, DramaSettings, DramaSummary } from "../../src/services/api/drama";

const dom = new Window({ url: "http://localhost/projects/test" });
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
}))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { App } = await import("antd");
const api = await import("../../src/services/api/drama");
const { useUserStore } = await import("../../src/stores/use-user-store");
const fixtureCatalog = {
    options: {
        image: [
            { choice: { channelId: "ch", modelKey: "one" }, imageRatios: ["16:9", "9:16", "1:1", "3:2"], imageResolutions: ["1k", "2k", "4k"], defaultImageResolution: "2k" },
            { choice: { channelId: "ch", modelKey: "two" }, imageRatios: ["16:9", "9:16", "1:1", "3:2"], imageResolutions: ["1k", "2k", "4k"], defaultImageResolution: "1k" },
            { choice: { channelId: "ch", modelKey: "three" }, imageRatios: ["16:9", "9:16", "1:1", "3:2"], imageResolutions: ["1k", "2k", "4k"], defaultImageResolution: "4k" },
            { choice: { channelId: "ch", modelKey: "no-default" }, imageRatios: ["16:9", "9:16"], imageResolutions: ["1k", "2k", "4k"] },
        ],
    },
};
let catalogPending = false;
mock.module("../../src/pages/projects/drama-model-picker", () => ({
    useDramaModelCatalog: () => ({ data: catalogPending ? undefined : fixtureCatalog, isPending: catalogPending }),
    DramaModelPicker: ({ value, onChange }: { value?: DramaModelChoice; onChange: (choice: DramaModelChoice) => void }) => (
        <select aria-label="资产图片模型" value={value?.modelKey || "one"} onChange={(event) => onChange({ channelId: "ch", modelKey: event.target.value })}>
            <option value="one">one</option>
            <option value="two">two</option>
            <option value="three">three</option>
            <option value="no-default">no-default</option>
        </select>
    ),
}));
mock.module("../../src/pages/projects/drama-shared", () => ({ MediaThumb: ({ resourceId, alt }: { resourceId: string; alt: string }) => <img data-resource={resourceId} alt={alt} /> }));
let pickError = "";
mock.module("../../src/pages/projects/studio/cast-library-picker", () => ({
    CastLibraryPicker: ({ onPick, onClose, referenceGroup }: { onPick: (id: string) => Promise<void>; onClose: () => void; referenceGroup: string }) => (
        <div role="dialog" aria-label={`添加${referenceGroup}参考`}>
            <button
                onClick={() =>
                    void onPick("picked-resource")
                        .then(onClose)
                        .catch((error) => {
                            pickError = error.message;
                        })
                }
            >
                选用资源
            </button>
        </div>
    ),
}));
const { CastImageOptions, readCastImageOptions } = await import("../../src/pages/projects/studio/cast-image-options");
const fixture: DramaCast = {
    id: "cast",
    revision: 3,
    projectId: "test",
    kind: "character",
    name: "秦子文",
    aliasesJson: "[]",
    appearance: "黑发",
    description: "",
    role: "",
    voiceInstructions: "",
    importance: 1,
    imageStatus: "draft",
    imageVersion: 0,
    position: 0,
    locked: false,
};
const summary = {
    project: { id: "test", aspectRatio: "1:1" },
    production: {
        revision: 9,
        settings: {
            aspectRatio: "1:1",
            assets: { mode: "closeup_turnaround", characterPrompt: "角色模板", scenePrompt: "场景模板", characterRatio: "9:16" },
            models: { image: { channelId: "ch", modelKey: "one" } },
        },
    },
} as DramaSummary;

function configured(patch: Partial<DramaSettings> = {}): DramaSummary {
    return { ...summary, production: { ...summary.production, settings: { ...summary.production.settings, ...patch } } };
}
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
let queries: InstanceType<typeof QueryClient> | undefined;
let changed = 0;
let dirty = false;
const onDirty = (value: boolean) => {
    dirty = value;
};
async function mount(cast = fixture, disabled = false, episodeId?: string, configuration = summary) {
    useUserStore.setState({ user: { id: "user-a" } as never });
    spyOn(api, "getDrama").mockResolvedValue(configuration);
    changed = 0;
    dirty = false;
    pickError = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
        root!.render(
            <QueryClientProvider client={queries!}>
                <App>
                    <CastImageOptions projectId="test" episodeId={episodeId} cast={cast} disabled={disabled} onChanged={() => changed++} onDirtyChange={onDirty} />
                </App>
            </QueryClientProvider>,
        ),
    );
    await settle();
    if (episodeId) for (let index = 0; index < 4; index += 1) await settle();
}
async function waitForAutoSave() {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 420)));
    await settle();
}
async function settle() {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
function button(text: string, index = 0) {
    const result = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((item) => item.textContent?.trim() === text)[index];
    expect(result, text).toBeDefined();
    return result!;
}
async function click(text: string, index = 0) {
    await act(async () => button(text, index).click());
    await settle();
}
async function changeModel(value: string) {
    const input = document.querySelector<HTMLSelectElement>('[aria-label="资产图片模型"]')!;
    await act(async () => {
        input.value = value;
        input.dispatchEvent(new Event("change", { bubbles: true }));
    });
}
function selectedText(label: string) {
    const select = host.querySelector(`[aria-label="${label}"]`)?.closest(".ant-select");
    expect(select, label).not.toBeNull();
    const selected = select?.querySelector(".ant-select-content");
    expect(selected, label).not.toBeNull();
    return selected!.textContent?.trim();
}
async function openSelect(label: string) {
    const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    await act(async () => input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
    await settle();
}
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    queries?.clear();
    document.body.replaceChildren();
    mock.restore();
    catalogPending = false;
    root = undefined;
});

test("图片配置默认显示完整表单并读取作品配置，没有重复标题或折叠开关", async () => {
    await mount();
    const section = host.querySelector('[aria-label="图片生成配置"]')!;
    expect(section).not.toBeNull();
    expect(section.querySelector('[aria-label="资产图片模型"]')).not.toBeNull();
    expect(section.querySelector('[aria-label="资产图片画幅"]')).not.toBeNull();
    expect(section.querySelector('[aria-label="资产图片分辨率"]')).not.toBeNull();
    expect(section.textContent).toContain("主体参考");
    expect(section.textContent).toContain("风格参考");
    expect(section.textContent).toContain("修改后自动生效");
    expect(section.textContent).not.toContain("保存图片配置");
    expect([...section.querySelectorAll("button")].some((item) => item.textContent?.trim() === "图片生成配置")).toBe(false);
    expect(section.querySelector("button[aria-expanded]")).toBeNull();
    expect(api.getDrama).toHaveBeenCalledTimes(1);
    expect(changed).toBe(0);
    expect(dirty).toBe(false);
});

for (const scope of ["project", "episode"] as const) {
    for (const target of [
        { label: "角色", kind: "character" as const },
        { label: "造型", kind: "character" as const, parentId: "hero" },
        { label: "场景", kind: "scene" as const },
        { label: "道具", kind: "prop" as const },
    ]) {
        test(`${scope === "episode" ? "本集" : "作品"}${target.label}显示实际画幅和分辨率，读取不会写入资产覆盖或触发保存`, async () => {
            const configuration = configured({
                assets: { ...summary.production.settings.assets, resolution: "1k", sceneResolution: "4k", propResolution: "2k" },
                models: { ...summary.production.settings.models, sceneImage: { channelId: "ch", modelKey: "two" }, propImage: { channelId: "ch", modelKey: "three" } },
            });
            const ownSettings = {
                ...configuration.production.settings,
                assets: { ...summary.production.settings.assets, characterRatio: "3:2" },
                models: { ...summary.production.settings.models, characterImage: { channelId: "ch", modelKey: "three" }, sceneImage: {}, propImage: { channelId: "ch", modelKey: "two" } },
            };
            const episodeId = scope === "episode" ? "episode-two" : undefined;
            if (episodeId) spyOn(api, "getDramaEpisodeStyle").mockResolvedValue({ projectId: "test", episodeId, revision: 9, episodeRevision: 3, settings: ownSettings });
            const save = spyOn(api, "updateDramaCastImageOptions").mockResolvedValue({ cast: fixture });
            const cast = { ...fixture, id: `${scope}-${target.label}`, kind: target.kind, ...(target.parentId ? { parentId: target.parentId, lookName: "雨夜" } : {}) };
            const originalCast = JSON.stringify(cast);
            const originalConfiguration = JSON.stringify(configuration);
            await mount(cast, false, episodeId, configuration);
            const effectiveModels = scope === "episode" ? { character: "three", scene: "one", prop: "two" } : { character: "one", scene: "two", prop: "three" };
            const effectiveResolutions = scope === "episode" ? { character: "4K", scene: "2K", prop: "1K" } : { character: "1K", scene: "4K", prop: "2K" };
            expect(document.querySelector<HTMLSelectElement>('[aria-label="资产图片模型"]')?.value).toBe(effectiveModels[target.kind]);
            expect(selectedText("资产图片画幅")).toBe(target.kind === "character" ? (episodeId ? "3:2" : "9:16") : "16:9");
            expect(selectedText("资产图片分辨率")).toBe(effectiveResolutions[target.kind]);
            expect(host.textContent).not.toContain(`使用${episodeId ? "本集" : "作品"}画幅`);
            expect(host.textContent).not.toContain(`使用${episodeId ? "本集" : "作品"}分辨率`);
            expect(dirty).toBe(false);
            expect(changed).toBe(0);
            await waitForAutoSave();
            expect(save).not.toHaveBeenCalled();
            expect(JSON.stringify(cast)).toBe(originalCast);
            expect(JSON.stringify(configuration)).toBe(originalConfiguration);
        });
    }
}

test("保存独立模型和参考组时使用作品与资产两种版本，不触发生图", async () => {
    const save = spyOn(api, "updateDramaCastImageOptions").mockResolvedValue({ cast: fixture });
    await mount({ ...fixture, imageOptionsJson: JSON.stringify({ model: { channelId: "ch", modelKey: "three" }, ratio: "1:1", resolution: "4k", subjectReferenceIds: ["subject"], styleReferenceIds: ["style"] }) });
    expect(document.querySelector('[data-resource="subject"]')).not.toBeNull();
    expect(document.querySelector('[data-resource="style"]')).not.toBeNull();
    expect(selectedText("资产图片画幅")).toBe("1:1");
    expect(selectedText("资产图片分辨率")).toBe("4K");
    await changeModel("two");
    expect(selectedText("资产图片画幅")).toBe("9:16");
    expect(selectedText("资产图片分辨率")).toBe("1K");
    expect(dirty).toBe(true);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="移除主体参考 1"]')!.click());
    await waitForAutoSave();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]).toEqual(["test", "cast", 9, 3, { model: { channelId: "ch", modelKey: "two" }, ratio: "", resolution: "", subjectReferenceIds: [], styleReferenceIds: ["style"] }]);
    expect(changed).toBe(1);
    expect(dirty).toBe(false);
});

test("资产显式模型画幅和分辨率覆盖分类配置，读取保持原覆盖不变", async () => {
    const configuration = configured({
        assets: { ...summary.production.settings.assets, sceneResolution: "4k" },
        models: { ...summary.production.settings.models, sceneImage: { channelId: "ch", modelKey: "three" } },
    });
    const imageOptionsJson = JSON.stringify({ model: { channelId: "ch", modelKey: "two" }, ratio: "1:1", resolution: "2k", subjectReferenceIds: [], styleReferenceIds: [] });
    const cast = { ...fixture, kind: "scene" as const, imageOptionsJson };
    const save = spyOn(api, "updateDramaCastImageOptions").mockResolvedValue({ cast });
    await mount(cast, false, undefined, configuration);
    expect(document.querySelector<HTMLSelectElement>('[aria-label="资产图片模型"]')?.value).toBe("two");
    expect(selectedText("资产图片画幅")).toBe("1:1");
    expect(selectedText("资产图片分辨率")).toBe("2K");
    expect(dirty).toBe(false);
    await waitForAutoSave();
    expect(save).not.toHaveBeenCalled();
    expect(cast.imageOptionsJson).toBe(imageOptionsJson);
});

test("恢复配置模型后展示分类模型实际默认，保存仍清空模型画幅分辨率覆盖", async () => {
    const configuration = configured({
        assets: { ...summary.production.settings.assets, characterRatio: "3:2" },
        models: { ...summary.production.settings.models, characterImage: { channelId: "ch", modelKey: "three" } },
    });
    const save = spyOn(api, "updateDramaCastImageOptions").mockResolvedValue({ cast: fixture });
    await mount({ ...fixture, imageOptionsJson: JSON.stringify({ model: { channelId: "ch", modelKey: "two" }, ratio: "1:1", resolution: "1k", subjectReferenceIds: ["subject"] }) }, false, undefined, configuration);
    expect(selectedText("资产图片画幅")).toBe("1:1");
    expect(selectedText("资产图片分辨率")).toBe("1K");
    await click("使用作品模型");
    expect(document.querySelector<HTMLSelectElement>('[aria-label="资产图片模型"]')?.value).toBe("three");
    expect(selectedText("资产图片画幅")).toBe("3:2");
    expect(selectedText("资产图片分辨率")).toBe("4K");
    expect(dirty).toBe(true);
    await waitForAutoSave();
    expect(save.mock.calls[0]?.[4]).toEqual({ model: {}, ratio: "", resolution: "", subjectReferenceIds: ["subject"], styleReferenceIds: [] });
    expect(dirty).toBe(false);
});

test("只保存新增参考图时不会把显示的默认值写成资产覆盖", async () => {
    const save = spyOn(api, "updateDramaCastImageOptions").mockResolvedValue({ cast: fixture });
    await mount();
    expect(selectedText("资产图片画幅")).toBe("9:16");
    expect(selectedText("资产图片分辨率")).toBe("2K");
    expect(dirty).toBe(false);
    await click("从资产库添加", 0);
    await click("选用资源");
    await waitForAutoSave();
    expect(save.mock.calls[0]?.[4]).toEqual({ model: {}, ratio: "", resolution: "", subjectReferenceIds: ["picked-resource"], styleReferenceIds: [] });
    expect(dirty).toBe(false);
});

test("模型未声明默认分辨率时明确未提供，不把首个可选档位当默认", async () => {
    const configuration = configured({ models: { ...summary.production.settings.models, image: { channelId: "ch", modelKey: "no-default" } } });
    const save = spyOn(api, "updateDramaCastImageOptions").mockResolvedValue({ cast: fixture });
    await mount(fixture, false, undefined, configuration);
    expect(selectedText("资产图片画幅")).toBe("9:16");
    expect(selectedText("资产图片分辨率")).toBe("未提供分辨率");
    expect(dirty).toBe(false);
    await waitForAutoSave();
    expect(save).not.toHaveBeenCalled();
    await openSelect("资产图片分辨率");
    const fourK = [...document.querySelectorAll<HTMLElement>(".ant-select-item-option-content")].find((option) => option.textContent?.trim() === "4K");
    expect(fourK).toBeDefined();
    await act(async () => fourK!.click());
    await settle();
    expect(selectedText("资产图片分辨率")).toBe("4K");
    await openSelect("资产图片分辨率");
    const options = [...document.querySelectorAll<HTMLElement>(".ant-select-item-option-content")].map((option) => option.textContent?.trim());
    expect(options).toContain("未提供分辨率");
    expect(options).not.toContain("4K（模型默认）");
    expect(options).not.toContain("4K（作品配置）");
    expect(save).not.toHaveBeenCalled();
});

test("模型目录读取中保留已知画幅并显示分辨率读取状态，不写默认覆盖", async () => {
    catalogPending = true;
    const save = spyOn(api, "updateDramaCastImageOptions").mockResolvedValue({ cast: fixture });
    await mount();
    expect(selectedText("资产图片画幅")).toBe("9:16");
    expect(selectedText("资产图片分辨率")).toBe("正在读取…");
    expect(dirty).toBe(false);
    await waitForAutoSave();
    expect(save).not.toHaveBeenCalled();
    expect(changed).toBe(0);
});

test("本集资产图片默认使用本集模型，保存带当前集且不改全剧缓存", async () => {
    const ownSettings = { ...summary.production.settings, models: { image: { channelId: "ch", modelKey: "two" } } };
    spyOn(api, "getDramaEpisodeStyle").mockResolvedValue({ projectId: "test", episodeId: "episode-two", revision: 9, episodeRevision: 3, settings: ownSettings });
    const save = spyOn(api, "updateDramaCastImageOptions").mockResolvedValue({ cast: fixture });
    await mount(fixture, false, "episode-two");
    expect(document.querySelector<HTMLSelectElement>('[aria-label="资产图片模型"]')?.value).toBe("two");
    expect(host.textContent).toContain("使用本集模型");
    await changeModel("one");
    await waitForAutoSave();
    expect(save.mock.calls[0]?.[5]).toBe("episode-two");
    expect(queries?.getQueryData<DramaSummary>(["drama", "test"])?.production.settings.models.image.modelKey).not.toBe("two");
    expect(summary.production.settings.models.image.modelKey).toBe("one");
});

test("读取本集图片配置失败不会误用作品模型保存", async () => {
    spyOn(api, "getDramaEpisodeStyle").mockRejectedValue(new Error("读取失败"));
    const save = spyOn(api, "updateDramaCastImageOptions").mockResolvedValue({ cast: fixture });
    await mount(fixture, false, "episode-two");
    expect(host.textContent).toContain("本集图片配置读取失败");
    await waitForAutoSave();
    expect(save).not.toHaveBeenCalled();
});
test("素材引用只添加到所选分组，两组不允许重复引用同一资源", async () => {
    await mount();
    await click("从资产库添加", 0);
    await click("选用资源");
    expect(document.querySelector('[data-resource="picked-resource"]')).not.toBeNull();
    await click("从资产库添加", 1);
    await click("选用资源");
    expect(pickError).toContain("已在参考组");
    expect(document.querySelectorAll('[data-resource="picked-resource"]').length).toBe(1);
});
test("自动保存失败保留草稿和脏状态，修改后再次自动保存", async () => {
    const save = spyOn(api, "updateDramaCastImageOptions").mockRejectedValueOnce(new Error("版本变化"));
    await mount();
    await changeModel("two");
    await waitForAutoSave();
    expect(dirty).toBe(true);
    expect(changed).toBe(0);
    save.mockResolvedValue({ cast: fixture });
    await changeModel("three");
    await waitForAutoSave();
    expect(save).toHaveBeenCalledTimes(2);
    expect(changed).toBe(1);
});
test("禁用时不能修改配置或提交", async () => {
    const save = spyOn(api, "updateDramaCastImageOptions").mockResolvedValue({ cast: fixture });
    await mount(fixture, true);
    await changeModel("two");
    await waitForAutoSave();
    expect(save).not.toHaveBeenCalled();
    expect(dirty).toBe(false);
});
test("账号切换隔离旧保存回执", async () => {
    let finish!: (value: { cast: DramaCast }) => void;
    spyOn(api, "updateDramaCastImageOptions").mockImplementation(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    await mount();
    await changeModel("two");
    await waitForAutoSave();
    await act(async () => useUserStore.setState({ user: { id: "user-b" } as never }));
    await act(async () => finish({ cast: fixture }));
    await settle();
    expect(changed).toBe(0);
    expect(dirty).toBe(false);
});
test("损坏配置不会自动变成空配置保存", async () => {
    expect(() => readCastImageOptions('{"styleReferenceIds":"bad"}')).toThrow();
    expect(() => readCastImageOptions('{"ratio":2}')).toThrow();
    const save = spyOn(api, "updateDramaCastImageOptions").mockResolvedValue({ cast: fixture });
    await mount({ ...fixture, imageOptionsJson: "broken" });
    expect(document.body.textContent).toContain("原图片配置无法读取");
    await changeModel("two");
    await waitForAutoSave();
    expect(save).not.toHaveBeenCalled();
    await click("重新配置");
    await waitForAutoSave();
    expect(save).toHaveBeenCalledTimes(1);
});
