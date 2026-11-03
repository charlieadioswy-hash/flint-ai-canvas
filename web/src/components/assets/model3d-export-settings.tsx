import { useEffect, useState } from "react";
import { InputNumber, Select } from "antd";

import type { Model3DSource } from "@/lib/canvas/model3d-preview";
import type { Model3DExportFormat } from "@/lib/model3d-formats";

export function Model3DExportSettings({
    source,
    target,
    animation,
    fps,
    disabled,
    onAnimationChange,
    onFpsChange,
    onReadyChange,
}: {
    source: Model3DSource;
    target: Model3DExportFormat | "original";
    animation?: string;
    fps: number;
    disabled: boolean;
    onAnimationChange: (value: string | undefined) => void;
    onFpsChange: (value: number) => void;
    onReadyChange: (ready: boolean) => void;
}) {
    const [clips, setClips] = useState<Array<{ name: string; duration: number }>>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const identity = `${source.storageKey || source.url}:${source.format}`;
    useEffect(() => {
        onAnimationChange(undefined);
        setError("");
        setClips([]);
        if (target !== "abc") {
            setLoading(false);
            onReadyChange(true);
            return;
        }
        const controller = new AbortController();
        setLoading(true);
        onReadyChange(false);
        void (async () => {
            const { loadModel3D } = await import("@/lib/canvas/model3d-preview");
            const { disposePrevisObject3D } = await import("@/lib/canvas/previs/previs-resources");
            controller.signal.throwIfAborted();
            const model = await loadModel3D(source, controller.signal);
            try {
                controller.signal.throwIfAborted();
                const animations = model.animations.filter((clip) => clip.duration >= 0 && Number.isFinite(clip.duration)).map((clip) => ({ name: clip.name, duration: clip.duration }));
                if (animations.some((clip) => !clip.name) || new Set(animations.map((clip) => clip.name)).size !== animations.length) throw new Error("动作名称为空或重复，请先在建模软件中命名后重新导入。");
                setClips(animations);
                if (animations.length === 1) onAnimationChange(animations[0].name);
                onReadyChange(animations.length <= 1);
            } finally {
                disposePrevisObject3D(model);
            }
        })()
            .catch((cause: unknown) => {
                if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取模型动作失败，请重试。");
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [identity, target, onAnimationChange, onReadyChange]);

    if (target !== "fbx" && target !== "abc") return null;
    if (target === source.format) return null;
    return (
        <div className="flex w-full flex-col gap-2 text-sm text-muted-foreground">
            {!source.storageKey?.startsWith("resource:") ? <p>点击下载时，将把此模型上传到服务器进行格式转换。</p> : null}
            {target === "fbx" ? (
                <p>FBX 会转换材质；贴图和 PBR 效果可能与原模型不同。</p>
            ) : (
                <>
                    <p>ABC 是几何缓存，动画会烘焙为顶点运动，不保留可编辑骨骼和着色器。贴图需在目标软件中重新连接。</p>
                    {loading ? <p role="status">正在本机读取模型动作…</p> : null}
                    {!loading && !error ? (
                        <div className="flex flex-wrap items-center gap-2">
                            {clips.length ? (
                                <Select
                                    aria-label="ABC 导出动作"
                                    className="min-w-44"
                                    value={animation}
                                    placeholder="请选择一个动作"
                                    disabled={disabled}
                                    options={clips.map((clip) => ({ value: clip.name, label: `${clip.name}（${clip.duration.toFixed(2)} 秒）` }))}
                                    onChange={(value) => {
                                        onAnimationChange(value);
                                        onReadyChange(true);
                                    }}
                                />
                            ) : (
                                <span>静态模型：导出单帧</span>
                            )}
                            <label className="flex items-center gap-2">
                                帧率
                                <InputNumber
                                    aria-label="ABC 导出帧率"
                                    min={1}
                                    max={120}
                                    precision={0}
                                    value={fps}
                                    disabled={disabled}
                                    onChange={(value) => {
                                        if (value !== null) onFpsChange(value);
                                    }}
                                />
                                fps
                            </label>
                        </div>
                    ) : null}
                </>
            )}
            {error ? (
                <p role="alert" className="text-destructive">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
