import { Button } from "antd";
import { useState } from "react";
import { Callout } from "@/components/ui/product/callout";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { exportCanvasSyncConflictDraftAndResume, hasCanvasSyncConflictDraft } from "@/services/user-data-sync";
import { useSyncProgressStore } from "@/stores/use-sync-progress-store";

export function CanvasSyncConflict({ projectId }: { projectId: string }) {
    const progress = useSyncProgressStore((state) => state.syncingProjects[projectId]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    if (progress?.errorKind !== "conflict" || !hasCanvasSyncConflictDraft(projectId)) return null;

    const exportAndResume = async () => {
        setBusy(true);
        setError("");
        try {
            await exportCanvasSyncConflictDraftAndResume(projectId, (draft, additionalDrafts) => exportCanvasProjects([draft, ...additionalDrafts], `${draft.title}-本地冲突草稿`, { allowProjectVersions: true }));
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : "草稿导出失败，已保留本地内容");
        } finally {
            setBusy(false);
        }
    };

    return (
        <Callout tone="warning" title="本地草稿需要保留" role="status">
            <div className="flex max-w-sm flex-col gap-3" data-canvas-no-zoom>
                <p>当前显示云端版本，自动保存已暂停。导出保留的本地草稿后，可继续编辑；草稿可从画布库导入。</p>
                <Button loading={busy} onClick={() => void exportAndResume()}>
                    导出保留草稿并继续编辑
                </Button>
                {error ? <p role="alert">{error}</p> : null}
            </div>
        </Callout>
    );
}
