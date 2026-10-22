import { expect, test } from "bun:test";
import { readScreenImage, readScreenMask } from "../src/services/irregular-screen-media";

const pngSignature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = () => new Blob([pngSignature], { type: "image/png" });

async function withDecodedImage(pixels: { width: number; height: number; data: Uint8ClampedArray }, run: (counts: { decoded: number; closed: number; drawn: number }) => Promise<void>) {
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const counts = { decoded: 0, closed: 0, drawn: 0 };
    const globals = {
        createImageBitmap: async () => {
            counts.decoded++;
            return { width: pixels.width, height: pixels.height, close: () => counts.closed++ };
        },
        document: {
            createElement: () => ({
                width: 0,
                height: 0,
                getContext: () => ({ drawImage: () => counts.drawn++, getImageData: () => pixels }),
            }),
        },
    };
    for (const [key, value] of Object.entries(globals)) {
        originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    try {
        await run(counts);
    } finally {
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
}

test("screen mask rejects renamed JPEGs, truncated signatures and oversized files before decoding", async () => {
    await withDecodedImage({ width: 2, height: 1, data: new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255]) }, async (counts) => {
        await expect(readScreenMask(new Blob([pngSignature], { type: "image/jpeg" }))).rejects.toThrow("仅支持");
        await expect(readScreenMask(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: "image/png" }))).rejects.toThrow("不是有效的 PNG");
        await expect(readScreenMask(new Blob([pngSignature.slice(0, 7)], { type: "image/png" }))).rejects.toThrow("不是有效的 PNG");
        await expect(readScreenMask(new Blob([pngSignature, new Uint8Array(10 * 1024 * 1024)], { type: "image/png" }))).rejects.toThrow("10 MB");
        expect(counts.decoded).toBe(0);
    });
});

test("new screen masks require transparency while PNG and JPEG content images retain their behavior", async () => {
    const opaque = { width: 2, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]) };
    await withDecodedImage(opaque, async (counts) => {
        await expect(readScreenMask(png())).rejects.toThrow("缺少透明");
        expect(await readScreenImage(png())).toBe(opaque);
        expect(await readScreenImage(new Blob([new Uint8Array([0xff, 0xd8])], { type: "image/jpeg" }))).toBe(opaque);
        expect(counts.closed).toBe(3);
    });
    const alpha = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 16, 0, 0, 0, 239]) };
    await withDecodedImage(alpha, async (counts) => {
        expect(await readScreenMask(png())).toBe(alpha);
        expect(counts.closed).toBe(1);
    });
});

test("oversized decoded masks are rejected and closed before allocating canvas pixels", async () => {
    await withDecodedImage({ width: 4097, height: 1, data: new Uint8ClampedArray() }, async (counts) => {
        await expect(readScreenMask(png())).rejects.toThrow("4096");
        expect(counts.closed).toBe(1);
        expect(counts.drawn).toBe(0);
    });
});

test("a valid PNG signature with corrupt contents produces an actionable PNG-only mask error", async () => {
    await withDecodedImage({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, async () => {
        Object.defineProperty(globalThis, "createImageBitmap", {
            configurable: true,
            writable: true,
            value: async () => {
                throw new Error("The source image could not be decoded");
            },
        });
        await expect(readScreenMask(png())).rejects.toThrow("屏幕蒙版无法读取，请上传完整且有效的透明背景 PNG");
        await expect(readScreenImage(new Blob([pngSignature], { type: "image/jpeg" }))).rejects.toThrow("PNG 或 JPEG");
    });
});
