import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { DramaCast, DramaSegment, DramaSegmentReferencePatch, DramaSummary, DramaWorkflowImpact } from "../../src/services/api/drama";

const dom = new Window({ url: "http://localhost/projects/drama" });
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
const { App } = await import("antd");
const { CastLooks } = await import("../../src/pages/projects/studio/cast-looks");
const { CastVoicePreview } = await import("../../src/pages/projects/studio/cast-voice");
const { ReferenceBoard } = await import("../../src/pages/projects/studio/segment-references");
const { CanvasDramaAdoptModal } = await import("../../src/components/canvas/canvas-drama-adopt-modal");
const { buildDramaCastNode, defaultDramaAdoptTarget } = await import("../../src/lib/canvas/drama-canvas-projection");
const { CanvasNodeType } = await import("../../src/types/canvas");
const api = await import("../../src/services/api/drama");
const { ApiError } = await import("../../src/services/api/request");
const resources = await import("../../src/services/api/resources");
const imageStorage = await import("../../src/services/image-storage");
const imageLoader = await import("../../src/services/canvas-image-loader");
const character = { id: "hero", name: "主角", kind: "character", imageStatus: "ready", imageResourceId: "base" } as DramaCast;
const look = { id: "look", projectId: "project", name: "主角", parentId: "hero", kind: "character", revision: 1, lookName: "晚宴", appearance: "黑色礼服", imagePrompt: "银色耳饰，柔和侧光", imageStatus: "draft" } as DramaCast;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;

beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    spyOn(api, "getDramaCastImpact").mockImplementation(async (_projectId, castId) => ({ kind: "cast", castId, revision: 1, segments: 0, episodes: 0, affectedSegments: 0, assetIds: [castId], directSegments: [], continuitySegments: [], message: "" }));
    spyOn(api, "preflightDramaStudioBatch").mockImplementation(async (_project, input) => lookQuote(input));
    spyOn(api, "getDrama").mockResolvedValue({ project: { id: "project" }, production: { revision: 1 } } as DramaSummary);
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

async function renderLooks(looks = [look], onChanged = () => {}, episodeId?: string) {
    await act(async () =>
        root.render(
            <QueryClientProvider client={client}>
                <App>
                    <CastLooks projectId="project" episodeId={episodeId} character={character} looks={looks} restyle={false} onChanged={onChanged} />
                </App>
            </QueryClientProvider>,
        ),
    );
}
async function click(label: string, scope: ParentNode = host) {
    if (label.startsWith("生成图片-")) {
        for (let attempt = 0; attempt < 80 && ![...scope.querySelectorAll<HTMLButtonElement>("button")].some((item) => item.textContent?.replace(/\s/g, "") === label && !item.disabled); attempt++) {
            await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 5)));
        }
    }
    const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent?.replace(/\s/g, "") === label);
    expect(button).toBeDefined();
    await act(async () => {
        button!.click();
    });
}

function lookQuote(input: Parameters<typeof api.preflightDramaStudioBatch>[1], amountMicrocredits = 2_000_000, queued = false) {
    return {
        action: input.action,
        targetIds: input.targetIds,
        baseRevision: 1,
        ready: true,
        priced: true,
        amountMicrocredits,
        confirmationToken: "quote-token",
        scopeHash: "same-scope",
        items: input.targetIds.map((targetId) => ({ targetId, targetKind: "cast" as const, targetRevision: 1, status: queued ? ("queued" as const) : ("ready" as const), amountMicrocredits, priced: true })),
        counts: { ready: queued ? 0 : input.targetIds.length, queued: queued ? input.targetIds.length : 0, already_queued: 0, skipped_ready: 0, blocked: 0, conflict: 0, failed: 0 },
        warnings: [],
    };
}
async function settleUntil(predicate: () => boolean) {
    for (let attempt = 0; attempt < 80 && !predicate(); attempt++) await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 5)));
    expect(predicate()).toBe(true);
}

test("a character starts with its base image and no automatically added look", async () => {
    const add = spyOn(api, "addDramaCastLook").mockResolvedValue({ look });
    await renderLooks([]);
    expect(host.textContent).toContain("角色本体即基础造型");
    expect(host.querySelector(".drama-look-item")).toBeNull();
    expect(host.querySelector(".drama-look-form")).toBeNull();
    expect(add).not.toHaveBeenCalled();
    const addTile = host.querySelector("button.drama-cast-add-tile");
    expect(addTile).not.toBeNull();
    expect(addTile?.textContent?.trim()).toBe("添加妆造");
    await click("添加妆造");
    expect(host.querySelector(".drama-look-form")).not.toBeNull();
    expect(add).not.toHaveBeenCalled();
});

test("已有造型不再显示确认保存，未修改时关闭不写入也不生成", async () => {
    const update = spyOn(api, "updateDramaCastLook").mockResolvedValue({ look, affectedSegments: 0 });
    const generate = spyOn(api, "regenerateDramaCast").mockResolvedValue({ affectedSegments: 0 });
    await renderLooks();
    await click("编辑造型 晚宴");
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="参考图生成提示词"]')?.value).toBe("银色耳饰，柔和侧光");
    expect(host.textContent).not.toContain("确认保存");
    await click("关闭编辑");
    expect(update).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
});

