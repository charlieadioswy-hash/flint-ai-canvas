import { useState } from "react";
import { App, Button, Popconfirm } from "antd";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History } from "lucide-react";

import { dramaKeys } from "@/lib/drama/drama-query-keys";
import { formatRelativeTime } from "@/lib/relative-time";
import { ApiError } from "@/services/api/request";
import { DRAMA_ERROR_REASON, listDramaTakes, restoreDramaSegmentTake, type DramaTake, type DramaTakeKind, type DramaTakeSource } from "@/services/api/drama";

import { MediaThumb } from "../drama-shared";
import type { useCastHistoryDrag } from "./cast-history-drag";

import { secondsLabel } from "./segment-parts";

const SOURCE_LABEL: Record<DramaTakeSource, string> = { pipeline: "生成", upload: "上传", canvas: "来自画布" };

type Props = {
    projectId: string;
    ownerId: string;
    kind: DramaTakeKind;
    limit?: number;
    showHeading?: boolean;
    onPreviewImage?: (take: DramaTake) => void;
    imageDrag?: { sourceProps: (take: DramaTake) => ReturnType<ReturnType<typeof useCastHistoryDrag>["sourceProps"]>; error?: string };
    /** 当前正在右侧预览的版本；仅展示，不写库。 */
    previewTakeId?: string;
    onPreview?: (take: DramaTake) => void;
    /** 段视频可把历史版本设为当前；需要集与段序号。 */
    switchCurrent?: { episodeId: string; segmentIndex: number; expectedRevision?: number };
};

