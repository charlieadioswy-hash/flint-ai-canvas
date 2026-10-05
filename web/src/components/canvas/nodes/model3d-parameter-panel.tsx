import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Collapse, Input, InputNumber, Select, Switch } from "antd";
import { Box, RefreshCw, Upload, X } from "lucide-react";

import { CachedResourceImage } from "@/components/cached-resource-image";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { isModel3DPending, MODEL3D_MODE_LABELS, MODEL3D_VIEWS, MODEL3D_VIEW_LABELS, model3DFaceRange, model3DImageBinding, model3DInputError, model3DParametersForModel, normalizeModel3DParameters, readModel3DState, resolveModel3DImage, type Model3DDraft, type Model3DImageBinding } from "@/lib/canvas/model3d";
import type { Model3DCapabilities, Model3DParameters, Model3DView } from "@/services/api/model3d";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

type Props = {
    node: CanvasNodeData; theme: CanvasTheme; nodes: CanvasNodeData[]; inputNodes: CanvasNodeData[]; capabilities: Model3DCapabilities | null; capabilityError: string;
    onChange: (update: (draft: Model3DDraft) => Model3DDraft) => void;
    onGenerate: () => void; onRefresh: () => void; onReloadConfig: () => void; onClose: () => void;
    onUpload: (file: File) => Promise<Model3DImageBinding>;
};