async function fillLookField(label: string, value: string) {
    const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
    const prototype = input.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
    await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

test("new appearance requires confirmation and saves a custom prompt without generation", async () => {
    const add = spyOn(api, "addDramaCastLook").mockResolvedValue({ look });
    const generate = spyOn(api, "regenerateDramaCast").mockResolvedValue({ affectedSegments: 0 });
    await renderLooks([]);
    await click("添加妆造");
    await fillLookField("造型名", "舞台妆");
    await fillLookField("造型外观", "红色长裙，盘发，淡金眼妆");
    await fillLookField("参考图生成提示词", "保持人物五官，红色丝绸长裙，柔和舞台光");
    expect(add).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    await click("确认保存");
    expect(add).toHaveBeenCalledWith("project", "hero", {
        lookName: "舞台妆",
        appearance: "红色长裙，盘发，淡金眼妆",
        imagePrompt: "保持人物五官，红色丝绸长裙，柔和舞台光",
        imageStyleId: "",
        imageStyleName: "",
        imageStylePrompt: "",
        fromChapter: 0,
        toChapter: 0,
    });
    expect(generate).not.toHaveBeenCalled();
});

test("本集新增造型携带当前集并在保存成功后刷新，切集后不沿用上一集", async () => {
    const add = spyOn(api, "addDramaCastLook").mockResolvedValue({ look });
    const generate = spyOn(api, "regenerateDramaCast").mockResolvedValue({ affectedSegments: 0 });
    const changed = mock();
    for (const [index, episodeId] of ["episode-1", "episode-2"].entries()) {
        await renderLooks([], changed, episodeId);
        await click("添加妆造");
        await fillLookField("造型名", "晚宴");
        await fillLookField("造型外观", "黑色礼服");
        await click("确认保存");
        await settleUntil(() => changed.mock.calls.length === index + 1);
        expect(add.mock.calls[index]).toEqual(["project", "hero", expect.objectContaining({ episodeId, lookName: "晚宴", appearance: "黑色礼服" })]);
        expect(host.querySelector(".drama-look-form")).toBeNull();
    }
    expect(generate).not.toHaveBeenCalled();
});

test("editing an appearance submits the newly typed prompt and keeps generation separate", async () => {
    const update = spyOn(api, "updateDramaCastLook").mockResolvedValue({ look, affectedSegments: 0 });
    const generate = spyOn(api, "regenerateDramaCast").mockResolvedValue({ affectedSegments: 0 });
    await renderLooks();
    await click("编辑造型 晚宴");
    await fillLookField("参考图生成提示词", "珍珠耳饰，暖色逆光，保留人物面部特征");
    expect(update).not.toHaveBeenCalled();
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 400)));
    expect(update).toHaveBeenCalledWith("project", "look", expect.objectContaining({ imagePrompt: "珍珠耳饰，暖色逆光，保留人物面部特征" }));
    expect(generate).not.toHaveBeenCalled();
});

test("造型文字章节与图片自动串行保存，在途输入不会被旧回执覆盖", async () => {
    let finish!: (value: { look: DramaCast; affectedSegments: number }) => void;
    const update = spyOn(api, "updateDramaCastLook")
        .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
        .mockImplementation(async (_project, _id, patch) => ({ look: { ...look, ...patch, revision: 3 }, affectedSegments: 0 }));
    await renderLooks();
    await click("编辑造型 晚宴");
    await fillLookField("造型名", "舞台妆");
    await fillLookField("造型外观", "红色长裙");
    await fillLookField("起始章", "2");
    await fillLookField("结束章", "5");
    await fillLookField("参考图生成提示词", "暖色侧光");
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 400)));
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][2]).toEqual(expect.objectContaining({ lookName: "舞台妆", appearance: "红色长裙", fromChapter: 2, toChapter: 5, imagePrompt: "暖色侧光", expectedRevision: 1, expectedCastRevision: 1 }));
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="参考图生成提示词"]')?.disabled).toBe(false);
    await fillLookField("造型外观", "红色长裙与珍珠耳饰");
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 400)));
    expect(update).toHaveBeenCalledTimes(1);
    await act(async () => finish({ look: { ...look, revision: 2 }, affectedSegments: 0 }));
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="造型外观"]')?.value).toBe("红色长裙与珍珠耳饰");
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 400)));
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][2]).toEqual(expect.objectContaining({ appearance: "红色长裙与珍珠耳饰", expectedCastRevision: 2 }));
});

test("造型自动保存失败不循环重发，保留草稿并允许显式重试", async () => {
    const update = spyOn(api, "updateDramaCastLook")
        .mockRejectedValueOnce(new Error("暂时断网"))
        .mockResolvedValue({ look: { ...look, revision: 2 }, affectedSegments: 0 });
    await renderLooks();
    await click("编辑造型 晚宴");
    await fillLookField("造型外观", "保留这套白色风衣");
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 450)));
    expect(update).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("修改仍保留");
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 450)));
    expect(update).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="造型外观"]')?.value).toBe("保留这套白色风衣");
    await click("重试保存");
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][2]).toEqual(expect.objectContaining({ appearance: "保留这套白色风衣" }));
    await click("关闭编辑");
    expect(host.querySelector(".drama-look-form")).toBeNull();
});

test("造型版本冲突只在确认版本变化后按当前草稿重试一次", async () => {
    spyOn(api, "getDrama")
        .mockResolvedValueOnce({ project: { id: "project" }, production: { revision: 1 } } as DramaSummary)
        .mockResolvedValue({ project: { id: "project" }, production: { revision: 4 } } as DramaSummary);
    spyOn(api, "listDramaCast").mockResolvedValue({ cast: [{ ...look, revision: 3, appearance: "其他页面的黑色风衣" }] });
    const update = spyOn(api, "updateDramaCastLook")
        .mockRejectedValueOnce(new ApiError("版本已变化", { status: 409, reason: "conflict" }))
        .mockResolvedValue({ look: { ...look, revision: 4 }, affectedSegments: 0 });
    await renderLooks();
    await click("编辑造型 晚宴");
    await fillLookField("造型外观", "当前页面的红色长裙");
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 450)));
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0][2]).toEqual(expect.objectContaining({ expectedRevision: 1, expectedCastRevision: 1 }));
    expect(update.mock.calls[1][2]).toEqual(expect.objectContaining({ expectedRevision: 4, expectedCastRevision: 3, appearance: "当前页面的红色长裙" }));
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="造型外观"]')?.value).toBe("当前页面的红色长裙");
});

