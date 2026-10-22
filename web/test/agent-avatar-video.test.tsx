import { afterAll, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";

const dom = new Window({ url: "https://canvas.example/" });
// happy-dom does not expose the standard media ready-state constants.
Object.defineProperties(dom.HTMLMediaElement, {
    HAVE_CURRENT_DATA: { value: 2 },
    HAVE_FUTURE_DATA: { value: 3 },
    HAVE_ENOUGH_DATA: { value: 4 },
});
const originals = new Map<string, PropertyDescriptor | undefined>();
const frames = new Map<number, () => void>();
let frameID = 0;
for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    HTMLMediaElement: dom.HTMLMediaElement,
    requestAnimationFrame: (callback: () => void) => {
        frames.set(++frameID, callback);
        return frameID;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AgentAvatarVideo } = await import("../src/components/canvas/agent-avatar-video");

afterAll(() => {
    dom.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

async function fixture(videoFrames = true) {
    const host = document.createElement("div");
    document.body.append(host);
    const errors: unknown[] = [];
    const root = createRoot(host, { onUncaughtError: (error) => errors.push(error) });
    let failures = 0;
    let drawFailure = false;
    let readFailure = false;
    let painted: Uint8ClampedArray | undefined;
    const context = {
        drawImage() {
            if (drawFailure) throw new DOMException("Cannot draw video", "InvalidStateError");
        },
        getImageData() {
            if (readFailure) throw new DOMException("Canvas is tainted", "SecurityError");
            return { data: new Uint8ClampedArray([0, 255, 0, 255, 180, 100, 80, 255]) };
        },
        putImageData(image: { data: Uint8ClampedArray }) {
            painted = image.data;
        },
    };
    const contextSpy = spyOn(dom.HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context as never);
    const pauseSpy = spyOn(dom.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const playSpy = spyOn(dom.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const render = async (src = "https://backend.example/api/avatar/idle.mp4", loop = true) => {
        await act(async () => root.render(<AgentAvatarVideo src={src} loop={loop} onError={() => failures++} />));
    };
    await render();
    const video = host.querySelector("video")!;
    const canvas = host.querySelector("canvas")!;
    Object.defineProperties(video, {
        readyState: { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA },
        videoWidth: { configurable: true, value: 640 },
        videoHeight: { configurable: true, value: 480 },
        requestVideoFrameCallback: {
            configurable: true,
            value: videoFrames
                ? (callback: () => void) => {
                      frames.set(++frameID, callback);
                      return frameID;
                  }
                : undefined,
        },
        cancelVideoFrameCallback: { configurable: true, value: (id: number) => frames.delete(id) },
    });
    return {
        video,
        canvas,
        errors,
        pauseSpy,
        playSpy,
        render,
        get failures() {
            return failures;
        },
        get painted() {
            return painted;
        },
        failRead(value = true) {
            readFailure = value;
        },
        failDraw() {
            drawFailure = true;
        },
        async tick() {
            const pending = [...frames.values()];
            frames.clear();
            video.currentTime += 1;
            await act(async () => pending.forEach((callback) => callback()));
        },
        async mediaError() {
            await act(async () => video.dispatchEvent(new dom.Event("error") as unknown as Event));
        },
        async dispose() {
            await act(async () => root.unmount());
            host.remove();
            contextSpy.mockRestore();
            pauseSpy.mockRestore();
            playSpy.mockRestore();
        },
    };
}

test("avatar video loads with credentials and continues chroma-key rendering", async () => {
    const f = await fixture();
    try {
        expect(f.video.getAttribute("crossorigin")).toBe("use-credentials");
        await f.tick();
        expect(f.painted?.[3]).toBe(0);
        expect(f.painted?.[7]).toBe(255);
        expect([f.canvas.width, f.canvas.height]).toEqual([320, 240]);
        expect(frames.size).toBe(1);
        expect(f.failures).toBe(0);
    } finally {
        await f.dispose();
    }
    expect(frames.size).toBe(0);
});

for (const videoFrames of [true, false]) {
    test(`pixel-read failure stops callbacks, reports once and recovers with a new source (${videoFrames ? "video" : "animation"} frames)`, async () => {
        const f = await fixture(videoFrames);
        try {
            await f.tick();
            f.failRead();
            await f.tick();
            expect(f.failures).toBe(1);
            expect(f.pauseSpy).toHaveBeenCalledTimes(1);
            expect(frames.size).toBe(0);
            await f.mediaError();
            expect(f.failures).toBe(1);
            await f.render(undefined, false);
            expect(f.playSpy).not.toHaveBeenCalled();
            f.failRead(false);
            await f.render("https://backend.example/api/avatar/running.mp4");
            await f.tick();
            expect(f.failures).toBe(1);
            expect(frames.size).toBe(1);
            expect(f.playSpy).toHaveBeenCalledTimes(1);
            expect(f.errors).toEqual([]);
        } finally {
            await f.dispose();
        }
        expect(frames.size).toBe(0);
    });
}

test("media load failure cancels the pending frame and reports once", async () => {
    const f = await fixture();
    try {
        await f.tick();
        await f.mediaError();
        await f.mediaError();
        expect(frames.size).toBe(0);
        expect(f.failures).toBe(1);
        expect(f.pauseSpy).toHaveBeenCalledTimes(1);
    } finally {
        await f.dispose();
    }
});

test("drawing failure during source setup is contained", async () => {
    const f = await fixture();
    try {
        f.failDraw();
        await f.render("https://backend.example/api/avatar/broken.mp4");
        expect(f.errors).toEqual([]);
        expect(f.failures).toBe(1);
        expect(frames.size).toBe(0);
        expect(f.playSpy).not.toHaveBeenCalled();
    } finally {
        await f.dispose();
    }
});
