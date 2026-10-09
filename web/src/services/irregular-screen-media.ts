import { deriveIrregularScreenMask, type IrregularScreenMaskMode } from "@/lib/canvas/irregular-screen-mask";
import type { IrregularScreenImage } from "@/lib/canvas/irregular-screen-domain";
import { getImageBlob, resolveImageUrl } from "@/services/image-storage";
import { resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { getActiveUserScope } from "@/lib/user-scope";

export type ScreenImage = IrregularScreenImage & { url: string; blob?: Blob; uploadKey?: string };

export async function readScreenImage(blob: Blob) {
    if (!["image/png", "image/jpeg"].includes(blob.type)) throw new Error("请上传 PNG 或 JPEG 图片");
    if (blob.size > 10 * 1024 * 1024) throw new Error("图片不能超过 10 MB");
    const bitmap = await createImageBitmap(blob);
    try {
        if (bitmap.width > 4096 || bitmap.height > 4096) throw new Error("图片宽高不能超过 4096 像素");
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("浏览器无法读取图片");
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height);
    } finally {
        bitmap.close();
    }
}

export async function deriveScreenOutputMask(image: ScreenImage, mode: IrregularScreenMaskMode) {
    const blob = image.blob || (await getImageBlob(image.storageKey));
    if (!blob) throw new Error("蒙版原图读取失败，请重新上传");
    const pixels = await readScreenImage(blob);
    const result = deriveIrregularScreenMask(pixels, mode);
    if (!result.valid) throw new Error(result.reason || "没有识别到有效屏幕区域");
    const canvas = document.createElement("canvas");
    canvas.width = pixels.width;
    canvas.height = pixels.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法生成输出蒙版");
    context.putImageData(new ImageData(new Uint8ClampedArray(result.data), pixels.width, pixels.height), 0, 0);
    const output = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("输出蒙版生成失败"))), "image/png"));
    return {
        image: { storageKey: "", url: URL.createObjectURL(output), blob: output, width: pixels.width, height: pixels.height, name: "屏幕输出蒙版.png", mimeType: "image/png", bytes: output.size } satisfies ScreenImage,
        warnings: result.warnings,
        mode: result.mode,
    };
}

export async function persistScreenImage(image: ScreenImage, idempotencyKey: string, signal?: AbortSignal): Promise<ScreenImage> {
    if (image.storageKey.startsWith("resource:")) return image;
    if (!image.blob) throw new Error("图片尚未准备好，请重新上传");
    const scope = getActiveUserScope();
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const resource = await uploadResourceFile(image.blob, "image", { fileName: image.name, width: image.width, height: image.height, idempotencyKey });
    if (scope !== getActiveUserScope() || signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return { ...image, storageKey: resourceStorageKey(resource.id), bytes: resource.size, mimeType: resource.mimeType };
}

export async function screenImageFromNode(node: { title: string; metadata?: { storageKey?: string; assetId?: string; naturalWidth?: number; naturalHeight?: number; mimeType?: string; bytes?: number } }): Promise<ScreenImage | null> {
    const metadata = node.metadata;
    if (!metadata?.storageKey || !metadata.naturalWidth || !metadata.naturalHeight) return null;
    return { storageKey: metadata.storageKey, assetId: metadata.assetId, width: metadata.naturalWidth, height: metadata.naturalHeight, name: node.title, url: await resolveImageUrl(metadata.storageKey), mimeType: metadata.mimeType, bytes: metadata.bytes };
}
