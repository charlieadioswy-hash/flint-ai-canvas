import { useEffect, useState } from "react";
import { ScreenCreationWorkspace } from "./screen-creation-workspace";
import { useScreenCreation } from "./use-screen-creation";
import { Navigate, useLocation, useParams, useSearchParams } from "react-router";
import { PageHeader, WorkspacePage } from "@/components/layout/workspace-page";
import { WorkspaceErrorState, WorkspaceLoadingState } from "@/components/layout/workspace-state";
import { useUserStore } from "@/stores/use-user-store";
import { loadScreenCreationEntry } from "./screen-creation-session";
import { useScreenCreationScenes } from "./use-screen-creation-scenes";

export default function ScreenCreationPage() {
    const { canvasId } = useParams();
    const location = useLocation();
    const [searchParams] = useSearchParams();
    const userId = useUserStore((state) => state.user?.id);
    return <ScreenCreationEntry key={`${userId || "guest"}:${location.key}`} canvasId={canvasId} newScene={searchParams.get("new") === "1"} />;
}

function ScreenCreationEntry({ canvasId, newScene }: { canvasId?: string; newScene: boolean }) {
    const library = useScreenCreationScenes();
    const [entry, setEntry] = useState<{ canvasId?: string } | null>(null);
    const [entryError, setEntryError] = useState<unknown>();
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        if (entry || canvasId || !library.ready || library.query.isError || (!newScene && library.userId && library.query.isFetching)) return;
        const controller = new AbortController();
        setEntryError(undefined);
        void loadScreenCreationEntry({ ...library, newScene }, controller.signal).then(async (resolved) => {
            if (controller.signal.aborted || !resolved) return;
            if (!resolved.canvasId && !newScene && library.query.hasNextPage) {
                await library.query.fetchNextPage({ cancelRefetch: false });
                return;
            }
            setEntry(resolved);
        }).catch((failure) => {
            if (!controller.signal.aborted) setEntryError(failure);
        });
        return () => controller.abort();
    }, [canvasId, entry, newScene, attempt, library.ready, library.userId, library.userHydrated, library.canvasHydrated, library.activeScope, library.projects, library.remoteScenes, library.query.isError, library.query.isFetching, library.query.hasNextPage, library.query.fetchNextPage]);

    if (library.ready && (canvasId || newScene || entry)) {
        if (!canvasId && !newScene && entry?.canvasId) return <Navigate to={`/screen-creation/${encodeURIComponent(entry.canvasId)}`} replace />;
        return <ScreenCreationForm />;
    }
    return (
        <WorkspacePage>
            <PageHeader title="异形屏创作" description="上传屏幕蒙版，让画面贴合每一块屏。" />
            {library.syncFailed ? (
                <WorkspaceErrorState title="账号同步尚未就绪" description="请重新加载后继续恢复场景。" onRetry={() => window.location.reload()} />
            ) : library.query.isError ? (
                <WorkspaceErrorState title="最近场景读取失败" description={library.query.error instanceof Error ? library.query.error.message : undefined} onRetry={() => void library.query.refetch()} />
            ) : entryError ? (
                <WorkspaceErrorState title="最近场景恢复失败" description={entryError instanceof Error ? entryError.message : undefined} onRetry={() => setAttempt((value) => value + 1)} />
            ) : (
                <WorkspaceLoadingState label="正在恢复异形屏场景" detail="读取当前账号的最近场景" />
            )}
        </WorkspacePage>
    );
}

function ScreenCreationForm() {
    return <ScreenCreationWorkspace {...useScreenCreation()} />;
}
