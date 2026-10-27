import { afterAll, expect, test } from "bun:test";
import type { LiblibLoraSelection } from "../src/lib/canvas/liblib-lora";

if (process.env.LIBLIB_LORA_FIELDS_TEST_WORKER !== "1") {
    test("LoRA selector interaction", async () => {
        // AntD must load after the DOM, independently of other test files.
        const child = Bun.spawn([process.execPath, "test", import.meta.path], {
            env: { ...process.env, LIBLIB_LORA_FIELDS_TEST_WORKER: "1" },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        if (status !== 0) throw new Error(`${stdout}\n${stderr}`);
        expect(status).toBe(0);
    }, 30_000);
} else {
    const { Window } = await import("happy-dom");
    const dom = new Window({ url: "http://localhost/" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
        window: dom, document: dom.document, navigator: dom.navigator,
        HTMLElement: dom.HTMLElement, HTMLBodyElement: dom.HTMLBodyElement, HTMLHtmlElement: dom.HTMLHtmlElement, HTMLInputElement: dom.HTMLInputElement,
        Element: dom.Element, Node: dom.Node, SVGElement: dom.SVGElement, ShadowRoot: dom.ShadowRoot,
        Event: dom.Event, CustomEvent: dom.CustomEvent, MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
        getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
        IS_REACT_ACT_ENVIRONMENT: true,
    })) {
        originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const { act, useState } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ConfigProvider } = await import("antd");
    const { LiblibLoraFields } = await import("../src/components/liblib-lora-fields");

    afterAll(() => {
        dom.happyDOM.abort();
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    });

    test("adding a LoRA restores the selector placeholder while retaining its selected card", async () => {
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        let selections: LiblibLoraSelection[] = [];
        const modelId = "11111111111111111111111111111111";
        function Harness() {
            const [value, setValue] = useState<LiblibLoraSelection[]>([]);
            return <ConfigProvider virtual={false} theme={{ token: { motion: false } }}><LiblibLoraFields value={value} profile={{ supported: true, maxNetworks: 5, baseModel: "sdxl", models: [{ id: modelId, name: "屏幕风格", baseModel: "sdxl", defaultWeight: 0.6 }] }} onChange={(next) => { selections = next; setValue(next); }} /></ConfigProvider>;
        }
        try {
            await act(async () => root.render(<Harness />));
            const selector = host.querySelector<HTMLElement>("[aria-label='添加 LoRA']")!;
            expect(selector).not.toBeNull();
            await act(async () => selector.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true })));
            for (let attempt = 0; attempt < 100 && !document.querySelector(".ant-select-item-option"); attempt++) {
                await act(async () => { await Bun.sleep(10); });
            }
            const option = document.querySelector<HTMLElement>(".ant-select-item-option")!;
            expect(option?.textContent).toContain("屏幕风格");
            await act(async () => option.click());
            expect(selections).toEqual([{ modelId, weight: 0.6 }]);
            expect(host.querySelector("[aria-label='移除 LoRA 1']")).not.toBeNull();
            expect(host.querySelector(".ant-select-placeholder")?.textContent).toBe("选择 LoRA");
            expect(host.querySelector(".ant-select")?.textContent).toBe("选择 LoRA");
        } finally {
            await act(async () => root.unmount());
            host.remove();
        }
    });
}
