import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { DramaCast, DramaListPage, DramaSummary, DramaTake, DramaWorkflowImpact } from "../../src/services/api/drama";
import type { CastImageFieldsValue } from "../../src/pages/projects/studio/cast-image-fields";
import type { CastView } from "../../src/services/api/drama-cast-views";

const dom = new Window({ url: "http://localhost/projects/current" });
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
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { MemoryRouter, useLocation } = await import("react-router");
const { App } = await import("antd");
const { CastPanel } = await import("../../src/pages/projects/studio/panels");
const { CastEditorDialog } = await import("../../src/pages/projects/studio/cast-editor-dialog");
const { CastCreateDialog } = await import("../../src/pages/projects/studio/cast-create-dialog");
const { CastProjectImport } = await import("../../src/pages/projects/studio/cast-project-import");
const { WorkflowAssetLibrary } = await import("../../src/pages/projects/workflow-asset-library");
const { CastImageFields } = await import("../../src/pages/projects/studio/cast-image-fields");
const { composeDramaStyleId, findDramaStyle } = await import("../../src/lib/drama/drama-styles");
const api = await import("../../src/services/api/drama");
const viewApi = await import("../../src/services/api/drama-cast-views");
const characterApi = await import("../../src/services/api/drama-character-library");
const { dramaKeys } = await import("../../src/lib/drama/drama-query-keys");
const viewState = await import("../../src/pages/projects/studio/cast-views-state");
const resources = await import("../../src/services/api/resources");
const imageStorage = await import("../../src/services/image-storage");
const { ApiError } = await import("../../src/services/api/request");
const { useUserStore } = await import("../../src/stores/use-user-store");

function castFixture(id: string, name: string, patch: Partial<DramaCast> = {}): DramaCast {
    return {
        id,
        projectId: "current",
        kind: "character",
        name,
        aliasesJson: "[]",
        role: "",
        description: "",
        appearance: `${name}的初始外观`,
        voiceInstructions: "",
        importance: 1,
        imageStatus: "draft",
        imageVersion: 0,
        revision: 1,
        locked: false,
        position: 0,
        ...patch,
    };
}
const hero = castFixture("hero", "林溪", { imageStatus: "ready", imageResourceId: "hero-image" });
const evening = castFixture("evening-look", "林溪", { parentId: hero.id, lookName: "晚宴", appearance: "黑色礼服，银色耳饰", imagePrompt: "晚宴柔光", imageResourceId: "evening-image", imageStatus: "ready", lookFromChapter: 2, lookToChapter: 4 });
const childhood = castFixture("childhood-look", "林溪", { parentId: hero.id, lookName: "幼年", appearance: "童年短发，蓝色外套", imagePrompt: "保持幼年五官" });
function impactOf(castId: string, hasVideo = false): DramaWorkflowImpact {
    return {
        kind: "cast",
        castId,
        revision: 9,
        episodes: 2,
        segments: 2,
        affectedSegments: 2,
        assetIds: [castId],
        directSegments: [{ id: "direct-segment", episodeId: "episode-a", episodeNumber: 1, episodeTitle: "相遇", segmentIndex: 0, revision: 1, videoStatus: hasVideo ? "ready" : "none", hasVideo }],
        continuitySegments: [{ id: "following-segment", episodeId: "episode-b", episodeNumber: 2, episodeTitle: "重逢", segmentIndex: 1, revision: 1, videoStatus: hasVideo ? "ready" : "none", hasVideo }],
        message: "已核对真实资产引用",
    };
}
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;

beforeEach(() => {
    window.localStorage.setItem("yingce:active-user-scope", "workspace-user");
    useUserStore.setState({ user: { id: "workspace-user" } as never });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    spyOn(resources, "getResourceAccess").mockRejectedValue(new Error("No remote media in this fixture"));
    spyOn(api, "getDramaCastImpact").mockImplementation(async (_projectId, castId) => impactOf(castId));
    spyOn(api, "preflightDramaStudioBatch").mockImplementation(async (_project, input) => imageBatchQuote(input));
    spyOn(api, "getDrama").mockResolvedValue(dialogSummary);
    spyOn(api, "getDramaEpisodeStyle").mockImplementation(async (projectId, episodeId) => ({ projectId, episodeId, revision: dialogSummary.production.revision, episodeRevision: 1, settings: dialogSummary.production.settings }));
    spyOn(api, "listDramaTakes").mockResolvedValue({ takes: [] });
    spyOn(viewApi, "listDramaCastViews").mockResolvedValue({ views: [] });
    spyOn(viewApi, "preflightDramaCastView").mockImplementation(async (_project, _cast, _id, input) => ({
        revision: input.expectedRevision ?? dialogSummary.production.revision,
        viewRevision: input.viewRevision ?? 4,
        ready: true,
        priced: true,
        estimated: true,
        amountMicrocredits: 1_000_000,
        scopeHash: "view-scope",
        confirmationToken: "view-token",
    }));
    spyOn(viewApi, "quoteDramaCastViewDraft").mockImplementation(async (_project, _cast, _id, input) => ({
        revision: input.expectedRevision,
        viewRevision: input.viewRevision,
        ready: true,
        priced: true,
        estimated: true,
        amountMicrocredits: 1_000_000,
        scopeHash: "view-scope",
        confirmationToken: "",
    }));
    spyOn(viewState, "readCastViewPending").mockResolvedValue(undefined);
    spyOn(viewState, "writeCastViewPending").mockResolvedValue(undefined);
    spyOn(viewState, "clearCastViewPending").mockResolvedValue(undefined);
    spyOn(characterApi, "getDramaCharacterUsage").mockResolvedValue({
        hasStory: true,
        appearances: [{ episodeId: "episode-a", episodeNumber: 1, episodeTitle: "相遇", shotId: "shot-8", position: 7, segmentIndex: 0 }],
        imageReferences: [],
        audioReferences: [],
    });
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
    await act(async () =>
        root.render(
            <QueryClientProvider client={client}>
                <MemoryRouter initialEntries={["/projects/current/e/episode-a?mode=simple&segment=7&shot=shot-8"]}>
                    <App>{children}</App>
                </MemoryRouter>
            </QueryClientProvider>,
        ),
    );
}
function button(label: string, scope: ParentNode = document) {
    const result = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent?.replace(/\s/g, "") === label.replace(/\s/g, ""));
    expect(result, `button ${label}`).toBeDefined();
    return result!;
}
async function click(label: string, scope: ParentNode = document) {
    await act(async () => button(label, scope).click());
}
function imageGenerationButton(scope: ParentNode = document) {
    return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => /^(保存并)?生成图片\s*-/.test(item.textContent || ""))!;
}
async function clickImageGeneration(scope: ParentNode = document) {
    await settleUntil(() => Boolean(imageGenerationButton(scope) && !imageGenerationButton(scope).disabled));
    await act(async () => imageGenerationButton(scope).click());
}
async function fill(label: string, value: string, scope: ParentNode = document) {
    const input = scope.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
    expect(input, `field ${label}`).not.toBeNull();
    const prototype = input.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
    await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}
async function selectOption(label: string, text: string) {
    const input = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
    expect(input).not.toBeNull();
    await act(async () => input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    const option = [...document.querySelectorAll<HTMLElement>(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")].find((item) => item.textContent?.trim() === text);
    expect(option, `option ${text}`).toBeDefined();
    await act(async () => option!.click());
}
function checkbox(label: string, scope: ParentNode = document) {
    const labeled = scope.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${label}"]`);
    const wrapper = [...scope.querySelectorAll<HTMLLabelElement>("label")].find((item) => item.textContent?.trim() === label);
    const input = labeled || wrapper?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(input, `checkbox ${label}`).toBeDefined();
    return input!;
}
async function check(label: string, scope: ParentNode = document) {
    await act(async () => checkbox(label, scope).click());
}
async function chooseImageStyle(value: string) {
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="参考图风格"]')!;
    expect(select).not.toBeNull();
    await act(async () => {
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
    });
}
async function settle() {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
async function waitForAutoSave() {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 420)));
    await settle();
}

function castHistoryTake(version: number, resourceId: string, current: boolean): DramaTake {
    return { id: `hero-take-${version}`, ownerId: hero.id, kind: "cast", version, resourceId, current, createdAt: "2026-11-20T04:00:00Z", prompt: "", source: "pipeline" };
}

test("参考图历史打开所选原图，并使用当前参考图的缩放预览", async () => {
    const original = { ...hero, imageVersion: 3, imageResourceId: "current-hero-image" };
    const historyResourceId = "history-hero-image";
    const originalImageUrl = (storageKey?: string) => `https://example.test/${storageKey?.replace(/^resource:/, "")}.png`;
    const resolveImage = spyOn(imageStorage, "resolveImageUrl").mockImplementation(async (storageKey) => originalImageUrl(storageKey));
    const adopt = spyOn(api, "adoptDramaCastTake").mockRejectedValue(new Error("预览不应提交采用请求"));
    spyOn(api, "listDramaTakes").mockResolvedValue({ takes: [castHistoryTake(3, original.imageResourceId, true), castHistoryTake(2, historyResourceId, false)] });
    const onClose = mock();
    await render(<DialogHarness castId={hero.id} items={[original]} onClose={onClose} />);
    const editor = document.querySelector(".drama-cast-dialog")!;
    const currentTrigger = button(`放大查看${hero.name}的参考图`, editor);
    await act(async () => currentTrigger.click());
    await settleUntil(() => Boolean(document.querySelector(".canvas-image-preview-modal img")));
    const currentPreview = document.querySelector(".canvas-image-preview-modal")!;
    expect(currentPreview.querySelector<HTMLImageElement>("img")?.src).toBe(originalImageUrl(`resource:${original.imageResourceId}`));
    expect(currentPreview.textContent).not.toContain("采用此版本");
    await act(async () => currentPreview.querySelector<HTMLButtonElement>(".ant-modal-close")!.click());
    await settleUntil(() => !document.querySelector(".canvas-image-preview-modal"));

    const historyPanel = editor.querySelector('[aria-label="参考图历史"]')!;
    await settleUntil(() => Boolean(historyPanel.querySelector('[aria-label="放大查看 V2"]')));
    const historyTrigger = button("放大查看 V2", historyPanel);
    historyTrigger.focus();
    await act(async () => historyTrigger.click());
    await settleUntil(() => Boolean(document.querySelector(".canvas-image-preview-modal img")));
    const historyPreview = document.querySelector(".canvas-image-preview-modal")!;
    const image = historyPreview.querySelector<HTMLImageElement>("img")!;
    expect(resolveImage).toHaveBeenCalledWith(`resource:${historyResourceId}`, "");
    expect(image.src).toBe(originalImageUrl(`resource:${historyResourceId}`));
    expect(button("采用此版本", historyPreview).disabled).toBe(false);
    expect(adopt).not.toHaveBeenCalled();
    await act(async () => image.dispatchEvent(new Event("load")));
    await click("放大图片", historyPreview);
    const zoom = historyPreview.querySelector('[aria-label="相对适应窗口的缩放比例"]');
    expect(Number.parseInt(zoom?.textContent || "", 10)).toBeGreaterThan(100);

    const previewStage = historyPreview.querySelector<HTMLElement>('[role="region"]')!;
    previewStage.focus();
    expect(document.activeElement).toBe(previewStage);
    await act(async () => previewStage.dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, key: "Escape", keyCode: 27 }) as unknown as Event));
    await settleUntil(() => !document.querySelector(".canvas-image-preview-modal"));
    expect(document.querySelector(".drama-cast-dialog")).toBe(editor);
    expect(document.activeElement).toBe(historyTrigger);
    expect(onClose).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
});

test("采用展开后的早期版本只提交一次，刷新主视觉并在收起后保留当前版本", async () => {
    const original = { ...hero, imageVersion: 8, revision: 7, imageResourceId: "history-image-8", imageTakeId: "hero-take-8" };
    const earlier = { ...original, imageResourceId: "history-image-1", imageTakeId: "hero-take-1", revision: 8 };
    const takes = Array.from({ length: 8 }, (_, index) => castHistoryTake(8 - index, `history-image-${8 - index}`, index === 0));
    const history = spyOn(api, "listDramaTakes").mockResolvedValue({ takes });
    const resolveImage = spyOn(imageStorage, "resolveImageUrl").mockImplementation(async (storageKey) => `https://example.test/${storageKey?.replace(/^resource:/, "")}.png`);
    let completeAdoption!: (result: Awaited<ReturnType<typeof api.adoptDramaCastTake>>) => void;
    const adopt = spyOn(api, "adoptDramaCastTake").mockImplementation(() => new Promise((resolve) => (completeAdoption = resolve)));
    const changed = mock();
    function AdoptHarness() {
        const [asset, setAsset] = useState(original);
        return (
            <DialogHarness
                castId={hero.id}
                items={[asset]}
                onChanged={() => {
                    changed();
                    setAsset(earlier);
                }}
            />
        );
    }

    await render(<AdoptHarness />);
    const historyPanel = document.querySelector('[aria-label="参考图历史"]')!;
    await settleUntil(() => historyPanel.querySelector(".is-current b")?.textContent === "V8");
    expect(historyPanel.querySelector('[aria-label="放大查看 V1"]')).toBeNull();
    const more = button("显示更早版本", historyPanel);
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await act(async () => more.click());
    expect(button("收起更早版本", historyPanel).getAttribute("aria-expanded")).toBe("true");
    await click("放大查看 V1", historyPanel);
    await settleUntil(() => Boolean(document.querySelector(".canvas-image-preview-modal img")));
    const preview = document.querySelector(".canvas-image-preview-modal")!;
    expect(preview.querySelector("img")?.getAttribute("src")).toBe("https://example.test/history-image-1.png");
    expect(adopt).not.toHaveBeenCalled();
    const action = button("采用此版本", preview);
    await act(async () => {
        action.click();
        action.click();
    });
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt).toHaveBeenCalledWith("current", hero.id, { takeId: earlier.imageTakeId, expectedCastRevision: original.revision, expectedImageVersion: original.imageVersion, restyleSegments: true });
    expect(changed).not.toHaveBeenCalled();
    expect(historyPanel.querySelector(".is-current b")?.textContent).toBe("V8");

    const readCount = history.mock.calls.length;
    history.mockResolvedValue({ takes: takes.map((take) => ({ ...take, current: take.id === earlier.imageTakeId })) });
    await act(async () => completeAdoption({ cast: earlier, affectedSegments: 1 }));
    await settleUntil(() => !document.querySelector(".canvas-image-preview-modal") && historyPanel.querySelector(".is-current b")?.textContent === "V1");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(history.mock.calls.length).toBeGreaterThan(readCount);
    await click("收起更早版本", historyPanel);
    expect(historyPanel.querySelector('[aria-label="放大查看 V2"]')).toBeNull();
    expect(historyPanel.querySelector('.is-current [aria-label="放大查看 V1"]')).not.toBeNull();
    await click(`放大查看${hero.name}的参考图`, document.querySelector(".drama-cast-dialog")!);
    await settleUntil(() => document.querySelector(".canvas-image-preview-modal img")?.getAttribute("src") === "https://example.test/history-image-1.png");
    expect(resolveImage).toHaveBeenCalledWith("resource:history-image-1", "");
});

