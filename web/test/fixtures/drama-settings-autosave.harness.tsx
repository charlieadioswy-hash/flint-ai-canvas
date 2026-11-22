import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { DramaModelChoice, DramaSettings, DramaSummary } from "@/services/api/drama";

const dom = new Window({ url: "http://localhost/projects/project-a" });
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

mock.module("@/pages/projects/drama-model-picker", () => ({
    DramaModelPicker: ({ capability, onChange }: { capability: string; onChange: (choice: DramaModelChoice) => void }) => <button onClick={() => onChange({ channelId: "channel", modelKey: `${capability}-new` })}>调整{capability}模型</button>,
    useDramaModelCatalog: () => ({ data: { options: { image: [], video: [], text: [] } } }),
}));
mock.module("@/pages/projects/step-settings", () => ({
    DramaTextSteps: () => null,
    DramaAssetImageModels: () => null,
    VideoResolutionField: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
        <select aria-label="视频分辨率" value={value} onChange={(event) => onChange(event.target.value)}>
            <option value="720p">720p</option>
            <option value="1080p">1080p</option>
            <option value="4K">4K</option>
        </select>
    ),
}));
mock.module("@/pages/projects/asset-scheme", () => ({ AssetSchemePicker: () => null }));
mock.module("@/pages/projects/storyboard-rules", () => ({ StoryboardRules: () => null }));
mock.module("@/pages/projects/workflow-batch", () => ({ WorkflowBatch: ({ disabled }: { disabled: boolean }) => <button disabled={disabled}>重做参考图</button> }));

const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { App } = await import("antd");
const { RouterProvider, createMemoryRouter } = await import("react-router");
const { SettingsPanel } = await import("@/pages/projects/studio/panels");
const api = await import("@/services/api/drama");
const { useUserStore } = await import("@/stores/use-user-store");
const { setActiveUserScope } = await import("@/lib/user-scope");

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
let router: ReturnType<typeof createMemoryRouter>;
let server: DramaSummary;
let hold: Promise<void> | undefined;
let rejectWrite = false;
let updateSummary: (summary: DramaSummary) => void;
const writes: Parameters<typeof api.updateDramaSettings>[1][] = [];
const makeSummary = (): DramaSummary =>
    ({
        project: { id: "project-a", sourceType: "script" },
        episodes: [],
        production: {
            revision: 9,
            guideStep: "done",
            budgetMicrocredits: 5_000_000,
            spentMicrocredits: 0,
            heldMicrocredits: 0,
            canvasSpentMicrocredits: 0,
            settings: {
                aspectRatio: "16:9",
                language: "中文",
                styleName: "原始画风",
                models: { text: { modelKey: "text" }, image: { modelKey: "image" }, video: { modelKey: "video" } },
                assets: {},
                storyboard: {},
                videoResolution: "720p",
                referenceLimit: 3,
                reviewMode: "sample",
                mediaMode: "manual",
                videoContinuity: "parallel",
                concurrency: 2,
            },
        },
    }) as DramaSummary;

