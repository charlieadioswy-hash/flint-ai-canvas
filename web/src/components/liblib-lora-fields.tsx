import { Button, InputNumber, Select } from "antd";
import { Trash2 } from "lucide-react";
import { LIBLIB_LORA_DEFAULT_WEIGHT, LIBLIB_LORA_PROTOCOL, liblibLoraBaseLabel, liblibLoraConfigurationError, liblibLoraModelId, parseLiblibLoras, type LiblibLoraProfile, type LiblibLoraSelection } from "@/lib/canvas/liblib-lora";

type Props = { value: unknown; profile?: LiblibLoraProfile; protocol?: string; disabled?: boolean; onChange: (value: LiblibLoraSelection[]) => void };

// Shared by canvas and screen creation; semantic colors follow the active theme.
export function LiblibLoraFields({ value, profile, protocol = LIBLIB_LORA_PROTOCOL, disabled, onChange }: Props) {
    let selections: LiblibLoraSelection[] = [];
    let malformed = false;
    try { selections = parseLiblibLoras(value); } catch { malformed = true; }
    const error = liblibLoraConfigurationError(value, profile, protocol);
    const max = Math.min(5, profile?.maxNetworks || 5);
    const models = profile?.models || [];
    const supported = protocol === LIBLIB_LORA_PROTOCOL && profile?.supported;
    const available = models.filter((model) => !selections.some((item) => item.modelId === liblibLoraModelId(model.id)));
    return <section className="space-y-3 text-xs" aria-label="LoRA 风格模型">
        <div className="flex items-center justify-between gap-2"><strong>LoRA 风格模型</strong><span className="text-foreground/60">{selections.length} / {max}</span></div>
        <p className="text-foreground/60">{supported ? `当前基础算法：${liblibLoraBaseLabel(profile?.baseModel)}。选择已登记的模型叠加风格。` : "当前模型未启用 LoRA。"}</p>
        {selections.map((selection, index) => {
            const model = models.find((item) => liblibLoraModelId(item.id) === selection.modelId);
            return <div key={selection.modelId} className="space-y-2 rounded-md border border-border p-3">
                <div className="flex items-start justify-between gap-2"><span className="min-w-0 break-all font-medium">{model?.name || `不可用 LoRA · ${selection.modelId}`}</span><Button size="small" type="text" aria-label={`移除 LoRA ${index + 1}`} icon={<Trash2 className="size-3" />} disabled={disabled} onClick={() => onChange(selections.filter((_, position) => position !== index))} /></div>
                <label className="flex items-center justify-between gap-2"><span>权重</span><InputNumber aria-label={`LoRA ${index + 1} 权重`} size="small" min={-4} max={4} step={0.05} value={selection.weight ?? LIBLIB_LORA_DEFAULT_WEIGHT} disabled={disabled} onChange={(weight) => { if (weight !== null) onChange(selections.map((item, position) => position === index ? { ...item, weight } : item)); }} /></label>
                {model?.triggerWords?.length ? <p className="break-words text-foreground/60">生成时自动加入触发词：{model.triggerWords.join("、")}。画面描述保持原样。</p> : null}
                {model && model.baseModel !== profile?.baseModel ? <p className="text-destructive">仅兼容 {liblibLoraBaseLabel(model.baseModel)}</p> : null}
            </div>;
        })}
        <Select<string | null> className="w-full" aria-label="添加 LoRA" placeholder={models.length ? "选择 LoRA" : "暂无已登记 LoRA，请联系管理员"} value={null} showSearch optionFilterProp="label" disabled={disabled || !supported || malformed || selections.length >= max} options={available.map((model) => ({ value: model.id, label: `${model.name} · ${liblibLoraBaseLabel(model.baseModel)}`, disabled: model.baseModel !== profile?.baseModel }))} onChange={(id) => { const model = models.find((item) => item.id === id); if (model) onChange([...selections, { modelId: liblibLoraModelId(model.id), weight: model.defaultWeight ?? LIBLIB_LORA_DEFAULT_WEIGHT }]); }} />
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        {malformed || selections.length ? <Button size="small" disabled={disabled} onClick={() => onChange([])}>{malformed ? "移除无效 LoRA 配置" : "清空 LoRA"}</Button> : null}
    </section>;
}