test("翻页读取并采用第 50 条之前的图片，迟到的分页结果不能改回当前版本", async () => {
    const takes = Array.from({ length: 55 }, (_, index) => castHistoryTake(55 - index, `paged-image-${55 - index}`, false));
    let current = takes[52];
    let olderReads = 0;
    let delayOlder = false;
    let finishOldPage!: () => void;
    const history = spyOn(api, "listDramaTakes").mockImplementation(async (_project, _owner, _kind, _signal, cursor) => {
        const result = (rows: DramaTake[]) => ({ currentResourceId: current.resourceId, takes: rows.map((item) => ({ ...item, current: item.id === current.id })) });
        if (!cursor) return { ...result([...takes.slice(0, 50), current]), nextBeforeTakeId: takes[49].id };
        expect(cursor).toBe(takes[49].id);
        if (++olderReads === 1) throw new Error("分页读取失败");
        const page = result(takes.slice(50));
        if (delayOlder) {
            delayOlder = false;
            await new Promise<void>((resolve) => (finishOldPage = resolve));
        }
        return page;
    });
    const original = { ...hero, imageVersion: 58, imageResourceId: current.resourceId, imageTakeId: current.id };
    const adopted = { ...original, imageTakeId: takes[54].id, imageResourceId: takes[54].resourceId, revision: 2, imageVersion: 59 };
    const adopt = spyOn(api, "adoptDramaCastTake").mockImplementation(async () => {
        current = takes[54];
        return { cast: adopted, affectedSegments: 0 };
    });
    function PagedHistory() {
        const [asset, setAsset] = useState(original);
        return <DialogHarness castId={hero.id} items={[asset]} onChanged={() => setAsset(adopted)} />;
    }
    await render(<PagedHistory />);
    const panel = document.querySelector('[aria-label="参考图历史"]')!;
    await settleUntil(() => panel.querySelector(".is-current b")?.textContent === "V3");
    expect(olderReads).toBe(0);
    await click("显示更早版本", panel);
    await settleUntil(() => panel.textContent?.includes("更早版本读取失败") === true);
    await click("重试读取更早版本", panel);
    await settleUntil(() => panel.querySelectorAll("li").length === 55);
    expect(panel.querySelectorAll('[aria-label="放大查看 V3"]')).toHaveLength(1);
    delayOlder = true;
    await act(async () => {
        void client.invalidateQueries({ queryKey: dramaKeys.takes("current", "cast", hero.id) });
    });
    await settleUntil(() => Boolean(finishOldPage));
    await click("采用 V1", panel);
    await settleUntil(() => panel.querySelector(".is-current b")?.textContent === "V1");
    await act(async () => finishOldPage());
    expect(panel.querySelectorAll(".is-current")).toHaveLength(1);
    expect(panel.querySelector(".is-current b")?.textContent).toBe("V1");
    expect(panel.querySelectorAll("li")).toHaveLength(55);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(history.mock.calls.filter((args) => args[4])).toHaveLength(olderReads);
});

for (const status of ["failed", "stale"] as const) {
    test(`当前主图为 ${status} 时可重新采用唯一的历史图恢复就绪`, async () => {
        const take = castHistoryTake(1, hero.imageResourceId!, true);
        const original = { ...hero, imageStatus: status, imageVersion: 1, imageTakeId: status === "stale" ? take.id : undefined };
        const ready = { ...original, imageTakeId: take.id, imageStatus: "ready" as const, imageVersion: 2, revision: 2 };
        spyOn(api, "listDramaTakes").mockResolvedValue({ takes: [take], currentResourceId: take.resourceId });
        spyOn(imageStorage, "resolveImageUrl").mockResolvedValue("https://example.test/recovered.png");
        const adopt = spyOn(api, "adoptDramaCastTake").mockResolvedValue({ cast: ready, affectedSegments: 0 });
        function RecoverableCast() {
            const [asset, setAsset] = useState<DramaCast>(original);
            return <DialogHarness castId={hero.id} items={[asset]} onChanged={() => setAsset(ready)} />;
        }
        await render(<RecoverableCast />);
        const panel = document.querySelector('[aria-label="参考图历史"]')!;
        await settleUntil(() => Boolean(panel.querySelector('[aria-label="采用 V1"]')));
        expect(button("采用 V1", panel).disabled).toBe(false);
        if (status === "failed") {
            await click("放大查看 V1", panel);
            await click("采用此版本", document.querySelector(".canvas-image-preview-modal")!);
        } else await click("采用 V1", panel);
        await settleUntil(() => !panel.querySelector('[aria-label="采用 V1"]') && document.querySelector('[aria-label="当前参考图"]')?.textContent?.includes("已就绪") === true);
        expect(adopt).toHaveBeenCalledWith("current", hero.id, { takeId: take.id, expectedCastRevision: original.revision, expectedImageVersion: 1, restyleSegments: true });
    });
}

test("预览内采用后关闭预览，迟到的失败提示回到历史列表", async () => {
    const earlier = castHistoryTake(1, "older-preview-image", false);
    spyOn(api, "listDramaTakes").mockResolvedValue({ takes: [castHistoryTake(2, hero.imageResourceId!, true), earlier], currentResourceId: hero.imageResourceId! });
    spyOn(imageStorage, "resolveImageUrl").mockResolvedValue("https://example.test/preview.png");
    let rejectAdoption!: (error: Error) => void;
    spyOn(api, "adoptDramaCastTake").mockImplementation(() => new Promise((_, reject) => (rejectAdoption = reject)));
    await render(<DialogHarness castId={hero.id} items={[hero]} />);
    const panel = document.querySelector('[aria-label="参考图历史"]')!;
    await settleUntil(() => Boolean(panel.querySelector('[aria-label="放大查看 V1"]')));
    await click("放大查看 V1", panel);
    const preview = document.querySelector(".canvas-image-preview-modal")!;
    await click("采用此版本", preview);
    await act(async () => preview.querySelector<HTMLButtonElement>(".ant-modal-close")!.click());
    await settleUntil(() => !document.querySelector(".canvas-image-preview-modal"));
    await act(async () => rejectAdoption(new Error("参考图已改变")));
    await settleUntil(() => panel.querySelector('[role="alert"]')?.textContent === "参考图已改变");
    expect(button("采用 V1", panel).disabled).toBe(false);
});

test("主视觉正在生成时历史图可预览，采用暂不可用", async () => {
    const original = { ...hero, imageStatus: "running" as const };
    const old = castHistoryTake(1, "older-hero-image", false);
    spyOn(api, "listDramaTakes").mockResolvedValue({ takes: [castHistoryTake(2, hero.imageResourceId!, true), old] });
    spyOn(imageStorage, "resolveImageUrl").mockResolvedValue("https://example.test/older-hero-image.png");
    const adopt = spyOn(api, "adoptDramaCastTake").mockRejectedValue(new Error("生成中不应提交采用请求"));
    await render(<DialogHarness castId={hero.id} items={[original]} />);
    const historyPanel = document.querySelector('[aria-label="参考图历史"]')!;
    await settleUntil(() => Boolean(historyPanel.querySelector('[aria-label="放大查看 V1"]')));
    expect(button("采用 V1", historyPanel).disabled).toBe(true);
    await click("放大查看 V1", historyPanel);
    await settleUntil(() => Boolean(document.querySelector(".canvas-image-preview-modal img")));
    const preview = document.querySelector(".canvas-image-preview-modal")!;
    const action = button("采用此版本", preview);
    expect(action.disabled).toBe(true);
    await act(async () => action.click());
    expect(adopt).not.toHaveBeenCalled();
});

test("版本列表直接采用沿用待更新设置，失败保留当前图且可重试", async () => {
    const original = { ...hero, imageVersion: 2, revision: 7, imageTakeId: "hero-take-2" };
    const old = castHistoryTake(1, "direct-older-image", false);
    const current = castHistoryTake(2, hero.imageResourceId!, true);
    const history = spyOn(api, "listDramaTakes").mockResolvedValue({ takes: [current, old] });
    const adopt = spyOn(api, "adoptDramaCastTake")
        .mockRejectedValueOnce(new ApiError("图像暂不可采用", { status: 409 }))
        .mockResolvedValue({ cast: { ...original, imageTakeId: old.id, imageResourceId: old.resourceId, revision: 8 }, affectedSegments: 0 });
    await render(<DialogHarness castId={hero.id} items={[original]} />);
    const historyPanel = document.querySelector('[aria-label="参考图历史"]')!;
    await settleUntil(() => Boolean(historyPanel.querySelector('[aria-label="采用 V1"]')));
    expect(historyPanel.querySelector('[aria-label="采用 V2"]')).toBeNull();
    await check("将引用视频标记为待更新", document.querySelector(".drama-cast-dialog")!);
    await click("采用 V1", historyPanel);
    await settleUntil(() => Boolean(historyPanel.querySelector('[role="alert"]')?.textContent?.includes("图像暂不可采用")));
    expect(document.querySelector(".canvas-image-preview-modal")).toBeNull();
    expect(historyPanel.querySelector(".is-current b")?.textContent).toBe("V2");
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt).toHaveBeenLastCalledWith("current", hero.id, { takeId: old.id, expectedCastRevision: original.revision, expectedImageVersion: original.imageVersion, restyleSegments: false });

    history.mockResolvedValue({
        takes: [
            { ...current, current: false },
            { ...old, current: true },
        ],
    });
    await click("采用 V1", historyPanel);
    await settleUntil(() => historyPanel.querySelector(".is-current b")?.textContent === "V1");
    expect(historyPanel.querySelector('[role="alert"]')).toBeNull();
    expect(adopt).toHaveBeenCalledTimes(2);
    expect(adopt).toHaveBeenLastCalledWith("current", hero.id, { takeId: old.id, expectedCastRevision: original.revision, expectedImageVersion: original.imageVersion, restyleSegments: false });
});

for (const outcome of ["ready", "failed"] as const) {
    test(`资产生成${outcome === "ready" ? "完成" : "未采用结果"}时，已打开的版本记录自动刷新`, async () => {
        const original = { ...hero, imageVersion: 1 };
        const previousTake = castHistoryTake(1, hero.imageResourceId!, true);
        const history = spyOn(api, "listDramaTakes").mockResolvedValue({ takes: [previousTake] });
        await render(<DialogHarness castId={hero.id} items={[original]} />);
        const historyPanel = document.querySelector('[aria-label="参考图历史"]')!;
        await settleUntil(() => historyPanel.querySelector(".is-current b")?.textContent === "V1");

        await render(<DialogHarness castId={hero.id} items={[{ ...original, imageStatus: "running" }]} />);
        const adopted = outcome === "ready";
        const newImage = "new-hero-image";
        history.mockResolvedValue({ takes: [castHistoryTake(2, newImage, adopted), { ...previousTake, current: !adopted }] });
        const completed = { ...original, imageStatus: outcome, ...(adopted && { imageVersion: 2, imageResourceId: newImage }) };
        await render(<DialogHarness castId={hero.id} items={[completed]} />);

        await settleUntil(() => historyPanel.querySelector("li:first-child b")?.textContent === "V2");
        expect(historyPanel.querySelector(".is-current b")?.textContent).toBe(adopted ? "V2" : "V1");
        expect(document.querySelector('[aria-label="参考图历史"]')).toBe(historyPanel);
    });
}

test("轮询只看到重试前后的失败状态时，版本记录仍显示保留的新图", async () => {
    const failed = { ...hero, imageStatus: "failed" as const, imageVersion: 1, updatedAt: "2026-11-20T04:00:00Z" };
    const previousTake = castHistoryTake(1, hero.imageResourceId!, true);
    const history = spyOn(api, "listDramaTakes").mockResolvedValue({ takes: [previousTake] });
    await render(<DialogHarness castId={hero.id} items={[failed]} />);
    const historyPanel = document.querySelector('[aria-label="参考图历史"]')!;
    await settleUntil(() => historyPanel.querySelector(".is-current b")?.textContent === "V1");

    history.mockResolvedValue({ takes: [castHistoryTake(2, "rejected-retry-image", false), previousTake] });
    await render(<DialogHarness castId={hero.id} items={[{ ...failed, updatedAt: "2026-11-20T04:01:00Z" }]} />);

    await settleUntil(() => historyPanel.querySelector("li:first-child b")?.textContent === "V2");
    expect(historyPanel.querySelector(".is-current b")?.textContent).toBe("V1");
    expect(document.querySelector('[aria-label="参考图历史"]')).toBe(historyPanel);
});

test("资产新图出现时，迟到的首个历史响应不能覆盖新版本", async () => {
    const original = { ...hero, imageVersion: 1 };
    const previousTake = castHistoryTake(1, hero.imageResourceId!, true);
    const newImage = "new-hero-image";
    let completeOldHistory!: (value: { takes: DramaTake[] }) => void;
    let firstSignal: AbortSignal | undefined;
    const history = spyOn(api, "listDramaTakes")
        .mockImplementationOnce((_projectId, _ownerId, _kind, signal) => {
            firstSignal = signal;
            return new Promise((resolve) => {
                completeOldHistory = resolve;
            });
        })
        .mockResolvedValue({ takes: [castHistoryTake(2, newImage, true), { ...previousTake, current: false }] });
    await render(<DialogHarness castId={hero.id} items={[original]} />);
    await settleUntil(() => history.mock.calls.length === 1);
    const historyPanel = document.querySelector('[aria-label="参考图历史"]')!;
    expect(historyPanel.textContent).toContain("正在读取版本");

    await render(<DialogHarness castId={hero.id} items={[{ ...original, imageVersion: 2, imageResourceId: newImage }]} />);
    await settleUntil(() => historyPanel.querySelector(".is-current b")?.textContent === "V2");
    expect(firstSignal?.aborted).toBe(true);

    await act(async () => completeOldHistory({ takes: [previousTake] }));
    await settle();
    expect(historyPanel.querySelector(".is-current b")?.textContent).toBe("V2");
});

test("资产文字与图片全部自动保存，底部状态与操作分行且无保存按钮", async () => {
    const target = { ...hero, imageOptionsJson: JSON.stringify({ subjectReferenceIds: ["subject-reference"] }) };
    const save = spyOn(api, "updateDramaCast").mockImplementation(async (_project, _id, patch) => ({ cast: { ...target, ...patch, revision: 2, imageOptionsJson: JSON.stringify(patch.imageOptions) } }));
    await render(<DialogHarness castId={target.id} items={[target]} />);
    const editor = document.querySelector(".drama-cast-dialog")!;
    await fill("名称", "新的角色名称", editor);
    await fill("外貌描述", "自动保存的白色风衣", editor);
    await fill("声线", "沉稳低音", editor);
    await click("移除主体参考 1", editor);
    await waitForAutoSave();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][2]).toEqual(
        expect.objectContaining({ name: "新的角色名称", appearance: "自动保存的白色风衣", voiceInstructions: "沉稳低音", expectedRevision: 9, expectedCastRevision: 1, imageOptions: expect.objectContaining({ subjectReferenceIds: [] }) }),
    );
    expect(editor.textContent).not.toContain("保存修改");
    expect(editor.querySelector(".drama-editor-status")).not.toBeNull();
    const actions = editor.querySelector(".drama-editor-action-buttons")!;
    expect(actions.lastElementChild?.textContent).toContain("生成图片");
});

test("资产串行自动保存保留在途新输入，生成等待最新草稿保存", async () => {
    let first!: (value: { cast: DramaCast }) => void;
    let revision = 9;
    const save = spyOn(api, "updateDramaCast").mockImplementation((_project, _id, patch) => {
        if (save.mock.calls.length === 1)
            return new Promise((resolve) => {
                first = resolve;
            });
        return Promise.resolve({ cast: { ...hero, ...patch, revision: 3 } });
    });
    spyOn(api, "getDrama").mockImplementation(async () => ({ ...dialogSummary, production: { ...dialogSummary.production, revision } }));
    await render(<DialogHarness castId={hero.id} items={[hero]} />);
    const editor = document.querySelector(".drama-cast-dialog")!;
    await fill("外貌描述", "第一次输入", editor);
    await waitForAutoSave();
    expect(save).toHaveBeenCalledTimes(1);
    expect(editor.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.disabled).toBe(false);
    await fill("外貌描述", "在途继续输入的最新内容", editor);
    await waitForAutoSave();
    expect(save).toHaveBeenCalledTimes(1);
    expect(imageGenerationButton(editor).disabled).toBe(true);
    revision = 10;
    await act(async () => first({ cast: { ...hero, revision: 2, appearance: "第一次输入" } }));
    await waitForAutoSave();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][2]).toEqual(expect.objectContaining({ expectedRevision: 10, expectedCastRevision: 2, appearance: "在途继续输入的最新内容" }));
    expect(editor.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe("在途继续输入的最新内容");
});

test("资产自动保存失败保留草稿且停止重发，可显式重试", async () => {
    const save = spyOn(api, "updateDramaCast")
        .mockRejectedValueOnce(new ApiError("连接断开", { status: 503 }))
        .mockResolvedValue({ cast: { ...hero, revision: 2, appearance: "失败后保留的内容" } });
    await render(<DialogHarness castId={hero.id} items={[hero]} />);
    const editor = document.querySelector(".drama-cast-dialog")!;
    await fill("外貌描述", "失败后保留的内容", editor);
    await waitForAutoSave();
    await waitForAutoSave();
    expect(save).toHaveBeenCalledTimes(1);
    expect(editor.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe("失败后保留的内容");
    expect(imageGenerationButton(editor).disabled).toBe(true);
    await click("重试保存", editor);
    await settleUntil(() => save.mock.calls.length === 2);
    expect(editor.textContent).not.toContain("自动保存失败");
});

test("版本变更时页面编辑优先有限重试，保留未编辑的远端字段", async () => {
    const refreshed = { ...hero, revision: 4, name: "远端更新的名称" };
    let revision = 9;
    const save = spyOn(api, "updateDramaCast").mockImplementation(async (_project, _id, patch) => {
        if (save.mock.calls.length === 1) {
            revision = 12;
            throw new ApiError("主体版本已变化", { status: 409, reason: "conflict" });
        }
        return { cast: { ...refreshed, ...patch, revision: 5 } };
    });
    spyOn(api, "getDrama").mockImplementation(async () => ({ ...dialogSummary, production: { ...dialogSummary.production, revision } }));
    spyOn(api, "listDramaCast").mockResolvedValue({ cast: [refreshed] });
    await render(<DialogHarness castId={hero.id} items={[hero]} />);
    await fill("外貌描述", "页面正在编辑的外观");
    await waitForAutoSave();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][2]).toEqual(expect.objectContaining({ expectedRevision: 12, expectedCastRevision: 4, appearance: "页面正在编辑的外观" }));
    expect(save.mock.calls[1][2]).not.toHaveProperty("name");
});

