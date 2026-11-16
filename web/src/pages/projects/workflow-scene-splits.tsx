import { useEffect, useRef, useState } from "react";
import { App, Button, Input, InputNumber, Select } from "antd";
import { useQuery } from "@tanstack/react-query";
import { AppModal } from "@/components/ui/product/app-modal";
import { DIRECTOR_TEMPLATES } from "@/lib/drama/director";
import { getActiveUserScope } from "@/lib/user-scope";
import type { DramaEpisodeDetail, DramaShot, DramaSummary } from "@/services/api/drama";
import { getDramaShotMedia } from "@/services/api/drama-shot-media";
import { adoptDramaSceneSplit, executeDramaSceneSplit, getDramaSceneSplits, preflightDramaSceneSplit, type DramaSceneSplitPreflight, type DramaSceneSplitRequest, type DramaSceneSplitResult } from "@/services/api/drama-scene-split";
import { ApiError } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";
import { formatCredits, useResourceMediaUrl } from "./drama-shared";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import { clearSceneSplitPending, readSceneSplitPending, writeSceneSplitPending } from "./workflow-scene-splits-state";
import "./workflow-scene-splits.css";

export function WorkflowSceneSplits({
    summary,
    detail,
    onChanged,
    onOpenSegment,
    initialSegmentIndex,
    buttonLabel = "段分镜",
}: {
    summary: DramaSummary;
    detail: DramaEpisodeDetail;
    onChanged: () => void;
    onOpenSegment: (index: number) => void;
    initialSegmentIndex?: number;
    buttonLabel?: string;
}) {
    const userId = useUserStore((state) => state.user?.id || "");
    const owner = `${userId}:${getActiveUserScope()}:${summary.project.id}:${detail.episode.id}`;
    const [opened, setOpened] = useState<{ owner: string; revision: number; episodeRevision: number }>();
    return (
        <>
            <Button size="small" disabled={!detail.shots.length || !detail.segments.length} onClick={() => setOpened({ owner, revision: summary.production.revision, episodeRevision: detail.episode.revision })}>
                {buttonLabel}
            </Button>
            <AppModal open={opened?.owner === owner} closable={false} maskClosable={false} keyboard={false} footer={null} width={1120} flush destroyOnHidden>
                {opened?.owner === owner ? (
                    <SceneSplitDialog
                        key={owner}
                        summary={summary}
                        detail={detail}
                        baseline={opened}
                        userId={userId}
                        initialSegmentIndex={initialSegmentIndex}
                        onClose={() => setOpened(undefined)}
                        onChanged={onChanged}
                        onOpenSegment={(index) => {
                            setOpened(undefined);
                            onOpenSegment(index);
                        }}
                    />
                ) : null}
            </AppModal>
        </>
    );
}

