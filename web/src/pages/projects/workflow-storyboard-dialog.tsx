import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox, Input, Select } from "antd";

import { AssetLibraryPickerModal } from "@/components/assets/asset-library-picker-modal";
import { AppModal } from "@/components/ui/product/app-modal";
import { getDrama, type DramaShot } from "@/services/api/drama";
import type { DramaShotMediaAction, DramaShotMediaConfig } from "@/services/api/drama-shot-media";
import {
    adoptDramaStoryboardCell,
    createDramaStoryboard,
    executeDramaStoryboard,
    getDramaStoryboard,
    listDramaStoryboards,
    preflightDramaStoryboard,
    quoteDramaStoryboard,
    splitDramaStoryboard,
    type DramaStoryboard,
    type DramaStoryboardCell,
    type DramaStoryboardPreflight,
    type DramaStoryboardCreate,
} from "@/services/api/drama-storyboard";
import { ApiError } from "@/services/api/request";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { useUserStore } from "@/stores/use-user-store";
import { DramaModelPicker } from "./drama-model-picker";
import { MediaThumb } from "./drama-shared";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import { generationLabel } from "./workflow-generation";
import "./workflow-storyboard.css";

type Props = { open: boolean; projectId: string; shots: DramaShot[]; referenceResourceIds?: string[]; title?: string; onClose: () => void };
type Quote = { boardId: string; preview: DramaStoryboardPreflight; request: DramaShotMediaAction; uncertain?: boolean };
const STATUS: Record<string, string> = { draft: "待生成", queued: "排队中", running: "生成中", image_ready: "原图已就绪", split: "已裁切分图", failed: "生成失败", cancelled: "已取消", stale: "原稿已变化" };

export function WorkflowStoryboardDialog(props: Props) {
    const userId = useUserStore((state) => state.user?.id || "");
    return props.open && props.shots.length ? <StoryboardSession key={`${userId}:${props.projectId}:${props.shots.map((shot) => shot.id).join(":")}`} {...props} userId={userId} /> : null;
}

