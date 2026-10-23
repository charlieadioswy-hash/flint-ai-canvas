import { InputNumber } from "antd";
import { Select } from "@/components/ui/base/select";
import { CONTROLNET_TYPES } from "@/lib/canvas/controlnet-catalog.generated";
import { controlNetConfigurationError, controlNetModelId, controlNetModels, controlNetPreprocessor, controlNetPreprocessors, controlNetType, switchControlNetPreprocessor, switchControlNetType, type ControlNetProfile } from "@/lib/canvas/controlnet-options";
import type { ControlNetParameters } from "@/lib/canvas/generation-contract.generated";

type Props = {
    parameters: ControlNetParameters;
    profile?: ControlNetProfile;
    defaults?: Record<string, unknown>;
    disabled?: boolean;
    onChange: (parameters: ControlNetParameters) => void;
};

export function ControlNetParameterFields({ parameters, profile, defaults = {}, disabled, onChange }: Props) {
    const type = controlNetType(parameters);
    const processors = controlNetPreprocessors(profile, type);
    const processor = controlNetPreprocessor(parameters.preprocessor);
    const typeDefinition = CONTROLNET_TYPES.find((item) => item.id === type);
    const models = controlNetModels(profile, type, defaults, parameters.preprocessor);
    const error = controlNetConfigurationError(parameters, profile, defaults);
    const selectedModel = models.find((model) => controlNetModelId(model.id) === controlNetModelId(parameters.model));
    const fieldClass = "block space-y-1.5 text-xs";
    return <div className="space-y-3">
        <label className={fieldClass}><span>Control Type（控制类型）</span><Select className="w-full" ariaLabel="Control Type（控制类型）" value={type || undefined} placeholder="选择控制类型" disabled={disabled} options={CONTROLNET_TYPES.map((item) => ({ value: item.id, label: `${item.label}${!item.supported ? "（暂不支持）" : ""}${item.supported && item.id !== "none" && !controlNetPreprocessors(profile, item.id).length ? "（未启用预处理器）" : ""}`, disabled: !item.supported || item.id === "none" || !controlNetPreprocessors(profile, item.id).length, title: item.description }))} onChange={(value) => onChange(switchControlNetType(parameters, value, profile, defaults))} /></label>
        <label className={fieldClass}><span>Preprocessor（预处理器）</span><Select className="w-full" ariaLabel="Preprocessor（预处理器）" value={parameters.preprocessor || undefined} placeholder="当前类型尚未启用预处理器" disabled={disabled || !processors.length} options={[...processors.map((item) => ({ value: item.id, label: item.label, disabled: false })), ...(!processors.some((item) => item.id === parameters.preprocessor) && parameters.preprocessor ? [{ value: parameters.preprocessor, label: `${parameters.preprocessor}（已不可用）`, disabled: true }] : [])]} onChange={(value) => onChange(switchControlNetPreprocessor(parameters, value, profile, defaults))} /></label>
        <label className={fieldClass}><span>Model（控制模型）</span><Select className="w-full" ariaLabel="Model（控制模型）" value={selectedModel?.id ?? (parameters.model || undefined)} placeholder="暂无兼容控制模型，请联系管理员" disabled={disabled || !models.length} showSearch optionFilterProp="label" options={[...models.map((model) => ({ value: model.id, label: model.name, title: model.id, disabled: false })), ...(!selectedModel && parameters.model ? [{ value: parameters.model, label: "原控制模型已不可用，请重新选择", title: parameters.model, disabled: true }] : [])]} onChange={(model) => onChange({ ...parameters, model })} /></label>
        {parameters.model ? <details className="screen-creation-model-detail"><summary>查看模型标识</summary><code>{parameters.model}</code></details> : null}
        <div className="grid grid-cols-2 gap-2">
            {(processor?.parameters || []).map((parameter) => {
                const value = parameters.preprocessor === "canny" ? parameters.canny?.[parameter.name as keyof NonNullable<ControlNetParameters["canny"]>] : parameters.processorParameters?.[parameter.name];
                return <label key={parameter.name} className={fieldClass}><span>{parameter.label}</span><InputNumber className="!w-full" aria-label={parameter.label} value={value} min={parameter.min} max={parameter.max} step={parameter.step} precision={parameter.type === "integer" ? 0 : undefined} disabled={disabled} onChange={(next) => {
                    if (next === null) return;
                    if (parameters.preprocessor === "canny" && parameters.canny) onChange({ ...parameters, canny: { ...parameters.canny, [parameter.name]: Number(next) } });
                    else onChange({ ...parameters, processorParameters: { ...parameters.processorParameters, [parameter.name]: Number(next) } });
                }} /></label>;
            })}
        </div>
        {type === "inpaint" ? <p className="text-xs text-foreground/60">ControlNet Inpaint 使用控制图与控制区域蒙版约束生成；“局部重绘”生成方式另行设置。</p> : null}
        {type === "reference" ? <p className="text-xs text-foreground/60">Reference 由预处理器直接参考画面，无需额外控制模型。</p> : null}
        {typeDefinition?.description ? <p className="text-xs text-foreground/60">{typeDefinition.description}</p> : null}
        {processor?.modes?.length ? <p className="text-xs text-foreground/60">此预处理器仅支持文生图。</p> : null}
        {processor?.description ? <p className="text-xs text-foreground/60">{processor.description}</p> : null}
        {error ? <p role="status" className="text-xs text-destructive">{error}</p> : null}
    </div>;
}