test("文字冲突重试沿用远端未编辑的图片配置，后续输入也不会覆盖", async () => {
    const refreshed = { ...hero, revision: 3, imageOptionsJson: JSON.stringify({ styleReferenceIds: ["remote-style"] }) };
    let current = { ...refreshed };
    const save = spyOn(api, "updateDramaCast").mockImplementation(async (_project, _id, patch) => {
        if (save.mock.calls.length === 1) throw new ApiError("主体版本已变化", { status: 409, reason: "conflict" });
        current = { ...current, ...patch, revision: current.revision! + 1, imageOptionsJson: JSON.stringify(patch.imageOptions) };
        return { cast: current };
    });
    spyOn(api, "listDramaCast").mockResolvedValue({ cast: [refreshed] });
    await render(<DialogHarness castId={hero.id} items={[hero]} />);
    await fill("外貌描述", "页面优先的外观");
    await waitForAutoSave();
    expect(save.mock.calls[1][2]).toEqual(expect.objectContaining({ appearance: "页面优先的外观", imageOptions: expect.objectContaining({ styleReferenceIds: ["remote-style"] }) }));
    await fill("外貌描述", "页面继续编辑的外观");
    await waitForAutoSave();
    expect(save.mock.calls[2][2]).toEqual(expect.objectContaining({ appearance: "页面继续编辑的外观", imageOptions: expect.objectContaining({ styleReferenceIds: ["remote-style"] }) }));
});

test("造型冲突重试只覆盖页面实际编辑字段，保留远端名称章节与提示词", async () => {
    const refreshed = { ...childhood, revision: 3, lookName: "远端造型名", lookFromChapter: 8, lookToChapter: 9, imagePrompt: "远端造型提示词" };
    const save = spyOn(api, "updateDramaCastLook")
        .mockRejectedValueOnce(new ApiError("造型版本已变化", { status: 409, reason: "conflict" }))
        .mockImplementation(async (_project, _id, patch) => ({ look: { ...refreshed, lookName: patch.lookName, appearance: patch.appearance, revision: 4 }, affectedSegments: 0 }));
    spyOn(api, "listDramaCast").mockResolvedValue({ cast: [refreshed] });
    await render(<DialogHarness castId={childhood.id} items={[hero, childhood]} />);
    await fill("外貌描述", "页面正在编辑的造型外观");
    await waitForAutoSave();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][2]).toEqual(expect.objectContaining({ lookName: "远端造型名", appearance: "页面正在编辑的造型外观", fromChapter: 8, toChapter: 9, imagePrompt: "远端造型提示词" }));
});

test("资产版本首读失败保留草稿且允许关闭，重试读取后自动保存", async () => {
    const read = spyOn(api, "getDrama")
        .mockRejectedValueOnce(new ApiError("读取失败", { status: 503 }))
        .mockResolvedValue(dialogSummary);
    const save = spyOn(api, "updateDramaCast").mockResolvedValue({ cast: { ...hero, revision: 2, appearance: "版本未就绪时输入的外观" } });
    const states: Array<[boolean, boolean]> = [];
    await render(<DialogHarness castId={hero.id} items={[hero]} onDirtyChange={(dirty, busy) => states.push([dirty, busy])} />);
    await settleUntil(() => read.mock.calls.length === 1);
    const editor = document.querySelector(".drama-cast-dialog")!;
    await fill("外貌描述", "版本未就绪时输入的外观", editor);
    expect(states.at(-1)).toEqual([true, false]);
    expect(button("关闭资产设定", editor).disabled).toBe(false);
    await click("重试保存", editor);
    await waitForAutoSave();
    expect(save).toHaveBeenCalledTimes(1);
    expect(editor.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe("版本未就绪时输入的外观");
    expect(states.at(-1)).toEqual([false, false]);
});

for (const conflict of ["unchanged", "foreign", "busy"] as const) {
    test(`资产${conflict}冲突不强制重写，保留当前草稿等待显式重试`, async () => {
        const save = spyOn(api, "updateDramaCast").mockRejectedValue(new ApiError("当前不可保存", { status: 409, reason: "conflict" }));
        spyOn(api, "listDramaCast").mockResolvedValue({ cast: [{ ...hero, ...(conflict === "foreign" ? { parentId: "different-parent", revision: 3 } : conflict === "busy" ? { imageStatus: "queued", revision: 3 } : {}) }] });
        const states: Array<[boolean, boolean]> = [];
        await render(<DialogHarness castId={hero.id} items={[hero]} onDirtyChange={(dirty, busy) => states.push([dirty, busy])} />);
        await fill("外貌描述", "冲突时仍保留的页面外观");
        await waitForAutoSave();
        await waitForAutoSave();
        expect(save).toHaveBeenCalledTimes(1);
        expect(document.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe("冲突时仍保留的页面外观");
        expect(states.at(-1)).toEqual([true, false]);
        expect(button("重试保存").disabled).toBe(false);
    });
}
async function settleUntil(predicate: () => boolean) {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(predicate()).toBe(true);
}
function imageBatchQuote(input: Parameters<typeof api.preflightDramaStudioBatch>[1], amountMicrocredits = 2_000_000, queued = false) {
    return {
        action: input.action,
        targetIds: input.targetIds,
        baseRevision: 9,
        ready: true,
        priced: true,
        amountMicrocredits,
        confirmationToken: `image-token:${input.episodeId || "project"}:${amountMicrocredits}`,
        scopeHash: "same-scope",
        items: input.targetIds.map((targetId) => ({ targetId, targetKind: "cast" as const, targetRevision: 1, status: queued ? ("queued" as const) : ("ready" as const), amountMicrocredits: amountMicrocredits / input.targetIds.length, priced: true })),
        counts: { ready: queued ? 0 : input.targetIds.length, queued: queued ? input.targetIds.length : 0, already_queued: 0, skipped_ready: 0, blocked: 0, conflict: 0, failed: 0 },
        warnings: [],
    };
}
function expectImageRequest(castId: string, episodeId?: string) {
    return expect.objectContaining({ action: "cast_image", targetIds: [castId], regenerate: true, restyleSegments: true, ...(episodeId ? { episodeId } : {}) });
}
function spyGeneration() {
    return {
        single: spyOn(api, "executeDramaStudioBatch").mockImplementation(async (_project, input) => imageBatchQuote(input, 2_000_000, true)),
        legacy: spyOn(api, "regenerateDramaCast").mockResolvedValue({ affectedSegments: 0 }),
        batch: spyOn(api, "regenerateDramaCasts").mockResolvedValue({ queued: 0, skipped: 0, affectedSegments: 0 }),
    };
}
function expectNoGeneration(generation: ReturnType<typeof spyGeneration>) {
    expect(generation.single).not.toHaveBeenCalled();
    expect(generation.batch).not.toHaveBeenCalled();
    expect(generation.legacy).not.toHaveBeenCalled();
}
function PanelHarness({ onFocus = () => {}, onChanged = () => {}, items = [hero, evening, childhood] }: { onFocus?: (id: string) => void; onChanged?: () => void; items?: DramaCast[] }) {
    const [focusId, setFocusId] = useState(hero.id);
    return (
        <CastPanel
            projectId="current"
            cast={items}
            ratios={{ character: "16:9" }}
            focusId={focusId}
            retrying={false}
            assetsPending={false}
            releasing={false}
            onFocus={(id) => {
                setFocusId(id);
                onFocus(id);
            }}
            onRetry={() => {}}
            onChanged={onChanged}
            onReleaseAssets={() => {}}
            onOpenCanvas={() => {}}
        />
    );
}

const dialogSummary = { project: { id: "current", name: "当前作品" }, production: { revision: 9, settings: { models: {}, assets: { characterRatio: "16:9" } } } } as DramaSummary;
const room = castFixture("room", "秦家卧室", { kind: "scene", imageStatus: "ready", imageResourceId: "room-image" });
function DialogHarness({
    castId,
    items,
    episodeId,
    summary = dialogSummary,
    onChanged = () => {},
    onClose = () => {},
    onDirtyChange,
    children,
}: {
    castId: string;
    items: DramaCast[];
    episodeId?: string;
    summary?: DramaSummary;
    onChanged?: () => void;
    onClose?: () => void;
    onDirtyChange?: (dirty: boolean, busy: boolean) => void;
    children?: ReactNode;
}) {
    const [open, setOpen] = useState(true);
    const location = useLocation();
    return (
        <>
            <output data-dialog-route>{location.pathname + location.search}</output>
            <CastEditorDialog
                summary={summary}
                cast={items}
                castId={open ? castId : undefined}
                episodeId={episodeId}
                onChanged={onChanged}
                onDirtyChange={onDirtyChange}
                onClose={() => {
                    setOpen(false);
                    onClose();
                }}
            >
                {children}
            </CastEditorDialog>
        </>
    );
}

function expectDialogName(dialog: Element, expectedTitle: string) {
    const titleId = dialog.getAttribute("aria-labelledby");
    expect(titleId?.trim()).toBeTruthy();
    const title = document.getElementById(titleId!);
    expect(title).not.toBeNull();
    expect(title?.textContent?.trim()).toBe(expectedTitle);
}

for (const [target, label] of [
    [hero, "人物"],
    [room, "场景"],
    [castFixture("key", "铜钥匙", { kind: "prop" }), "道具"],
] as const) {
    test(`${label}信息入口与辅助按钮同排，读取当前资产出镜且返回后保留工作区`, async () => {
        const generation = spyGeneration();
        await render(
            <DialogHarness castId={target.id} items={[hero, room, target]}>
                <button>原有工具</button>
            </DialogHarness>,
        );
        const editor = document.querySelector(".drama-cast-dialog")!;
        const actions = editor.querySelector(".drama-cast-assistance-actions")!;
        const infoButton = button(`${label}信息与出镜`, editor);
        expect(infoButton.parentElement).toBe(actions);
        expect(button("AI 补写外观", editor).parentElement).toBe(actions);
        expect(button("图片反推提示词", editor).parentElement).toBe(actions);
        if (target.kind === "character") expect(button("生成音色试听", editor).parentElement).toBe(actions);
        expect(button("原有工具", editor)).toBeDefined();
        expect(editor.querySelector('[aria-label="从角色库导入"]')).toBeNull();
        await click(`${label}信息与出镜`, editor);
        await settleUntil(() => Boolean(document.querySelector(".drama-character-dialog")));
        const info = document.querySelector(".drama-character-dialog")!;
        expect(info.querySelector("h2")?.textContent).toBe(`${target.name} · ${label}信息`);
        expect(characterApi.getDramaCharacterUsage).toHaveBeenCalledWith("current", target.id, expect.any(AbortSignal));
        expect(info.querySelector(".drama-character-dialog-body > section")?.getAttribute("aria-label")).toBe("真实出镜与引用");
        if (target.kind !== "character") expect(info.querySelector('[aria-label="年龄"]')).toBeNull();
        await click("关闭", info);
        await settleUntil(() => !document.querySelector(".drama-character-dialog"));
        expect(document.querySelector(".drama-cast-dialog")).toBe(editor);
        expectNoGeneration(generation);
    });
}

test("造型工作区保留辅助功能，不显示基础资产信息入口", async () => {
    await render(<DialogHarness castId={evening.id} items={[hero, evening]} />);
    const editor = document.querySelector(".drama-cast-dialog")!;
    expect(editor.querySelector(".drama-cast-assistance-actions")?.textContent).toContain("AI 补写外观");
    expect(editor.querySelector(".drama-cast-assistance-actions")?.textContent).toContain("图片反推提示词");
    expect(editor.querySelector(".drama-cast-assistance-actions")?.textContent).not.toContain("信息与出镜");
    expect(characterApi.getDramaCharacterUsage).not.toHaveBeenCalled();
});

test("仅修改人物信息也会汇总到工作区未保存保护，取消关闭保留编辑", async () => {
    const states: Array<[boolean, boolean]> = [];
    const closed = mock();
    await render(<DialogHarness castId={hero.id} items={[hero]} onClose={closed} onDirtyChange={(dirty, busy) => states.push([dirty, busy])} />);
    const editor = document.querySelector(".drama-cast-dialog")!;
    await click("人物信息与出镜", editor);
    const info = document.querySelector(".drama-character-dialog")!;
    await fill("年龄", "27岁", info);
    expect(states.at(-1)).toEqual([true, false]);
    expect(editor.querySelector(".drama-cast-dialog-save-state")?.textContent).toBe("有未保存的修改");
    await click("关闭资产设定", editor);
    expect(document.querySelector(".ant-modal-confirm")?.textContent).toContain("未保存的修改");
    await click("继续编辑", document.querySelector(".ant-modal-confirm")!);
    expect(closed).not.toHaveBeenCalled();
    expect(info.querySelector<HTMLTextAreaElement>('[aria-label="年龄"]')?.value).toBe("27岁");
});

test("主表单自动保存后可保存人物信息，刷新后按新版本继续保存", async () => {
    const states: Array<[boolean, boolean]> = [];
    const changed = mock();
    const updated = { ...hero, revision: 3, appearance: "主表单中未保存的白色风衣", definitionJson: JSON.stringify({ age: "27岁" }) };
    const refreshed = { ...dialogSummary, production: { ...dialogSummary.production, revision: 10 } };
    let completeDefinition!: (value: { cast: DramaCast }) => void;
    const definition = spyOn(characterApi, "updateDramaCharacterDefinition").mockReturnValue(
        new Promise((resolve) => {
            completeDefinition = resolve;
        }),
    );
    const save = spyOn(api, "updateDramaCast")
        .mockResolvedValueOnce({ cast: { ...hero, revision: 2, appearance: updated.appearance } })
        .mockResolvedValue({ cast: { ...updated, revision: 4 } });
    const generation = spyGeneration();
    const view = (current: DramaCast, summary = dialogSummary) => <DialogHarness castId={hero.id} items={[current]} summary={summary} onChanged={changed} onDirtyChange={(dirty, busy) => states.push([dirty, busy])} />;
    await render(view(hero));
    const editor = document.querySelector(".drama-cast-dialog")!;
    await fill("外貌描述", "主表单中未保存的白色风衣", editor);
    await waitForAutoSave();
    const appearance = editor.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]');
    await click("人物信息与出镜", editor);
    const info = document.querySelector(".drama-character-dialog")!;
    await fill("年龄", "27岁", info);
    await click("保存人物信息", info);
    await settleUntil(() => definition.mock.calls.length === 1);
    expect(definition).toHaveBeenCalledWith("current", hero.id, { expectedRevision: 9, expectedCastRevision: 1, fields: { age: "27岁" } });
    expect(states.at(-1)).toEqual([true, true]);
    for (const label of ["关闭资产设定", "AI 补写外观", "图片反推提示词", "生成音色试听", "人物信息与出镜"]) expect(button(label, editor).disabled).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => completeDefinition({ cast: updated }));
    await settleUntil(() => !document.querySelector(".drama-character-dialog"));
    expect(states.at(-1)).toEqual([false, false]);
    expect(button("人物信息与出镜", editor).disabled).toBe(false);
    spyOn(api, "getDrama").mockResolvedValue(refreshed);
    await act(async () => {
        client.setQueryData(dramaKeys.summary("current"), refreshed);
    });
    await render(view(updated, refreshed));
    expect(editor.querySelector('[aria-label="外貌描述"]')).toBe(appearance);
    expect(appearance?.value).toBe("主表单中未保存的白色风衣");
    await fill("外貌描述", "人物信息保存后继续补充的白色风衣", editor);
    await waitForAutoSave();
    await settleUntil(() => save.mock.calls.length === 2);
    expect(save.mock.calls[1][2]).toEqual(expect.objectContaining({ expectedRevision: 10, expectedCastRevision: 3, appearance: "人物信息保存后继续补充的白色风衣" }));
    expectNoGeneration(generation);
});

