import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Button } from "antd";
import { History } from "lucide-react";

import { dramaKeys } from "@/lib/drama/drama-query-keys";
import { formatRelativeTime } from "@/lib/relative-time";
import { listDramaTakes, type DramaTake, type DramaTakeKind, type DramaTakeSource } from "@/services/api/drama";

import { MediaThumb } from "../drama-shared";

const SOURCE_LABEL: Record<DramaTakeSource, string> = { pipeline: "生成", upload: "上传", canvas: "来自画布" };

/** 设定参考图、剧情段视频或成片的版本记录，新版本在前；标出来源（流水线生成、上传、从精修画布采用）与当前版本。 */
export function DramaTakeList({
    projectId,
    ownerId,
    kind,
    limit = 6,
    showHeading = true,
    onPreviewImage,
    imageAdoption,
}: {
    projectId: string;
    ownerId: string;
    kind: DramaTakeKind;
    limit?: number;
    showHeading?: boolean;
    onPreviewImage?: (take: DramaTake) => void;
    imageAdoption?: { onAdopt: (take: DramaTake) => void; restoreCurrent: boolean; disabled: boolean; pendingId?: string; error?: string };
}) {
    const [expanded, setExpanded] = useState(false);
    const query = useQuery({
        queryKey: dramaKeys.takes(projectId, kind, ownerId),
        queryFn: ({ signal }) => listDramaTakes(projectId, ownerId, kind, signal),
        enabled: Boolean(projectId && ownerId),
        staleTime: 10_000,
        ...(kind === "cast" ? { refetchOnMount: "always" as const } : {}),
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
                        const content = (
                            <>
                                {kind === "cast" ? (
                                    <span className="drama-take-thumb">
                                        <MediaThumb resourceId={resourceId} alt={`V${version}`} />
                                    </span>
                                ) : null}
                                <b>V{version}</b>
                                <span className={`drama-take-source is-${take.source}`}>{SOURCE_LABEL[take.source]}</span>
                                <time dateTime={take.createdAt}>{formatRelativeTime(take.createdAt)}</time>
                                {take.current ? <em>当前</em> : null}
                            </>
                        );
                        const label = `放大查看 V${version}`;
                        return (
                            <li key={take.id} className={take.current ? "is-current" : undefined}>
                                {castImage && onPreviewImage ? (
                                    <button type="button" className="drama-take-preview" aria-label={label} aria-haspopup="dialog" title={label} onClick={() => onPreviewImage(take)}>
                                        {content}
                                    </button>
                                ) : (
                                    content
                                )}
                                {castImage && imageAdoption && (!take.current || imageAdoption.restoreCurrent) ? (
                                    <Button type="link" size="small" className="drama-take-adopt" aria-label={`采用 V${version}`} disabled={imageAdoption.disabled} loading={imageAdoption.pendingId === take.id} onClick={() => imageAdoption.onAdopt(take)}>
                                        采用
                                    </Button>
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
            {!status && hasOlderTakes && !canExpand ? <p className="drama-takes-more">另有 {takes.length - limit} 个更早的版本</p> : null}
            {imageAdoption?.error ? (
                <p className="drama-sg-note is-warn" role="alert">
                    {imageAdoption.error}
                </p>
            ) : null}
        </section>
    );
}
