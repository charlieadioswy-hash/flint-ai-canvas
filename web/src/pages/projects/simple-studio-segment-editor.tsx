import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { App } from "antd";

import {
    deleteDramaShot,
    insertDramaShot,
    reprocessDramaSegmentVideo,
    updateDramaSegment,
    updateDramaSegmentReferences,
    updateDramaShot,
    writeDramaSegmentPrompts,
    type DramaCast,
    type DramaEpisodeDetail,
    type DramaModelChoice,
    type DramaSegment,
    type DramaSegmentReferencePatch,
    type DramaShot,
    type DramaShotPatch,
    type DramaSummary,
} from "@/services/api/drama";
import { activeDramaGuide } from "./guide-state";
import { SegmentDialog } from "./studio/segment-dialog";
import { useDramaInvalidate, useOpenDramaCanvas } from "./studio/use-studio";

export type SimpleStudioSegmentEditorProps = {
    summary: DramaSummary;
    detail?: DramaEpisodeDetail;
    episodeId: string;
    segmentIndex?: number;
    shotId?: string;
    castById: Map<string, DramaCast>;
    busy?: boolean;
    onClose: () => void;
    onNavigate: (segmentIndex: number, shotId?: string) => void;
    /** 只进入父页面的 Agent 预检与确认，不在编辑器内放行媒体。 */
    onGenerate: (segment: DramaSegment, model?: DramaModelChoice) => void;
    onOpenAdvancedCast: (castId: string) => void;
};

/** 简易台复用详细制作台的真实段编辑器，切换作品时隔离在途写入。 */
export function SimpleStudioSegmentEditor(props: SimpleStudioSegmentEditorProps) {
    return <SegmentEditorSession key={props.summary.project.id} {...props} />;
}

type SegmentTarget = { episodeId: string; segment: DramaSegment };
type ShotTarget = { episodeId: string; segmentIndex: number; shot: DramaShot };

