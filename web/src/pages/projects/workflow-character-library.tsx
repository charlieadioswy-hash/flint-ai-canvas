import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Input } from "antd";
import { BookUser } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal/app-modal";
import { getActiveUserScope } from "@/lib/user-scope";
import { getDramaCharacterUsage, importDramaCharacterLibrary, saveDramaCharacterLibrary, updateDramaCharacterDefinition } from "@/services/api/drama-character-library";
import type { DramaCast, DramaSummary } from "@/services/api/drama";
import { listCharacters, type CharacterRepresentation, type ProjectCharacterDetail } from "@/services/api/projects";
import { useUserStore } from "@/stores/use-user-store";

import { useResourceMediaUrl } from "./drama-shared";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import { CHARACTER_FIELDS, changedCharacterFields, characterFieldValues, parseCharacterDefinition } from "./workflow-character-definition";
import "./workflow-character-library.css";

type Props = {
    summary: DramaSummary;
    cast: DramaCast[];
    busy?: boolean;
    onChanged: () => void;
    onDirtyChange?: (dirty: boolean, busy: boolean) => void;
};
type Dialog = { mode: "import" | "info" | "save"; revision: number; target?: DramaCast };
const ROLE_LABELS: Record<string, string> = { primary: "主形象", front: "正面", side: "侧面", back: "背面", turnaround_sheet: "三视图", expression_sheet: "表情图" };

function CharacterImage({ resourceId, label }: { resourceId?: string; label: string }) {
    const url = useResourceMediaUrl(resourceId);
    return url ? <img src={url} alt={label} loading="lazy" /> : <span className="drama-character-no-image">{resourceId ? "图片读取中" : "暂无形象"}</span>;
}

function CharacterAudio({ resourceId }: { resourceId?: string }) {
    const url = useResourceMediaUrl(resourceId);
    return resourceId ? url ? <audio controls preload="none" src={url} aria-label="角色声音样本" /> : <p>正在读取声音样本</p> : <p>此声音没有样本音频，仅复用已绑定的声音档案。</p>;
}

export function WorkflowCharacterLibrary(props: Props) {
    const userId = useUserStore((state) => state.user?.id || "");
    return <CharacterLibrarySession key={JSON.stringify([userId, getActiveUserScope(), props.summary.project.id])} {...props} userId={userId} />;
}

function CharacterLibrarySession({ summary, cast, busy = false, onChanged, onDirtyChange, userId }: Props & { userId: string }) {
    const { modal } = App.useApp();
    const operation = useDramaOperationScope(summary.project.id);
    const [selectedId, setSelectedId] = useState("");
    const [dialog, setDialog] = useState<Dialog>();
    const [dialogState, setDialogState] = useState({ dirty: false, busy: false });
    const dialogStateRef = useRef(dialogState);
    const latest = useRef({ onChanged, onDirtyChange });
    latest.current = { onChanged, onDirtyChange };
    const characters = cast.filter((item) => item.projectId === summary.project.id && item.kind === "character" && !item.parentId);
    const selected = characters.find((item) => item.id === selectedId);

    useEffect(() => {
        latest.current.onDirtyChange?.(dialogState.dirty, dialogState.busy);
    }, [dialogState]);
    useEffect(() => () => latest.current.onDirtyChange?.(false, false), []);

    const open = (mode: Dialog["mode"]) => {
        const ticket = operation.capture();
        if (busy || !userId || !operation.isCurrent(ticket) || getActiveUserScope() !== userId) return;
        setDialog({ mode, revision: summary.production.revision, target: selected });
    };
    const close = () => {
        if (dialogStateRef.current.busy) return;
        const ticket = operation.capture();
        const dismiss = () => {
            if (!operation.isCurrent(ticket)) return;
            setDialog(undefined);
            dialogStateRef.current = { dirty: false, busy: false };
            setDialogState({ dirty: false, busy: false });
        };
        if (dialogStateRef.current.dirty) {
            modal.confirm({ title: "放弃当前人物信息修改？", content: "尚未提交的选择和修改会丢弃。", okText: "放弃修改", cancelText: "继续编辑", onOk: dismiss });
        } else dismiss();
    };

    return (
        <section className="drama-character-library-tools" aria-label="人物信息与角色库">
            <BookUser className="size-4" aria-hidden="true" />
            <label>
                <span className="sr-only">选择要查看的人物</span>
                <select aria-label="选择要查看的人物" value={selected ? selectedId : ""} disabled={busy || dialogState.busy} onChange={(event) => setSelectedId(event.target.value)}>
                    <option value="">选择人物</option>
                    {characters.map((item) => (
                        <option key={item.id} value={item.id}>
                            {item.name}
                        </option>
                    ))}
                </select>
            </label>
            <Button disabled={busy || dialogState.busy || !selected} onClick={() => open("info")}>
                人物信息与出镜
            </Button>
            <Button disabled={busy || dialogState.busy || !selected} onClick={() => open("save")}>
                另存到角色库
            </Button>
            <Button disabled={busy || dialogState.busy} onClick={() => open("import")}>
                从角色库导入
            </Button>
            {dialog ? (
                <AppModal flush open title={null} footer={null} closable={false} width={920} onCancel={close} maskClosable={!dialogState.busy} keyboard={!dialogState.busy}>
                    <CharacterDialog
                        key={`${dialog.mode}:${dialog.target?.id || "new"}:${dialog.revision}`}
                        summary={summary}
                        cast={characters}
                        draft={dialog}
                        busy={busy}
                        userId={userId}
                        onClose={close}
                        onState={(state) => {
                            dialogStateRef.current = state;
                            setDialogState(state);
                        }}
                        onChanged={() => {
                            setDialog(undefined);
                            dialogStateRef.current = { dirty: false, busy: false };
                            setDialogState({ dirty: false, busy: false });
                            latest.current.onChanged();
                        }}
                    />
                </AppModal>
            ) : null}
        </section>
    );
}