export function Model3DParameterPanel({ node, theme, nodes, inputNodes, capabilities, capabilityError, onChange: onDraftChange, onGenerate, onRefresh, onReloadConfig, onClose, onUpload }: Props) {
    const { draft, run } = readModel3DState(node);
    const parameters = normalizeModel3DParameters(draft.mode, draft.parameters, capabilities);
    const version = capabilities?.modelVersions.find((model) => model.id === parameters.model);
    const advanced = version?.supportsAdvanced;
    const faceRange = model3DFaceRange(normalizeModel3DParameters(draft.mode, parameters, capabilities), capabilities);
    const pending = isModel3DPending(run);
    const uncertain = run?.status === "submission_unknown" || run?.submissionOutcome === "unknown";
    const inputError = model3DInputError(draft, nodes, inputNodes, capabilities);
    const onChange = (update: (draft: Model3DDraft) => Model3DDraft) => onDraftChange((current) => {
        const next = update(current);
        return { ...next, parameters: normalizeModel3DParameters(next.mode, next.parameters, capabilities) };
    });
    const setParameter = <K extends keyof Model3DParameters>(key: K, value: Model3DParameters[K]) => onChange((current) => ({ ...current, parameters: { ...current.parameters, [key]: value } }));
    const setImage = (view: Model3DView | "image", binding?: Model3DImageBinding) => onChange((current) => view === "image" ? { ...current, image: binding } : { ...current, views: { ...current.views, [view]: binding } });
    const connectedIds = new Set(inputNodes.map((item) => item.id));
    const images = nodes.filter((item) => item.type === CanvasNodeType.Image && (item.metadata?.storageKey || item.metadata?.content)).sort((a, b) => Number(connectedIds.has(b.id)) - Number(connectedIds.has(a.id)));

    return <section className="flex max-h-[min(76vh,760px,var(--canvas-node-panel-max-height,760px))] flex-col overflow-hidden rounded-[var(--panel-radius)] border shadow-[var(--shadow-panel)]" style={{ background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }} data-canvas-no-zoom data-canvas-wheel-scroll onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} aria-label="3D 模型生成参数">
        <header className="flex shrink-0 items-center justify-between border-b px-4 py-3" style={{ borderColor: theme.node.stroke }}><span className="flex items-center gap-2 text-sm font-medium"><Box className="size-4" />3D 模型生成</span><button type="button" title="关闭参数面板" aria-label="关闭参数面板" className="rounded-[var(--r-md)] p-1" onClick={onClose}><X className="size-4" /></button></header>
        <div className="thin-scrollbar min-h-0 space-y-4 overflow-y-auto p-4">
            <div className="flex gap-1 rounded-[var(--r-md)] border p-1" style={{ borderColor: theme.node.stroke }} aria-label="生成模式">{(["text", "image", "multiview"] as const).map((mode) => <button type="button" key={mode} aria-pressed={draft.mode === mode} disabled={Boolean(capabilities && !capabilities.modes.includes(mode))} className="flex-1 rounded-[var(--r-md)] px-2 py-2 text-xs disabled:opacity-40" style={{ color: draft.mode === mode ? theme.toolbar.activeText : theme.node.muted, background: draft.mode === mode ? theme.toolbar.activeBg : "transparent" }} onClick={() => onChange((current) => ({ ...current, mode }))}>{MODEL3D_MODE_LABELS[mode]}</button>)}</div>
            {draft.mode === "text" ? <Field label="模型描述"><Input.TextArea value={draft.prompt} rows={4} placeholder="描述物体形状、材质、颜色与细节" onChange={(event) => onChange((current) => ({ ...current, prompt: event.target.value }))} />{inputNodes.some((item) => item.type === CanvasNodeType.Text || item.type === CanvasNodeType.Markdown) ? <p className="mt-2 text-xs leading-relaxed" style={{ color: theme.node.muted }}>已连接文字将追加到本次描述：{inputNodes.filter((item) => item.type === CanvasNodeType.Text || item.type === CanvasNodeType.Markdown).map((item) => item.title).join("、")}</p> : null}</Field> : draft.mode === "image" ? <ImageSlot label="参考图片" value={draft.image} images={images} nodes={nodes} connectedIds={connectedIds} theme={theme} capabilities={capabilities} onChange={(binding) => setImage("image", binding)} onUpload={onUpload} /> : <div className="grid grid-cols-2 gap-3">{MODEL3D_VIEWS.map((view) => <ImageSlot key={view} label={`${MODEL3D_VIEW_LABELS[view]}${view === "front" ? " · 必选" : ""}`} value={draft.views[view]} images={images} nodes={nodes} connectedIds={connectedIds} theme={theme} capabilities={capabilities} onChange={(binding) => setImage(view, binding)} onUpload={onUpload} />)}<p className="col-span-2 text-xs leading-relaxed" style={{ color: theme.node.muted }}>指定每张图片的视角，正面必选，至少两个不同视角。连线后仍需选择对应槽位。</p></div>}
            <Field label="生成模型"><Select className="w-full" value={parameters.model || undefined} placeholder="请选择生效模型" options={capabilities?.modelVersions.map((model) => ({ value: model.id, label: model.label })) || []} onChange={(model) => onChange((current) => ({ ...current, parameters: model3DParametersForModel({ ...current.parameters, model }, capabilities) }))} /></Field>
            <div className="grid grid-cols-2 gap-4"><Field label="生成贴图"><Switch checked={parameters.texture} onChange={(texture) => onChange((current) => ({ ...current, parameters: { ...current.parameters, texture, pbr: texture ? current.parameters.pbr : false } }))} /></Field><Field label="PBR 材质"><Switch checked={parameters.pbr} disabled={!parameters.texture} onChange={(value) => setParameter("pbr", value)} /></Field>{advanced ? <Field label="几何质量"><Select className="w-full" value={parameters.geometryQuality || "standard"} options={[{ value: "standard", label: "标准" }, { value: "detailed", label: "精细" }]} onChange={(value) => setParameter("geometryQuality", value)} /></Field> : null}<Field label={faceRange.max ? `面数上限（${faceRange.min.toLocaleString()}–${faceRange.max.toLocaleString()}）` : "面数上限"}><InputNumber className="!w-full" value={parameters.faceLimit} min={faceRange.min} max={faceRange.max} precision={0} placeholder="服务默认" onChange={(value) => setParameter("faceLimit", value ?? undefined)} /></Field>{advanced && parameters.texture ? <Field label="贴图质量"><Select className="w-full" value={parameters.textureQuality || "standard"} options={[{ value: "standard", label: "标准" }, { value: "detailed", label: "精细" }, { value: "extreme", label: "极致" }, { value: "fast", label: "快速（贴图 3.5）" }]} onChange={(value) => onChange((current) => ({ ...current, parameters: { ...current.parameters, textureQuality: value, ...(value === "fast" ? { textureVersion: "v3.5-20260815" } : {}) } }))} /></Field> : null}</div>
            <Collapse ghost items={[{ key: "advanced", label: "高级参数", children: <div className="space-y-4">
                {draft.mode === "text" ? <Field label="负面描述"><Input.TextArea rows={2} value={parameters.negativePrompt || ""} onChange={(event) => setParameter("negativePrompt", event.target.value || undefined)} /></Field> : null}
                <div className="grid grid-cols-2 gap-4"><SeedField label="模型随机种子" value={parameters.modelSeed} onChange={(value) => setParameter("modelSeed", value)} />{draft.mode === "text" ? <SeedField label="图像随机种子" value={parameters.imageSeed} onChange={(value) => setParameter("imageSeed", value)} /> : null}{parameters.texture ? <SeedField label="贴图随机种子" value={parameters.textureSeed} onChange={(value) => setParameter("textureSeed", value)} /> : null}
                {advanced ? <><Toggle label="自动实际尺寸" checked={parameters.autoSize} onChange={(value) => setParameter("autoSize", value)} /><Toggle label="四边形拓扑（输出 FBX）" checked={parameters.quad} onChange={(value) => setParameter("quad", value)} /><Toggle label="智能低面数" checked={parameters.smartLowPoly} onChange={(value) => setParameter("smartLowPoly", value)} /><Field label="几何压缩"><Select className="w-full" value={parameters.compress || ""} options={[{ value: "", label: "关闭" }, { value: "geometry", label: "开启" }]} onChange={(value: "" | "geometry") => setParameter("compress", value)} /></Field></> : null}
                <Toggle label="导出 UV" checked={parameters.exportUv ?? true} onChange={(value) => setParameter("exportUv", value)} /><Field label="导出朝向"><Select className="w-full" allowClear value={parameters.exportOrientation} placeholder="服务默认（+X）" options={["+x", "-x", "+y", "-y"].map((value) => ({ value, label: value.toUpperCase() }))} onChange={(value) => setParameter("exportOrientation", value)} /></Field>
                {parameters.texture ? <><Field label="贴图版本"><Select className="w-full" allowClear placeholder="服务默认" value={parameters.textureVersion} options={[{ value: "v2.5-20250123", label: "贴图 2.5" }, { value: "v3.0-20250812", label: "贴图 3.0" }, { value: "v3.5-20260815", label: "贴图 3.5" }]} onChange={(value) => setParameter("textureVersion", value)} /><p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>去除图像光照仅在贴图 3.5 下生效，默认开启。</p></Field>{parameters.textureVersion === "v3.5-20260815" ? <Toggle label="去除图像光照" checked={parameters.delight ?? true} onChange={(value) => setParameter("delight", value)} /> : null}</> : null}
                {draft.mode === "image" ? <Toggle label="图像自动修正" checked={parameters.enableImageAutofix} onChange={(value) => setParameter("enableImageAutofix", value)} /> : null}
                {draft.mode !== "text" && parameters.texture ? <><Field label="贴图对齐"><Select className="w-full" allowClear value={parameters.textureAlignment} placeholder="服务默认" options={[{ value: "original_image", label: "原始图片" }, { value: "geometry", label: "几何体" }]} onChange={(value) => setParameter("textureAlignment", value)} /></Field><Field label="模型朝向"><Select className="w-full" allowClear value={parameters.orientation} placeholder="服务默认" options={[{ value: "default", label: "默认" }, { value: "align_image", label: "对齐图片" }]} onChange={(value) => setParameter("orientation", value)} /></Field></> : null}
                </div>
            </div> }]} />
            {capabilityError ? <p role="alert" className="text-xs" style={{ color: "var(--status-warning)" }}>{capabilityError}</p> : null}
            {run?.error ? <p role="alert" className="text-xs leading-relaxed" style={{ color: "var(--status-warning)" }}>{run.error}</p> : null}
        </div>
        <footer className="shrink-0 space-y-2 border-t p-4" style={{ borderColor: theme.node.stroke }}>
            {inputError ? <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>{inputError}</p> : null}
            <div className="flex items-center gap-2"><Button type="primary" className="flex-1" loading={pending} disabled={!capabilities?.available || Boolean(inputError) || uncertain} onClick={onGenerate}>{pending ? "任务进行中" : "生成 3D 模型"}</Button>{run?.requestId ? <Button title="刷新任务状态" icon={<RefreshCw className="size-3.5" />} onClick={onRefresh} /> : null}<Button title="刷新服务配置" icon={<SettingsIcon />} onClick={onReloadConfig} /></div>
            <p className="text-[var(--fs-tiny)] leading-relaxed" style={{ color: theme.node.muted }}>{uncertain ? "提交结果待确认，核实前不会再次生成。" : pending ? "本次任务使用提交时的参数；继续编辑会用于下一次生成。" : `手动提交异步任务 · ${parameters.quad ? "FBX" : "GLB"} 输出`}</p>
        </footer>
    </section>;
}

