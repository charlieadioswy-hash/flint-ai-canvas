import { localForageStorageForScope } from "@/lib/localforage-storage";
import type { DramaSceneSplitRequest } from "@/services/api/drama-scene-split";

const key = (projectId: string, episodeId: string) => `drama-scene-split-pending:${projectId}:${episodeId}`;
export async function readSceneSplitPending(userId: string, projectId: string, episodeId: string) {
    const raw = await localForageStorageForScope(userId).getItem(key(projectId, episodeId));
    if (!raw) return undefined;
    const value = JSON.parse(raw) as DramaSceneSplitRequest;
    if (!value.clientOperationId || !value.confirmationToken || !Number.isInteger(value.expectedRevision) || !Number.isInteger(value.episodeRevision) || !Array.isArray(value.shotIds) || !value.shotIds.length)
        throw new Error("重拆提交记录无效，请重新载入");
    return value;
}
export function writeSceneSplitPending(userId: string, projectId: string, episodeId: string, value: DramaSceneSplitRequest) {
    return localForageStorageForScope(userId).setItem(key(projectId, episodeId), JSON.stringify(value));
}
export function clearSceneSplitPending(userId: string, projectId: string, episodeId: string) {
    return localForageStorageForScope(userId).removeItem(key(projectId, episodeId));
}
