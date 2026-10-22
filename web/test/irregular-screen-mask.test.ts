import { describe, expect, test } from "bun:test";
import { deriveIrregularScreenMask, validateIrregularScreenMaskFile, validateIrregularScreenMaskPixels, type IrregularScreenPixels } from "../src/lib/canvas/irregular-screen-mask";

function pixels(rows: number[][][]): IrregularScreenPixels {
    return { width: rows[0].length, height: rows.length, data: new Uint8ClampedArray(rows.flat().flatMap((pixel) => (pixel.length === 3 ? [...pixel, 255] : pixel))) };
}

describe("irregular screen mask extraction", () => {
    test("merges colored screen regions and excludes a white border without modifying RGB input", () => {
        const source = pixels([
            [
                [255, 255, 255],
                [0, 0, 0],
                [251, 249, 250],
                [0, 0, 0],
            ],
            [
                [0, 0, 0],
                [255, 0, 0],
                [0, 0, 255],
                [0, 0, 0],
            ],
            [
                [0, 0, 0],
                [0, 255, 0],
                [0, 0, 0],
                [255, 255, 255],
            ],
        ]);
        const original = new Uint8ClampedArray(source.data);
        const mask = deriveIrregularScreenMask(source);
        expect(mask.mode).toBe("color");
        expect(mask.valid).toBe(true);
        expect(mask.coverage).toBe(0.25);
        expect(mask.bounds).toEqual({ x: 1, y: 1, width: 2, height: 2 });
        expect(Array.from(mask.data).filter((_, index) => index % 4 === 0)).toEqual([0, 0, 0, 0, 0, 255, 255, 0, 0, 255, 0, 0]);
        expect(source.data).toEqual(original);
    });

    test("ignores near-black JPEG noise and near-white colored ringing", () => {
        const mask = deriveIrregularScreenMask(
            pixels([
                [
                    [3, 8, 12],
                    [246, 235, 251],
                    [243, 27, 20],
                    [8, 11, 6],
                ],
            ]),
        );
        expect(mask.mode).toBe("color");
        expect(mask.coverage).toBe(0.25);
        expect(Array.from(mask.data).filter((_, index) => index % 4 === 0)).toEqual([0, 0, 255, 0]);
    });

    test("keeps luminance weights for grayscale masks with JPEG black tolerance", () => {
        const mask = deriveIrregularScreenMask(
            pixels([
                [
                    [8, 8, 8],
                    [128, 128, 128],
                    [249, 249, 249],
                ],
            ]),
        );
        expect(mask.mode).toBe("luminance");
        expect(Array.from(mask.data).filter((_, index) => index % 4 === 0)).toEqual([0, 128, 255]);
        expect(mask.valid).toBe(true);
    });

    test("detects alpha silhouettes including black opaque interiors", () => {
        const mask = deriveIrregularScreenMask(
            pixels([
                [
                    [255, 0, 0, 0],
                    [0, 0, 0, 128],
                    [0, 0, 0, 255],
                ],
            ]),
        );
        expect(mask.mode).toBe("alpha");
        expect(Array.from(mask.data).filter((_, index) => index % 4 === 0)).toEqual([0, 128, 255]);
        expect(mask.valid).toBe(true);
    });

    test("does not include transparent colored pixels in a color mask", () => {
        const mask = deriveIrregularScreenMask(
            pixels([
                [
                    [255, 0, 0, 0],
                    [255, 0, 0, 255],
                    [0, 0, 0, 255],
                ],
            ]),
        );
        expect(mask.mode).toBe("color");
        expect(mask.coverage).toBe(1 / 3);
    });

    test("explicit preview modes do not silently switch the requested interpretation", () => {
        const source = pixels([
            [
                [255, 255, 255],
                [255, 0, 0],
                [0, 0, 0],
            ],
        ]);
        expect(deriveIrregularScreenMask(source, "color").coverage).toBe(1 / 3);
        const luminance = deriveIrregularScreenMask(source, "luminance");
        expect(luminance.mode).toBe("luminance");
        expect(luminance.data[0]).toBe(255);
        expect(luminance.warnings).not.toHaveLength(0);
        expect(deriveIrregularScreenMask(source, "alpha").valid).toBe(false);
    });

    test("rejects fully white, fully black, fully transparent and uniform gray masks", () => {
        for (const pixel of [
            [255, 255, 255],
            [0, 0, 0],
            [255, 255, 255, 0],
            [128, 128, 128],
        ]) {
            const result = deriveIrregularScreenMask(pixels([[pixel, pixel]]));
            expect(result.valid).toBe(false);
            expect(result.reason).toBeTruthy();
        }
    });

    test("rejects invalid pixel dimensions", () => {
        expect(() => deriveIrregularScreenMask({ width: 2, height: 2, data: new Uint8ClampedArray(4) })).toThrow("尺寸");
    });
});