function SettingsIcon() { return <RefreshCw className="size-3.5" />; }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block space-y-2"><span className="block text-xs font-medium">{label}</span>{children}</label>; }
function Toggle({ label, checked, onChange }: { label: string; checked?: boolean; onChange: (value: boolean) => void }) { return <Field label={label}><Switch checked={Boolean(checked)} onChange={onChange} /></Field>; }
function SeedField({ label, value, onChange }: { label: string; value?: number; onChange: (value?: number) => void }) { return <Field label={label}><InputNumber className="!w-full" precision={0} value={value} placeholder="随机" onChange={(next) => onChange(next ?? undefined)} /></Field>; }

function ImageSlot({ label, value, images, nodes, connectedIds, theme, capabilities, onChange, onUpload }: { label: string; value?: Model3DImageBinding; images: CanvasNodeData[]; nodes: CanvasNodeData[]; connectedIds: Set<string>; theme: CanvasTheme; capabilities: Model3DCapabilities | null; onChange: (binding?: Model3DImageBinding) => void; onUpload: (file: File) => Promise<Model3DImageBinding> }) {
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState("");
    const mounted = useRef(true);
    const fileInput = useRef<HTMLInputElement>(null);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const resolved = resolveModel3DImage(value, nodes);
    return <div className="min-w-0 space-y-2 rounded-[var(--r-md)] border p-2.5" style={{ borderColor: theme.node.stroke }}><span className="text-xs font-medium">{label}</span><div className="flex h-20 items-center justify-center overflow-hidden rounded-[var(--r-md)]" style={{ background: theme.spatial.dropzone, color: theme.node.muted }}>{resolved?.url || resolved?.storageKey ? <CachedResourceImage storageKey={resolved.storageKey} src={resolved.url} alt={label} className="size-full object-contain" draggable={false} /> : <span className="text-xs">未选择图片</span>}</div><Select className="w-full" size="small" showSearch allowClear disabled={uploading} optionFilterProp="label" value={value?.sourceNodeId || (value && !value.sourceNodeId ? "__uploaded__" : undefined)} placeholder="选择画布图片" options={[...(value && !value.sourceNodeId ? [{ value: "__uploaded__", label: value.title || "已上传图片" }] : []), ...images.map((image) => ({ value: image.id, label: `${connectedIds.has(image.id) ? "已连接 · " : ""}${image.title}` }))]} onChange={(id) => { if (id === "__uploaded__") return; setError(""); const image = images.find((image) => image.id === id); onChange(image ? model3DImageBinding(image) : undefined); }} /><input ref={fileInput} type="file" className="hidden" accept={capabilities?.inputLimits.mimeTypes.join(",") || "image/png,image/jpeg"} onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        setUploading(true); setError("");
        void onUpload(file).then((binding) => { if (mounted.current) onChange(binding); }).catch((cause) => { if (mounted.current) setError(cause instanceof Error ? cause.message : "图片上传失败"); }).finally(() => { if (mounted.current) setUploading(false); });
    }} /><Button block size="small" loading={uploading} icon={<Upload className="size-3" />} onClick={() => fileInput.current?.click()}>上传图片</Button>{error ? <p role="alert" className="text-xs leading-relaxed" style={{ color: "var(--status-warning)" }}>{error}</p> : null}{value?.sourceNodeId && !resolved ? <p className="text-xs" style={{ color: "var(--status-warning)" }}>原图片已删除，请重新选择。</p> : null}</div>;
}