for (const [target, appearanceLabel, expectedTitle] of [
    [hero, "外貌描述", "林溪 · 角色设定"],
    [room, "环境描述", "秦家卧室 · 场景设定"],
] as const) {
    test(`${target.kind} reference opens its own editor dialog and saves without leaving the segment`, async () => {
        const changed = mock();
        const closed = mock();
        const save = spyOn(api, "updateDramaCast").mockResolvedValue({ cast: target });
        const generation = spyGeneration();
        await render(<DialogHarness castId={target.id} items={[hero, room]} onChanged={changed} onClose={closed} />);
        const dialog = document.querySelector('[role="dialog"]')!;
        const originalRoute = host.querySelector("[data-dialog-route]")!.textContent;
        expect(dialog).not.toBeNull();
        expectDialogName(dialog, expectedTitle);
        expect(dialog.querySelector("h2")?.textContent).toContain(target.name);
        expect(dialog.querySelector<HTMLInputElement>('[aria-label="名称"]')?.value).toBe(target.name);
        expect(dialog.querySelector<HTMLTextAreaElement>(`[aria-label="${appearanceLabel}"]`)?.value).toBe(target.appearance);
        expect(dialog.querySelector(".drama-cast-grid")).toBeNull();
        await fill(appearanceLabel, `${target.appearance}，保留标志性细节`, dialog);
        await fill("参考图生成提示词", "暖色侧光，完整保留设定细节", dialog);
        await waitForAutoSave();
        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledWith(
            "current",
            target.id,
            expect.objectContaining({ expectedRevision: 9, expectedCastRevision: 1, imageOptions: expect.any(Object), appearance: `${target.appearance}，保留标志性细节`, imagePrompt: "暖色侧光，完整保留设定细节" }),
        );
        expect(changed).toHaveBeenCalledTimes(1);
        expect(closed).not.toHaveBeenCalled();
        expect(host.querySelector("[data-dialog-route]")?.textContent).toBe(originalRoute);
        await click("关闭资产设定", dialog);
        expect(closed).toHaveBeenCalledTimes(1);
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(host.querySelector("[data-dialog-route]")?.textContent).toBe(originalRoute);
        expectNoGeneration(generation);
    });
}

for (const target of ["missing", "foreign"]) {
    test(`${target} reference does not fall back to another asset in the dialog`, async () => {
        const generation = spyGeneration();
        const save = spyOn(api, "updateDramaCast").mockResolvedValue({ cast: hero });
        const foreign = { ...room, id: "foreign", projectId: "another-project" };
        await render(<DialogHarness castId={target} items={[hero, foreign]} />);
        const dialog = document.querySelector('[role="dialog"]')!;
        expectDialogName(dialog, "资产设定");
        expect(dialog.textContent).toContain("此资产已不存在或暂时无法读取");
        expect(dialog.querySelector(".drama-editor")).toBeNull();
        expect(dialog.querySelector('[aria-label="名称"]')).toBeNull();
        expect(save).not.toHaveBeenCalled();
        expectNoGeneration(generation);
    });
}

test("有视频依赖时先显示报价，点击即保存并生成，不重复弹确认", async () => {
    const writes: string[] = [];
    const save = spyOn(api, "updateDramaCast").mockImplementation(async () => {
        writes.push("save");
        return { cast: hero };
    });
    const saveLook = spyOn(api, "updateDramaCastLook").mockResolvedValue({ look: evening, affectedSegments: 0 });
    const generation = spyGeneration();
    generation.single.mockImplementation(async (_project, input) => {
        writes.push("generate");
        return imageBatchQuote(input, 2_000_000, true);
    });
    const impactRead = spyOn(api, "getDramaCastImpact").mockResolvedValue(impactOf(hero.id, true));
    const changed = mock();
    await render(<DialogHarness castId={hero.id} items={[hero]} onChanged={changed} />);
    const editor = document.querySelector(".drama-cast-dialog")!;
    expect(impactRead).not.toHaveBeenCalled();
    expect(editor.querySelector('[aria-label="资产影响范围"]')).toBeNull();
    expect(editor.querySelector('[aria-label="已有视频影响范围"]')).toBeNull();
    await fill("外貌描述", "保留未保存的白色外套与银色纽扣", editor);
    expect(writes).toEqual([]);
    await clickImageGeneration(editor);
    await settleUntil(() => generation.single.mock.calls.length === 1);
    expect(writes).toEqual(["save", "generate"]);
    expect(save).toHaveBeenCalledWith("current", hero.id, expect.objectContaining({ appearance: "保留未保存的白色外套与银色纽扣" }));
    expect(generation.single).toHaveBeenCalledWith("current", expectImageRequest(hero.id));
    expect(document.querySelector(".ant-modal-confirm")).toBeNull();
    expect(impactRead).toHaveBeenCalledWith("current", hero.id);
    expect(saveLook).not.toHaveBeenCalled();
    expect(generation.batch).not.toHaveBeenCalled();
});

test("首次生成且没有已生成视频依赖时直接生成，不展示影响弹窗", async () => {
    const first = { ...hero, imageResourceId: undefined, imageStatus: "draft" as const };
    const save = spyOn(api, "updateDramaCast").mockResolvedValue({ cast: first });
    const generation = spyGeneration();
    await render(<DialogHarness castId={first.id} items={[first]} />);
    const editor = document.querySelector(".drama-cast-dialog")!;
    expect(api.getDramaCastImpact).not.toHaveBeenCalled();
    await clickImageGeneration(editor);
    await settleUntil(() => generation.single.mock.calls.length === 1);
    expect(api.getDramaCastImpact).toHaveBeenCalledWith("current", first.id);
    expect(document.querySelector(".ant-modal-confirm")).toBeNull();
    expect(editor.querySelector('[aria-label="已有视频影响范围"]')).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(generation.single).toHaveBeenCalledWith("current", expectImageRequest(first.id));
    expect(generation.batch).not.toHaveBeenCalled();
});

test("同一主体在不同分集详情生成时始终提交当前分集配置范围", async () => {
    const first = { ...hero, imageResourceId: undefined, imageStatus: "draft" as const };
    const generation = spyGeneration();
    const save = spyOn(api, "updateDramaCast").mockResolvedValue({ cast: first });
    for (const [index, episodeId] of ["episode-a", "episode-b"].entries()) {
        await render(<DialogHarness castId={first.id} items={[first]} episodeId={episodeId} />);
        await clickImageGeneration(document.querySelector(".drama-cast-dialog")!);
        await settleUntil(() => generation.single.mock.calls.length === index + 1);
        expect(generation.single.mock.calls[index]).toEqual(["current", expectImageRequest(first.id, episodeId)]);
    }
    expect(save).not.toHaveBeenCalled();
    expect(generation.batch).not.toHaveBeenCalled();
});

test("分集角色详情内生成造型图保留当前集", async () => {
    const generation = spyGeneration();
    for (const [index, episodeId] of ["episode-a", "episode-b"].entries()) {
        await render(<DialogHarness castId={hero.id} items={[hero, childhood]} episodeId={episodeId} />);
        await clickImageGeneration(document.querySelector(".drama-look-item")!);
        await settleUntil(() => generation.single.mock.calls.length === index + 1);
        expect(generation.single.mock.calls[index]).toEqual(["current", expectImageRequest(childhood.id, episodeId)]);
    }
});

test("分集角色详情内造型重编排与保存保留当前集", async () => {
    const rebuilt = spyOn(api, "rebuildDramaCastImagePrompt").mockResolvedValue({ imagePrompt: "本集造型新提示词" });
    const save = spyOn(api, "updateDramaCastLook").mockResolvedValue({ look: childhood, affectedSegments: 0 });
    await render(<DialogHarness castId={hero.id} items={[hero, childhood]} episodeId="episode-b" />);
    await click("编辑造型 幼年", document.querySelector(".drama-cast-dialog")!);
    const form = document.querySelector(".drama-look-form")!;
    await fill("造型外观", "短发与本集蓝色外套", form);
    await click("重新编排提示词", form);
    await click("确认替换", [...document.querySelectorAll('[role="dialog"]')].at(-1)!);
    expect(rebuilt).toHaveBeenCalledWith("current", childhood.id, expect.objectContaining({ episodeId: "episode-b", appearance: "短发与本集蓝色外套" }));
    await waitForAutoSave();
    expect(save).toHaveBeenCalledWith("current", childhood.id, expect.objectContaining({ episodeId: "episode-b", appearance: "短发与本集蓝色外套", imagePrompt: "本集造型新提示词" }));
});

for (const surface of ["workspace", "inline"] as const) {
    test(`${surface}造型文字与图片连续自动保存满足版本合同`, async () => {
        let savedLook = { ...childhood };
        let revision = dialogSummary.production.revision;
        spyOn(api, "getDrama").mockImplementation(async () => ({ ...dialogSummary, production: { ...dialogSummary.production, revision } }));
        const save = spyOn(api, "updateDramaCastLook").mockImplementation(async (_projectId, _castId, patch) => {
            if (!patch.lookName?.trim() || !patch.appearance?.trim()) throw new ApiError("造型名称和外观不能为空", { status: 400 });
            if (patch.expectedRevision !== revision || patch.expectedCastRevision !== savedLook.revision) throw new ApiError("造型版本已变化", { status: 409 });
            savedLook = { ...savedLook, lookName: patch.lookName, appearance: patch.appearance, imagePrompt: patch.imagePrompt || "", revision: savedLook.revision! + 1 };
            revision += 1;
            return { look: savedLook, affectedSegments: 0 };
        });
        const generation = spyGeneration();
        await render(<DialogHarness castId={surface === "workspace" ? childhood.id : hero.id} items={[hero, childhood]} episodeId="episode-b" />);
        if (surface === "inline") await click("编辑造型 幼年", document.querySelector(".drama-cast-dialog")!);
        const editor = document.querySelector(surface === "workspace" ? ".drama-cast-dialog" : ".drama-look-form")!;
        await fill(surface === "workspace" ? "造型名称" : "造型名", "未保存的造型名", editor);
        await fill(surface === "workspace" ? "外貌描述" : "造型外观", "未保存的造型外观", editor);
        for (const [index, prompt] of ["第一轮图片提示词", "第二轮图片提示词"].entries()) {
            await fill("参考图生成提示词", prompt, editor);
            await waitForAutoSave();
            expect(save).toHaveBeenCalledTimes(index + 1);
            expect(savedLook.imagePrompt).toBe(prompt);
            expect(save.mock.calls[index][2]).toEqual(expect.objectContaining({ lookName: "未保存的造型名", appearance: "未保存的造型外观", expectedRevision: 9 + index, expectedCastRevision: 1 + index, episodeId: "episode-b" }));
            expect(editor.querySelector<HTMLInputElement>(`[aria-label="${surface === "workspace" ? "造型名称" : "造型名"}"]`)?.value).toBe("未保存的造型名");
            expect(editor.querySelector<HTMLTextAreaElement>(`[aria-label="${surface === "workspace" ? "外貌描述" : "造型外观"}"]`)?.value).toBe("未保存的造型外观");
            expect(savedLook.lookName).toBe("未保存的造型名");
            expect(savedLook.appearance).toBe("未保存的造型外观");
        }
        expectNoGeneration(generation);
    });
}

test("同一主体切集后旧分集的影响检查迟到不提交生成，新操作使用当前集", async () => {
    const first = { ...hero, imageResourceId: undefined, imageStatus: "draft" as const };
    let resolveImpact!: (value: DramaWorkflowImpact) => void;
    const impactRead = spyOn(api, "getDramaCastImpact")
        .mockResolvedValue(impactOf(first.id))
        .mockReturnValueOnce(new Promise((resolve) => (resolveImpact = resolve)));
    const generation = spyGeneration();
    await render(<DialogHarness castId={first.id} items={[first]} episodeId="episode-a" />);
    await clickImageGeneration(document.querySelector(".drama-cast-dialog")!);
    await settleUntil(() => impactRead.mock.calls.length === 1);
    await render(<DialogHarness castId={first.id} items={[first]} episodeId="episode-b" />);
    await act(async () => resolveImpact(impactOf(first.id)));
    expectNoGeneration(generation);
    await clickImageGeneration(document.querySelector(".drama-cast-dialog")!);
    await settleUntil(() => generation.single.mock.calls.length === 1);
    expect(generation.single).toHaveBeenCalledWith("current", expectImageRequest(first.id, "episode-b"));
});