describe("new screen mask upload validation", () => {
    const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    test("requires exact PNG MIME and signature, including the four trailing signature bytes", () => {
        expect(() => validateIrregularScreenMaskFile({ type: "image/png", size: 256 }, signature)).not.toThrow();
        for (const type of ["image/jpeg", "application/octet-stream", ""]) {
            expect(() => validateIrregularScreenMaskFile({ type, size: 256 }, signature)).toThrow("仅支持");
        }
        for (let index = 0; index < signature.length; index++) {
            const corrupted = new Uint8Array(signature);
            corrupted[index] ^= 0xff;
            expect(() => validateIrregularScreenMaskFile({ type: "image/png", size: 256 }, corrupted)).toThrow("不是有效的 PNG");
        }
        expect(() => validateIrregularScreenMaskFile({ type: "image/png", size: 7 }, signature.slice(0, 7))).toThrow("不是有效的 PNG");
        expect(() => validateIrregularScreenMaskFile({ type: "image/png", size: 0 }, new Uint8Array())).toThrow("不是有效的 PNG");
    });

    test("accepts the 10 MB limit and rejects larger masks", () => {
        expect(() => validateIrregularScreenMaskFile({ type: "image/png", size: 10 * 1024 * 1024 }, signature)).not.toThrow();
        expect(() => validateIrregularScreenMaskFile({ type: "image/png", size: 10 * 1024 * 1024 + 1 }, signature)).toThrow("10 MB");
    });

    test("requires both transparent and opaque regions while preserving partial-alpha edges", () => {
        const source = pixels([
            [
                [255, 0, 0, 16],
                [0, 0, 0, 128],
                [255, 255, 255, 239],
            ],
        ]);
        expect(() => validateIrregularScreenMaskPixels(source)).not.toThrow();
        const result = deriveIrregularScreenMask(source, "alpha");
        expect(result.mode).toBe("alpha");
        expect(result.valid).toBe(true);
        expect([result.data[0], result.data[4], result.data[8]]).toEqual([0, 128, 255]);
        expect(() =>
            validateIrregularScreenMaskPixels(
                pixels([
                    [
                        [0, 0, 0, 17],
                        [0, 0, 0, 255],
                    ],
                ]),
            ),
        ).toThrow("缺少透明");
        expect(() =>
            validateIrregularScreenMaskPixels(
                pixels([
                    [
                        [0, 0, 0, 0],
                        [0, 0, 0, 238],
                    ],
                ]),
            ),
        ).toThrow("缺少不透明");
        expect(() =>
            validateIrregularScreenMaskPixels(
                pixels([
                    [
                        [0, 0, 0, 0],
                        [255, 0, 0, 0],
                    ],
                ]),
            ),
        ).toThrow("缺少不透明");
        expect(() =>
            validateIrregularScreenMaskPixels(
                pixels([
                    [
                        [0, 0, 0, 255],
                        [255, 255, 255, 255],
                    ],
                ]),
            ),
        ).toThrow("缺少透明");
    });

    test("new alpha masks ignore RGB colors while legacy color and luminance remain available", () => {
        const source = pixels([
            [
                [255, 0, 0, 0],
                [255, 0, 0, 255],
                [0, 0, 0, 255],
                [255, 255, 255, 255],
            ],
        ]);
        validateIrregularScreenMaskPixels(source);
        expect(deriveIrregularScreenMask(source, "alpha").coverage).toBe(3 / 4);
        expect(deriveIrregularScreenMask(source, "color").coverage).toBe(1 / 4);
        expect(deriveIrregularScreenMask(source, "auto").mode).toBe("color");
        expect(deriveIrregularScreenMask(source, "luminance").mode).toBe("luminance");
    });

    test("checks both dimension limits and malformed pixel buffers", () => {
        for (const [width, height] of [
            [4096, 1],
            [1, 4096],
        ]) {
            const data = new Uint8ClampedArray(width * height * 4);
            data[7] = 255;
            expect(() => validateIrregularScreenMaskPixels({ width, height, data })).not.toThrow();
        }
        for (const [width, height] of [
            [4097, 1],
            [1, 4097],
        ]) {
            expect(() => validateIrregularScreenMaskPixels({ width, height, data: new Uint8ClampedArray(width * height * 4) })).toThrow("4096");
        }
        expect(() => validateIrregularScreenMaskPixels({ width: 2, height: 2, data: new Uint8ClampedArray(4) })).toThrow("尺寸无效");
    });
});
