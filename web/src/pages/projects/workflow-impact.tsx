import { useQuery } from "@tanstack/react-query";
import { Button } from "antd";
import { Link } from "react-router";

import { getDramaCastImpact, getDramaSettingsImpact, type DramaWorkflowAffectedSegment } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";
import "./workflow-impact.css";

function ImpactSegments({ projectId, segments }: { projectId: string; segments: DramaWorkflowAffectedSegment[] }) {
    return (
        <ul>
            {segments.map((segment) => (
                <li key={segment.id}>
                    <Link to={`/projects/${encodeURIComponent(projectId)}/e/${encodeURIComponent(segment.episodeId)}?mode=simple&step=story&segment=${segment.segmentIndex}`}>
                        第 {segment.episodeNumber} 集 · 第 {segment.segmentIndex + 1} 段{segment.episodeTitle ? ` · ${segment.episodeTitle}` : ""}
                    </Link>
                    <span>{segment.hasVideo ? "已有视频" : segment.videoStatus === "running" || segment.videoStatus === "queued" ? "视频处理中" : "尚无视频"}</span>
                </li>
            ))}
        </ul>
    );
}

/** 仅展示已保存引用的真实影响，不启动重写或媒体生成。 */
export function WorkflowImpact({ projectId, revision, castId }: { projectId: string; revision: number; castId?: string }) {
    const userId = useUserStore((state) => state.user?.id || "");
    const query = useQuery({
        queryKey: ["drama", projectId, "workflow-impact", userId, castId || "style", revision],
        queryFn: ({ signal }) => (castId ? getDramaCastImpact(projectId, castId, signal) : getDramaSettingsImpact(projectId, signal)),
        enabled: Boolean(userId && projectId),
    });
    const impact = query.data;
    const current = impact?.revision === revision && impact.kind === (castId ? "cast" : "style") && (!castId || impact.castId === castId);
    return (
        <section className="drama-workflow-impact" aria-label={castId ? "资产影响范围" : "风格影响范围"}>
            <strong>{castId ? "资产影响范围" : "风格影响范围"}</strong>
            {query.isPending ? (
                <p role="status">正在读取真实引用范围…</p>
            ) : query.isError ? (
                <p role="alert">
                    影响范围读取失败，请重试后再判断。
                    <Button size="small" type="link" onClick={() => void query.refetch()}>
                        重试
                    </Button>
                </p>
            ) : !current ? (
                <p role="alert">
                    内容已有更新，影响范围需要刷新。
                    <Button size="small" type="link" onClick={() => void query.refetch()}>
                        刷新影响范围
                    </Button>
                </p>
            ) : impact ? (
                <>
                    <p>{impact.message}</p>
                    <p>
                        涉及 {impact.assetIds.length} 项资产、{impact.affectedSegments} 段。保存设定不会自动重新生成已有产物。
                    </p>
                    <details>
                        <summary>直接影响 {impact.directSegments.length} 段</summary>
                        {impact.directSegments.length ? <ImpactSegments projectId={projectId} segments={impact.directSegments} /> : <p>没有直接引用的剧情段。</p>}
                    </details>
                    {impact.continuitySegments.length ? (
                        <details>
                            <summary>尾帧续接涉及后续 {impact.continuitySegments.length} 段</summary>
                            <ImpactSegments projectId={projectId} segments={impact.continuitySegments} />
                        </details>
                    ) : null}
                </>
            ) : null}
        </section>
    );
}
