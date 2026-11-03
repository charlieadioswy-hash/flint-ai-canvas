import type { Model3DSource } from "@/lib/canvas/model3d-preview";
import { model3DFileName, type Model3DExportFormat, type Model3DServerExportFormat } from "@/lib/model3d-formats";
import { prepareModel3DConversionSource } from "@/lib/model3d-conversion-source";
import { cancelModel3DExport, cancelModel3DExportRequest, createModel3DExport, getModel3DExport, getModel3DExportCapabilities, type Model3DExportTask } from "@/services/api/model3d-exports";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { downloadBrowserMedia } from "@/services/browser-download";
import { useUserStore } from "@/stores/use-user-store";

export type Model3DDownloadOptions = {
    signal?: AbortSignal;
    animation?: string;
    fps?: number;
    onProgress?: (task: Model3DExportTask) => void;
};

function waitForPoll(signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();
        const abort = () => {
            clearTimeout(timer);
            reject(new DOMException("导出已取消", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, 1000);
        signal.addEventListener("abort", abort, { once: true });
    });
}

export async function convertModel3DOnServer(source: Model3DSource, format: Model3DServerExportFormat, options: Model3DDownloadOptions = {}) {
    const controller = new AbortController();
    const signal = controller.signal;
    const ownerId = useUserStore.getState().user?.id;
    const requestId = crypto.randomUUID();
    let taskId = "";
    let submitted = false;
    let terminal = false;
    const cancel = () => {
        if (!submitted || terminal) return;
        // A request cancellation also fences a POST whose response was lost.
        const pending = taskId ? cancelModel3DExport(taskId) : cancelModel3DExportRequest(requestId);
        void pending.catch(() => undefined);
    };
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    signal.addEventListener("abort", cancel, { once: true });
    const unsubscribe = useUserStore.subscribe((state) => {
        if (state.user?.id !== ownerId) controller.abort();
    });
    try {
        options.signal?.throwIfAborted();
        const capabilities = await getModel3DExportCapabilities(signal);
        signal.throwIfAborted();
        if (!capabilities.available || !capabilities.formats.includes(format)) throw new Error("模型转换服务暂不可用，请联系管理员启用后重试。");
        const resourceId = source.storageKey ? resourceIdFromStorageKey(source.storageKey) : undefined;
        const prepared = await prepareModel3DConversionSource(source, resourceId || undefined, signal);
        signal.throwIfAborted();
        submitted = true;
        let task = await createModel3DExport(
            { requestId, resourceId: prepared.resourceId, sourceFormat: prepared.sourceFormat, fileName: prepared.fileName, format, animation: format === "abc" ? options.animation : undefined, fps: format === "abc" ? (options.fps ?? 30) : undefined },
            prepared.file,
            signal,
        );
        taskId = task.id;
        while (true) {
            signal.throwIfAborted();
            options.onProgress?.(task);
            if (task.status === "succeeded") {
                terminal = true;
                if (!task.result || task.result.format !== format) throw new Error("模型导出结果无效，请重试。");
                return task.result;
            }
            if (task.status === "failed" || task.status === "cancelled") {
                terminal = true;
                if (task.status === "cancelled") throw new DOMException("导出已取消", "AbortError");
                throw new Error(task.error || "模型转换失败，请重试。");
            }
            await waitForPoll(signal);
            task = await getModel3DExport(taskId, signal);
        }
    } catch (error) {
        if (!signal.aborted) cancel();
        throw error;
    } finally {
        unsubscribe();
        options.signal?.removeEventListener("abort", abort);
        signal.removeEventListener("abort", cancel);
    }
}

/** Native downloads bypass the converter, including its availability request. */
export async function downloadModel3D(source: Model3DSource, target: Model3DExportFormat | "original", options: Model3DDownloadOptions = {}) {
    options.signal?.throwIfAborted();
    if (target === "original" || target === source.format) {
        await downloadBrowserMedia({ ...source, fileName: source.fileName || model3DFileName(undefined, source.format) }, options.signal);
    } else if (target === "fbx" || target === "abc") {
        const result = await convertModel3DOnServer(source, target, options);
        options.signal?.throwIfAborted();
        await downloadBrowserMedia(result, options.signal);
    } else {
        const { exportModel3D } = await import("@/lib/model3d-export");
        options.signal?.throwIfAborted();
        const result = await exportModel3D(source, target, options.signal);
        options.signal?.throwIfAborted();
        const { saveAs } = await import("file-saver");
        options.signal?.throwIfAborted();
        saveAs(result.blob, result.fileName);
    }
}
