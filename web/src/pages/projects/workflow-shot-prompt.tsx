import { useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Tooltip } from "antd";
import { AtSign } from "lucide-react";

import { CanvasResourceMentionTextarea, type CanvasResourceMentionTextareaActions } from "@/components/canvas/canvas-resource-mention-textarea";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { listDramaCast, type DramaCast, type DramaShot } from "@/services/api/drama";
import type { DramaShotMediaConfig } from "@/services/api/drama-shot-media";

import { parseList } from "./drama-shared";
import { shotImageMentionIds, shotImageMentionToken } from "./workflow-shot-reference-bindings";

const KIND_LABEL = { character: "角色", scene: "场景", prop: "道具" };
const castLabel = (cast: DramaCast) => `${cast.name}${cast.lookName ? ` · ${cast.lookName}` : ""}`;

/** 资产身份来自镜头关联；图片编号仅来自本次实际绑定，不为缺图资产分配图片编号。 */
export function buildShotPromptReferences(shot: DramaShot, casts: DramaCast[], config: DramaShotMediaConfig, kind: "image" | "video"): CanvasResourceReference[] {
    const frameMode = kind === "video" && config.operation === "image_to_video";
    const images = frameMode ? [config.firstFrameResourceId, config.lastFrameResourceId].filter(Boolean) : config.referenceResourceIds;
    const attached = new Set(images);
    const subjectImages = new Map<string, string>();
    for (const id of images) {
        const castId = id && config.referenceSubjects?.[id];
        if (castId && !subjectImages.has(castId)) subjectImages.set(castId, id);
    }
    const ids = new Set([shot.sceneCastId, ...parseList(shot.castIdsJson), ...parseList(shot.lookCastIdsJson), ...parseList(shot.propIdsJson)]);
    const linked = casts.filter((cast) => ids.has(cast.id) || subjectImages.has(cast.id) || (cast.imageResourceId && attached.has(cast.imageResourceId)));
    const lookParents = new Set(linked.filter((cast) => cast.parentId && (ids.has(cast.id) || subjectImages.has(cast.id))).map((cast) => cast.parentId));
    const subjects = linked.filter((cast) => !lookParents.has(cast.id));
    const aliases = new Map<string, Set<string>>();
    const captions = new Map<string, number>();
    for (const cast of subjects) {
        const caption = castLabel(cast);
        captions.set(caption, (captions.get(caption) || 0) + 1);
        for (const raw of [cast.name, caption, ...parseList(cast.aliasesJson)]) {
            const name = raw.trim();
            if (Array.from(name).length < 2) continue;
            if (!aliases.has(name)) aliases.set(name, new Set());
            aliases.get(name)!.add(cast.id);
        }
    }
    const ordinals = new Map<string, number>();
    const assetReferences: CanvasResourceReference[] = subjects.map((cast) => {
        const caption = castLabel(cast);
        const ordinal = (ordinals.get(caption) || 0) + 1;
        ordinals.set(caption, ordinal);
        const label = captions.get(caption)! > 1 || (aliases.get(caption)?.size || 0) > 1 ? `${caption}（${KIND_LABEL[cast.kind]} ${ordinal}）` : caption;
        const imageId = subjectImages.get(cast.id) || cast.imageResourceId;
        const status = !imageId ? "未生成图片" : attached.has(imageId) ? "已附图" : "未附图，按文字设定";
        return {
            id: `shot-cast:${cast.id}`,
            nodeId: "",
            kind: cast.kind === "character" ? "character" : "image",
            label,
            title: `${label} · ${KIND_LABEL[cast.kind]}（${status}）`,
            text: [cast.appearance, cast.description].filter(Boolean).join("；"),
            storageKey: imageId ? `resource:${imageId}` : undefined,
            mentionToken: Array.from(caption).length < 2 || label !== caption ? `@${label}` : label,
            textAliases: [...aliases].filter(([, owners]) => owners.size === 1 && owners.has(cast.id)).map(([name]) => name),
            active: true,
        };
    });
    const imageReferences: CanvasResourceReference[] = frameMode
        ? [
              { id: config.firstFrameResourceId, role: "first", label: "首帧" },
              { id: config.lastFrameResourceId, role: "last", label: "尾帧" },
          ]
              .filter((frame) => frame.id)
              .map((frame) => ({
                  id: `shot-frame:${frame.role}`,
                  nodeId: "",
                  kind: "image",
                  label: frame.label,
                  title: `${frame.label} · ${config.referenceNames?.[frame.id!] || "本镜图片"}`,
                  storageKey: `resource:${frame.id}`,
                  mentionToken: frame.label,
                  active: true,
              }))
        : config.referenceResourceIds.map((id, index) => ({
              id: `shot-ref:${id}`,
              nodeId: "",
              kind: "image",
              label: `参考图${index + 1}`,
              title: config.referenceNames?.[id] || casts.find((cast) => cast.id === config.referenceSubjects?.[id] || cast.imageResourceId === id)?.name || `参考图${index + 1}`,
              storageKey: `resource:${id}`,
              mentionToken: shotImageMentionToken(id),
              textAliases: [`参考图${index + 1}`],
              active: true,
          }));
    const missingImages: CanvasResourceReference[] = shotImageMentionIds(config.prompt)
        .filter((id) => frameMode || !config.referenceResourceIds.includes(id))
        .map((id) => ({
            id: `shot-ref:${id}`,
            nodeId: "",
            kind: "image",
            label: "已移除图片",
            title: "引用的图片已移除，请重新选择图片或删除此引用",
            mentionToken: shotImageMentionToken(id),
            active: true,
            mentionMenuHidden: true,
        }));
    return [...assetReferences, ...imageReferences, ...missingImages];
}