/** 设定参考图、剧情段视频或成片的版本记录，新版本在前；标出来源（流水线生成、上传、从精修画布采用）与当前版本。 */
export function DramaTakeList({ projectId, ownerId, kind, limit = 6, showHeading = true, onPreviewImage, imageDrag, previewTakeId, onPreview, switchCurrent }: Props) {
    const [expanded, setExpanded] = useState(false);
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const query = useQuery({
        queryKey: dramaKeys.takes(projectId, kind, ownerId),
        queryFn: ({ signal }) => listDramaTakes(projectId, ownerId, kind, signal),
        enabled: Boolean(projectId && ownerId),
        staleTime: 10_000,
        ...(kind === "cast" ? { refetchOnMount: "always" as const } : {}),
    });
    const restore = useMutation({
        mutationFn: (take: DramaTake) => {
            if (!switchCurrent) throw new Error("该类型暂不支持切换当前版本");
            return restoreDramaSegmentTake(projectId, switchCurrent.episodeId, switchCurrent.segmentIndex, {
                takeId: take.id,
                expectedRevision: switchCurrent.expectedRevision,
            });
        },
        onSuccess: async (result, take) => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: ["drama", projectId, "takes"] }),
                queryClient.invalidateQueries({ queryKey: dramaKeys.episode(projectId, switchCurrent?.episodeId || "") }),
                queryClient.invalidateQueries({ queryKey: dramaKeys.summary(projectId), exact: true }),
                queryClient.invalidateQueries({ queryKey: dramaKeys.jobs(projectId) }),
            ]);
            if (result.unchanged) message.info(`V${take.version} 已经是当前版本`);
            else {
                message.success(`已把 V${take.version} 设为当前版本`);
                if (result.videoError) message.warning(result.videoError);
            }
            onPreview?.(take);
        },
        onError: (error) => {
            if (error instanceof ApiError && error.reason === DRAMA_ERROR_REASON.segmentChanged) {
                message.warning("剧情段刚被修改，请刷新后再切换");
                void queryClient.invalidateQueries({ queryKey: dramaKeys.episode(projectId, switchCurrent?.episodeId || "") });
                return;
            }
            message.error(error instanceof Error && error.message ? error.message : "切换当前版本失败");
        },
    });
    const canExpand = kind === "cast" && Boolean(onPreviewImage);
    const cursor = query.data?.nextBeforeTakeId;
    const older = useInfiniteQuery({
        queryKey: [...dramaKeys.takes(projectId, kind, ownerId), "older", cursor],
        queryFn: ({ pageParam, signal }) => listDramaTakes(projectId, ownerId, kind, signal, pageParam),
        initialPageParam: cursor,
        getNextPageParam: (page) => page.nextBeforeTakeId,
        enabled: expanded && canExpand && Boolean(cursor),
        staleTime: 10_000,
    });
    // 首屏可能附带很早的当前记录，后续页读到同一条时沿用首屏的标记。
    const byId = new Map((query.data?.takes || []).map((take) => [take.id, take]));
    const currentId = query.data?.takes.find((take) => take.current)?.id;
    for (const page of older.data?.pages || []) {
        for (const take of page.takes) {
            if (!byId.has(take.id)) byId.set(take.id, { ...take, current: take.id === currentId });
        }
    }
    const takes = [...byId.values()].sort((left, right) => right.version - left.version);
    const visibleTakes = expanded ? takes : takes.filter((take, index) => index < limit || (canExpand && take.current));
    const hasOlderTakes = takes.length > limit || Boolean(cursor);
    const switchable = kind === "video" && Boolean(switchCurrent);
    if (!projectId || !ownerId) return null;
    const status = query.isPending ? "正在读取版本…" : query.isError ? "版本记录读取失败" : !takes.length ? "暂无版本记录" : "";
    return (
        <section className="drama-takes" aria-label="版本记录">
            {showHeading ? (
                <div className="drama-takes-head">
                    <History className="size-3.5" aria-hidden />
                    <span>版本记录</span>
                    {!status ? (
                        <small>
                            {takes.length}
                            {cursor && (!older.data || older.hasNextPage) ? "+" : ""}
                        </small>
                    ) : null}
                </div>
            ) : null}
            {status ? (
                <p className={`drama-sg-note${query.isError ? " is-warn" : ""}`} role="status">
                    {status}
                </p>
            ) : null}
            {!status ? (
                <ol className="drama-takes-list">
                    {visibleTakes.map((take) => {
                        const { resourceId, version } = take;
                        const castImage = kind === "cast" && resourceId;
                        const previewing = previewTakeId === take.id && !take.current;
                        const className = take.current ? "is-current" : previewing ? "is-preview" : undefined;
                        const meta = takeMeta(take);
                        const content = (
                            <>
                                {kind === "cast" ? (
                                    <span className="drama-take-thumb">
                                        <MediaThumb resourceId={resourceId} alt={`V${version}`} />
                                    </span>
                                ) : null}
                                <b>V{version}</b>
                                <span className={`drama-take-source is-${take.source}`}>{SOURCE_LABEL[take.source]}</span>
                                {meta ? <span className="drama-take-meta">{meta}</span> : null}
                                <time dateTime={take.createdAt}>{formatRelativeTime(take.createdAt)}</time>
                            </>
                        );
                        const label = `放大查看 V${version}`;
                        return (
                            <li key={take.id} className={className}>
                                {castImage && onPreviewImage ? (
                                    <button type="button" className="drama-take-preview" aria-label={label} aria-haspopup="dialog" title={label} onClick={() => onPreviewImage(take)} {...imageDrag?.sourceProps(take)}>
                                        {content}
                                    </button>
                                ) : onPreview && resourceId ? (
                                    <button type="button" className="drama-take-preview" onClick={() => onPreview(take)} aria-pressed={previewTakeId === take.id} aria-label={take.current ? `预览当前版本 V${take.version}` : `预览 V${take.version}`}>
                                        {content}
                                    </button>
                                ) : (
                                    content
                                )}
                                {take.current ? <em>当前</em> : previewing ? <em>预览中</em> : null}
                                {switchable && !take.current ? (
                                    <Popconfirm
                                        title={`把 V${take.version} 设为本段当前视频？`}
                                        description="只改本段当前版本，成片会标记为需重新合成。不会重新生成，也不删除其它版本。"
                                        okText="设为当前"
                                        cancelText="取消"
                                        onConfirm={() => restore.mutateAsync(take)}
                                    >
                                        <Button size="small" type="link" className="drama-take-switch" loading={restore.isPending && restore.variables?.id === take.id} disabled={restore.isPending} onClick={(event) => event.stopPropagation()}>
                                            设为当前
                                        </Button>
                                    </Popconfirm>
                                ) : null}
                            </li>
                        );
                    })}
                </ol>
            ) : null}
            {!status && expanded && canExpand && cursor ? (
                <>
                    {older.isFetching ? (
                        <p className="drama-sg-note" role="status">
                            正在读取更早版本…
                        </p>
                    ) : null}
                    {older.isError ? (
                        <p className="drama-sg-note is-warn" role="alert">
                            更早版本读取失败
                        </p>
                    ) : null}
                    {!older.isFetching && (older.hasNextPage || older.isError) ? (
                        <Button type="link" size="small" className="justify-self-start" onClick={() => void (older.isError && !older.isFetchNextPageError ? older.refetch() : older.fetchNextPage({ cancelRefetch: false }))}>
                            {older.isError ? "重试读取更早版本" : "加载更多版本"}
                        </Button>
                    ) : null}
                </>
            ) : null}
            {!status && hasOlderTakes && canExpand && (expanded || cursor || visibleTakes.length < takes.length) ? (
                <Button type="link" size="small" className="justify-self-start" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
                    {expanded ? "收起更早版本" : "显示更早版本"}
                </Button>
            ) : null}
            {!status && takes.length > limit && !canExpand ? <p className="drama-takes-more">另有 {Math.max(0, takes.length - limit)} 个更早的版本</p> : null}
            {imageDrag?.error ? (
                <p className="drama-sg-note is-warn" role="alert">
                    {imageDrag.error}
                </p>
            ) : null}
        </section>
    );
}

function takeMeta(take: DramaTake) {
    const parts: string[] = [];
    if (take.durationMs) parts.push(secondsLabel(take.durationMs).replace(/s$/, " 秒"));
    if (take.model) parts.push(shortModelName(take.model));
    return parts.join(" · ");
}

/** 版本行里的模型名去掉渠道前缀，避免右侧窄栏被撑出横向滚动。 */
export function shortModelName(model: string) {
    return model.replace(/^(wb-|wb_|ohmybb-)/i, "").replace(/^minimax-/i, "");
}