function SceneSplitDialog({
    summary,
    detail,
    baseline,
    userId,
    onClose,
    onChanged,
    onOpenSegment,
    initialSegmentIndex,
}: {
    summary: DramaSummary;
    detail: DramaEpisodeDetail;
    baseline: { revision: number; episodeRevision: number };
    userId: string;
    onClose: () => void;
    onChanged: () => void;
    onOpenSegment: (index: number) => void;
    initialSegmentIndex?: number;
}) {
    const { modal, message } = App.useApp();
    const projectId = summary.project.id;
    const episodeId = detail.episode.id;
    const settings = summary.production.settings;
    const operation = useDramaOperationScope(projectId);
    const segments = [...detail.segments].sort((a, b) => a.index - b.index).map((segment) => ({ segment, shots: detail.shots.filter((shot) => shot.segmentIndex === segment.index).sort((a, b) => a.position - b.position) }));
    const [segmentId, setSegmentId] = useState(segments.find((row) => row.segment.index === initialSegmentIndex)?.segment.id || segments[0]?.segment.id || "");
    const selected = segments.find((row) => row.segment.id === segmentId);
    const group = selected?.shots;
    const [count, setCount] = useState(group?.length || 1);
    const [template, setTemplate] = useState<string>(settings.storyboard.directorTemplate || "");
    const [instruction, setInstruction] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [quote, setQuote] = useState<DramaSceneSplitPreflight>();
    const [operationId, setOperationId] = useState("");
    const [pending, setPending] = useState<DramaSceneSplitRequest>();
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState("");
    const lock = useRef(false);
    const ownerActive = Boolean(userId && userId === getActiveUserScope());
    const stale = baseline.revision !== summary.production.revision || baseline.episodeRevision !== detail.episode.revision;
    const disabled = busy || Boolean(pending) || !loaded || stale || !ownerActive || !group?.length;
    const ticket = operation.capture();
    const results = useQuery({
        queryKey: ["drama-scene-splits", userId, getActiveUserScope(), projectId, episodeId],
        queryFn: ({ signal }) => getDramaSceneSplits(projectId, episodeId, signal),
        enabled: ownerActive,
        refetchInterval: (query) => (query.state.data?.some((row) => !["succeeded", "failed", "cancelled"].includes(row.status)) ? 2000 : false),
    });
    useEffect(() => {
        setQuote(undefined);
        setOperationId("");
    }, [instruction, count, template, segmentId]);
    const loadPending = async () => {
        const current = operation.capture();
        setLoadError("");
        try {
            const value = await readSceneSplitPending(userId, projectId, episodeId);
            if (!operation.isCurrent(current)) return;
            setPending(value);
            setLoaded(true);
        } catch (reason) {
            if (operation.isCurrent(current)) setLoadError(reason instanceof Error ? reason.message : "读取重拆提交记录失败");
        }
    };
    useEffect(() => {
        void loadPending();
    }, []);
    const request = {
        expectedRevision: baseline.revision,
        episodeRevision: baseline.episodeRevision,
        shotIds: group?.map((shot) => shot.id) || [],
        targetShotCount: count,
        directorTemplate: template,
        instruction,
        model: settings.models.scriptText?.logicalModelId || settings.models.scriptText?.channelId ? settings.models.scriptText : settings.models.text,
    };
    const run = async (action: "preflight" | "execute" | "adopt", takeId?: string) => {
        if (lock.current || busy || !ownerActive || !loaded || !operation.isCurrent(ticket) || (disabled && !(action === "execute" && pending))) return;
        lock.current = true;
        setBusy(true);
        setError("");
        try {
            if (action === "preflight") {
                const result = await preflightDramaSceneSplit(projectId, episodeId, request);
                if (!operation.isCurrent(ticket)) return;
                setQuote(result);
                setOperationId(crypto.randomUUID());
            } else if (action === "execute") {
                const input = pending || (quote?.ready && quote.priced && operationId ? { ...request, confirmationToken: quote.confirmationToken, clientOperationId: operationId } : undefined);
                if (!input) return;
                await writeSceneSplitPending(userId, projectId, episodeId, input);
                if (!operation.isCurrent(ticket)) return;
                setPending(input);
                try {
                    await executeDramaSceneSplit(projectId, episodeId, input);
                } catch (reason) {
                    const rejected = reason instanceof ApiError && [reason.status, reason.code].some((status) => status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429);
                    if (rejected) {
                        await clearSceneSplitPending(userId, projectId, episodeId);
                        if (operation.isCurrent(ticket)) {
                            setPending(undefined);
                            setQuote(undefined);
                        }
                    }
                    throw reason;
                }
                await clearSceneSplitPending(userId, projectId, episodeId);
                if (!operation.isCurrent(ticket)) return;
                setPending(undefined);
                setQuote(undefined);
                message.success("本段重拆已排队，完成后请审阅并采用");
                void results.refetch();
            } else {
                await adoptDramaSceneSplit(projectId, episodeId, { expectedRevision: baseline.revision, episodeRevision: baseline.episodeRevision, takeId: takeId! });
                if (!operation.isCurrent(ticket)) return;
                message.success("已替换本段分镜，相关媒体已标记过期");
                onChanged();
                onClose();
            }
        } catch (error) {
            if (operation.isCurrent(ticket)) setError(error instanceof Error ? error.message : "操作失败，请重试");
        } finally {
            lock.current = false;
            if (operation.isCurrent(ticket)) setBusy(false);
        }
    };
    const close = () => {
        if (busy || lock.current) return;
        if (pending) return onClose();
        if (instruction.trim() || quote) modal.confirm({ title: "关闭段分镜？", content: "未提交的重拆要求将丢弃，已提交任务和历史仍会保留。", onOk: onClose });
        else onClose();
    };
    if (!ownerActive)
        return (
            <div className="drama-scene-splits">
                <p role="alert">登录状态已变化，请关闭后重新打开。</p>
                <Button onClick={onClose}>关闭</Button>
            </div>
        );
    return (
        <div className="drama-scene-splits">
            <header>
                <div>
                    <h2>第 {detail.episode.number} 集 · 段分镜</h2>
                    <p>
                        {segments.length} 段 · {detail.shots.length} 镜
                    </p>
                </div>
                <Button disabled={busy} onClick={close}>
                    关闭
                </Button>
            </header>
            <div className="drama-scene-splits-body">
                <nav aria-label="分镜段">
                    {segments.map(({ segment, shots }) => (
                        <button
                            key={segment.id}
                            type="button"
                            disabled={busy || Boolean(pending)}
                            aria-pressed={segment.id === segmentId}
                            onClick={() => {
                                setSegmentId(segment.id);
                                setCount(shots.length || 1);
                                setError("");
                            }}
                        >
                            <b>第 {segment.index + 1} 段</b>
                            <span>{segment.title || "未命名段"}</span>
                            <small>
                                {shots.length} 镜 · {(shots.reduce((total, shot) => total + shot.durationMs, 0) / 1000).toFixed(1)}s
                            </small>
                        </button>
                    ))}
                </nav>
                <main>
                    {stale ? <p role="alert">作品或分镜已有更新。当前要求已保留，请关闭后重新打开。</p> : null}
                    {error ? <p role="alert">{error}</p> : null}
                    {loadError ? (
                        <p role="alert">
                            {loadError} <Button onClick={() => void loadPending()}>重新读取提交记录</Button>
                        </p>
                    ) : null}
                    {pending ? (
                        <p role="status">
                            重拆提交回执待确认，将使用原请求和标识核对，避免重复生成。
                            <Button type="primary" disabled={busy} onClick={() => void run("execute")}>
                                核对重拆提交结果
                            </Button>
                        </p>
                    ) : null}
                    {selected ? (
                        <h3>
                            第 {selected.segment.index + 1} 段 · {selected.segment.title || "未命名段"}
                        </h3>
                    ) : null}
                    {!group?.length ? <p role="alert">当前段没有可重拆的镜头，请先完善本集分镜。</p> : null}
                    <div className="drama-scene-splits-grid">
                        {group?.map((shot) => (
                            <SceneShotCard key={shot.id} shot={shot} userId={userId} revision={detail.episode.revision} disabled={busy || Boolean(pending)} onOpen={() => onOpenSegment(shot.segmentIndex)} />
                        ))}
                    </div>
                    <section aria-label="重拆本段">
                        <h3>重拆本段</h3>
                        <p>先生成文字方案，审阅后再替换本段全部镜头。保留本段台词，场景仅限本段已有场景；段边界及其他段内容保留。本段视频与镜头图片会标为过期，旧版本保留。</p>
                        <div className="drama-scene-splits-config">
                            <label>
                                目标镜头数
                                <InputNumber
                                    aria-label="本段目标镜头数"
                                    min={1}
                                    max={240 - detail.shots.length + (group?.length || 0)}
                                    precision={0}
                                    value={count}
                                    disabled={disabled}
                                    onChange={(value) => {
                                        if (typeof value === "number") setCount(value);
                                    }}
                                />
                            </label>
                            <label>
                                分镜模板
                                <Select aria-label="本段分镜模板" value={template} disabled={disabled} options={DIRECTOR_TEMPLATES.map(({ value, label }) => ({ value, label }))} onChange={setTemplate} />
                            </label>
                        </div>
                        <Input.TextArea aria-label="本段重拆要求" rows={3} maxLength={4000} disabled={disabled} value={instruction} placeholder="如：增加人物反应镜头，保持本段台词与场景不变" onChange={(event) => setInstruction(event.target.value)} />
                        <div className="drama-scene-splits-config">
                            <Button disabled={disabled} loading={busy} onClick={() => void run("preflight")}>
                                预检重拆
                            </Button>
                            {quote && !pending ? (
                                quote.ready ? (
                                    <>
                                        <span>
                                            {quote.estimated ? "预计" : "报价"} {formatCredits(quote.amountMicrocredits)} 积分
                                        </span>
                                        <Button type="primary" disabled={disabled || !quote.priced} onClick={() => void run("execute")}>
                                            确认并生成文字方案
                                        </Button>
                                    </>
                                ) : (
                                    <span role="alert">{quote.reason}</span>
                                )
                            ) : null}
                        </div>
                    </section>
                    <section aria-label="本段重拆历史">
                        <h3>文字方案与历史</h3>
                        <Button disabled={busy || results.isFetching} onClick={() => void results.refetch()}>
                            刷新方案
                        </Button>
                        {results.isError ? <p role="alert">读取重拆方案失败，请刷新重试。</p> : null}
                        {results.data
                            ?.filter((row) => Boolean(group?.length) && row.shotIds.length === group?.length && row.shotIds.every((id, index) => id === group?.[index].id))
                            .map((row) => (
                                <SceneSplitResult
                                    key={row.takeId}
                                    row={row}
                                    disabled={disabled}
                                    onAdopt={() =>
                                        modal.confirm({
                                            title: "采用这份段分镜？",
                                            content: "将替换本段全部镜头，按顺序复用原ID，移除的镜头保留在历史中，新增镜头使用新ID。本段原台词必须完整保留，场景仅限本段已有场景；本段相关媒体会过期，其他段内容不改写。",
                                            okText: "确认替换本段",
                                            onOk: () => run("adopt", row.takeId),
                                        })
                                    }
                                />
                            ))}
                    </section>
                </main>
            </div>
        </div>
    );
}

