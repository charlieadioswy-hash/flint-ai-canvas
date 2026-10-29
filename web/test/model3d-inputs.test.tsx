import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Model3DDraft, Model3DImageBinding } from "../src/lib/canvas/model3d";
import type { Model3DCapabilities } from "../src/services/api/model3d";

const dom = new Window({ url: "http://localhost/model3d" });
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
const { ConfigProvider } = await import("antd");
const { Model3DInputs } = await import("../src/pages/model3d/model3d-inputs");

afterAll(() => {
    dom.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

const capabilities: Model3DCapabilities = {
    available: true,
    providerName: "Tripo",
    policyRevision: 1,
    activeConfigVersion: 1,
    defaultModel: "h3.1",
    modelVersions: [
        { id: "h3.1", label: "H3.1", supportsAdvanced: true, maxFacesStandard: 500000, maxFacesDetailed: 2000000 },
        { id: "v1.4", label: "V1.4", supportsAdvanced: false, maxFacesStandard: 100000, maxFacesDetailed: 100000 },
    ],
    modes: ["text", "image", "multiview"],
    inputLimits: { maxBytes: 10 * 1024 * 1024, mimeTypes: ["image/png", "image/jpeg"], minViews: 2, maxViews: 4, requiredView: "front" },
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (cause: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function drag(target: Element, type: string, files: File[]) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const dataTransfer = { files, types: ["Files"], dropEffect: "none" };
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    target.dispatchEvent(event);
    return { event, dataTransfer };
}

async function fixture(options: { mode?: Model3DDraft["mode"]; disabled?: boolean; onUpload?: (file: File) => Promise<Model3DImageBinding> } = {}) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const uploads: File[] = [];
    const changes: Model3DDraft[] = [];
    let latestDraft!: Model3DDraft;
    let setDisabled!: (value: boolean) => void;
    function TestInputs() {
        const [draft, setDraft] = useState<Model3DDraft>({ mode: options.mode || "image", prompt: "机器人", views: {}, parameters: { model: "h3.1", texture: true, pbr: true } });
        const [disabled, updateDisabled] = useState(options.disabled || false);
        latestDraft = draft;
        setDisabled = updateDisabled;
        return (
            <ConfigProvider theme={{ token: { motion: false } }}>
                <Model3DInputs
                    draft={draft}
                    capabilities={capabilities}
                    count={1}
                    disabled={disabled}
                    onChange={(update) => {
                        const next = update(draft);
                        changes.push(next);
                        setDraft(next);
                    }}
                    onCountChange={() => {}}
                    onUpload={(file) => {
                        uploads.push(file);
                        return options.onUpload ? options.onUpload(file) : Promise.resolve({ resourceId: file.name, title: file.name });
                    }}
                    onIdeas={() => {}}
                />
            </ConfigProvider>
        );
    }
    await act(async () => root.render(<TestInputs />));
    return {
        host,
        uploads,
        changes,
        get draft() {
            return latestDraft;
        },
        uploadTarget(label = "参考图片") {
            return host.querySelector<HTMLButtonElement>(`button[aria-label="选择${label}"]`)!;
        },
        async chooseFile(file: File, label = "参考图片") {
            const input = host.querySelector<HTMLInputElement>(`input[aria-label="上传${label}"]`)!;
            Object.defineProperty(input, "files", { configurable: true, value: [file] });
            await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
            expect(input.value).toBe("");
        },
        async click(text: string) {
            const button = [...host.querySelectorAll("button")].find((item) => item.textContent?.replace(/\s/g, "") === text.replace(/\s/g, ""));
            expect(button).toBeDefined();
            await act(async () => button!.click());
        },
        async select(label: string, option: string) {
            const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
            expect(input).not.toBeNull();
            await act(async () => input.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true })));
            const item = [...document.querySelectorAll<HTMLElement>(".ant-select-item-option")].find((element) => element.textContent === option);
            expect(item).toBeDefined();
            await act(async () => item!.click());
        },
        async setDisabled(value: boolean) {
            await act(async () => setDisabled(value));
        },
        async dispose() {
            await act(async () => root.unmount());
            host.remove();
        },
    };
}

