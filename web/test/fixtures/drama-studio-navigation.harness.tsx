import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { DramaEpisodeDetail, DramaShot, DramaSummary } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/projects/project/e/episode" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router");
type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & { type?: string; size?: string; shape?: string; icon?: ReactNode; loading?: boolean };
mock.module("antd", () => ({
    App: { useApp: () => ({ message: { success() {}, error() {} }, modal: { confirm() {} } }) },
    Button: ({ type: _type, size: _size, shape: _shape, loading, icon, children, ...props }: ButtonProps) => (
        <button {...props} type="button" disabled={loading || props.disabled}>
            {icon}
            {children}
        </button>
    ),
    Dropdown: ({ children }: { children: ReactNode }) => children,
}));
mock.module("@/components/layout/workspace-page", () => ({ WorkspacePage: ({ children }: { children: ReactNode }) => children }));
mock.module("@/components/layout/workspace-state", () => ({ WorkspaceLoadingState: () => null, WorkspaceErrorState: () => null }));
mock.module("@/components/ui/base/segmented-control", () => ({ SegmentedControl: () => null }));
mock.module("@/pages/projects/simple-studio", () => ({ default: () => <div data-simple-studio /> }));
let openSimpleStudio: (() => void) | undefined;
mock.module("@/pages/projects/studio/use-studio-agent", () => ({
    useStudioAgent(_project: string, _summary: unknown, _unavailable: boolean, onOpen: () => void) {
        openSimpleStudio = onOpen;
    },
}));
mock.module("@/pages/projects/drama-shared", () => ({
    formatCount: (value: number) => String(value),
    formatDuration: (value: number) => String(value),
    sourceFormatOf: () => "novel",
    StagePips: () => null,
    STAGE_LABEL: { review: "待审阅" },
    STATUS_LABEL: { running: "运行中" },
}));
for (const [path, names] of [
    ["panels", ["CastPanel", "InboxPanel", "SettingsPanel"]],
    ["episode-delete-modal", ["EpisodeDeleteModal"]],
    ["episode-rail", ["EpisodeRail"]],
    ["episode-source", ["AddEpisodeModal"]],
    ["asset-transfer", ["AssetImportModal", "AssetPackageModal"]],
    ["chapter-picker", ["ChapterPickerModal"]],
    ["final-view", ["FinalView"]],
    ["genesis", ["StudioGenesis"]],
    ["queue-bar", ["QueueBar"]],
    ["script-view", ["ScriptView"]],
    ["storyboard", ["Storyboard"]],
] as const) {
    mock.module(`@/pages/projects/studio/${path}`, () => Object.fromEntries(names.map((name) => [name, () => null])));
}
let dialog: { onInsertShot: (shot: DramaShot, position: "before" | "after") => void; onDeleteShot: (shot: DramaShot) => void };
mock.module("@/pages/projects/studio/segment-dialog", () => ({
    SegmentDialog: (props: typeof dialog) => {
        dialog = props;
        return null;
    },
}));
const noopRequest = async () => ({});
let insertResult: Promise<{ shot: DramaShot }> | undefined;
let removeResult: Promise<void> | undefined;
mock.module("@/services/api/drama", () => ({
    approveDramaEpisode: noopRequest,
    deleteDramaShot: async () => {
        await removeResult;
        return {};
    },
    generateDramaSegments: noopRequest,
    insertDramaShot: async () => insertResult || { shot: { id: "inserted" } as DramaShot },
    pauseDrama: noopRequest,
    reprocessDramaSegmentVideo: noopRequest,
    regenerateDramaCast: noopRequest,
    releaseDramaMedia: noopRequest,
    renameDramaEpisode: noopRequest,
    rescriptDramaEpisode: noopRequest,
    retryFailedDrama: noopRequest,
    startDrama: noopRequest,
    updateDramaSegment: noopRequest,
    updateDramaSegmentReferences: noopRequest,
    writeDramaSegmentPrompts: noopRequest,
    updateDramaShot: noopRequest,
}));
const episode = { id: "episode", projectId: "project", number: 1, title: "序章", stage: "review", stats: { segments: 1 }, shotCount: 1 };
const summary = {
    project: { id: "project", name: "真实制作台导航" },
    production: { status: "running", guideStep: "completed", planDone: true, settings: { assets: { characterRatio: "9:16" }, models: { video: {} }, reviewMode: "auto" } },
    episodes: [episode],
    inbox: [],
    jobCounts: {},
} as unknown as DramaSummary;
const detail = { episode, shots: [], segments: [], jobs: [] } as unknown as DramaEpisodeDetail;
mock.module("@/pages/projects/studio/use-studio", () => ({
    useDramaSummary: () => ({ data: summary, isLoading: false, isError: false }),
    useDramaEpisode: () => ({ data: detail }),
    useDramaCast: () => ({ cast: [], byId: new Map() }),
    useDramaInvalidate: () => () => {},
    useOpenDramaCanvas: () => ({ opening: null, open: noopRequest }),
    isTypingTarget: () => false,
}));
const { default: DramaStudioPage } = await import("@/pages/projects/detail");