function StoryboardSession({ projectId, shots, referenceResourceIds = [], title = "故事板", onClose, userId }: Props & { userId: string }) {
    const client = useQueryClient();
    const scope = useDramaOperationScope(projectId);
    const episodeId = shots[0].episodeId;
    const summary = useQuery({ queryKey: ["drama-storyboard-defaults", userId, projectId], queryFn: ({ signal }) => getDrama(projectId, signal) });
    const listKey = ["drama-storyboards", userId, projectId, episodeId];
    const history = useQuery({ queryKey: listKey, queryFn: ({ signal }) => listDramaStoryboards(projectId, episodeId, signal) });
    const [boardId, setBoardId] = useState("");
    const boardKey = ["drama-storyboard", userId, projectId, boardId];
    const board = useQuery({
        queryKey: boardKey,
        queryFn: ({ signal }) => getDramaStoryboard(projectId, boardId, signal),
        enabled: Boolean(boardId),
        refetchInterval: (query) => (["queued", "running"].includes(query.state.data?.status || "") ? 3000 : false),
    });
    const [config, setConfig] = useState<DramaShotMediaConfig>();
    const [grid, setGrid] = useState("2x2");
    const [selected, setSelected] = useState(shots.slice(0, 4).map((shot) => shot.id));
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [quote, setQuote] = useState<Quote>();
    const [price, setPrice] = useState<{ key: string; preview: DramaStoryboardPreflight }>();
    const [priceError, setPriceError] = useState<{ key: string; message: string }>();
    const [pricing, setPricing] = useState("");
    const [priceVersion, setPriceVersion] = useState(0);
    const [picker, setPicker] = useState(false);
    const locked = useRef(false);
    const creation = useRef<{ key: string; request: DramaStoryboardCreate } | undefined>(undefined);
    const current = board.data;
    const disabled = Boolean(busy || quote?.uncertain);
    const [rows, columns] = grid.split("x").map(Number);
    const slots = rows * columns;
    const visibleHistory = (history.data || []).filter((item) => item.shotIds.every((id) => shots.some((shot) => shot.id === id)));
    const savedPriceKey = (value: DramaStoryboard) => JSON.stringify([value.id, value.revision, shots]);
    const draftKey = boardId && current ? savedPriceKey(current) : JSON.stringify([selected, rows, columns, config, shots]);
    const displayedPrice = price?.key === draftKey ? price.preview : undefined;
    const canGenerate = !boardId ? Boolean(config && selected.length && selected.length <= slots) : current?.status === "draft";

    useEffect(() => {
        if (!canGenerate || busy || quote?.uncertain) return;
        let cancelled = false;
        const controller = new AbortController();
        const ticket = scope.capture();
        setPricing(draftKey);
        const timer = window.setTimeout(() => {
            const request = boardId && current ? preflightDramaStoryboard(projectId, boardId, { expectedRevision: current.revision }) : quoteDramaStoryboard(projectId, { shotIds: selected, rows, columns, config: config! }, controller.signal);
            void request
                .then((preview) => {
                    if (!cancelled && scope.isCurrent(ticket)) {
                        setPrice({ key: draftKey, preview });
                        setPriceError(undefined);
                    }
                })
                .catch((reason) => {
                    if (!cancelled && scope.isCurrent(ticket)) {
                        setPrice(undefined);
                        setPriceError({ key: draftKey, message: reason instanceof Error ? reason.message : "暂无法取得报价" });
                    }
                })
                .finally(() => {
                    if (!cancelled && scope.isCurrent(ticket)) setPricing("");
                });
        }, 300);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [draftKey, canGenerate, busy, quote?.uncertain, priceVersion]);

    useEffect(() => {
        if (summary.data && !config) {
            const refs = [...new Set(referenceResourceIds)].filter(Boolean).slice(0, 20);
            setConfig({
                model: summary.data.production.settings.models.image,
                prompt: "",
                operation: refs.length ? "image_to_image" : "text_to_image",
                aspectRatio: summary.data.production.settings.aspectRatio || "16:9",
                resolution: "1K",
                generateAudio: false,
                referenceResourceIds: refs,
            });
        }
    }, [summary.data, config, referenceResourceIds]);

    const accept = (value: DramaStoryboard) => {
        client.setQueryData(["drama-storyboard", userId, projectId, value.id], value);
        setBoardId(value.id);
        void client.invalidateQueries({ queryKey: listKey });
    };
    const run = async (name: string, action: (ticket: ReturnType<typeof scope.capture>) => Promise<void>) => {
        if (locked.current) return;
        locked.current = true;
        const ticket = scope.capture();
        setBusy(name);
        setError("");
        try {
            await action(ticket);
        } catch (reason) {
            if (scope.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : "操作失败");
        } finally {
            locked.current = false;
            if (scope.isCurrent(ticket)) setBusy("");
        }
    };
    const execute = () =>
        run("execute", async (ticket) => {
            let submission = quote?.uncertain ? quote : undefined;
            if (!submission) {
                if (!canGenerate || !displayedPrice?.ready || !displayedPrice.priced || !displayedPrice.scopeHash) return;
                let created = current;
                if (!boardId) {
                    if (!config) return;
                    if (creation.current?.key !== draftKey) creation.current = { key: draftKey, request: { clientOperationId: `storyboard-create:${crypto.randomUUID()}`, shotIds: selected, rows, columns, config } };
                    created = await createDramaStoryboard(projectId, creation.current.request);
                    if (!scope.isCurrent(ticket)) return;
                    accept(created);
                }
                if (!created) return;
                const preview = await preflightDramaStoryboard(projectId, created.id, { expectedRevision: created.revision });
                if (!scope.isCurrent(ticket)) return;
                setPrice({ key: savedPriceKey(created), preview });
                if (!preview.ready || !preview.priced || !preview.confirmationToken || preview.scopeHash !== displayedPrice.scopeHash || preview.amountMicrocredits !== displayedPrice.amountMicrocredits) {
                    setNotice("费用或生成范围已更新，请查看生成按钮后再操作。故事板草稿已保存。");
                    return;
                }
                submission = { boardId: created.id, preview, request: { expectedRevision: preview.revision, baseRevision: preview.baseRevision, confirmationToken: preview.confirmationToken, clientOperationId: `storyboard-image:${crypto.randomUUID()}` } };
                setQuote(submission);
            }
            try {
                const task = await executeDramaStoryboard(projectId, submission.boardId, submission.request);
                if (!scope.isCurrent(ticket)) return;
                setNotice(`故事板已提交，${STATUS[task.status] || "请查看任务状态"}`);
                setQuote(undefined);
                setPrice(undefined);
                client.setQueryData<DramaStoryboard>(["drama-storyboard", userId, projectId, submission.boardId], (previous) => (previous ? { ...previous, status: task.status, taskId: task.id } : previous));
            } catch (reason) {
                const rejected = reason instanceof ApiError && [reason.status, reason.code].some((value) => value !== undefined && value >= 400 && value < 500 && value !== 408);
                if (scope.isCurrent(ticket)) {
                    setQuote(rejected ? undefined : { ...submission, uncertain: true });
                    if (rejected) {
                        setPrice(undefined);
                        setPriceVersion((value) => value + 1);
                    }
                }
                throw reason;
            }
            try {
                const latest = await getDramaStoryboard(projectId, submission.boardId);
                if (scope.isCurrent(ticket)) accept(latest);
            } catch {
                if (scope.isCurrent(ticket)) setError("任务已提交，状态暂未刷新，请稍后刷新查看");
            }
        });
    const adopt = (cell: DramaStoryboardCell) =>
        run(`adopt:${cell.id}`, async (ticket) => {
            if (!current || !cell.shotId) return;
            await adoptDramaStoryboardCell(projectId, current.id, { expectedRevision: current.revision, expectedMediaRevision: cell.mediaRevision, cellId: cell.id });
            if (!scope.isCurrent(ticket)) return;
            setNotice("已采用为对应镜头的图片");
            void client.invalidateQueries({ queryKey: ["drama-shot-media", userId, projectId, cell.shotId, "image"] });
            const latest = await getDramaStoryboard(projectId, current.id);
            if (scope.isCurrent(ticket)) accept(latest);
        });

    return (
        <AppModal
            open
            centered
            width={1120}
            title={title}
            footer={null}
            onCancel={() => {
                if (!disabled) onClose();
            }}
            closable={!disabled}
            maskClosable={!disabled}
        >
            <div className="drama-storyboard">
                {history.isError ? <p role="alert">读取历史故事板失败，请刷新状态后再查看历史。</p> : null}
                {board.isError && current ? <p role="alert">故事板最新状态暂未读取，当前展示上次记录，请刷新状态。</p> : null}
                <div className="drama-storyboard-toolbar">
                    <Select
                        aria-label="故事板历史"
                        disabled={disabled}
                        placeholder="查看本段历史故事板"
                        value={boardId || undefined}
                        options={visibleHistory.map((item, index) => ({ value: item.id, label: `${index + 1} · ${item.rows}×${item.columns} · ${STATUS[item.status] || item.status}` }))}
                        onChange={(value) => {
                            setBoardId(value);
                            setQuote(undefined);
                            setNotice("");
                        }}
                    />
                    <Button
                        disabled={disabled || !boardId}
                        onClick={() => {
                            setBoardId("");
                            setQuote(undefined);
                            setError("");
                            setNotice("");
                        }}
                    >
                        新建故事板
                    </Button>
                    <Button
                        disabled={disabled}
                        onClick={() =>
                            void run("refresh", async (ticket) => {
                                if (boardId) {
                                    const value = await getDramaStoryboard(projectId, boardId);
                                    if (scope.isCurrent(ticket)) accept(value);
                                } else await history.refetch();
                            })
                        }
                    >
                        刷新状态
                    </Button>
                </div>
                {error ? <p role="alert">{error}</p> : null}
                {notice ? <p role="status">{notice}</p> : null}
                <div className="drama-storyboard-columns">
                    <section className="drama-storyboard-config" aria-label="故事板生成配置">
                        {!boardId ? (
                            <>
                                <p>选择本段镜头，先生成一张故事板原图，再裁切并逐格采用。</p>
                                {summary.isError ? (
                                    <p role="alert">
                                        读取作品默认配置失败 <Button onClick={() => void summary.refetch()}>重试配置</Button>
                                    </p>
                                ) : !config ? (
                                    <p role="status">正在读取默认配置…</p>
                                ) : (
                                    <>
                                        <label>
                                            <span>宫格规格</span>
                                            <Select
                                                aria-label="宫格规格"
                                                disabled={disabled}
                                                value={grid}
                                                options={[
                                                    { value: "2x2", label: "2 行 × 2 列" },
                                                    { value: "2x3", label: "2 行 × 3 列" },
                                                    { value: "3x3", label: "3 行 × 3 列" },
                                                ]}
                                                onChange={(value) => {
                                                    setGrid(value);
                                                    const [r, c] = value.split("x").map(Number);
                                                    setSelected((previous) => previous.slice(0, r * c));
                                                }}
                                            />
                                        </label>
                                        <div className="drama-storyboard-shots" aria-label="故事板镜头范围">
                                            {shots.map((shot) => (
                                                <Checkbox
                                                    key={shot.id}
                                                    checked={selected.includes(shot.id)}
                                                    disabled={disabled || (!selected.includes(shot.id) && selected.length >= slots)}
                                                    onChange={(event) =>
                                                        setSelected((previous) => (event.target.checked ? shots.filter((item) => previous.includes(item.id) || item.id === shot.id).map((item) => item.id) : previous.filter((id) => id !== shot.id)))
                                                    }
                                                >
                                                    镜头 {shot.position + 1}
                                                </Checkbox>
                                            ))}
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                            已选 {selected.length} / {slots} 格，剩余格留空，不新增镜头。
                                        </p>
                                        <label>
                                            <span>图片模型</span>
                                            <fieldset disabled={disabled} inert={disabled}>
                                                <DramaModelPicker
                                                    showPrice={false}
                                                    capability="image"
                                                    value={config.model}
                                                    aspectRatio={config.aspectRatio}
                                                    onChange={(model) => {
                                                        if (!disabled) setConfig({ ...config, model });
                                                    }}
                                                />
                                            </fieldset>
                                        </label>
                                        <div className="drama-storyboard-specs">
                                            <label>
                                                <span>整图画幅</span>
                                                <Input aria-label="故事板整图画幅" disabled={disabled} value={config.aspectRatio} onChange={(event) => setConfig({ ...config, aspectRatio: event.target.value })} />
                                            </label>
                                            <label>
                                                <span>整图分辨率</span>
                                                <Input aria-label="故事板整图分辨率" disabled={disabled} value={config.resolution} onChange={(event) => setConfig({ ...config, resolution: event.target.value })} />
                                            </label>
                                        </div>
                                        <label>
                                            <span>补充要求</span>
                                            <Input.TextArea aria-label="故事板补充要求" disabled={disabled} autoSize={{ minRows: 3, maxRows: 6 }} value={config.prompt} onChange={(event) => setConfig({ ...config, prompt: event.target.value })} />
                                        </label>
                                        <div className="drama-storyboard-references">
                                            {config.referenceResourceIds.map((id, index) => (
                                                <div key={id}>
                                                    <MediaThumb resourceId={id} alt={`故事板参考图 ${index + 1}`} />
                                                    <Button
                                                        size="small"
                                                        disabled={disabled}
                                                        onClick={() => {
                                                            const ids = config.referenceResourceIds.filter((value) => value !== id);
                                                            setConfig({ ...config, referenceResourceIds: ids, operation: ids.length ? "image_to_image" : "text_to_image" });
                                                        }}
                                                    >
                                                        移除
                                                    </Button>
                                                </div>
                                            ))}
                                        </div>
                                        <Button disabled={disabled || config.referenceResourceIds.length >= 20} onClick={() => setPicker(true)}>
                                            从资产库添加参考图
                                        </Button>
                                    </>
                                )}
                            </>
                        ) : current ? (
                            <>
                                <strong>
                                    {current.rows}×{current.columns} · {STATUS[current.status] || current.status}
                                </strong>
                                <p>
                                    关联 {current.shotIds.length} 个真实镜头，整图 {current.sourceWidth || "—"} × {current.sourceHeight || "—"}。
                                </p>
                                <pre className="drama-storyboard-prompt">{current.config.prompt}</pre>
                                {current.error ? <p role="alert">{current.error}</p> : null}
                                {current.status === "image_ready" ? (
                                    <Button
                                        disabled={disabled}
                                        loading={busy === "split"}
                                        onClick={() =>
                                            void run("split", async (ticket) => {
                                                const value = await splitDramaStoryboard(projectId, current.id, { expectedRevision: current.revision });
                                                if (scope.isCurrent(ticket)) accept(value);
                                            })
                                        }
                                    >
                                        裁切为独立图片
                                    </Button>
                                ) : null}
                            </>
                        ) : board.isError ? (
                            <p role="alert">读取故事板失败，请刷新状态。</p>
                        ) : (
                            <p role="status">正在读取故事板…</p>
                        )}
                        {!boardId || current?.status === "draft" || quote?.uncertain ? (
                            <Button
                                type="primary"
                                disabled={Boolean(busy) || (!quote?.uncertain && (!canGenerate || !displayedPrice?.ready || !displayedPrice.priced || !displayedPrice.scopeHash || pricing === draftKey))}
                                loading={busy === "execute"}
                                onClick={() => void execute()}
                            >
                                {quote?.uncertain ? "核对故事板提交" : generationLabel("生成图片", displayedPrice, canGenerate && pricing === draftKey)}
                            </Button>
                        ) : null}
                        {!boardId && !selected.length ? <p role="status">请选择至少一个镜头。</p> : null}
                        {quote?.uncertain ? <p role="status">回执未确认，核对会复用本次提交标识。</p> : null}
                        {displayedPrice && (!displayedPrice.ready || !displayedPrice.priced) ? <p role="status">{displayedPrice.reason || "当前参数暂无法取得报价，请调整配置。"}</p> : null}
                        {priceError?.key === draftKey ? <p role="alert">{priceError.message}</p> : null}
                    </section>
                    <section className="drama-storyboard-output" aria-label="故事板原图与真实裁片">
                        {current?.resourceId ? (
                            <>
                                <strong>原图</strong>
                                <MediaThumb resourceId={current.resourceId} alt="故事板原图" />
                            </>
                        ) : (
                            <p className="text-muted-foreground">生成后在这里查看原图和独立分图</p>
                        )}
                        {current?.cells.length ? (
                            <div className="drama-storyboard-grid" style={{ gridTemplateColumns: `repeat(${current.columns}, minmax(0, 1fr))` }}>
                                {current.cells.map((cell) => (
                                    <article key={cell.id}>
                                        <MediaThumb resourceId={cell.resourceId} alt={`第 ${cell.index + 1} 格真实图片`} />
                                        <span>
                                            {cell.shotId ? `镜头 ${(shots.find((shot) => shot.id === cell.shotId)?.position ?? cell.index) + 1}` : "未关联镜头"} · {cell.width}×{cell.height}
                                        </span>
                                        {cell.shotId ? (
                                            <Button size="small" disabled={disabled || cell.current || current.status !== "split"} loading={busy === `adopt:${cell.id}`} onClick={() => void adopt(cell)}>
                                                {cell.current ? "已采用" : "采用到此镜头"}
                                            </Button>
                                        ) : null}
                                    </article>
                                ))}
                            </div>
                        ) : null}
                    </section>
                </div>
            </div>
            <AssetLibraryPickerModal
                open={picker}
                remoteLibrary
                acceptRemoteItems
                remoteKind="image"
                mediaKinds={["image"]}
                multiple={false}
                items={[]}
                categoryLabels={{ all: "全部素材" }}
                title="选择故事板参考图"
                onClose={() => setPicker(false)}
                remoteItemDisabledReason={(asset) => (asset.kind === "image" && resourceIdFromStorageKey(asset.data.storageKey) ? undefined : "请选择已保存的图片")}
                onConfirm={(_ids, items) => {
                    const asset = items?.[0]?.asset;
                    const id = asset?.kind === "image" ? resourceIdFromStorageKey(asset.data.storageKey) : "";
                    if (!id || !config) throw new Error("请选择已保存的图片");
                    if (!disabled) setConfig({ ...config, referenceResourceIds: [...new Set([...config.referenceResourceIds, id])], operation: "image_to_image" });
                    setPicker(false);
                }}
            />
        </AppModal>
    );
}