function SceneShotCard({ shot, userId, revision, disabled, onOpen }: { shot: DramaShot; userId: string; revision: number; disabled: boolean; onOpen: () => void }) {
    const active = userId === getActiveUserScope();
    const media = useQuery({ queryKey: ["scene-shot-image", userId, getActiveUserScope(), shot.projectId, shot.id, revision], queryFn: ({ signal }) => getDramaShotMedia(shot.projectId, shot.id, "image", signal), enabled: active });
    const url = useResourceMediaUrl(active ? media.data?.resourceId : undefined);
    if (!active) return null;
    return (
        <button type="button" disabled={disabled} onClick={onOpen} title="打开本镜头所在段编辑与媒体生成">
            <strong>
                镜头 {shot.position + 1} · {(shot.durationMs / 1000).toFixed(1)}s
            </strong>
            <small>{shot.scene || "未命名场景"}</small>
            {url ? <img src={url} alt={`镜头${shot.position + 1}的已保存图片`} loading="lazy" /> : <span>{shot.action || shot.imagePrompt || "暂无画面说明"}</span>}
            <small>{[shot.shotSize, shot.camera, shot.dialogue].filter(Boolean).join(" · ")}</small>
            {media.data?.status === "stale" ? <small>图片已过期</small> : media.isError ? <small>图片读取失败，仍可编辑</small> : null}
        </button>
    );
}

