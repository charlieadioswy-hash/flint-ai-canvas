import { Input, InputNumber } from "antd";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";

import { Select } from "@/components/ui/base/select";
import { screenModelDefaults } from "@/lib/canvas/irregular-screen-model";
import type { ScreenAdvancedSettings, ScreenCreationWorkspaceProps } from "./screen-creation-types";

type Props = Pick<ScreenCreationWorkspaceProps, "advanced" | "setAdvanced" | "maskMode" | "setMaskMode" | "profile" | "config" | "model"> & { disabled: boolean };
type NumericSetting = Exclude<keyof ScreenAdvancedSettings, "controlModel" | "negativePrompt">;

function SettingField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
    return (
        <label className="screen-creation-field">
            <span>{label}</span>
            {children}
            {hint ? <small>{hint}</small> : null}
        </label>
    );
}

export function ScreenCreationAdvanced({ advanced, setAdvanced, maskMode, setMaskMode, profile, config, model, disabled }: Props) {
    const defaults = screenModelDefaults(config, model).defaults;
    const recommendedModel = String(defaults.controlNetModel || profile?.controlNet?.models?.[0] || "");
    const configuredModels = profile?.controlNet?.models || [];
    const catalogModels = Array.from(new Set(configuredModels.length ? configuredModels : [recommendedModel].filter(Boolean)));
    const controlModels = catalogModels.map((value, index) => ({ value, label: value === recommendedModel ? "推荐轮廓模型" : `轮廓模型 ${index + 1}`, title: value, disabled: false }));
    if (advanced.controlModel && !catalogModels.includes(advanced.controlModel)) controlModels.push({ value: advanced.controlModel, label: "原轮廓模型已不可用，请重新选择", title: advanced.controlModel, disabled: true });
    const numberField = (key: NumericSetting, label: string, min: number, max?: number, step = 1, hint?: string) => (
        <SettingField label={label} hint={hint}>
            <InputNumber
                aria-label={label}
                value={advanced[key]}
                min={min}
                max={max}
                step={step}
                precision={step === 1 ? 0 : undefined}
                disabled={disabled}
                onChange={(value) => {
                    if (value !== null) setAdvanced({ [key]: Number(value) });
                }}
            />
        </SettingField>
    );

    return (
        <details className="screen-creation-advanced">
            <summary>
                <span>
                    <SlidersHorizontal className="size-4" />
                    高级设置
                </span>
                <ChevronDown className="screen-creation-disclosure size-4" />
            </summary>
            <div className="screen-creation-advanced-body">
                <section className="screen-creation-settings-section" aria-label="蒙版解释设置">
                    <h3>可见范围</h3>
                    <SettingField label="蒙版识别方式" hint="在右侧切换到“有效区域”，确认哪些部分会显示画面。">
                        <Select
                            ariaLabel="蒙版识别方式"
                            value={maskMode}
                            disabled={disabled}
                            onChange={setMaskMode}
                            options={[
                                { value: "auto", label: "自动识别" },
                                { value: "color", label: "彩色区域作为屏幕" },
                                { value: "luminance", label: "黑白蒙版 · 白色可见" },
                                { value: "alpha", label: "透明通道 · 不透明区域可见" },
                            ]}
                        />
                    </SettingField>
                </section>
                <section className="screen-creation-settings-section" aria-label="ControlNet 设置">
                    <div>
                        <h3>轮廓控制 · ControlNet</h3>
                        <p className="screen-creation-hint">Canny 提取屏幕轮廓，按完整画幅对齐输出。</p>
                    </div>
                    <SettingField label="控制模型" hint={!catalogModels.length ? "请联系管理员补充轮廓模型配置。" : undefined}>
                        <Select
                            ariaLabel="控制模型"
                            value={advanced.controlModel || undefined}
                            placeholder="暂无可用的轮廓模型"
                            disabled={disabled || !catalogModels.length}
                            onChange={(controlModel) => setAdvanced({ controlModel })}
                            options={controlModels}
                        />
                    </SettingField>
                    {advanced.controlModel ? (
                        <details className="screen-creation-model-detail">
                            <summary>查看模型标识</summary>
                            <code>{advanced.controlModel}</code>
                        </details>
                    ) : null}
                    <div className="screen-creation-settings-grid">
                        {numberField("strength", "控制强度", 0, 2, 0.05)}
                        {numberField("resolution", "检测分辨率", 64, 2048, 64)}
                        {numberField("start", "开始比例", 0, 1, 0.05)}
                        {numberField("end", "结束比例", 0, 1, 0.05)}
                        {numberField("lowThreshold", "Canny 低阈值", 1, 255)}
                        {numberField("highThreshold", "Canny 高阈值", 1, 255)}
                    </div>
                </section>
                <section className="screen-creation-settings-section" aria-label="Liblib 生成参数">
                    <h3>Liblib 生成参数</h3>
                    <div className="screen-creation-settings-grid">
                        {numberField("steps", "采样步数", 1)}
                        {numberField("cfgScale", "提示词引导 · CFG", 0, undefined, 0.5)}
                        {numberField("sampler", "采样器编号", 0)}
                        {numberField("seed", "随机种子", -1, undefined, 1, "-1 为随机种子")}
                    </div>
                    {numberField("denoisingStrength", "参考图重绘强度", 0, 1, 0.05, "使用内容参考图时生效")}
                    <SettingField label="负向提示词">
                        <Input.TextArea
                            aria-label="负向提示词"
                            placeholder="希望画面避免出现的内容"
                            value={advanced.negativePrompt}
                            autoSize={{ minRows: 2, maxRows: 5 }}
                            disabled={disabled}
                            onChange={(event) => setAdvanced({ negativePrompt: event.target.value })}
                        />
                    </SettingField>
                </section>
            </div>
        </details>
    );
}