beforeEach(() => {
    setActiveUserScope("user-a");
    useUserStore.setState({ user: { id: "user-a" } as never });
    writes.length = 0;
    hold = undefined;
    rejectWrite = false;
    server = makeSummary();
    spyOn(api, "getDrama").mockImplementation(async () => structuredClone(server));
    spyOn(api, "updateDramaSettings").mockImplementation(async (_project, input) => {
        writes.push(structuredClone(input));
        await hold;
        if (rejectWrite) throw new Error("设置写入失败");
        expect(input.expectedRevision).toBe(server.production.revision);
        const current = server.production.settings;
        const settings = input.generation ? { ...current, ...input.generation, models: { ...current.models, ...input.generation.models } } : input.settings || current;
        server = { ...server, production: { ...server.production, revision: server.production.revision + 1, settings, budgetMicrocredits: input.budgetMicrocredits ?? server.production.budgetMicrocredits } };
        return structuredClone(server);
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => {
    await act(async () => root.unmount());
    router?.dispose();
    client.clear();
    host.remove();
    mock.restore();
});
afterAll(() => dom.happyDOM.abort());
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const waitAuto = () => act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
async function render(summary = server) {
    function SettingsRoute() {
        const [current, setCurrent] = useState(summary);
        updateSummary = setCurrent;
        return <SettingsPanel projectId="project-a" summary={current} cast={[]} onChanged={() => {}} />;
    }
    router = createMemoryRouter(
        [
            { path: "/settings", element: <SettingsRoute /> },
            { path: "/other", element: <p>已进入其他页面</p> },
        ],
        { initialEntries: ["/settings"] },
    );
    await act(async () => {
        root.render(
            <QueryClientProvider client={client}>
                <App>
                    <RouterProvider router={router} />
                </App>
            </QueryClientProvider>,
        );
        await settle();
    });
}
function button(text: string) {
    const target = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);
    if (!target) throw new Error(`找不到按钮 ${text}: ${host.textContent}`);
    return target;
}
async function click(text: string) {
    await act(async () => {
        button(text).click();
        await settle();
    });
}
async function resolution(value: string) {
    await act(async () => {
        const input = host.querySelector<HTMLSelectElement>('[aria-label="视频分辨率"]')!;
        input.value = value;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await settle();
    });
}
async function budget(value: string) {
    await act(async () => {
        const input = host.querySelector<HTMLInputElement>('[aria-label="预算上限"]')!;
        Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await settle();
    });
}

test("图片和视频模型以及分辨率修改自动持久化，重做参考图无需保存", async () => {
    await render();
    await click("调整image模型");
    await click("调整video模型");
    await resolution("1080p");
    expect(button("重做参考图").disabled).toBe(true);
    await waitAuto();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ expectedRevision: 9, generation: { models: { image: { modelKey: "image-new" }, video: { modelKey: "video-new" } }, videoResolution: "1080p" } });
    expect(writes[0].budgetMicrocredits).toBeUndefined();
    expect(button("保存其他设置").disabled).toBe(true);
    expect(button("重做参考图").disabled).toBe(false);
});

test("预算与文字草稿不随生成配置自动保存，也不阻挡参考图操作", async () => {
    await render();
    await budget("12");
    await click("调整text模型");
    await resolution("1080p");
    await waitAuto();
    expect(writes).toHaveLength(1);
    expect(writes[0].budgetMicrocredits).toBeUndefined();
    expect(writes[0].settings).toBeUndefined();
    expect(writes[0].generation?.models).not.toHaveProperty("text");
    expect((host.querySelector('[aria-label="预算上限"]') as HTMLInputElement).value).toBe("12");
    expect(button("保存其他设置").disabled).toBe(false);
    expect(button("重做参考图").disabled).toBe(false);
    await click("保存其他设置");
    expect(writes[1]).toMatchObject({ expectedRevision: 10, budgetMicrocredits: 12_000_000, settings: { models: { text: { modelKey: "text-new" } }, videoResolution: "1080p" } });
});

test("保存期间后续参数串行追加，使用上一次回执版本", async () => {
    await render();
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
        release = resolve;
    });
    await resolution("1080p");
    await waitAuto();
    expect(writes).toHaveLength(1);
    await resolution("4K");
    await waitAuto();
    expect(writes).toHaveLength(1);
    await act(async () => {
        hold = undefined;
        release();
        await settle();
    });
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ expectedRevision: 10, generation: { videoResolution: "4K" } });
    expect(button("重做参考图").disabled).toBe(false);
});

test("自动保存失败保留当前选择，明确重试前不循环重发", async () => {
    await render();
    rejectWrite = true;
    await resolution("1080p");
    await waitAuto();
    expect(writes).toHaveLength(1);
    expect(host.textContent).toContain("设置写入失败");
    expect((host.querySelector('[aria-label="视频分辨率"]') as HTMLSelectElement).value).toBe("1080p");
    await waitAuto();
    expect(writes).toHaveLength(1);
    rejectWrite = false;
    await click("重试应用生成配置");
    expect(writes).toHaveLength(2);
    expect(button("重做参考图").disabled).toBe(false);
});

test("离开设置先同步尚未提交的参数，完成后自动继续且不弹确认", async () => {
    await render();
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
        release = resolve;
    });
    await resolution("1080p");
    await act(async () => {
        void router.navigate("/other");
        await settle();
    });
    expect(writes).toHaveLength(1);
    expect(router.state.location.pathname).toBe("/settings");
    expect(host.textContent).toContain("正在应用生成配置");
    expect(document.querySelector(".ant-modal-confirm")).toBeNull();
    await act(async () => {
        hold = undefined;
        release();
        await settle();
    });
    expect(server.production.settings.videoResolution).toBe("1080p");
    expect(router.state.location.pathname).toBe("/other");
    expect(host.textContent).toContain("已进入其他页面");
});

