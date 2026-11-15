import { getActiveUserScope } from "@/lib/user-scope";
import { useUserStore } from "@/stores/use-user-store";

export type CanvasAgentEntryDraft = {
    text: string;
    skillIds: string[];
    files: Array<{ id: string; file: File }>;
};
export type CanvasAgentEntryHandoff = CanvasAgentEntryDraft & { canvasId: string; scope: string; userId: string };

const drafts = new Map<string, { scope: string; userId: string; expiresAt: number; draft: CanvasAgentEntryDraft }>();

/** 参考文件只在本次路由交接时留在内存，不能写入 history 或跨账号恢复。 */
export function queueCanvasAgentEntry(canvasId: string, draft: CanvasAgentEntryDraft) {
    const userId = useUserStore.getState().user?.id;
    if (!canvasId || !userId) throw new Error("请登录后创建画布");
    drafts.set(canvasId, { scope: getActiveUserScope(), userId, expiresAt: Date.now() + 10 * 60_000, draft: { text: draft.text, skillIds: [...draft.skillIds], files: [...draft.files] } });
}

export function takeCanvasAgentEntry(canvasId: string): CanvasAgentEntryHandoff | null {
    const entry = drafts.get(canvasId);
    if (!entry) return null;
    drafts.delete(canvasId);
    if (entry.expiresAt <= Date.now() || entry.scope !== getActiveUserScope() || entry.userId !== useUserStore.getState().user?.id) return null;
    return { ...entry.draft, canvasId, scope: entry.scope, userId: entry.userId };
}
