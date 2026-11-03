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
        ProgressEvent: dom.ProgressEvent,
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
    const { Model3DNodeContent } = await import("@/components/canvas/nodes/model3d-node");
    const { CanvasModel3DContext } = await import("@/components/canvas/canvas-model3d-context");
    const { canvasThemes } = await import("@/lib/canvas-theme");
    const { createDefaultModel3DState } = await import("@/lib/canvas/model3d");
    const { CanvasNodeType } = await import("@/types/canvas");
    const { useUserStore } = await import("@/stores/use-user-store");
    const { http } = await import("@/services/api/request");
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
        await act(async () => {
            await Bun.sleep(10);
        });
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
            return (
                <ConfigProvider virtual={false} theme={{ token: { motion: false } }}>
                    {open ? (
                        <AssetModelDownloadModal
                            asset={asset}
                            ownerId={owner.id}
                            onClose={() => {
                                closed++;
                                setOpen(false);
                            }}
                        />
                    ) : null}
                </ConfigProvider>
            );
        }
        const render = async (next: ModelAsset) => {
            await act(async () => root.render(<Content asset={next} />));
        };
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
            get closed() {
                return closed;
            },
            async click(text: string) {
                await act(async () => button(text).click());
            },
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
        const response = new Promise<Response>((done) => {
            resolve = done;
        });
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
        globalThis.fetch = (async () => {
            reads++;
            throw new Error("unexpected model read");
        }) as typeof fetch;
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

    test("choosing FBX for an existing FBX downloads the original even when the converter is unavailable", async () => {
        const asset = source();
        asset.data = { ...asset.data, fileName: "robot.fbx", mimeType: "application/vnd.autodesk.fbx", url: "data:application/octet-stream;base64,AA==" };
        const get = spyOn(http, "get").mockRejectedValue(new Error("converter unavailable"));
        const post = spyOn(http, "post").mockRejectedValue(new Error("unexpected conversion"));
        try {
            const f = await fixture(asset);
            await f.choose("FBX");
            await f.click("下载");
            await until(() => anchors.length === 1);
            expect(anchors[0].fileName).toBe("robot.fbx");
            expect(get).not.toHaveBeenCalled();
            expect(post).not.toHaveBeenCalled();
        } finally {
            get.mockRestore();
            post.mockRestore();
        }
    });

    test.each(["glb", "fbx"] as const)("canvas %s download opens the shared export menu and keeps native download available", async (format) => {
        useUserStore.setState({ user: owner });
        const state = createDefaultModel3DState("h3.1");
        state.result = { assetId: "asset", resourceId: "", storageKey: "", url: "data:application/octet-stream;base64,AA==", fileName: `robot.${format}`, mimeType: "application/octet-stream", bytes: 1, format };
        const node = { id: "canvas-model", title: "robot", type: CanvasNodeType.Model3D, width: 520, height: 420, position: { x: 0, y: 0 }, metadata: { model3d: state } };
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        const get = spyOn(http, "get").mockRejectedValue(new Error("converter unavailable"));
        const post = spyOn(http, "post").mockRejectedValue(new Error("unexpected conversion"));
        try {
            await act(async () =>
                root.render(
                    <ConfigProvider virtual={false} theme={{ token: { motion: false } }}>
                        <CanvasModel3DContext.Provider value={{ capabilities: null, nodes: [node], inputNodes: () => [], generate: async () => {}, refreshTask: async () => {}, openParameters: () => {} }}>
                            <Model3DNodeContent node={node} theme={canvasThemes.light} />
                        </CanvasModel3DContext.Provider>
                    </ConfigProvider>,
                ),
            );
            const trigger = [...host.querySelectorAll("button")].find((button) => button.textContent?.replace(/\s/g, "") === "导出模型");
            expect(trigger).toBeDefined();
            await act(async () => trigger!.click());
            await until(() => document.querySelector('[aria-label="模型下载格式"]') !== null);
            expect(anchors).toHaveLength(0);
            await act(async () => document.querySelector<HTMLElement>('[aria-label="模型下载格式"]')!.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true })));
            await until(() => document.querySelectorAll(".ant-select-item-option").length === 7);
            expect([...document.querySelectorAll(".ant-select-item-option")].some((item) => item.textContent === "FBX")).toBe(true);
            expect([...document.querySelectorAll(".ant-select-item-option")].some((item) => item.textContent?.startsWith("ABC"))).toBe(true);
            const original = [...document.querySelectorAll<HTMLElement>(".ant-select-item-option")].find((item) => item.textContent?.startsWith("原文件"));
            await act(async () => original!.click());
            const download = [...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")].find((button) => button.textContent?.replace(/\s/g, "") === "下载");
            await act(async () => download!.click());
            await until(() => anchors.length === 1);
            expect(anchors[0].fileName).toBe(`robot.${format}`);
            expect(get).not.toHaveBeenCalled();
            expect(post).not.toHaveBeenCalled();
        } finally {
            await act(async () => root.unmount());
            host.remove();
            get.mockRestore();
            post.mockRestore();
        }
    });

    test.each([
        ["multi-frame actions", 2],
        ["zero-duration poses", 1],
    ] as const)("ABC requires a choice between %s and submits the selected action", async (_kind, keyframeCount) => {
        const times = Array.from({ length: keyframeCount }, (_, index) => index);
        const names = keyframeCount === 1 ? ["pose_a", "pose_b"] : ["walk", "run"];
        const bytes = new Float32Array([...times, ...times.flatMap((time) => [time, 0, 0])]);
        const gltf = {
            asset: { version: "2.0" },
            buffers: [{ byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(bytes.buffer).toString("base64")}` }],
            bufferViews: [
                { buffer: 0, byteOffset: 0, byteLength: keyframeCount * 4 },
                { buffer: 0, byteOffset: keyframeCount * 4, byteLength: keyframeCount * 12 },
            ],
            accessors: [
                { bufferView: 0, componentType: 5126, count: keyframeCount, type: "SCALAR", min: [0], max: [keyframeCount - 1] },
                { bufferView: 1, componentType: 5126, count: keyframeCount, type: "VEC3" },
            ],
            nodes: [{ name: "root" }],
            scenes: [{ nodes: [0] }],
            scene: 0,
            animations: names.map((name) => ({ name, samplers: [{ input: 0, output: 1 }], channels: [{ sampler: 0, target: { node: 0, path: "translation" } }] })),
        };
        const asset = source();
        asset.data = { ...asset.data, fileName: "robot.gltf", mimeType: "model/gltf+json", url: `data:model/gltf+json;base64,${Buffer.from(JSON.stringify(gltf)).toString("base64")}` };
        const get = spyOn(http, "get").mockResolvedValue({ available: true, formats: ["abc"] } as never);
        const post = spyOn(http, "post").mockResolvedValue({
            id: "export",
            status: "succeeded",
            stage: "完成",
            progress: 100,
            result: { resourceId: "converted", storageKey: "", url: "https://cdn.invalid/robot.abc", fileName: "robot.abc", format: "abc", mimeType: "application/octet-stream", bytes: 1024 },
        } as never);
        try {
            const f = await fixture(asset);
            await f.choose("ABC");
            await until(() => document.querySelector('[aria-label="ABC 导出动作"]') !== null);
            expect(document.querySelector("[role='dialog']")?.textContent).toContain("不保留可编辑骨骼和着色器");
            expect(document.querySelector("[role='dialog']")?.textContent).toContain("将把此模型上传到服务器");
            expect(f.button("下载").disabled).toBe(true);
            expect(document.querySelector<HTMLInputElement>('[aria-label="ABC 导出帧率"]')?.value).toBe("30");
            await f.click("下载");
            expect(get).not.toHaveBeenCalled();
            expect(post).not.toHaveBeenCalled();
            for (const name of names) {
                await act(async () => document.querySelector<HTMLElement>('[aria-label="ABC 导出动作"]')!.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true })));
                await until(() => [...document.querySelectorAll(".ant-select-item-option")].some((item) => item.textContent?.startsWith(name)));
                for (const offeredName of names) expect([...document.querySelectorAll(".ant-select-item-option")].some((item) => item.textContent === `${offeredName}（${(keyframeCount - 1).toFixed(2)} 秒）`)).toBe(true);
                const option = [...document.querySelectorAll<HTMLElement>(".ant-select-item-option")].find((item) => item.textContent?.startsWith(name));
                await act(async () => option!.click());
                expect(f.button("下载").disabled).toBe(false);
            }
            await f.click("下载");
            await until(() => anchors.length === 1);
            expect(post).toHaveBeenCalledTimes(1);
            expect(post.mock.calls[0][0]).toBe("/model3d/exports");
            const request = post.mock.calls[0][1] as FormData;
            expect(request.get("format")).toBe("abc");
            expect(request.get("animation")).toBe(names[1]);
            expect(request.get("fps")).toBe("30");
            expect(anchors).toEqual([{ href: "https://cdn.invalid/robot.abc", fileName: "robot.abc" }]);
        } finally {
            get.mockRestore();
            post.mockRestore();
        }
    });

    test("unknown source formats keep the original download and disable conversion choices", async () => {
        const asset = source();
        asset.data = { ...asset.data, fileName: "robot.usdz", mimeType: "model/vnd.usdz+zip", url: "data:application/octet-stream;base64,AA==" };
        const f = await fixture(asset);
        await f.choose("原文件");
        await act(async () => document.querySelector<HTMLElement>("[aria-label='模型下载格式']")!.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true })));
        await until(() => document.querySelectorAll(".ant-select-item-option").length === 7);
        expect(document.querySelectorAll(".ant-select-item-option-disabled")).toHaveLength(6);
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
        if (action === "cancel") {
            await f.click("取消");
            expect(f.closed).toBe(1);
        } else if (action === "close icon") {
            const close = document.querySelector<HTMLButtonElement>(".ant-modal-close");
            expect(close).not.toBeNull();
            await act(async () => close!.click());
            expect(f.closed).toBe(1);
        } else if (action === "unmount") await f.dispose();
        else if (action === "replace asset") await f.render({ ...source(), id: "another-model", title: "another" });
        else
            await act(async () => {
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
        await act(async () => {
            button.click();
            button.click();
        });
        await until(() => pending.signals.length > 0);
        expect(pending.signals).toHaveLength(1);
        pending.resolve(new Response(obj));
        await until(() => saved.length === 1);
        expect(pending.signals).toHaveLength(1);
    });

    test("a failed conversion reports the error and can retry successfully", async () => {
        const f = await fixture();
        let reads = 0;
        globalThis.fetch = (async () => (++reads === 1 ? new Response("missing", { status: 404 }) : new Response(obj))) as typeof fetch;
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