test("造型冲突仅覆盖本地改动字段，后续保存继续保留远端名称", async () => {
    spyOn(api, "getDrama")
        .mockResolvedValueOnce({ project: { id: "project" }, production: { revision: 1 } } as DramaSummary)
        .mockResolvedValue({ project: { id: "project" }, production: { revision: 4 } } as DramaSummary);
    const remote = { ...look, lookName: "远端更新的舞台妆", revision: 3 };
    spyOn(api, "listDramaCast").mockResolvedValue({ cast: [remote] });
    const update = spyOn(api, "updateDramaCastLook")
        .mockRejectedValueOnce(new ApiError("版本已变化", { status: 409, reason: "conflict" }))
        .mockImplementation(async (_project, _id, patch) => ({ look: { ...remote, ...patch, revision: update.mock.calls.length + 2 }, affectedSegments: 0 }));
    await renderLooks();
    await click("编辑造型 晚宴");
    await fillLookField("造型外观", "本地更新的红色长裙");
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 450)));
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][2]).toEqual(expect.objectContaining({ lookName: remote.lookName, appearance: "本地更新的红色长裙", expectedCastRevision: 3 }));
    await fillLookField("参考图生成提示词", "第二次编辑的暖色侧光");
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 450)));
    expect(update).toHaveBeenCalledTimes(3);
    expect(update.mock.calls[2][2]).toEqual(expect.objectContaining({ lookName: remote.lookName, appearance: "本地更新的红色长裙", imagePrompt: "第二次编辑的暖色侧光", expectedCastRevision: 4 }));
});

test("造型校验失败不覆盖或重发，离开编辑后迟到回执不触发刷新", async () => {
    let finish!: (value: { look: DramaCast; affectedSegments: number }) => void;
    const update = spyOn(api, "updateDramaCastLook")
        .mockRejectedValueOnce(new ApiError("校验失败", { status: 400 }))
        .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const readCast = spyOn(api, "listDramaCast").mockResolvedValue({ cast: [look] });
    const changed = mock();
    await renderLooks([look], changed);
    await click("编辑造型 晚宴");
    await fillLookField("造型外观", "保留白色风衣");
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 450)));
    expect(update).toHaveBeenCalledTimes(1);
    expect(readCast).not.toHaveBeenCalled();
    await click("重试保存");
    expect(update).toHaveBeenCalledTimes(2);
    await renderLooks([], changed);
    await act(async () => finish({ look: { ...look, revision: 2 }, affectedSegments: 0 }));
    expect(changed).not.toHaveBeenCalled();
    expect(host.querySelector(".drama-look-form")).toBeNull();
});

test("造型版本读取失败保留输入并可刷新恢复自动保存", async () => {
    const read = spyOn(api, "getDrama").mockRejectedValue(new Error("暂时断线"));
    spyOn(api, "listDramaCast").mockResolvedValue({ cast: [look] });
    const update = spyOn(api, "updateDramaCastLook").mockResolvedValue({ look: { ...look, revision: 2 }, affectedSegments: 0 });
    await renderLooks();
    await click("编辑造型 晚宴");
    await fillLookField("造型外观", "读取失败期间继续编辑的红色长裙");
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 450)));
    expect(update).not.toHaveBeenCalled();
    expect(host.textContent).toContain("版本读取失败");
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes("放弃修改并关闭"))?.disabled).toBe(false);
    read.mockResolvedValue({ project: { id: "project" }, production: { revision: 1 } } as DramaSummary);
    await click("刷新状态");
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 450)));
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][2]).toEqual(expect.objectContaining({ appearance: "读取失败期间继续编辑的红色长裙" }));
});