for (const surface of ["workspace", "sidebar"] as const) {
    test(`${surface} 保存响应返回前轮询到新设定仍继续生成，并保持忙碌直到生成请求完成`, async () => {
        const refreshed = { ...hero, name: "林溪·新设定", appearance: "保存后的白色外套与银色纽扣" };
        let resolveSave!: (value: { cast: DramaCast }) => void;
        const save = spyOn(api, "updateDramaCast").mockReturnValue(new Promise((resolve) => (resolveSave = resolve)));
        let resolveGeneration!: (value: ReturnType<typeof imageBatchQuote>) => void;
        const generation = spyGeneration();
        generation.single.mockReturnValue(new Promise((resolve) => (resolveGeneration = resolve)));
        const changed = mock();
        const view = (item: DramaCast) => (surface === "workspace" ? <DialogHarness castId={hero.id} items={[item]} onChanged={changed} /> : <PanelHarness items={[item]} onChanged={changed} />);
        const editor = () => document.querySelector(surface === "workspace" ? ".drama-cast-dialog" : ".drama-view-side")!;
        await render(view(hero));
        await fill("名称", refreshed.name, editor());
        await fill("外貌描述", refreshed.appearance, editor());
        const originalInput = editor().querySelector('[aria-label="外貌描述"]');
        await waitForAutoSave();
        await settleUntil(() => save.mock.calls.length === 1);
        expectNoGeneration(generation);

        // 模拟 PATCH 已落库但响应未返回，cast 轮询先读取到保存结果。
        await render(view(refreshed));
        expect(editor().querySelector('[aria-label="外貌描述"]') === originalInput).toBe(true);
        expect(editor().querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe(refreshed.appearance);
        expect(imageGenerationButton(editor()).disabled).toBe(true);
        await act(async () => resolveSave({ cast: refreshed }));
        await clickImageGeneration(editor());
        await settleUntil(() => generation.single.mock.calls.length === 1);
        expect(generation.single).toHaveBeenCalledWith("current", expectImageRequest(hero.id));
        expect(imageGenerationButton(editor()).disabled).toBe(true);
        if (surface === "workspace") expect(button("关闭资产设定", editor()).disabled).toBe(true);

        await act(async () => resolveGeneration(imageBatchQuote({ action: "cast_image", targetIds: [hero.id] }, 2_000_000, true)));
        await settleUntil(() => !imageGenerationButton(editor()).disabled);
        expect(changed).toHaveBeenCalledTimes(2);
        expect(generation.single).toHaveBeenCalledTimes(1);
        expect(generation.batch).not.toHaveBeenCalled();
    });
}

for (const change of ["asset", "account", "episode"] as const) {
    test(`保存途中切换 ${change} 仍取消旧资产的后续生成`, async () => {
        const other = { ...hero, id: "other-hero", name: "其他角色" };
        let resolveSave!: (value: { cast: DramaCast }) => void;
        const save = spyOn(api, "updateDramaCast").mockReturnValue(new Promise((resolve) => (resolveSave = resolve)));
        const generation = spyGeneration();
        const changed = mock();
        const view = (castId: string, episodeId = "episode-a") => <DialogHarness castId={castId} items={[hero, other]} episodeId={episodeId} onChanged={changed} />;
        await render(view(hero.id));
        await fill("外貌描述", "未返回的保存内容");
        await waitForAutoSave();
        await settleUntil(() => save.mock.calls.length === 1);
        if (change === "asset") await render(view(other.id));
        else if (change === "episode") await render(view(hero.id, "episode-b"));
        else await act(async () => useUserStore.setState({ user: { id: "another-workspace-user" } as never }));
        await act(async () => resolveSave({ cast: { ...hero, appearance: "未返回的保存内容" } }));
        expectNoGeneration(generation);
        expect(changed).not.toHaveBeenCalled();
        const dialog = document.querySelector(".drama-cast-dialog")!;
        expect(dialog.querySelector<HTMLInputElement>('[aria-label="名称"]')?.value).toBe(change === "asset" ? other.name : hero.name);
        await settleUntil(() => !imageGenerationButton(dialog).disabled);
    });
}

test("读取依赖期间回填新设定时取消旧草稿的后续保存和生成", async () => {
    const refreshed = { ...hero, name: "林溪·外部新设定", appearance: "另一标签页已保存的外观" };
    let resolveImpact!: (value: DramaWorkflowImpact) => void;
    const impactRead = spyOn(api, "getDramaCastImpact").mockReturnValueOnce(new Promise((resolve) => (resolveImpact = resolve)));
    const save = spyOn(api, "updateDramaCast").mockResolvedValue({ cast: hero });
    const generation = spyGeneration();
    await render(<DialogHarness castId={hero.id} items={[hero]} />);
    await fill("外貌描述", "保留点击前的旧草稿");
    await clickImageGeneration();
    await settleUntil(() => impactRead.mock.calls.length === 1);
    await render(<DialogHarness castId={hero.id} items={[refreshed]} />);
    await act(async () => resolveImpact(impactOf(hero.id, true)));
    const editor = document.querySelector(".drama-cast-dialog")!;
    await settleUntil(() => !imageGenerationButton(editor).disabled);
    expect(editor.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe(refreshed.appearance);
    expect(save).toHaveBeenCalledTimes(1);
    expectNoGeneration(generation);
    expect(document.querySelector(".ant-modal-confirm")).toBeNull();
});

test("主视觉保存后费用变化只更新报价，核对新按钮后再次点击才生成", async () => {
    let amount = 2_000_000;
    spyOn(api, "preflightDramaStudioBatch").mockImplementation(async (_project, input) => imageBatchQuote(input, amount));
    const save = spyOn(api, "updateDramaCast").mockResolvedValue({ cast: { ...hero, revision: 2, appearance: "新风衣与银纽扣" } });
    const generation = spyGeneration();
    await render(<DialogHarness castId={hero.id} items={[hero]} />);
    await fill("外貌描述", "新风衣与银纽扣");
    await settleUntil(() => imageGenerationButton().textContent?.includes("2积分") === true && !imageGenerationButton().disabled);
    amount = 3_000_000;
    await clickImageGeneration();
    await settleUntil(() => imageGenerationButton().textContent?.includes("3积分") === true && !imageGenerationButton().disabled);
    expect(save).toHaveBeenCalledTimes(1);
    expectNoGeneration(generation);
    expect(document.querySelector(".drama-cast-dialog")?.textContent).not.toContain("生成提交结果待核对");
    await clickImageGeneration();
    await settleUntil(() => generation.single.mock.calls.length === 1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(generation.single).toHaveBeenCalledWith("current", expect.objectContaining({ confirmationToken: "image-token:project:3000000" }));
});

test("reference dialog polling preserves draft fields and autosaves before closing", async () => {
    const changed = mock();
    const save = spyOn(api, "updateDramaCast").mockResolvedValue({ cast: room });
    const generation = spyGeneration();
    await render(<DialogHarness castId={room.id} items={[hero, room]} onChanged={changed} />);
    const dialog = document.querySelector('[role="dialog"]')!;
    await fill("环境描述", "尚未保存的落地窗与破损地板", dialog);
    await fill("参考图生成提示词", "保留我手工输入的晨光", dialog);
    const originalInput = dialog.querySelector<HTMLTextAreaElement>('[aria-label="环境描述"]');
    for (const patch of [{ imageStatus: "queued" }, { imageStatus: "ready", imageVersion: 2, imageResourceId: "room-new-image", locked: true }] as const) {
        await render(<DialogHarness castId={room.id} items={[hero, { ...room, ...patch }]} onChanged={changed} />);
        expect(dialog.querySelector('[aria-label="环境描述"]')).toBe(originalInput);
        expect(originalInput?.value).toBe("尚未保存的落地窗与破损地板");
        expect(dialog.querySelector<HTMLTextAreaElement>('[aria-label="参考图生成提示词"]')?.value).toBe("保留我手工输入的晨光");
    }
    await waitForAutoSave();
    await click("关闭资产设定", dialog);
    expect(document.querySelector(".ant-modal-confirm")).toBeNull();
    await render(<DialogHarness key="reopened" castId={room.id} items={[hero, { ...room, appearance: "尚未保存的落地窗与破损地板", imagePrompt: "保留我手工输入的晨光" }]} onChanged={changed} />);
    const reopened = document.querySelector(".drama-cast-dialog")!;
    expect(reopened.querySelector<HTMLTextAreaElement>('[aria-label="环境描述"]')?.value).toBe("尚未保存的落地窗与破损地板");
    expect(reopened.querySelector<HTMLTextAreaElement>('[aria-label="参考图生成提示词"]')?.value).toBe("保留我手工输入的晨光");
    expect(save).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expectNoGeneration(generation);
});

test("character thumbnails select the look id and save only that look from the side editor", async () => {
    const focused = mock();
    const updateBase = spyOn(api, "updateDramaCast").mockResolvedValue({ cast: hero });
    const updateLook = spyOn(api, "updateDramaCastLook").mockResolvedValue({ look: evening, affectedSegments: 0 });
    const generation = spyGeneration();
    await render(<PanelHarness onFocus={focused} />);
    await click("切换到晚宴", host);
    expect(focused).toHaveBeenLastCalledWith(evening.id);
    expect(button("切换到晚宴", host).getAttribute("aria-pressed")).toBe("true");
    const editor = host.querySelector(".drama-view-side")!;
    expect(editor.querySelector<HTMLInputElement>('[aria-label="造型名称"]')?.value).toBe("晚宴");
    expect(editor.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe(evening.appearance);
    await fill("造型名称", "红毯晚宴", editor);
    await fill("外貌描述", "深红礼服，珍珠耳饰", editor);
    await fill("参考图生成提示词", "红毯暖光，保持人物五官", editor);
    await waitForAutoSave();
    expect(updateLook).toHaveBeenCalledWith("current", evening.id, expect.objectContaining({ lookName: "红毯晚宴", appearance: "深红礼服，珍珠耳饰", imagePrompt: "红毯暖光，保持人物五官", fromChapter: 2, toChapter: 4 }));
    expect(updateBase).not.toHaveBeenCalled();
    expectNoGeneration(generation);
    await click("切换到幼年", host);
    expect(focused).toHaveBeenLastCalledWith(childhood.id);
    expect(editor.querySelector<HTMLInputElement>('[aria-label="造型名称"]')?.value).toBe("幼年");
    await click("切换到基础造型", host);
    expect(focused).toHaveBeenLastCalledWith(hero.id);
    expect(editor.querySelector<HTMLInputElement>('[aria-label="名称"]')?.value).toBe(hero.name);
});

test("the separate appearance tab selects and edits an appearance without a base card", async () => {
    const focused = mock();
    await render(<PanelHarness onFocus={focused} />);
    const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((item) => item.textContent?.startsWith("造型"))!;
    await act(async () => tab.click());
    expect(tab.getAttribute("aria-selected")).toBe("true");
    const grid = host.querySelector(".drama-cast-grid")!;
    expect(grid.querySelector('[aria-label="编辑林溪"]')).toBeNull();
    expect(grid.querySelectorAll(".drama-cast-card")).toHaveLength(2);
    await click("编辑幼年", grid);
    expect(focused).toHaveBeenLastCalledWith(childhood.id);
    expect(host.querySelector<HTMLInputElement>('[aria-label="造型名称"]')?.value).toBe("幼年");
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe(childhood.appearance);
});

test("refetching saved appearance and style for the same cast id rehydrates the editor", async () => {
    const originalStyle = findDramaStyle(composeDramaStyleId("2d", "xuanhuan"))!;
    const original = { ...hero, imagePrompt: "原始提示词", imageStyleId: originalStyle.id, imageStyleName: originalStyle.name, imageStylePrompt: originalStyle.prompt };
    const refreshedStyle = findDramaStyle(composeDramaStyleId("semi-realistic", "apocalypse"))!;
    const refreshed = { ...original, name: "林溪·第二季", appearance: "第二季的短发与防护外套", imagePrompt: "导入后的末日生存提示词", imageStyleId: refreshedStyle.id, imageStyleName: refreshedStyle.name, imageStylePrompt: refreshedStyle.prompt };
    const save = spyOn(api, "updateDramaCast").mockResolvedValue({ cast: refreshed });
    await render(<PanelHarness items={[original]} />);
    expect(save).not.toHaveBeenCalled();

    await render(<PanelHarness items={[refreshed]} />);
    const editor = host.querySelector(".drama-view-side")!;
    expect(editor.querySelector<HTMLInputElement>('[aria-label="名称"]')?.value).toBe(refreshed.name);
    expect(editor.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe(refreshed.appearance);
    expect(editor.querySelector<HTMLTextAreaElement>('[aria-label="参考图生成提示词"]')?.value).toBe(refreshed.imagePrompt);
    expect(editor.querySelector<HTMLSelectElement>('[aria-label="参考图风格"]')?.selectedOptions[0]?.textContent).toBe(refreshedStyle.name);
    expect(editor.textContent).not.toContain("保存修改");

    // 单独更新已保存风格也应回填，不能依赖外观或名称恰好一起变化。
    const styleOnly = findDramaStyle(composeDramaStyleId("realistic", "campus"))!;
    await render(<PanelHarness items={[{ ...refreshed, imageStyleId: styleOnly.id, imageStyleName: styleOnly.name, imageStylePrompt: styleOnly.prompt }]} />);
    expect(editor.querySelector<HTMLSelectElement>('[aria-label="参考图风格"]')?.selectedOptions[0]?.textContent).toBe(styleOnly.name);
    expect(editor.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe(refreshed.appearance);
    expect(save).not.toHaveBeenCalled();
    await fill("外貌描述", `${refreshed.appearance}，增加防护手套`, editor);
    await waitForAutoSave();
    expect(save).toHaveBeenCalledWith("current", hero.id, expect.objectContaining({ appearance: `${refreshed.appearance}，增加防护手套`, expectedCastRevision: 1, imageOptions: expect.any(Object) }));
});

test("media status and lock polling preserve unsaved appearance, prompt and style edits", async () => {
    const savedStyle = findDramaStyle(composeDramaStyleId("2d", "urban"))!;
    const saved = { ...hero, imagePrompt: "已保存提示词", imageStyleId: savedStyle.id, imageStyleName: savedStyle.name, imageStylePrompt: savedStyle.prompt };
    const editedStyle = findDramaStyle("3d-guoman")!;
    const save = spyOn(api, "updateDramaCast").mockResolvedValue({ cast: saved });
    await render(<PanelHarness items={[saved]} />);
    await fill("名称", "编辑中的角色名", host);
    await fill("外貌描述", "编辑中的白色外套", host);
    await fill("参考图生成提示词", "编辑中的暖色光线", host);
    await chooseImageStyle(editedStyle.id);
    const appearanceInput = host.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]');
    const updates: Partial<DramaCast>[] = [{ imageStatus: "queued" }, { locked: true }, { imageStatus: "ready", imageVersion: 2, imageResourceId: "newly-polled-image", locked: true }];
    for (const update of updates) {
        await render(<PanelHarness items={[{ ...saved, ...update }]} />);
        expect(host.querySelector('[aria-label="外貌描述"]')).toBe(appearanceInput);
        expect(appearanceInput?.value).toBe("编辑中的白色外套");
        expect(host.querySelector<HTMLInputElement>('[aria-label="名称"]')?.value).toBe("编辑中的角色名");
        expect(host.querySelector<HTMLTextAreaElement>('[aria-label="参考图生成提示词"]')?.value).toBe("编辑中的暖色光线");
        expect(host.querySelector<HTMLSelectElement>('[aria-label="参考图风格"]')?.value).toBe(editedStyle.id);
    }
    await fill("外貌描述", "编辑中的白色外套，继续补充银色纽扣", host);
    await waitForAutoSave();
    expect(save).toHaveBeenCalledWith(
        "current",
        hero.id,
        expect.objectContaining({ name: "编辑中的角色名", appearance: "编辑中的白色外套，继续补充银色纽扣", imagePrompt: "编辑中的暖色光线", imageStyleId: editedStyle.id, imageStyleName: editedStyle.name, imageStylePrompt: editedStyle.prompt }),
    );
});

test("主体自动保存完成后可切换锁定，随后编辑沿用新版本", async () => {
    const target = { ...hero, imageOptionsJson: JSON.stringify({ subjectReferenceIds: ["subject-reference"] }) };
    let current = { ...target };
    const update = spyOn(api, "updateDramaCast").mockImplementation(async (_projectId, _castId, patch) => {
        current = { ...current, ...patch, revision: current.revision! + 1, ...(patch.imageOptions ? { imageOptionsJson: JSON.stringify(patch.imageOptions) } : {}) };
        return { cast: current };
    });
    const generation = spyGeneration();
    await render(<PanelHarness items={[target]} />);
    const editor = host.querySelector(".drama-view-side")!;
    await fill("外貌描述", "保留草稿中的白色风衣", editor);
    await fill("参考图生成提示词", "保留草稿中的暖色侧光", editor);
    await click("移除主体参考 1", editor);
    expect(editor.querySelector<HTMLButtonElement>('.drama-switch-label [role="switch"]')?.disabled).toBe(true);
    await waitForAutoSave();
    await act(async () => editor.querySelector<HTMLButtonElement>('.drama-switch-label [role="switch"]')!.click());
    await settleUntil(() => update.mock.calls.length === 2);
    expect(update.mock.calls[1][2]).toEqual({ locked: true });
    await fill("外貌描述", "保留草稿中的白色风衣和银纽扣", editor);
    await waitForAutoSave();
    await settleUntil(() => update.mock.calls.length === 3);
    expect(update.mock.calls[2][2]).toEqual(expect.objectContaining({ expectedCastRevision: 3, appearance: "保留草稿中的白色风衣和银纽扣", imageOptions: expect.objectContaining({ subjectReferenceIds: [] }) }));
    expectNoGeneration(generation);
});

for (const metadata of [{ imageResourceId: "adopted-image", imageVersion: 2, locked: true }, { voiceSampleResourceId: "adopted-voice" }]) {
    test(`${"imageResourceId" in metadata ? "采用图片" : "绑定声音"}的版本更新不阻止已有草稿保存`, async () => {
        const updated = { ...hero, ...metadata, revision: 2 };
        const save = spyOn(api, "updateDramaCast").mockResolvedValue({ cast: { ...updated, revision: 3 } });
        await render(<PanelHarness items={[hero]} />);
        const editor = host.querySelector(".drama-view-side")!;
        await fill("外貌描述", "保留原有文字草稿", editor);
        await render(<PanelHarness items={[updated]} />);
        expect(editor.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe("保留原有文字草稿");
        await waitForAutoSave();
        expect(save).toHaveBeenCalledWith("current", hero.id, expect.objectContaining({ expectedCastRevision: 2, appearance: "保留原有文字草稿" }));
    });
}

for (const external of [{ appearance: "其他用户保存的新外观" }, { imageOptionsJson: JSON.stringify({ styleReferenceIds: ["external-style"] }) }]) {
    test(`外部${"appearance" in external ? "文字" : "图片配置"}变化仍按旧版本校验并保留草稿`, async () => {
        const save = spyOn(api, "updateDramaCast").mockRejectedValue(new ApiError("主体版本已变化", { status: 409 }));
        const generation = spyGeneration();
        await render(<PanelHarness items={[hero]} />);
        const editor = host.querySelector(".drama-view-side")!;
        await fill("外貌描述", "当前尚未保存的外观", editor);
        await render(<PanelHarness items={[{ ...hero, ...external, revision: 2 }]} />);
        await waitForAutoSave();
        expect(save).toHaveBeenCalledWith("current", hero.id, expect.objectContaining({ expectedCastRevision: 1, appearance: "当前尚未保存的外观" }));
        expect(editor.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe("当前尚未保存的外观");
        expect(button("重试保存", editor).disabled).toBe(false);
        expectNoGeneration(generation);
    });
}

for (const [kind, name] of [
    ["character", "新角色"],
    ["scene", "林间小屋"],
    ["prop", "铜制怀表"],
] as const) {
    test(`creating a ${kind} saves a draft without generating an image`, async () => {
        const created = castFixture(`created-${kind}`, name, { kind });
        const save = spyOn(api, "createDramaCast").mockResolvedValue({ cast: created });
        const generation = spyGeneration();
        const onCreated = mock();
        const onClose = mock();
        await render(<CastCreateDialog projectId="current" initialKind={kind} onCreated={onCreated} onClose={onClose} />);
        const dialog = document.querySelector('[role="dialog"]')!;
        expect(button("保存设定", dialog).disabled).toBe(true);
        await fill("新设定名称", `  ${name}  `, dialog);
        await fill("新设定外观", `  ${name}的具体外观  `, dialog);
        await fill("参考图生成提示词", "柔和侧光，保留细节", dialog);
        expect(save).not.toHaveBeenCalled();
        await click("保存设定", dialog);
        expect(save).toHaveBeenCalledWith("current", { kind, name, appearance: `${name}的具体外观`, imagePrompt: "柔和侧光，保留细节" });
        expect(onCreated).toHaveBeenCalledWith(created);
        expect(onClose).toHaveBeenCalledTimes(1);
        expectNoGeneration(generation);
    });
}

const sourceHero = castFixture("season-one-hero", hero.name, { projectId: "season-one", imageStatus: "ready", imageResourceId: "season-one-image" });
const sourceLook = castFixture("season-one-look", hero.name, { projectId: "season-one", parentId: sourceHero.id, lookName: "冬装" });
const sourceScene = castFixture("season-one-scene", "旧宅", { projectId: "season-one", kind: "scene" });
const sourceProp = castFixture("season-two-prop", "怀表", { projectId: "season-two", kind: "prop" });
function mockSources() {
    const list = spyOn(api, "listDramas").mockResolvedValue({
        items: [{ project: { id: "current", name: "当前作品" } }, { project: { id: "season-one", name: "第一季" } }, { project: { id: "season-two", name: "第二季" } }],
        page: 1,
        pageSize: 100,
        total: 3,
        hasMore: false,
        statusCounts: {},
    } as DramaListPage);
    const casts = spyOn(api, "listDramaCast").mockImplementation(async (id) => ({ cast: id === "season-one" ? [sourceHero, sourceLook, sourceScene] : [sourceProp] }));
    const imported = spyOn(api, "importDramaCast").mockResolvedValue({ imported: 1, skipped: 0, cast: [sourceHero] });
    return { list, casts, imported };
}
async function renderImport() {
    const sources = mockSources();
    const onClose = mock();
    const onImported = mock();
    await render(<CastProjectImport projectId="current" currentCast={[hero]} onClose={onClose} onImported={onImported} />);
    await settleUntil(() => sources.list.mock.calls.length === 1 && !document.querySelector(".ant-select-loading"));
    return { ...sources, onClose, onImported };
}
async function chooseSource(name: string, expectedCheckbox: string) {
    await selectOption("素材来源作品", name);
    await settleUntil(() => Boolean(document.querySelector(`[aria-label="${expectedCheckbox}"]`)));
}

test("cross-season import requires a source and explicit cast ids and defaults to preserving existing images", async () => {
    const generation = spyGeneration();
    const { imported, casts, onImported, onClose } = await renderImport();
    expect(button("关联 0 个设定").disabled).toBe(true);
    expect(casts).not.toHaveBeenCalled();
    expect(imported).not.toHaveBeenCalled();
    await chooseSource("第一季", `关联${sourceHero.name}`);
    expect(casts.mock.calls[0]?.[0]).toBe("season-one");
    expect(button("关联 0 个设定").disabled).toBe(true);
    const choices = document.querySelector('[role="group"][aria-label="选择要关联的素材"]')!;
    expect(choices.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(choices.querySelector('[aria-label="关联冬装"]')).toBeNull();
    await check(`关联${sourceHero.name}`, choices);
    await settleUntil(() => !button("关联 1 个设定").disabled);
    expect(imported).not.toHaveBeenCalled();
    await click("关联 1 个设定");
    expect(imported).toHaveBeenCalledWith("current", { sourceProjectId: "season-one", castIds: [sourceHero.id], matchByName: true, replaceExisting: false });
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expectNoGeneration(generation);
});

test("replacing an existing image is sent only after explicitly checking replacement", async () => {
    const { imported } = await renderImport();
    await chooseSource("第一季", `关联${sourceHero.name}`);
    await check(`关联${sourceHero.name}`);
    await check("替换同名设定已有的参考图，旧图保留在版本记录中");
    await settleUntil(() => !button("关联 1 个设定").disabled);
    await click("关联 1 个设定");
    expect(imported).toHaveBeenCalledWith("current", { sourceProjectId: "season-one", castIds: [sourceHero.id], matchByName: true, replaceExisting: true });
});

test("switching import source clears cast selections and replacement permission", async () => {
    const { imported } = await renderImport();
    const replaceLabel = "替换同名设定已有的参考图，旧图保留在版本记录中";
    await chooseSource("第一季", `关联${sourceHero.name}`);
    await check(`关联${sourceHero.name}`);
    await check(`关联${sourceScene.name}`);
    await check(replaceLabel);
    expect(checkbox(replaceLabel).checked).toBe(true);
    expect(button("关联 2 个设定")).toBeDefined();
    await chooseSource("第二季", `关联${sourceProp.name}`);
    expect(checkbox(replaceLabel).checked).toBe(false);
    expect(document.querySelector<HTMLInputElement>(`[aria-label="关联${sourceProp.name}"]`)?.checked).toBe(false);
    expect(document.querySelector(`[aria-label="关联${sourceHero.name}"]`)).toBeNull();
    expect(button("关联 0 个设定").disabled).toBe(true);
    expect(imported).not.toHaveBeenCalled();
    await check(`关联${sourceProp.name}`);
    await settleUntil(() => !button("关联 1 个设定").disabled);
    await click("关联 1 个设定");
    expect(imported).toHaveBeenCalledWith("current", { sourceProjectId: "season-two", castIds: [sourceProp.id], matchByName: true, replaceExisting: false });
});

test("import preview matches names across Unicode whitespace, punctuation and case", async () => {
    const { list, casts, imported } = mockSources();
    const target = castFixture("current-normalized", "主角\u3000a", { imageResourceId: "existing-normalized-image", imageStatus: "ready" });
    const variants = ["主角·A", "主角（A）", "主角 A"].map((name, index) => castFixture(`normalized-source-${index}`, name, { projectId: "season-one" }));
    const distinct = castFixture("distinct-source", "主角B", { projectId: "season-one" });
    casts.mockResolvedValue({ cast: [...variants, distinct] });
    await render(<CastProjectImport projectId="current" currentCast={[target]} onClose={() => {}} onImported={() => {}} />);
    await settleUntil(() => list.mock.calls.length === 1 && !document.querySelector(".ant-select-loading"));
    await chooseSource("第一季", `关联${variants[0].name}`);
    const preview = (name: string) => checkbox(`关联${name}`).closest(".drama-cast-import-item")!.querySelector(".drama-cast-import-description")!.textContent;
    for (const item of variants) {
        expect(preview(item.name)).toContain("保留本作品已有参考图");
        expect(preview(item.name)).not.toContain("作为新设定加入");
    }
    expect(preview(distinct.name)).toContain("作为新设定加入");

    const matchLabel = "匹配本作品中同类型、同名称的设定，缺少的设定新增";
    await check(matchLabel);
    for (const item of variants) expect(preview(item.name)).toContain("作为新设定加入");
    await check(matchLabel);
    for (const item of variants) expect(preview(item.name)).toContain("保留本作品已有参考图");
    await check("替换同名设定已有的参考图，旧图保留在版本记录中");
    for (const item of variants) expect(preview(item.name)).toContain("替换同名设定参考图，旧图保留版本");
    await check(`关联${variants[0].name}`);
    await settleUntil(() => !button("关联 1 个设定").disabled);
    await click("关联 1 个设定");
    expect(imported).toHaveBeenCalledWith("current", { sourceProjectId: "season-one", castIds: [variants[0].id], matchByName: true, replaceExisting: true });
});

for (const [kind, label, chosen] of [
    ["scene", "场景", sourceScene],
    ["prop", "道具", { ...sourceProp, projectId: "season-one" }],
] as const) {
    test(`${kind} library imports only the selected kind from the named source project`, async () => {
        const { list, casts, imported } = mockSources();
        const sources = [sourceHero, sourceLook, sourceScene, { ...sourceProp, projectId: "season-one" }, castFixture("wrong-source", "外部场景", { projectId: "unrelated", kind })];
        casts.mockResolvedValue({ cast: sources });
        const foreignTarget = castFixture("foreign-target", chosen.name, { projectId: "unrelated", kind, imageResourceId: "foreign-image" });
        await render(<CastProjectImport projectId="current" kind={kind} currentCast={[foreignTarget]} onClose={() => {}} onImported={() => {}} />);
        await settleUntil(() => list.mock.calls.length === 1 && !document.querySelector(".ant-select-loading"));
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain(`从${label}库导入`);
        await chooseSource("第一季", `关联${chosen.name}`);
        const choices = document.querySelector('[role="group"][aria-label="选择要关联的素材"]')!;
        expect(choices.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
        expect(choices.textContent).toContain("作为新设定加入");
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain("来源作品：第一季");
        await click("全选");
        await click(`导入 1 个${label}`);
        expect(imported).toHaveBeenCalledWith("current", { sourceProjectId: "season-one", castIds: [chosen.id], matchByName: true, replaceExisting: false });
    });

    test(`${kind} episode library import captures its episode and isolates responses after switching episodes`, async () => {
        const { list, casts, imported } = mockSources();
        casts.mockResolvedValue({ cast: [chosen] });
        let finish!: (result: Awaited<ReturnType<typeof api.importDramaCast>>) => void;
        let fail!: (error: Error) => void;
        imported.mockImplementation(
            () =>
                new Promise((resolve, reject) => {
                    finish = resolve;
                    fail = reject;
                }),
        );
        const onChanged = mock();
        const onDirtyChange = mock();
        const props = { projectId: "current", kind, cast: [], busy: false, onChanged, onDirtyChange };
        await render(<WorkflowAssetLibrary {...props} episodeId="episode-1" />);
        await click(`从${label}库导入`);
        await settleUntil(() => list.mock.calls.length === 1 && !document.querySelector(".ant-select-loading"));
        await chooseSource("第一季", `关联${chosen.name}`);
        await check(`关联${chosen.name}`);
        await click(`导入 1 个${label}`);
        expect(imported).toHaveBeenCalledWith("current", { sourceProjectId: "season-one", castIds: [chosen.id], matchByName: true, replaceExisting: false, episodeId: "episode-1" });
        await render(<WorkflowAssetLibrary {...props} episodeId="episode-2" />);
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        await act(async () => {
            if (kind === "scene") finish({ imported: 1, skipped: 0, cast: [chosen] });
            else fail(new Error("旧集导入失败"));
        });
        expect(onChanged).not.toHaveBeenCalled();
        expect(document.body.textContent).not.toContain("已关联 1 项素材");
        expect(document.body.textContent).not.toContain("旧集导入失败");
        await click(`从${label}库导入`);
        await settleUntil(() => !document.querySelector(".ant-select-loading"));
        expect(button(`导入 0 个${label}`).disabled).toBe(true);
        await chooseSource("第一季", `关联${chosen.name}`);
        await settleUntil(() => !checkbox(`关联${chosen.name}`).disabled);
        await check(`关联${chosen.name}`);
        imported.mockResolvedValue({ imported: 1, skipped: 0, cast: [chosen] });
        await settleUntil(() => Boolean([...document.querySelectorAll("button")].find((item) => item.textContent?.replace(/\s/g, "") === `导入1个${label}`)));
        await click(`导入 1 个${label}`);
        expect(imported).toHaveBeenLastCalledWith("current", { sourceProjectId: "season-one", castIds: [chosen.id], matchByName: true, replaceExisting: false, episodeId: "episode-2" });
        expect(onChanged).toHaveBeenCalledTimes(1);
    });
}

test("project import reports selection and pending state and locks every control without duplicate writes", async () => {
    const { list, imported } = mockSources();
    let finish!: (result: Awaited<ReturnType<typeof api.importDramaCast>>) => void;
    imported.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const onClose = mock();
    const onStateChange = mock();
    await render(<CastProjectImport projectId="current" currentCast={[hero]} onClose={onClose} onImported={() => {}} onStateChange={onStateChange} />);
    await settleUntil(() => list.mock.calls.length === 1 && !document.querySelector(".ant-select-loading"));
    expect(onStateChange).toHaveBeenLastCalledWith(false, false);
    await chooseSource("第一季", `关联${sourceScene.name}`);
    await check(`关联${sourceScene.name}`);
    expect(onStateChange).toHaveBeenLastCalledWith(true, false);
    const submit = button("关联 1 个设定");
    await act(async () => {
        submit.click();
        submit.click();
    });
    await settleUntil(() => imported.mock.calls.length === 1 && onStateChange.mock.calls.at(-1)?.[1] === true);
    expect(onStateChange).toHaveBeenLastCalledWith(true, true);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="素材来源作品"]')?.disabled).toBe(true);
    expect([...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every((input) => input.disabled)).toBe(true);
    expect(button("取消", dialog).disabled).toBe(true);
    expect(button("全选", dialog).disabled).toBe(true);
    expect(dialog.querySelector(".ant-modal-close")).toBeNull();
    await click("取消", dialog);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish({ imported: 0, skipped: 1, cast: [] }));
    await settleUntil(() => !button("关联 1 个设定").disabled);
    expect(onStateChange).toHaveBeenLastCalledWith(true, false);
    await render(null);
    expect(onStateChange).toHaveBeenLastCalledWith(false, false);
});

test("external asset editing lock disables import but still permits cancellation", async () => {
    const { list, imported } = mockSources();
    const onClose = mock();
    const props = { projectId: "current", currentCast: [hero], onClose, onImported: () => {} };
    await render(<CastProjectImport {...props} />);
    await settleUntil(() => list.mock.calls.length === 1 && !document.querySelector(".ant-select-loading"));
    await chooseSource("第一季", `关联${sourceScene.name}`);
    await check(`关联${sourceScene.name}`);
    await render(<CastProjectImport {...props} disabled />);
    expect(button("关联 1 个设定").disabled).toBe(true);
    expect(button("取消").disabled).toBe(false);
    expect(checkbox(`关联${sourceScene.name}`).disabled).toBe(true);
    await click("关联 1 个设定");
    expect(imported).not.toHaveBeenCalled();
    await render(<CastProjectImport {...props} />);
    expect(button("关联 1 个设定").disabled).toBe(false);
    expect(checkbox(`关联${sourceScene.name}`).checked).toBe(true);
    await click("取消");
    expect(onClose).toHaveBeenCalledTimes(1);
});

test("import rejects mismatched account persistence scope before reading or writing data", async () => {
    const { list, casts, imported } = mockSources();
    window.localStorage.setItem("yingce:active-user-scope", "other-user");
    const onClose = mock();
    const onStateChange = mock();
    await render(<CastProjectImport projectId="current" currentCast={[hero]} onClose={onClose} onImported={() => {}} onStateChange={onStateChange} />);
    expect(list).not.toHaveBeenCalled();
    expect(casts).not.toHaveBeenCalled();
    expect(imported).not.toHaveBeenCalled();
    expect(button("关联 0 个设定").disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('[aria-label="素材来源作品"]')?.disabled).toBe(true);
    expect(onStateChange).toHaveBeenLastCalledWith(false, false);
    await click("取消");
    expect(onClose).toHaveBeenCalledTimes(1);
});

test("import identifies an empty source project list without offering unrelated asset types", async () => {
    const { list, casts } = mockSources();
    list.mockResolvedValue({ items: [{ project: { id: "current", name: "当前作品" } }], page: 1, pageSize: 100, total: 1, hasMore: false, statusCounts: {} } as DramaListPage);
    await render(<CastProjectImport projectId="current" kind="scene" currentCast={[hero]} onClose={() => {}} onImported={() => {}} />);
    await settleUntil(() => Boolean(document.body.textContent?.includes("暂无其他可导入的作品")));
    expect(casts).not.toHaveBeenCalled();
    expect(button("导入 0 个场景").disabled).toBe(true);
});

test("refetching or failed source data cannot submit stale selections and does not report them dirty", async () => {
    const { list, casts, imported } = mockSources();
    const onStateChange = mock();
    await render(<CastProjectImport projectId="current" currentCast={[hero]} onClose={() => {}} onImported={() => {}} onStateChange={onStateChange} />);
    await settleUntil(() => list.mock.calls.length === 1 && !document.querySelector(".ant-select-loading"));
    await chooseSource("第一季", `关联${sourceScene.name}`);
    await check(`关联${sourceScene.name}`);
    expect(onStateChange).toHaveBeenLastCalledWith(true, false);
    let fail!: (error: Error) => void;
    casts.mockImplementation(() => new Promise((_, reject) => (fail = reject)));
    await act(async () => {
        void client.invalidateQueries({ queryKey: ["drama", "season-one", "cast"] });
    });
    await settleUntil(() => casts.mock.calls.length === 2 && onStateChange.mock.calls.at(-1)?.[0] === false);
    expect(button("关联 0 个设定").disabled).toBe(true);
    expect(onStateChange).toHaveBeenLastCalledWith(false, false);
    await click("关联 0 个设定");
    expect(imported).not.toHaveBeenCalled();
    await act(async () => fail(new Error("来源素材读取失败")));
    await settleUntil(() => Boolean(document.querySelector('[role="alert"]')?.textContent?.includes("读取素材失败")));
    expect(button("关联 0 个设定").disabled).toBe(true);
    expect(onStateChange).toHaveBeenLastCalledWith(false, false);
    expect(imported).not.toHaveBeenCalled();
});

for (const changed of ["project", "account", "persistence scope", "unmounted"] as const) {
    for (const outcome of ["success", "error"] as const) {
        test(`late import ${outcome} cannot affect the page after ${changed} changed`, async () => {
            const { list, imported } = mockSources();
            let finish!: (result: Awaited<ReturnType<typeof api.importDramaCast>>) => void;
            let fail!: (error: Error) => void;
            imported.mockImplementation(
                () =>
                    new Promise((resolve, reject) => {
                        finish = resolve;
                        fail = reject;
                    }),
            );
            const onClose = mock();
            const onImported = mock();
            const onStateChange = mock();
            const props = { projectId: "current", currentCast: [hero], onClose, onImported, onStateChange };
            await render(<CastProjectImport {...props} />);
            await settleUntil(() => list.mock.calls.length === 1 && !document.querySelector(".ant-select-loading"));
            await chooseSource("第一季", `关联${sourceScene.name}`);
            await check(`关联${sourceScene.name}`);
            await click("关联 1 个设定");
            await settleUntil(() => imported.mock.calls.length === 1);
            if (changed === "project") await render(<CastProjectImport {...props} projectId="other-project" />);
            else if (changed === "account") await act(async () => useUserStore.setState({ user: { id: "other-user" } as never }));
            else if (changed === "persistence scope") {
                window.localStorage.setItem("yingce:active-user-scope", "other-scope");
                await render(<CastProjectImport {...props} />);
            } else await render(null);
            expect(onStateChange).toHaveBeenLastCalledWith(false, false);
            await act(async () => {
                if (outcome === "success") finish({ imported: 1, skipped: 0, cast: [sourceScene] });
                else fail(new Error("过期导入错误"));
            });
            expect(onImported).not.toHaveBeenCalled();
            expect(onClose).not.toHaveBeenCalled();
            expect(document.body.textContent).not.toContain("已关联 1 项素材");
            expect(document.body.textContent).not.toContain("过期导入错误");
            expect(onStateChange).toHaveBeenLastCalledWith(false, false);
            if (changed !== "unmounted") expect(button("关联 0 个设定").disabled).toBe(true);
        });
    }
}

function ImageFieldsHarness({ initial = {}, onChange = () => {}, overrideAppearance, episodeId }: { initial?: CastImageFieldsValue; onChange?: (patch: CastImageFieldsValue) => void; overrideAppearance?: string; episodeId?: string }) {
    const [appearance, setAppearance] = useState("初始外观");
    const [value, setValue] = useState(initial);
    return (
        <>
            <input aria-label="当前外观" value={appearance} onChange={(event) => setAppearance(event.target.value)} />
            <CastImageFields
                projectId="current"
                episodeId={episodeId}
                castId={evening.id}
                appearance={overrideAppearance ?? appearance}
                value={value}
                onChange={(patch) => {
                    setValue((previous) => ({ ...previous, ...patch }));
                    onChange(patch);
                }}
            />
        </>
    );
}
async function enableOwnStyle() {
    const label = [...document.querySelectorAll<HTMLLabelElement>("label")].find((item) => item.textContent?.includes("为此设定单独设置风格"));
    const control = label?.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(control).toBeDefined();
    await act(async () => control!.click());
}

test("prompt rebuilding uses the currently edited appearance and compatible preset without saving or generating", async () => {
    const rebuilt = spyOn(api, "rebuildDramaCastImagePrompt").mockResolvedValue({ imagePrompt: "已编排：3D 都市，白色风衣" });
    const save = spyOn(api, "updateDramaCastLook").mockResolvedValue({ look: evening, affectedSegments: 0 });
    const generation = spyGeneration();
    const changed = mock();
    await render(<ImageFieldsHarness initial={{ imagePrompt: "手写原提示词" }} onChange={changed} episodeId="episode-b" />);
    await fill("当前外观", "白色风衣，短发，银色耳饰");
    await enableOwnStyle();
    const style = findDramaStyle("3d-guoman")!;
    const presets = document.querySelector<HTMLSelectElement>('select[aria-label="参考图风格"]')!;
    expect(presets.querySelector('option[value="live-sweet"]')).toBeNull();
    expect(presets.querySelector('option[value="2d-webtoon"]')).not.toBeNull();
    const selectedPreset = presets.value;
    const changesBeforeFilter = changed.mock.calls.length;
    const filter = document.querySelector<HTMLSelectElement>('select[aria-label="题材筛选"]')!;
    await act(async () => {
        filter.value = "xianxia";
        filter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(changed).toHaveBeenCalledTimes(changesBeforeFilter);
    expect(presets.value).toBe(selectedPreset);
    expect(presets.selectedOptions[0]?.disabled).toBe(true);
    expect(presets.querySelector('option[value="2d-webtoon"]')).toBeNull();
    expect(presets.querySelector('option[value="live-sweet"]')).toBeNull();
    expect(presets.querySelector('option[value="3d-guoman"]')).not.toBeNull();
    await chooseImageStyle(style.id);
    expect(rebuilt).not.toHaveBeenCalled();
    await click("重新编排提示词");
    expect(rebuilt).not.toHaveBeenCalled();
    await click("确认替换", [...document.querySelectorAll('[role="dialog"]')].at(-1)!);
    expect(rebuilt).toHaveBeenCalledWith("current", evening.id, { episodeId: "episode-b", appearance: "白色风衣，短发，银色耳饰", imageStyleId: style.id, imageStyleName: style.name, imageStylePrompt: style.prompt });
    expect(changed).toHaveBeenLastCalledWith({ imagePrompt: "已编排：3D 都市，白色风衣" });
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="参考图生成提示词"]')?.value).toBe("已编排：3D 都市，白色风衣");
    expect(save).not.toHaveBeenCalled();
    expectNoGeneration(generation);
});

test("failed prompt rebuilding retains the user's current input", async () => {
    const style = findDramaStyle(composeDramaStyleId("2d", "xuanhuan"))!;
    const rebuilt = spyOn(api, "rebuildDramaCastImagePrompt").mockRejectedValue(new Error("编排暂时不可用"));
    const changed = mock();
    await render(<ImageFieldsHarness initial={{ imagePrompt: "初始提示词", imageStyleId: style.id, imageStyleName: style.name, imageStylePrompt: style.prompt }} onChange={changed} />);
    await fill("参考图生成提示词", "保留我手工输入的服装和表情");
    const changesBefore = changed.mock.calls.length;
    await click("重新编排提示词");
    await click("确认替换", [...document.querySelectorAll('[role="dialog"]')].at(-1)!);
    expect(rebuilt).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(changesBefore);
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="参考图生成提示词"]')?.value).toBe("保留我手工输入的服装和表情");
    expect(button("重新编排提示词").disabled).toBe(false);
});

test("an outdated rebuild response does not overwrite input after appearance changes", async () => {
    let resolve!: (value: { imagePrompt: string }) => void;
    const rebuilt = spyOn(api, "rebuildDramaCastImagePrompt").mockReturnValue(
        new Promise((done) => {
            resolve = done;
        }),
    );
    const changed = mock();
    await render(<ImageFieldsHarness initial={{ imagePrompt: "原有手工提示词" }} onChange={changed} overrideAppearance="旧外观" />);
    await click("重新编排提示词");
    await click("确认替换", [...document.querySelectorAll('[role="dialog"]')].at(-1)!);
    expect(rebuilt).toHaveBeenCalledTimes(1);
    await render(<ImageFieldsHarness initial={{ imagePrompt: "原有手工提示词" }} onChange={changed} overrideAppearance="新外观" />);
    await act(async () => resolve({ imagePrompt: "基于旧外观的过期提示词" }));
    expect(changed).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="参考图生成提示词"]')?.value).toBe("原有手工提示词");
});

for (const [kind, label] of [
    ["character", "外貌描述"],
    ["scene", "环境描述"],
    ["prop", "外形描述"],
] as const) {
    test(`${kind}图片配置与文字全部自动保存、不生成`, async () => {
        const target = castFixture(`auto-${kind}`, "自动保存资产", { kind, imageOptionsJson: JSON.stringify({ subjectReferenceIds: ["subject-reference"] }) });
        const save = spyOn(api, "updateDramaCast").mockImplementation(async (_projectId, _castId, patch) => ({ cast: { ...target, revision: 2, imageOptionsJson: JSON.stringify(patch.imageOptions) } }));
        const generation = spyGeneration();
        await render(<DialogHarness castId={target.id} items={[target]} />);
        const editor = document.querySelector(".drama-cast-dialog")!;
        await fill(label, "未保存的文字草稿", editor);
        await click("移除主体参考 1", editor);
        await waitForAutoSave();
        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0][2]).toEqual({
            appearance: "未保存的文字草稿",
            imageOptions: { model: {}, ratio: "", resolution: "", subjectReferenceIds: [], styleReferenceIds: [] },
            expectedRevision: 9,
            expectedCastRevision: 1,
        });
        expect(editor.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)?.value).toBe("未保存的文字草稿");
        expect(editor.textContent).not.toContain("保存修改");
        expect(editor.querySelector(".drama-cast-dialog-save-state")).toBeNull();
        expectNoGeneration(generation);
    });
}

test("纯图片配置待同步只上报忙碌，完成后关闭不弹放弃确认", async () => {
    const target = { ...hero, imageOptionsJson: JSON.stringify({ subjectReferenceIds: ["subject-reference"] }) };
    let finish!: (value: { cast: DramaCast }) => void;
    const save = spyOn(api, "updateDramaCast").mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const states: Array<[boolean, boolean]> = [];
    const closed = mock();
    await render(<DialogHarness castId={target.id} items={[target]} onClose={closed} onDirtyChange={(dirty, busy) => states.push([dirty, busy])} />);
    const editor = document.querySelector(".drama-cast-dialog")!;
    await click("移除主体参考 1", editor);
    expect(states.at(-1)).toEqual([false, true]);
    await waitForAutoSave();
    expect(save).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toEqual([false, true]);
    await act(async () => finish({ cast: { ...target, revision: 2, imageOptionsJson: JSON.stringify(save.mock.calls[0][2].imageOptions) } }));
    await settleUntil(() => states.at(-1)?.[1] === false);
    expect(states.at(-1)).toEqual([false, false]);
    await click("关闭资产设定", editor);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".ant-modal-confirm")).toBeNull();
});

test("离开资产后自动保存的迟到回执不刷新旧会话、不影响新资产", async () => {
    const target = { ...hero, imageOptionsJson: JSON.stringify({ subjectReferenceIds: ["subject-reference"] }) };
    let finish!: (value: { cast: DramaCast }) => void;
    spyOn(api, "updateDramaCast").mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const readSummary = spyOn(api, "getDrama").mockResolvedValue(dialogSummary);
    const changed = mock();
    await render(<DialogHarness castId={target.id} items={[target]} onChanged={changed} />);
    await click("移除主体参考 1", document.querySelector(".drama-cast-dialog")!);
    await waitForAutoSave();
    await render(<DialogHarness castId={room.id} items={[room]} onChanged={changed} />);
    const readsBeforeReply = readSummary.mock.calls.length;
    await act(async () => finish({ cast: { ...target, revision: 2, imageOptionsJson: "{}" } }));
    await settle();
    expect(readSummary).toHaveBeenCalledTimes(readsBeforeReply);
    expect(changed).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('[aria-label="名称"]')?.value).toBe(room.name);
});

test("统一保存文字与图片草稿只发一次原子PATCH，图片配置不再有第二个保存按钮", async () => {
    const target = { ...hero, imageOptionsJson: JSON.stringify({ subjectReferenceIds: ["subject-reference"] }) };
    const save = spyOn(api, "updateDramaCast").mockResolvedValue({ cast: { ...target, revision: 2 } });
    const oldOptions = spyOn(api, "updateDramaCastImageOptions").mockResolvedValue({ cast: target });
    const generation = spyGeneration();
    await render(<DialogHarness castId={target.id} items={[target]} />);
    const editor = document.querySelector(".drama-cast-dialog")!;
    expect(editor.textContent).not.toContain("保存图片配置");
    await fill("外貌描述", "白色风衣与银色纽扣", editor);
    await click("移除主体参考 1", editor);
    await waitForAutoSave();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("current", target.id, { expectedRevision: 9, expectedCastRevision: 1, appearance: "白色风衣与银色纽扣", imageOptions: { model: {}, ratio: "", resolution: "", subjectReferenceIds: [], styleReferenceIds: [] } });
    expect(oldOptions).not.toHaveBeenCalled();
    expectNoGeneration(generation);
    expect(editor.textContent).not.toContain("保存修改");
});

test("只修改图片时不伪造文字变化，版本冲突保留两组草稿且不生成", async () => {
    const target = { ...hero, imageOptionsJson: JSON.stringify({ subjectReferenceIds: ["subject-reference"] }) };
    const save = spyOn(api, "updateDramaCast").mockRejectedValue(new ApiError("主体版本已变化", { status: 409 }));
    spyOn(api, "listDramaCast").mockResolvedValue({ cast: [target] });
    const generation = spyGeneration();
    await render(<DialogHarness castId={target.id} items={[target]} />);
    const editor = document.querySelector(".drama-cast-dialog")!;
    await click("移除主体参考 1", editor);
    await waitForAutoSave();
    const patch = save.mock.calls[0][2];
    expect(patch).toEqual({ expectedRevision: 9, expectedCastRevision: 1, imageOptions: { model: {}, ratio: "", resolution: "", subjectReferenceIds: [], styleReferenceIds: [] } });
    expect(button("重试保存", editor).disabled).toBe(false);
    await fill("外貌描述", "冲突后继续编辑的外观", editor);
    await render(<DialogHarness castId={target.id} items={[{ ...target, revision: 2, appearance: "外部已保存的外观" }]} />);
    expect(editor.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe("冲突后继续编辑的外观");
    expect(editor.querySelector('[aria-label="移除主体参考 1"]')).toBeNull();
    expectNoGeneration(generation);
});

test("主视觉允许两组草稿保存并生成，保存失败时完整保稿且不提交生成", async () => {
    const target = { ...hero, imageOptionsJson: JSON.stringify({ styleReferenceIds: ["style-reference"] }) };
    const save = spyOn(api, "updateDramaCast").mockRejectedValue(new ApiError("配置冲突", { status: 409 }));
    spyOn(api, "listDramaCast").mockResolvedValue({ cast: [target] });
    const generation = spyGeneration();
    await render(<DialogHarness castId={target.id} items={[target]} />);
    const editor = document.querySelector(".drama-cast-dialog")!;
    await fill("外貌描述", "保留外观草稿", editor);
    await click("移除风格参考 1", editor);
    await waitForAutoSave();
    expect(imageGenerationButton(editor).disabled).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expectNoGeneration(generation);
    expect(editor.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe("保留外观草稿");
    expect(editor.querySelector('[aria-label="移除风格参考 1"]')).toBeNull();
    expect(button("重试保存", editor).disabled).toBe(false);
});

for (const outcome of ["rejected", "uncertain"] as const) {
    test(`保存成功后生成${outcome}单独反馈，不回滚保存或自动重发`, async () => {
        const target = { ...hero, imageOptionsJson: JSON.stringify({ subjectReferenceIds: ["subject-reference"] }) };
        const save = spyOn(api, "updateDramaCast").mockResolvedValue({ cast: { ...target, revision: 2 } });
        const generation = spyGeneration();
        generation.single.mockRejectedValue(outcome === "rejected" ? new ApiError("模型不可用", { status: 400 }) : new Error("响应断开"));
        spyOn(api, "listDramaCast").mockResolvedValue({ cast: [{ ...target, imageStatus: "queued" }] });
        await render(<DialogHarness castId={target.id} items={[target]} />);
        const editor = document.querySelector(".drama-cast-dialog")!;
        await fill("外貌描述", "已保存的外观", editor);
        await click("移除主体参考 1", editor);
        await waitForAutoSave();
        await clickImageGeneration(editor);
        expect(save).toHaveBeenCalledTimes(1);
        expect(generation.single).toHaveBeenCalledTimes(1);
        expect(editor.textContent).toContain(outcome === "rejected" ? "生成提交失败" : "生成提交结果待核对");
        expect(editor.querySelector(".drama-cast-dialog-save-state")).toBeNull();
        if (outcome === "uncertain") {
            expect(imageGenerationButton(editor).disabled).toBe(true);
            await click("核对生成状态", editor);
            expect(editor.textContent).toContain("已核对到生成任务或新图片");
            expect(generation.single).toHaveBeenCalledTimes(1);
        }
    });
}

test("非空提示词覆盖取消时零编排，空提示词直接编排且不保存生成", async () => {
    const rebuilt = spyOn(api, "rebuildDramaCastImagePrompt").mockResolvedValue({ imagePrompt: "新的编排草稿" });
    const changed = mock();
    const generation = spyGeneration();
    await render(<ImageFieldsHarness initial={{ imagePrompt: "手写提示词" }} onChange={changed} />);
    await click("重新编排提示词");
    expect(rebuilt).not.toHaveBeenCalled();
    await click("取消", [...document.querySelectorAll('[role="dialog"]')].at(-1)!);
    expect(rebuilt).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    await fill("参考图生成提示词", "");
    await click("重新编排提示词");
    expect(rebuilt).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith({ imagePrompt: "新的编排草稿" });
    expectNoGeneration(generation);
});

function independentView(cast: DramaCast, id: string, name: string): CastView {
    return {
        id,
        projectId: "current",
        castId: cast.id,
        revision: 4,
        config: { name, direction: "front", prompt: `${name}补充提示词`, imageOptions: { model: {}, ratio: "", resolution: "" } },
        resourceId: `${id}-image`,
        status: "ready",
        takes: [{ id: `${id}-take`, version: 8, kind: "image", resourceId: `${id}-old`, status: "ready", current: false, source: "model", createdAt: "2026-11-15" } as never],
    };
}
for (const target of [hero, room, castFixture("prop", "玉佩", { kind: "prop" }), evening]) {
    test(`${target.parentId ? "look" : target.kind}底部选择联动独立视图配置、预览与版本，再返回主视觉`, async () => {
        const front = independentView(target, "front-view", "正面图");
        const back = independentView(target, "back-view", "背面图");
        spyOn(viewApi, "listDramaCastViews").mockResolvedValue({ views: [front, back] });
        const save = spyOn(viewApi, "saveDramaCastView").mockResolvedValue(front);
        const generation = spyGeneration();
        await render(<DialogHarness castId={target.id} items={[hero, target]} />);
        await click("选择正面图独立视图");
        const workspace = document.querySelector('[aria-label="正面图工作区"]')!;
        expect(workspace).not.toBeNull();
        expect(workspace.querySelector<HTMLInputElement>('[aria-label="视图名称"]')?.value).toBe("正面图");
        expect(workspace.querySelector('[aria-label="放大查看正面图"]')).not.toBeNull();
        expect(workspace.querySelector('[aria-label="独立视图版本记录"]')?.textContent).toContain("正面图 · 版本记录");
        expect(workspace.querySelector('[aria-label="独立视图版本记录"]')?.textContent).toContain("版本 8");
        expect(button("选择正面图独立视图").getAttribute("aria-selected")).toBe("true");
        await click("选择背面图独立视图");
        expect(document.querySelector<HTMLInputElement>('[aria-label="视图名称"]')?.value).toBe("背面图");
        expect(document.querySelector('[aria-label="独立视图版本记录"]')?.textContent).toContain("背面图 · 版本记录");
        await click("选择主视觉");
        expect(document.querySelector('[aria-label="当前参考图"]')).not.toBeNull();
        expect(document.querySelector('[aria-label="参考图历史"]')).not.toBeNull();
        expect(save).not.toHaveBeenCalled();
        expectNoGeneration(generation);
    });
}

test("独立视图右侧版本可预览历史原图，关闭后停留在当前视图", async () => {
    const front = independentView(hero, "front-view", "正面图");
    const oldImage = front.takes[0].resourceId!;
    const oldImageUrl = "https://example.test/front-view-old.png";
    const resolveImage = spyOn(imageStorage, "resolveImageUrl").mockResolvedValue(oldImageUrl);
    spyOn(viewApi, "listDramaCastViews").mockResolvedValue({ views: [front] });
    const adopt = spyOn(viewApi, "adoptDramaCastView").mockResolvedValue(front);
    const onClose = mock();
    await render(<DialogHarness castId={hero.id} items={[hero]} onClose={onClose} />);
    await click("选择正面图独立视图");
    const workspace = document.querySelector('[aria-label="正面图工作区"]')!;
    const historyPanel = workspace.querySelector('[aria-label="独立视图版本记录"]')!;
    const trigger = button("放大查看正面图版本 8", historyPanel);
    trigger.focus();
    await act(async () => trigger.click());
    await settleUntil(() => Boolean(document.querySelector(".canvas-image-preview-modal img")));
    const preview = document.querySelector(".canvas-image-preview-modal")!;
    expect(resolveImage).toHaveBeenCalledWith(`resource:${oldImage}`, "");
    expect(preview.querySelector<HTMLImageElement>("img")?.src).toBe(oldImageUrl);
    expect(adopt).not.toHaveBeenCalled();

    const previewStage = preview.querySelector<HTMLElement>('[role="region"]')!;
    previewStage.focus();
    expect(document.activeElement === previewStage).toBe(true);
    await act(async () => previewStage.dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, key: "Escape", keyCode: 27 }) as unknown as Event));
    await settleUntil(() => !document.querySelector(".canvas-image-preview-modal"));
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="正面图工作区"]') === workspace).toBe(true);
    expect(document.activeElement === trigger).toBe(true);
    expect(button("采用此版本", historyPanel)).toBeDefined();
});

