import { useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { App, Button, Checkbox, Select } from "antd";
import { Link2 } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import { dramaKeys } from "@/lib/drama/drama-query-keys";
import { getActiveUserScope, isUserSessionInvalidated, subscribeUserSessionInvalidation } from "@/lib/user-scope";
import { importDramaCast, listDramaCast, listDramas, type DramaCast } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";
import { CAST_KIND_LABEL, MediaThumb } from "../drama-shared";
import { useDramaOperationScope } from "./use-drama-operation-scope";

// 与服务端 production.NormalizeName 对齐，预览不能把空格或标点差异误报为新增。
const normalizeCastName = (value: string) => value.toLowerCase().replace(/[\p{White_Space}\p{P}]/gu, "");

type CastProjectImportProps = {
    projectId: string;
    episodeId?: string;
    currentCast: DramaCast[];
    kind?: DramaCast["kind"];
    disabled?: boolean;
    onClose: () => void;
    onImported: () => void;
    onStateChange?: (dirty: boolean, busy: boolean) => void;
};

export function CastProjectImport(props: CastProjectImportProps) {
    const userId = useUserStore((state) => state.user?.id);
    const accountScope = getActiveUserScope();
    const invalidated = useSyncExternalStore(subscribeUserSessionInvalidation, isUserSessionInvalidated, () => false);
    return <CastProjectImportSession key={JSON.stringify([props.projectId, props.episodeId, props.kind, userId, accountScope, invalidated])} {...props} userId={userId} accountScope={accountScope} />;
}

function CastProjectImportSession({ projectId, episodeId, currentCast, kind, disabled = false, onClose, onImported, onStateChange, userId, accountScope }: CastProjectImportProps & { userId?: string; accountScope: string }) {
    const { message } = App.useApp();
    const operation = useDramaOperationScope(projectId);
    const mutationLock = useRef(false);
    const stateCallback = useRef(onStateChange);
    stateCallback.current = onStateChange;
    const [search, setSearch] = useState("");
    const query = useDeferredValue(search.trim());
    const [sourceProjectId, setSourceProjectId] = useState("");
    const [sourceProjectName, setSourceProjectName] = useState("");
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [matchByName, setMatchByName] = useState(true);
    const [replaceExisting, setReplaceExisting] = useState(false);
    const sessionIsActive = () => Boolean(userId && accountScope === userId && useUserStore.getState().user?.id === userId && getActiveUserScope() === accountScope);
    const ownerIsActive = sessionIsActive() && operation.isCurrent(operation.capture());
    const projects = useQuery({ queryKey: ["dramas", "cast-import", userId, accountScope, projectId, query], queryFn: ({ signal }) => listDramas({ page: 1, pageSize: 100, q: query || undefined }, signal), enabled: Boolean(ownerIsActive && projectId) });
    const sourceProjects = projects.data?.items.filter((item) => item.project.id !== projectId) || [];
    const source = useQuery({
        queryKey: [...dramaKeys.cast(sourceProjectId), "cast-import", userId, accountScope, projectId],
        queryFn: ({ signal }) => listDramaCast(sourceProjectId, signal),
        enabled: Boolean(ownerIsActive && sourceProjectId && sourceProjectId !== projectId),
    });
    const bases = useMemo(() => source.data?.cast.filter((item) => item.projectId === sourceProjectId && !item.parentId && (!kind || item.kind === kind)) || [], [kind, source.data, sourceProjectId]);
    const sourceReady = Boolean(sourceProjectId && sourceProjectId !== projectId && source.isSuccess && !source.isFetching);
    const picked = sourceReady ? bases.filter((item) => selected.has(item.id)) : [];
    const targets = currentCast.filter((item) => item.projectId === projectId && (!kind || item.kind === kind));
    type ImportRequest = { ticket: ReturnType<typeof operation.capture>; payload: Parameters<typeof importDramaCast>[1] };
    const importAssets = useMutation({
        mutationFn: ({ ticket, payload }: ImportRequest) => {
            if (!sessionIsActive() || isUserSessionInvalidated() || !operation.isCurrent(ticket)) throw new Error("当前作品或账号已切换，请重新选择素材");
            return importDramaCast(ticket.projectId, payload);
        },
        onSuccess: (result, { ticket }) => {
            if (!operation.isCurrent(ticket)) return;
            onImported();
            if (result.imported) {
                message.success(`已关联 ${result.imported} 项素材${result.skipped ? `，跳过 ${result.skipped} 项` : ""}`);
                onClose();
            } else message.info("所选素材已关联或已有参考图，本次没有替换；需要替换时请勾选下方选项");
        },
        onError: (error, { ticket }) => {
            if (operation.isCurrent(ticket)) message.error(error instanceof Error ? error.message : "关联素材失败");
        },
        onSettled: () => {
            mutationLock.current = false;
        },
    });
    const blocked = disabled || importAssets.isPending || !ownerIsActive;
    useEffect(() => {
        stateCallback.current?.(picked.length > 0, importAssets.isPending);
    }, [picked.length, importAssets.isPending]);
    useEffect(() => () => stateCallback.current?.(false, false), []);
    const submit = () => {
        const ticket = operation.capture();
        if (!projectId || blocked || !sessionIsActive() || mutationLock.current || !sourceReady || !picked.length || !operation.isCurrent(ticket)) return;
        mutationLock.current = true;
        importAssets.mutate({ ticket, payload: { sourceProjectId, castIds: picked.map((item) => item.id), matchByName, replaceExisting, ...(episodeId ? { episodeId } : {}) } });
    };
    const changeSource = (id: string) => {
        if (blocked || mutationLock.current) return;
        setSourceProjectId(id);
        setSourceProjectName(projects.data?.items.find((item) => item.project.id === id)?.project.name || "");
        setSelected(new Set());
        setReplaceExisting(false);
    };
    const toggle = (id: string, checked: boolean) => {
        if (blocked || mutationLock.current || !sourceReady || !bases.some((item) => item.id === id)) return;
        setSelected((previous) => {
            const next = new Set(previous);
            if (checked) next.add(id);
            else next.delete(id);
            return next;
        });
    };
    const description = (item: DramaCast) => {
        if (targets.some((target) => target.sourceProjectId === sourceProjectId && target.sourceCastId === item.id)) return replaceExisting ? "已关联，将按来源更新设定与参考图" : "已关联，重复选择会跳过";
        const matches = matchByName ? targets.filter((target) => !target.parentId && target.kind === item.kind && normalizeCastName(target.name) === normalizeCastName(item.name)) : [];
        if (matches.length > 1) return "本作品有多个同名设定，请先区分名称";
        if (!matches.length) return "作为新设定加入";
        if (matches[0].imageResourceId && !replaceExisting) return "保留本作品已有参考图";
        return replaceExisting && matches[0].imageResourceId ? "替换同名设定参考图，旧图保留版本" : "补全本作品同名设定";
    };
    return (
        <AppModal
            open
            title={kind ? `从${CAST_KIND_LABEL[kind]}库导入` : "关联已有作品素材"}
            rootClassName="drama-root"
            width={720}
            onCancel={() => !importAssets.isPending && !mutationLock.current && onClose()}
            onOk={submit}
            okText={kind ? `导入 ${picked.length} 个${CAST_KIND_LABEL[kind]}` : `关联 ${picked.length} 个设定`}
            cancelText="取消"
            confirmLoading={importAssets.isPending}
            okButtonProps={{ disabled: blocked || !picked.length || !sourceReady }}
            cancelButtonProps={{ disabled: importAssets.isPending }}
            maskClosable={!importAssets.isPending}
            closable={!importAssets.isPending}
            keyboard={!importAssets.isPending}
        >
            <div className="drama-cast-form">
                <p className="drama-editor-note">
                    {kind
                        ? `从其他作品选择${CAST_KIND_LABEL[kind]}导入${episodeId ? "当前集" : "当前作品"}。参考图直接复用，不重新生成；导入后可独立编辑，来源作品保持不变。`
                        : "选择第一季或其他作品的角色、场景、道具；角色造型会一并带入。参考图直接复用，不重新生成。新作品可独立编辑，原作品保持不变。"}
                </p>
                <Select
                    aria-label="素材来源作品"
                    placeholder="选择来源作品，可输入作品名搜索"
                    showSearch
                    filterOption={false}
                    onSearch={(value) => !blocked && !mutationLock.current && setSearch(value)}
                    value={sourceProjectId || undefined}
                    onChange={changeSource}
                    loading={projects.isFetching}
                    disabled={blocked}
                    options={sourceProjects.map((item) => ({ value: item.project.id, label: item.project.name }))}
                />
                {projects.isError ? (
                    <p role="alert">
                        读取作品失败。
                        <Button size="small" disabled={blocked} onClick={() => !mutationLock.current && void projects.refetch()}>
                            重试
                        </Button>
                    </p>
                ) : null}
                {projects.isSuccess && !projects.isFetching && !sourceProjects.length ? <small className="drama-editor-note">{query ? "未找到匹配作品" : "暂无其他可导入的作品"}</small> : null}
                {projects.data?.hasMore ? <small className="drama-editor-note">作品较多，请输入名称缩小范围。</small> : null}
                {sourceProjectId ? (
                    <>
                        <small className="drama-editor-note">来源作品：{sourceProjectName || sourceProjectId}</small>
                        {source.isPending ? (
                            <p role="status">正在读取来源作品素材…</p>
                        ) : source.isError ? (
                            <p role="alert">
                                读取素材失败。
                                <Button size="small" disabled={blocked} onClick={() => !mutationLock.current && void source.refetch()}>
                                    重试
                                </Button>
                            </p>
                        ) : (
                            <>
                                <div className="drama-editor-row">
                                    <span>
                                        {bases.length} 个{kind ? CAST_KIND_LABEL[kind] : "基础设定"}
                                    </span>
                                    <Button
                                        size="small"
                                        disabled={blocked || !sourceReady || !bases.length}
                                        onClick={() => {
                                            if (!blocked && !mutationLock.current && sourceReady) setSelected(picked.length === bases.length ? new Set() : new Set(bases.map((item) => item.id)));
                                        }}
                                    >
                                        {picked.length === bases.length && bases.length ? "取消全选" : "全选"}
                                    </Button>
                                </div>
                                <div className="drama-cast-import-list thin-scrollbar" role="group" aria-label="选择要关联的素材">
                                    {bases.map((item) => {
                                        const lookCount = source.data?.cast.filter((look) => look.parentId === item.id).length || 0;
                                        return (
                                            <div key={item.id} className="drama-cast-import-item">
                                                <Checkbox aria-label={`关联${item.name}`} checked={selected.has(item.id)} disabled={blocked || !sourceReady} onChange={(event) => toggle(item.id, event.target.checked)} />
                                                <span className="drama-cast-import-thumb">{item.imageResourceId ? <MediaThumb resourceId={item.imageResourceId} alt={item.name} /> : <Link2 className="size-5 opacity-40" />}</span>
                                                <span className="drama-cast-import-description">
                                                    <strong>
                                                        {item.name}{" "}
                                                        <small>
                                                            {CAST_KIND_LABEL[item.kind]}
                                                            {lookCount ? ` · ${lookCount} 套造型` : ""}
                                                        </small>
                                                    </strong>
                                                    <small>{description(item)}</small>
                                                </span>
                                            </div>
                                        );
                                    })}
                                    {!bases.length ? <p className="drama-editor-note">{kind ? `此作品还没有可导入的${CAST_KIND_LABEL[kind]}。` : "此作品还没有可关联的设定。"}</p> : null}
                                </div>
                            </>
                        )}
                    </>
                ) : null}
                <Checkbox
                    checked={matchByName}
                    disabled={blocked}
                    onChange={(event) => {
                        if (blocked || mutationLock.current) return;
                        setMatchByName(event.target.checked);
                        setReplaceExisting(false);
                    }}
                >
                    匹配本作品中同类型、同名称的设定，缺少的设定新增
                </Checkbox>
                <Checkbox
                    checked={replaceExisting}
                    disabled={!matchByName || blocked}
                    onChange={(event) => {
                        if (!blocked && !mutationLock.current) setReplaceExisting(event.target.checked);
                    }}
                >
                    替换同名设定已有的参考图，旧图保留在版本记录中
                </Checkbox>
                <p className="drama-editor-note">{!kind || kind === "character" ? "造型的适用章节会重置，请按本季剧情重新设置。" : ""}导入不会自动启动生成；重复关联同一来源素材不会创建副本。</p>
            </div>
        </AppModal>
    );
}
