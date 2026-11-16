import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Input, Select } from "antd";
import { Images, Plus, RefreshCw, X } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import { CanvasImagePreview } from "@/components/canvas/canvas-image-preview";
import { createClientUUID } from "@/lib/client-id";
import { formatDramaCredits } from "@/lib/drama/drama-format";
import { dramaKeys } from "@/lib/drama/drama-query-keys";
import { dramaChoiceKey } from "@/lib/drama/model-choice";
import { getDrama, getDramaEpisodeStyle, type DramaCast, type DramaCastImageOptions } from "@/services/api/drama";
import {
    adoptDramaCastView,
    deleteDramaCastView,
    executeDramaCastView,
    listDramaCastViews,
    preflightDramaCastView,
    saveDramaCastView,
    type CastView,
    type CastViewConfig,
    type CastViewDirection,
    type CastViewPreflight,
} from "@/services/api/drama-cast-views";
import { ApiError } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

import { DramaModelPicker, useDramaModelCatalog } from "../drama-model-picker";
import { MediaThumb } from "../drama-shared";
import { CastLibraryPicker } from "./cast-library-picker";
import { readCastImageOptions } from "./cast-image-options";
import { clearCastViewPending, readCastViewPending, writeCastViewPending, type PendingCastView } from "./cast-views-state";
import { useDramaOperationScope } from "./use-drama-operation-scope";
import "./cast-views.css";

const DIRECTIONS: { value: CastViewDirection; label: string }[] = [
    { value: "front", label: "正面" },
    { value: "back", label: "背面" },
    { value: "left", label: "左侧" },
    { value: "right", label: "右侧" },
    { value: "top", label: "俯视" },
    { value: "detail", label: "局部" },
    { value: "custom", label: "自定义" },
];
const STATUS: Record<string, string> = { idle: "待生成", ready: "已就绪", stale: "设定已更新", queued: "排队中", running: "生成中", succeeded: "已完成", failed: "生成失败", cancelled: "已取消" };
type Props = { projectId: string; episodeId?: string; cast: DramaCast; disabled: boolean; onChanged: () => void; preview?: boolean };
type Quote = PendingCastView & { preview: CastViewPreflight };
type Workspace = { renderMain: (selector: ReactNode) => ReactNode; onDirtyChange?: (dirty: boolean, busy: boolean) => void };

export function CastViewWorkspace(props: Props & Workspace) {
    const userId = useUserStore((state) => state.user?.id || "");
    return <CastViewsSession key={`${userId}:${props.projectId}:${props.episodeId || ""}:${props.cast.id}`} {...props} userId={userId} onClose={() => undefined} workspace={props} />;
}

export function CastViews(props: Props) {
    const [open, setOpen] = useState(false);
    const userId = useUserStore((state) => state.user?.id || "");
    const query = useQuery({
        queryKey: ["drama-cast-views", userId, props.projectId, props.cast.id],
        queryFn: ({ signal }) => listDramaCastViews(props.projectId, props.cast.id, signal),
        enabled: Boolean(props.preview),
        refetchInterval: (value) => (props.preview && value.state.data?.views.some((row) => ["queued", "running"].includes(row.status)) ? 3000 : false),
    });
    return (
        <section className="drama-cast-views" aria-label="资产多视图">
            <Button type="text" icon={<Images className="size-4" />} disabled={props.disabled} onClick={() => setOpen(true)}>
                {props.preview ? "管理多视图" : "多视图"}
            </Button>
            {props.preview ? (
                <div className="drama-cast-view-strip">
                    {query.isPending ? (
                        <p role="status">正在读取独立视图…</p>
                    ) : query.isError ? (
                        <p role="alert">
                            独立视图读取失败。
                            <Button size="small" onClick={() => void query.refetch()}>
                                重试
                            </Button>
                        </p>
                    ) : !query.data?.views.length ? (
                        <p>暂无独立视图，可按需添加正面、侧面、背面或局部图。</p>
                    ) : (
                        query.data.views.map((row) => (
                            <article key={row.id}>
                                <div>{row.resourceId ? <MediaThumb resourceId={row.resourceId} alt={`${row.config.name}当前图片`} /> : <span>{STATUS[row.status] || "待生成"}</span>}</div>
                                <strong>{row.config.name}</strong>
                                <small>
                                    {DIRECTIONS.find((item) => item.value === row.config.direction)?.label} · {STATUS[row.status] || row.status}
                                </small>
                            </article>
                        ))
                    )}
                </div>
            ) : null}
            {open ? <CastViewsSession key={`${userId}:${props.projectId}:${props.episodeId || ""}:${props.cast.id}`} {...props} userId={userId} onClose={() => setOpen(false)} /> : null}
        </section>
    );
}

