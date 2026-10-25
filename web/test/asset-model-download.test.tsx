import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import type { ModelAsset } from "@/stores/use-asset-store";

if (process.env.ASSET_MODEL_DOWNLOAD_TEST_WORKER !== "1") {
    test("asset model download UI integration", async () => {
        // Keep the file-saver mock and browser globals out of other test files.
        const child = Bun.spawn([process.execPath, "test", import.meta.path], {
            env: { ...process.env, ASSET_MODEL_DOWNLOAD_TEST_WORKER: "1" },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        if (status !== 0) throw new Error(`${stdout}\n${stderr}`);
        expect(status).toBe(0);
    }, 30_000);
} else {
    const { Window } = await import("happy-dom");
    const dom = new Window({ url: "http://localhost/assets" });
    const globals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
        window: dom,
        document: dom.document,
        navigator: dom.navigator,
        HTMLElement: dom.HTMLElement,
        HTMLBodyElement: dom.HTMLBodyElement,
        HTMLHtmlElement: dom.HTMLHtmlElement,
        HTMLInputElement: dom.HTMLInputElement,
        Element: dom.Element,
        Node: dom.Node,
        SVGElement: dom.SVGElement,
        ShadowRoot: dom.ShadowRoot,
        Event: dom.Event,
        CustomEvent: dom.CustomEvent,
        MutationObserver: dom.MutationObserver,
        ResizeObserver: dom.ResizeObserver,
        getComputedStyle: dom.getComputedStyle.bind(dom),
        requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
        cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
        IS_REACT_ACT_ENVIRONMENT: true,
    })) {
        globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const saved: Array<{ blob: Blob; fileName: string }> = [];
    mock.module("file-saver", () => ({ saveAs: (blob: Blob, fileName: string) => saved.push({ blob, fileName }) }));
    const { act, useState } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ConfigProvider } = await import("antd");
    const { AssetModelDownloadModal } = await import("@/pages/assets/asset-model-download-modal");
    const { useUserStore } = await import("@/stores/use-user-store");
    const originalUser = useUserStore.getState().user;
    const originalFetch = globalThis.fetch;
    const owner = { id: "download-owner", username: "download-owner", displayName: "Download owner", role: "user" as const, status: "active" as const };
    const anchors: Array<{ href: string; fileName: string }> = [];
    const anchorClick = spyOn(dom.HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
        anchors.push({ href: this.href, fileName: this.download });
    });
    const obj = "v -1 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
    const source = (): ModelAsset => ({
        id: "download-model",
        kind: "model",
        title: "robot",
        coverUrl: "",
        tags: ["3D"],
        createdAt: "2026-10-25T00:00:00Z",
        updatedAt: "2026-10-25T00:00:00Z",
        data: { url: `data:model/obj;base64,${Buffer.from(obj).toString("base64")}`, bytes: obj.length, mimeType: "model/obj", fileName: "robot.obj" },
    });
    let active: { dispose(): Promise<void> } | undefined;

    async function flush() {
        await act(async () => { await Bun.sleep(10); });
    }

    async function until(predicate: () => boolean) {
        for (let attempt = 0; attempt < 200; attempt++) {
            if (predicate()) return;
            await flush();
        }
        expect(predicate()).toBe(true);
    }

    async function fixture(asset = source()) {
        useUserStore.setState({ user: owner });
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        let closed = 0;
        let disposed = false;
        function Content({ asset }: { asset: ModelAsset }) {
            const [open, setOpen] = useState(true);
            return <ConfigProvider virtual={false} theme={{ token: { motion: false } }}>{open ? <AssetModelDownloadModal asset={asset} ownerId={owner.id} onClose={() => { closed++; setOpen(false); }} /> : null}</ConfigProvider>;
        }
        const render = async (next: ModelAsset) => { await act(async () => root.render(<Content asset={next} />)); };
        await render(asset);
        const button = (text: string) => {
            const result = [...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")].find((item) => item.textContent?.replace(/\s/g, "") === text.replace(/\s/g, ""));
            expect(result).toBeDefined();
            return result!;
        };
        const result = {
            asset,
            button,
            render,
            get closed() { return closed; },
            async click(text: string) { await act(async () => button(text).click()); },
            async choose(label: string) {
                const select = document.querySelector<HTMLElement>("[aria-label='模型下载格式']")!;
                expect(select).not.toBeNull();
                await act(async () => select.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true })));
                await until(() => document.querySelectorAll(".ant-select-item-option").length > 0);
                const option = [...document.querySelectorAll<HTMLElement>(".ant-select-item-option")].find((item) => item.textContent?.startsWith(label));
                expect(option).toBeDefined();
                await act(async () => option!.click());
            },
            async dispose() {
                if (disposed) return;
                disposed = true;
                await act(async () => root.unmount());
                host.remove();
            },
        };
        active = result;
        return result;
    }

    function pendingRead() {
        let resolve!: (response: Response) => void;
        const response = new Promise<Response>((done) => { resolve = done; });
        const signals: AbortSignal[] = [];
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            signals.push(init!.signal!);
            return response;
        }) as typeof fetch;
        return { signals, resolve };
    }

    afterEach(async () => {
        await active?.dispose();
        active = undefined;
        globalThis.fetch = originalFetch;
        saved.length = 0;
        anchors.length = 0;
    });
    afterAll(() => {
        anchorClick.mockRestore();
        useUserStore.setState({ user: originalUser });
        dom.happyDOM.abort();
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    });

    test.each(["original", "same format"])("%s downloads the source directly without reading or converting it", async (selection) => {
        const f = await fixture();
        let reads = 0;
        globalThis.fetch = (async () => { reads++; throw new Error("unexpected model read"); }) as typeof fetch;
        expect(document.querySelector("[role='dialog']")?.textContent).toContain("下载模型");
        if (selection === "same format") await f.choose("OBJ");
        await f.click("下载");
        await until(() => anchors.length === 1);
        expect(anchors).toEqual([{ href: f.asset.data.url, fileName: "robot.obj" }]);
        expect(reads).toBe(0);
        expect(saved).toEqual([]);
    });

    test("OBJ to STL uses the real browser converter and leaves the stored asset unchanged", async () => {
        const f = await fixture();
        const before = JSON.stringify(f.asset);
        await f.choose("STL");
        await f.click("下载");
        await until(() => saved.length === 1);
        expect(saved[0].fileName).toBe("robot.stl");
        expect(saved[0].blob.type).toBe("model/stl");
        expect(saved[0].blob.size).toBeGreaterThan(84);
        expect(anchors).toEqual([]);
        expect(JSON.stringify(f.asset)).toBe(before);
    });

    test("unknown source formats keep the original download and disable conversion choices", async () => {
        const asset = source();
        asset.data = { ...asset.data, fileName: "robot.usdz", mimeType: "model/vnd.usdz+zip", url: "data:application/octet-stream;base64,AA==" };
        const f = await fixture(asset);
        await f.choose("原文件");
        await act(async () => document.querySelector<HTMLElement>("[aria-label='模型下载格式']")!.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true })));
        await until(() => document.querySelectorAll(".ant-select-item-option").length === 5);
        expect(document.querySelectorAll(".ant-select-item-option-disabled")).toHaveLength(4);
        expect(document.querySelector("[role='dialog']")?.textContent).toContain("此格式暂不支持转换");
        await f.click("下载");
        await until(() => anchors.length === 1);
        expect(anchors[0].fileName).toBe("robot.usdz");
        expect(saved).toEqual([]);
    });

    test.each(["cancel", "close icon", "unmount", "replace asset", "switch account"])("%s aborts an unfinished conversion and prevents a late save", async (action) => {
        const f = await fixture();
        const pending = pendingRead();
        await f.choose("STL");
        await f.click("下载");
        await until(() => pending.signals.length === 1);
        expect(document.querySelector("[role='dialog']")?.textContent).toContain("正在转换…");
        if (action === "cancel") { await f.click("取消"); expect(f.closed).toBe(1); }
        else if (action === "close icon") {
            const close = document.querySelector<HTMLButtonElement>(".ant-modal-close");
            expect(close).not.toBeNull();
            await act(async () => close!.click());
            expect(f.closed).toBe(1);
        }
        else if (action === "unmount") await f.dispose();
        else if (action === "replace asset") await f.render({ ...source(), id: "another-model", title: "another" });
        else await act(async () => {
            useUserStore.setState({ user: { ...owner, id: "another-owner" } });
            useUserStore.setState({ user: owner });
        });
        expect(pending.signals[0].aborted).toBe(true);
        pending.resolve(new Response(obj));
        await flush();
        expect(saved).toEqual([]);
        expect(anchors).toEqual([]);
        expect(document.querySelector("[role='alert']")).toBeNull();
    });

    test("two immediate download clicks start only one conversion", async () => {
        const f = await fixture();
        const pending = pendingRead();
        await f.choose("STL");
        const button = f.button("下载");
        await act(async () => { button.click(); button.click(); });
        await until(() => pending.signals.length > 0);
        expect(pending.signals).toHaveLength(1);
        pending.resolve(new Response(obj));
        await until(() => saved.length === 1);
        expect(pending.signals).toHaveLength(1);
    });

    test("a failed conversion reports the error and can retry successfully", async () => {
        const f = await fixture();
        let reads = 0;
        globalThis.fetch = (async () => ++reads === 1 ? new Response("missing", { status: 404 }) : new Response(obj)) as typeof fetch;
        await f.choose("STL");
        await f.click("下载");
        await until(() => document.querySelector("[role='alert']") !== null);
        expect(document.querySelector("[role='alert']")?.textContent).toContain("模型读取失败");
        expect(saved).toEqual([]);
        await f.click("下载");
        await until(() => saved.length === 1);
        expect(reads).toBe(2);
        expect(document.querySelector("[role='alert']")).toBeNull();
    });
}
