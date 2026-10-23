import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ImageCapabilityConfig, ModelCapabilityConfig } from "../src/lib/model-capabilities";
import type { AiConfig } from "../src/stores/use-config-store";
import type { CanvasNodeData } from "../src/types/canvas";

const dom = new Window({ url: "http://localhost/" });
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
const { CanvasImageCountControl } = await import("../src/components/canvas/canvas-image-count-control");
const { CanvasFreeformEmptyState } = await import("../src/components/canvas/canvas-short-drama-entry");
const { defaultConfig } = await import("../src/stores/use-config-store");
const { defaultImageCapabilityConfig, normalizeModelCapabilityConfig } = await import("../src/lib/model-capabilities");
const { buildNodeConfig } = await import("../src/components/canvas/canvas-node-prompt-config");
const { buildGenerationConfig } = await import("../src/lib/canvas/canvas-project-generation");
const { requestCreditCost } = await import("../src/lib/model-pricing");
const { ImageSettingsPanel } = await import("../src/components/image-settings-panel");
const { ModelCapabilityEditor } = await import("../src/components/model-capability-editor");
const { capabilitySpecFromChannelModel } = await import("../src/pages/admin/logical-models/model-routing-capabilities");
const { prepareBackendGenerationTask } = await import("../src/services/api/generation-task");
const { canvasThemes } = await import("../src/lib/canvas-theme");
const { MemoryRouter } = await import("react-router");
const { App } = await import("antd");
const { WorkspaceSidebarNav } = await import("../src/components/layout/workspace-sidebar-nav");
const { defaultFeatureAvailability, useUserStore } = await import("../src/stores/use-user-store");