test("single image click and drop share the upload path, with stable nested drag highlighting", async () => {
    const f = await fixture();
    try {
        const target = f.uploadTarget();
        let pickerOpens = 0;
        f.host.querySelector('input[type="file"]')!.addEventListener("click", () => ++pickerOpens);
        await act(async () => target.click());
        expect(pickerOpens).toBe(1);
        const clicked = new File(["click"], "clicked.png", { type: "image/png" });
        await f.chooseFile(clicked);
        expect(f.uploads).toEqual([clicked]);
        expect(f.draft.image?.resourceId).toBe("clicked.png");

        const dropped = new File(["drop"], "dropped.png", { type: "image/png" });
        await act(async () => {
            drag(target, "dragenter", [dropped]);
            drag(target.querySelector("span")!, "dragenter", [dropped]);
            drag(target.querySelector("span")!, "dragleave", [dropped]);
        });
        expect(target.textContent).toContain("松开以上传图片");
        expect(target.style.borderColor).not.toBe("");
        const over = drag(target, "dragover", [dropped]);
        expect(over.event.defaultPrevented).toBe(true);
        expect(over.dataTransfer.dropEffect).toBe("copy");
        await act(async () => drag(target, "dragleave", [dropped]));
        expect(target.textContent).not.toContain("松开以上传图片");
        await act(async () => {
            drag(target, "dragenter", [dropped]);
            expect(drag(target, "drop", [dropped]).event.defaultPrevented).toBe(true);
        });
        expect(f.uploads).toEqual([clicked, dropped]);
        expect(f.draft.image?.resourceId).toBe("dropped.png");
        expect(target.textContent).not.toContain("松开以上传图片");
    } finally {
        await f.dispose();
    }
});

test("each multiview slot accepts its own drop without changing the other views", async () => {
    const f = await fixture({ mode: "multiview" });
    try {
        for (const [view, label] of [
            ["front", "正面（必选）"],
            ["left", "左侧"],
            ["back", "背面"],
            ["right", "右侧"],
        ] as const) {
            const file = new File([view], `${view}.png`, { type: "image/png" });
            await act(async () => drag(f.uploadTarget(label), "drop", [file]));
            expect(f.draft.views[view]?.resourceId).toBe(`${view}.png`);
        }
        expect(Object.keys(f.draft.views)).toHaveLength(4);
        expect(f.uploads).toHaveLength(4);
        expect(f.draft.image).toBeUndefined();
    } finally {
        await f.dispose();
    }
});

test("multiple files are rejected explicitly and a later single drop can succeed", async () => {
    const f = await fixture();
    try {
        const first = new File(["first"], "first.png", { type: "image/png" });
        const second = new File(["second"], "second.png", { type: "image/png" });
        await act(async () => drag(f.uploadTarget(), "drop", [first, second]));
        expect(f.uploads).toHaveLength(0);
        expect(f.host.querySelector('[role="alert"]')?.textContent).toContain("一次只能上传一张图片");
        await act(async () => drag(f.uploadTarget(), "drop", [second]));
        expect(f.draft.image?.resourceId).toBe("second.png");
        expect(f.host.querySelector('[role="alert"]')).toBeNull();
    } finally {
        await f.dispose();
    }
});

