import { localForageStorageForScope } from "@/lib/localforage-storage";
import type { DramaShotMediaAction } from "@/services/api/drama-shot-media";

const key = (projectId: string, shotId: string) => `drama-shot-audio-pending:${projectId}:${shotId}`;
export async function readShotAudioPending(userId: string, projectId: string, shotId: string) {
    const raw = await localForageStorageForScope(userId).getItem(key(projectId, shotId));
    if (!raw) return undefined;
    const value = JSON.parse(raw) as DramaShotMediaAction;
    if (!value.clientOperationId || !value.confirmationToken || !Number.isInteger(value.expectedRevision) || !Number.isInteger(value.baseRevision)) throw new Error("镜头音频提交记录无效，请重新载入");
    return value;
}
export function writeShotAudioPending(userId: string, projectId: string, shotId: string, action: DramaShotMediaAction) {
    return localForageStorageForScope(userId).setItem(key(projectId, shotId), JSON.stringify(action));
}
export function clearShotAudioPending(userId: string, projectId: string, shotId: string) {
    return localForageStorageForScope(userId).removeItem(key(projectId, shotId));
}
