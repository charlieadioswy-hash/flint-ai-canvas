import { resetGenerationTaskMetadata } from "@/lib/canvas/canvas-task-state";
import { model3DFormat } from "@/lib/model3d-formats";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { Model3DImageBinding } from "@/lib/canvas/model3d";

export type ImportedCanvasMedia = { storageKey: string; url: string };
const isBlob = (value?: string) => Boolean(value?.startsWith("blob:"));

/** ZIP 中的 3D 是独立文件副本；任务身份不能跨画布恢复，内部 result 不能继续引用旧文件。 */
export function remapImportedCanvasNode(node: CanvasNodeData, media: ReadonlyMap<string, ImportedCanvasMedia>): CanvasNodeData {
    const metadata = { ...node.metadata };
    const mapped = metadata.storageKey ? media.get(metadata.storageKey) : undefined;
    metadata.storageKey = mapped?.storageKey || (isBlob(metadata.storageKey) ? undefined : metadata.storageKey);
    metadata.content = mapped?.url ?? (isBlob(metadata.content) ? "" : metadata.content);
    metadata.previewContent = mapped?.url ?? (isBlob(metadata.previewContent) ? "" : metadata.previewContent);
    if (node.type !== CanvasNodeType.Model3D) return { ...node, metadata };

    const state = node.metadata?.model3d;
    const result = state?.result;
    const resultMedia = result ? media.get(result.storageKey || `resource:${result.resourceId}`) : undefined;
    // 与查看器一致，存在生成结果时以 result 为准；普通导入模型使用顶层定位。
    const resultKey = resultMedia?.storageKey || result?.storageKey;
    const storageKey = result ? (isBlob(resultKey) ? undefined : resultKey) : metadata.storageKey;
    const content = result ? resultMedia?.url || (isBlob(result.url) ? "" : result.url) : metadata.content;
    const next = resetGenerationTaskMetadata(metadata, storageKey || content ? "success" : "idle");
    delete next.assetId;
    delete next.generationEffectKeys;
    next.storageKey = storageKey;
    next.content = content;
    next.previewContent = content;
    next.mimeType = result?.mimeType || metadata.mimeType;
    next.bytes = result?.bytes ?? metadata.bytes;
    next.model3dFormat = model3DFormat({ format: result?.format || metadata.model3dFormat, fileName: result?.fileName || node.title, mimeType: metadata.mimeType, url: content }) || undefined;
    const remapImage = (image: Model3DImageBinding | undefined): Model3DImageBinding | undefined => {
        if (!image) return undefined;
        const replacement = media.get(image.storageKey || `resource:${image.resourceId}`);
        if (!replacement) return { ...image, url: isBlob(image.url) ? undefined : image.url };
        return { ...image, ...replacement, resourceId: replacement.storageKey.startsWith("resource:") ? replacement.storageKey.slice("resource:".length) : undefined };
    };
    if (state) next.model3d = {
        ...state,
        run: undefined,
        draft: { ...state.draft, parameters: { ...state.draft.parameters }, image: remapImage(state.draft.image), views: Object.fromEntries(Object.entries(state.draft.views).map(([view, image]) => [view, remapImage(image)])) },
        result: result && (storageKey || content) ? { ...result, assetId: "", storageKey: storageKey || "", url: content || "", resourceId: storageKey?.startsWith("resource:") ? storageKey.slice("resource:".length) : "" } : undefined,
    };
    return { ...node, metadata: next };
}