test("独立视图在当前工作区单独保存、报价后一键生成和采用版本，主体dirty阻止切换", async () => {
    let row = independentView(hero, "front-view", "正面图");
    spyOn(viewApi, "listDramaCastViews").mockImplementation(async () => ({ views: [row] }));
    const viewSave = spyOn(viewApi, "saveDramaCastView").mockImplementation(async (_project, _cast, _id, input) => {
        row = { ...row, revision: 5, config: input.config };
        return row;
    });
    const mainSave = spyOn(api, "updateDramaCast").mockResolvedValue({ cast: hero });
    const check = spyOn(viewApi, "preflightDramaCastView").mockImplementation(async (_project, _cast, _id, input) => ({
        revision: 9,
        viewRevision: input.viewRevision!,
        ready: true,
        priced: true,
        estimated: true,
        amountMicrocredits: 1_000_000,
        scopeHash: "view-scope",
        confirmationToken: "view-token",
    }));
    const execute = spyOn(viewApi, "executeDramaCastView").mockResolvedValue({ id: "view-task" } as never);
    const adopt = spyOn(viewApi, "adoptDramaCastView").mockResolvedValue(row);
    await render(<DialogHarness castId={hero.id} items={[hero]} episodeId="episode-b" />);
    await fill("外貌描述", "主体的未保存修改");
    expect(button("选择正面图独立视图").disabled).toBe(true);
    await fill("外貌描述", hero.appearance);
    await click("选择正面图独立视图");
    await fill("视图名称", "正面特写");
    expect(button("生成图片 - 计价中").disabled).toBe(true);
    await waitForAutoSave();
    expect(viewSave).toHaveBeenCalledWith("current", hero.id, row.id, expect.objectContaining({ episodeId: "episode-b", expectedRevision: 9, expectedCastRevision: 1, viewRevision: 4, config: expect.objectContaining({ name: "正面特写" }) }));
    expect(mainSave).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await settleUntil(() => Boolean([...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.replace(/\s/g, "") === "生成图片-1积分" && !item.disabled)));
    expect(check).toHaveBeenCalledWith("current", hero.id, row.id, { episodeId: "episode-b", expectedRevision: 9, viewRevision: 5 });
    expect(execute).not.toHaveBeenCalled();
    await click("生成图片 - 1积分");
    expect(execute).toHaveBeenCalledWith("current", hero.id, row.id, expect.objectContaining({ episodeId: "episode-b", expectedRevision: 9, viewRevision: 5, confirmationToken: "view-token", clientOperationId: expect.stringContaining("cast-view:") }));
    await click("采用此版本");
    expect(adopt).toHaveBeenCalledWith("current", hero.id, row.id, { expectedRevision: 9, viewRevision: 5, takeId: row.takes[0].id });
});

