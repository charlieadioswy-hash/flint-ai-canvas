import { useCallback, useEffect, useRef } from "react";
import { assertCurrentUserSession, captureUserSession, getActiveUserScope } from "@/lib/user-scope";
import { useUserStore } from "@/stores/use-user-store";

type OperationTicket = { projectId: string; account: string; epoch: number; session: ReturnType<typeof captureUserSession> };

function accountKey() {
    return JSON.stringify([getActiveUserScope(), useUserStore.getState().user?.id ?? null]);
}

/** 写入仍由服务端完成；离开作品或会话后，迟到回执不能操作当前页面。 */
export function useDramaOperationScope(projectId: string) {
    const scope = useRef({ projectId, account: accountKey(), epoch: 0, mounted: true });
    if (scope.current.projectId !== projectId || scope.current.account !== accountKey()) {
        scope.current = { projectId, account: accountKey(), epoch: scope.current.epoch + 1, mounted: true };
    }
    useEffect(() => {
        scope.current.mounted = true;
        const unsubscribe = useUserStore.subscribe((next, previous) => {
            if (next.user?.id !== previous.user?.id) {
                scope.current.epoch += 1;
                scope.current.account = accountKey();
            }
        });
        return () => {
            unsubscribe();
            scope.current.mounted = false;
            scope.current.epoch += 1;
        };
    }, []);
    const capture = useCallback((): OperationTicket => ({ ...scope.current, session: captureUserSession(true) }), []);
    const isCurrent = useCallback((ticket: OperationTicket) => {
        const current = scope.current;
        if (!current.mounted || current.epoch !== ticket.epoch || current.projectId !== ticket.projectId || current.account !== ticket.account || ticket.account !== accountKey()) return false;
        try {
            assertCurrentUserSession(ticket.session);
            return true;
        } catch {
            return false;
        }
    }, []);
    return { capture, isCurrent };
}
