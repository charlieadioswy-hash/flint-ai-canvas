import { useState } from "react";
import { Button, Checkbox, Select } from "antd";
import { AppModal } from "@/components/ui/product/app-modal";
import type { Model3DProcessing, Model3DProcessingOperation, Model3DTaskView } from "@/services/api/model3d";
import { defaultModel3DProcessing, model3DAnimationOptions, model3DProcessingOptions, MODEL3D_PROCESSING_LABELS, MODEL3D_RIG_LABELS } from "./model3d-processing-state";

export function Model3DProcessingPanel({ task, enabled, disabled, onProcess, onSource }: {
    task: Model3DTaskView;
    enabled: Model3DProcessingOperation[];
    disabled: boolean;
    onProcess: (processing: Model3DProcessing) => void;
    onSource: (id: string) => void;
}) {
    const options = model3DProcessingOptions(task).filter((operation) => enabled.includes(operation));
    const [draft, setDraft] = useState<Model3DProcessing | null>(() => options[0] ? defaultModel3DProcessing(task, options[0]) : null);
    const [confirmation, setConfirmation] = useState<Model3DProcessing | null>(null);
    const [specificParts, setSpecificParts] = useState(false);
    const parts = task.result?.parts || [];
    const operation = draft?.operation;
    const invalid = !draft || !options.includes(draft.operation) || (operation === "complete" && specificParts && !draft.partNames?.length) || (operation === "animate" && !model3DAnimationOptions(draft.rigType || "").some((item) => item.value === draft.animation));
    const change = (values: Partial<Model3DProcessing>) => setDraft((previous) => previous ? { ...previous, ...values } : previous);
    return (
        <section className="model3d-processing" aria-label="模型后续处理">
            <div className="model3d-panel-heading">
                <div><h2>模型后续处理</h2><p className="model3d-hint">拆分、补全、绑骨与动画分别保存新版本。</p></div>
                {task.processing ? <Button size="small" onClick={() => onSource(task.processing!.sourceTaskId)}>查看来源任务</Button> : null}
            </div>
            {draft && options.length > 0 ? (
                <div className="model3d-processing-fields">
                    <div className="model3d-choices" role="group" aria-label="处理方式">
                        {options.map((value) => <Button key={value} aria-pressed={value === operation} disabled={disabled} onClick={() => { setDraft(defaultModel3DProcessing(task, value)); setSpecificParts(false); }}>{MODEL3D_PROCESSING_LABELS[value]}</Button>)}
                    </div>
                    {operation === "segment" ? <>
                        <label className="model3d-field"><span>拆分模型</span><Select aria-label="拆分模型" value={draft.model} disabled={disabled} options={[{ value: "v2.0-20260430", label: "v2 · 语义拆分（Beta）" }, { value: "v1.0-20250506", label: "v1 · 几何拆分" }]} onChange={(model) => setDraft({ operation: "segment", sourceTaskId: task.id, model, ...(model === "v2.0-20260430" ? { granularity: "balanced", splitByConnectivity: true } : {}) })} /></label>
                        {draft.model === "v2.0-20260430" ? <>
                            <label className="model3d-field"><span>拆分粒度</span><Select aria-label="拆分粒度" value={draft.granularity} disabled={disabled} options={[{ value: "simple", label: "简单" }, { value: "balanced", label: "均衡" }, { value: "detailed", label: "精细" }]} onChange={(granularity) => change({ granularity })} /></label>
                            <Checkbox checked={draft.splitByConnectivity} disabled={disabled} onChange={(event) => change({ splitByConnectivity: event.target.checked })}>按连通区域拆分</Checkbox>
                        </> : null}
                    </> : null}
                    {operation === "complete" ? <>
                        <p className="model3d-hint">补齐拆分后部件的缺失几何。可使用 AI 补全，或快速封闭孔洞。</p>
                        <label className="model3d-field"><span>补全方式</span><Select aria-label="补全方式" value={draft.completionMode} disabled={disabled} options={[{ value: "ai_completion", label: "AI 补全" }, { value: "quick_cap", label: "快速封口" }]} onChange={(completionMode) => change({ completionMode })} /></label>
                        <Checkbox checked={specificParts} disabled={disabled || parts.length === 0} onChange={(event) => { setSpecificParts(event.target.checked); change({ partNames: event.target.checked ? [] : undefined }); }}>仅补全指定部件</Checkbox>
                        {specificParts ? <Select mode="multiple" aria-label="补全部件" placeholder="请选择要补全的部件" value={draft.partNames || []} disabled={disabled} options={parts.map((value) => ({ value, label: value }))} onChange={(partNames) => change({ partNames })} /> : <p className="model3d-hint">处理全部拆分部件。</p>}
                    </> : null}
                    {operation === "rig_check" ? <p className="model3d-hint">先检查模型是否适合自动绑骨，并识别骨架类型；检查完成后再选择绑骨参数。</p> : null}
                    {operation === "rig" ? <>
                        <p>检测骨架：{MODEL3D_RIG_LABELS[draft.rigType || ""] || draft.rigType}</p>
                        <label className="model3d-field"><span>绑骨模型</span><Select aria-label="绑骨模型" value={draft.model} disabled={disabled} options={[{ value: "v3.0-20260909", label: "v3.0 · 推荐" }, ...(draft.rigType === "others" ? [] : [{ value: "v2.5-20260210", label: "v2.5" }])]} onChange={(model) => change({ model, ...(draft.rigType === "biped" ? { spec: "tripo" } : {}) })} /></label>
                        {draft.rigType === "biped" ? <label className="model3d-field"><span>骨架命名规范</span><Select aria-label="骨架命名规范" value={draft.spec} disabled={disabled} options={(draft.model === "v3.0-20260909" ? ["tripo", "mixamo", "actorcore", "unity", "unreal", "vrm"] : ["tripo", "mixamo"]).map((value) => ({ value, label: value === "tripo" ? "Tripo 原生" : value }))} onChange={(spec) => change({ spec })} /></label> : null}
                    </> : null}
                    {operation === "animate" ? <>
                        <label className="model3d-field"><span>预设动作</span><Select aria-label="预设动作" value={draft.animation} disabled={disabled} options={model3DAnimationOptions(draft.rigType || "")} onChange={(animation) => change({ animation })} /></label>
                        <Checkbox checked={draft.animateInPlace} disabled={disabled} onChange={(event) => change({ animateInPlace: event.target.checked })}>原地运动（去除位移）</Checkbox>
                        <p className="model3d-hint">每个动作生成一个新版本，模型几何与动画一起保存。</p>
                    </> : null}
                    {operation === "rig" || operation === "animate" ? <label className="model3d-field"><span>产物格式</span><Select aria-label="处理产物格式" value={draft.outFormat} disabled={disabled} options={[{ value: "glb", label: "GLB · 网页预览" }, { value: "fbx", label: "FBX · 建模与游戏引擎" }]} onChange={(outFormat) => change({ outFormat })} /></label> : null}
                    <Button type="primary" disabled={disabled || invalid} onClick={() => setConfirmation(structuredClone(draft))}>确认{MODEL3D_PROCESSING_LABELS[draft.operation]}</Button>
                </div>
            ) : <p className="model3d-processing-fields model3d-hint">{task.status !== "succeeded" ? "任务完成后可选择后续操作。" : task.processing?.operation === "rig_check" && !task.rigCheck?.riggable ? "此模型未通过绑骨检查。请调整原始模型的形态或姿态，再生成新版本。" : task.processing?.operation === "rig" ? "此骨架类型暂无已公开的预设动作，可下载模型到建模工具中制作动画。" : task.processing ? "可预览、下载此结果，或返回来源任务尝试其他参数。" : "当前服务暂未开放模型处理。"}</p>}
            <AppModal open={Boolean(confirmation)} title={confirmation ? `确认${MODEL3D_PROCESSING_LABELS[confirmation.operation]}` : "确认处理"} okText="开始处理" cancelText="返回修改" okButtonProps={{ disabled: disabled || invalid }} onCancel={() => setConfirmation(null)} onOk={() => { if (!confirmation || disabled || invalid) return; onProcess(confirmation); setConfirmation(null); }}>
                <p>基于当前所选版本执行{confirmation ? MODEL3D_PROCESSING_LABELS[confirmation.operation] : "处理"}，单独记录进度和结果。原版本会保留。</p>
                <p className="model3d-hint">{confirmation?.operation === "rig_check" ? "检查只保存可绑骨结论，不产生模型文件。" : "处理使用已配置的 Tripo 账号额度，实际费用以服务商结算为准。"}</p>
            </AppModal>
        </section>
    );
}
