import { useEffect, useRef, useState, type ReactNode, type SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Select } from "antd";
import { Plus, X } from "lucide-react";

import { dramaKeys } from "@/lib/drama/drama-query-keys";
import { dramaChoiceKey } from "@/lib/drama/model-choice";
import { getDrama, updateDramaCastImageOptions, type DramaCast, type DramaCastImageOptions } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";
import { DramaModelPicker, useDramaModelCatalog } from "../drama-model-picker";
import { MediaThumb } from "../drama-shared";
import { CastLibraryPicker } from "./cast-library-picker";
import "./cast-image-options.css";

export function readCastImageOptions(value?: string): DramaCastImageOptions {
    const parsed = value ? JSON.parse(value) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("图片配置格式错误");
    if (
        (parsed.ratio !== undefined && typeof parsed.ratio !== "string") ||
        (parsed.resolution !== undefined && typeof parsed.resolution !== "string") ||
        (parsed.model !== undefined && (!parsed.model || typeof parsed.model !== "object" || Array.isArray(parsed.model)))
    )
        throw new Error("图片配置格式错误");
    for (const key of ["subjectReferenceIds", "styleReferenceIds"] as const) {
        if (parsed[key] !== undefined && (!Array.isArray(parsed[key]) || parsed[key].some((id: unknown) => typeof id !== "string"))) throw new Error("参考图片配置格式错误");
    }
    return { model: parsed.model || {}, ratio: parsed.ratio || "", resolution: parsed.resolution || "", subjectReferenceIds: parsed.subjectReferenceIds || [], styleReferenceIds: parsed.styleReferenceIds || [] };
}

export type CastImageOptionsDraft = { options: DramaCastImageOptions; corrupt: boolean };
export function castImageOptionsDraft(value?: string): CastImageOptionsDraft {
    try {
        return { options: readCastImageOptions(value), corrupt: false };
    } catch {
        return { options: readCastImageOptions(), corrupt: true };
    }
}

export function CastImageOptions({
    projectId,
    cast,
    disabled,
    onChanged,
    onDirtyChange,
    value,
    onChange,
}: {
    projectId: string;
    cast: DramaCast;
    disabled: boolean;
    onChanged: () => void;
    onDirtyChange?: (dirty: boolean) => void;
    value?: CastImageOptionsDraft;
    onChange?: (draft: CastImageOptionsDraft) => void;
}) {
    const userId = useUserStore((state) => state.user?.id || "");
    return <CastImageOptionsSession key={`${userId}:${projectId}:${cast.id}:${value ? "controlled" : cast.imageOptionsJson || ""}`} {...{ projectId, cast, disabled, onChanged, onDirtyChange, userId, value, onChange }} />;
}