export function WorkflowShotPromptEditor({
    projectId,
    userId,
    shot,
    kind,
    config,
    disabled,
    onChange,
}: {
    projectId: string;
    userId: string;
    shot: DramaShot;
    kind: "image" | "video";
    config: DramaShotMediaConfig;
    disabled: boolean;
    onChange: (patch: Partial<DramaShotMediaConfig>) => void;
}) {
    const actions = useRef<CanvasResourceMentionTextareaActions | null>(null);
    const casts = useQuery({
        queryKey: ["drama-shot-reference-cast", userId, projectId],
        queryFn: ({ signal }) => listDramaCast(projectId, signal),
        staleTime: 20_000,
        refetchInterval: (query) => (query.state.data?.cast.some((cast) => ["queued", "running"].includes(cast.imageStatus)) ? 3000 : false),
    });
    const references = useMemo(() => buildShotPromptReferences(shot, casts.data?.cast || [], config, kind), [shot, casts.data, config, kind]);
    const missingImages = references.some((reference) => reference.mentionMenuHidden);
    return (
        <section className="drama-shot-media-prompt">
            <div className="drama-shot-prompt-heading">
                <span>提示词</span>
                <Tooltip title="在光标处引用本镜头的资产或参考图" placement="top">
                    <button
                        type="button"
                        aria-label="插入资产或参考图引用"
                        disabled={disabled || !references.some((reference) => !reference.mentionMenuHidden)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                            actions.current?.insertTextAtSelection("@");
                            actions.current?.focus();
                        }}
                    >
                        <AtSign aria-hidden /> 引用
                    </button>
                </Tooltip>
            </div>
            <CanvasResourceMentionTextarea
                actionsRef={actions}
                value={config.prompt}
                references={references}
                disabled={disabled}
                onChange={(prompt) => onChange({ prompt, promptSourceHash: "" })}
                sendOnEnter={false}
                includeAssetLibrary={false}
                mentionMenuLabels={{ connected: "本镜头资产与参考图", search: "搜索资产或参考图" }}
                containerClassName="drama-shot-prompt-field"
                className="drama-shot-prompt-input thin-scrollbar"
                style={{ color: "var(--foreground)" }}
                aria-label="镜头媒体提示词"
                placeholder={config.prompt ? "" : "输入提示词，输入 @ 引用本镜头的资产或参考图"}
            />
            {missingImages ? <small role="alert">提示词引用的图片已移除，请重新选择图片或删除对应引用。</small> : null}
        </section>
    );
}