function CastViewsSession({ projectId, episodeId, cast, disabled, onChanged, onClose, userId, workspace }: Props & { userId: string; onClose: () => void; workspace?: Workspace }) {
    const { modal } = App.useApp();
    const operation = useDramaOperationScope(projectId);
    const queryKey = ["drama-cast-views", userId, projectId, cast.id];
    const query = useQuery({
        queryKey,
        queryFn: ({ signal }) => listDramaCastViews(projectId, cast.id, signal),
        refetchInterval: (value) => (value.state.data?.views.some((row) => ["queued", "running"].includes(row.status) || row.takes.some((take) => ["queued", "running"].includes(take.status))) ? 3000 : false),
    });
    const summary = useQuery({ queryKey: dramaKeys.summary(projectId), queryFn: ({ signal }) => getDrama(projectId, signal) });
    const [quote, setQuote] = useState<Quote>();
    const [pending, setPending] = useState<PendingCastView>();
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [editor, setEditor] = useState<{ row?: CastView }>();
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [selected, setSelected] = useState<string>();
    const [workspaceEditor, setWorkspaceEditor] = useState<{ row?: CastView; expectedRevision?: number; castRevision?: number }>();
    const [editorState, setEditorState] = useState({ dirty: false, busy: false });
    const [previewing, setPreviewing] = useState(false);
    const locked = useRef(false);
    const revision = summary.data?.production.revision;
    const blocked = Boolean(disabled || busy || pending || !loaded || summary.isError || summary.isPending || query.isError || query.isPending);
    const selectedRow = query.data?.views.find((row) => row.id === selected);
    const stateChange = useRef(workspace?.onDirtyChange);
    stateChange.current = workspace?.onDirtyChange;
    useEffect(() => {
        if (workspace && selected) stateChange.current?.(editorState.dirty, Boolean(busy) || editorState.busy);
    }, [workspace, selected, editorState, busy]);
    useEffect(() => {
        if (workspace && selected && selected !== "new" && query.isSuccess && !selectedRow) {
            setSelected(undefined);
            setWorkspaceEditor(undefined);
            setQuote(undefined);
            setNotice("所选独立视图已不存在，已返回主视觉");
            stateChange.current?.(false, false);
        }
    }, [workspace, selected, selectedRow, query.isSuccess]);
    useEffect(() => {
        if (!workspace || !selectedRow || selected === "new" || editorState.dirty || editorState.busy || busy || revision === undefined) return;
        if (workspaceEditor?.row?.revision !== selectedRow.revision || workspaceEditor.expectedRevision !== revision || workspaceEditor.castRevision !== cast.revision)
            setWorkspaceEditor({ row: selectedRow, expectedRevision: revision, castRevision: cast.revision });
    }, [workspace, selected, selectedRow, editorState.dirty, editorState.busy, busy, revision, cast.revision, workspaceEditor]);

    const load = async () => {
        const ticket = operation.capture();
        setLoadError("");
        try {
            const value = await readCastViewPending(userId, projectId, cast.id);
            if (operation.isCurrent(ticket)) {
                setPending(value);
                setLoaded(true);
            }
        } catch (reason) {
            if (operation.isCurrent(ticket)) setLoadError(reason instanceof Error ? reason.message : "读取提交记录失败");
        }
    };
    useEffect(() => {
        void load();
    }, []);
    const run = async (name: string, action: (ticket: ReturnType<typeof operation.capture>) => Promise<void>) => {
        if (locked.current) return;
        locked.current = true;
        const ticket = operation.capture();
        setBusy(name);
        setError("");
        try {
            await action(ticket);
        } catch (reason) {
            if (operation.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : "操作失败");
        } finally {
            locked.current = false;
            if (operation.isCurrent(ticket)) setBusy("");
        }
    };
    const refresh = async (ticket: ReturnType<typeof operation.capture>, text?: string) => {
        if (!operation.isCurrent(ticket)) return;
        setQuote(undefined);
        if (text) setNotice(text);
        onChanged();
        const refreshed = await Promise.all([query.refetch(), summary.refetch()]);
        if (operation.isCurrent(ticket) && refreshed.some((item) => item.isError)) setError("操作已完成，最新状态暂未刷新，请重新载入");
        return refreshed;
    };
    const execute = (value: PendingCastView) =>
        run("execute", async (ticket) => {
            await writeCastViewPending(userId, projectId, cast.id, value);
            if (!operation.isCurrent(ticket)) return;
            setPending(value);
            try {
                await executeDramaCastView(projectId, cast.id, value.viewId, value.action);
                await clearCastViewPending(userId, projectId, cast.id);
                if (!operation.isCurrent(ticket)) return;
                setPending(undefined);
                await refresh(ticket, "视图生成已提交，进度将自动更新");
            } catch (reason) {
                const rejected = reason instanceof ApiError && [reason.status, reason.code].some((status) => status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429);
                if (rejected) {
                    await clearCastViewPending(userId, projectId, cast.id);
                    if (operation.isCurrent(ticket)) {
                        setPending(undefined);
                        setQuote(undefined);
                    }
                }
                throw reason;
            }
        });
    if (workspace) {
        const select = (id?: string) => {
            if (disabled || busy || editorState.busy || id === selected) return;
            const apply = () => {
                setSelected(id);
                setQuote(undefined);
                setError("");
                setPreviewing(false);
                setEditorState({ dirty: false, busy: false });
                setWorkspaceEditor(id ? { row: query.data?.views.find((row) => row.id === id), expectedRevision: revision, castRevision: cast.revision } : undefined);
                stateChange.current?.(false, false);
            };
            if (!editorState.dirty) return apply();
            const ticket = operation.capture();
            modal.confirm({
                title: "放弃未保存的视图配置？",
                okText: "放弃并切换",
                cancelText: "继续编辑",
                onOk: () => {
                    if (operation.isCurrent(ticket)) apply();
                },
            });
        };
        const selector = (
            <section className="drama-cast-views" aria-label="选择主视觉或独立视图">
                <div className="drama-editor-workspace-heading">
                    <h3>当前对象：{selected ? selectedRow?.config.name || "新建独立视图" : "主视觉"}</h3>
                    <span>独立视图单独保存与生成</span>
                </div>
                <div className="drama-cast-view-strip" role="tablist" aria-label="主视觉与独立视图">
                    <button type="button" role="tab" aria-label="选择主视觉" aria-selected={!selected} disabled={disabled || Boolean(busy) || editorState.busy} onClick={() => select()}>
                        {cast.imageResourceId ? <MediaThumb resourceId={cast.imageResourceId} alt="主视觉" /> : <Images className="size-5" />}
                        <strong>主视觉</strong>
                    </button>
                    {(query.data?.views || []).map((row) => (
                        <button type="button" role="tab" aria-label={`选择${row.config.name}独立视图`} key={row.id} aria-selected={selected === row.id} disabled={disabled || Boolean(busy) || editorState.busy} onClick={() => select(row.id)}>
                            {row.resourceId ? <MediaThumb resourceId={row.resourceId} alt={row.config.name} /> : <Images className="size-5" />}
                            <strong>{row.config.name}</strong>
                            <small>{STATUS[row.status] || row.status}</small>
                        </button>
                    ))}
                    <Button icon={<Plus className="size-4" />} disabled={blocked || editorState.busy || typeof cast.revision !== "number"} onClick={() => select("new")}>
                        新增视图
                    </Button>
                </div>
                {query.isPending ? (
                    <p role="status">正在读取独立视图…</p>
                ) : query.isError ? (
                    <p role="alert">
                        独立视图读取失败。
                        <Button size="small" onClick={() => void query.refetch()}>
                            重试
                        </Button>
                    </p>
                ) : !query.data?.views.length ? (
                    <p>暂无独立视图，可按需新增。</p>
                ) : null}
                {summary.isError ? (
                    <p role="alert">
                        作品配置读取失败，请刷新状态后再操作独立视图。
                        <Button
                            size="small"
                            disabled={Boolean(busy)}
                            onClick={() =>
                                void run("refresh", async (ticket) => {
                                    await refresh(ticket);
                                })
                            }
                        >
                            刷新视图状态
                        </Button>
                    </p>
                ) : null}
                {error ? <p role="alert">{error}</p> : null}
                {notice ? <p role="status">{notice}</p> : null}
                {loadError ? (
                    <p role="alert">
                        {loadError}
                        <Button onClick={() => void load()}>重新读取提交记录</Button>
                    </p>
                ) : null}
                {pending ? (
                    <div role="status">
                        视图提交结果待确认，将复用原提交标识。
                        <Button disabled={Boolean(busy)} loading={busy === "execute"} onClick={() => void execute(pending)}>
                            确认提交结果
                        </Button>
                    </div>
                ) : null}
            </section>
        );
        if (!selected) return workspace.renderMain(selector);
        const row = selectedRow;
        const active = row && (["queued", "running"].includes(row.status) || row.takes.some((take) => ["queued", "running"].includes(take.status)));
        const currentQuote = quote?.viewId === row?.id ? quote : undefined;
        const quoteStale = currentQuote && (currentQuote.action.viewRevision !== row?.revision || currentQuote.action.expectedRevision !== revision);
        return (
            <div className="drama-editor is-workspace is-view" aria-label={`${row?.config.name || "新建独立视图"}工作区`}>
                <section className="drama-editor-settings thin-scrollbar" aria-label="独立视图配置">
                    <div className="drama-editor-workspace-heading">
                        <h3>{row?.config.name || "新增独立视图"}</h3>
                        <span>仅修改当前视图</span>
                    </div>
                    {workspaceEditor && revision !== undefined ? (
                        <CastViewEditor
                            key={`${selected}:${workspaceEditor.row?.revision || 0}:${workspaceEditor.expectedRevision ?? revision}:${workspaceEditor.castRevision ?? cast.revision}`}
                            projectId={projectId}
                            episodeId={episodeId}
                            cast={cast}
                            row={workspaceEditor.row}
                            expectedRevision={workspaceEditor.expectedRevision ?? revision}
                            inline
                            disabled={Boolean(busy) || Boolean(active) || Boolean(pending) || summary.isError || query.isError}
                            onDirtyChange={(dirty, busy) => setEditorState((previous) => (previous.dirty === dirty && previous.busy === busy ? previous : { dirty, busy }))}
                            onClose={() => select()}
                            onSaved={async (saved) => {
                                await run("save", async (ticket) => {
                                    const refreshed = await refresh(ticket, "视图配置已保存，可预检生成");
                                    if (!operation.isCurrent(ticket) || !refreshed || refreshed.some((item) => item.isError)) return;
                                    setSelected(saved.id);
                                    setWorkspaceEditor({ row: saved, expectedRevision: refreshed[1].data?.production.revision, castRevision: cast.revision });
                                });
                            }}
                        />
                    ) : (
                        <p role="status">正在读取视图配置…</p>
                    )}
                    {editorState.dirty && row && (workspaceEditor?.row?.revision !== row.revision || workspaceEditor.expectedRevision !== revision || workspaceEditor.castRevision !== cast.revision) ? (
                        <p role="alert">已保存版本发生变化，当前草稿已保留。切换后重新载入再编辑，避免覆盖其他修改。</p>
                    ) : null}
                </section>
                <section className="drama-editor-preview" aria-label="当前独立视图">
                    <div className="drama-editor-workspace-heading">
                        <h3>{row?.config.name || "新建独立视图"}</h3>
                        <span>{row ? STATUS[row.status] || row.status : "保存配置后可生成"}</span>
                    </div>
                    <button type="button" className="drama-cast-hero drama-cast-view-preview" disabled={!row?.resourceId} aria-label={`放大查看${row?.config.name || "视图"}`} onClick={() => setPreviewing(true)}>
                        {row?.resourceId ? <MediaThumb resourceId={row.resourceId} alt={row.config.name} /> : <span>{row ? STATUS[row.status] || row.status : "尚无图片"}</span>}
                    </button>
                    {row?.error ? <p role="alert">{row.error}</p> : null}
                </section>
                <div className="drama-editor-actions">
                    {row ? (
                        <>
                            <Button
                                icon={<RefreshCw className="size-4" />}
                                loading={busy === `check:${row.id}`}
                                disabled={blocked || editorState.dirty || editorState.busy || Boolean(active)}
                                onClick={() =>
                                    void run(`check:${row.id}`, async (ticket) => {
                                        const preview = await preflightDramaCastView(projectId, cast.id, row.id, { viewRevision: row.revision, ...(episodeId ? { episodeId } : {}) });
                                        const current = await summary.refetch();
                                        if (current.isError) throw new Error("无法确认最新作品版本，请刷新后重试");
                                        if (operation.isCurrent(ticket))
                                            setQuote({
                                                viewId: row.id,
                                                preview,
                                                action: {
                                                    expectedRevision: preview.revision,
                                                    viewRevision: preview.viewRevision,
                                                    confirmationToken: preview.confirmationToken,
                                                    clientOperationId: `cast-view:${createClientUUID()}`,
                                                    ...(episodeId ? { episodeId } : {}),
                                                },
                                            });
                                    })
                                }
                            >
                                预检生成
                            </Button>
                            <Button
                                danger
                                disabled={blocked || editorState.dirty || editorState.busy || Boolean(active)}
                                onClick={() => {
                                    const ticket = operation.capture();
                                    modal.confirm({
                                        title: `删除视图“${row.config.name}”？`,
                                        content: "删除配置，资源与任务历史保留。",
                                        okText: "删除视图",
                                        cancelText: "取消",
                                        onOk: () => {
                                            if (!operation.isCurrent(ticket) || revision === undefined) return;
                                            return run(`delete:${row.id}`, async (current) => {
                                                await deleteDramaCastView(projectId, cast.id, row.id, { expectedRevision: revision, viewRevision: row.revision });
                                                setSelected(undefined);
                                                setWorkspaceEditor(undefined);
                                                await refresh(current, "视图已删除");
                                            });
                                        },
                                    });
                                }}
                            >
                                删除视图
                            </Button>
                        </>
                    ) : null}
                    {currentQuote ? (
                        <div role="status">
                            {quoteStale
                                ? "配置已有更新，请重新预检。"
                                : currentQuote.preview.ready
                                  ? `${currentQuote.preview.estimated ? "预计" : "本次"} ${formatDramaCredits(currentQuote.preview.amountMicrocredits)} 积分`
                                  : currentQuote.preview.reason || "当前无法生成"}
                            {currentQuote.preview.ready ? (
                                <Button type="primary" disabled={blocked || editorState.dirty || editorState.busy || Boolean(quoteStale) || !currentQuote.preview.priced} onClick={() => void execute(currentQuote)}>
                                    确认生成此视图
                                </Button>
                            ) : null}
                        </div>
                    ) : null}
                </div>
                <section className="drama-editor-extras">{selector}</section>
                <aside className="drama-editor-history" aria-label="独立视图版本记录">
                    <div className="drama-editor-workspace-heading">
                        <h3>{row?.config.name || "独立视图"} · 版本记录</h3>
                    </div>
                    {row?.takes.length ? (
                        <div className="drama-cast-view-history">
                            {row.takes.map((take) => (
                                <div key={take.id}>
                                    {take.resourceId ? <MediaThumb resourceId={take.resourceId} alt={`${row.config.name}版本${take.version}`} /> : null}
                                    <span>
                                        版本 {take.version} · {STATUS[take.status] || take.status}
                                        {take.current ? " · 当前使用" : ""}
                                    </span>
                                    {take.error ? <p role="alert">{take.error}</p> : null}
                                    <Button
                                        disabled={blocked || editorState.dirty || editorState.busy || !take.resourceId || take.current || !["ready", "succeeded"].includes(take.status) || revision === undefined}
                                        onClick={() =>
                                            void run(`adopt:${take.id}`, async (ticket) => {
                                                if (revision === undefined) return;
                                                await adoptDramaCastView(projectId, cast.id, row.id, { expectedRevision: revision, viewRevision: row.revision, takeId: take.id });
                                                await refresh(ticket, "已采用该视图历史图片");
                                            })
                                        }
                                    >
                                        采用此版本
                                    </Button>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p role="status">暂无版本记录</p>
                    )}
                </aside>
                {previewing && row?.resourceId ? <CanvasImagePreview storageKey={`resource:${row.resourceId}`} alt={row.config.name} onClose={() => setPreviewing(false)} /> : null}
            </div>
        );
    }
    return (
        <AppModal
            open
            centered
            width="min(920px, calc(100vw - 32px))"
            title={`${cast.lookName || cast.name} · 多视图`}
            footer={null}
            onCancel={onClose}
            closable={!busy && !editor}
            maskClosable={!busy && !editor}
            keyboard={!busy && !editor}
            rootClassName="drama-root"
        >
            <div className="drama-cast-views-body">
                <p>为角色、造型、场景或道具保存独立视图。每个视图单独生成、保留历史，采用结果只更新该视图。</p>
                <div className="drama-cast-views-actions">
                    <Button
                        icon={<Plus className="size-4" />}
                        disabled={blocked || typeof cast.revision !== "number"}
                        onClick={() => {
                            setQuote(undefined);
                            setEditor({});
                        }}
                    >
                        新增视图
                    </Button>
                    <Button
                        icon={<RefreshCw className="size-4" />}
                        disabled={Boolean(busy)}
                        onClick={() =>
                            void run("refresh", async (ticket) => {
                                await refresh(ticket);
                            })
                        }
                    >
                        刷新
                    </Button>
                </div>
                {error ? <p role="alert">{error}</p> : null}
                {notice ? <p role="status">{notice}</p> : null}
                {loadError ? (
                    <p role="alert">
                        {loadError} <Button onClick={() => void load()}>重新读取提交记录</Button>
                    </p>
                ) : null}
                {pending ? (
                    <div role="status">
                        视图提交结果待确认，将复用原提交标识。
                        <Button disabled={Boolean(busy)} loading={busy === "execute"} onClick={() => void execute(pending)}>
                            确认提交结果
                        </Button>
                    </div>
                ) : null}
                {query.isPending || summary.isPending ? <p role="status">正在读取视图与当前配置…</p> : null}
                {query.isError || summary.isError ? <p role="alert">读取视图或作品配置失败，请刷新后再操作。</p> : null}
                {!query.isPending && !query.isError && !query.data?.views.length ? <p>还没有独立视图，点击“新增视图”选择方向并保存配置。</p> : null}
                <div className="drama-cast-views-grid">
                    {(query.data?.views || []).map((row) => {
                        const active = ["queued", "running"].includes(row.status) || row.takes.some((take) => ["queued", "running"].includes(take.status));
                        const currentQuote = quote?.viewId === row.id ? quote : undefined;
                        const quoteStale = currentQuote && (currentQuote.action.viewRevision !== row.revision || currentQuote.action.expectedRevision !== revision);
                        return (
                            <article key={row.id} className="drama-cast-view-card">
                                <div className="drama-cast-view-image">{row.resourceId ? <MediaThumb resourceId={row.resourceId} alt={`${row.config.name}当前图片`} /> : <span>{STATUS[row.status] || "待生成"}</span>}</div>
                                <div className="drama-cast-views-actions">
                                    <strong>{row.config.name}</strong>
                                    <span>
                                        {DIRECTIONS.find((item) => item.value === row.config.direction)?.label} · {STATUS[row.status] || row.status}
                                    </span>
                                </div>
                                {row.error ? <p role="alert">{row.error}</p> : null}
                                <div className="drama-cast-views-actions">
                                    <Button
                                        size="small"
                                        disabled={blocked || active}
                                        onClick={() => {
                                            setQuote(undefined);
                                            setEditor({ row });
                                        }}
                                    >
                                        编辑配置
                                    </Button>
                                    <Button
                                        size="small"
                                        disabled={blocked || active}
                                        loading={busy === `check:${row.id}`}
                                        onClick={() =>
                                            void run(`check:${row.id}`, async (ticket) => {
                                                const preview = await preflightDramaCastView(projectId, cast.id, row.id, { viewRevision: row.revision, ...(episodeId ? { episodeId } : {}) });
                                                const current = await summary.refetch();
                                                if (current.isError) throw new Error("无法确认最新作品版本，请刷新后重试");
                                                if (operation.isCurrent(ticket))
                                                    setQuote({
                                                        viewId: row.id,
                                                        preview,
                                                        action: {
                                                            expectedRevision: preview.revision,
                                                            viewRevision: preview.viewRevision,
                                                            confirmationToken: preview.confirmationToken,
                                                            clientOperationId: `cast-view:${createClientUUID()}`,
                                                            ...(episodeId ? { episodeId } : {}),
                                                        },
                                                    });
                                            })
                                        }
                                    >
                                        预检生成
                                    </Button>
                                    <Button
                                        size="small"
                                        danger
                                        disabled={blocked || active}
                                        onClick={() => {
                                            const ticket = operation.capture();
                                            modal.confirm({
                                                title: `删除视图“${row.config.name}”？`,
                                                content: "删除视图配置，已生成的资源和任务历史会保留。",
                                                okText: "删除视图",
                                                cancelText: "取消",
                                                onOk: () => {
                                                    if (!operation.isCurrent(ticket) || revision === undefined) return;
                                                    return run(`delete:${row.id}`, async (current) => {
                                                        await deleteDramaCastView(projectId, cast.id, row.id, { expectedRevision: revision, viewRevision: row.revision });
                                                        await refresh(current, "视图已删除");
                                                    });
                                                },
                                            });
                                        }}
                                    >
                                        删除视图
                                    </Button>
                                </div>
                                {currentQuote ? (
                                    <div role="status">
                                        {quoteStale
                                            ? "配置已有更新，请重新预检。"
                                            : currentQuote.preview.ready
                                              ? `${currentQuote.preview.estimated ? "预计" : "本次"} ${formatDramaCredits(currentQuote.preview.amountMicrocredits)} 积分`
                                              : currentQuote.preview.reason || "当前无法生成"}
                                        {currentQuote.preview.ready ? (
                                            <Button size="small" type="primary" disabled={blocked || Boolean(quoteStale) || !currentQuote.preview.priced} onClick={() => void execute(currentQuote)}>
                                                确认生成此视图
                                            </Button>
                                        ) : null}
                                    </div>
                                ) : null}
                                <details>
                                    <summary>历史结果（{row.takes.length}）</summary>
                                    <div className="drama-cast-view-history">
                                        {row.takes.map((take) => (
                                            <div key={take.id}>
                                                {take.resourceId ? <MediaThumb resourceId={take.resourceId} alt={`${row.config.name}版本${take.version}`} /> : null}
                                                <span>
                                                    版本 {take.version} · {STATUS[take.status] || take.status}
                                                    {take.current ? " · 当前使用" : ""}
                                                </span>
                                                {take.error ? <p role="alert">{take.error}</p> : null}
                                                <Button
                                                    size="small"
                                                    disabled={blocked || !take.resourceId || take.current || !["ready", "succeeded"].includes(take.status) || revision === undefined}
                                                    onClick={() =>
                                                        void run(`adopt:${take.id}`, async (ticket) => {
                                                            if (revision === undefined) return;
                                                            await adoptDramaCastView(projectId, cast.id, row.id, { expectedRevision: revision, viewRevision: row.revision, takeId: take.id });
                                                            await refresh(ticket, "已采用该视图历史图片");
                                                        })
                                                    }
                                                >
                                                    采用此版本
                                                </Button>
                                            </div>
                                        ))}
                                    </div>
                                </details>
                            </article>
                        );
                    })}
                </div>
                {editor && revision !== undefined ? (
                    <CastViewEditor
                        key={`${editor.row?.id || "new"}:${editor.row?.revision || 0}`}
                        projectId={projectId}
                        episodeId={episodeId}
                        cast={cast}
                        row={editor.row}
                        expectedRevision={revision}
                        onClose={() => setEditor(undefined)}
                        onSaved={async () => {
                            const ticket = operation.capture();
                            setEditor(undefined);
                            await refresh(ticket, "视图配置已保存，可在卡片上预检生成");
                        }}
                    />
                ) : null}
            </div>
        </AppModal>
    );
}

function CastViewEditor({
    projectId,
    episodeId,
    cast,
    row,
    expectedRevision,
    onClose,
    onSaved,
    inline,
    disabled,
    onDirtyChange,
}: {
    projectId: string;
    episodeId?: string;
    cast: DramaCast;
    row?: CastView;
    expectedRevision: number;
    onClose: () => void;
    onSaved: (saved: CastView) => Promise<void>;
    inline?: boolean;
    disabled?: boolean;
    onDirtyChange?: (dirty: boolean, busy: boolean) => void;
}) {
    const { modal } = App.useApp();
    const userId = useUserStore((state) => state.user?.id || "");
    const operation = useDramaOperationScope(projectId);
    const [draft, setDraft] = useState<CastViewConfig>(() => (row ? structuredClone(row.config) : { name: "", direction: "front", prompt: "", imageOptions: { model: {}, ratio: "", resolution: "" } }));
    const initial = useRef(JSON.stringify(draft));
    const baseVersions = useRef({ expectedRevision, expectedCastRevision: cast.revision, viewRevision: row?.revision || 0 });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [picker, setPicker] = useState<"subjectReferenceIds" | "styleReferenceIds">();
    const locked = useRef(false);
    const stateChange = useRef(onDirtyChange);
    stateChange.current = onDirtyChange;
    const dirty = initial.current !== JSON.stringify(draft);
    useEffect(() => {
        stateChange.current?.(dirty, saving);
    }, [dirty, saving]);
    useEffect(() => () => stateChange.current?.(false, false), []);
    const catalog = useDramaModelCatalog();
    let inherited: DramaCastImageOptions | undefined;
    try {
        inherited = readCastImageOptions(cast.imageOptionsJson);
    } catch {
        /* The server refuses invalid inherited configuration on save. */
    }
    const summary = useQuery({ queryKey: dramaKeys.summary(projectId), queryFn: ({ signal }) => getDrama(projectId, signal) });
    const episodeSettings = useQuery({
        queryKey: ["drama-episode-style", userId, projectId, episodeId, summary.data?.production.revision || 0],
        queryFn: ({ signal }) => getDramaEpisodeStyle(projectId, episodeId!, signal),
        enabled: Boolean(episodeId && summary.data),
    });
    const contextBlocked = Boolean(summary.isPending || summary.isError || (episodeId && (!episodeSettings.data || episodeSettings.isError)));
    const settings = episodeId ? episodeSettings.data?.settings : summary.data?.production.settings;
    const categoryModel = cast.kind === "character" ? settings?.models.characterImage : cast.kind === "scene" ? settings?.models.sceneImage : settings?.models.propImage;
    const model = dramaChoiceKey(draft.imageOptions.model) ? draft.imageOptions.model : dramaChoiceKey(inherited?.model) ? inherited?.model : dramaChoiceKey(categoryModel) ? categoryModel : settings?.models.image;
    const option = catalog.data?.options.image.find((item) => dramaChoiceKey(item.choice) === dramaChoiceKey(model));
    const patch = (value: Partial<CastViewConfig>) => {
        if (!locked.current) setDraft((current) => ({ ...current, ...value }));
    };
    const patchOptions = (value: Partial<CastViewConfig["imageOptions"]>) => {
        if (!locked.current) setDraft((current) => ({ ...current, imageOptions: { ...current.imageOptions, ...value } }));
    };
    const close = () => {
        if (locked.current) return;
        if (inline) return onClose();
        if (initial.current === JSON.stringify(draft)) return onClose();
        const ticket = operation.capture();
        modal.confirm({
            title: "放弃未保存的视图配置？",
            onOk: () => {
                if (operation.isCurrent(ticket)) onClose();
            },
        });
    };
    const save = async () => {
        if (disabled || contextBlocked || locked.current || typeof baseVersions.current.expectedCastRevision !== "number") return;
        locked.current = true;
        setSaving(true);
        setError("");
        const ticket = operation.capture();
        try {
            const saved = await saveDramaCastView(projectId, cast.id, row?.id, { ...baseVersions.current, expectedCastRevision: baseVersions.current.expectedCastRevision, config: draft, ...(episodeId ? { episodeId } : {}) });
            if (operation.isCurrent(ticket)) {
                initial.current = JSON.stringify(draft);
                await onSaved(saved);
            }
        } catch (reason) {
            if (operation.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : "保存视图失败");
        } finally {
            locked.current = false;
            if (operation.isCurrent(ticket)) setSaving(false);
        }
    };
    return (
        <CastViewEditorShell inline={inline} title={row ? "编辑视图配置" : "新增独立视图"} onClose={close} saving={saving}>
            {contextBlocked ? <p role={summary.isError || episodeSettings.isError ? "alert" : "status"}>{summary.isError || episodeSettings.isError ? "制作配置读取失败，请重新进入后再操作。" : "正在读取制作配置…"}</p> : null}
            <fieldset className="drama-cast-view-form" disabled={saving || disabled || contextBlocked} inert={saving || disabled || contextBlocked}>
                <label>
                    <span>视图名称</span>
                    <Input aria-label="视图名称" value={draft.name} maxLength={60} onChange={(event) => patch({ name: event.target.value })} />
                </label>
                <label>
                    <span>方向</span>
                    <Select aria-label="视图方向" value={draft.direction} options={DIRECTIONS} onChange={(direction) => patch({ direction })} />
                </label>
                <label>
                    <span>补充提示词</span>
                    <Input.TextArea aria-label="视图补充提示词" value={draft.prompt} rows={3} maxLength={12000} onChange={(event) => patch({ prompt: event.target.value })} />
                </label>
                <label>
                    <span>图片模型</span>
                    <DramaModelPicker capability="image" value={model} onChange={(value) => patchOptions({ model: value, ratio: "", resolution: "" })} />
                </label>
                <Button size="small" disabled={!dramaChoiceKey(draft.imageOptions.model)} onClick={() => patchOptions({ model: {}, ratio: "", resolution: "" })}>
                    沿用本资产模型
                </Button>
                <div className="drama-cast-view-parameters">
                    <label>
                        <span>画幅</span>
                        <Select
                            aria-label="视图画幅"
                            value={draft.imageOptions.ratio}
                            options={[{ value: "", label: "沿用本资产画幅" }, ...Array.from(new Set([...(option?.imageRatios || []), draft.imageOptions.ratio].filter(Boolean))).map((value) => ({ value, label: value }))]}
                            onChange={(ratio) => patchOptions({ ratio })}
                        />
                    </label>
                    <label>
                        <span>分辨率</span>
                        <Select
                            aria-label="视图分辨率"
                            value={draft.imageOptions.resolution}
                            options={[{ value: "", label: "沿用本资产分辨率" }, ...Array.from(new Set([...(option?.imageResolutions || []), draft.imageOptions.resolution].filter(Boolean))).map((value) => ({ value, label: value }))]}
                            onChange={(resolution) => patchOptions({ resolution })}
                        />
                    </label>
                </div>
                {(["subjectReferenceIds", "styleReferenceIds"] as const).map((key) => {
                    const own = draft.imageOptions[key];
                    const refs = own ?? inherited?.[key] ?? [];
                    const label = key === "subjectReferenceIds" ? "主体" : "风格";
                    return (
                        <section key={key}>
                            <div className="drama-cast-views-actions">
                                <strong>{label}参考</strong>
                                <Select
                                    aria-label={`${label}参考来源`}
                                    value={own == null ? "inherit" : "custom"}
                                    options={[
                                        { value: "inherit", label: "沿用本资产参考" },
                                        { value: "custom", label: "单独设置" },
                                    ]}
                                    onChange={(value) => patchOptions({ [key]: value === "inherit" ? undefined : [...refs] })}
                                />
                            </div>
                            <div className="drama-cast-view-references">
                                {refs.map((id, index) => (
                                    <div key={id}>
                                        <MediaThumb resourceId={id} alt={`${label}参考${index + 1}`} />
                                        {own != null ? <Button size="small" type="text" icon={<X className="size-3" />} aria-label={`移除${label}参考${index + 1}`} onClick={() => patchOptions({ [key]: own.filter((item) => item !== id) })} /> : null}
                                    </div>
                                ))}
                                <Button size="small" onClick={() => setPicker(key)}>
                                    从资产库添加{label}参考
                                </Button>
                                {own != null ? (
                                    <Button size="small" onClick={() => patchOptions({ [key]: [] })}>
                                        清空{label}参考
                                    </Button>
                                ) : null}
                            </div>
                        </section>
                    );
                })}
                <p>空模型和规格沿用本资产配置；主体图会自动用于保持一致性。保存配置不会提交生成或替换图片。</p>
                {error ? <p role="alert">{error}</p> : null}
                <div className="drama-cast-views-actions">
                    <Button onClick={close}>取消</Button>
                    <Button type="primary" loading={saving} disabled={!draft.name.trim() || (draft.direction === "custom" && !draft.prompt.trim()) || typeof cast.revision !== "number"} onClick={() => void save()}>
                        保存视图配置
                    </Button>
                </div>
            </fieldset>
            {picker ? (
                <CastLibraryPicker
                    open
                    cast={cast}
                    referenceGroup={picker === "subjectReferenceIds" ? "主体" : "风格"}
                    onClose={() => setPicker(undefined)}
                    onPick={async (id) => {
                        if (locked.current) throw new Error("正在保存，请稍后再选择");
                        const ticket = operation.capture();
                        if (!operation.isCurrent(ticket)) throw new Error("会话已变化，请重新选择");
                        const refs = draft.imageOptions[picker] ?? inherited?.[picker] ?? [];
                        if (refs.includes(id)) throw new Error("图片已在此参考组中");
                        patchOptions({ [picker]: [...refs, id] });
                    }}
                />
            ) : null}
        </CastViewEditorShell>
    );
}

function CastViewEditorShell({ inline, title, onClose, saving, children }: { inline?: boolean; title: string; onClose: () => void; saving: boolean; children: ReactNode }) {
    if (inline) return <>{children}</>;
    return (
        <AppModal open centered title={title} onCancel={onClose} footer={null} width="min(620px, calc(100vw - 32px))" closable={!saving} maskClosable={!saving} keyboard={!saving} rootClassName="drama-root">
            {children}
        </AppModal>
    );
}
