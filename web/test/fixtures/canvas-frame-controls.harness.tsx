import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { CanvasNodeData, CanvasFrameColor } from "../../src/types/canvas";
import type { CanvasNodeRenderLOD } from "../../src/lib/canvas/canvas-node-lod";

const dom = new Window({ url: "http://localhost/" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    localStorage: dom.localStorage,
    HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement,
    Element: dom.Element,
    Node: dom.Node,
    SVGElement: dom.SVGElement,
    ShadowRoot: dom.ShadowRoot,
    MutationObserver: dom.MutationObserver,
    ResizeObserver: dom.ResizeObserver,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
// 仅隔离云端编辑租约，组件、编辑器 hook 与状态更新均使用真实实现。
const leaseInputs: string[] = [];
mock.module("@/services/canvas-edit-leases", () => ({
    canvasEditLeases: {
        input: (canvasId: string, nodeId: string) => {
            leaseInputs.push(`${canvasId}:${nodeId}`);
            return true;
        },
    },
}));
const { act, useRef, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { App, ConfigProvider } = await import("antd");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CanvasFrameNode } = await import("../../src/components/canvas/canvas-frame-node");
const { useCanvasNodeEditor } = await import("../../src/pages/canvas/use-canvas-node-editor");
const { useConfigStore } = await import("../../src/stores/use-config-store");
const { CanvasNodeType } = await import("../../src/types/canvas");

afterAll(() => {
    dom.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

const noop = () => {};
function frame(locked = false): CanvasNodeData {
    return {
        id: "group",
        type: CanvasNodeType.Frame,
        title: "新房初见",
        position: { x: 30, y: 40 },
        width: 600,
        height: 420,
        metadata: { locked, workflowKind: "storyboard", frame: { collapsed: false, expandedWidth: 600, expandedHeight: 420, color: "blue" } },
    };
}

async function componentFixture(options: { locked?: boolean; readOnly?: boolean; renderLOD?: CanvasNodeRenderLOD } = {}) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const titles: Array<[string, string]> = [];
    const colors: Array<[string, CanvasFrameColor | undefined]> = [];
    let drags = 0;
    await act(async () =>
        root.render(
            <CanvasFrameNode
                data={frame(options.locked)}
                childNodes={[]}
                scale={1}
                isSelected
                isDropTarget={false}
                readOnly={options.readOnly}
                renderLOD={options.renderLOD}
                onMouseDown={() => drags++}
                onResize={noop}
                onToggleCollapsed={noop}
                onFolderStyleChange={noop}
                onTitleChange={(...args) => titles.push(args)}
                onFrameColorChange={(...args) => colors.push(args)}
                onContextMenu={noop}
            />,
        ),
    );
    return {
        host,
        titles,
        colors,
        drags: () => drags,
        async dispose() {
            await act(async () => root.unmount());
            host.remove();
        },
    };
}

test("头部名称单击编辑，Enter只提交一次，Escape取消且不触发分镜组拖动", async () => {
    const f = await componentFixture();
    try {
        const title = f.host.querySelector<HTMLButtonElement>('[aria-label="编辑分镜组名称：新房初见"]')!;
        expect(title.closest(".canvas-frame-header")).not.toBeNull();
        await act(async () => title.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, button: 0 }) as unknown as Event));
        await act(async () => title.click());
        const input = f.host.querySelector<HTMLInputElement>('[aria-label="分镜组名称"]')!;
        expect(input).not.toBeNull();
        await act(async () => {
            Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, "  搬家第一天  ");
            input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
        });
        await act(async () => input.dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }) as unknown as Event));
        expect(f.titles).toEqual([["group", "搬家第一天"]]);
        expect(f.host.querySelector("input")).toBeNull();
        await act(async () => f.host.querySelector<HTMLButtonElement>('[aria-label="编辑分镜组名称：新房初见"]')!.click());
        const cancelledInput = f.host.querySelector<HTMLInputElement>('[aria-label="分镜组名称"]')!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(cancelledInput, "不应保存的名称");
            cancelledInput.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
        });
        await act(async () => cancelledInput.dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }) as unknown as Event));
        await act(async () => cancelledInput.blur());
        expect(f.host.querySelector("input")).toBeNull();
        expect(f.titles).toEqual([["group", "搬家第一天"]]);
        expect(f.drags()).toBe(0);
    } finally {
        await f.dispose();
    }
});

