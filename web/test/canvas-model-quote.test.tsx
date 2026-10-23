import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { LogicalModelQuote, ModelQuoteRequest } from "../src/services/api/logical-models";

const dom = new Window({ url: "http://localhost/" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { apiClient } = await import("../src/services/api/request");
const { useCanvasModelQuote } = await import("../src/components/canvas/use-canvas-model-quote");

afterAll(() => {
    dom.happyDOM.abort();
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

const request: ModelQuoteRequest = {
    channelId: "video-channel",
    modelKey: "MiniMax-Hailuo-02",
    intent: { capability: "video", operation: "text_to_video", inputs: { image: 0 }, options: { vquality: "512", videoSeconds: 10 } },
};
const quote: LogicalModelQuote = { logicalModelId: "", billingMode: "fixed_request", quantity: 1, amountMicrocredits: 1_000_000, estimated: false };

function deferred() {
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function fixture() {
    const original = apiClient.request;
    const calls: Array<{ signal: AbortSignal; result: ReturnType<typeof deferred> }> = [];
    apiClient.request = ((config: { signal: AbortSignal }) => {
        const result = deferred();
        calls.push({ signal: config.signal, result });
        return result.promise;
    }) as typeof apiClient.request;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let current!: ReturnType<typeof useCanvasModelQuote>;
    function Harness({ value, enabled }: { value?: ModelQuoteRequest; enabled: boolean }) {
        current = useCanvasModelQuote(value, enabled);
        return null;
    }
    return {
        calls,
        current: () => current,
        async render(value: ModelQuoteRequest | undefined = request, enabled = true) {
            await act(async () => root.render(<Harness value={value} enabled={enabled} />));
        },
        async resolve(index: number) {
            await act(async () => calls[index]!.result.resolve({ data: { code: 0, data: { quote }, msg: "ok" }, status: 200, headers: {} }));
        },
        async reject(index: number, message = "当前规格未配置有效价格") {
            await act(async () => calls[index]!.result.reject(new Error(message)));
        },
        async dispose() {
            await act(async () => root.unmount());
            host.remove();
            apiClient.request = original;
        },
    };
}

test("quote rejection remains visible and a retry waits for a successful quote", async () => {
    const f = await fixture();
    try {
        await f.render();
        expect(f.current().pending).toBe(true);
        expect(f.current().quote).toBeNull();
        await f.reject(0);
        expect(f.current().error).toBe("当前规格未配置有效价格");
        expect(f.current().pending).toBe(false);
        expect(f.current().quote).toBeNull();
        await act(async () => f.current().retry());
        expect(f.calls).toHaveLength(2);
        expect(f.current().pending).toBe(true);
        expect(f.current().error).toBe("");
        await f.resolve(1);
        expect(f.current().pending).toBe(false);
        expect(f.current().quote).toEqual(quote);
    } finally {
        await f.dispose();
    }
});

test("parameter changes cancel old quotes and late responses cannot clear the current error", async () => {
    const f = await fixture();
    try {
        await f.render();
        await f.render({ ...request, intent: { ...request.intent, operation: "image_to_video", inputs: { image: 1 } } });
        expect(f.calls[0]!.signal.aborted).toBe(true);
        expect(f.current().pending).toBe(true);
        await f.reject(1, "新规格不可用");
        await f.resolve(0);
        expect(f.current().error).toBe("新规格不可用");
        expect(f.current().quote).toBeNull();
        await f.render(request);
        expect(f.current().pending).toBe(true);
        await f.resolve(2);
        expect(f.current().quote).toEqual(quote);
    } finally {
        await f.dispose();
    }
});

test("disabled credits do not require quotes; re-enabling cannot reuse a previous quote", async () => {
    const f = await fixture();
    try {
        await f.render(request, false);
        expect(f.calls).toHaveLength(0);
        expect(f.current().pending).toBe(false);
        await f.render();
        await f.resolve(0);
        await f.render(request, false);
        expect(f.current().quote).toBeNull();
        await f.render();
        expect(f.current().pending).toBe(true);
        expect(f.current().quote).toBeNull();
        expect(f.calls).toHaveLength(2);
        await f.render(undefined, false);
        expect(f.current().pending).toBe(false);
        expect(f.current().error).toBe("");
    } finally {
        await f.dispose();
    }
});