function SceneSplitResult({ row, disabled, onAdopt }: { row: DramaSceneSplitResult; disabled: boolean; onAdopt: () => void }) {
    return (
        <article className="drama-scene-split-result">
            <strong>
                {row.applied ? "已采用" : row.status === "succeeded" ? "待审阅" : row.status === "failed" || row.status === "cancelled" ? "未完成" : `正在处理 ${row.progress}%`}
                {row.stale && !row.applied ? " · 来源已变化" : ""}
            </strong>
            {row.error ? <p role="alert">{row.error}</p> : null}
            {row.text ? (
                <details>
                    <summary>查看文字方案</summary>
                    <SceneShotPreview text={row.text} />
                </details>
            ) : null}
            {row.snapshot ? (
                <details>
                    <summary>查看替换前的分镜与媒体记录</summary>
                    <SceneShotPreview text={row.snapshot.shotsJson} />
                    <SceneMediaHistory text={row.snapshot.takesJson} />
                </details>
            ) : null}
            {row.status === "succeeded" && !row.applied ? (
                <Button disabled={disabled || row.stale || Boolean(row.error) || !scenePreviewShots(row.text || "").length} onClick={onAdopt}>
                    采用此方案
                </Button>
            ) : null}
        </article>
    );
}

type PreviewShot = { scene?: string; action?: string; imagePrompt?: string; dialogue?: string; shotSize?: string; camera?: string; durationMs?: number; durationSeconds?: number };
function scenePreviewShots(text: string): PreviewShot[] {
    let raw = text.trim();
    try {
        if (!raw.startsWith("[") && !raw.startsWith("{")) raw = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
        const parsed = JSON.parse(raw);
        const shots: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed.shots) ? parsed.shots : [];
        if (shots.some((shot) => !shot || typeof shot !== "object" || Array.isArray(shot))) return [];
        for (const shot of shots as Record<string, unknown>[]) {
            for (const key of ["scene", "action", "imagePrompt", "dialogue", "shotSize", "camera"]) if (shot[key] != null && typeof shot[key] !== "string") return [];
            for (const key of ["durationMs", "durationSeconds"]) if (shot[key] != null && (typeof shot[key] !== "number" || !Number.isFinite(shot[key]))) return [];
        }
        return shots as PreviewShot[];
    } catch {
        return [];
    }
}