test("custom appearance image is uploaded and assigned only after confirmation", async () => {
    const upload = spyOn(resources, "uploadResourceFile").mockResolvedValue({ id: "custom-look" } as Awaited<ReturnType<typeof resources.uploadResourceFile>>);
    const save = spyOn(api, "setDramaCastImage").mockResolvedValue({ cast: { ...look, imageResourceId: "custom-look", locked: true }, affectedSegments: 0 });
    const generate = spyOn(api, "regenerateDramaCast").mockResolvedValue({ affectedSegments: 0 });
    await renderLooks();
    await click("自定义图");
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new dom.File(["image"], "舞台妆.png", { type: "image/png" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("确认后保存并锁定这张图片，不调用模型生成");
    expect(upload).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    await click("确认保存", document);
    expect(upload).toHaveBeenCalledWith(file, "image", { fileName: "舞台妆.png" });
    expect(save).toHaveBeenCalledWith("project", "look", "custom-look", false);
    expect(generate).not.toHaveBeenCalled();
});

test("saved draft quotes automatically and generates through one click", async () => {
    const generate = spyOn(api, "executeDramaStudioBatch").mockImplementation(async (_project, input) => lookQuote(input, 2_000_000, true));
    await renderLooks();
    expect(host.textContent).toContain("已保存，待生成或上传");
    expect(generate).not.toHaveBeenCalled();
    await click("生成图片-2积分");
    expect(generate).toHaveBeenCalledWith("project", expect.objectContaining({ action: "cast_image", targetIds: ["look"], regenerate: true, baseRevision: 1, confirmationToken: "quote-token" }));
});

test("已有依赖视频的造型生成直接提交，不重复弹窗确认", async () => {
    const generate = spyOn(api, "executeDramaStudioBatch").mockImplementation(async (_project, input) => lookQuote(input, 2_000_000, true));
    spyOn(api, "getDramaCastImpact").mockResolvedValue({
        kind: "cast",
        castId: "look",
        revision: 1,
        directSegments: [{ id: "s1", episodeId: "e2", episodeNumber: 2, episodeTitle: "晚宴", segmentIndex: 3, revision: 1, hasVideo: true, videoStatus: "ready" }],
        continuitySegments: [],
    } as unknown as DramaWorkflowImpact);
    await renderLooks([{ ...look, imageResourceId: "old-look" }]);
    await click("生成图片-2积分");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(generate).toHaveBeenCalledWith("project", expect.objectContaining({ targetIds: ["look"], regenerate: true, confirmationToken: "quote-token" }));
});

test("锁定造型先按解锁后配置报价，点击才解锁并核对费用生成", async () => {
    const unlock = spyOn(api, "updateDramaCast").mockResolvedValue({ cast: look });
    const generate = spyOn(api, "executeDramaStudioBatch").mockImplementation(async (_project, input) => lookQuote(input, 2_000_000, true));
    await renderLooks([{ ...look, locked: true, imageResourceId: "custom-look" }]);
    expect(unlock).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(api.preflightDramaStudioBatch).toHaveBeenCalledWith("project", { action: "cast_image", targetIds: ["look"], regenerate: true, castDrafts: { look: { unlock: true } } });
    await click("生成图片-2积分");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(unlock).toHaveBeenCalledWith("project", "look", { locked: false });
    expect(generate).toHaveBeenCalledWith("project", expect.objectContaining({ targetIds: ["look"], regenerate: true, confirmationToken: "quote-token" }));
});

test("造型生成费用变动后停止提交，更新按钮后再次点击才执行", async () => {
    const generate = spyOn(api, "executeDramaStudioBatch").mockImplementation(async (_project, input) => lookQuote(input, 3_000_000, true));
    let calls = 0;
    spyOn(api, "preflightDramaStudioBatch").mockImplementation(async (_project, input) => lookQuote(input, ++calls === 1 ? 2_000_000 : 3_000_000));
    await renderLooks();
    await click("生成图片-2积分");
    expect(generate).not.toHaveBeenCalled();
    await click("生成图片-3积分");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("造型生成同价但配置范围变化时停止，重新显示报价后才能生成", async () => {
    const generate = spyOn(api, "executeDramaStudioBatch").mockImplementation(async (_project, input) => lookQuote(input, 2_000_000, true));
    let reads = 0;
    spyOn(api, "preflightDramaStudioBatch").mockImplementation(async (_project, input) => ({ ...lookQuote(input), scopeHash: ++reads === 1 ? "original-scope" : "changed-scope" }));
    await renderLooks();
    await click("生成图片-2积分");
    expect(generate).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("生成提交结果待核对");
    await settleUntil(() => reads >= 3);
    await click("生成图片-2积分");
    expect(generate).toHaveBeenCalledTimes(1);
});

test("造型生成提交结果未知时阻止再次生成，只读取已有任务状态", async () => {
    const generate = spyOn(api, "executeDramaStudioBatch").mockRejectedValue(new Error("响应断开"));
    const read = spyOn(api, "listDramaCast").mockResolvedValue({ cast: [{ ...look, imageStatus: "queued" }] });
    await renderLooks();
    await click("生成图片-2积分");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("生成提交结果待核对");
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.replace(/\s/g, "") === "生成图片-2积分")!;
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(generate).toHaveBeenCalledTimes(1);
    await click("核对生成状态");
    expect(read).toHaveBeenCalledWith("project");
    expect(generate).toHaveBeenCalledTimes(1);
});

test("造型报价阻断时按钮禁用并在原处说明原因", async () => {
    const generate = spyOn(api, "executeDramaStudioBatch");
    spyOn(api, "preflightDramaStudioBatch").mockImplementation(async (_project, input) => ({ ...lookQuote(input), ready: false, reason: "积分不足", items: [{ ...lookQuote(input).items[0], status: "blocked" }] }));
    await renderLooks();
    await settleUntil(() => host.textContent?.includes("积分不足") || false);
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.startsWith("生成图片"))?.disabled).toBe(true);
    expect(generate).not.toHaveBeenCalled();
});

test("voice preview distinguishes characters with and without audio", async () => {
    await act(async () =>
        root.render(
            <App>
                <CastVoicePreview name="甲" resourceId="sample" />
                <CastVoicePreview name="乙" />
            </App>,
        ),
    );
    expect(host.querySelector<HTMLButtonElement>('[aria-label="试听甲的音频"]')?.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="乙未绑定音频"]')?.disabled).toBe(true);
});

test("voice preview plays the authorized sample, pauses, and stops on unmount", async () => {
    const originalAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio");
    const audio = {
        src: "",
        play: mock(async () => {}),
        pause: mock(() => {}),
        removeAttribute: mock((name: string) => {
            if (name === "src") audio.src = "";
        }),
        load: mock(() => {}),
        onended: null,
        onerror: null,
    };
    Object.defineProperty(globalThis, "Audio", {
        configurable: true,
        writable: true,
        value: function () {
            return audio;
        },
    });
    const access = spyOn(resources, "getResourceAccess").mockResolvedValue({ url: "/api/resources/sample/content" } as Awaited<ReturnType<typeof resources.getResourceAccess>>);
    try {
        await act(async () =>
            root.render(
                <App>
                    <CastVoicePreview name="主角" resourceId="sample" />
                </App>,
            ),
        );
        await click("试听主角的音频");
        expect(access).toHaveBeenCalledWith(resources.resourceStorageKey("sample"), "display", "playback");
        expect(audio.play).toHaveBeenCalledTimes(1);
        expect(audio.src).toBe(resources.resolveResourceAccessURL("/api/resources/sample/content"));
        await click("暂停主角的音频");
        expect(audio.pause).toHaveBeenCalledTimes(1);
        await click("试听主角的音频");
        await act(async () => root.render(null));
        expect(audio.pause).toHaveBeenCalledTimes(2);
        expect(audio.removeAttribute).toHaveBeenCalledWith("src");
        expect(audio.load).toHaveBeenCalledTimes(1);
        expect(audio.src).toBe("");
        expect(audio.onended).toBeNull();
        expect(audio.onerror).toBeNull();
    } finally {
        if (originalAudio) Object.defineProperty(globalThis, "Audio", originalAudio);
        else Reflect.deleteProperty(globalThis, "Audio");
    }
});

const segment = {
    id: "segment",
    index: 0,
    referenceMode: "custom",
    audioReferenceMode: "auto",
    request: {
        references: [
            { castId: "hero", name: "主角", kind: "character", label: "参考图1", sent: false },
            { castId: "", resourceId: "extra", name: "夜景", kind: "image", label: "参考图2", sent: false },
        ],
        audioReferences: [
            { castId: "hero", name: "主角", sent: false },
            { castId: "second", name: "配角", sent: false },
        ],
        modelMaxAudios: 1,
        referenceCapacity: 3,
        modelMaxImages: 3,
    },
} as DramaSegment;

async function renderReferences(onSave: (patch: DramaSegmentReferencePatch) => Promise<unknown>, currentSegment = segment, onOpenCast: (id: string) => void = () => {}) {
    const castById = new Map<string, DramaCast>([
        ["hero", { ...character, imageResourceId: undefined, voiceSampleResourceId: "voice-1" }],
        ["second", { ...character, id: "second", name: "配角", aliasesJson: '["小乙"]', imageResourceId: undefined, voiceSampleResourceId: "voice-2" }],
        ["hall", { ...character, id: "hall", kind: "scene", name: "王府大厅", imageResourceId: undefined }],
        ["sword", { ...character, id: "sword", kind: "prop", name: "宝剑", imageResourceId: undefined }],
        ["look", look],
    ]);
    await act(async () =>
        root.render(
            <QueryClientProvider client={client}>
                <App>
                    <ReferenceBoard segment={currentSegment} shots={[]} castById={castById} busy={false} onSave={onSave} onOpenCast={onOpenCast} />
                </App>
            </QueryClientProvider>,
        ),
    );
}

async function openReferenceMenu() {
    await click("管理参考资产");
    const menu = document.querySelector<HTMLElement>('[aria-label="搜索参考资产"]');
    expect(menu).not.toBeNull();
    return menu!;
}

test("reference rail mixes asset kinds, shows only images or missing-image names, and opens the exact cast", async () => {
    const openCast = mock((_id: string) => {});
    const save = mock(async () => {});
    spyOn(resources, "getResourceAccess").mockResolvedValue({ url: "data:image/png;base64,iVBORw0KGgo=" } as Awaited<ReturnType<typeof resources.getResourceAccess>>);
    spyOn(imageLoader, "prepareCanvasImage").mockImplementation(async (src) => {
        const image = document.createElement("img");
        image.src = src;
        return image;
    });
    const references = [
        { castId: "hero", resourceId: "hero-image", name: "主角", kind: "character", label: "参考图1", sent: true },
        { castId: "hall", resourceId: "hall-image", name: "王府大厅", kind: "scene", label: "参考图2", sent: true },
        { castId: "sword", name: "宝剑", kind: "prop", label: "参考图3", sent: false },
        { ...segment.request.references[1], label: "参考图4" },
    ] as DramaSegment["request"]["references"];
    await renderReferences(save, { ...segment, request: { ...segment.request, references, audioReferences: [] } }, openCast);
    const rail = host.querySelector<HTMLElement>('[aria-label="参考资产缩略图"]')!;
    expect(rail.getAttribute("tabindex")).toBe("0");
    expect(rail.querySelectorAll(".drama-sdx-reference-tile")).toHaveLength(4);
    expect(host.querySelector(".drama-sdx-asset-group")).toBeNull();
    for (const name of ["主角", "王府大厅"]) {
        const tile = rail.querySelector<HTMLButtonElement>(`[aria-label="查看${name}设定"]`)!;
        expect(tile.querySelector(`img[alt="${name}"]`)).not.toBeNull();
        expect(tile.querySelector(".drama-sdx-reference-name")).toBeNull();
        expect(tile.textContent).toBe("");
        expect(tile.querySelector(".drama-sdx-reference-zoom")).not.toBeNull();
    }
    const sword = rail.querySelector<HTMLButtonElement>('[aria-label="查看宝剑设定"]')!;
    expect(sword.querySelector("img")).toBeNull();
    expect(sword.querySelector(".drama-sdx-reference-name")?.textContent).toBe("宝剑");
    await click("查看主角设定", rail);
    await click("查看王府大厅设定", rail);
    await click("查看宝剑设定", rail);
    expect(openCast.mock.calls).toEqual([["hero"], ["hall"], ["sword"]]);
    expect(save).not.toHaveBeenCalled();
});

test("opening a cast from the management menu closes the menu before leaving the reference board", async () => {
    const openCast = mock((_id: string) => {});
    const save = mock(async () => {});
    await renderReferences(save, segment, openCast);
    const menu = await openReferenceMenu();
    const trigger = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.replace(/\s/g, "") === "管理参考资产")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await click("查看主角设定", menu);
    expect(openCast.mock.calls).toEqual([["hero"]]);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // 浮层退出动画尚未结束时仍可挂载，但必须已进入关闭状态。
    expect(!menu.isConnected || menu.closest(".ant-popover")?.className.includes("-leave")).toBe(true);
    expect(save).not.toHaveBeenCalled();
});

