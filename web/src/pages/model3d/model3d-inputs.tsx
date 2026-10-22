import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Collapse, Input, InputNumber, Select, Switch } from "antd";
import { ImagePlus, Sparkles, X } from "lucide-react";
import { CachedResourceImage } from "@/components/cached-resource-image";
import { MODEL3D_MODE_LABELS, MODEL3D_VIEWS, MODEL3D_VIEW_LABELS, model3DFaceRange, normalizeModel3DParameters, type Model3DDraft, type Model3DImageBinding } from "@/lib/canvas/model3d";
import type { Model3DCapabilities, Model3DParameters } from "@/services/api/model3d";

export type Model3DInputsProps = {
    draft: Model3DDraft;
    capabilities: Model3DCapabilities | null;
    count: number;
    disabled: boolean;
    onChange: (update: (draft: Model3DDraft) => Model3DDraft) => void;
    onCountChange: (count: number) => void;
    onUpload: (file: File) => Promise<Model3DImageBinding>;
    onIdeas: () => void;
};

export function Model3DInputs({ draft, capabilities, count, disabled, onChange, onCountChange, onUpload, onIdeas }: Model3DInputsProps) {
    const parameters = normalizeModel3DParameters(draft.mode, draft.parameters, capabilities);
    const version = capabilities?.modelVersions.find((version) => version.id === parameters.model);
    const range = model3DFaceRange(parameters, capabilities);
    const update = (change: (draft: Model3DDraft) => Model3DDraft) =>
        onChange((current) => {
            const next = change(current);
            return { ...next, parameters: normalizeModel3DParameters(next.mode, next.parameters, capabilities) };
        });
    const setParameter = <K extends keyof Model3DParameters>(key: K, value: Model3DParameters[K]) => update((current) => ({ ...current, parameters: { ...current.parameters, [key]: value } }));
    return (
        <div className="model3d-inputs">
            <div className="model3d-section-heading">
                <span className="model3d-step">1</span>
                <h2>描述你的模型</h2>
            </div>
            <div className="model3d-mode-switch" role="group" aria-label="3D 输入方式">
                {(["text", "image", "multiview"] as const).map((mode) => (
                    <button type="button" key={mode} disabled={disabled || !capabilities?.modes.includes(mode)} aria-pressed={draft.mode === mode} onClick={() => update((current) => ({ ...current, mode }))}>
                        {MODEL3D_MODE_LABELS[mode]}
                    </button>
                ))}
            </div>
            {draft.mode === "text" ? (
                <Field label="模型描述">
                    <Input.TextArea
                        aria-label="模型描述"
                        value={draft.prompt}
                        rows={5}
                        maxLength={1024}
                        showCount
                        disabled={disabled}
                        placeholder="描述一个完整的物体：轮廓、比例、结构、材质和颜色…"
                        onChange={(event) => update((current) => ({ ...current, prompt: event.target.value }))}
                    />
                    <Button type="text" icon={<Sparkles className="size-4" />} onClick={onIdeas} disabled={disabled}>
                        帮我想想
                    </Button>
                </Field>
            ) : draft.mode === "image" ? (
                <Model3DImageInput label="参考图片" value={draft.image} capabilities={capabilities} disabled={disabled} onUpload={onUpload} onChange={(image) => update((current) => ({ ...current, image }))} />
            ) : (
                <div className="model3d-image-grid">
                    {MODEL3D_VIEWS.map((view) => (
                        <Model3DImageInput
                            key={view}
                            label={`${MODEL3D_VIEW_LABELS[view]}${view === "front" ? "（必选）" : ""}`}
                            value={draft.views[view]}
                            capabilities={capabilities}
                            disabled={disabled}
                            onUpload={onUpload}
                            onChange={(image) => update((current) => ({ ...current, views: { ...current.views, [view]: image } }))}
                        />
                    ))}
                    <p className="model3d-hint">至少上传正面与另一个视角，视角之间不能重复。</p>
                </div>
            )}
            <div className="model3d-section-heading">
                <span className="model3d-step">2</span>
                <h2>确认形态与精度</h2>
            </div>
            <Field label="生成模型">
                <Select
                    aria-label="生成模型"
                    className="w-full"
                    value={parameters.model || undefined}
                    disabled={disabled}
                    placeholder="选择模型"
                    options={capabilities?.modelVersions.map((model) => ({ value: model.id, label: model.label }))}
                    onChange={(model) => setParameter("model", model)}
                />
            </Field>
            <Field label="模型形态">
                <div className="model3d-mode-switch" role="group" aria-label="模型形态">
                    <button type="button" disabled={disabled} aria-pressed={parameters.texture} onClick={() => update((current) => ({ ...current, parameters: { ...current.parameters, texture: true, pbr: true } }))}>
                        带纹理模型
                    </button>
                    <button type="button" disabled={disabled} aria-pressed={!parameters.texture} onClick={() => setParameter("texture", false)}>
                        白模
                    </button>
                </div>
            </Field>
            <div className="model3d-field-row">
                <Field label="目标面数">
                    <InputNumber
                        aria-label="目标面数"
                        className="!w-full"
                        min={range.min}
                        max={range.max}
                        precision={0}
                        step={10000}
                        value={parameters.faceLimit}
                        placeholder="输入面数"
                        disabled={disabled}
                        onChange={(value) => setParameter("faceLimit", value ?? undefined)}
                    />
                    <small className="model3d-hint">
                        {range.min.toLocaleString()}–{range.max?.toLocaleString() || "服务允许的上限"}，实际面数以产物为准
                    </small>
                </Field>
                <Field label="候选版本">
                    <Select aria-label="候选版本数量" className="w-full" value={count} disabled={disabled} options={[1, 2, 3, 4].map((value) => ({ value, label: `${value} 个版本` }))} onChange={onCountChange} />
                    <small className="model3d-hint">每个版本独立生成并记录</small>
                </Field>
            </div>
            <Collapse
                ghost
                size="small"
                items={[
                    {
                        key: "advanced",
                        label: "更多模型参数",
                        children: (
                            <div className="model3d-advanced">
                                {version?.supportsAdvanced ? (
                                    <>
                                        <Field label="几何质量">
                                            <Select
                                                aria-label="几何质量"
                                                className="w-full"
                                                value={parameters.geometryQuality || "standard"}
                                                disabled={disabled}
                                                options={[
                                                    { value: "standard", label: "标准" },
                                                    { value: "detailed", label: "精细" },
                                                ]}
                                                onChange={(value) => setParameter("geometryQuality", value)}
                                            />
                                        </Field>
                                        <Field label="面片形态">
                                            <Select
                                                aria-label="面片形态"
                                                className="w-full"
                                                value={parameters.quad ? "quad" : "triangle"}
                                                disabled={disabled}
                                                options={[
                                                    { value: "triangle", label: "三角面（GLB）" },
                                                    { value: "quad", label: "四边面（FBX）" },
                                                ]}
                                                onChange={(value) => setParameter("quad", value === "quad")}
                                            />
                                        </Field>
                                        <Field label="低多边形优化">
                                            <Switch aria-label="低多边形优化" disabled={disabled} checked={Boolean(parameters.smartLowPoly)} onChange={(value) => setParameter("smartLowPoly", value)} />
                                        </Field>
                                    </>
                                ) : null}
                                <Field label="PBR 材质">
                                    <Switch aria-label="PBR 材质" disabled={disabled || !parameters.texture} checked={parameters.pbr} onChange={(value) => setParameter("pbr", value)} />
                                </Field>
                                <Field label="模型种子（留空为随机）">
                                    <InputNumber aria-label="模型种子" className="!w-full" precision={0} value={parameters.modelSeed} disabled={disabled} onChange={(value) => setParameter("modelSeed", value ?? undefined)} />
                                </Field>
                                {count > 1 && parameters.modelSeed !== undefined ? <p className="model3d-hint">相同种子可能产生相似结果；需要更多变化时请留空。</p> : null}
                            </div>
                        ),
                    },
                ]}
            />
        </div>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="model3d-field">
            <span className="model3d-field-label">{label}</span>
            {children}
        </div>
    );
}

