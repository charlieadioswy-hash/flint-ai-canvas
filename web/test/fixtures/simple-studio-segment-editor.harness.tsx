import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import type { DramaEpisodeDetail, DramaSegment, DramaShot, DramaSummary } from "@/services/api/drama";
import { dramaKeys } from "@/lib/drama/drama-query-keys";

const browser = new Window({ url: "http://localhost/projects/project" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const message = { success: mock(() => {}), error: mock(() => {}) };
mock.module("antd", () => ({ App: { useApp: () => ({ message }) } }));

const patchPrompt = mock(async (..._args: unknown[]) => ({ saved: true }));
const patchReferences = mock(async (..._args: unknown[]) => ({ saved: true }));
const patchShot = mock(async (..._args: unknown[]) => ({ shot: {} }));
const writePrompt = mock(async (..._args: unknown[]) => ({ queued: 1 }));
const processVideo = mock(async (..._args: unknown[]) => ({}));
const legacyGenerate = mock(async () => {
    throw new Error("不能整集放行");
});
let insertResult: Promise<{ shot: DramaShot }> | undefined;
const insertShot = mock(async (..._args: unknown[]) => insertResult || { shot: { id: "inserted" } as DramaShot });
let removeResult: Promise<{ deleted: boolean }> | undefined;
const removeShot = mock(async (..._args: unknown[]) => removeResult || { deleted: true });
mock.module("@/services/api/drama", () => ({
    getDrama: async () => ({}),
    getDramaEpisode: async () => ({}),
    listDramaCast: async () => ({}),
    deleteDramaShot: removeShot,
    insertDramaShot: insertShot,
    reprocessDramaSegmentVideo: processVideo,
    updateDramaSegment: patchPrompt,
    updateDramaSegmentReferences: patchReferences,
    updateDramaShot: patchShot,
    writeDramaSegmentPrompts: writePrompt,
    generateDramaSegments: legacyGenerate,
}));
mock.module("@/services/drama-canvas", () => ({
    encodeDramaCanvasFocus: () => "segment:episode:0",
    openDramaCanvasPath: async () => "/canvas/canvas",
}));

type DialogProps = ComponentProps<typeof import("@/pages/projects/studio/segment-dialog").SegmentDialog>;
let dialog!: DialogProps;
mock.module("@/pages/projects/studio/segment-dialog", () => ({
    SegmentDialog: (props: DialogProps) => {
        dialog = props;
        return <div data-testid="editor" data-episode={props.detail?.episode.id || ""} />;
    },
}));
const { SimpleStudioSegmentEditor } = await import("@/pages/projects/simple-studio-segment-editor");
type EditorProps = ComponentProps<typeof SimpleStudioSegmentEditor>;

function summary(step: "completed" | "story" = "completed"): DramaSummary {
    return { project: { id: "project", name: "作品" }, production: { revision: 17, guideStep: step, settings: { aspectRatio: "9:16", videoResolution: "720p", models: { video: { logicalModelId: "video-default" } } } } } as unknown as DramaSummary;
}
function detail(episodeId = "episode-a"): DramaEpisodeDetail {
    return {
        episode: { id: episodeId, projectId: "project", number: 2 },
        segments: [{ id: `segment-${episodeId}`, index: 0, revision: 5 }],
        shots: [{ id: `shot-${episodeId}`, episodeId, projectId: "project", segmentIndex: 0 }],
    } as unknown as DramaEpisodeDetail;
}
async function fixture() {
    const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    query.setQueryData(dramaKeys.episode("project", "episode-a"), detail());
    query.setQueryData(dramaKeys.episode("project", "episode-b"), detail("episode-b"));
    query.setQueryData(dramaKeys.summary("project"), summary());
    query.setQueryData(dramaKeys.takes("project", "video", "segment-episode-a"), { takes: [] });
    const navigate = mock(() => {});
    const generate = mock(() => {});
    const openCast = mock(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let props: EditorProps = { summary: summary(), detail: detail(), episodeId: "episode-a", segmentIndex: 0, castById: new Map(), onClose: () => {}, onNavigate: navigate, onGenerate: generate, onOpenAdvancedCast: openCast };
    const render = async (patch: Partial<EditorProps> = {}) => {
        props = { ...props, ...patch };
        await act(() =>
            root.render(
                <QueryClientProvider client={query}>
                    <MemoryRouter>
                        <SimpleStudioSegmentEditor {...props} />
                    </MemoryRouter>
                </QueryClientProvider>,
            ),
        );
    };
    await render();
    return {
        query,
        navigate,
        generate,
        openCast,
        render,
        close: async () => {
            await act(() => root.unmount());
            host.remove();
            query.clear();
        },
    };
}
async function flush() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

afterAll(() => {
    browser.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

test("提示词与镜头复用旧写入，完成引导后不发送引导版本号", async () => {
    const view = await fixture();
    try {
        await act(() => dialog.onSavePrompt(detail().segments[0], "修改后的提示词"));
        await flush();
        expect(patchPrompt.mock.calls.at(-1)).toEqual(["project", "episode-a", 0, "修改后的提示词", undefined]);
        expect(view.query.getQueryState(dramaKeys.episode("project", "episode-a"))?.isInvalidated).toBe(true);
        expect(view.query.getQueryState(dramaKeys.episode("project", "episode-b"))?.isInvalidated).toBe(false);
        expect(view.query.getQueryState(dramaKeys.takes("project", "video", "segment-episode-a"))?.isInvalidated).toBe(true);
        await act(() => dialog.onPatchShot(detail().shots[0], { dialogue: "新的台词" }));
        await flush();
        expect(patchShot.mock.calls.at(-1)).toEqual(["project", "shot-episode-a", { dialogue: "新的台词" }]);
        await view.render({ summary: summary("story") });
        await act(() => dialog.onSavePrompt(detail().segments[0], "引导中的修改"));
        await flush();
        expect(patchPrompt.mock.calls.at(-1)).toEqual(["project", "episode-a", 0, "引导中的修改", 17]);
    } finally {
        await view.close();
    }
});

test("编辑器生成仅委托父级预检，资产入口交父级路由处理", async () => {
    const view = await fixture();
    try {
        const changed = { ...detail().segments[0], revision: 8 };
        await view.render({ detail: { ...detail(), segments: [changed] } });
        await act(() => dialog.onGenerate(detail().segments[0], { logicalModelId: "video-selected" }));
        expect(view.generate.mock.calls).toEqual([[changed, { logicalModelId: "video-selected" }]]);
        expect(legacyGenerate).not.toHaveBeenCalled();
        await act(() => dialog.onOpenCast("cast-a"));
        expect(view.openCast.mock.calls).toEqual([["cast-a"]]);
    } finally {
        await view.close();
    }
});

test("插镜头在途切集后只刷新原集，不抢回新集定位", async () => {
    const view = await fixture();
    let finish!: (value: { shot: DramaShot }) => void;
    insertResult = new Promise((resolve) => {
        finish = resolve;
    });
    try {
        await act(() => dialog.onInsertShot?.(detail().shots[0], "after"));
        await view.render({ episodeId: "episode-b", detail: detail("episode-b") });
        await act(async () => finish({ shot: { id: "inserted" } as DramaShot }));
        await flush();
        expect(insertShot.mock.calls.at(-1)).toEqual(["project", "shot-episode-a", "after"]);
        expect(view.navigate).not.toHaveBeenCalled();
        expect(view.query.getQueryState(dramaKeys.episode("project", "episode-a"))?.isInvalidated).toBe(true);
        expect(view.query.getQueryState(dramaKeys.episode("project", "episode-b"))?.isInvalidated).toBe(false);
    } finally {
        insertResult = undefined;
        await view.close();
    }
});

for (const operation of ["insert", "delete"] as const) {
    test(`${operation === "insert" ? "插入" : "删除"}镜头在途离开编辑器后不导航回旧页面`, async () => {
        const view = await fixture();
        let closed = false;
        let finish!: () => void;
        if (operation === "insert") {
            insertResult = new Promise((resolve) => {
                finish = () => resolve({ shot: { id: "inserted" } as DramaShot });
            });
        } else {
            removeResult = new Promise((resolve) => {
                finish = () => resolve({ deleted: true });
            });
        }
        try {
            await act(() => {
                if (operation === "insert") dialog.onInsertShot?.(detail().shots[0], "after");
                else dialog.onDeleteShot?.(detail().shots[0]);
            });
            await view.close();
            closed = true;
            await act(async () => finish());
            await flush();
            expect(view.navigate).not.toHaveBeenCalled();
        } finally {
            insertResult = undefined;
            removeResult = undefined;
            if (!closed) await view.close();
        }
    });
}

test("参考保存、提示词重写和已有视频重处理均只操作指定集段", async () => {
    const view = await fixture();
    try {
        await view.render({ episodeId: "episode-b", detail: detail("episode-b") });
        const segment = detail("episode-b").segments[0];
        await act(async () => {
            await dialog.onSaveReferences(segment, { referenceCastIds: ["cast-a"] });
        });
        expect(patchReferences.mock.calls.at(-1)).toEqual(["project", "episode-b", 0, { referenceCastIds: ["cast-a"] }]);
        await act(() => dialog.onWritePrompt(segment));
        await flush();
        expect(writePrompt.mock.calls.at(-1)).toEqual(["project", "episode-b", [0]]);
        await act(() => dialog.onReprocess(segment));
        await flush();
        expect(processVideo.mock.calls.at(-1)).toEqual(["project", "episode-b", 0]);
        expect(legacyGenerate).not.toHaveBeenCalled();
    } finally {
        await view.close();
    }
});

test("详情与当前真实集不匹配时不展示旧段，也不允许旧回调写入", async () => {
    const view = await fixture();
    try {
        await view.render({ episodeId: "episode-b" });
        expect(dialog.detail).toBeUndefined();
        const before = patchPrompt.mock.calls.length;
        await act(() => dialog.onSavePrompt(detail().segments[0], "不能写到另一集"));
        expect(patchPrompt.mock.calls.length).toBe(before);
        await expect(dialog.onSaveReferences(detail().segments[0], {})).rejects.toThrow("本段内容已变化");
    } finally {
        await view.close();
    }
});
