import { useEffect, useRef, useState } from "react";
import { Select } from "antd";

import { AppModal } from "@/components/ui/product/app-modal";
import { model3DFileName, model3DFormat, type Model3DExportFormat } from "@/lib/model3d-formats";
import { downloadBrowserMedia } from "@/services/browser-download";
import type { ModelAsset } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";

export function AssetModelDownloadModal({ asset, ownerId, onClose }: { asset: ModelAsset; ownerId: string; onClose: () => void }) {
    const [targetFormat, setTargetFormat] = useState<Model3DExportFormat | "original">("original");
    const [exporting, setExporting] = useState(false);
    const [error, setError] = useState("");
    const operation = useRef<AbortController | null>(null);
    const format = model3DFormat(asset.data);
    const fileName = format ? model3DFileName(asset.title || asset.data.fileName, format) : asset.data.fileName || asset.title || "model";
    const converting = targetFormat !== "original" && targetFormat !== format;

    useEffect(() => {
        setTargetFormat("original");
        setError("");
        setExporting(false);
        // Subscribe synchronously so switching away and back cannot revive an
        // old conversion while its dynamic imports are still pending.
        const unsubscribe = useUserStore.subscribe((state) => {
            if ((state.user?.id || "") !== ownerId) operation.current?.abort();
        });
        return () => {
            unsubscribe();
            operation.current?.abort();
            operation.current = null;
        };
    }, [asset, ownerId]);

    const close = () => {
        operation.current?.abort();
        onClose();
    };
    const download = async () => {
        if (operation.current || (useUserStore.getState().user?.id || "") !== ownerId) return;
        const controller = new AbortController();
        operation.current = controller;
        const current = () => operation.current === controller && !controller.signal.aborted && (useUserStore.getState().user?.id || "") === ownerId;
        setExporting(true);
        setError("");
        try {
            if (!converting) {
                await downloadBrowserMedia({ storageKey: asset.data.storageKey, url: asset.data.url, fileName }, controller.signal);
            } else {
                if (!format) throw new Error("此模型格式暂不支持转换，请下载原文件。");
                const { exportModel3D } = await import("@/lib/model3d-export");
                if (!current()) return;
                const result = await exportModel3D({ storageKey: asset.data.storageKey, url: asset.data.url, format, fileName }, targetFormat, controller.signal);
                if (!current()) return;
                const { saveAs } = await import("file-saver");
                if (current()) saveAs(result.blob, result.fileName);
            }
        } catch (cause) {
            if (current()) setError(cause instanceof Error ? cause.message : "下载失败，请重试。");
        } finally {
            if (current()) {
                operation.current = null;
                setExporting(false);
            }
        }
    };

    return (
        <AppModal
            open
            title="下载模型"
            okText={exporting ? (converting ? "正在转换…" : "正在准备下载…") : "下载"}
            cancelText="取消"
            okButtonProps={{ loading: exporting }}
            onOk={() => void download()}
            onCancel={close}
        >
            <div className="flex flex-col gap-3">
                <p className="truncate font-medium text-foreground" title={asset.title}>
                    {asset.title || asset.data.fileName}
                </p>
                <label htmlFor="asset-model-download-format" className="text-sm text-muted-foreground">
                    下载格式
                </label>
                <Select<Model3DExportFormat | "original">
                    id="asset-model-download-format"
                    aria-label="模型下载格式"
                    value={targetFormat}
                    onChange={setTargetFormat}
                    disabled={exporting}
                    options={[
                        { value: "original", label: format ? `原文件（${format.toUpperCase()}）` : "原文件" },
                        { value: "glb", label: "GLB（含材质）", disabled: !format },
                        { value: "gltf", label: "GLTF（自包含）", disabled: !format },
                        { value: "obj", label: "OBJ（几何，无贴图）", disabled: !format },
                        { value: "stl", label: "STL（几何，无贴图）", disabled: !format },
                    ]}
                />
                <p className="text-sm text-muted-foreground">资产库保留原文件，选择其他格式下载不会覆盖原文件。OBJ、STL 不包含贴图。</p>
                {!format ? <p className="text-sm text-muted-foreground">此格式暂不支持转换，可以下载原文件。</p> : null}
                {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            </div>
        </AppModal>
    );
}