function Model3DImageInput({
    label,
    value,
    capabilities,
    disabled,
    onChange,
    onUpload,
}: {
    label: string;
    value?: Model3DImageBinding;
    capabilities: Model3DCapabilities | null;
    disabled: boolean;
    onChange: (image?: Model3DImageBinding) => void;
    onUpload: (file: File) => Promise<Model3DImageBinding>;
}) {
    const input = useRef<HTMLInputElement>(null);
    const request = useRef(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    useEffect(
        () => () => {
            ++request.current;
        },
        [],
    );
    return (
        <div className="model3d-upload">
            <span className="model3d-field-label">{label}</span>
            <input
                ref={input}
                type="file"
                className="sr-only"
                tabIndex={-1}
                accept={capabilities?.inputLimits.mimeTypes.join(",") || "image/png,image/jpeg"}
                aria-label={`上传${label}`}
                disabled={disabled || busy}
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    const revision = ++request.current;
                    setBusy(true);
                    setError("");
                    void onUpload(file)
                        .then((image) => {
                            if (request.current === revision) onChange(image);
                        })
                        .catch((cause) => {
                            if (request.current === revision) setError(cause instanceof Error ? cause.message : "图片上传失败");
                        })
                        .finally(() => {
                            if (request.current === revision) setBusy(false);
                        });
                }}
            />
            <button type="button" className="model3d-upload-target" disabled={disabled || busy} onClick={() => input.current?.click()} aria-label={`选择${label}`}>
                {value ? <CachedResourceImage storageKey={value.storageKey} src={value.url} alt={label} className="model3d-reference-image" /> : <ImagePlus className="size-6" />}
                <span>{busy ? "正在上传…" : value?.title || "点击上传图片"}</span>
            </button>
            {value ? (
                <Button
                    size="small"
                    type="text"
                    icon={<X className="size-3" />}
                    disabled={disabled || busy}
                    onClick={() => {
                        ++request.current;
                        onChange(undefined);
                    }}
                >
                    移除图片
                </Button>
            ) : null}
            {error ? (
                <p role="alert" className="model3d-error">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
