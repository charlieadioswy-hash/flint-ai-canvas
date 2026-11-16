import { useEffect, useRef, useState, type ReactNode } from "react";
import { App, Button } from "antd";
import { ArrowLeft, BookUser, X } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import type { DramaCast, DramaSummary } from "@/services/api/drama";
import { CAST_KIND_LABEL } from "../drama-shared";
import { WorkflowCastAssistance } from "../workflow-cast-assistance";
import { WorkflowCharacterLibrary } from "../workflow-character-library";
import { CastEditor } from "./panels";
import { useOpenDramaCanvas } from "./use-studio";
import "./cast-editor-dialog.css";

export type CastEditorDialogProps = {
    summary: DramaSummary;
    cast: DramaCast[];
    castId?: string;
    episodeId?: string;
    onClose: () => void;
    onChanged: () => void;
    children?: ReactNode;
    onDirtyChange?: (dirty: boolean, busy: boolean) => void;
};

/** 与原设定页共用编辑器，关闭或切换作品、设定后销毁本次表单。 */
export function CastEditorDialog(props: CastEditorDialogProps) {
    return props.castId ? <CastEditorDialogSession key={`${props.summary.project.id}:${props.episodeId || ""}:${props.castId}`} {...props} /> : null;
}

function CastEditorDialogSession({ summary, cast, castId, episodeId, onClose, onChanged, children, onDirtyChange }: CastEditorDialogProps) {
    const { modal, message } = App.useApp();
    const [editorState, setEditorState] = useState({ dirty: false, busy: false });
    const [infoState, setInfoState] = useState({ dirty: false, busy: false });
    const dirty = editorState.dirty || infoState.dirty;
    const busy = editorState.busy || infoState.busy;
    const stateChange = useRef(onDirtyChange);
    stateChange.current = onDirtyChange;
    useEffect(() => {
        stateChange.current?.(dirty, busy);
    }, [dirty, busy]);
    useEffect(() => () => stateChange.current?.(false, false), []);
    const projectId = summary.project.id;
    const current = cast.find((item) => item.id === castId && item.projectId === projectId);
    const canvas = useOpenDramaCanvas(summary);
    const kindLabel = current ? (current.parentId ? "造型" : CAST_KIND_LABEL[current.kind]) : "资产";
    const title = current ? `${current.lookName || current.name} · ${kindLabel}设定` : "资产设定";
    const requestClose = () => {
        if (busy) {
            message.info("正在保存，请完成后再关闭");
            return;
        }
        if (!dirty) {
            onClose();
            return;
        }
        modal.confirm({
            title: "关闭并放弃未保存的修改？",
            content: "部分修改尚未自动保存。关闭将放弃这些修改，已保存的资产与图片会保留。",
            okText: "放弃修改并关闭",
            cancelText: "继续编辑",
            okButtonProps: { danger: true },
            focusable: { autoFocusButton: "cancel" },
            onOk: onClose,
        });
    };
    return (
        <AppModal open onCancel={requestClose} mask={{ closable: !busy }} keyboard={!busy} footer={null} title={title} classNames={{ header: "sr-only" }} closable={false} flush width="100vw" rootClassName="drama-root drama-cast-workspace-modal">
            <WorkflowCharacterLibrary
                summary={summary}
                cast={cast}
                busy={editorState.busy}
                onChanged={onChanged}
                onDirtyChange={(dirty, busy) => setInfoState((previous) => (previous.dirty === dirty && previous.busy === busy ? previous : { dirty, busy }))}
            >
                {({ showInfo }) => (
                    <section className="drama-cast-dialog">
                        <header className="drama-cast-dialog-head">
                            <Button type="text" icon={<ArrowLeft className="size-4" />} disabled={busy} onClick={requestClose}>
                                返回
                            </Button>
                            <h2>{title}</h2>
                            {busy || dirty ? (
                                <span className="drama-cast-dialog-save-state" role="status">
                                    {busy ? "正在处理…" : "有未保存的修改"}
                                </span>
                            ) : null}
                            <Button type="text" icon={<X className="size-4" />} disabled={busy} aria-label="关闭资产设定" onClick={requestClose} />
                        </header>
                        <div className="drama-cast-dialog-body thin-scrollbar">
                            {current ? (
                                <CastEditor
                                    projectId={projectId}
                                    episodeId={episodeId}
                                    cast={current}
                                    parent={current.parentId ? cast.find((item) => item.id === current.parentId && item.projectId === projectId) : undefined}
                                    looks={cast.filter((item) => item.parentId === current.id && item.projectId === projectId)}
                                    ratios={{ character: summary.production.settings.assets.characterRatio }}
                                    onChanged={onChanged}
                                    onOpenCanvas={() => void canvas.open({ kind: "cast", castId: current.id })}
                                    canvasOpening={canvas.opening === `cast:${current.id}`}
                                    layout="workspace"
                                    onDirtyChange={(dirty, busy) => setEditorState((previous) => (previous.dirty === dirty && previous.busy === busy ? previous : { dirty, busy }))}
                                    tools={
                                        <>
                                            <WorkflowCastAssistance summary={summary} cast={current} onChanged={onChanged} disabled={busy}>
                                                {!current.parentId ? (
                                                    <Button size="small" icon={<BookUser className="size-3.5" />} disabled={busy} onClick={() => showInfo(current)}>
                                                        {current.kind === "character" ? "人物" : CAST_KIND_LABEL[current.kind]}信息与出镜
                                                    </Button>
                                                ) : null}
                                            </WorkflowCastAssistance>
                                            {children}
                                        </>
                                    }
                                />
                            ) : (
                                <div className="drama-empty is-compact" role="status">
                                    此资产已不存在或暂时无法读取，请关闭后刷新分镜。
                                </div>
                            )}
                        </div>
                    </section>
                )}
            </WorkflowCharacterLibrary>
        </AppModal>
    );
}
