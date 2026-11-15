import { useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Select } from "antd";

import { getDramaEpisode, type DramaCast, type DramaCastKind, type DramaEpisodeDetail, type DramaSummary } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";
import { MediaThumb, parseList } from "./drama-shared";
import { WorkflowBatch } from "./workflow-batch";

/** 包含人工段引用及造型本体，不根据名称或出现章节猜测出场资产。 */
export function episodeAssetIds(detail: DramaEpisodeDetail, cast: DramaCast[]) {
    const ids = new Set<string>();
    for (const shot of detail.shots) {
        for (const id of [...parseList(shot.castIdsJson), ...parseList(shot.lookCastIdsJson), ...parseList(shot.propIdsJson), shot.sceneCastId || ""]) if (id) ids.add(id);
    }
    for (const segment of detail.segments) {
        for (const ref of [...segment.request.references, ...(segment.request.audioReferences || [])]) if (ref.castId) ids.add(ref.castId);
    }
    for (const item of cast) if (ids.has(item.id) && item.parentId) ids.add(item.parentId);
    return ids;
}

type ScopeProps = {
    summary: DramaSummary;
    cast: DramaCast[];
    kind?: DramaCastKind;
    episodeId?: string;
    showToolbar?: boolean;
    sharedBeforeStoryboard?: boolean;
    busy: boolean;
    onChanged: () => void;
    children: (cast: DramaCast[], refreshing: boolean, sharedCast: DramaCast[]) => ReactNode;
};

export function WorkflowAssetScope(props: ScopeProps) {
    const userId = useUserStore((state) => state.user?.id || "");
    return <AssetScopeSession key={`${userId}:${props.summary.project.id}`} {...props} userId={userId} />;
}

function AssetScopeSession({ summary, cast, kind, episodeId: controlledEpisodeId, showToolbar = true, sharedBeforeStoryboard = false, busy, onChanged, children, userId }: ScopeProps & { userId: string }) {
    const [localEpisodeId, setEpisodeId] = useState("");
    const episodeId = controlledEpisodeId ?? localEpisodeId;
    const [selecting, setSelecting] = useState(false);
    const [selection, setSelection] = useState<Set<string>>(() => new Set());
    const projectId = summary.project.id;
    const projectCast = cast.filter((item) => item.projectId === projectId);
    const episode = summary.episodes.find((item) => item.id === episodeId);
    const detail = useQuery({
        queryKey: ["drama", projectId, "asset-scope", userId, episodeId, summary.production.revision],
        queryFn: ({ signal }) => getDramaEpisode(projectId, episodeId, signal),
        enabled: Boolean(episode),
        refetchInterval: (summary.jobCounts.running || summary.jobCounts.queued) && episode ? 2500 : false,
    });
    // 同一集刷新时保留列与批次回执；旧列表只读，不能拿它发起新生成。
    const lastDetail = useRef<DramaEpisodeDetail | undefined>(undefined);
    if (episode && detail.data?.episode.id === episodeId) lastDetail.current = detail.data;
    const currentDetail = episode && lastDetail.current?.episode.id === episodeId ? lastDetail.current : undefined;
    const referenced = currentDetail ? episodeAssetIds(currentDetail, projectCast) : new Set<string>();
    const shared = Boolean(sharedBeforeStoryboard && currentDetail && !currentDetail.shots.length && !currentDetail.segments.length);
    const visible = projectCast.filter((item) => (!kind || item.kind === kind) && (!episodeId || (episode && (shared || referenced.has(item.id)))));
    const sharedCast = sharedBeforeStoryboard && currentDetail && !shared ? projectCast.filter((item) => (!kind || item.kind === kind) && !referenced.has(item.id)) : [];
    const selected = [...selection].filter((id) => projectCast.some((item) => item.id === id));
    const toggle = (id: string) =>
        setSelection((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    const unavailable = Boolean(episodeId && (!episode || !currentDetail));
    const refreshing = Boolean(episodeId && (detail.isPending || detail.isFetching || detail.isError));

    return (
        <section className="drama-workflow-asset-scope" aria-label="资产展示与批量范围">
            {showToolbar ? (
                <div className="drama-workflow-assets-actions">
                    <Select
                        aria-label="按集查看资产"
                        value={episodeId}
                        onChange={setEpisodeId}
                        disabled={busy}
                        options={[{ value: "", label: "全部资产" }, ...summary.episodes.map((item) => ({ value: item.id, label: `第 ${item.number} 集 · ${item.title}` }))]}
                    />
                    <Button aria-pressed={selecting} disabled={busy} onClick={() => setSelecting(!selecting)}>
                        {selecting ? "返回资产审阅" : "批量选择"}
                    </Button>
                    {selecting ? (
                        <>
                            <Button disabled={busy || unavailable || refreshing || !visible.length} onClick={() => setSelection((current) => new Set([...current, ...visible.map((item) => item.id)]))}>
                                选择当前范围
                            </Button>
                            <Button disabled={busy || !selected.length} onClick={() => setSelection(new Set())}>
                                清空选择（{selected.length}）
                            </Button>
                        </>
                    ) : null}
                </div>
            ) : null}
            {shared ? (
                <p className="drama-workflow-assets-shared-note" role="status">
                    本集尚未编排分镜，展示作品共享主体。
                </p>
            ) : null}
            {currentDetail && detail.isError ? (
                <p role="alert">
                    本集引用资产刷新失败，已保留列表，重试后可继续操作。<Button onClick={() => void detail.refetch()}>重试</Button>
                </p>
            ) : null}
            {unavailable ? (
                <p role={detail.isError ? "alert" : "status"}>
                    {!episode ? "本集已移除，请重新选择范围。" : detail.isError ? "本集引用资产读取失败。" : "正在读取本集引用资产…"}
                    {episode && detail.isError ? <Button onClick={() => void detail.refetch()}>重试</Button> : null}
                </p>
            ) : !visible.length && kind ? (
                <p role="status">本范围暂无引用资产。</p>
            ) : selecting ? (
                <div className="drama-workflow-asset-selection">
                    {visible.map((item) => (
                        <label key={item.id}>
                            <input type="checkbox" disabled={busy || refreshing} checked={selection.has(item.id)} onChange={() => toggle(item.id)} aria-label={`选择${item.name}${item.lookName ? ` · ${item.lookName}` : ""}`} />
                            <div className="drama-workflow-asset-selection-image">{item.imageResourceId ? <MediaThumb resourceId={item.imageResourceId} alt={item.name} /> : <span>暂无图片</span>}</div>
                            <strong>
                                {item.name}
                                {item.lookName ? ` · ${item.lookName}` : ""}
                            </strong>
                        </label>
                    ))}
                </div>
            ) : (
                children(visible, refreshing, sharedCast)
            )}
            {selecting ? (
                <WorkflowBatch projectId={projectId} revision={summary.production.revision} targetIds={selected} actions={["cast_image"]} disabled={busy || refreshing} onChanged={onChanged} onClearSelection={() => setSelection(new Set())} />
            ) : null}
        </section>
    );
}
