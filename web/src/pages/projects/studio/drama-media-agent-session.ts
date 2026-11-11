import { createStore } from "zustand/vanilla";
import { getActiveUserScope } from "@/lib/user-scope";
import type { DramaAgentProposal } from "@/services/api/agent";
import type { DramaStudioActionPreflight, DramaStudioActionRequest } from "@/services/api/drama";
import { useGlobalAgentStore } from "@/stores/use-global-agent-store";
import { useUserStore } from "@/stores/use-user-store";
import type { DramaGuideProposalBatch } from "../guide-state";

export type DramaMediaPreviewState = { request: DramaStudioActionRequest; preview?: DramaStudioActionPreflight; error?: string; loading?: boolean; submitted?: boolean };
type StudioSessionState = {
    proposals: DramaAgentProposal[];
    previews: Record<string, DramaMediaPreviewState>;
    dismissed: Set<string>;
    batches: DramaGuideProposalBatch[];
    busy: Set<string>;
    textWrite: Promise<void>;
};

const sessions = new Map<string, ReturnType<typeof createStudioSession>>();
function createStudioSession() {
    return createStore<StudioSessionState>(() => ({ proposals: [], previews: {}, dismissed: new Set(), batches: [], busy: new Set(), textWrite: Promise.resolve() }));
}

export function dramaMediaAccountKey() {
    return JSON.stringify([getActiveUserScope(), useUserStore.getState().user?.id]);
}

/** 只在当前登录期间保留待确认操作，往返两种制作视图不丢失；刷新不恢复媒体授权。 */
export function dramaMediaSession(account: string, projectId: string) {
    const key = JSON.stringify([account, projectId]);
    let session = sessions.get(key);
    if (!session) {
        session = createStudioSession();
        sessions.set(key, session);
    }
    return session;
}

export function dramaMediaSessionIsCurrent(account: string, projectId: string, session: ReturnType<typeof createStudioSession>) {
    return dramaMediaAccountKey() === account && sessions.get(JSON.stringify([account, projectId])) === session;
}

useUserStore.subscribe((state, previous) => {
    if (state.user?.id !== previous.user?.id) sessions.clear();
});
useGlobalAgentStore.subscribe((state, previous) => {
    if (state.resetEpoch !== previous.resetEpoch) sessions.clear();
});