function SceneShotPreview({ text }: { text: string }) {
    const shots = scenePreviewShots(text);
    if (!shots.length) return <p>这份文字方案未返回可展示的完整镜头，请重新生成。</p>;
    return (
        <div className="drama-scene-splits-grid">
            {shots.map((shot, index) => (
                <div className="drama-scene-preview-shot" key={index}>
                    <strong>
                        镜头 {index + 1} · {shot.durationSeconds || (shot.durationMs || 0) / 1000}s
                    </strong>
                    {shot.scene ? <small>{shot.scene}</small> : null}
                    <p>{shot.action || shot.imagePrompt}</p>
                    <small>{[shot.shotSize, shot.camera].filter(Boolean).join(" · ")}</small>
                    {shot.dialogue ? <p>台词：{shot.dialogue}</p> : null}
                </div>
            ))}
        </div>
    );
}

function SceneMediaHistory({ text }: { text: string }) {
    let takes: Array<{ id: string; resourceId: string; kind: string; version: number }> = [];
    try {
        const parsed = JSON.parse(text || "[]");
        if (Array.isArray(parsed)) takes = parsed;
    } catch {
        /* Old records may not contain media. */
    }
    return (
        <div className="drama-scene-splits-media">
            {takes
                .filter((take) => take.resourceId)
                .map((take) => (
                    <SceneMediaTake key={take.id} take={take} />
                ))}
        </div>
    );
}

function SceneMediaTake({ take }: { take: { resourceId: string; kind: string; version: number } }) {
    const url = useResourceMediaUrl(take.resourceId);
    const image = take.kind === "shot_image";
    const audio = take.kind === "shot_audio";
    return (
        <figure>
            <figcaption>
                {image ? "镜头图片" : audio ? "镜头音频" : "视频"} · 版本 {take.version}
            </figcaption>
            {url ? image ? <img src={url} alt={`历史镜头图片版本${take.version}`} loading="lazy" /> : audio ? <audio src={url} controls preload="none" /> : <video src={url} controls preload="none" /> : <span>正在读取历史媒体</span>}
        </figure>
    );
}
