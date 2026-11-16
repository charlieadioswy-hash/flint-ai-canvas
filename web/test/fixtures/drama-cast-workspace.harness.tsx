import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { DramaCast, DramaListPage, DramaSummary, DramaWorkflowImpact } from "../../src/services/api/drama";
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
const { CastImageFields } = await import("../../src/pages/projects/studio/cast-image-fields");
const { composeDramaStyleId, findDramaStyle } = await import("../../src/lib/drama/drama-styles");
const api = await import("../../src/services/api/drama");
const viewApi = await import("../../src/services/api/drama-cast-views");
const viewState = await import("../../src/pages/projects/studio/cast-views-state");
const resources = await import("../../src/services/api/resources");
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
    useUserStore.setState({ user: { id: "workspace-user" } as never });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    spyOn(resources, "getResourceAccess").mockRejectedValue(new Error("No remote media in this fixture"));
    spyOn(api, "getDramaCastImpact").mockImplementation(async (_projectId, castId) => impactOf(castId));
    spyOn(api, "getDrama").mockResolvedValue(dialogSummary);
    spyOn(api, "listDramaTakes").mockResolvedValue({ takes: [] });
    spyOn(viewApi, "listDramaCastViews").mockResolvedValue({ views: [] });
    spyOn(viewState, "readCastViewPending").mockResolvedValue(undefined);
    spyOn(viewState, "writeCastViewPending").mockResolvedValue(undefined);
    spyOn(viewState, "clearCastViewPending").mockResolvedValue(undefined);
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
async function chooseAxis(label: string, value: string) {
    const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    expect(select).not.toBeNull();
    await act(async () => {
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
    });
}
async function settleUntil(predicate: () => boolean) {
    for (let attempt = 0; attempt < 30 && !predicate(); attempt++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(predicate()).toBe(true);
}
function spyGeneration() {
    return {
        single: spyOn(api, "regenerateDramaCast").mockResolvedValue({ affectedSegments: 0 }),
        batch: spyOn(api, "regenerateDramaCasts").mockResolvedValue({ queued: 0, skipped: 0, affectedSegments: 0 }),
    };
}
function expectNoGeneration(generation: ReturnType<typeof spyGeneration>) {
    expect(generation.single).not.toHaveBeenCalled();
    expect(generation.batch).not.toHaveBeenCalled();
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
function DialogHarness({ castId, items, onChanged = () => {}, onClose = () => {} }: { castId: string; items: DramaCast[]; onChanged?: () => void; onClose?: () => void }) {
    const [open, setOpen] = useState(true);
    const location = useLocation();
    return (
        <>
            <output data-dialog-route>{location.pathname + location.search}</output>
            <CastEditorDialog
                summary={dialogSummary}
                cast={items}
                castId={open ? castId : undefined}
                onChanged={onChanged}
                onClose={() => {
                    setOpen(false);
                    onClose();
                }}
            />
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
        await click("保存修改", dialog);
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

test("有视频依赖时保存并重新生成先提示，取消零写入，明确确认后才保存并生成", async () => {
    const writes: string[] = [];
    const save = spyOn(api, "updateDramaCast").mockImplementation(async () => {
        writes.push("save");
        return { cast: hero };
    });
    const saveLook = spyOn(api, "updateDramaCastLook").mockResolvedValue({ look: evening, affectedSegments: 0 });
    const generation = spyGeneration();
    generation.single.mockImplementation(async () => {
        writes.push("generate");
        return { affectedSegments: 2 };
    });
    let resolveImpact!: (impact: DramaWorkflowImpact) => void;
    const pendingImpact = new Promise<DramaWorkflowImpact>((resolve) => {
        resolveImpact = resolve;
    });
    const impactRead = spyOn(api, "getDramaCastImpact").mockReturnValue(pendingImpact);
    const changed = mock();
    await render(<DialogHarness castId={hero.id} items={[hero]} onChanged={changed} />);
    const editor = document.querySelector(".drama-cast-dialog")!;
    expect(impactRead).not.toHaveBeenCalled();
    expect(editor.querySelector('[aria-label="资产影响范围"]')).toBeNull();
    expect(editor.querySelector('[aria-label="已有视频影响范围"]')).toBeNull();
    await fill("外貌描述", "保留未保存的白色外套与银色纽扣", editor);
    await click("保存并重新生成", editor);
    expect(impactRead).toHaveBeenCalledWith("current", hero.id);
    expect(save).not.toHaveBeenCalled();
    expect(saveLook).not.toHaveBeenCalled();
    expectNoGeneration(generation);
    await act(async () => resolveImpact(impactOf(hero.id, true)));
    await settleUntil(() => Boolean(document.querySelector('[aria-label="已有视频影响范围"]')));
    const firstConfirmation = [...document.querySelectorAll('[role="dialog"]')].at(-1)!;
    expect(firstConfirmation.textContent).toContain("已有 2 段视频");
    expect(firstConfirmation.textContent).toContain("第 1 集 · 第 1 段");
    expect(firstConfirmation.textContent).toContain("第 2 集 · 第 2 段");
    expect(save).not.toHaveBeenCalled();
    expectNoGeneration(generation);
    await click("取消", firstConfirmation);
    await settleUntil(() => !button("保存并重新生成", editor).disabled);
    expect(writes).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    expect(editor.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe("保留未保存的白色外套与银色纽扣");
    await click("保存并重新生成", editor);
    await settleUntil(() => {
        const latest = [...document.querySelectorAll('[role="dialog"]')].at(-1);
        return Boolean(latest && latest !== firstConfirmation && latest.querySelector('[aria-label="已有视频影响范围"]'));
    });
    const finalConfirmation = [...document.querySelectorAll('[role="dialog"]')].at(-1)!;
    expect(writes).toEqual([]);
    await click("继续生成", finalConfirmation);
    await settleUntil(() => generation.single.mock.calls.length === 1);
    expect(writes).toEqual(["save", "generate"]);
    expect(save).toHaveBeenCalledWith("current", hero.id, expect.objectContaining({ appearance: "保留未保存的白色外套与银色纽扣" }));
    expect(generation.single).toHaveBeenCalledWith("current", hero.id, true);
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
    await click("生成参考图", editor);
    await settleUntil(() => generation.single.mock.calls.length === 1);
    expect(api.getDramaCastImpact).toHaveBeenCalledWith("current", first.id);
    expect(document.querySelector(".ant-modal-confirm")).toBeNull();
    expect(editor.querySelector('[aria-label="已有视频影响范围"]')).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(generation.single).toHaveBeenCalledWith("current", first.id, true);
    expect(generation.batch).not.toHaveBeenCalled();
});

for (const surface of ["workspace", "sidebar"] as const) {
    test(`${surface} 保存响应返回前轮询到新设定仍继续生成，并保持忙碌直到生成请求完成`, async () => {
        const refreshed = { ...hero, name: "林溪·新设定", appearance: "保存后的白色外套与银色纽扣" };
        let resolveSave!: (value: { cast: DramaCast }) => void;
        const save = spyOn(api, "updateDramaCast").mockReturnValue(new Promise((resolve) => (resolveSave = resolve)));
        let resolveGeneration!: (value: { affectedSegments: number }) => void;
        const generation = spyGeneration();
        generation.single.mockReturnValue(new Promise((resolve) => (resolveGeneration = resolve)));
        const changed = mock();
        const view = (item: DramaCast) => (surface === "workspace" ? <DialogHarness castId={hero.id} items={[item]} onChanged={changed} /> : <PanelHarness items={[item]} onChanged={changed} />);
        const editor = () => document.querySelector(surface === "workspace" ? ".drama-cast-dialog" : ".drama-view-side")!;
        await render(view(hero));
        await fill("名称", refreshed.name, editor());
        await fill("外貌描述", refreshed.appearance, editor());
        const originalInput = editor().querySelector('[aria-label="外貌描述"]');
        await click("保存并重新生成", editor());
        await settleUntil(() => save.mock.calls.length === 1);
        expectNoGeneration(generation);

        // 模拟 PATCH 已落库但响应未返回，cast 轮询先读取到保存结果。
        await render(view(refreshed));
        expect(editor().querySelector('[aria-label="外貌描述"]') === originalInput).toBe(true);
        expect(editor().querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe(refreshed.appearance);
        expect(button("保存并重新生成", editor()).disabled).toBe(true);
        await act(async () => resolveSave({ cast: refreshed }));
        await settleUntil(() => generation.single.mock.calls.length === 1);
        expect(generation.single).toHaveBeenCalledWith("current", hero.id, true);
        expect(button("重新生成", editor()).disabled).toBe(true);
        if (surface === "workspace") expect(button("关闭资产设定", editor()).disabled).toBe(true);

        await act(async () => resolveGeneration({ affectedSegments: 0 }));
        await settleUntil(() => !button("重新生成", editor()).disabled);
        expect(changed).toHaveBeenCalledTimes(1);
        expect(generation.single).toHaveBeenCalledTimes(1);
        expect(generation.batch).not.toHaveBeenCalled();
    });
}

for (const change of ["asset", "account"] as const) {
    test(`保存途中切换 ${change} 仍取消旧资产的后续生成`, async () => {
        const other = { ...hero, id: "other-hero", name: "其他角色" };
        let resolveSave!: (value: { cast: DramaCast }) => void;
        const save = spyOn(api, "updateDramaCast").mockReturnValue(new Promise((resolve) => (resolveSave = resolve)));
        const generation = spyGeneration();
        const changed = mock();
        const view = (castId: string) => <DialogHarness castId={castId} items={[hero, other]} onChanged={changed} />;
        await render(view(hero.id));
        await fill("外貌描述", "未返回的保存内容");
        await click("保存并重新生成");
        await settleUntil(() => save.mock.calls.length === 1);
        if (change === "asset") await render(view(other.id));
        else await act(async () => useUserStore.setState({ user: { id: "another-workspace-user" } as never }));
        await act(async () => resolveSave({ cast: { ...hero, appearance: "未返回的保存内容" } }));
        expectNoGeneration(generation);
        expect(changed).not.toHaveBeenCalled();
        const dialog = document.querySelector(".drama-cast-dialog")!;
        expect(dialog.querySelector<HTMLInputElement>('[aria-label="名称"]')?.value).toBe(change === "asset" ? other.name : hero.name);
        expect(button("重新生成", dialog).disabled).toBe(false);
    });
}

for (const stage of ["reading", "confirming"] as const) {
    test(`同资产在 ${stage} 阶段回填新设定时取消旧草稿的生成确认`, async () => {
        const refreshed = { ...hero, name: "林溪·外部新设定", appearance: "另一标签页已保存的外观" };
        let resolveImpact!: (value: DramaWorkflowImpact) => void;
        const impactRead = spyOn(api, "getDramaCastImpact").mockResolvedValue(impactOf(hero.id, true));
        impactRead.mockReturnValueOnce(new Promise((resolve) => (resolveImpact = resolve)));
        const save = spyOn(api, "updateDramaCast").mockResolvedValue({ cast: hero });
        const generation = spyGeneration();
        await render(<DialogHarness castId={hero.id} items={[hero]} />);
        await fill("外貌描述", "打开确认前的旧草稿");
        await click("保存并重新生成");
        await settleUntil(() => impactRead.mock.calls.length === 1);
        let oldConfirmation: Element | undefined;
        if (stage === "confirming") {
            await act(async () => resolveImpact(impactOf(hero.id, true)));
            await settleUntil(() => Boolean(document.querySelector('[aria-label="已有视频影响范围"]')));
            oldConfirmation = [...document.querySelectorAll('[role="dialog"]')].at(-1)!;
        }

        await render(<DialogHarness castId={hero.id} items={[refreshed]} />);
        const editor = document.querySelector(".drama-cast-dialog")!;
        await settleUntil(() => !button("保存并重新生成", editor).disabled);
        expect(editor.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe("打开确认前的旧草稿");
        if (stage === "reading") await act(async () => resolveImpact(impactOf(hero.id, true)));
        else await click("继续生成", oldConfirmation);
        expect(save).not.toHaveBeenCalled();
        expectNoGeneration(generation);

        expect(button("保存修改", editor).disabled).toBe(false);
    });
}

test("reference dialog polling preserves draft fields and closing discards them for reopening", async () => {
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
    await click("关闭资产设定", dialog);
    expect(document.querySelector(".ant-modal-confirm")?.textContent).toContain("未保存的修改");
    await click("继续编辑");
    expect(originalInput?.value).toBe("尚未保存的落地窗与破损地板");
    await click("关闭资产设定", dialog);
    await click("放弃修改并关闭");
    await render(<DialogHarness key="reopened" castId={room.id} items={[hero, room]} onChanged={changed} />);
    const reopened = document.querySelector(".drama-cast-dialog")!;
    expect(reopened.querySelector<HTMLTextAreaElement>('[aria-label="环境描述"]')?.value).toBe(room.appearance);
    expect(reopened.querySelector<HTMLTextAreaElement>('[aria-label="参考图生成提示词"]')?.value).toBe("");
    expect(save).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
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
    await click("保存修改", editor);
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
    expect(editor.querySelector<HTMLSelectElement>('[aria-label="表现形式"]')?.value).toBe("semi-realistic");
    expect(editor.querySelector<HTMLSelectElement>('[aria-label="题材"]')?.value).toBe("apocalypse");
    expect(button("保存修改", editor).disabled).toBe(true);

    // 单独更新已保存风格也应回填，不能依赖外观或名称恰好一起变化。
    const styleOnly = findDramaStyle(composeDramaStyleId("realistic", "campus"))!;
    await render(<PanelHarness items={[{ ...refreshed, imageStyleId: styleOnly.id, imageStyleName: styleOnly.name, imageStylePrompt: styleOnly.prompt }]} />);
    expect(editor.querySelector<HTMLSelectElement>('[aria-label="表现形式"]')?.value).toBe("realistic");
    expect(editor.querySelector<HTMLSelectElement>('[aria-label="题材"]')?.value).toBe("campus");
    expect(editor.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe(refreshed.appearance);
    expect(button("保存修改", editor).disabled).toBe(true);
    await fill("外貌描述", `${refreshed.appearance}，增加防护手套`, editor);
    await click("保存修改", editor);
    expect(save).toHaveBeenCalledWith("current", hero.id, expect.objectContaining({ appearance: `${refreshed.appearance}，增加防护手套`, expectedCastRevision: 1, imageOptions: expect.any(Object) }));
});

test("media status and lock polling preserve unsaved appearance, prompt and style edits", async () => {
    const savedStyle = findDramaStyle(composeDramaStyleId("2d", "urban"))!;
    const saved = { ...hero, imagePrompt: "已保存提示词", imageStyleId: savedStyle.id, imageStyleName: savedStyle.name, imageStylePrompt: savedStyle.prompt };
    const editedStyle = findDramaStyle(composeDramaStyleId("3d", "apocalypse"))!;
    const save = spyOn(api, "updateDramaCast").mockResolvedValue({ cast: saved });
    await render(<PanelHarness items={[saved]} />);
    await fill("名称", "编辑中的角色名", host);
    await fill("外貌描述", "编辑中的白色外套", host);
    await fill("参考图生成提示词", "编辑中的暖色光线", host);
    await chooseAxis("表现形式", "3d");
    await chooseAxis("题材", "apocalypse");
    const appearanceInput = host.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]');
    const updates: Partial<DramaCast>[] = [{ imageStatus: "queued" }, { locked: true }, { imageStatus: "ready", imageVersion: 2, imageResourceId: "newly-polled-image", locked: true }];
    for (const update of updates) {
        await render(<PanelHarness items={[{ ...saved, ...update }]} />);
        expect(host.querySelector('[aria-label="外貌描述"]')).toBe(appearanceInput);
        expect(appearanceInput?.value).toBe("编辑中的白色外套");
        expect(host.querySelector<HTMLInputElement>('[aria-label="名称"]')?.value).toBe("编辑中的角色名");
        expect(host.querySelector<HTMLTextAreaElement>('[aria-label="参考图生成提示词"]')?.value).toBe("编辑中的暖色光线");
        expect(host.querySelector<HTMLSelectElement>('[aria-label="表现形式"]')?.value).toBe("3d");
        expect(host.querySelector<HTMLSelectElement>('[aria-label="题材"]')?.value).toBe("apocalypse");
    }
    await fill("外貌描述", "编辑中的白色外套，继续补充银色纽扣", host);
    await click("保存修改", host.querySelector(".drama-view-side")!);
    expect(save).toHaveBeenCalledWith(
        "current",
        hero.id,
        expect.objectContaining({ name: "编辑中的角色名", appearance: "编辑中的白色外套，继续补充银色纽扣", imagePrompt: "编辑中的暖色光线", imageStyleId: editedStyle.id, imageStyleName: editedStyle.name, imageStylePrompt: editedStyle.prompt }),
    );
});

test("dirty主体切换锁定后沿用新版本保存，保留文字与图片配置草稿", async () => {
    const target = { ...hero, imageOptionsJson: JSON.stringify({ subjectReferenceIds: ["subject-reference"] }) };
    const locked = { ...target, locked: true, revision: 2 };
    const update = spyOn(api, "updateDramaCast").mockImplementation(async (_projectId, _castId, patch) => ({ cast: "locked" in patch ? locked : { ...locked, ...patch, revision: 3 } }));
    const generation = spyGeneration();
    await render(<PanelHarness items={[target]} />);
    const editor = host.querySelector(".drama-view-side")!;
    await fill("外貌描述", "保留草稿中的白色风衣", editor);
    await fill("参考图生成提示词", "保留草稿中的暖色侧光", editor);
    await click("移除主体参考 1", editor);
    await act(async () => editor.querySelector<HTMLButtonElement>('.drama-switch-label [role="switch"]')!.click());
    await settleUntil(() => update.mock.calls.length === 1);
    expect(update.mock.calls[0][2]).toEqual({ locked: true });
    await settleUntil(() => !button("保存修改", editor).disabled);
    await click("保存修改", editor);
    await settleUntil(() => update.mock.calls.length === 2);
    expect(update.mock.calls[1][2]).toEqual(expect.objectContaining({ expectedCastRevision: 2, appearance: "保留草稿中的白色风衣", imagePrompt: "保留草稿中的暖色侧光", imageOptions: expect.objectContaining({ subjectReferenceIds: [] }) }));
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
        await click("保存修改", editor);
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
        await click("保存修改", editor);
        expect(save).toHaveBeenCalledWith("current", hero.id, expect.objectContaining({ expectedCastRevision: 1, appearance: "当前尚未保存的外观" }));
        expect(editor.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe("当前尚未保存的外观");
        expect(button("保存修改", editor).disabled).toBe(false);
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

function ImageFieldsHarness({ initial = {}, onChange = () => {}, overrideAppearance }: { initial?: CastImageFieldsValue; onChange?: (patch: CastImageFieldsValue) => void; overrideAppearance?: string }) {
    const [appearance, setAppearance] = useState("初始外观");
    const [value, setValue] = useState(initial);
    return (
        <>
            <input aria-label="当前外观" value={appearance} onChange={(event) => setAppearance(event.target.value)} />
            <CastImageFields
                projectId="current"
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

test("prompt rebuilding uses the currently edited appearance and composed style without saving or generating", async () => {
    const rebuilt = spyOn(api, "rebuildDramaCastImagePrompt").mockResolvedValue({ imagePrompt: "已编排：3D 都市，白色风衣" });
    const save = spyOn(api, "updateDramaCastLook").mockResolvedValue({ look: evening, affectedSegments: 0 });
    const generation = spyGeneration();
    const changed = mock();
    await render(<ImageFieldsHarness initial={{ imagePrompt: "手写原提示词" }} onChange={changed} />);
    await fill("当前外观", "白色风衣，短发，银色耳饰");
    await enableOwnStyle();
    await chooseAxis("表现形式", "3d");
    await chooseAxis("题材", "urban");
    const style = findDramaStyle(composeDramaStyleId("3d", "urban"))!;
    expect(rebuilt).not.toHaveBeenCalled();
    await click("重新编排提示词");
    expect(rebuilt).not.toHaveBeenCalled();
    await click("确认替换", [...document.querySelectorAll('[role="dialog"]')].at(-1)!);
    expect(rebuilt).toHaveBeenCalledWith("current", evening.id, { appearance: "白色风衣，短发，银色耳饰", imageStyleId: style.id, imageStyleName: style.name, imageStylePrompt: style.prompt });
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
    await click("保存修改", editor);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("current", target.id, { expectedRevision: 9, expectedCastRevision: 1, appearance: "白色风衣与银色纽扣", imageOptions: { model: {}, ratio: "", resolution: "", subjectReferenceIds: [], styleReferenceIds: [] } });
    expect(oldOptions).not.toHaveBeenCalled();
    expectNoGeneration(generation);
    expect(button("保存修改", editor).disabled).toBe(true);
});

test("只修改图片时不伪造文字变化，版本冲突保留两组草稿且不生成", async () => {
    const target = { ...hero, imageOptionsJson: JSON.stringify({ subjectReferenceIds: ["subject-reference"] }) };
    const save = spyOn(api, "updateDramaCast").mockRejectedValue(new ApiError("主体版本已变化", { status: 409 }));
    const generation = spyGeneration();
    await render(<DialogHarness castId={target.id} items={[target]} />);
    const editor = document.querySelector(".drama-cast-dialog")!;
    await click("移除主体参考 1", editor);
    await click("保存修改", editor);
    const patch = save.mock.calls[0][2];
    expect(patch).toEqual({ expectedRevision: 9, expectedCastRevision: 1, imageOptions: { model: {}, ratio: "", resolution: "", subjectReferenceIds: [], styleReferenceIds: [] } });
    expect(button("保存修改", editor).disabled).toBe(false);
    await fill("外貌描述", "冲突后继续编辑的外观", editor);
    await render(<DialogHarness castId={target.id} items={[{ ...target, revision: 2, appearance: "外部已保存的外观" }]} />);
    expect(editor.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe("冲突后继续编辑的外观");
    expect(editor.querySelector('[aria-label="移除主体参考 1"]')).toBeNull();
    expectNoGeneration(generation);
});

test("主视觉允许两组草稿保存并生成，保存失败时完整保稿且不提交生成", async () => {
    const target = { ...hero, imageOptionsJson: JSON.stringify({ styleReferenceIds: ["style-reference"] }) };
    const save = spyOn(api, "updateDramaCast").mockRejectedValue(new ApiError("配置冲突", { status: 409 }));
    const generation = spyGeneration();
    await render(<DialogHarness castId={target.id} items={[target]} />);
    const editor = document.querySelector(".drama-cast-dialog")!;
    await fill("外貌描述", "保留外观草稿", editor);
    await click("移除风格参考 1", editor);
    expect(button("保存并重新生成", editor).disabled).toBe(false);
    await click("保存并重新生成", editor);
    expect(save).toHaveBeenCalledTimes(1);
    expectNoGeneration(generation);
    expect(editor.querySelector<HTMLTextAreaElement>('[aria-label="外貌描述"]')?.value).toBe("保留外观草稿");
    expect(editor.querySelector('[aria-label="移除风格参考 1"]')).toBeNull();
    expect(button("保存修改", editor).disabled).toBe(false);
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
        await click("保存并重新生成", editor);
        expect(save).toHaveBeenCalledTimes(1);
        expect(generation.single).toHaveBeenCalledTimes(1);
        expect(editor.textContent).toContain("修改已保存");
        expect(editor.textContent).toContain(outcome === "rejected" ? "生成提交失败" : "生成提交结果待核对");
        expect(button("保存修改", editor).disabled).toBe(true);
        if (outcome === "uncertain") {
            expect(button("重新生成", editor).disabled).toBe(true);
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

test("独立视图在当前工作区单独保存、预检确认生成和采用版本，主体dirty阻止切换", async () => {
    let row = independentView(hero, "front-view", "正面图");
    spyOn(viewApi, "listDramaCastViews").mockImplementation(async () => ({ views: [row] }));
    const viewSave = spyOn(viewApi, "saveDramaCastView").mockImplementation(async (_project, _cast, _id, input) => {
        row = { ...row, revision: 5, config: input.config };
        return row;
    });
    const mainSave = spyOn(api, "updateDramaCast").mockResolvedValue({ cast: hero });
    const check = spyOn(viewApi, "preflightDramaCastView").mockResolvedValue({ revision: 9, viewRevision: 5, ready: true, priced: true, estimated: true, amountMicrocredits: 1000, confirmationToken: "view-token" });
    const execute = spyOn(viewApi, "executeDramaCastView").mockResolvedValue({ id: "view-task" } as never);
    const adopt = spyOn(viewApi, "adoptDramaCastView").mockResolvedValue(row);
    await render(<DialogHarness castId={hero.id} items={[hero]} />);
    await fill("外貌描述", "主体的未保存修改");
    expect(button("选择正面图独立视图").disabled).toBe(true);
    await fill("外貌描述", hero.appearance);
    await click("选择正面图独立视图");
    await fill("视图名称", "正面特写");
    expect(button("预检生成").disabled).toBe(true);
    await click("保存视图配置");
    expect(viewSave).toHaveBeenCalledWith("current", hero.id, row.id, expect.objectContaining({ expectedRevision: 9, expectedCastRevision: 1, viewRevision: 4, config: expect.objectContaining({ name: "正面特写" }) }));
    expect(mainSave).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await settleUntil(() => !button("预检生成").disabled);
    await click("预检生成");
    expect(check).toHaveBeenCalledWith("current", hero.id, row.id, { viewRevision: 5 });
    expect(execute).not.toHaveBeenCalled();
    await click("确认生成此视图");
    expect(execute).toHaveBeenCalledWith("current", hero.id, row.id, expect.objectContaining({ expectedRevision: 9, viewRevision: 5, confirmationToken: "view-token", clientOperationId: expect.stringContaining("cast-view:") }));
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
    await click("保存视图配置");
    await settleUntil(() => !button("预检生成").disabled);
    await fill("视图补充提示词", "第二轮提示词");
    await click("保存视图配置");
    await settleUntil(() => !button("预检生成").disabled);
    expect(save.mock.calls[0][3]).toEqual(expect.objectContaining({ expectedRevision: 9, viewRevision: 4 }));
    expect(save.mock.calls[1][3]).toEqual(expect.objectContaining({ expectedRevision: 10, viewRevision: 5 }));
    await click("采用此版本");
    await settleUntil(() => !button("预检生成").disabled);
    await fill("视图补充提示词", "采用后继续编辑");
    await click("保存视图配置");
    await settleUntil(() => !button("预检生成").disabled);
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
    await click("保存视图配置");
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
    const check = spyOn(viewApi, "preflightDramaCastView");
    const generation = spyGeneration();
    await render(<DialogHarness castId={hero.id} items={[hero]} />);
    await settleUntil(() => !button("新增视图").disabled);
    await click("新增视图");
    await fill("视图名称", "新增正面");
    await click("保存视图配置");
    await settleUntil(() => Boolean(document.querySelector('[aria-label="新增正面工作区"]')));
    expect(save).toHaveBeenCalledWith("current", hero.id, undefined, expect.objectContaining({ expectedRevision: 9, expectedCastRevision: 1, viewRevision: 0 }));
    await settleUntil(() => !button("删除视图").disabled);
    await click("删除视图");
    await click("删除视图", [...document.querySelectorAll('[role="dialog"]')].at(-1)!);
    expect(remove).toHaveBeenCalledWith("current", hero.id, "new-view", { expectedRevision: 10, viewRevision: 1 });
    await settleUntil(() => Boolean(document.querySelector('[aria-label="当前参考图"]')));
    expect(check).not.toHaveBeenCalled();
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
    expect(button("新增视图").disabled).toBe(true);
    read.mockResolvedValue(dialogSummary);
    await click("刷新视图状态");
    await settleUntil(() => !button("新增视图").disabled);
    expect(document.body.textContent).not.toContain("作品配置读取失败");
});
