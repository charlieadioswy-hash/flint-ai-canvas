import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { App } from "antd";

import { getActiveUserScope } from "@/lib/user-scope";
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

function subscribeToScopeChanges(listener: () => void) {
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
}

/** 点击生成即授权；读取依赖后直接执行，已有视频影响通过非阻断提示说明。 */
export function useCastRegenerationGuard(projectId: string) {
    const { message } = App.useApp();
    const operation = useDramaOperationScope(projectId);
    const userId = useUserStore((state) => state.user?.id);
    const userScope = useSyncExternalStore(subscribeToScopeChanges, getActiveUserScope, getActiveUserScope);
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
        return () => {
            active.current = null;
        };
    }, [projectId, userId, userScope]);

    const request = async ({ castId, name, restyleSegments, unlock, execute }: RegenerationRequest) => {
        if (active.current) return;
        const pending: Pending = { ticket: operation.capture(), executing: false };
        active.current = pending;
        setBusy(true);
        const current = () => active.current === pending && operation.isCurrent(pending.ticket);
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
            if (generatedCastVideoSegments(impact).length || unlock) {
                const count = generatedCastVideoSegments(impact).length;
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
