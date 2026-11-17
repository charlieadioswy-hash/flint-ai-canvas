import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { CanvasNodeData } from "../../src/types/canvas";

const dom = new Window({ url: "http://localhost/" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    HTMLElement: dom.HTMLElement,
    Element: dom.Element,
    Node: dom.Node,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    MouseEvent: dom.MouseEvent,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act, useRef, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useCanvasSelectionController } = await import("../../src/pages/canvas/use-canvas-selection-controller");
const { CanvasNodeType } = await import("../../src/types/canvas");

afterAll(() => {
    dom.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

const noop = () => {};
function frame(id: string, x = 0): CanvasNodeData {
    return { id, type: CanvasNodeType.Frame, title: "分镜组", position: { x, y: 0 }, width: 500, height: 400, metadata: { frame: { collapsed: false, expandedWidth: 500, expandedHeight: 400 } } };
}
function image(id: string, x: number, parentId?: string, locked = false): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x, y: 100 }, width: 100, height: 80, parentId, metadata: { locked } };
}

async function fixture(initial: CanvasNodeData[], initiallySelected: string[] = []) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let latest = initial;
    const archived: Array<{ folderId: string; nodeIds: string[] }> = [];
    function Harness() {
        const [nodes, setNodes] = useState(initial);
        latest = nodes;
        const nodesRef = useRef(nodes);
        nodesRef.current = nodes;
        const containerRef = useRef<HTMLDivElement>(null);
        const viewportRef = useRef({ x: 0, y: 0, k: 1 });
        const [selected, setSelected] = useState(new Set(initiallySelected));
        const selectedNodeIdsRef = useRef(selected);
        selectedNodeIdsRef.current = selected;
        const historyPausedRef = useRef(false);
        const controller = useCanvasSelectionController({
            containerRef,
            nodesRef,
            viewportRef,
            selectedNodeIdsRef,
            historyPausedRef,
            screenToCanvas: (x, y) => ({ x, y }),
            setNodes,
            setSelectedNodeIds: setSelected,
            setSelectedConnectionId: noop,
            cancelPendingConnectionCreate: noop,
            onCanvasSelectionStart: noop,
            onNodeInteractionStart: noop,
            onNodeClick: noop,
            onDeselect: noop,
            onLinkedFolderDrop: (folder, nodes) => archived.push({ folderId: folder.id, nodeIds: nodes.map((node) => node.id) }),
        });
        return (
            <div ref={containerRef}>
                {nodes.map((node) => (
                    <div key={node.id} data-node-id={node.id} style={{ transform: `translate(${node.position.x}px, ${node.position.y}px)` }} onMouseDown={(event) => controller.handleNodeMouseDown(event, node.id)}>
                        {node.title}
                    </div>
                ))}
            </div>
        );
    }
    await act(async () => root.render(<Harness />));
    return {
        node: (id: string) => latest.find((node) => node.id === id)!,
        archived,
        async drag(id: string, dx: number, dy: number) {
            const element = host.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
            await act(async () => element.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 100, clientY: 100 }) as unknown as Event));
            await act(async () => window.dispatchEvent(new dom.MouseEvent("mousemove", { bubbles: true, clientX: 100 + dx, clientY: 100 + dy }) as unknown as Event));
            await act(async () => window.dispatchEvent(new dom.MouseEvent("mouseup", { bubbles: true, clientX: 100 + dx, clientY: 100 + dy }) as unknown as Event));
        },
        async dispose() {
            await act(async () => root.unmount());
            host.remove();
        },
    };
}

test("连续拖动分镜组始终携带所有子元素，锁定元素不能独立移动", async () => {
    const f = await fixture([frame("group"), image("child", 100, "group"), image("locked", 250, "group", true), image("loose", 300)]);
    try {
        await f.drag("group", 150, 120);
        expect(f.node("group").position).toEqual({ x: 150, y: 120 });
        expect(f.node("child").position).toEqual({ x: 250, y: 220 });
        expect(f.node("locked").position).toEqual({ x: 400, y: 220 });
        expect(f.node("child").parentId).toBe("group");
        expect(f.node("locked").parentId).toBe("group");
        expect(f.node("loose").position).toEqual({ x: 300, y: 100 });
        expect(f.node("loose").parentId).toBeUndefined();
        await f.drag("group", 30, 50);
        expect(f.node("group").position).toEqual({ x: 180, y: 170 });
        expect(f.node("child").position).toEqual({ x: 280, y: 270 });
        expect(f.node("locked").position).toEqual({ x: 430, y: 270 });
        await f.drag("locked", 100, 100);
        expect(f.node("locked").position).toEqual({ x: 430, y: 270 });
    } finally {
        await f.dispose();
    }
});

test("元素拖入加入，跨组切换，拖出移除；后续拖组只携带仍关联的元素", async () => {
    const f = await fixture([frame("a"), frame("b", 900), image("image", 600)]);
    try {
        await f.drag("image", -400, 0);
        expect(f.node("image").parentId).toBe("a");
        await f.drag("image", 800, 0);
        expect(f.node("image").parentId).toBe("b");
        await f.drag("image", 600, 0);
        expect(f.node("image").parentId).toBeUndefined();
        const position = { ...f.node("image").position };
        await f.drag("b", 50, 80);
        expect(f.node("image").position).toEqual(position);
    } finally {
        await f.dispose();
    }
});

test("同时移动属于不同组的多选元素，仍分别保留各自归属", async () => {
    const f = await fixture([frame("a"), frame("b", 900), image("first", 100, "a"), image("second", 1000, "b")], ["first", "second"]);
    try {
        await f.drag("first", 35, 50);
        expect(f.node("first").position).toEqual({ x: 135, y: 150 });
        expect(f.node("second").position).toEqual({ x: 1035, y: 150 });
        expect(f.node("first").parentId).toBe("a");
        expect(f.node("second").parentId).toBe("b");
    } finally {
        await f.dispose();
    }
});

test("多选移出部分成员后不扩张分镜组，后续拖组只带走留组成员", async () => {
    const f = await fixture([frame("group"), image("stay", 0, "group"), image("leave", 350, "group")], ["stay", "leave"]);
    try {
        await f.drag("stay", 200, 0);
        expect(f.node("group").width).toBe(500);
        expect(f.node("stay")).toMatchObject({ parentId: "group", position: { x: 200, y: 100 } });
        expect(f.node("leave").parentId).toBeUndefined();
        expect(f.node("leave").position).toEqual({ x: 550, y: 100 });
        await f.drag("group", 50, 30);
        expect(f.node("stay").position).toEqual({ x: 250, y: 130 });
        expect(f.node("leave").position).toEqual({ x: 550, y: 100 });
    } finally {
        await f.dispose();
    }
});
