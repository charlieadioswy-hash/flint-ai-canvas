import { localForageStorageForScope } from "@/lib/localforage-storage";
import type { DramaCastAssistanceRequest } from "@/services/api/drama-cast-assistance";

function pendingKey(projectId: string, castId: string, purpose: string) {
    return `drama-cast-assistance:${projectId}:${castId}:${purpose}`;
}

export async function readCastAssistancePending(userId: string, projectId: string, castId: string, purpose: string) {
    const value = await localForageStorageForScope(userId).getItem(pendingKey(projectId, castId, purpose));
    if (!value) return undefined;
    const parsed = JSON.parse(value) as DramaCastAssistanceRequest;
    if (parsed.purpose !== purpose || !parsed.clientOperationId || !parsed.confirmationToken || !Number.isInteger(parsed.expectedRevision) || !Number.isInteger(parsed.castRevision) || !parsed.model)
        throw new Error("待确认提交记录无效，请保留本页并重新载入");
    return parsed;
}

export function writeCastAssistancePending(userId: string, projectId: string, castId: string, request: DramaCastAssistanceRequest) {
    return localForageStorageForScope(userId).setItem(pendingKey(projectId, castId, request.purpose), JSON.stringify(request));
}

export function clearCastAssistancePending(userId: string, projectId: string, castId: string, purpose: string) {
    return localForageStorageForScope(userId).removeItem(pendingKey(projectId, castId, purpose));
}
