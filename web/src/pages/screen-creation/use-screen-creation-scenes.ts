import { useMemo, useSyncExternalStore } from "react";
import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query";
import { getActiveUserScope } from "@/lib/user-scope";
import { listRemoteCanvasProjectsPage } from "@/services/api/user-data";
import { getRemoteUserDataSyncSessionSnapshot, subscribeRemoteUserDataSyncSession } from "@/services/user-data-sync";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import { screenCreationScenes } from "./screen-creation-session";

export function screenCreationScenesQueryOptions(userId?: string) {
    return infiniteQueryOptions({
        queryKey: ["canvas-library", userId, "irregular-screen", "pages"],
        initialPageParam: 1,
        queryFn: ({ pageParam, signal }) => listRemoteCanvasProjectsPage({ page: pageParam, pageSize: 40, sort: "updated", sceneKind: "irregular-screen", signal }),
        getNextPageParam: (page) => page.hasMore ? page.page + 1 : undefined,
    });
}

export function useScreenCreationScenes() {
    const userId = useUserStore((state) => state.user?.id);
    const userHydrated = useUserStore((state) => state.hydrated);
    const canvasHydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const remoteSession = useSyncExternalStore(subscribeRemoteUserDataSyncSession, getRemoteUserDataSyncSessionSnapshot, getRemoteUserDataSyncSessionSnapshot);
    const activeScope = getActiveUserScope();
    const remoteReady = remoteSession.userId === userId && remoteSession.phase === "ready";
    const ready = userHydrated && canvasHydrated && activeScope === (userId || "guest") && (!userId || remoteReady);
    const query = useInfiniteQuery({
        ...screenCreationScenesQueryOptions(userId),
        enabled: ready && Boolean(userId),
    });
    const remoteScenes = useMemo(() => query.data?.pages.flatMap((page) => page.projects), [query.data]);
    return {
        userId,
        userHydrated,
        canvasHydrated,
        activeScope,
        projects,
        ready,
        syncFailed: Boolean(userId) && remoteSession.userId === userId && remoteSession.phase === "failed",
        query,
        remoteScenes,
        scenes: ready ? screenCreationScenes(projects, remoteScenes) : [],
    };
}
