import { useEffect, useRef, useState } from "react";
import { App, Button, Input, Switch } from "antd";
import { RefreshCw } from "lucide-react";

import { defaultDramaStyleForType, dramaStylePresetsForType, findDramaStyle } from "@/lib/drama/drama-styles";
import { rebuildDramaCastImagePrompt, type DramaCastImageStyle, type DramaSettings } from "@/services/api/drama";
import { useDramaOperationScope } from "./use-drama-operation-scope";

export type CastImageFieldsValue = DramaCastImageStyle & { imagePrompt?: string };

export function CastImageFields({
    projectId,
    episodeId,
    castId,
    dramaType,
    appearance,
    value,
    onChange,
    disabled = false,
}: {
    projectId: string;
    episodeId?: string;
    castId?: string;
    dramaType?: DramaSettings["dramaType"];
    appearance: string;
    value: CastImageFieldsValue;
    onChange: (patch: CastImageFieldsValue) => void;
    disabled?: boolean;
}) {
    const { message, modal } = App.useApp();
    const operation = useDramaOperationScope(projectId);
    const [building, setBuilding] = useState(false);
    const buildingRef = useRef(false);
    const confirmation = useRef<{ destroy: () => void } | undefined>(undefined);
    useEffect(() => () => confirmation.current?.destroy(), []);
    const snapshot = JSON.stringify({ projectId, episodeId, castId, appearance, ...value });
    const latest = useRef(snapshot);
    latest.current = snapshot;
    const ownStyle = Boolean(value.imageStyleId || value.imageStyleName || value.imageStylePrompt);
    const presets = dramaStylePresetsForType(dramaType);
    const currentPreset = presets.find((style) => style.id === value.imageStyleId);
    const chooseStyle = (id: string) => {
        const style = findDramaStyle(id);
        if (style) onChange({ imageStyleId: style.id, imageStyleName: style.name, imageStylePrompt: style.prompt });
    };
    const rebuild = async (ticket: ReturnType<typeof operation.capture>, accepted: string) => {
        if (!castId || !operation.isCurrent(ticket) || latest.current !== accepted) return;
        try {
            const result = await rebuildDramaCastImagePrompt(projectId, castId, {
                appearance,
                imageStyleId: value.imageStyleId || "",
                imageStyleName: value.imageStyleName || "",
                imageStylePrompt: value.imageStylePrompt || "",
                ...(episodeId ? { episodeId } : {}),
            });
            if (!operation.isCurrent(ticket)) return;
            if (latest.current === accepted) {
                onChange({ imagePrompt: result.imagePrompt });
                message.success("提示词已重新编排");
            } else message.info("设定已变化，请按最新内容重新编排提示词");
        } catch (error) {
            if (operation.isCurrent(ticket)) message.error(error instanceof Error ? error.message : "编排提示词失败");
        } finally {
            buildingRef.current = false;
            if (operation.isCurrent(ticket)) setBuilding(false);
        }
    };
    const requestRebuild = () => {
        if (!castId || disabled || buildingRef.current || !appearance.trim()) return;
        const ticket = operation.capture();
        const accepted = snapshot;
        buildingRef.current = true;
        setBuilding(true);
        if (!value.imagePrompt?.trim()) return void rebuild(ticket, accepted);
        confirmation.current = modal.confirm({
            title: "重新编排会替换当前提示词",
            content: "确认后重新编排并替换当前提示词，不会生成图片。",
            okText: "确认替换",
            cancelText: "取消",
            centered: true,
            onOk: async () => {
                confirmation.current = undefined;
                if (operation.isCurrent(ticket) && latest.current === accepted) await rebuild(ticket, accepted);
                else {
                    buildingRef.current = false;
                    if (operation.isCurrent(ticket)) {
                        setBuilding(false);
                        message.info("设定已变化，请按最新内容重新编排提示词");
                    }
                }
            },
            onCancel: () => {
                confirmation.current = undefined;
                buildingRef.current = false;
                if (operation.isCurrent(ticket)) setBuilding(false);
            },
        });
    };
    return (
        <div className="drama-cast-image-fields">
            <label className="drama-switch-label">
                <Switch size="small" checked={ownStyle} disabled={disabled || building} onChange={(checked) => (checked ? chooseStyle(defaultDramaStyleForType(dramaType).id) : onChange({ imageStyleId: "", imageStyleName: "", imageStylePrompt: "" }))} />
                为此设定单独设置风格
            </label>
            {ownStyle ? (
                <label className="drama-field">
                    <span className="drama-field-label">参考图风格</span>
                    <select aria-label="参考图风格" value={currentPreset?.id || ""} disabled={disabled || building} onChange={(event) => chooseStyle(event.target.value)}>
                        {currentPreset ? null : (
                            <option value="" disabled>
                                {value.imageStyleName || "当前风格"}
                            </option>
                        )}
                        {presets.map((style) => (
                            <option key={style.id} value={style.id}>
                                {style.name}
                            </option>
                        ))}
                    </select>
                </label>
            ) : (
                <small className="drama-editor-note">沿用{episodeId ? "本集" : "作品"}风格；穿越、幼年或不同世界的造型可在此单独选择。</small>
            )}
            <div className="drama-field-label">
                <span>参考图生成提示词</span>
                {castId ? (
                    <Button size="small" type="text" icon={<RefreshCw className="size-3.5" />} loading={building} disabled={disabled || !appearance.trim()} onClick={requestRebuild}>
                        重新编排提示词
                    </Button>
                ) : null}
            </div>
            <Input.TextArea
                aria-label="参考图生成提示词"
                value={value.imagePrompt || ""}
                maxLength={12000}
                autoSize={{ minRows: 3, maxRows: 8 }}
                disabled={disabled || building}
                placeholder={`留空使用${episodeId ? "本集" : "作品"}模板；也可填写自己的生图要求`}
                onChange={(event) => onChange({ imagePrompt: event.target.value })}
            />
            <small className="drama-editor-note">留空使用{episodeId ? "本集" : "作品"}模板；切换模板或风格后可重新编排，已有人工提示词不会自动修改。点击生成才开始生图。</small>
        </div>
    );
}
