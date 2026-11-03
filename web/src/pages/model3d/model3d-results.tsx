import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Button, Select } from "antd";
import { Box, Check, Download, FileBox, LoaderCircle, PencilLine, RefreshCw, Upload, X } from "lucide-react";
import type { Model3DWorkflowTask } from "./use-model3d-workflow";
import { generationTaskProgress } from "@/lib/generation-task-display";
import { MODEL3D_MODE_LABELS } from "@/lib/canvas/model3d";
import { downloadBrowserMedia } from "@/services/browser-download";
import { downloadModel3D } from "@/services/model3d-download";
import { Model3DExportSettings } from "@/components/assets/model3d-export-settings";
import { useUserStore } from "@/stores/use-user-store";
import { model3DFormat, type Model3DExportFormat, type Model3DPreviewFormat } from "@/lib/model3d-formats";
import type { Model3DProcessing, Model3DProcessingOperation } from "@/services/api/model3d";
import { Model3DProcessingPanel } from "./model3d-processing-panel";
import { MODEL3D_PROCESSING_LABELS, MODEL3D_RIG_LABELS } from "./model3d-processing-state";

const Viewer = lazy(() => import("@/components/assets/model3d-viewer").then((module) => ({ default: module.Model3DViewer })));

export function Model3DTaskProgress({ task }: { task: Model3DWorkflowTask }) {
    const progress = task.localStatus || task.submissionOutcome === "unknown" ? undefined : generationTaskProgress(task);
    const pending = task.status === "queued" || task.status === "running";
    const label =
        task.localStatus === "submitting"
            ? "正在提交"
            : task.localStatus === "submission_unknown" || task.submissionOutcome === "unknown"
              ? "提交待确认"
              : task.status === "succeeded"
                ? "已完成"
                : task.status === "failed"
                  ? "失败"
                  : task.status === "cancelled"
                    ? "已取消"
                    : task.stage || (task.status === "queued" ? "排队中" : "生成中");
    return (
        <div className="model3d-task-status" aria-live="polite">
            <span>
                {pending ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" /> : task.status === "succeeded" ? <Check className="size-3.5" /> : null}
                {label}
                {progress !== undefined ? ` · ${progress}%` : ""}
            </span>
            {progress !== undefined ? <progress max={100} value={progress} aria-label="3D 任务进度" /> : null}
        </div>
    );
}

type PreviewSource = { storageKey?: string; url: string; format: Model3DPreviewFormat; fileName: string };

export function Model3DResults({
    tasks,
    selectedTask,
    loading,
    refreshing,
    hasMore,
    editingDisabled,
    onSelect,
    onRefresh,
    onRecover,
    onReuse,
    onLoadMore,
    processingOperations = [],
    onProcess,
    onSource,
    onFindSegmentation,
}: {
    tasks: Model3DWorkflowTask[];
    selectedTask?: Model3DWorkflowTask;
    loading: boolean;
    refreshing: boolean;
    hasMore: boolean;
    editingDisabled: boolean;
    onSelect: (id: string) => void;
    onRefresh: () => void;
    onRecover: (id: string) => void;
    onReuse: (task: Model3DWorkflowTask) => void;
    onLoadMore: () => void;
    processingOperations?: Model3DProcessingOperation[];
    onProcess?: (processing: Model3DProcessing) => void;
    onSource?: (id: string) => void;
    onFindSegmentation?: (id: string) => Promise<boolean>;
}) {
    const [local, setLocal] = useState<PreviewSource | null>(null);
    const [targetFormat, setTargetFormat] = useState<Model3DExportFormat | "original">("original");
    const [exporting, setExporting] = useState(false);
    const [error, setError] = useState("");
    const [animation, setAnimation] = useState<string>();
    const [fps, setFps] = useState(30);
    const [settingsReady, setSettingsReady] = useState(true);
    const [exportStage, setExportStage] = useState("");
    const input = useRef<HTMLInputElement>(null);
    const operation = useRef<AbortController | null>(null);
    const result = selectedTask?.status === "succeeded" ? selectedTask.result : undefined;
    const source: PreviewSource | undefined = local || (result?.resourceId ? { storageKey: result.storageKey, url: result.url, format: result.format, fileName: result.fileName } : undefined);
    const identity = `${source?.storageKey || source?.url || ""}:${source?.format || ""}`;
    useEffect(
        () => () => {
            if (local) URL.revokeObjectURL(local.url);
        },
        [local],
    );
    useEffect(() => {
        setTargetFormat("original");
        setError("");
        setExporting(false);
        setSettingsReady(true);
        const ownerId = useUserStore.getState().user?.id;
        const unsubscribe = useUserStore.subscribe((state) => {
            if (state.user?.id !== ownerId) operation.current?.abort();
        });
        return () => {
            unsubscribe();
            operation.current?.abort();
            operation.current = null;
        };
    }, [identity]);
    const download = async () => {
        if (!source || operation.current || !settingsReady) return;
        const controller = new AbortController();
        operation.current = controller;
        setExporting(true);
        setError("");
        setExportStage("");
        const current = () => operation.current === controller && !controller.signal.aborted;
        try {
            if (targetFormat === "original") await downloadBrowserMedia(source, controller.signal);
            else {
                await downloadModel3D(source, targetFormat, {
                    signal: controller.signal,
                    animation,
                    fps,
                    onProgress: (task) => {
                        if (current()) setExportStage(`${task.stage}${task.progress ? ` · ${task.progress}%` : ""}`);
                    },
                });
            }
        } catch (cause) {
            if (current()) setError(cause instanceof Error ? cause.message : "导出失败，请重试。");
        } finally {
            if (current()) {
                operation.current = null;
                setExporting(false);
            }
        }
    };
    return (
        <div className="model3d-results">
            <section className="model3d-preview-panel" aria-label="3D 产物预览">
                <header className="model3d-panel-heading">
                    <div>
                        <h2>{local ? "本地模型预览" : "版本预览"}</h2>
                        <p className="model3d-hint">{source ? `${source.format.toUpperCase()} · 拖动旋转，滚轮缩放` : "选择一个候选版本，查看生成进度与模型"}</p>
                    </div>
                    <div className="model3d-choices">
                        {!local && selectedTask && !selectedTask.processing ? (
                            <Button size="small" disabled={editingDisabled} icon={<PencilLine className="size-3.5" />} title="载入此版本的输入，修改后确认生成新版本" onClick={() => onReuse(selectedTask)}>
                                修改后生成新版本
                            </Button>
                        ) : null}
                        <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => input.current?.click()}>
                            导入模型预览
                        </Button>
                    </div>
                </header>
                <input
                    ref={input}
                    type="file"
                    accept=".glb,.gltf,.fbx,.obj,.stl"
                    className="sr-only"
                    tabIndex={-1}
                    aria-label="导入模型预览"
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (!file) return;
                        const format = model3DFormat({ fileName: file.name });
                        if (!format) {
                            setError("请选择 GLB、GLTF、FBX、OBJ 或 STL 文件。");
                            return;
                        }
                        if (file.size > 128 * 1024 * 1024 || file.size === 0) {
                            setError("模型文件须大于 0 且不超过 128 MiB。");
                            return;
                        }
                        setLocal({ url: URL.createObjectURL(file), format, fileName: file.name });
                    }}
                />
                <div className="model3d-preview-stage">
                    {source ? (
                        <Suspense
                            fallback={
                                <div className="model3d-preview-empty">
                                    <LoaderCircle className="size-8 animate-spin motion-reduce:animate-none" />
                                    <p>正在加载查看器</p>
                                </div>
                            }
                        >
                            <Viewer key={identity} storageKey={source.storageKey} url={source.url} format={source.format} partNames={!local ? result?.parts : undefined} expanded />
                        </Suspense>
                    ) : (
                        <div className="model3d-preview-empty">
                            <Box className="model3d-preview-icon" strokeWidth={1} />
                            {selectedTask ? (
                                <>
                                    <h3>
                                        {selectedTask.rigCheck
                                            ? selectedTask.rigCheck.riggable
                                                ? "模型可以自动绑骨"
                                                : "模型暂不适合自动绑骨"
                                            : selectedTask.status === "failed"
                                              ? "这个版本未完成"
                                              : selectedTask.status === "cancelled"
                                                ? "这个任务已取消"
                                                : "模型正在准备中"}
                                    </h3>
                                    {selectedTask.rigCheck?.riggable ? <p>检测骨架：{MODEL3D_RIG_LABELS[selectedTask.rigCheck.rigType] || selectedTask.rigCheck.rigType}，可在下方继续绑骨。</p> : null}
                                    <Model3DTaskProgress task={selectedTask} />
                                    {selectedTask.localError || selectedTask.error?.message ? (
                                        <p role="alert" className="model3d-error">
                                            {selectedTask.localError || selectedTask.error?.message}
                                        </p>
                                    ) : null}
                                    {selectedTask.canRetryStorage ? <Button onClick={() => onRecover(selectedTask.id)}>恢复原任务保存</Button> : null}
                                </>
                            ) : (
                                <>
                                    <h3>把你的想法变成 3D 模型</h3>
                                    <p>输入描述或上传图片，生成后在这里旋转、检查和导出。</p>
                                </>
                            )}
                        </div>
                    )}
                </div>
                {local ? (
                    <div className="model3d-preview-note">
                        <span>仅在本机预览。支持自包含模型；外置贴图请先打包为 GLB。</span>
                        <Button size="small" type="text" icon={<X className="size-3" />} onClick={() => setLocal(null)}>
                            返回任务产物
                        </Button>
                    </div>
                ) : null}
                <footer className="model3d-export-bar">
                    {source ? (
                        <>
                            <Select
                                aria-label="导出格式"
                                value={targetFormat}
                                onChange={(value) => {
                                    setSettingsReady(value !== "abc");
                                    setTargetFormat(value);
                                }}
                                disabled={exporting}
                                options={[
                                    { value: "original", label: `原文件（${source.format.toUpperCase()}）` },
                                    { value: "glb", label: "GLB（含材质）" },
                                    { value: "gltf", label: "GLTF（自包含）" },
                                    { value: "fbx", label: "FBX" },
                                    { value: "abc", label: "ABC（Alembic 几何缓存）" },
                                    { value: "obj", label: "OBJ（静态几何，无贴图）" },
                                    { value: "stl", label: "STL（静态几何，无贴图）" },
                                ]}
                            />
                            <Button icon={<Download className="size-4" />} loading={exporting} disabled={!settingsReady} onClick={() => void download()}>
                                下载模型
                            </Button>
                            {exporting ? (
                                <Button
                                    onClick={() => {
                                        operation.current?.abort();
                                        operation.current = null;
                                        setExporting(false);
                                        setExportStage("");
                                    }}
                                >
                                    取消导出
                                </Button>
                            ) : null}
                            <Model3DExportSettings source={source} target={targetFormat} animation={animation} fps={fps} disabled={exporting} onAnimationChange={setAnimation} onFpsChange={setFps} onReadyChange={setSettingsReady} />
                            {exporting && exportStage ? (
                                <p role="status" className="model3d-hint">
                                    {exportStage}
                                </p>
                            ) : null}
                        </>
                    ) : (
                        <p className="model3d-hint">支持 GLB / GLTF / FBX / OBJ / STL 预览</p>
                    )}
                    {!local && selectedTask?.status === "succeeded" && result?.resourceId ? (
                        <span className="model3d-saved">
                            <Check className="size-3.5" />
                            已保存到资产库
                        </span>
                    ) : null}
                </footer>
                {error ? (
                    <p role="alert" className="model3d-error model3d-export-error">
                        {error}
                    </p>
                ) : null}
                {!local && selectedTask && onProcess ? (
                    <Model3DProcessingPanel
                        key={`${selectedTask.id}:${selectedTask.status}:${processingOperations.join(",")}`}
                        task={selectedTask}
                        enabled={processingOperations}
                        disabled={editingDisabled}
                        onProcess={onProcess}
                        onSource={onSource || onSelect}
                        onFindSegmentation={onFindSegmentation}
                    />
                ) : null}
            </section>
            <section className="model3d-history" aria-label="3D 历史版本">
                <header className="model3d-panel-heading">
                    <div>
                        <h2>历史版本</h2>
                        <p className="model3d-hint">自动同步进度；切换版本只查看结果，需要调整时点击「修改后生成新版本」。</p>
                    </div>
                    <Button size="small" title="同步任务列表、进度和结果，不重新生成" icon={<RefreshCw className="size-3.5" />} loading={refreshing} onClick={onRefresh}>
                        刷新任务
                    </Button>
                </header>
                {loading && tasks.length === 0 ? (
                    <p role="status" className="model3d-history-empty">
                        正在读取任务…
                    </p>
                ) : tasks.length === 0 ? (
                    <p className="model3d-history-empty">还没有独立 3D 任务，从左侧开始一次创作。</p>
                ) : (
                    <div className="model3d-task-list">
                        {tasks.map((task) => (
                            <article key={task.id} className={`model3d-task-card${!local && selectedTask?.id === task.id ? " is-selected" : ""}`}>
                                <button
                                    type="button"
                                    className="model3d-task-select"
                                    aria-pressed={!local && selectedTask?.id === task.id}
                                    onClick={() => {
                                        setLocal(null);
                                        onSelect(task.id);
                                    }}
                                >
                                    <span className="model3d-task-icon">
                                        <FileBox className="size-5" />
                                    </span>
                                    <span className="model3d-task-copy">
                                        <strong>
                                            {task.processing ? `${MODEL3D_PROCESSING_LABELS[task.processing.operation]} · ` : ""}
                                            {task.prompt?.trim() || `${MODEL3D_MODE_LABELS[task.mode]}生成模型`}
                                        </strong>
                                        <small>
                                            {task.processing
                                                ? task.processing.model || MODEL3D_PROCESSING_LABELS[task.processing.operation]
                                                : `${task.parameters?.model || "3D"} · ${task.parameters?.faceLimit ? `${task.parameters.faceLimit.toLocaleString()} 面` : "自动面数"}`}
                                            {task.groupId ? ` · 本批候选 ${task.candidateIndex}/${task.candidateCount}` : ""} ·{" "}
                                            {new Date(task.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                                        </small>
                                        <Model3DTaskProgress task={task} />
                                    </span>
                                </button>
                                {!task.processing ? (
                                    <Button
                                        type="text"
                                        size="small"
                                        disabled={editingDisabled}
                                        icon={<PencilLine className="size-3.5" />}
                                        title="载入此版本的输入，修改后确认生成新版本"
                                        onClick={() => {
                                            setLocal(null);
                                            onReuse(task);
                                        }}
                                    >
                                        修改后生成新版本
                                    </Button>
                                ) : null}
                            </article>
                        ))}
                    </div>
                )}
                {hasMore ? (
                    <Button block loading={loading} onClick={onLoadMore}>
                        加载更多历史任务
                    </Button>
                ) : null}
            </section>
        </div>
    );
}
