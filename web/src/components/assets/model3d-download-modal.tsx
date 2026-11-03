import { useEffect, useRef, useState } from "react";
import { Select } from "antd";

import { AppModal } from "@/components/ui/product/app-modal";
import { Model3DExportSettings } from "@/components/assets/model3d-export-settings";
import { model3DFileName, model3DFormat, type Model3DExportFormat, type Model3DFormatSource } from "@/lib/model3d-formats";
import { downloadBrowserMedia } from "@/services/browser-download";
import { downloadModel3D } from "@/services/model3d-download";
import { useUserStore } from "@/stores/use-user-store";

export function Model3DDownloadModal({ source, sourceId, title, ownerId, onClose }: { source: Model3DFormatSource & { url: string; storageKey?: string }; sourceId: string; title?: string; ownerId: string; onClose: () => void }) {
    const [targetFormat, setTargetFormat] = useState<Model3DExportFormat | "original">("original");
    const [exporting, setExporting] = useState(false);
    const [error, setError] = useState("");
    const [animation, setAnimation] = useState<string>();
    const [fps, setFps] = useState(30);
    const [settingsReady, setSettingsReady] = useState(true);
    const [stage, setStage] = useState("");
    const operation = useRef<AbortController | null>(null);
    const format = model3DFormat(source);
    const fileName = format ? model3DFileName(title || source.fileName, format) : source.fileName || title || "model";
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
    }, [sourceId, source.storageKey, source.url, format, fileName, ownerId]);

    const close = () => {
        operation.current?.abort();
        onClose();
    };
    const download = async () => {
        if (operation.current || !settingsReady || (useUserStore.getState().user?.id || "") !== ownerId) return;
        const controller = new AbortController();
        operation.current = controller;
        const current = () => operation.current === controller && !controller.signal.aborted && (useUserStore.getState().user?.id || "") === ownerId;
        setExporting(true);
        setError("");
        setStage("");
        try {
            if (!converting) {
                await downloadBrowserMedia({ storageKey: source.storageKey, url: source.url, fileName }, controller.signal);
            } else {
                if (!format) throw new Error("此模型格式暂不支持转换，请下载原文件。");
                await downloadModel3D({ storageKey: source.storageKey, url: source.url, format, fileName }, targetFormat, {
                    signal: controller.signal,
                    animation,
                    fps,
                    onProgress: (task) => {
                        if (current()) setStage(`${task.stage}${task.progress ? ` · ${task.progress}%` : ""}`);
                    },
                });
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
        <AppModal open title="下载模型" okText={exporting ? (converting ? "正在转换…" : "正在准备下载…") : "下载"} cancelText="取消" okButtonProps={{ loading: exporting, disabled: !settingsReady }} onOk={() => void download()} onCancel={close}>
            <div className="flex flex-col gap-3">
                <p className="truncate font-medium text-foreground" title={title}>
                    {title || source.fileName}
                </p>
                <label htmlFor="asset-model-download-format" className="text-sm text-muted-foreground">
                    下载格式
                </label>
                <Select<Model3DExportFormat | "original">
                    id="asset-model-download-format"
                    aria-label="模型下载格式"
                    value={targetFormat}
                    onChange={(value) => {
                        setSettingsReady(value !== "abc");
                        setTargetFormat(value);
                    }}
                    disabled={exporting}
                    options={[
                        { value: "original", label: format ? `原文件（${format.toUpperCase()}）` : "原文件" },
                        { value: "glb", label: "GLB（含材质）", disabled: !format },
                        { value: "gltf", label: "GLTF（自包含）", disabled: !format },
                        { value: "fbx", label: "FBX", disabled: !format },
                        { value: "abc", label: "ABC（Alembic 几何缓存）", disabled: !format },
                        { value: "obj", label: "OBJ（几何，无贴图）", disabled: !format },
                        { value: "stl", label: "STL（几何，无贴图）", disabled: !format },
                    ]}
                />
                {format ? (
                    <Model3DExportSettings
                        source={{ storageKey: source.storageKey, url: source.url, format, fileName }}
                        target={targetFormat}
                        animation={animation}
                        fps={fps}
                        disabled={exporting}
                        onAnimationChange={setAnimation}
                        onFpsChange={setFps}
                        onReadyChange={setSettingsReady}
                    />
                ) : null}
                {exporting && stage ? (
                    <p role="status" className="text-sm text-muted-foreground">
                        {stage}
                    </p>
                ) : null}
                <p className="text-sm text-muted-foreground">选择其他格式下载不会覆盖模型原文件。OBJ、STL 不包含贴图。</p>
                {!format ? <p className="text-sm text-muted-foreground">此格式暂不支持转换，可以下载原文件。</p> : null}
                {error ? (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                ) : null}
            </div>
        </AppModal>
    );
}
