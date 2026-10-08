import { Button, Input, InputNumber, Popover } from "antd";
import { Plus, ScanLine, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useUpstreamNodes } from "./canvas-node-graph-context";
import { controlImageReference, defaultControlNetBinding, nodeControlNet, nodeOutputMask, setControlNetReference } from "@/lib/canvas/controlnet";
import { generationSpecMetadata, readNodeGenerationSpec, specFromConfig, validateGenerationSpec } from "@/lib/canvas/generation-contract";
import type { ControlNetBinding, ControlNetParameters, GenerationSpec, ReferenceBinding } from "@/lib/canvas/generation-contract.generated";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import type { ModelProtocolDefinition, ModelProtocolParameter } from "@/lib/model-protocols";
import { modelOptionName, resolveModelChannel, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { uploadResourceFile } from "@/services/api/resources";
import { fetchPluginProviderCatalog } from "@/services/api/plugin-catalog";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

type Props = { node: CanvasNodeData; config: AiConfig; sourceNodes?: CanvasNodeData[]; disabled?: boolean; onChange: (patch: Partial<CanvasNodeMetadata>) => void; onOpenChange?: (open: boolean) => void };

export function CanvasControlNetPopover({ node, config, sourceNodes: providedSources, disabled, onChange, onOpenChange }: Props) {
    const [open, setOpen] = useState(false);
    const upstream = useUpstreamNodes(node.id);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState("");
    const [protocols, setProtocols] = useState<ModelProtocolDefinition[]>([]);
    const spec = readNodeGenerationSpec(node) || specFromConfig("image", "", config);
    const currentSpec = useRef(spec);
    currentSpec.current = spec;
    const units = nodeControlNet(node);
    const outputMask = nodeOutputMask(node);
    const profile = modelCapabilityConfigFor(config, config.model).image?.controlNet;
    const sourceNodes = (providedSources || upstream).filter((source) => controlImageReference(source));
    const requestConfig = resolveModelRequestConfig(config, config.model);
    const protocolId = requestConfig.interfaceType || "";
    const parameters = protocols.find((item) => item.value === protocolId)?.parameters?.filter((item) => item.mapping?.includes("providerOptions") && ["string", "integer", "number", "boolean"].includes(item.type)) || [];
    const channel = resolveModelChannel(config, config.model);
    const defaults = channel.modelCosts?.find((item) => item.model === modelOptionName(config.model))?.defaultOptions || {};
    const providerOptions = { ...defaults, ...node.metadata?.providerOptions?.[protocolId] };

    useEffect(() => {
        if (!open) return;
        let active = true;
        void fetchPluginProviderCatalog("canvas", "image").then((items) => { if (active) setProtocols(items); }).catch(() => { if (active) setError("协议参数暂时无法读取，请重新打开设置重试"); });
        return () => { active = false; };
    }, [open]);

    const commit = (next: GenerationSpec) => {
        try { const validated = validateGenerationSpec(next); currentSpec.current = validated; onChange({ ...generationSpecMetadata(validated), structureControl: true }); setError(""); }
        catch (failure) { setError(failure instanceof Error ? failure.message : "控制参数无效"); }
    };
    const updateUnit = (id: string, patch: Partial<ControlNetBinding>) => commit({ ...currentSpec.current, options: { ...currentSpec.current.options, controlNet: (currentSpec.current.options.controlNet || []).map((unit) => unit.id === id ? { ...unit, ...patch } : unit) } });
    const updateParameters = (unit: ControlNetBinding, patch: Partial<ControlNetParameters>) => updateUnit(unit.id, { parameters: { ...unit.parameters, ...patch } });

    const bindSource = (unitId: string | undefined, role: ReferenceBinding["role"], value: string) => {
        let next = currentSpec.current;
        const bindingId = unitId ? `${unitId}:${role}` : "output-mask";
        const source = value.startsWith("node:") ? { nodeId: value.slice(5) } : value.startsWith("resource:") ? { resourceId: value.slice(9) } : undefined;
        next = setControlNetReference(next, bindingId, role, source);
        if (unitId) next = { ...next, options: { ...next.options, controlNet: (next.options.controlNet || []).map((unit) => unit.id === unitId ? { ...unit, ...(role === "control-image" ? { imageBindingId: source ? bindingId : "" } : { maskBindingId: source ? bindingId : undefined }) } : unit) } };
        else next = { ...next, options: { ...next.options, outputMask: source ? { bindingId, mode: next.options.outputMask?.mode || "non-black", resizeMode: "stretch" } : undefined, controlNet: source ? (next.options.controlNet || []).map((unit) => ({ ...unit, parameters: { ...unit.parameters, resizeMode: "stretch" } })) : next.options.controlNet } };
        commit(next);
    };
    const upload = async (file: File | undefined, unitId: string | undefined, role: ReferenceBinding["role"]) => {
        if (!file) return;
        if (!file.type.startsWith("image/")) { setError("请选择图片文件"); return; }
        setUploading(true); setError("");
        try { const resource = await uploadResourceFile(file, "image", { fileName: file.name }); bindSource(unitId, role, `resource:${resource.id}`); }
        catch (failure) { setError(failure instanceof Error ? failure.message : "图片上传失败"); }
        finally { setUploading(false); }
    };
    const sourcePicker = (unitId: string | undefined, role: ReferenceBinding["role"], bindingId: string | undefined, label: string) => {
        const binding = spec.referenceBindings.find((item) => item.id === bindingId);
        const value = binding?.nodeId ? `node:${binding.nodeId}` : binding?.resourceId ? `resource:${binding.resourceId}` : "";
        return <div className="space-y-1.5">
            <label className="block text-xs font-medium" htmlFor={`${node.id}-${unitId || "output"}-${role}`}>{label}</label>
            <div className="flex gap-2">
                <select id={`${node.id}-${unitId || "output"}-${role}`} className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs" value={value} disabled={disabled || uploading} onChange={(event) => bindSource(unitId, role, event.target.value)}>
                    <option value="">{role === "control-image" ? "选择已连接图片" : "不使用"}</option>
                    {binding?.resourceId ? <option value={value}>已上传图片</option> : null}
                    {binding?.nodeId && !sourceNodes.some((source) => source.id === binding.nodeId) ? <option value={value}>原图片已断开或不可用</option> : null}
                    {sourceNodes.map((source) => <option key={source.id} value={`node:${source.id}`}>{source.title}{source.type === "media-conversion" ? "（转换结果，仍会执行 Canny 检测）" : ""}</option>)}
                </select>
                <label className="flex h-8 cursor-pointer items-center gap-1 rounded-md border border-border px-2 text-xs focus-within:ring-1 focus-within:ring-foreground/40"><Upload className="size-3" />上传<input type="file" accept="image/*" aria-label={`上传${label}`} className="sr-only" disabled={disabled || uploading} onChange={(event) => { void upload(event.target.files?.[0], unitId, role); event.target.value = ""; }} /></label>
            </div>
        </div>;
    };
    const numeric = (label: string, value: number, min: number, max: number, step: number, change: (value: number) => void) => <label className="space-y-1 text-xs"><span className="block">{label}</span><InputNumber aria-label={label} className="!w-full" size="small" value={value} min={min} max={max} step={step} disabled={disabled || uploading} onChange={(next) => { if (next !== null) change(Number(next)); }} /></label>;
    const content = <div className="max-h-[70vh] w-[360px] max-w-[calc(100vw-48px)] space-y-3 overflow-y-auto p-1 text-foreground" data-canvas-no-zoom data-canvas-wheel-scroll onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between"><strong className="text-sm">结构控制生图</strong><Button size="small" icon={<Plus className="size-3" />} disabled={disabled || uploading || units.length >= Math.min(4, profile?.maxUnits || 4)} onClick={() => { const unit = defaultControlNetBinding(crypto.randomUUID()); if (outputMask) unit.parameters.resizeMode = "stretch"; commit({ ...spec, options: { ...spec.options, controlNet: [...units, unit] } }); }}>添加控制</Button></div>
        <p className="text-xs text-foreground/60">连接屏幕示意图并选择为控制图，生成时执行 Canny。控制图与蒙版应使用相同画幅比例。</p>
        {units.map((unit, index) => <div key={unit.id} className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between"><span className="text-xs font-medium">控制 {index + 1} · Canny</span><Button type="text" size="small" aria-label={`移除控制 ${index + 1}`} icon={<Trash2 className="size-3" />} disabled={disabled || uploading} onClick={() => { let next = spec; for (const binding of [unit.imageBindingId, unit.maskBindingId]) if (binding) next = setControlNetReference(next, binding, "control-image"); commit({ ...next, options: { ...next.options, controlNet: units.filter((item) => item.id !== unit.id) } }); }} /></div>
            {sourcePicker(unit.id, "control-image", unit.imageBindingId, "控制图")}
            <label className="block space-y-1 text-xs"><span>控制模型标识</span>{profile?.models?.length ? <select className="h-8 w-full rounded-md border border-border bg-background px-2" aria-label={`控制 ${index + 1} 模型`} value={unit.parameters.model} disabled={disabled || uploading} onChange={(event) => updateParameters(unit, { model: event.target.value })}><option value="">选择控制模型</option>{profile.models.map((model) => <option key={model} value={model}>{model}</option>)}</select> : <Input size="small" aria-label={`控制 ${index + 1} 模型`} placeholder="控制模型 UUID / 标识" value={unit.parameters.model} disabled={disabled || uploading} onChange={(event) => updateParameters(unit, { model: event.target.value })} />}</label>
            <div className="grid grid-cols-3 gap-2">{numeric("检测分辨率", unit.parameters.canny?.resolution || 512, 64, 2048, 64, (value) => updateParameters(unit, { canny: { ...(unit.parameters.canny || { resolution: 512, lowThreshold: 100, highThreshold: 200 }), resolution: value } }))}{numeric("低阈值", unit.parameters.canny?.lowThreshold || 100, 1, 255, 1, (value) => updateParameters(unit, { canny: { ...(unit.parameters.canny || { resolution: 512, lowThreshold: 100, highThreshold: 200 }), lowThreshold: value } }))}{numeric("高阈值", unit.parameters.canny?.highThreshold || 200, 1, 255, 1, (value) => updateParameters(unit, { canny: { ...(unit.parameters.canny || { resolution: 512, lowThreshold: 100, highThreshold: 200 }), highThreshold: value } }))}</div>
            <div className="grid grid-cols-3 gap-2">{numeric("控制强度", unit.parameters.strength, 0, 2, 0.05, (strength) => updateParameters(unit, { strength }))}{numeric("开始比例", unit.parameters.start, 0, 1, 0.05, (start) => updateParameters(unit, { start }))}{numeric("结束比例", unit.parameters.end, 0, 1, 0.05, (end) => updateParameters(unit, { end }))}</div>
            <div className="grid grid-cols-2 gap-2"><label className="space-y-1 text-xs"><span className="block">控制方式</span><select className="h-8 w-full rounded-md border border-border bg-background px-2" aria-label="控制方式" value={unit.parameters.controlMode} disabled={disabled || uploading} onChange={(event) => updateParameters(unit, { controlMode: event.target.value as ControlNetParameters["controlMode"] })}><option value="balanced">均衡</option><option value="prompt">提示词优先</option><option value="control">结构优先</option></select></label><label className="space-y-1 text-xs"><span className="block">画幅变换</span><select className="h-8 w-full rounded-md border border-border bg-background px-2" aria-label="画幅变换" value={unit.parameters.resizeMode} disabled={disabled || uploading || Boolean(outputMask)} onChange={(event) => updateParameters(unit, { resizeMode: event.target.value as ControlNetParameters["resizeMode"] })}><option value="stretch">完整画幅缩放</option><option value="crop">裁剪适配</option><option value="fill">留白适配</option></select></label></div>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={unit.parameters.pixelPerfect} disabled={disabled || uploading} onChange={(event) => updateParameters(unit, { pixelPerfect: event.target.checked })} />自动适配检测分辨率</label>
            {sourcePicker(unit.id, "control-mask", unit.maskBindingId, "控制区域蒙版（可选）")}
        </div>)}
        <div className="space-y-2 rounded-lg border border-border p-3">{sourcePicker(undefined, "output-mask", outputMask?.bindingId, "输出范围蒙版（可选）")}{outputMask ? <><select className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs" aria-label="输出蒙版解释方式" value={outputMask.mode} disabled={disabled || uploading} onChange={(event) => commit({ ...spec, options: { ...spec.options, outputMask: { ...outputMask, mode: event.target.value as "non-black" | "luminance" } } })}><option value="non-black">彩色示意图：非黑区域允许显示</option><option value="luminance">黑白蒙版：白色显示，黑色遮挡</option></select><p className="text-xs text-foreground/60">按完整画幅缩放到输出尺寸，蒙版外固定为黑色；所有控制图采用同一变换。</p></> : <p className="text-xs text-foreground/60">用于严格限制最终图片边界，与控制区域蒙版分别设置。</p>}</div>
        {parameters.length ? <div className="space-y-2 rounded-lg border border-border p-3"><strong className="text-xs">生成参数</strong>{parameters.map((parameter) => <label key={parameter.name} className="block space-y-1 text-xs"><span>{parameter.description || parameter.name}{parameter.required ? " *" : ""}</span><ProviderParameterInput parameter={parameter} value={providerOptions[parameter.name]} disabled={disabled || uploading} onChange={(value) => onChange({ providerOptions: { ...node.metadata?.providerOptions, [protocolId]: { ...node.metadata?.providerOptions?.[protocolId], [parameter.name]: value } } })} /></label>)}</div> : null}
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}{uploading ? <p role="status" className="text-xs text-foreground/60">正在保存图片…</p> : null}
    </div>;
    return <Popover open={open} onOpenChange={(next) => { setOpen(next); onOpenChange?.(next); }} trigger="click" placement="topLeft" content={content}><button type="button" className="canvas-node-composer-settings-trigger" disabled={disabled} aria-expanded={open} aria-label="结构控制生图设置"><ScanLine className="size-3" /><span>结构控制{units.length ? ` · ${units.length}` : ""}</span></button></Popover>;
}

function ProviderParameterInput({ parameter, value, disabled, onChange }: { parameter: ModelProtocolParameter; value: unknown; disabled?: boolean; onChange: (value: unknown) => void }) {
    if (parameter.type === "boolean" || parameter.values?.length) {
        const values = parameter.type === "boolean" ? ["true", "false"] : parameter.values || [];
        return <select className="h-8 w-full rounded-md border border-border bg-background px-2" aria-label={parameter.name} disabled={disabled} value={value === undefined ? "" : String(value)} onChange={(event) => onChange(event.target.value === "" ? undefined : parameter.type === "boolean" ? event.target.value === "true" : event.target.value)}><option value="">使用模型默认值</option>{values.map((item) => <option key={item} value={item}>{item}</option>)}</select>;
    }
    if (parameter.type === "integer" || parameter.type === "number") return <InputNumber className="!w-full" size="small" aria-label={parameter.name} disabled={disabled} value={typeof value === "number" ? value : null} precision={parameter.type === "integer" ? 0 : undefined} onChange={(next) => onChange(next === null ? undefined : Number(next))} />;
    return <Input size="small" aria-label={parameter.name} disabled={disabled} value={String(value ?? "")} placeholder={parameter.name} onChange={(event) => onChange(event.target.value)} />;
}
