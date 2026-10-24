import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";

const dom = new Window({ url: "http://localhost/" });
// happy-dom rejects native animation cancellation promises during unmount.
// Use Motion's normal JavaScript fallback for this DOM interaction regression.
Object.defineProperty(dom.Element.prototype, "animate", { configurable: true, value: undefined });
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
    ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const { act, useLayoutEffect } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CanvasToolbar } = await import("../src/components/canvas/canvas-toolbar");
const { CanvasOverlayLayerProvider, useCanvasOverlayLayer } = await import("../src/components/canvas/canvas-overlay-layer");
const { canvasAppearanceForTheme } = await import("../src/lib/canvas/canvas-appearance");

afterAll(() => {
    dom.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

const css = readFileSync(new URL("../src/styles/globals.css", import.meta.url), "utf8");
function layer(value: string) {
    const token = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
    const number = token ? css.match(new RegExp(`${token}:\\s*(\\d+)`))?.[1] : value;
    if (!number) throw new Error(`Unknown layer ${value}`);
    return Number(number);
}

// Exercise the real toolbar, menu and overlay provider. This companion uses the
// same layer and focus handlers as the selected node panel, without canvas I/O.
function SelectedComposer() {
    const { bringToFront, zIndex } = useCanvasOverlayLayer("node-panel:video", "var(--z-modal-overlay)");
    useLayoutEffect(bringToFront, [bringToFront]);
    return <div data-test-composer style={{ position: "absolute", zIndex }} onFocusCapture={bringToFront}><button>视频参数</button></div>;
}

async function fixture() {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const noop = () => {};
    let created = 0;
    await act(async () => root.render(
        <CanvasOverlayLayerProvider>
            <CanvasToolbar
                selectedCount={1} workspaceMode="professional" canvasTool="box-select" onToolChange={noop}
                isProjectLinked={false} canUndo={false} canRedo={false}
                appearance={canvasAppearanceForTheme("dark")} backgroundMode="dots" showImageInfo
                onAddImage={noop} onAddVideo={() => created++} onAddAudio={noop} onAddText={noop} onChooseStyle={noop}
                onAddScript={noop} onAddFrame={noop} onAddFolder={noop} onAddDrawing={noop} onAddExtensionNode={noop}
                onAddWorkflow={noop} onOpenPrevis={noop} onUndo={noop} onRedo={noop} onUpload={noop} onDelete={noop}
                onClear={noop} onDeselect={noop} onAppearanceChange={noop} onSaveAppearanceDefault={noop}
                onBackgroundModeChange={noop} onShowImageInfoChange={noop} onOpenMyAssets={noop} onOpenProjectCharacters={noop}
            />
            <SelectedComposer />
        </CanvasOverlayLayerProvider>,
    ));
    const button = (label: string) => {
        const found = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.getAttribute("aria-label") === label || item.title === label || item.textContent?.trim() === label);
        if (!found) throw new Error(`Missing button ${label}`);
        return found;
    };
    const toolbar = host.querySelector<HTMLDivElement>("[data-canvas-no-zoom]")!;
    const composer = host.querySelector<HTMLDivElement>("[data-test-composer]")!;
    return {
        button, toolbar, composer,
        get created() { return created; },
        get addOpen() { return button("添加节点").getAttribute("aria-expanded") === "true"; },
        async click(label: string) { await act(async () => button(label).click()); },
        async focus(label: string) { await act(async () => button(label).focus()); },
        async dispose() { await act(async () => root.unmount()); host.remove(); },
    };
}

test.each([true, false])("focus entering the selected composer dismisses the add menu (trigger focused: %s)", async (focusTrigger) => {
    const f = await fixture();
    try {
        expect(layer(f.toolbar.style.zIndex)).toBeLessThan(layer(f.composer.style.zIndex));
        if (focusTrigger) await f.focus("添加节点");
        await f.click("添加节点");
        expect(f.addOpen).toBe(true);
        expect(layer(f.toolbar.style.zIndex)).toBeGreaterThan(layer(f.composer.style.zIndex));
        await f.focus("视频参数");
        expect(document.activeElement).toBe(f.button("视频参数"));
        expect(f.addOpen).toBe(false);
        expect(layer(f.toolbar.style.zIndex)).toBeLessThan(layer(f.composer.style.zIndex));
        expect(f.created).toBe(0);
    } finally {
        await f.dispose();
    }
});

test("focus can move between the add menu and dock before selecting a node once", async () => {
    const f = await fixture();
    try {
        await f.click("添加节点");
        await f.focus("视频");
        expect(f.addOpen).toBe(true);
        await f.focus("添加节点");
        expect(f.addOpen).toBe(true);
        await f.focus("视频");
        await f.click("视频");
        expect(f.created).toBe(1);
        expect(f.addOpen).toBe(false);
    } finally {
        await f.dispose();
    }
});

test("the add menu still closes on toggle and outside pointerdown", async () => {
    const f = await fixture();
    try {
        await f.click("添加节点");
        expect(f.addOpen).toBe(true);
        await f.click("添加节点");
        expect(f.addOpen).toBe(false);
        await f.click("添加节点");
        await act(async () => document.body.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true }) as unknown as Event));
        expect(f.addOpen).toBe(false);
        expect(f.created).toBe(0);
    } finally {
        await f.dispose();
    }
});
