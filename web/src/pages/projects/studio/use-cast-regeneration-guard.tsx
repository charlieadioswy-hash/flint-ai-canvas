import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { App } from "antd";

import { getActiveUserScope } from "@/lib/user-scope";
import { getDramaCastImpact } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";
import { CastVideoImpact, generatedCastVideoSegments } from "../workflow-impact";
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

/** 检查与确认都在保存设定之前；取消不会留下保存、解锁或生成副作用。 */
export function useCastRegenerationGuard(projectId: string) {
    const { message, modal } = App.useApp();
    const operation = useDramaOperationScope(projectId);
    const userId = useUserStore((state) => state.user?.id);
    const userScope = useSyncExternalStore(subscribeToScopeChanges, getActiveUserScope, getActiveUserScope);
    const [busy, setBusy] = useState(false);
    type Pending = { ticket: ReturnType<typeof operation.capture>; executing: boolean; dialog?: { destroy: () => void }; resolve?: (allowed: boolean) => void };
    const active = useRef<Pending | null>(null);
    const cancelBeforeExecution = useCallback(() => {
        const pending = active.current;
        if (!pending || pending.executing) return;
        active.current = null;
        pending.dialog?.destroy();
        pending.resolve?.(false);
        setBusy(false);
    }, []);
    useEffect(() => {
        setBusy(false);
        return () => {
            const pending = active.current;
            active.current = null;
            pending?.dialog?.destroy();
            pending?.resolve?.(false);
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
                const allowed = await new Promise<boolean>((resolve) => {
                    pending.resolve = resolve;
                    pending.dialog = modal.confirm({
                        title: unlock ? `解锁并重新生成「${name}」？` : `重新生成「${name}」参考图？`,
                        content: (
                            <>
                                {unlock ? <p>将解锁当前自定义图，并按已保存的设定生成新图。</p> : null}
                                <CastVideoImpact projectId={projectId} impact={impact} restyleSegments={restyleSegments} />
                            </>
                        ),
                        okText: unlock ? "解锁并生成" : "继续生成",
                        cancelText: "取消",
                        centered: true,
                        onOk: () => resolve(current()),
                        onCancel: () => resolve(false),
                    });
                });
                pending.dialog = undefined;
                pending.resolve = undefined;
                if (!allowed || !current()) return;
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
