import { describe, expect, test } from "bun:test";
import { deriveIrregularScreenMask, type IrregularScreenPixels } from "../src/lib/canvas/irregular-screen-mask";

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
