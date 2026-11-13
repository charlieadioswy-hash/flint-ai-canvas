import { localForageStorageForScope } from "@/lib/localforage-storage";
import type { CastViewAction } from "@/services/api/drama-cast-views";

export type PendingCastView = { viewId: string; action: CastViewAction };
const key = (projectId: string, castId: string) => `drama-cast-view-pending:${projectId}:${castId}`;

export async function readCastViewPending(userId: string, projectId: string, castId: string) {
    const value = await localForageStorageForScope(userId).getItem(key(projectId, castId));
    if (!value) return undefined;
    const parsed = JSON.parse(value) as PendingCastView;
    if (!parsed.viewId || !parsed.action?.clientOperationId || !parsed.action.confirmationToken || !Number.isInteger(parsed.action.expectedRevision) || !Number.isInteger(parsed.action.viewRevision)) throw new Error("视图待确认提交记录无效，请重新载入");
    return parsed;
}
export function writeCastViewPending(userId: string, projectId: string, castId: string, value: PendingCastView) {
    return localForageStorageForScope(userId).setItem(key(projectId, castId), JSON.stringify(value));
}
export function clearCastViewPending(userId: string, projectId: string, castId: string) {
    return localForageStorageForScope(userId).removeItem(key(projectId, castId));
}
