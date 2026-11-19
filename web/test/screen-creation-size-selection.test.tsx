import { afterAll, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { ScreenCreationWorkspaceProps } from "../src/pages/screen-creation/screen-creation-types";

if (process.env.SCREEN_CREATION_SIZE_TEST_CHILD !== "1") {
    // Keep DOM globals and module spies out of the rest of the suite.
    test("异形屏更换蒙版时区分自动尺寸和手动尺寸", async () => {
        const child = Bun.spawn([process.execPath, "test", import.meta.path], {
            cwd: new URL("..", import.meta.url).pathname,
            env: { ...process.env, SCREEN_CREATION_SIZE_TEST_CHILD: "1" },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(code, `${stdout}\n${stderr}`).toBe(0);
    });
} else {
    const dom = new Window({ url: "http://localhost/screen-creation" });
    Object.assign(globalThis, { window: dom, document: dom.document, HTMLAnchorElement: dom.HTMLAnchorElement, IS_REACT_ACT_ENVIRONMENT: true });
    afterAll(() => dom.happyDOM.abort());

    const [{ act }, { createRoot }, { MemoryRouter, Routes, Route }, configModule, { defaultImageCapabilityConfig }, scenes, media, quote] = await Promise.all([
        import("react"),
        import("react-dom/client"),
        import("react-router"),
        import("../src/stores/use-config-store"),
        import("../src/lib/model-capabilities"),
        import("../src/pages/screen-creation/use-screen-creation-scenes"),
        import("../src/services/irregular-screen-media"),
        import("../src/components/canvas/use-canvas-model-quote"),
    ]);
    const channelId = "screen-channel";
    const modelKey = "0ea388c7eb854be3ba3c6f65aac6bfd3";
    const model = configModule.encodeChannelModel(channelId, modelKey);
    const profile = defaultImageCapabilityConfig("liblib-image");
    const canny = "b6806516962f4e1599a93ac4483c3d23";
    profile.size = { ...profile.size, values: ["1280x720", "720x1280", "1024x1024"], default: "1280x720", allowCustom: false };
    profile.controlNet = { supported: true, maxUnits: 1, baseModel: "sdxl", preprocessors: ["canny"], models: [canny] };
    const channel = configModule.createModelChannel({
        id: channelId,
        name: "Screen",
        scope: "system",
        baseUrl: "https://provider.example",
        interfaceType: "liblib-image",
        models: [modelKey],
        modelCosts: [
            {
                model: modelKey,
                capability: "image",
                protocol: "liblib-image",
                available: true,
                billingMode: "fixed_request",
                unitPriceMicrocredits: 1,
                defaultOptions: { family: "sd", textToImageTemplateUuid: "e10adc3949ba59abbe56e057f20f883e", controlNetModel: canny },
                capabilityConfig: { version: 1, image: profile },
            },
        ],
    });
    const config = { ...configModule.defaultConfig, channels: [channel], model, imageModel: model };
    spyOn(configModule, "useEffectiveConfig").mockReturnValue(config);
    const sceneLibrary = { scenes: [], query: { isPending: false, isError: false, hasNextPage: false, isFetchingNextPage: false } } as unknown as ReturnType<typeof scenes.useScreenCreationScenes>;
    spyOn(scenes, "useScreenCreationScenes").mockReturnValue(sceneLibrary);
    spyOn(quote, "useCanvasModelQuote").mockReturnValue({ quote: null, error: "", pending: false, retry: () => {} });
    spyOn(media, "readScreenMask").mockImplementation(async (file) => {
        const [width, height] = (file as File).name.split(".")[0].split("x").map(Number);
        return { width, height, data: new Uint8ClampedArray(0) };
    });
    spyOn(media, "deriveScreenOutputMask").mockImplementation(async (image) => ({
        image: { ...image, blob: image.blob!, name: "输出蒙版.png", mimeType: "image/png", bytes: image.blob!.size },
        warnings: [],
        mode: "alpha",
    }));

    const { useScreenCreation } = await import("../src/pages/screen-creation/use-screen-creation");

    async function withScreen(path: string, check: (current: () => ScreenCreationWorkspaceProps, upload: (size: string) => Promise<void>) => Promise<void>) {
        let screen: ScreenCreationWorkspaceProps | undefined;
        function Screen() {
            screen = useScreenCreation();
            return null;
        }
        const root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
        try {
            await act(async () => {
                root.render(
                    <MemoryRouter initialEntries={[path]}>
                        <Routes>
                            <Route path="/screen-creation/:canvasId?" element={<Screen />} />
                        </Routes>
                    </MemoryRouter>,
                );
            });
            await check(
                () => screen!,
                async (size) => {
                    await act(async () => screen!.uploadMask(new File([size], `${size}.png`, { type: "image/png" })));
                },
            );
        } finally {
            await act(async () => root.unmount());
        }
    }

    test("自动尺寸跟随更换后的蒙版，手动尺寸不变", async () => {
        await withScreen("/screen-creation", async (screen, upload) => {
            expect(screen().model).toBe(model);
            await upload("1280x720");
            expect(screen().size).toBe("1280x720");
            await upload("720x1280");
            expect(screen().size).toBe("720x1280");

            await act(async () => screen().setSize("1024x1024"));
            await upload("1280x720");
            expect(screen().mask).toMatchObject({ width: 1280, height: 720 });
            expect(screen().size).toBe("1024x1024");
        });
    });

    test("重新打开场景后，自动尺寸仍随更换后的蒙版调整", async () => {
        const [{ buildIrregularScreenTemplate }, { screenControlParameters, screenDefaultSettings }, sync, storage] = await Promise.all([
            import("../src/lib/canvas/irregular-screen-domain"),
            import("../src/lib/canvas/irregular-screen-model"),
            import("../src/services/user-data-sync"),
            import("../src/services/image-storage"),
        ]);
        const template = buildIrregularScreenTemplate({
            generationMode: "text2img",
            controlImage: { storageKey: "resource:control", width: 1280, height: 720 },
            outputMask: { storageKey: "resource:mask", width: 1280, height: 720 },
            prompt: "测试场景",
            modelSelection: { kind: "channel", channelId, modelKey },
            controlParameters: screenControlParameters(screenDefaultSettings(config, model)),
            size: "1280x720",
            sizeMode: "auto",
            maskMode: "alpha",
        });
        spyOn(sync, "loadCanvasProjectForEditing").mockResolvedValue({
            ...template,
            id: "saved-screen",
            title: "测试场景",
            createdAt: "2026-11-19T00:00:00Z",
            updatedAt: "2026-11-19T00:00:00Z",
        });
        spyOn(storage, "resolveImageUrl").mockResolvedValue("/synthetic-mask.png");
        await withScreen("/screen-creation/saved-screen", async (screen, upload) => {
            expect(screen().loading).toBe(false);
            expect(screen().size).toBe("1280x720");
            await upload("720x1280");
            expect(screen().size).toBe("720x1280");
        });
    });
}