test("reference rail maps vertical wheel to horizontal scroll and preserves direction, units and Ctrl zoom", async () => {
    await renderReferences(mock(async () => {}));
    const rail = host.querySelector<HTMLElement>('[aria-label="参考资产缩略图"]')!;
    Object.defineProperty(rail, "clientWidth", { configurable: true, value: 240 });
    rail.scrollLeft = 200;
    const parentWheel = mock(() => {});
    host.addEventListener("wheel", parentWheel);
    const wheel = async (options: WheelEventInit) => {
        const event = new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, ...options });
        // Happy DOM 的 WheelEvent 继承 UIEvent，未实现 MouseEvent 的修饰键。
        Object.defineProperty(event, "ctrlKey", { value: options.ctrlKey ?? false });
        await act(async () => rail.dispatchEvent(event));
        return event;
    };
    expect((await wheel({ deltaY: 80 })).defaultPrevented).toBe(true);
    expect(rail.scrollLeft).toBe(280);
    expect((await wheel({ deltaX: -40, deltaY: 3 })).defaultPrevented).toBe(true);
    expect(rail.scrollLeft).toBe(240);
    await wheel({ deltaY: 2, deltaMode: 1 });
    expect(rail.scrollLeft).toBe(272);
    await wheel({ deltaY: 1, deltaMode: 2 });
    expect(rail.scrollLeft).toBe(512);
    expect(parentWheel).not.toHaveBeenCalled();
    expect((await wheel({ deltaY: 500, ctrlKey: true })).defaultPrevented).toBe(false);
    expect(rail.scrollLeft).toBe(512);
    expect(parentWheel).toHaveBeenCalledTimes(1);
});

