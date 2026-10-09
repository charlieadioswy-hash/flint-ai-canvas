export type IrregularScreenMaskMode = "auto" | "color" | "luminance" | "alpha";
export type IrregularScreenPixels = { width: number; height: number; data: Uint8ClampedArray };
export type IrregularScreenMaskResult = IrregularScreenPixels & {
    mode: Exclude<IrregularScreenMaskMode, "auto">;
    valid: boolean;
    reason?: string;
    coverage: number;
    bounds?: { x: number; y: number; width: number; height: number };
    warnings: string[];
};

const BLACK_TOLERANCE = 16;
const WHITE_TOLERANCE = 239;

function coloredPixel(red: number, green: number, blue: number, alpha: number) {
    const maximum = Math.max(red, green, blue);
    const chroma = maximum - Math.min(red, green, blue);
    // Chroma and saturation jointly reject JPEG ringing on black/white borders.
    return alpha > BLACK_TOLERANCE && maximum > 40 && chroma >= 32 && chroma / maximum >= 0.2;
}

function denoise(value: number) {
    return value <= BLACK_TOLERANCE ? 0 : value >= WHITE_TOLERANCE ? 255 : Math.round(value);
}

export function deriveIrregularScreenMask(source: IrregularScreenPixels, requestedMode: IrregularScreenMaskMode = "auto"): IrregularScreenMaskResult {
    const { width, height, data } = source;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height * 4 !== data.length) throw new Error("蒙版像素尺寸无效");
    if (!["auto", "color", "luminance", "alpha"].includes(requestedMode)) throw new Error("蒙版识别模式无效");
    const pixels = width * height;
    let colorPixels = 0;
    let transparentPixels = 0;
    let visiblePixels = 0;
    for (let index = 0; index < data.length; index += 4) {
        if (coloredPixel(data[index], data[index + 1], data[index + 2], data[index + 3])) colorPixels++;
        if (data[index + 3] <= BLACK_TOLERANCE) transparentPixels++;
        else visiblePixels++;
    }
    const hasColor = colorPixels >= Math.max(1, Math.ceil(pixels * 0.0005));
    const hasAlphaShape = transparentPixels > 0 && visiblePixels > 0;
    const mode = requestedMode === "auto" ? (hasColor ? "color" : hasAlphaShape ? "alpha" : "luminance") : requestedMode;
    const output = new Uint8ClampedArray(data.length);
    let activePixels = 0;
    let total = 0;
    let minimum = 255;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let index = 0; index < data.length; index += 4) {
        const alpha = data[index + 3];
        const value =
            mode === "color" ? (coloredPixel(data[index], data[index + 1], data[index + 2], alpha) ? 255 : 0) : mode === "alpha" ? denoise(alpha) : denoise(((0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]) * alpha) / 255);
        output[index] = output[index + 1] = output[index + 2] = value;
        output[index + 3] = 255;
        minimum = Math.min(minimum, value);
        total += value;
        if (value > 0) {
            activePixels++;
            const x = (index / 4) % width;
            const y = Math.floor(index / 4 / width);
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    }
    const reason =
        activePixels === 0 ? (mode === "color" ? "未识别到彩色有效区域，请切换为黑白灰或透明度模式" : "蒙版没有有效区域，请检查图片或切换识别模式") : minimum > BLACK_TOLERANCE ? "蒙版覆盖整张图片，未识别到屏幕外区域，请检查预览并切换识别模式" : undefined;
    const warnings: string[] = [];
    if (mode === "color") warnings.push("彩色区域合并为一个有效区域；黑底和白色边框不参与输出，颜色不对应独立提示词。");
    if (mode === "luminance" && hasColor) warnings.push("当前按亮度读取彩色图片，白色边框也会保留；可切换彩色区域模式。");
    if (activePixels > 0 && activePixels / pixels < 0.001) warnings.push("有效区域小于图片的 0.1%，请确认预览中的屏幕区域。");
    return { width, height, data: output, mode, valid: !reason, reason, coverage: total / (255 * pixels), bounds: activePixels ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : undefined, warnings };
}