function CharacterDialog({
    summary,
    cast,
    draft,
    busy,
    userId,
    onClose,
    onState,
    onChanged,
}: {
    summary: DramaSummary;
    cast: DramaCast[];
    draft: Dialog;
    busy: boolean;
    userId: string;
    onClose: () => void;
    onState: (state: { dirty: boolean; busy: boolean }) => void;
    onChanged: () => void;
}) {
    const { message, modal } = App.useApp();
    const projectId = summary.project.id;
    const operation = useDramaOperationScope(projectId);
    const [target, setTarget] = useState(draft.target);
    const [page, setPage] = useState(1);
    const [search, setSearch] = useState("");
    const [query, setQuery] = useState("");
    const [library, setLibrary] = useState<ProjectCharacterDetail>();
    const [representationId, setRepresentationId] = useState("");
    const [includeVoice, setIncludeVoice] = useState(false);
    const [replaceText, setReplaceText] = useState(false);
    const [name, setName] = useState(target?.name || "");
    const [pending, setPending] = useState(false);
    const [failure, setFailure] = useState("");
    const lock = useRef(false);
    const latest = useRef({ summary, cast, busy, onState, onChanged, onClose });
    latest.current = { summary, cast, busy, onState, onChanged, onClose };
    let definition: Record<string, unknown> = {};
    let definitionError = "";
    try {
        definition = parseCharacterDefinition(draft.target?.definitionJson);
    } catch (error) {
        definitionError = error instanceof Error ? error.message : "人物定义读取失败";
    }
    const baseline = characterFieldValues(definition, draft.target?.role || "");
    const [fields, setFields] = useState<Record<string, string>>(baseline);
    const changes = changedCharacterFields(baseline, fields);
    const dirty = draft.mode === "info" ? Object.keys(changes).length > 0 : draft.mode === "save" ? name !== target?.name : Boolean(library);
    const currentTarget = target ? cast.find((item) => item.id === target.id) : undefined;
    const stale = draft.revision !== summary.production.revision || Boolean(target && (!currentTarget || currentTarget.revision !== target.revision));
    const ownerIsActive = Boolean(userId && userId === getActiveUserScope());
    const disabled = busy || pending || stale || !ownerIsActive;
    const renderTicket = operation.capture();
    const list = useQuery({
        queryKey: ["drama-character-library", userId, getActiveUserScope(), projectId, page, query],
        queryFn: () => listCharacters({ page, pageSize: 12, query }),
        enabled: draft.mode === "import" && ownerIsActive,
    });
    const usage = useQuery({
        queryKey: ["drama-character-usage", userId, getActiveUserScope(), projectId, draft.target?.id, summary.production.revision],
        queryFn: ({ signal }) => getDramaCharacterUsage(projectId, draft.target!.id, signal),
        enabled: draft.mode === "info" && Boolean(draft.target) && ownerIsActive,
    });

    useEffect(() => {
        latest.current.onState({ dirty, busy: pending });
    }, [dirty, pending]);
    const choose = (card: ProjectCharacterDetail) => {
        if (disabled || !operation.isCurrent(renderTicket)) return;
        setLibrary(card);
        setRepresentationId("");
        setIncludeVoice(false);
        setReplaceText(false);
        setFailure("");
    };
    const write = async () => {
        if (disabled || lock.current || definitionError || !operation.isCurrent(renderTicket)) return;
        const ticket = operation.capture();
        const current = latest.current;
        if (current.busy || current.summary.production.revision !== draft.revision || (target && current.cast.find((row) => row.id === target.id)?.revision !== target.revision)) return;
        if (target && target.revision == null) {
            setFailure("人物版本暂不可用，请刷新作品后重试。");
            return;
        }
        lock.current = true;
        latest.current.onState({ dirty, busy: true });
        setPending(true);
        setFailure("");
        try {
            if (draft.mode === "import") {
                if (!library) throw new Error("请先选择角色库中的角色");
                await importDramaCharacterLibrary(ticket.projectId, {
                    expectedRevision: draft.revision,
                    libraryAssetId: library.asset.id,
                    libraryVersionId: library.character.versionId,
                    targetCastId: target?.id,
                    expectedCastRevision: target?.revision,
                    replaceText: Boolean(target && replaceText),
                    ...(representationId ? { representationId } : {}),
                    includeVoice,
                });
            } else if (draft.mode === "save") {
                if (!target || !name.trim()) throw new Error("请填写角色库名称");
                await saveDramaCharacterLibrary(ticket.projectId, target.id, { expectedRevision: draft.revision, expectedCastRevision: target.revision!, name: name.trim() });
            } else {
                if (!target || !Object.keys(changes).length) return;
                await updateDramaCharacterDefinition(ticket.projectId, target.id, { expectedRevision: draft.revision, expectedCastRevision: target.revision!, fields: changes });
            }
            if (!operation.isCurrent(ticket)) return;
            message.success(draft.mode === "import" ? "已导入角色设定，不会自动生成图片或视频" : draft.mode === "save" ? "已另存为新的个人角色卡" : "已保存人物信息");
            latest.current.onChanged();
        } catch (error) {
            if (operation.isCurrent(ticket)) setFailure(error instanceof Error ? error.message : "保存失败，请刷新后重试");
        } finally {
            lock.current = false;
            if (operation.isCurrent(ticket)) setPending(false);
        }
    };
    const submit = () => {
        if (disabled || lock.current) return;
        if (draft.mode === "import" && target && replaceText) {
            const ticket = operation.capture();
            modal.confirm({
                title: `替换「${target.name}」的文字设定？`,
                content: "采用所选角色库版本的文字，保留目标角色名称。当前剧本中的原有文字将被替换。",
                okText: "确认替换并导入",
                cancelText: "保留当前文字",
                onOk: () => {
                    if (operation.isCurrent(ticket)) return write();
                },
            });
        } else void write();
    };

    if (!ownerIsActive) {
        return (
            <div className="drama-character-dialog">
                <header>
                    <h2>人物信息</h2>
                    <Button onClick={onClose}>关闭</Button>
                </header>
                <div className="drama-character-dialog-body">
                    <p role="alert">登录状态已变化，请关闭后重新打开。</p>
                </div>
            </div>
        );
    }

    return (
        <div className="drama-character-dialog" aria-label={draft.mode === "import" ? "导入个人角色" : draft.mode === "save" ? "另存新角色" : "人物信息与出镜"}>
            <header>
                <div>
                    <h2>{draft.mode === "import" ? "从个人角色库导入" : draft.mode === "save" ? "另存到个人角色库" : `${draft.target?.name} · 人物信息`}</h2>
                    <p>复用已保存的设定和媒体，后续修改各自独立。</p>
                </div>
                <Button disabled={pending} onClick={onClose}>
                    关闭
                </Button>
            </header>
            <div className="drama-character-dialog-body">
                {!ownerIsActive ? <p role="alert">登录状态已变化，请关闭后重新打开。</p> : null}
                {stale ? <p role="alert">作品或人物已有更新，当前选择和修改已保留。请关闭并重新打开后再提交。</p> : null}
                {failure ? <p role="alert">{failure}</p> : null}
                {draft.mode === "import" ? (
                    <>
                        <label className="drama-character-field">
                            导入目标
                            <select
                                aria-label="导入目标"
                                disabled={disabled}
                                value={target?.id || ""}
                                onChange={(event) => {
                                    setTarget(cast.find((item) => item.id === event.target.value));
                                    setReplaceText(false);
                                }}
                            >
                                <option value="">新增为本作品角色</option>
                                {cast.map((item) => (
                                    <option key={item.id} value={item.id}>
                                        {item.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <form
                            className="drama-character-search"
                            onSubmit={(event) => {
                                event.preventDefault();
                                if (!disabled) {
                                    setPage(1);
                                    setQuery(search.trim());
                                }
                            }}
                        >
                            <Input aria-label="搜索个人角色" value={search} disabled={disabled} onChange={(event) => setSearch(event.target.value)} />
                            <Button htmlType="submit" disabled={disabled}>
                                搜索
                            </Button>
                            <Button disabled={disabled || list.isFetching} onClick={() => void list.refetch()}>
                                刷新角色库
                            </Button>
                        </form>
                        {list.isPending ? (
                            <p role="status">正在读取个人角色库</p>
                        ) : list.isError ? (
                            <p role="alert">角色库读取失败，请刷新重试。</p>
                        ) : !list.data?.characters.length ? (
                            <p>个人角色库中没有匹配的人物。可先将作品中的人物另存到角色库。</p>
                        ) : null}
                        <div className="drama-character-library-grid" role="group" aria-label="个人角色列表">
                            {list.data?.characters.map((card) => {
                                const image = card.character.representations.find((item) => item.mediaType === "image");
                                return (
                                    <button key={card.asset.id} type="button" disabled={disabled} aria-pressed={library?.asset.id === card.asset.id && library.character.versionId === card.character.versionId} onClick={() => choose(card)}>
                                        <CharacterImage resourceId={image?.resourceId} label={card.asset.title} />
                                        <strong>{card.asset.title}</strong>
                                        <small>
                                            版本 {card.character.version} · {card.character.voice ? "已绑定声音" : "未绑定声音"}
                                        </small>
                                    </button>
                                );
                            })}
                        </div>
                        {list.data ? (
                            <div className="drama-character-pagination">
                                <Button disabled={disabled || page <= 1 || list.isFetching} onClick={() => setPage((value) => value - 1)}>
                                    上一页
                                </Button>
                                <span>
                                    第 {page} 页 · 共 {list.data.total} 个
                                </span>
                                <Button disabled={disabled || !list.data.hasMore || list.isFetching} onClick={() => setPage((value) => value + 1)}>
                                    下一页
                                </Button>
                            </div>
                        ) : null}
                        {library ? (
                            <section className="drama-character-library-preview" aria-label="所选角色预览">
                                <h3>
                                    {library.asset.title} · 版本 {library.character.version}
                                </h3>
                                <pre>
                                    {typeof library.character.definition.sourceDefinition === "string"
                                        ? library.character.definition.sourceDefinition
                                        : typeof library.character.definition.description === "string"
                                          ? library.character.definition.description
                                          : "此角色没有文字说明"}
                                </pre>
                                <details>
                                    <summary>完整角色库定义</summary>
                                    <pre>{JSON.stringify(library.character.definition, null, 2)}</pre>
                                </details>
                                <fieldset disabled={disabled}>
                                    <legend>采用形象</legend>
                                    <label>
                                        <input type="radio" name="character-representation" checked={!representationId} onChange={() => setRepresentationId("")} />
                                        {target ? "保留当前形象" : "暂不采用形象"}
                                    </label>
                                    <div className="drama-character-representations">
                                        {library.character.representations
                                            .filter((item) => item.mediaType === "image")
                                            .map((item: CharacterRepresentation) => (
                                                <label key={item.id}>
                                                    <input type="radio" name="character-representation" checked={representationId === item.id} onChange={() => setRepresentationId(item.id)} />
                                                    <CharacterImage resourceId={item.resourceId} label={ROLE_LABELS[item.role] || item.role} />
                                                    <span>{ROLE_LABELS[item.role] || item.role}</span>
                                                </label>
                                            ))}
                                    </div>
                                </fieldset>
                                {library.character.voice ? (
                                    <div>
                                        <label>
                                            <input type="checkbox" checked={includeVoice} disabled={disabled} onChange={(event) => setIncludeVoice(event.target.checked)} />
                                            采用声音「{library.character.voice.profile.name}」
                                        </label>
                                        <CharacterAudio resourceId={library.character.voice.profile.sampleResourceId} />
                                    </div>
                                ) : (
                                    <p>这个角色尚未绑定声音。</p>
                                )}
                                {target ? (
                                    <label>
                                        <input type="checkbox" checked={replaceText} disabled={disabled} onChange={(event) => setReplaceText(event.target.checked)} />
                                        替换当前人物文字设定（保留人物名称）
                                    </label>
                                ) : null}
                                <p>{target && !replaceText ? "默认保留当前人物的名称、外观、说明、声线和原文定义，只补充库中扩展信息及明确选用的媒体。" : "按所选角色库版本复制文字；不会自动生成图片或视频。"}</p>
                            </section>
                        ) : null}
                    </>
                ) : draft.mode === "save" ? (
                    <>
                        <label className="drama-character-field">
                            角色库名称
                            <Input aria-label="角色库名称" value={name} maxLength={60} disabled={disabled} onChange={(event) => setName(event.target.value)} />
                        </label>
                        <p>将当前人物的完整定义、当前形象和已绑定声音保存为一张新的个人角色卡。原角色库卡片不会被覆盖。</p>
                        <CharacterImage resourceId={target?.imageResourceId} label={target?.name || "当前人物"} />
                        <p>{target?.description || "暂无文字说明"}</p>
                    </>
                ) : (
                    <>
                        {definitionError ? <p role="alert">{definitionError}</p> : null}
                        <section aria-label="当前人物说明">
                            <h3>当前人物说明</h3>
                            <p>{draft.target?.description || "暂无说明"}</p>
                            <p>外观：{draft.target?.appearance || "未填写"}</p>
                            <p>声线：{draft.target?.voiceInstructions || "未填写"}</p>
                            <p>简介、外观和声线仍可从资产卡片的设定编辑入口调整。</p>
                        </section>
                        <section className="drama-character-structured" aria-label="结构化人物信息">
                            {CHARACTER_FIELDS.map(([key, label]) => (
                                <label className="drama-character-field" key={key}>
                                    {label}
                                    <Input.TextArea
                                        aria-label={label}
                                        rows={key === "background" || key.endsWith("Prompt") ? 3 : 1}
                                        disabled={disabled || Boolean(definitionError)}
                                        value={fields[key]}
                                        onChange={(event) => setFields((previous) => ({ ...previous, [key]: event.target.value }))}
                                    />
                                </label>
                            ))}
                        </section>
                        <section aria-label="人物原文定义">
                            <h3>原文定义</h3>
                            <pre>{typeof definition.sourceDefinition === "string" && definition.sourceDefinition ? definition.sourceDefinition : "未保存独立的原文定义。现有说明仍保留在资产设定中。"}</pre>
                            <p>原文保持完整，不随结构化信息编辑而改写。</p>
                        </section>
                        <details>
                            <summary>其他已保存信息</summary>
                            <pre>{JSON.stringify(definition, null, 2)}</pre>
                        </details>
                        <section aria-label="真实出镜与引用">
                            <h3>出镜与引用</h3>
                            {usage.isPending ? (
                                <p role="status">正在读取分镜引用</p>
                            ) : usage.isError ? (
                                <p role="alert">
                                    出镜信息读取失败。<Button onClick={() => void usage.refetch()}>重试</Button>
                                </p>
                            ) : usage.data ? (
                                <>
                                    {!usage.data.hasStory ? (
                                        <p>尚未生成分镜，不根据正文推断出镜。</p>
                                    ) : (
                                        <p>
                                            实际出镜 {usage.data.appearances.length} 镜；显式参考图引用 {usage.data.imageReferences.length} 段；显式音频引用 {usage.data.audioReferences.length} 段。
                                        </p>
                                    )}
                                    <ul>
                                        {usage.data.appearances.map((item) => (
                                            <li key={item.shotId}>
                                                第 {item.episodeNumber} 集 · 第 {item.segmentIndex + 1} 段 · 镜头 {item.position + 1}
                                            </li>
                                        ))}
                                    </ul>
                                    {usage.data.audioReferences.length ? <p>音频引用：{usage.data.audioReferences.map((item) => `第 ${item.episodeNumber} 集第 ${item.segmentIndex + 1} 段`).join("、")}（不计入出镜）</p> : null}
                                </>
                            ) : null}
                        </section>
                    </>
                )}
            </div>
            <footer>
                <p>保存仅影响设定，不自动重写分镜或重新生成媒体。</p>
                <Button disabled={pending} onClick={onClose}>
                    取消
                </Button>
                <Button type="primary" loading={pending} disabled={disabled || Boolean(definitionError) || (draft.mode === "import" ? !library : draft.mode === "save" ? !name.trim() : !Object.keys(changes).length)} onClick={submit}>
                    {draft.mode === "import" ? "确认导入" : draft.mode === "save" ? "另存新角色" : "保存人物信息"}
                </Button>
            </footer>
        </div>
    );
}