test("busy and disabled slots prevent browser navigation and never start another upload", async () => {
    const pending = deferred<Model3DImageBinding>();
    const f = await fixture({ disabled: true, onUpload: () => pending.promise });
    try {
        const file = new File(["image"], "image.png", { type: "image/png" });
        const target = f.uploadTarget();
        await act(async () => {
            expect(drag(target, "drop", [file]).event.defaultPrevented).toBe(true);
            const over = drag(target, "dragover", [file]);
            expect(over.event.defaultPrevented).toBe(true);
            expect(over.dataTransfer.dropEffect).toBe("none");
        });
        await f.chooseFile(file);
        expect(f.uploads).toHaveLength(0);
        await f.setDisabled(false);
        await act(async () => {
            drag(target, "drop", [file]);
            drag(target, "drop", [file]);
        });
        await f.chooseFile(file);
        expect(f.uploads).toHaveLength(1);
        expect(target.disabled).toBe(true);
        expect(target.textContent).toContain("正在上传");
        await act(async () => pending.resolve({ resourceId: "done" }));
        expect(target.disabled).toBe(false);
        expect(f.draft.image?.resourceId).toBe("done");
    } finally {
        await f.dispose();
    }
});

test("upload failure leaves the input available for retrying the same file", async () => {
    let attempts = 0;
    const f = await fixture({
        onUpload: async () => {
            if (++attempts === 1) throw new Error("上传失败，请重试");
            return { resourceId: "retried" };
        },
    });
    try {
        const file = new File(["retry"], "retry.png", { type: "image/png" });
        await f.chooseFile(file);
        expect(f.host.querySelector('[role="alert"]')?.textContent).toContain("上传失败，请重试");
        expect(f.uploadTarget().disabled).toBe(false);
        await f.chooseFile(file);
        expect(f.draft.image?.resourceId).toBe("retried");
        expect(f.uploads).toEqual([file, file]);
        expect(f.host.querySelector('[role="alert"]')).toBeNull();
    } finally {
        await f.dispose();
    }
});

test("an upload completing after its input unmounts cannot update the draft", async () => {
    const pending = deferred<Model3DImageBinding>();
    const f = await fixture({ onUpload: () => pending.promise });
    try {
        await act(async () => drag(f.uploadTarget(), "drop", [new File(["old"], "old.png", { type: "image/png" })]));
        await f.click("文本");
        const changesAfterSwitch = f.changes.length;
        await act(async () => pending.resolve({ resourceId: "obsolete" }));
        expect(f.changes).toHaveLength(changesAfterSwitch);
        expect(f.draft.mode).toBe("text");
        expect(f.draft.image).toBeUndefined();
    } finally {
        await f.dispose();
    }
});

test("texture quality maps 8K to extreme and sanitizes it when switching to white mesh or a basic model", async () => {
    const f = await fixture({ mode: "text" });
    try {
        await f.select("贴图质量", "8K");
        expect(f.draft.parameters.textureQuality).toBe("extreme");
        expect(f.host.textContent).toContain("预览显存占用");
        expect(f.host.textContent).toContain("费用以当前服务配置为准");
        await f.click("白模");
        expect(f.draft.parameters.textureQuality).toBeUndefined();
        expect(f.draft.parameters.pbr).toBe(false);
        expect(f.host.querySelector<HTMLInputElement>('input[aria-label="贴图质量"]')?.disabled).toBe(true);
        await f.click("带纹理模型");
        await f.select("贴图质量", "高清");
        expect(f.draft.parameters.textureQuality).toBe("detailed");
        await f.select("贴图质量", "标准");
        expect(f.draft.parameters.textureQuality).toBe("standard");
        await f.select("贴图质量", "8K");
        await f.select("生成模型", "V1.4");
        expect(f.draft.parameters.textureQuality).toBeUndefined();
        expect(f.host.querySelector<HTMLInputElement>('input[aria-label="贴图质量"]')?.disabled).toBe(true);
        expect(f.host.textContent).toContain("当前模型不支持调整贴图质量");
        await f.select("生成模型", "H3.1");
        expect(f.draft.parameters.textureQuality).toBeUndefined();
        expect(f.host.querySelector<HTMLInputElement>('input[aria-label="贴图质量"]')?.disabled).toBe(false);
    } finally {
        await f.dispose();
    }
});
