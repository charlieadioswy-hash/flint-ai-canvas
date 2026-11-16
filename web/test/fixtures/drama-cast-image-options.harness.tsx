import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { DramaCast, DramaModelChoice, DramaSummary } from "../../src/services/api/drama";

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
            { choice: { channelId: "ch", modelKey: "one" }, imageRatios: ["16:9", "1:1"], imageResolutions: ["1k", "2k"] },
            { choice: { channelId: "ch", modelKey: "two" }, imageRatios: ["16:9"], imageResolutions: ["1k"] },
        ],
    },
};
mock.module("../../src/pages/projects/drama-model-picker", () => ({
    useDramaModelCatalog: () => ({ data: fixtureCatalog }),
    DramaModelPicker: ({ value, onChange }: { value?: DramaModelChoice; onChange: (choice: DramaModelChoice) => void }) => (
        <select aria-label="资产图片模型" value={value?.modelKey || "one"} onChange={(event) => onChange({ channelId: "ch", modelKey: event.target.value })}>
            <option value="one">one</option>
            <option value="two">two</option>
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
const summary = { project: { id: "test" }, production: { revision: 9, settings: { models: { image: { channelId: "ch", modelKey: "one" } } } } } as DramaSummary;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
let queries: InstanceType<typeof QueryClient> | undefined;
let changed = 0;
let dirty = false;
const onDirty = (value: boolean) => {
    dirty = value;
};
async function mount(cast = fixture, disabled = false) {
    useUserStore.setState({ user: { id: "user-a" } as never });
    spyOn(api, "getDrama").mockResolvedValue(summary);
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
                    <CastImageOptions projectId="test" cast={cast} disabled={disabled} onChanged={() => changed++} onDirtyChange={onDirty} />
                </App>
            </QueryClientProvider>,
        ),
    );
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
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    queries?.clear();
    document.body.replaceChildren();
    mock.restore();
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
    expect(section.textContent).toContain("保存后仅影响下次生成，已有图片和提示词保留");
    expect([...section.querySelectorAll("button")].some((item) => item.textContent?.trim() === "图片生成配置")).toBe(false);
    expect(section.querySelector("button[aria-expanded]")).toBeNull();
    expect(api.getDrama).toHaveBeenCalledTimes(1);
    expect(changed).toBe(0);
    expect(dirty).toBe(false);
});

test("保存独立模型和参考组时使用作品与资产两种版本，不触发生图", async () => {
    const save = spyOn(api, "updateDramaCastImageOptions").mockResolvedValue({ cast: fixture });
    await mount({ ...fixture, imageOptionsJson: JSON.stringify({ subjectReferenceIds: ["subject"], styleReferenceIds: ["style"] }) });
    expect(document.querySelector('[data-resource="subject"]')).not.toBeNull();
    expect(document.querySelector('[data-resource="style"]')).not.toBeNull();
    await changeModel("two");
    expect(dirty).toBe(true);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="移除主体参考 1"]')!.click());
    await click("保存图片配置");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]).toEqual(["test", "cast", 9, 3, { model: { channelId: "ch", modelKey: "two" }, ratio: "", resolution: "", subjectReferenceIds: [], styleReferenceIds: ["style"] }]);
    expect(changed).toBe(1);
    expect(dirty).toBe(false);
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
test("保存失败保留草稿和脏状态，可显式重试", async () => {
    const save = spyOn(api, "updateDramaCastImageOptions").mockRejectedValueOnce(new Error("版本变化"));
    await mount();
    await changeModel("two");
    await click("保存图片配置");
    expect(dirty).toBe(true);
    expect(changed).toBe(0);
    save.mockResolvedValue({ cast: fixture });
    await click("保存图片配置");
    expect(save).toHaveBeenCalledTimes(2);
    expect(changed).toBe(1);
});
test("禁用时不能修改配置或提交", async () => {
    const save = spyOn(api, "updateDramaCastImageOptions").mockResolvedValue({ cast: fixture });
    await mount(fixture, true);
    await changeModel("two");
    await click("保存图片配置");
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
    await click("保存图片配置");
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
    await click("保存图片配置");
    expect(save).not.toHaveBeenCalled();
    await click("重新配置");
    await click("保存图片配置");
    expect(save).toHaveBeenCalledTimes(1);
});
