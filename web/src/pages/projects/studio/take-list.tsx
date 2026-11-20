import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";

import { dramaKeys } from "@/lib/drama/drama-query-keys";
import { formatRelativeTime } from "@/lib/relative-time";
import { listDramaTakes, type DramaTakeKind, type DramaTakeSource } from "@/services/api/drama";

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
}: {
    projectId: string;
    ownerId: string;
    kind: DramaTakeKind;
    limit?: number;
    showHeading?: boolean;
    onPreviewImage?: (resourceId: string, version: number) => void;
}) {
    const query = useQuery({
        queryKey: dramaKeys.takes(projectId, kind, ownerId),
        queryFn: ({ signal }) => listDramaTakes(projectId, ownerId, kind, signal),
        enabled: Boolean(projectId && ownerId),
        staleTime: 10_000,
        ...(kind === "cast" ? { refetchOnMount: "always" as const } : {}),
    });
    const takes = query.data?.takes || [];
    if (!projectId || !ownerId) return null;
    const status = query.isPending ? "正在读取版本…" : query.isError ? "版本记录读取失败" : !takes.length ? "暂无版本记录" : "";
    return (
        <section className="drama-takes" aria-label="版本记录">
            {showHeading ? (
                <div className="drama-takes-head">
                    <History className="size-3.5" aria-hidden />
                    <span>版本记录</span>
                    {!status ? <small>{takes.length}</small> : null}
                </div>
            ) : null}
            {status ? (
                <p className={`drama-sg-note${query.isError ? " is-warn" : ""}`} role="status">
                    {status}
                </p>
            ) : null}
            {!status ? (
                <ol className="drama-takes-list">
                    {takes.slice(0, limit).map((take) => {
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
                                    <button type="button" className="drama-take-preview" aria-label={label} aria-haspopup="dialog" title={label} onClick={() => onPreviewImage(castImage, version)}>
                                        {content}
                                    </button>
                                ) : (
                                    content
                                )}
                            </li>
                        );
                    })}
                </ol>
            ) : null}
            {!status && takes.length > limit ? <p className="drama-takes-more">另有 {takes.length - limit} 个更早的版本</p> : null}
        </section>
    );
}
