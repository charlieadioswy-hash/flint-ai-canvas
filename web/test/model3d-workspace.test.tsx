import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import type { Model3DCapabilities, Model3DTaskView } from "../src/services/api/model3d";

const dom = new Window({ url: "http://localhost/model3d" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement,
    Element: dom.Element,
    Node: dom.Node,
    SVGElement: dom.SVGElement,
    ShadowRoot: dom.ShadowRoot,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { App, ConfigProvider, theme } = await import("antd");
const { Model3DWorkspace } = await import("../src/pages/model3d/model3d-workspace");
const { Model3DTaskProgress } = await import("../src/pages/model3d/model3d-results");
const { createDefaultModel3DState } = await import("../src/lib/canvas/model3d");

afterAll(() => {
    dom.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

const capabilities: Model3DCapabilities = {
    available: true,
    providerName: "Tripo",
    policyRevision: 1,
    activeConfigVersion: 1,
    defaultModel: "h3.1",
    modelVersions: [{ id: "h3.1", label: "H3.1", supportsAdvanced: true, maxFacesStandard: 500000, maxFacesDetailed: 2000000 }],
    modes: ["text", "image", "multiview"],
    inputLimits: { maxBytes: 10 * 1024 * 1024, mimeTypes: ["image/png", "image/jpeg"], minViews: 2, maxViews: 4, requiredView: "front" },
};
function task(overrides: Partial<Model3DTaskView> = {}): Model3DTaskView {
    return {
        id: "task",
        mode: "text",
        status: "running",
        stage: "生成中",
        sourceFingerprint: "fingerprint",
        clientContext: { canvasId: "", nodeId: "" },
        submissionOutcome: "submitted",
        canRetryStorage: false,
        createdAt: "2026-10-22T00:00:00Z",
        updatedAt: "2026-10-22T00:00:00Z",
        ...overrides,
    };
}

async function fixture(dark = false) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const calls = { generate: [] as unknown[][], select: [] as string[], refresh: 0 };
    function TestWorkspace() {
        const [draft, setDraft] = useState(() => ({ ...createDefaultModel3DState("h3.1").draft, prompt: "卡通机器人", parameters: { model: "h3.1", texture: true, pbr: true, faceLimit: 100000 } }));
        const [count, setCount] = useState(2);
        return (
            <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
                <App>
                    <MemoryRouter initialEntries={["/model3d"]}>
                        <Model3DWorkspace
                            capabilities={capabilities}
                            loading={false}
                            refreshing={false}
                            error=""
                            draft={draft}
                            setDraft={setDraft}
                            count={count}
                            setCount={setCount}
                            tasks={[task()]}
                            selectedTaskId="task"
                            selectTask={(id) => calls.select.push(id)}
                            submitting={false}
                            uploading={false}
                            hasMore={false}
                            loadingMore={false}
                            generate={async (...args) => {
                                calls.generate.push(args);
                            }}
                            refresh={async () => {
                                ++calls.refresh;
                            }}
                            refreshTask={async () => {}}
                            recover={async () => {}}
                            loadMore={async () => {}}
                            uploadImage={async () => ({ resourceId: "image" })}
                            reuseTask={() => {}}
                        />
                    </MemoryRouter>
                </App>
            </ConfigProvider>
        );
    }
    await act(async () => root.render(<TestWorkspace />));
    const click = async (label: string) => {
        const button = [...document.querySelectorAll("button")].find((element) => element.textContent?.replace(/\s/g, "") === label.replace(/\s/g, ""));
        expect(button).toBeDefined();
        await act(async () => button!.click());
    };
    return {
        host,
        calls,
        click,
        async dispose() {
            await act(async () => root.unmount());
            host.remove();
        },
    };
}

for (const dark of [false, true]) {
    test(`standalone workspace waits for explicit confirmation before generating (${dark ? "dark" : "light"})`, async () => {
        const f = await fixture(dark);
        try {
            expect(f.host.textContent).toContain("3D 创作");
            expect(f.host.querySelector('a[href="/assets"]')).not.toBeNull();
            expect(f.calls.generate).toHaveLength(0);
            await f.click("确认并生成 2 个版本");
            expect(document.querySelector('[role="dialog"]')?.textContent).toContain("100,000");
            expect(document.querySelector('[role="dialog"]')?.textContent).toContain("2 个独立任务");
            expect(f.calls.generate).toHaveLength(0);
            await f.click("开始生成 2 个版本");
            expect(f.calls.generate).toHaveLength(1);
            expect(f.calls.generate[0]?.[0]).toMatchObject({ prompt: "卡通机器人", parameters: { faceLimit: 100000, texture: true, pbr: true } });
            expect(f.calls.generate[0]?.[1]).toBe(2);
        } finally {
            await f.dispose();
        }
    });
}

test("selecting a task and refreshing status never generate another task", async () => {
    const f = await fixture();
    try {
        await act(async () => f.host.querySelector<HTMLButtonElement>(".model3d-task-select")!.click());
        await f.click("刷新任务");
        expect(f.calls.select).toEqual(["task"]);
        expect(f.calls.refresh).toBe(1);
        expect(f.calls.generate).toHaveLength(0);
    } finally {
        await f.dispose();
    }
});

test("cancelling generation confirmation leaves tasks untouched", async () => {
    const f = await fixture();
    try {
        await f.click("确认并生成 2 个版本");
        await f.click("返回修改");
        expect(f.calls.generate).toHaveLength(0);
    } finally {
        await f.dispose();
    }
});

test("prompt ideas can be adopted without generating a model", async () => {
    const f = await fixture();
    try {
        await f.click("帮我想想");
        await f.click("科幻跑车");
        expect(document.querySelector<HTMLTextAreaElement>('[aria-label="生成的 3D 提示词"]')?.value).toContain("一辆完整的未来科幻跑车");
        await f.click("使用这段描述");
        expect(f.host.querySelector<HTMLTextAreaElement>('[aria-label="模型描述"]')?.value).toContain("一辆完整的未来科幻跑车");
        expect(f.calls.generate).toHaveLength(0);
    } finally {
        await f.dispose();
    }
});

test("3D progress displays real zero and hides percentages during saving or uncertain submission", () => {
    const zero = renderToStaticMarkup(<Model3DTaskProgress task={task({ providerProgress: 0 })} />);
    expect(zero).toContain("0%");
    expect(zero).toContain('value="0"');
    const withoutPercentage = [
        task(),
        task({ providerProgress: 100 }),
        task({ stage: "保存 3D 模型文件", providerProgress: 99 }),
        task({ status: "failed", providerProgress: 99 }),
        { ...task({ providerProgress: 30 }), localStatus: "submission_unknown" as const },
    ];
    for (const value of withoutPercentage) expect(renderToStaticMarkup(<Model3DTaskProgress task={value} />)).not.toContain("<progress");
});
