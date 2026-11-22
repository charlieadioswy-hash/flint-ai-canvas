import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "antd";

import { assertCurrentUserSession, captureUserSession, subscribeUserSessionInvalidation } from "@/lib/user-scope";
import { getDramaCastImpact } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";
import { generatedCastVideoSegments } from "../workflow-impact";
import { useDramaOperationScope } from "./use-drama-operation-scope";

type RegenerationRequest = {
    castId: string;
    name: string;
    restyleSegments: boolean;
    unlock?: boolean;
    execute: (isCurrent: () => boolean) => Promise<unknown>;
};

/** 点击生成即授权；读取依赖后直接执行，已有视频影响通过非阻断提示说明。 */
export function useCastRegenerationGuard(projectId: string) {
    const { message } = App.useApp();
    const operation = useDramaOperationScope(projectId);
    const userId = useUserStore((state) => state.user?.id);
    const [busy, setBusy] = useState(false);
    type Pending = { ticket: ReturnType<typeof operation.capture>; executing: boolean };
    const active = useRef<Pending | null>(null);
    const cancelBeforeExecution = useCallback(() => {
        const pending = active.current;
        if (!pending || pending.executing) return;
        active.current = null;
        setBusy(false);
    }, []);
    useEffect(() => {
        setBusy(false);
        const unsubscribe = subscribeUserSessionInvalidation(() => {
            active.current = null;
            setBusy(false);
        });
        return () => {
            unsubscribe();
            active.current = null;
        };
    }, [projectId, userId]);

    const request = async ({ castId, name, restyleSegments, unlock, execute }: RegenerationRequest) => {
        if (active.current) return;
        let session: ReturnType<typeof captureUserSession>;
        try {
            session = captureUserSession();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "账号已切换，请重新打开后重试");
            return;
        }
        const pending: Pending = { ticket: operation.capture(), executing: false };
        active.current = pending;
        setBusy(true);
        const current = () => {
            if (active.current !== pending || !operation.isCurrent(pending.ticket)) return false;
            try {
                assertCurrentUserSession(session);
                return true;
            } catch {
                return false;
            }
        };
        try {
            let impact;
            try {
                impact = await getDramaCastImpact(projectId, castId);
                if (!current()) return;
                if (impact.kind !== "cast" || impact.castId !== castId || !Array.isArray(impact.directSegments) || !Array.isArray(impact.continuitySegments)) throw new Error("资产影响范围已变化，请重新检查");
            } catch (error) {
                if (current()) message.error(error instanceof Error ? error.message : "影响范围读取失败，请重试");
                return;
            }
            const count = generatedCastVideoSegments(impact).length;
            if (count || unlock) {
                message.info(`${unlock ? `将解锁「${name}」并生成新图。` : ""}${count ? `已有 ${count} 段视频引用此资产${restyleSegments ? "，将标记为待更新" : "，原视频保留"}。` : ""}`);
            }
            if (current()) {
                pending.executing = true;
                await execute(current).catch(() => undefined);
            }
        } finally {
            if (active.current === pending) {
                active.current = null;
                setBusy(false);
            }
        }
    };
    return { busy, request, cancelBeforeExecution };
}