function Location() {
    const location = useLocation();
    return <output data-location>{location.search}</output>;
}
async function fixture(search: string) {
    const query = new QueryClient();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(() =>
        root.render(
            <QueryClientProvider client={query}>
                <MemoryRouter initialEntries={[`/projects/project/e/episode?${search}`]}>
                    <Location />
                    <Routes>
                        <Route path="/projects/:projectId/e/:episodeId" element={<DramaStudioPage />} />
                    </Routes>
                </MemoryRouter>
            </QueryClientProvider>,
        ),
    );
    return {
        host,
        close: async () => {
            await act(() => root.unmount());
            host.remove();
            query.clear();
        },
    };
}

afterAll(() => {
    browser.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

for (const search of ["tab=script", "tab=final", "view=cast", "view=inbox", "view=settings"]) {
    test(`旧详细深链 ${search} 返回分镜仍留在详细制作台`, async () => {
        const view = await fixture(search);
        try {
            const selector = search.startsWith("tab=") ? ".drama-tabs button" : ".drama-nav button";
            const text = search.startsWith("tab=") ? "分镜" : "制作";
            expect(view.host.querySelector("[data-simple-studio]")).toBeNull();
            const button = [...view.host.querySelectorAll<HTMLButtonElement>(selector)].find((item) => item.textContent?.trim() === text);
            expect(button).toBeDefined();
            await act(() => button!.click());
            expect(view.host.querySelector("[data-simple-studio]")).toBeNull();
            const params = new URLSearchParams(view.host.querySelector("[data-location]")!.textContent!);
            expect(params.get("mode")).toBe("advanced");
            expect(params.has(search.split("=")[0])).toBe(false);
            expect(view.host.querySelector(".drama-studio")).not.toBeNull();
        } finally {
            await view.close();
        }
    });
}

for (const operation of ["insert", "delete"] as const) {
    test(`详细台${operation === "insert" ? "插入" : "删除"}镜头在途切回简易台后不被旧回执切回`, async () => {
        const view = await fixture("mode=advanced&segment=0");
        let finish!: () => void;
        if (operation === "insert") {
            insertResult = new Promise((resolve) => {
                finish = () => resolve({ shot: { id: "inserted" } as DramaShot });
            });
        } else
            removeResult = new Promise((resolve) => {
                finish = resolve;
            });
        try {
            const shot = { id: "shot-one", episodeId: "episode", projectId: "project", segmentIndex: 0 } as DramaShot;
            await act(() => {
                if (operation === "insert") dialog.onInsertShot(shot, "after");
                else dialog.onDeleteShot(shot);
            });
            await act(() => openSimpleStudio!());
            expect(view.host.querySelector("[data-simple-studio]")).not.toBeNull();
            await act(async () => {
                finish();
                await Promise.resolve();
            });
            expect(view.host.querySelector("[data-simple-studio]")).not.toBeNull();
        } finally {
            insertResult = undefined;
            removeResult = undefined;
            await view.close();
        }
    });
}