afterAll(() => {
    dom.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function configWithProfile(profile: ImageCapabilityConfig): AiConfig {
    return {
        ...defaultConfig,
        model: "test::image-model",
        imageModel: "test::image-model",
        count: "1",
        canvasImageCount: "1",
        channels: [
            {
                id: "test",
                name: "Test",
                scope: "system",
                enabled: true,
                baseUrl: "/api/ai/system/test",
                apiFormat: "openai",
                models: ["image-model"],
                concurrencyLimit: 1,
                hasApiKey: true,
                hasSecretKey: false,
                createdAt: "",
                updatedAt: "",
                modelCosts: [{ model: "image-model", capability: "image", capabilityConfig: { image: profile }, billingMode: "fixed_request", unitPriceMicrocredits: 2_000_000, priceConfigured: true }],
            },
        ],
    } as AiConfig;
}

async function fixture() {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    return {
        host,
        async render(element: React.ReactNode) {
            await act(async () => root.render(element));
        },
        async dispose() {
            await act(async () => root.unmount());
            host.remove();
        },
    };
}

test("visible count selection uses the same count in node config, generation and credits", async () => {
    const f = await fixture();
    const config = configWithProfile({ ...defaultImageCapabilityConfig(), maxOutputs: 4 });
    let node: CanvasNodeData = { id: "image", type: "image", title: "Image", position: { x: 0, y: 0 }, width: 320, height: 320, metadata: { model: config.model } };
    const render = () =>
        f.render(
            <CanvasImageCountControl
                config={buildNodeConfig(config, node, "image", { capability: "image" })}
                onChange={(count) => {
                    node = { ...node, metadata: { ...node.metadata, count } };
                }}
            />,
        );
    try {
        await render();
        const select = f.host.querySelector("select")!;
        expect([...select.options].map((option) => option.value)).toEqual(["1", "2", "3", "4"]);
        select.value = "3";
        await act(async () => select.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event));
        await render();
        expect(f.host.querySelector("select")!.value).toBe("3");
        const generated = buildGenerationConfig(config, node, "image");
        expect(generated.count).toBe("3");
        expect(requestCreditCost({ channelMode: "remote", modelCosts: config.channels[0].modelCosts, model: "image-model", capability: "image", config: generated, count: generated.count })).toBe(6);

        await f.render(<ImageSettingsPanel config={generated} theme={canvasThemes.dark} showCount={false} onConfigChange={() => {}} />);
        expect(f.host.textContent).not.toContain("生成张数");
        await f.render(<ImageSettingsPanel config={generated} theme={canvasThemes.dark} onConfigChange={() => {}} />);
        expect(f.host.textContent).toContain("生成张数");
    } finally {
        await f.dispose();
    }
});

test("native resolution clicks persist through the real settings panel, quote and task payload", async () => {
    const f = await fixture();
    const profile = defaultImageCapabilityConfig("wangsu-gemini-image", "gemini-nano-banana-2.1");
    const initial = { ...configWithProfile(profile), size: "1:1", quality: "auto", imageResolution: "1k" };
    const cost = initial.channels[0].modelCosts![0];
    Object.assign(cost, {
        protocol: "wangsu-gemini-image",
        logicalModelId: "logical-native-image",
        logicalCapabilitySpec: capabilitySpecFromChannelModel({ capability: "image", capabilityConfig: { version: 1, image: profile } } as Parameters<typeof capabilitySpecFromChannelModel>[0]),
        pricePolicy: "channel",
        logicalPriceTiers: [
            { selector: { quality: "1k" }, billingMode: "fixed_request", unitPriceMicrocredits: 1_000_000 },
            { selector: { quality: "4k" }, billingMode: "fixed_request", unitPriceMicrocredits: 4_000_000 },
        ],
    });
    let selected = initial;
    function Settings() {
        const [config, setConfig] = useState(initial);
        selected = config;
        return <ImageSettingsPanel config={config} theme={canvasThemes.dark} onConfigChange={(key, value) => setConfig((previous) => ({ ...previous, [key]: value }))} />;
    }
    const button = (label: string) => [...f.host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!;
    try {
        await f.render(<Settings />);
        expect(button("2K").disabled).toBe(true);
        expect(button("4K").disabled).toBe(false);
        await act(async () => button("4K").click());
        await act(async () => button("1:8").click());
        expect(selected).toMatchObject({ size: "1:8", imageResolution: "4k", quality: "auto" });
        expect(button("4K").getAttribute("aria-pressed")).toBe("true");
        expect(f.host.textContent).toContain("1:8 · 4K");
        expect(requestCreditCost({ channelMode: "remote", modelCosts: selected.channels[0].modelCosts, model: "image-model", capability: "image", config: selected, count: 1 })).toBe(4);
        const task = await prepareBackendGenerationTask({ mode: "image", prompt: "A quiet landscape", config: selected });
        const input = task.input as { config: Record<string, unknown>; capabilityOptions: Record<string, unknown> };
        expect(input.config.imageResolution).toBe("4k");
        expect(input.capabilityOptions).toMatchObject({ size: "1:8", imageResolution: "4k" });
        expect(input.capabilityOptions.quality).toBeUndefined();
    } finally {
        await f.dispose();
    }
});

test("native admin edits save ratios and resolution without creating pixel presets", async () => {
    const f = await fixture();
    const profile = defaultImageCapabilityConfig("wangsu-gemini-image", "gemini-nano-banana-2.1");
    profile.resolution.default = "4k";
    let saved: ModelCapabilityConfig = { version: 1, image: profile };
    function Editor() {
        const [value, setValue] = useState(saved);
        saved = value;
        return <ModelCapabilityEditor capability="image" protocol="wangsu-gemini-image" model="gemini-nano-banana-2.1" section="protocol" value={value} onChange={setValue} />;
    }
    const button = (label: string) => f.host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    try {
        await f.render(<Editor />);
        for (const ratio of ["1:4", "1:8", "4:1", "8:1"]) expect(button(`支持比例 ${ratio}`)).not.toBeNull();
        expect(f.host.querySelector(".image-size-preset-group")).toBeNull();
        expect(f.host.textContent).not.toContain("尺寸自动换算");
        await act(async () => button("支持比例 8:1").click());
        await act(async () => button("支持分辨率 4K").click());
        expect(saved.image?.size.values).toHaveLength(13);
        expect(saved.image?.resolution).toEqual({ supported: true, values: ["1k", "2k"], default: "1k" });
        const reopened = normalizeModelCapabilityConfig(JSON.parse(JSON.stringify(saved))).image!;
        expect(reopened.size.presets).toBeUndefined();
        expect(reopened.size.values).toContain("1:8");
        expect(reopened.size.values).not.toContain("8:1");
        expect(reopened.quality).toEqual({ supported: false, values: [], default: "auto" });
        await act(async () => button("支持比例 8:1").click());
        expect(saved.image?.size.values).toEqual(profile.size.values);
        await act(async () => button("支持分辨率 2K").click());
        expect(button("支持分辨率 1K").disabled).toBe(true);
    } finally {
        await f.dispose();
    }
});

test("count choices honor single-output models and declared enum or step constraints", async () => {
    const f = await fixture();
    try {
        for (const [profile, options] of [
            [defaultImageCapabilityConfig("km-kemei-seedream"), ["1"]],
            [{ ...defaultImageCapabilityConfig(), maxOutputs: 4, parameters: [{ name: "count", label: "数量", type: "integer", min: 1, max: 4, values: [1, 4], default: 1 }] }, ["1", "4"]],
            [{ ...defaultImageCapabilityConfig(), maxOutputs: 5, parameters: [{ name: "count", label: "数量", type: "integer", min: 1, max: 5, step: 2, default: 1 }] }, ["1", "3", "5"]],
            [{ ...defaultImageCapabilityConfig(), maxOutputs: 32, parameters: [{ name: "count", label: "数量", type: "integer", values: [1, 16, 32], default: 1 }] }, ["1", "16", "32"]],
        ] as [ImageCapabilityConfig, string[]][]) {
            await f.render(<CanvasImageCountControl config={{ ...configWithProfile(profile), count: "15" }} onChange={() => {}} />);
            const select = f.host.querySelector("select")!;
            expect([...select.options].map((option) => option.value)).toEqual(options);
            expect(select.disabled).toBe(options.length === 1);
            expect(options).toContain(select.value);
        }
    } finally {
        await f.dispose();
    }
});

test("empty freeform canvas directly offers Agent, creation and import actions", async () => {
    const f = await fixture();
    const calls: string[] = [];
    try {
        await f.render(<CanvasFreeformEmptyState commands={[{ id: "text", label: "文本", section: "node", icon: null, onClick: () => calls.push("text") }]} onOpenAgent={() => calls.push("agent")} onUpload={() => calls.push("upload")} />);
        const click = async (label: string) => {
            const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
            expect(button).toBeDefined();
            await act(async () => button!.click());
        };
        await click("交给 Agent");
        await click("导入素材");
        await click("直接创作");
        await click("文本");
        expect(calls).toEqual(["agent", "upload", "text"]);
        expect(f.host.textContent).not.toContain("空白画布");
        expect(f.host.querySelector('[aria-expanded="false"]')).not.toBeNull();
    } finally {
        await f.dispose();
    }
});

test("sidebar groups assets, skills and history at the bottom with active routes and feature gates", async () => {
    const f = await fixture();
    const before = useUserStore.getState();
    try {
        for (const enabled of [true, false]) {
            await act(async () => useUserStore.setState({ user: null, features: { ...defaultFeatureAvailability, taskCenterEnabled: enabled, imageWorkbenchEnabled: enabled, videoWorkbenchEnabled: enabled } }));
            await f.render(
                <MemoryRouter initialEntries={["/skills"]}>
                    <App>
                        <WorkspaceSidebarNav collapsed={false} onNavigate={() => {}} onOpenSearch={() => {}} onExpand={() => {}} onCollapse={() => {}} />
                    </App>
                </MemoryRouter>,
            );
            const groups = f.host.querySelectorAll('[data-nav-group-heading="资产与工具"]');
            expect(groups).toHaveLength(1);
            const group = groups[0];
            expect(group.classList.contains("mt-auto")).toBe(true);
            expect([...group.querySelectorAll("[data-nav-id]")].map((item) => item.getAttribute("data-nav-id"))).toEqual(enabled ? ["assets", "skills", "tasks"] : ["assets", "skills"]);
            expect(f.host.querySelector('[data-nav-group-heading="资源与工具"]')).toBeNull();
            expect(f.host.querySelector('[data-nav-group-heading="资产与历史"]')).toBeNull();
            expect(group.querySelector('[data-nav-id="skills"]')!.classList.contains("is-active")).toBe(true);
            expect(Boolean(f.host.querySelector('[data-nav-id="toolbox-image"]'))).toBe(enabled);
            expect(Boolean(f.host.querySelector('[data-nav-id="toolbox-video"]'))).toBe(enabled);
        }
    } finally {
        await f.dispose();
        useUserStore.setState(before);
    }
});