for (const pending of [false, true]) {
    test(`${pending ? "同步期间" : "同步触发前"}离开遇到保存失败时留在设置并保留选择`, async () => {
        await render();
        rejectWrite = true;
        let release!: () => void;
        hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        await resolution("1080p");
        if (pending) await waitAuto();
        await act(async () => {
            void router.navigate("/other");
            await settle();
        });
        expect(writes).toHaveLength(1);
        expect(router.state.location.pathname).toBe("/settings");
        await act(async () => {
            hold = undefined;
            release();
            await settle();
        });
        expect(router.state.location.pathname).toBe("/settings");
        expect(host.textContent).toContain("设置写入失败");
        expect((host.querySelector('[aria-label="视频分辨率"]') as HTMLSelectElement).value).toBe("1080p");
        expect(document.querySelector(".ant-modal-confirm")).toBeNull();
        rejectWrite = false;
        await click("重试应用生成配置");
        expect(server.production.settings.videoResolution).toBe("1080p");
        await act(async () => {
            await router.navigate("/other");
            await settle();
        });
        expect(router.state.location.pathname).toBe("/other");
    });
}

test("账号切换不会提交旧账号尚未同步的生成配置", async () => {
    await render();
    await resolution("1080p");
    await act(async () => {
        setActiveUserScope("user-b");
        useUserStore.setState({ user: { id: "user-b" } as never });
        await settle();
    });
    await waitAuto();
    expect(writes).toHaveLength(0);
});

for (const receivedSummary of [false, true]) {
    test(`远端配置${receivedSummary ? "已推送到当前页面" : "仅在同步读取时更新"}时，以当前页面生成参数为准`, async () => {
        await render();
        await resolution("1080p");
        server = structuredClone(server);
        server.production.revision++;
        server.production.settings.videoResolution = "4K";
        server.production.settings.models.text = { modelKey: "remote-text" };
        server.production.budgetMicrocredits = 11_000_000;
        if (receivedSummary) await act(async () => updateSummary(structuredClone(server)));
        await waitAuto();
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ expectedRevision: 10, generation: { videoResolution: "1080p" } });
        expect(server.production.settings.videoResolution).toBe("1080p");
        expect(server.production.settings.models.text).toEqual({ modelKey: "remote-text" });
        expect(server.production.budgetMicrocredits).toBe(11_000_000);
        expect(host.textContent).not.toContain("生成配置已在其他位置更新");
    });
}

test("账号 A 切 B 再切回 A 后，旧读取请求不能继续提交已卸载页面的草稿", async () => {
    let releaseRead!: (summary: DramaSummary) => void;
    const pendingRead = new Promise<DramaSummary>((resolve) => {
        releaseRead = resolve;
    });
    spyOn(api, "getDrama").mockImplementationOnce(() => pendingRead);
    await render();
    await resolution("1080p");
    await waitAuto();
    expect(writes).toHaveLength(0);
    for (const userId of ["user-b", "user-a"]) {
        await act(async () => {
            setActiveUserScope(userId);
            useUserStore.setState({ user: { id: userId } as never });
            await settle();
        });
    }
    await act(async () => {
        releaseRead(structuredClone(server));
        await settle();
    });
    expect(writes).toHaveLength(0);
    expect(server.production.settings.videoResolution).toBe("720p");
    expect((host.querySelector('[aria-label="视频分辨率"]') as HTMLSelectElement).value).toBe("720p");
});

test("账号往返后旧写入回执不能追加旧页面的后续草稿", async () => {
    await render();
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
        release = resolve;
    });
    await resolution("1080p");
    await waitAuto();
    expect(writes).toHaveLength(1);
    await resolution("4K");
    for (const userId of ["user-b", "user-a"]) {
        await act(async () => {
            setActiveUserScope(userId);
            useUserStore.setState({ user: { id: userId } as never });
            await settle();
        });
    }
    await act(async () => {
        hold = undefined;
        release();
        await settle();
    });
    expect(writes).toHaveLength(1);
    expect(server.production.settings.videoResolution).toBe("1080p");
    expect((host.querySelector('[aria-label="视频分辨率"]') as HTMLSelectElement).value).toBe("720p");
});