test("底部提供默认和七种底色，选择只更新颜色而不启动画布拖动", async () => {
    const f = await componentFixture();
    try {
        const picker = f.host.querySelector<HTMLElement>('[aria-label="分镜组底色"]')!;
        expect(picker.classList.contains("top-full")).toBe(true);
        const buttons = [...picker.querySelectorAll<HTMLButtonElement>("button")];
        expect(buttons).toHaveLength(8);
        expect(buttons[1].getAttribute("aria-pressed")).toBe("true");
        for (const button of buttons) {
            await act(async () => button.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, button: 0 }) as unknown as Event));
            await act(async () => button.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }) as unknown as Event));
            await act(async () => button.click());
        }
        expect(f.colors).toEqual([undefined, "blue", "green", "violet", "amber", "rose", "teal", "slate"].map((color) => ["group", color]));
        expect(f.drags()).toBe(0);
    } finally {
        await f.dispose();
    }
});

test("锁定与只读分镜组不允许改名或选择底色", async () => {
    for (const options of [{ locked: true }, { readOnly: true }]) {
        const f = await componentFixture(options);
        try {
            expect(f.host.querySelector('[aria-label="分镜组底色"]')).toBeNull();
            expect(f.host.querySelector('[aria-label^="编辑分镜组名称"]')).toBeNull();
            await act(async () => f.host.querySelector<HTMLButtonElement>('button[title="新房初见"]')!.click());
            expect(f.host.querySelector("input")).toBeNull();
            expect(f.titles).toEqual([]);
            expect(f.colors).toEqual([]);
        } finally {
            await f.dispose();
        }
    }
});

test("低精度预览与壳层仍将名称留在头部", async () => {
    for (const renderLOD of ["preview", "shell"] as const) {
        const f = await componentFixture({ renderLOD });
        try {
            const title = f.host.querySelector<HTMLElement>('[title="新房初见"]')!;
            const header = title.closest(".canvas-frame-header")!;
            expect(header).not.toBeNull();
            expect(header.classList.contains("top-0")).toBe(true);
            expect(f.host.querySelector("[data-node-lod]")?.getAttribute("data-node-lod")).toBe(renderLOD);
        } finally {
            await f.dispose();
        }
    }
});

test("真实编辑器将底色写入节点，缩放折叠后保留，默认色可序列化清除", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const queryClient = new QueryClient();
    let latest: CanvasNodeData[] = [];
    let editor: ReturnType<typeof useCanvasNodeEditor>;
    function Harness() {
        const [nodes, setNodes] = useState([frame(), { ...frame(true), id: "locked" }]);
        latest = nodes;
        const nodesRef = useRef(nodes);
        nodesRef.current = nodes;
        editor = useCanvasNodeEditor({
            config: useConfigStore.getState().config,
            canvasId: "canvas",
            canvasTitle: "测试",
            nodesRef,
            setNodes,
            setSelectedNodeIds: noop,
            setSelectedConnectionId: noop,
            setDialogNodeId: noop,
            setToolbarNodeId: noop,
            setHoveredNodeId: noop,
        });
        return null;
    }
    try {
        await act(async () =>
            root.render(
                <QueryClientProvider client={queryClient}>
                    <ConfigProvider theme={{ token: { motion: false } }}>
                        <App>
                            <Harness />
                        </App>
                    </ConfigProvider>
                </QueryClientProvider>,
            ),
        );
        await act(async () => editor!.handleFrameColorChange("group", "rose"));
        expect(latest[0].metadata?.frame?.color).toBe("rose");
        await act(async () => editor!.handleNodeResize("group", 720, 520));
        expect(latest[0].metadata?.frame).toMatchObject({ color: "rose", collapsed: false, expandedWidth: 720, expandedHeight: 520 });
        await act(async () => editor!.toggleFrameCollapsed("group"));
        expect(latest[0].metadata?.frame).toMatchObject({ color: "rose", collapsed: true });
        await act(async () => editor!.toggleFrameCollapsed("group"));
        expect(latest[0]).toMatchObject({ width: 720, height: 520, metadata: { frame: { color: "rose", collapsed: false } } });
        await act(async () => editor!.handleFrameColorChange("group", undefined));
        expect(latest[0].metadata?.frame?.color).toBeUndefined();
        const reloaded = JSON.parse(JSON.stringify(latest)) as CanvasNodeData[];
        expect(Object.hasOwn(reloaded[0].metadata!.frame!, "color")).toBe(false);
        expect(reloaded[0].metadata?.frame).toMatchObject({ collapsed: false, expandedWidth: 720, expandedHeight: 520 });
        await act(async () => editor!.handleFrameColorChange("locked", "green"));
        expect(latest[1].metadata?.frame?.color).toBe("blue");
        expect(leaseInputs.filter((value) => value === "canvas:group")).toHaveLength(2);
        expect(leaseInputs).not.toContain("canvas:locked");
    } finally {
        await act(async () => root.unmount());
        queryClient.clear();
        host.remove();
    }
});
