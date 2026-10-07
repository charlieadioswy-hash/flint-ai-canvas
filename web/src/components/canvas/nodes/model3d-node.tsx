import { lazy, Suspense, useEffect, useState } from "react";
import { Box, Download, LoaderCircle, Maximize2, RefreshCw, Rotate3D, Settings2, X } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import { useCanvasModel3DContext } from "../canvas-model3d-context";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { isModel3DPending, MODEL3D_MODE_LABELS, model3DDownloadName, model3DSourceFingerprint, readModel3DState } from "@/lib/canvas/model3d";
import { downloadBrowserMedia } from "@/services/browser-download";
import { formatBytes } from "@/lib/image-utils";
import type { CanvasNodeData } from "@/types/canvas";

const Viewer = lazy(() => import("./model3d-viewer").then((module) => ({ default: module.Model3DViewer })));

export function Model3DNodeContent({ node, theme, readOnly = false }: { node: CanvasNodeData; theme: CanvasTheme; readOnly?: boolean }) {
    const context = useCanvasModel3DContext();
    const state = readModel3DState(node);
    const run = state.run;
    const format = state.result?.format || node.metadata?.model3dFormat;
    const url = state.result?.url || node.metadata?.content || "";
    const storageKey = state.result?.storageKey || node.metadata?.storageKey;
    const hasModel = Boolean(format && (url || storageKey));
    const [active, setActive] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [downloadError, setDownloadError] = useState("");
    const identity = `${storageKey || url}:${format}`;
    useEffect(() => { setActive(false); setExpanded(false); setDownloadError(""); }, [identity]);
    const editable = Boolean(context && !readOnly);
    const pending = isModel3DPending(run);
    const unknown = run?.status === "submission_unknown" || run?.submissionOutcome === "unknown";
    const changed = Boolean(context && state.resultFingerprint && state.resultFingerprint !== model3DSourceFingerprint(state.draft, context.nodes, context.inputNodes(node.id)));
    const version = context?.capabilities?.modelVersions.find((model) => model.id === state.draft.parameters.model)?.label || state.draft.parameters.model || "选择模型";
    const status = run?.status === "submitting" ? "正在提交" : run?.status === "queued" ? "排队中" : run?.status === "running" ? "生成中" : unknown ? "提交待确认" : run?.status === "failed" ? "生成失败" : run?.status === "cancelled" ? "已取消" : hasModel ? "生成完成" : "待生成";
    const download = async () => {
        if (!format || !editable) return;
        setDownloadError("");
        try { await downloadBrowserMedia({ storageKey, url, fileName: model3DDownloadName({ format, fileName: state.result?.fileName || node.title }) }); }
        catch { setDownloadError("下载暂时不可用，请稍后重试。"); }
    };
    const openParameters = () => { setActive(false); setExpanded(false); context?.openParameters(node.id); };
    const preview = (full: boolean) => hasModel && format ? <Suspense fallback={<div className="flex size-full items-center justify-center text-xs" style={{ color: theme.node.muted }}>加载 3D 查看器…</div>}><Viewer key={`${identity}:${full}`} storageKey={storageKey} url={url} format={format} theme={theme} expanded={full} /></Suspense> : null;
    return <div className="flex size-full flex-col overflow-hidden rounded-[var(--node-radius)]" style={{ background: theme.node.fill, color: theme.node.text }}>
        <div className="relative z-[var(--node-z-overlay)] flex min-h-10 shrink-0 items-center justify-between gap-2 border-b px-4 py-2 text-xs" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
            <span className="flex min-w-0 items-center gap-2"><Box className="size-3.5 shrink-0" /><span className="truncate">{editable ? `${MODEL3D_MODE_LABELS[state.draft.mode]} · ${version}` : `${format?.toUpperCase() || "3D"} 模型`}</span></span>
            {editable ? <button type="button" title="编辑 3D 生成参数" aria-label="编辑 3D 生成参数" className="rounded-[var(--r-md)] p-1.5" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); openParameters(); }}><Settings2 className="size-3.5" /></button> : null}
        </div>
        <div className="relative min-h-0 flex-1">
            {active && !expanded ? preview(false) : <div className="flex size-full flex-col items-center justify-center gap-3 px-5 text-center" style={{ color: theme.node.muted }}><Box className="size-12 opacity-40" /><span className="text-sm">{hasModel ? "模型已就绪" : "文本或参考图生成 3D 模型"}</span><span className="max-w-80 text-xs leading-relaxed">{hasModel ? `${format!.toUpperCase()}${node.metadata?.bytes ? ` · ${formatBytes(node.metadata.bytes)}` : ""}` : "选择生成方式与参数，手动执行后在这里旋转查看结果"}</span>{hasModel ? <button type="button" className="flex items-center gap-2 rounded-[var(--r-md)] border px-3 py-2 text-xs" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={() => setActive(true)}><Rotate3D className="size-3.5" />进入 3D 预览</button> : editable ? <button type="button" className="rounded-[var(--r-md)] border px-3 py-2 text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={openParameters}>设置生成参数</button> : null}</div>}
            {active ? <div className="absolute right-2 top-2 flex gap-1" onMouseDown={(event) => event.stopPropagation()}><button type="button" title="放大预览" aria-label="放大预览" className="rounded-[var(--r-md)] border p-2" style={{ background: theme.node.panel, borderColor: theme.node.stroke }} onClick={() => setExpanded(true)}><Maximize2 className="size-3.5" /></button><button type="button" title="退出旋转预览" aria-label="退出旋转预览" className="rounded-[var(--r-md)] border p-2" style={{ background: theme.node.panel, borderColor: theme.node.stroke }} onClick={() => setActive(false)}><X className="size-3.5" /></button></div> : null}
        </div>
        <div className="shrink-0 space-y-2 border-t px-4 py-3 text-xs" style={{ borderColor: theme.node.stroke }} onMouseDown={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5" style={{ color: run?.status === "failed" || unknown ? "var(--status-warning)" : theme.node.muted }}>{pending ? <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" /> : null}{status}{pending && typeof run?.progress === "number" ? ` · ${Math.round(run.progress)}%` : ""}</span><div className="flex gap-2">{editable && run?.requestId ? <button type="button" title="刷新任务状态" aria-label="刷新任务状态" onClick={() => void context?.refreshTask(node.id)}><RefreshCw className="size-3.5" /></button> : null}{editable && hasModel ? <button type="button" className="flex items-center gap-1.5" onClick={() => void download()}><Download className="size-3.5" />下载 {format?.toUpperCase()}</button> : null}</div></div>
            {changed ? <p style={{ color: theme.node.muted }}>输入或参数已修改，预览为上次生成结果。</p> : null}
            {editable && (run?.error || downloadError) ? <p role="alert" className="leading-relaxed" style={{ color: "var(--status-warning)" }}>{downloadError || run?.error}</p> : null}
            {editable && run?.canRetryStorage ? <button type="button" className="underline underline-offset-2" onClick={() => void context?.refreshTask(node.id, true)}>恢复结果保存</button> : null}
        </div>
        <AppModal flush open={expanded} onCancel={() => setExpanded(false)} footer={null} width="min(1100px, 94vw)" title={`${node.title} · 3D 预览`} destroyOnHidden>
            <div className="h-[min(72vh,760px)] min-h-72">{expanded ? preview(true) : null}</div>
        </AppModal>
    </div>;
}