function CastImageOptionsSession({ projectId, cast, disabled, onChanged, onDirtyChange, userId, value, onChange }: Parameters<typeof CastImageOptions>[0] & { userId: string }) {
    const { message } = App.useApp();
    const [localCorrupt, setLocalCorrupt] = useState(false);
    const [localOptions, setLocalOptions] = useState<DramaCastImageOptions>(() => {
        try {
            return readCastImageOptions(cast.imageOptionsJson);
        } catch {
            return readCastImageOptions();
        }
    });
    const options = value?.options ?? localOptions;
    const corrupt = value?.corrupt ?? localCorrupt;
    const setCorrupt = (corrupt: boolean) => (value ? onChange?.({ options, corrupt }) : setLocalCorrupt(corrupt));
    const setOptions = (next: SetStateAction<DramaCastImageOptions>) => {
        const options = typeof next === "function" ? next(value?.options ?? localOptions) : next;
        if (value) onChange?.({ options, corrupt });
        else setLocalOptions(options);
    };
    const initial = useRef(JSON.stringify(options));
    const [saving, setSaving] = useState(false);
    const savingRef = useRef(false);
    const mounted = useRef(true);
    const [picker, setPicker] = useState<"subject" | "style">();
    const summary = useQuery({ queryKey: dramaKeys.summary(projectId), queryFn: ({ signal }) => getDrama(projectId, signal) });
    const catalog = useDramaModelCatalog();
    const current = () => mounted.current && (useUserStore.getState().user?.id || "") === userId;
    useEffect(() => {
        mounted.current = true;
        try {
            readCastImageOptions(cast.imageOptionsJson);
        } catch {
            setLocalCorrupt(true);
        }
        return () => {
            mounted.current = false;
        };
    }, []);
    const dirty = initial.current !== JSON.stringify(options);
    useEffect(() => {
        onDirtyChange?.(dirty || saving);
        return () => onDirtyChange?.(false);
    }, [dirty, saving, onDirtyChange]);
    const settings = summary.data?.production.settings;
    const inheritedModel = cast.kind === "character" ? settings?.models.characterImage : cast.kind === "scene" ? settings?.models.sceneImage : settings?.models.propImage;
    const effectiveModel = dramaChoiceKey(options.model) ? options.model : inheritedModel && dramaChoiceKey(inheritedModel) ? inheritedModel : settings?.models.image;
    const model = catalog.data?.options.image.find((item) => dramaChoiceKey(item.choice) === dramaChoiceKey(effectiveModel));
    const ratios = [...new Set([...(model?.imageRatios || []), options.ratio].filter(Boolean))];
    const resolutions = [...new Set([...(model?.imageResolutions || []), options.resolution].filter(Boolean))];
    const referenceCount = options.subjectReferenceIds.length + options.styleReferenceIds.length;
    const save = async () => {
        if (disabled || savingRef.current || !current() || !dirty || corrupt || !summary.data || typeof cast.revision !== "number") return;
        savingRef.current = true;
        setSaving(true);
        try {
            await updateDramaCastImageOptions(projectId, cast.id, summary.data.production.revision, cast.revision, options);
            if (!current()) return;
            initial.current = JSON.stringify(options);
            onDirtyChange?.(false);
            message.success("图片生成配置已保存，下次生成时生效");
            onChanged();
        } catch (error) {
            if (current()) message.error(error instanceof Error ? error.message : "图片配置保存失败");
        } finally {
            savingRef.current = false;
            if (current()) setSaving(false);
        }
    };
    return (
        <section className="drama-cast-image-options" aria-label="图片生成配置">
            <div className="drama-cast-image-options-body">
                {corrupt ? (
                    <p role="alert">
                        原图片配置无法读取。
                        <Button
                            size="small"
                            disabled={disabled || saving}
                            onClick={() => {
                                setCorrupt(false);
                                initial.current = "invalid";
                            }}
                        >
                            重新配置
                        </Button>
                    </p>
                ) : null}
                <Field label="本资产图片模型" hint="未单独指定时沿用该类资产的作品配置">
                    <fieldset disabled={disabled || saving}>
                        <DramaModelPicker
                            capability="image"
                            value={effectiveModel}
                            onChange={(model) => {
                                if (!disabled && !savingRef.current) setOptions({ ...options, model, ratio: "", resolution: "" });
                            }}
                        />
                    </fieldset>
                    <Button size="small" disabled={disabled || saving || !dramaChoiceKey(options.model)} onClick={() => setOptions({ ...options, model: {}, ratio: "", resolution: "" })}>
                        沿用作品模型
                    </Button>
                </Field>
                <div className="drama-cast-image-options-grid">
                    <Field label="图片画幅">
                        <Select
                            aria-label="资产图片画幅"
                            disabled={disabled || saving}
                            value={options.ratio}
                            options={[{ value: "", label: "沿用作品画幅" }, ...ratios.map((value) => ({ value, label: value }))]}
                            onChange={(ratio) => setOptions({ ...options, ratio })}
                        />
                    </Field>
                    <Field label="分辨率">
                        <Select
                            aria-label="资产图片分辨率"
                            disabled={disabled || saving}
                            value={options.resolution}
                            options={[{ value: "", label: "沿用作品分辨率" }, ...resolutions.map((value) => ({ value, label: value.toUpperCase() }))]}
                            onChange={(resolution) => setOptions({ ...options, resolution })}
                        />
                    </Field>
                </div>
                {(["subject", "style"] as const).map((group) => {
                    const key = group === "subject" ? "subjectReferenceIds" : "styleReferenceIds";
                    const label = group === "subject" ? "主体" : "风格";
                    return (
                        <Field key={group} label={`${label}参考`} hint={group === "subject" ? "参考身份、外形与结构；造型仍会先引用角色本体图" : "仅参考画风、材质、光照与色彩"}>
                            <div className="drama-cast-image-reference-row">
                                {options[key].map((id, index) => (
                                    <div key={id} className="drama-cast-image-reference">
                                        <MediaThumb resourceId={id} alt={`${label}参考 ${index + 1}`} />
                                        <Button
                                            type="text"
                                            size="small"
                                            icon={<X className="size-3" />}
                                            aria-label={`移除${label}参考 ${index + 1}`}
                                            disabled={disabled || saving}
                                            onClick={() => setOptions({ ...options, [key]: options[key].filter((value) => value !== id) })}
                                        />
                                    </div>
                                ))}
                                <Button size="small" icon={<Plus className="size-3" />} disabled={disabled || saving || referenceCount >= 8} onClick={() => setPicker(group)}>
                                    从资产库添加
                                </Button>
                            </div>
                        </Field>
                    );
                })}
                {summary.isError ? (
                    <p role="alert">
                        无法读取当前配置。
                        <Button size="small" onClick={() => void summary.refetch()}>
                            重试
                        </Button>
                    </p>
                ) : null}
                <p>保存后仅影响下次生成，已有图片和提示词保留。主体与风格参考合计最多 8 张，实际数量以模型能力为准。</p>
                {!value ? (
                    <Button disabled={disabled || !dirty || corrupt || !summary.data || typeof cast.revision !== "number"} loading={saving} onClick={() => void save()}>
                        保存图片配置
                    </Button>
                ) : null}
            </div>
            {picker ? (
                <CastLibraryPicker
                    open
                    cast={cast}
                    referenceGroup={picker === "subject" ? "主体" : "风格"}
                    onClose={() => setPicker(undefined)}
                    onPick={async (id) => {
                        if (!current() || disabled || savingRef.current) throw new Error("当前状态已变化，请重新选择");
                        if ([...options.subjectReferenceIds, ...options.styleReferenceIds].includes(id)) throw new Error("这张图已在参考组中");
                        if (referenceCount >= 8) throw new Error("参考图片最多 8 张");
                        const key = picker === "subject" ? "subjectReferenceIds" : "styleReferenceIds";
                        setOptions((value) => ({ ...value, [key]: [...value[key], id] }));
                    }}
                />
            ) : null}
        </section>
    );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    return (
        <div className="drama-field">
            <div className="drama-field-label">
                <span>{label}</span>
                {hint ? <small>{hint}</small> : null}
            </div>
            {children}
        </div>
    );
}
