import { Input, InputNumber } from "antd";
import { ChevronDown, CircleHelp, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip } from "@/components/ui/base/tooltip";
import { Checkbox } from "@/components/ui/base/checkbox";
import { ControlNetParameterFields } from "@/components/controlnet-parameter-fields";
import { screenControlParameters, screenModelDefaults, screenSettingsFromControlSelection } from "@/lib/canvas/irregular-screen-model";
import type { ScreenAdvancedSettings, ScreenCreationWorkspaceProps } from "./screen-creation-types";

type Props = Pick<ScreenCreationWorkspaceProps, "advanced" | "setAdvanced" | "profile" | "config" | "model" | "generationMode" | "inpaint" | "setInpaint" | "inpaintUnavailableReason"> & { disabled: boolean };
type NumericSetting = Exclude<keyof ScreenAdvancedSettings, "controlModel" | "negativePrompt" | "controlType" | "preprocessor" | "processorParameters" | "pixelPerfect">;

const settingHelp: Record<NumericSetting, string> = {
    strength: "控制强度（ControlNet strength）：越高越贴合蒙版轮廓，越低越允许画面自由变化。",
    resolution: "检测分辨率（processor resolution）：越高越能识别细小轮廓，也可能带入更多细碎边缘；不改变输出尺寸。",
    start: "开始控制时点（start）：0 表示从生成开始就约束轮廓，1 表示到最后才开始。",
    end: "结束控制时点（end）：1 表示一直约束到生成结束；提前结束可让后期细节更自由。",
    lowThreshold: "边缘低阈值（Canny low threshold）：调低可保留更多较弱的边缘，调高可减少细碎线条。应低于上限。",
    highThreshold: "边缘高阈值（Canny high threshold）：调高只保留更明显的轮廓，调低可识别更多边缘。应高于下限。",
    steps: "采样步数（steps）：画面反复细化的次数。更多迭代通常耗时更长，不一定一直提升画质。",
    cfgScale: "提示词引导（CFG）：越高越强调画面描述，过高可能让颜色和细节变得生硬。",
    sampler: "采样器（sampler）：决定画面逐步成形的方法。通常保留当前推荐编号即可。",
    seed: "随机种子（seed）：-1 每次随机；使用相同种子与其他相同设置，有助于复现相似画面。",
    denoisingStrength: "重绘强度（denoising）：越低越保留原图，越高越按描述重新绘制。没有内容图片时不生效。",
};

function SettingField({ label, children, hint, help }: { label: string; children: ReactNode; hint?: string; help?: string }) {
    return (
        <label className="screen-creation-field">
            <span className="screen-creation-setting-label">
                {label}
                {help ? (
                    <Tooltip title={help}>
                        <button type="button" className="screen-creation-help" aria-label={`${label}说明`} aria-description={help}>
                            <CircleHelp aria-hidden="true" />
                        </button>
                    </Tooltip>
                ) : null}
            </span>
            {children}
            {hint ? <small>{hint}</small> : null}
        </label>
    );
}

export function ScreenCreationAdvanced({ advanced, setAdvanced, profile, config, model, generationMode, inpaint, setInpaint, inpaintUnavailableReason, disabled }: Props) {
    const defaults = screenModelDefaults(config, model).defaults;
    const numberField = (key: NumericSetting, label: string, min: number, max?: number, step = 1, hint?: string) => (
        <SettingField label={label} hint={hint} help={settingHelp[key]}>
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
                {generationMode === "img2img" ? <section className="screen-creation-settings-section" aria-label="图生图设置">
                    <h3>图生图设置</h3>
                    <Checkbox aria-label="蒙版重绘" checked={inpaint} disabled={disabled || (!inpaint && Boolean(inpaintUnavailableReason))} onChange={(event) => setInpaint(event.target.checked)}>蒙版重绘</Checkbox>
                    <p className="screen-creation-hint">开启后仅重绘屏幕有效区域内的内容原图，原图尺寸必须与屏幕蒙版完全一致；最终屏外保持黑色。</p>
                    {inpaintUnavailableReason ? <p className="screen-creation-hint" role="status">{inpaintUnavailableReason}</p> : null}
                </section> : null}
                <section className="screen-creation-settings-section" aria-label="ControlNet 设置">
                    <div>
                        <h3>ControlNet 结构控制</h3>
                        <p className="screen-creation-hint">按控制类型提取轮廓、深度、姿态或其他画面信息。</p>
                    </div>
                    <ControlNetParameterFields parameters={screenControlParameters(advanced)} profile={profile?.controlNet} defaults={defaults} disabled={disabled} onChange={(parameters) => setAdvanced(screenSettingsFromControlSelection(advanced, parameters))} />
                    {advanced.controlType === "inpaint" ? <p className="screen-creation-hint">屏幕有效区域同时作为 ControlNet Inpaint 的控制区域蒙版。</p> : null}
                    <Checkbox aria-label="完美像素（Pixel Perfect）" checked={advanced.pixelPerfect ?? true} disabled={disabled} onChange={(event) => setAdvanced({ pixelPerfect: event.target.checked })}>完美像素（Pixel Perfect）</Checkbox>
                    <div className="screen-creation-settings-grid">
                        {numberField("strength", "控制强度", 0, 2, 0.05)}
                        {numberField("start", "开始控制时点", 0, 1, 0.05)}
                        {numberField("end", "结束控制时点", 0, 1, 0.05)}
                    </div>
                </section>
                <section className="screen-creation-settings-section" aria-label="画面细节设置">
                    <h3>画面细节</h3>
                    <div className="screen-creation-settings-grid">
                        {numberField("steps", "细节迭代次数", 1)}
                        {numberField("cfgScale", "描述贴合程度", 0, undefined, 0.5)}
                        {numberField("sampler", "画面生成方法", 0)}
                        {numberField("seed", "复现种子", -1, undefined, 1, "-1 表示每次随机")}
                    </div>
                    {generationMode === "img2img" ? numberField("denoisingStrength", "画面变化幅度", 0, 1, 0.05, inpaint ? "调整屏幕范围内的原图变化，最终屏外保持黑色" : "越低越保留内容原图，越高越按描述重新绘制") : null}
                    <SettingField label="避免出现的内容" help="负向提示词（negative prompt）：描述不希望出现的元素，例如模糊、文字或多余的人物。">
                        <Input.TextArea
                            aria-label="避免出现的内容"
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
