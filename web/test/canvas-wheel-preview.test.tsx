import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ViewportTransform } from "../src/types/canvas";
import { zoomImagePreviewAt } from "../src/lib/canvas/canvas-image-preview";

const dom = new Window({ url: "http://localhost/" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
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
const { act, createRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CanvasViewport } = await import("../src/components/canvas/canvas-viewport");
const { CanvasImagePreview } = await import("../src/components/canvas/canvas-image-preview");

afterAll(() => {
    dom.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

async function fixture() {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const containerRef = createRef<HTMLDivElement>();
    const previews: ViewportTransform[] = [];
    const commits: ViewportTransform[] = [];
    let backgroundPointers = 0;
    let backgroundWheels = 0;
    const onPreview = (next: ViewportTransform) => previews.push(next);
    const onCommit = (next: ViewportTransform) => commits.push(next);
    const render = async (src?: string) => {
        await act(async () =>
            root.render(
                <div onPointerDown={() => backgroundPointers++} onWheel={() => backgroundWheels++}>
                    <CanvasViewport containerRef={containerRef} viewport={{ x: 0, y: 0, k: 1 }} onViewportChange={onCommit} onViewportPreviewChange={onPreview}>
                        <div data-node-id="selected-image">
                            <img width="300" height="200" />
                        </div>
                        <CanvasImagePreview src={src} onClose={() => void render()} />
                    </CanvasViewport>
                </div>,
            ),
        );
    };
    await render();
    return {
        host,
        render,
        container: containerRef.current!,
        previews,
        commits,
        backgroundEvents: () => ({ pointers: backgroundPointers, wheels: backgroundWheels }),
        async dispose() {
            await act(async () => root.unmount());
            host.remove();
        },
    };
}

async function wheel(target: Element, init: WheelEventInit) {
    const event = new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 200, clientY: 100, ...init });
    // happy-dom WheelEvent extends UIEvent and omits the browser's MouseEvent fields.
    Object.assign(event, { clientX: 200, clientY: 100, ctrlKey: false, metaKey: false, shiftKey: false, ...init });
    await act(async () => target.dispatchEvent(event as unknown as Event));
    return event;
}

test("ordinary wheels pan at native scales; touchpad axes and Shift horizontal pan are preserved", async () => {
    const f = await fixture();
    try {
        await wheel(f.container, { deltaY: 100 });
        expect(f.previews.at(-1)).toEqual({ x: 0, y: -100, k: 1 });
        await wheel(f.container, { deltaY: 125 });
        expect(f.previews.at(-1)).toEqual({ x: 0, y: -225, k: 1 });
        await wheel(f.container, { deltaY: 3, deltaMode: 1 });
        expect(f.previews.at(-1)).toEqual({ x: 0, y: -273, k: 1 });
        await wheel(f.container, { deltaX: 12.5, deltaY: 4 });
        expect(f.previews.at(-1)).toEqual({ x: -12.5, y: -277, k: 1 });
        await wheel(f.container, { deltaY: 100, shiftKey: true });
        expect(f.previews.at(-1)).toEqual({ x: -112.5, y: -277, k: 1 });
        await act(async () => new Promise((resolve) => setTimeout(resolve, 140)));
        expect(f.commits).toEqual([{ x: -112.5, y: -277, k: 1 }]);
    } finally {
        await f.dispose();
    }
});

test("Ctrl, Cmd and touchpad pinch zoom around the pointer without resizing selected image nodes", async () => {
    for (const init of [
        { ctrlKey: true, deltaY: -100 },
        { metaKey: true, deltaY: -100 },
        { ctrlKey: true, deltaY: -4 },
    ]) {
        const f = await fixture();
        try {
            window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Control" }) as unknown as Event);
            const selected = f.container.querySelector("[data-node-id] img")!;
            const event = await wheel(selected, init);
            const next = f.previews.at(-1)!;
            expect(event.defaultPrevented).toBe(true);
            expect(next.k).toBeGreaterThan(1);
            expect((200 - next.x) / next.k).toBeCloseTo(200);
            expect((100 - next.y) / next.k).toBeCloseTo(100);
            expect(selected.getAttribute("width")).toBe("300");
            expect(selected.getAttribute("height")).toBe("200");
        } finally {
            await f.dispose();
        }
    }
});

test("inputs, scroll areas and floating panels keep vertical scrolling and never zoom the background", async () => {
    const f = await fixture();
    try {
        for (const markup of [
            "<input />",
            "<textarea></textarea>",
            "<div contenteditable='true'></div>",
            "<div data-canvas-wheel-scroll><span></span></div>",
            "<div data-canvas-no-zoom><span></span></div>",
            ...["ant-modal", "ant-popover", "ant-dropdown", "ant-select-dropdown", "ant-picker-dropdown"].map((name) => `<div class='${name}'><span></span></div>`),
        ]) {
            const region = document.createElement("div");
            region.innerHTML = markup;
            f.container.append(region);
            const target = region.querySelector("span") ?? region.firstElementChild!;
            expect((await wheel(target, { deltaY: 100 })).defaultPrevented).toBe(false);
            expect((await wheel(target, { deltaY: -100, ctrlKey: true })).defaultPrevented).toBe(true);
            expect(f.previews).toEqual([]);
            region.remove();
        }
    } finally {
        await f.dispose();
    }
});

test("horizontal lists retain native scrolling until their boundary without moving the canvas", async () => {
    const f = await fixture();
    try {
        const list = document.createElement("div");
        list.dataset.canvasWheelScroll = "true";
        list.style.overflowX = "auto";
        Object.defineProperties(list, { scrollWidth: { value: 500 }, clientWidth: { value: 200 } });
        const item = document.createElement("span");
        list.append(item);
        f.container.append(list);
        list.scrollLeft = 0;
        expect((await wheel(item, { deltaX: 30 })).defaultPrevented).toBe(false);
        expect((await wheel(item, { deltaX: -30 })).defaultPrevented).toBe(true);
        list.scrollLeft = 150;
        expect((await wheel(item, { deltaX: -30 })).defaultPrevented).toBe(false);
        expect((await wheel(item, { deltaY: 100, shiftKey: true })).defaultPrevented).toBe(false);
        list.scrollLeft = 300;
        expect((await wheel(item, { deltaX: 30 })).defaultPrevented).toBe(true);
        expect((await wheel(item, { deltaY: 100 })).defaultPrevented).toBe(false);
        expect(f.previews).toEqual([]);
    } finally {
        await f.dispose();
    }
});

const imageSrc = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4000' height='8000'/%3E";

test("image preview zooms, drags, restores fit, resets on reopen/source change and isolates background events", async () => {
    const f = await fixture();
    const image = () => document.querySelector<HTMLImageElement>(".canvas-image-preview-modal img")!;
    const stage = () => document.querySelector<HTMLDivElement>("[aria-label='图片预览，滚轮缩放，拖动查看']")!;
    const loaded = async () => act(async () => image().dispatchEvent(new dom.Event("load") as unknown as Event));
    try {
        await f.render(imageSrc);
        await loaded();
        expect(image().style.transform).toBe("translate(0px, 0px) scale(1)");
        expect(image().classList.contains("object-contain")).toBe(true);
        const event = await wheel(stage(), { deltaY: -100, ctrlKey: true });
        expect(event.defaultPrevented).toBe(true);
        expect(image().style.transform).not.toBe("translate(0px, 0px) scale(1)");
        const beforeDrag = image().style.transform;
        const captures = new Set<number>();
        stage().setPointerCapture = (id) => {
            captures.add(id);
        };
        stage().hasPointerCapture = (id) => captures.has(id);
        stage().releasePointerCapture = (id) => {
            captures.delete(id);
        };
        const pointer = async (type: string, x: number, y: number) => act(async () => stage().dispatchEvent(new dom.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: x, clientY: y }) as unknown as Event));
        await pointer("pointerdown", 10, 20);
        await wheel(stage(), { deltaY: -100 });
        const zoomDuringDrag = image().style.transform.match(/scale\((.+)\)/)![1];
        await pointer("pointermove", 50, 80);
        expect(image().style.transform).not.toBe(beforeDrag);
        expect(image().style.transform).toContain(`scale(${zoomDuringDrag})`);
        await pointer("pointercancel", 50, 80);
        expect(captures.size).toBe(0);
        const afterDrag = image().style.transform;
        await pointer("pointermove", 100, 180);
        expect(image().style.transform).toBe(afterDrag);
        expect(f.backgroundEvents()).toEqual({ pointers: 0, wheels: 0 });
        expect(f.previews).toEqual([]);
        await act(async () =>
            Array.from(document.querySelectorAll("button"))
                .find((button) => button.textContent === "适应窗口")!
                .click(),
        );
        expect(image().style.transform).toBe("translate(0px, 0px) scale(1)");
        await wheel(stage(), { deltaY: -120 });
        await f.render(imageSrc.replace("4000", "8000"));
        await loaded();
        expect(image().style.transform).toBe("translate(0px, 0px) scale(1)");
        await act(async () => document.querySelector<HTMLButtonElement>("[aria-label='放大图片']")!.click());
        expect(image().style.transform).not.toBe("translate(0px, 0px) scale(1)");
        await act(async () => stage().dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, key: "0" }) as unknown as Event));
        expect(image().style.transform).toBe("translate(0px, 0px) scale(1)");
        await wheel(stage(), { deltaY: -120 });
        await f.render();
        await f.render(imageSrc.replace("4000", "8000"));
        await loaded();
        expect(image().style.transform).toBe("translate(0px, 0px) scale(1)");
        await act(async () => stage().dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, key: "Escape", keyCode: 27 }) as unknown as Event));
        expect(image()).toBeNull();
    } finally {
        await f.dispose();
    }
});

test("preview zoom keeps the pointed image position anchored and remains within limits", () => {
    const initial = { x: 30, y: -50, k: 2 };
    const point = { x: 160, y: 110 };
    const next = zoomImagePreviewAt(initial, point, -100);
    expect((point.x - next.x) / next.k).toBeCloseTo((point.x - initial.x) / initial.k);
    expect((point.y - next.y) / next.k).toBeCloseTo((point.y - initial.y) / initial.k);
    let current = next;
    for (let i = 0; i < 100; i++) current = zoomImagePreviewAt(current, point, -240);
    expect(current.k).toBe(8);
    for (let i = 0; i < 100; i++) current = zoomImagePreviewAt(current, point, 240);
    expect(current.k).toBe(0.25);
    expect(zoomImagePreviewAt(current, point, NaN)).toBe(current);
});