test("独立视图连续保存与采用后再保存都使用刷新后的作品和视图版本", async () => {
    let revision = 9;
    let row = independentView(hero, "front-view", "正面图");
    spyOn(api, "getDrama").mockImplementation(async () => ({ ...dialogSummary, production: { ...dialogSummary.production, revision } }));
    spyOn(viewApi, "listDramaCastViews").mockImplementation(async () => ({ views: [row] }));
    const save = spyOn(viewApi, "saveDramaCastView").mockImplementation(async (_project, _cast, _id, input) => {
        if (input.expectedRevision !== revision || input.viewRevision !== row.revision) throw new ApiError("旧版本", { status: 409 });
        revision++;
        row = { ...row, revision: row.revision + 1, config: input.config };
        return row;
    });
    spyOn(viewApi, "adoptDramaCastView").mockImplementation(async () => {
        revision++;
        row = { ...row, revision: row.revision + 1 };
        return row;
    });
    await render(<DialogHarness castId={hero.id} items={[hero]} />);
    await click("选择正面图独立视图");
    await fill("视图补充提示词", "第一轮提示词");
    await waitForAutoSave();
    await settle();
    await fill("视图补充提示词", "第二轮提示词");
    await waitForAutoSave();
    await settle();
    expect(save.mock.calls[0][3]).toEqual(expect.objectContaining({ expectedRevision: 9, viewRevision: 4 }));
    expect(save.mock.calls[1][3]).toEqual(expect.objectContaining({ expectedRevision: 10, viewRevision: 5 }));
    await click("采用此版本");
    await settle();
    await fill("视图补充提示词", "采用后继续编辑");
    await waitForAutoSave();
    await settle();
    expect(save.mock.calls[2][3]).toEqual(expect.objectContaining({ expectedRevision: 12, viewRevision: 7 }));
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="视图补充提示词"]')?.value).toBe("采用后继续编辑");
});