test("reference upload remains available in the management menu and appends only the uploaded image", async () => {
    const save = mock(async () => {});
    const upload = spyOn(resources, "uploadResourceFile").mockResolvedValue({ id: "uploaded-reference" } as Awaited<ReturnType<typeof resources.uploadResourceFile>>);
    await renderReferences(save);
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const trigger = spyOn(input, "click").mockImplementation(() => {});
    const menu = await openReferenceMenu();
    await click("上传参考图", menu);
    expect(trigger).toHaveBeenCalledTimes(1);
    const file = new dom.File(["image"], "补充景物.png", { type: "image/png" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(upload).toHaveBeenCalledWith(file, "image", { fileName: "补充景物.png" });
    expect(save).toHaveBeenCalledWith({
        referenceImages: [
            { resourceId: "extra", name: "夜景" },
            { resourceId: "uploaded-reference", name: "补充景物" },
        ],
    });
});

test("reference removal updates only the selected source and keeps library/upload entry points", async () => {
    const save = mock(async () => {});
    await renderReferences(save);
    expect(host.textContent).toContain("素材库");
    expect(host.textContent).toContain("上传参考图");
    expect(host.querySelector('[aria-label="移除参考图夜景"]')).toBeNull();
    const menu = await openReferenceMenu();
    expect(menu.textContent).toContain("素材库");
    expect(menu.textContent).toContain("上传参考图");
    await click("移除参考图夜景", menu);
    expect(save).toHaveBeenLastCalledWith({ referenceImages: [] });
    await click("移除参考图主角", menu);
    expect(save).toHaveBeenLastCalledWith({ referenceCastIds: [] });
});

test("over-limit automatic voices are applied when adjusted and can be restored to automatic mode", async () => {
    const save = mock(async () => {});
    await renderReferences(save);
    expect(host.querySelector('[aria-label="关闭配角的音色"]')).toBeNull();
    const menu = await openReferenceMenu();
    expect(menu.textContent).toContain("当前模型音色不可多于 1 个");
    await click("关闭配角的音色", menu);
    expect(menu.querySelector<HTMLButtonElement>('[aria-label="开启配角的音色"]')?.disabled).toBe(true);
    expect(save).toHaveBeenLastCalledWith({ audioCastIds: ["hero"] });
    await renderReferences(save, { ...segment, audioReferenceMode: "custom", request: { ...segment.request, audioReferences: segment.request.audioReferences?.slice(0, 1) } });
    await click("恢复自动音色", menu);
    expect(save).toHaveBeenLastCalledWith({ autoAudioReferences: true });
});

test("a failed preview retains the selected voice when another voice is enabled", async () => {
    const save = mock(async () => {});
    const warning = "剧情段超过所选视频模型的时长上限，请调整分镜时长或重新改编";
    await renderReferences(save, {
        ...segment,
        audioReferenceMode: "custom",
        request: {
            ...segment.request,
            warning,
            references: [...segment.request.references, { castId: "second", name: "配角", kind: "character", label: "参考图3", sent: false }],
            audioReferences: [{ castId: "hero", name: "主角", resourceId: "voice-1", sent: false, note: `视频请求尚未就绪，参考音色未发送：${warning}` }],
            modelMaxAudios: 2,
        },
    });
    const menu = await openReferenceMenu();
    expect(menu.querySelector<HTMLButtonElement>('[aria-label="关闭主角的音色"]')?.disabled).toBe(false);
    expect(menu.textContent).toContain("视频请求尚未就绪，参考音色未发送");
    await click("开启配角的音色", menu);
    expect(save).toHaveBeenLastCalledWith({ audioCastIds: ["hero", "second"] });
});

test("a model without audio support still allows closing and applying the existing voice", async () => {
    const save = mock(async () => {});
    await renderReferences(save, {
        ...segment,
        audioReferenceMode: "custom",
        request: { ...segment.request, audioReferences: segment.request.audioReferences?.slice(0, 1), modelMaxAudios: 0 },
    });
    const menu = await openReferenceMenu();
    expect(menu.querySelector<HTMLButtonElement>('[aria-label="关闭主角的音色"]')?.disabled).toBe(false);
    await click("关闭主角的音色", menu);
    expect(save).toHaveBeenLastCalledWith({ audioCastIds: [] });
});

test("mixed reference assets keep request order and can reorder in the menu without changing custom images", async () => {
    const save = mock(async () => {});
    const references = [
        segment.request.references[0],
        { castId: "second", name: "配角", kind: "character", label: "参考图2", sent: false },
        { castId: "hall", name: "王府大厅", kind: "scene", label: "参考图3", sent: false },
        { castId: "sword", name: "宝剑", kind: "prop", label: "参考图4", sent: false },
        { ...segment.request.references[1], label: "参考图5" },
    ] as DramaSegment["request"]["references"];
    await renderReferences(save, { ...segment, request: { ...segment.request, references } });
    const rail = host.querySelector('[aria-label="参考资产缩略图"]')!;
    expect([...rail.querySelectorAll("button")].map((item) => item.getAttribute("aria-label"))).toEqual(["查看主角设定", "查看配角设定", "查看王府大厅设定", "查看宝剑设定", "放大预览夜景"]);
    const menu = await openReferenceMenu();
    await click("提前王府大厅", menu);
    expect(save).toHaveBeenLastCalledWith({ referenceCastIds: ["hero", "hall", "second", "sword"] });
    const reordered = [references[0], references[2], references[1], references[3], references[4]].map((ref, index) => ({ ...ref, label: `参考图${index + 1}` }));
    await renderReferences(save, { ...segment, request: { ...segment.request, references: reordered } });
    expect([...rail.querySelectorAll("button")].map((item) => item.getAttribute("aria-label"))).toEqual(["查看主角设定", "查看王府大厅设定", "查看配角设定", "查看宝剑设定", "放大预览夜景"]);
    await click("提前配角", menu);
    expect(save).toHaveBeenLastCalledWith({ referenceCastIds: ["hero", "second", "hall", "sword"] });
});

test("voice controls stay under the character asset and a look inherits the base character voice", async () => {
    const save = mock(async () => {});
    const references = [{ castId: "look", name: "主角 · 晚宴", kind: "character", label: "参考图1", sent: false }] as DramaSegment["request"]["references"];
    await renderReferences(save, { ...segment, request: { ...segment.request, references, audioReferences: segment.request.audioReferences?.slice(0, 1) } });
    expect(host.querySelector('[aria-label="查看主角 · 晚宴设定"]')).not.toBeNull();
    const menu = await openReferenceMenu();
    const card = menu.querySelector('[aria-label="主角 · 晚宴资产"]');
    expect(card?.querySelector('[aria-label="关闭主角的音色"]')).not.toBeNull();
    expect(card?.querySelector('[aria-label="试听主角的音频"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="主角资产"]')).toBeNull();
    expect(host.querySelector('[aria-label="本段角色音色"]')).toBeNull();
    await click("关闭主角的音色", card!);
    expect(save).toHaveBeenLastCalledWith({ audioCastIds: [] });
});

test("secondary asset menu searches by alias, filters categories, and toggles selected references", async () => {
    const save = mock(async () => {});
    await renderReferences(save);
    await click("管理参考资产");
    const menu = document.querySelector('[aria-label="搜索参考资产"]')!;
    expect(menu).not.toBeNull();
    const input = menu.querySelector<HTMLInputElement>('[aria-label="搜索资产"]')!;
    const type = async (value: string) => {
        await act(async () => {
            Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
    };
    await type("小乙");
    expect(menu.querySelector('[aria-label="配角资产"]')).not.toBeNull();
    expect(menu.querySelector('[aria-label="主角资产"]')).toBeNull();
    await type("");
    await click("场景", menu);
    expect(menu.querySelector('[aria-label="配角资产"]')).toBeNull();
    await click("添加参考图王府大厅", menu);
    expect(save).toHaveBeenLastCalledWith({ referenceCastIds: ["hero", "hall"] });
    await renderReferences(save, { ...segment, request: { ...segment.request, references: [...segment.request.references, { castId: "hall", name: "王府大厅", kind: "scene", label: "参考图3", sent: false }] } });
    await click("移除参考图王府大厅", menu);
    expect(save).toHaveBeenLastCalledWith({ referenceCastIds: ["hero"] });
});

test("voice edits made in the secondary menu apply without a save action", async () => {
    const save = mock(async () => {});
    await renderReferences(save);
    await click("管理参考资产");
    const menu = document.querySelector('[aria-label="搜索参考资产"]')!;
    await click("关闭配角的音色", menu);
    expect(save).toHaveBeenLastCalledWith({ audioCastIds: ["hero"] });
});

test("failed automatic voice selection keeps the intended choice and retries explicitly", async () => {
    let failed = true;
    const save = mock(async () => {
        if (failed) throw new Error("音色选择写入失败");
    });
    await renderReferences(save);
    const menu = await openReferenceMenu();
    await click("关闭配角的音色", menu);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith({ audioCastIds: ["hero"] });
    expect(menu.textContent).toContain("音色选择写入失败");
    expect(menu.querySelector('[aria-label="开启配角的音色"]')).not.toBeNull();
    expect(menu.textContent).not.toContain("保存音色选择");
    failed = false;
    await click("重试音色选择", menu);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ audioCastIds: ["hero"] });
    expect(menu.textContent).not.toContain("音色选择写入失败");
});

test("reference image opens the real large preview and can return to the reference panel", async () => {
    spyOn(imageStorage, "resolveImageUrl").mockResolvedValue("data:image/png;base64,iVBORw0KGgo=");
    await renderReferences(mock(async () => {}));
    await click("放大预览夜景");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("夜景");
    await act(async () => document.querySelector<HTMLButtonElement>(".canvas-image-preview-modal .ant-modal-close")!.click());
    expect(document.querySelector(".canvas-image-preview-modal")).toBeNull();
    expect(host.querySelector('[aria-label="放大预览夜景"]')).not.toBeNull();
});

const adoptCast = [character, look, { ...character, id: "second", name: "配角" }, { ...character, id: "hall", kind: "scene", name: "大厅" }, { ...character, id: "sword", kind: "prop", name: "宝剑" }] as DramaCast[];

async function renderAdopt(boundCastId?: string) {
    const summary = { project: { id: "project" }, episodes: [], production: { settings: {} } } as unknown as DramaSummary;
    const node = {
        id: "canvas-image",
        type: CanvasNodeType.Image,
        position: { x: 0, y: 0 },
        width: 320,
        height: 240,
        metadata: {
            storageKey: "resource:canvas-outfit",
            ...(boundCastId ? { dramaRef: { projectId: "project", kind: "cast" as const, id: boundCastId } } : {}),
        },
    };
    const adopted = mock(() => {});
    const closed = mock(() => {});
    const impact = spyOn(api, "getDramaCastImpact").mockResolvedValue({ episodes: 1, segments: 2 });
    const save = spyOn(api, "setDramaCastImage").mockImplementation(async (_projectId, castId, imageResourceId) => ({ cast: { ...adoptCast.find((item) => item.id === castId)!, imageResourceId, imageVersion: 4 }, affectedSegments: 0 }));
    spyOn(resources, "getResourceAccess").mockRejectedValue(new Error("Preview unavailable in this fixture"));
    await act(async () =>
        root.render(
            <QueryClientProvider client={client}>
                <App>
                    <CanvasDramaAdoptModal node={node} nodes={[node]} summary={summary} cast={adoptCast} onClose={closed} onAdopted={adopted} />
                </App>
            </QueryClientProvider>,
        ),
    );
    return { save, adopted, closed, impact };
}

async function selectAdoptOption(label: string, optionText: string) {
    const input = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
    expect(input).not.toBeNull();
    await act(async () => input!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    const option = [...document.querySelectorAll<HTMLElement>(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")].find((item) => item.textContent?.trim() === optionText);
    expect(option).toBeDefined();
    await act(async () => option!.click());
}

test("canvas adoption selects a character outfit and submits its own slot", async () => {
    const { save, adopted, closed, impact } = await renderAdopt();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect([...dialog.querySelectorAll("button")].find((item) => item.textContent?.replace(/\s/g, "") === "采用")?.disabled).toBe(true);
    await selectAdoptOption("选择设定", "主角");
    await selectAdoptOption("选择服装或妆造", "晚宴");
    expect(impact.mock.calls.at(-1)?.slice(0, 2)).toEqual(["project", "look"]);
    await click("采用", dialog);
    expect(save).toHaveBeenCalledWith("project", "look", "canvas-outfit", false, { source: "canvas", taskId: undefined });
    expect(adopted).toHaveBeenCalledWith("canvas-image", { projectId: "project", kind: "cast", id: "look", baseResourceId: "canvas-outfit", baseImageVersion: 4, baseTakeId: undefined });
    expect(closed).toHaveBeenCalledTimes(1);
});

test("an outfit-bound canvas image defaults to the same character and outfit", async () => {
    const { save } = await renderAdopt("look");
    expect(document.querySelector('[aria-label="选择设定"]')?.closest(".app-unified-select")?.textContent).toContain("主角");
    expect(document.querySelector('[aria-label="选择服装或妆造"]')?.closest(".app-unified-select")?.textContent).toContain("晚宴");
    await click("采用", document);
    expect(save.mock.calls[0]?.[1]).toBe("look");
});

test("switching characters clears the previous outfit and selects the new base", async () => {
    const { save } = await renderAdopt("look");
    await selectAdoptOption("选择设定", "配角");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("还没有额外造型");
    await click("采用", document);
    expect(save.mock.calls[0]?.[1]).toBe("second");
});

test("base appearance remains an explicit adoption option", async () => {
    const { save } = await renderAdopt("look");
    await selectAdoptOption("选择服装或妆造", "基础造型（角色本体）");
    await click("采用", document);
    expect(save.mock.calls[0]?.[1]).toBe("hero");
});

test.each(["大厅", "宝剑"])("adopting to %s needs no character outfit selection", async (name) => {
    const { save } = await renderAdopt("look");
    await selectAdoptOption("选择设定", name);
    expect(document.querySelector('[aria-label="选择服装或妆造"]')).toBeNull();
    await click("采用", document);
    expect(save.mock.calls[0]?.[1]).toBe(name === "大厅" ? "hall" : "sword");
});

test("outfit projection preserves its name, custom prompt and adoption binding", () => {
    const node = buildDramaCastNode({ projectId: "project", cast: look, media: { assetIdOf: () => undefined, urlOf: () => "" }, topLeft: { x: 0, y: 0 } });
    expect(node.title).toBe("角色 · 主角 · 晚宴");
    expect(node.metadata?.prompt).toBe(look.imagePrompt);
    expect(node.metadata?.composerContent).toBe(look.imagePrompt);
    expect(defaultDramaAdoptTarget(node, [node])).toEqual({ kind: "cast", castId: "look" });
});