function SegmentEditorSession({ summary, detail, episodeId, segmentIndex, shotId, castById, busy = false, onClose, onNavigate, onGenerate, onOpenAdvancedCast }: SimpleStudioSegmentEditorProps) {
    const projectId = summary.project.id;
    const { message } = App.useApp();
    const invalidate = useDramaInvalidate(projectId);
    const canvas = useOpenDramaCanvas(summary);
    const current = detail?.episode.projectId === projectId && detail.episode.id === episodeId ? detail : undefined;
    const selection = useRef<{ episodeId: string; segmentIndex?: number } | null>({ episodeId, segmentIndex });
    useEffect(() => {
        selection.current = { episodeId, segmentIndex };
        return () => {
            selection.current = null;
        };
    }, [episodeId, segmentIndex]);
    // expectedRevision 属于引导编辑协议；已结束引导的制作台按原编辑接口保存。
    const expectedRevision = activeDramaGuide(summary.production.guideStep) ? summary.production.revision : undefined;
    const errorMessage = (error: unknown, fallback: string) => message.error(error instanceof Error ? error.message : fallback);
    const stillSelected = (target: { episodeId: string; segmentIndex: number }) => selection.current?.episodeId === target.episodeId && selection.current.segmentIndex === target.segmentIndex;

    const patchShot = useMutation({
        mutationFn: ({ shot, patch, revision }: ShotTarget & { patch: DramaShotPatch; revision?: number }) => updateDramaShot(projectId, shot.id, { ...patch, ...(revision === undefined ? {} : { expectedRevision: revision }) }),
        onSuccess: () => message.success("已保存，本段提示词与视频已标记过期，请重新确认"),
        onError: (error) => errorMessage(error, "保存失败"),
        onSettled: (_, __, target) => invalidate(target.episodeId),
    });
    const insertShot = useMutation({
        mutationFn: ({ shot, position }: ShotTarget & { position: "before" | "after" }) => insertDramaShot(projectId, shot.id, position),
        onSuccess: ({ shot }, target) => {
            if (stillSelected(target)) onNavigate(target.segmentIndex, shot.id);
            message.success("已插入空镜头，填写动作或台词后本段提示词需重新撰写");
        },
        onError: (error) => errorMessage(error, "插入失败"),
        onSettled: (_, __, target) => invalidate(target.episodeId),
    });
    const removeShot = useMutation({
        mutationFn: ({ shot }: ShotTarget) => deleteDramaShot(projectId, shot.id),
        onSuccess: (_, target) => {
            if (stillSelected(target)) onNavigate(target.segmentIndex);
            message.success("已删除镜头，本段提示词与视频已标记过期");
        },
        onError: (error) => errorMessage(error, "删除失败"),
        onSettled: (_, __, target) => invalidate(target.episodeId),
    });
    const savePrompt = useMutation({
        mutationFn: ({ episodeId: targetEpisodeId, segment, override, revision }: SegmentTarget & { override: string; revision?: number }) => updateDramaSegment(projectId, targetEpisodeId, segment.index, override, revision),
        onSuccess: (_, { override }) => message.success(override ? "已保存完整视频提示词" : "已恢复模型撰写的版本"),
        onError: (error) => errorMessage(error, "保存失败"),
        onSettled: (_, __, target) => invalidate(target.episodeId),
    });
    const saveReferences = useMutation({
        mutationFn: ({ episodeId: targetEpisodeId, segment, patch }: SegmentTarget & { patch: DramaSegmentReferencePatch }) => updateDramaSegmentReferences(projectId, targetEpisodeId, segment.index, patch),
        onSuccess: async (_, target) => {
            await invalidate(target.episodeId);
            message.success("已保存本段参考与音色选择，请核对提示词中的参考编号");
        },
        onError: (error, target) => {
            void invalidate(target.episodeId);
            errorMessage(error, "保存失败");
        },
    });
    const writePrompt = useMutation({
        mutationFn: ({ episodeId: targetEpisodeId, segment }: SegmentTarget) => writeDramaSegmentPrompts(projectId, targetEpisodeId, [segment.index]),
        onSuccess: () => message.success("已开始撰写本段视频提示词"),
        onError: (error) => errorMessage(error, "撰写失败"),
        onSettled: (_, __, target) => invalidate(target.episodeId),
    });
    const reprocess = useMutation({
        mutationFn: ({ episodeId: targetEpisodeId, segment }: SegmentTarget) => reprocessDramaSegmentVideo(projectId, targetEpisodeId, segment.index),
        onSuccess: () => message.success("正在重新处理已有视频，不会重新生成"),
        onError: (error) => errorMessage(error, "重新处理失败"),
        onSettled: (_, __, target) => invalidate(target.episodeId),
    });

    const segmentTarget = (segment: DramaSegment): SegmentTarget | undefined => {
        const latest = current?.segments.find((item) => item.id === segment.id && item.index === segment.index);
        if (latest && current) return { episodeId: current.episode.id, segment: latest };
    };
    const shotTarget = (shot: DramaShot): ShotTarget | undefined => {
        const latest = current?.shots.find((item) => item.id === shot.id && item.projectId === projectId && item.episodeId === current.episode.id);
        if (latest) return { episodeId: latest.episodeId, segmentIndex: latest.segmentIndex, shot: latest };
    };
    const withSegment = (segment: DramaSegment, action: (target: SegmentTarget) => void) => {
        const target = segmentTarget(segment);
        if (target) action(target);
        else message.error("本段内容已变化，请重新打开分镜");
    };
    const withShot = (shot: DramaShot, action: (target: ShotTarget) => void) => {
        const target = shotTarget(shot);
        if (target) action(target);
        else message.error("镜头内容已变化，请重新打开分镜");
    };

    return (
        <SegmentDialog
            detail={current}
            segmentIndex={segmentIndex}
            shotId={shotId}
            castById={castById}
            aspectRatio={summary.production.settings.aspectRatio}
            busy={busy || patchShot.isPending || insertShot.isPending || removeShot.isPending || savePrompt.isPending || saveReferences.isPending || writePrompt.isPending || reprocess.isPending}
            writing={writePrompt.isPending}
            onClose={onClose}
            onNavigate={onNavigate}
            onPatchShot={(shot, patch) => withShot(shot, (target) => patchShot.mutate({ ...target, patch, revision: expectedRevision }))}
            onInsertShot={(shot, position) => withShot(shot, (target) => insertShot.mutate({ ...target, position }))}
            onDeleteShot={(shot) => withShot(shot, (target) => removeShot.mutate(target))}
            onSavePrompt={(segment, override) => withSegment(segment, (target) => savePrompt.mutate({ ...target, override, revision: expectedRevision }))}
            onSaveReferences={async (segment, patch) => {
                const target = segmentTarget(segment);
                if (!target) throw new Error("本段内容已变化，请重新打开分镜");
                return saveReferences.mutateAsync({ ...target, patch });
            }}
            onWritePrompt={(segment) => withSegment(segment, (target) => writePrompt.mutate(target))}
            onGenerate={(segment, model) => withSegment(segment, (target) => onGenerate(target.segment, model))}
            reprocessing={reprocess.isPending}
            onReprocess={(segment) => withSegment(segment, (target) => reprocess.mutate(target))}
            defaultVideoModel={summary.production.settings.models.video}
            videoResolution={summary.production.settings.videoResolution}
            onOpenCast={onOpenAdvancedCast}
            onOpenCanvas={(segment) => withSegment(segment, (target) => void canvas.open({ kind: "segment", episodeId: target.episodeId, segmentIndex: target.segment.index }))}
            canvasOpening={Boolean(canvas.opening?.startsWith("segment:"))}
        />
    );
}