test("独立视图外部版本更新时保留当前dirty配置，冲突不覆盖草稿", async () => {
    let revision = 9;
    let row = independentView(hero, "front-view", "正面图");
    spyOn(api, "getDrama").mockImplementation(async () => ({ ...dialogSummary, production: { ...dialogSummary.production, revision } }));
    spyOn(viewApi, "listDramaCastViews").mockImplementation(async () => ({ views: [row] }));
    const save = spyOn(viewApi, "saveDramaCastView").mockRejectedValue(new ApiError("视图版本已变化", { status: 409 }));
    await render(<DialogHarness castId={hero.id} items={[hero]} />);
    await click("选择正面图独立视图");
    await fill("视图补充提示词", "保留手工视图草稿");
    revision = 10;
    row = { ...row, revision: 5, config: { ...row.config, prompt: "其他标签页保存的内容" } };
    await act(async () => {
        await client.refetchQueries({ queryKey: ["drama-cast-views"] });
        await client.refetchQueries({ queryKey: ["drama", "current"], exact: true });
    });
    await settleUntil(() => Boolean(document.querySelector(".drama-editor-settings")?.textContent?.includes("当前草稿已保留")));
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="视图补充提示词"]')?.value).toBe("保留手工视图草稿");
    expect(document.querySelector(".drama-editor-settings")?.textContent).toContain("当前草稿已保留");
    await waitForAutoSave();
    expect(save).toHaveBeenCalledWith("current", hero.id, row.id, expect.objectContaining({ expectedRevision: 9, viewRevision: 4 }));
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="视图补充提示词"]')?.value).toBe("保留手工视图草稿");
});

test("独立视图新增与删除直接在工作区完成，不自动生成", async () => {
    let revision = 9;
    let views: CastView[] = [];
    spyOn(api, "getDrama").mockImplementation(async () => ({ ...dialogSummary, production: { ...dialogSummary.production, revision } }));
    spyOn(viewApi, "listDramaCastViews").mockImplementation(async () => ({ views }));
    const save = spyOn(viewApi, "saveDramaCastView").mockImplementation(async (_project, _cast, _id, input) => {
        revision++;
        const row = { ...independentView(hero, "new-view", input.config.name), revision: 1, config: input.config, takes: [] };
        views = [row];
        return row;
    });
    const remove = spyOn(viewApi, "deleteDramaCastView").mockImplementation(async () => {
        revision++;
        views = [];
        return { deleted: true };
    });
    const generation = spyGeneration();
    await render(<DialogHarness castId={hero.id} items={[hero]} />);
    await settleUntil(() => !button("添加视图").disabled);
    const addTile = button("添加视图");
    expect(addTile.classList.contains("drama-cast-add-tile")).toBe(true);
    expect(addTile.textContent?.trim()).toBe("添加视图");
    expect(document.body.textContent).not.toContain("暂无独立视图，可按需新增。");
    await click("添加视图");
    await fill("视图名称", "新增正面");
    await waitForAutoSave();
    await settleUntil(() => Boolean(document.querySelector('[aria-label="新增正面工作区"]')));
    expect(save).toHaveBeenCalledWith("current", hero.id, undefined, expect.objectContaining({ expectedRevision: 9, expectedCastRevision: 1, viewRevision: 0 }));
    await settleUntil(() => !button("删除视图").disabled);
    await click("删除视图");
    await click("删除视图", [...document.querySelectorAll('[role="dialog"]')].at(-1)!);
    expect(remove).toHaveBeenCalledWith("current", hero.id, "new-view", { expectedRevision: 10, viewRevision: 1 });
    await settleUntil(() => Boolean(document.querySelector('[aria-label="当前参考图"]')));
    expectNoGeneration(generation);
});

test("独立视图自动保存失败后直接放弃返回主视觉，不再确认或重试", async () => {
    const row = independentView(hero, "front-view", "正面图");
    spyOn(viewApi, "listDramaCastViews").mockResolvedValue({ views: [row] });
    const save = spyOn(viewApi, "saveDramaCastView").mockRejectedValue(new ApiError("视图版本已变化", { status: 409 }));
    const generation = spyGeneration();
    await render(<DialogHarness castId={hero.id} items={[hero]} />);
    await click("选择正面图独立视图");
    await fill("视图名称", "冲突后保留的草稿");
    await waitForAutoSave();
    expect(document.body.textContent).toContain("视图版本已变化");
    await click("放弃修改并关闭");
    expect(document.querySelector('[aria-label="当前参考图"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="视图名称"]')).toBeNull();
    expect(document.querySelector(".ant-modal-confirm")).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
    expectNoGeneration(generation);
});

test("主视觉打开时可直接核对已有独立视图的待确认提交，不重新预检或更换提交标识", async () => {
    const row = independentView(hero, "front-view", "正面图");
    const pending = { viewId: row.id, action: { expectedRevision: 9, viewRevision: 4, confirmationToken: "original-token", clientOperationId: "original-operation" } };
    spyOn(viewApi, "listDramaCastViews").mockResolvedValue({ views: [row] });
    spyOn(viewState, "readCastViewPending").mockResolvedValue(pending);
    const execute = spyOn(viewApi, "executeDramaCastView").mockResolvedValue({ id: "original-task" } as never);
    const check = spyOn(viewApi, "preflightDramaCastView");
    await render(<DialogHarness castId={hero.id} items={[hero]} />);
    expect(button("选择主视觉").getAttribute("aria-selected")).toBe("true");
    await click("确认提交结果");
    expect(execute).toHaveBeenCalledWith("current", hero.id, row.id, pending.action);
    expect(check).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="当前参考图"]')).not.toBeNull();
});

test("独立视图作品配置读取失败时主视觉旁可刷新状态，恢复后允许继续操作", async () => {
    const read = spyOn(api, "getDrama").mockRejectedValue(new Error("暂时断线"));
    await render(<DialogHarness castId={hero.id} items={[hero]} />);
    await settleUntil(() => Boolean(document.body.textContent?.includes("作品配置读取失败")));
    expect(button("添加视图").disabled).toBe(true);
    read.mockResolvedValue(dialogSummary);
    await click("刷新视图状态");
    await settleUntil(() => !button("添加视图").disabled);
    expect(document.body.textContent).not.toContain("作品配置读取失败");
});
