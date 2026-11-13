import type { ReactNode } from "react";
import { Button } from "antd";
import { X } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import type { DramaCast, DramaSummary } from "@/services/api/drama";
import { CAST_KIND_LABEL } from "../drama-shared";
import { WorkflowCastAssistance } from "../workflow-cast-assistance";
import { CastEditor, castEditorFormKey } from "./panels";
import { useOpenDramaCanvas } from "./use-studio";
import "./cast-editor-dialog.css";

export type CastEditorDialogProps = {
    summary: DramaSummary;
    cast: DramaCast[];
    castId?: string;
    onClose: () => void;
    onChanged: () => void;
    children?: ReactNode;
};

/** 与原设定页共用编辑器，关闭或切换作品、设定后销毁本次表单。 */
export function CastEditorDialog(props: CastEditorDialogProps) {
    return props.castId ? <CastEditorDialogSession key={`${props.summary.project.id}:${props.castId}`} {...props} /> : null;
}

function CastEditorDialogSession({ summary, cast, castId, onClose, onChanged, children }: CastEditorDialogProps) {
    const projectId = summary.project.id;
    const current = cast.find((item) => item.id === castId && item.projectId === projectId);
    const canvas = useOpenDramaCanvas(summary);
    const kindLabel = current ? (current.parentId ? "造型" : CAST_KIND_LABEL[current.kind]) : "资产";
    const title = current ? `${current.lookName || current.name} · ${kindLabel}设定` : "资产设定";
    return (
        <AppModal open onCancel={onClose} footer={null} title={title} classNames={{ header: "sr-only" }} closable={false} flush centered width="min(640px, calc(100vw - 32px))" rootClassName="drama-root">
            <section className="drama-cast-dialog">
                <header className="drama-cast-dialog-head">
                    <h2>{title}</h2>
                    <Button type="text" icon={<X className="size-4" />} aria-label="关闭资产设定" onClick={onClose} />
                </header>
                <div className="drama-cast-dialog-body thin-scrollbar">
                    {current ? <WorkflowCastAssistance summary={summary} cast={current} onChanged={onChanged} /> : null}
                    {current ? children : null}
                    {current ? (
                        <CastEditor
                            key={castEditorFormKey(current)}
                            projectId={projectId}
                            cast={current}
                            parent={current.parentId ? cast.find((item) => item.id === current.parentId && item.projectId === projectId) : undefined}
                            looks={cast.filter((item) => item.parentId === current.id && item.projectId === projectId)}
                            ratios={{ character: summary.production.settings.assets.characterRatio }}
                            onChanged={onChanged}
                            onOpenCanvas={() => void canvas.open({ kind: "cast", castId: current.id })}
                            canvasOpening={canvas.opening === `cast:${current.id}`}
                        />
                    ) : (
                        <div className="drama-empty is-compact" role="status">
                            此资产已不存在或暂时无法读取，请关闭后刷新分镜。
                        </div>
                    )}
                </div>
            </section>
        </AppModal>
    );
}
