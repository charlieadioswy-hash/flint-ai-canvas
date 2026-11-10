import { useEffect } from "react";
import type { DramaSummary } from "@/services/api/drama";
import { useGlobalAgentStore } from "@/stores/use-global-agent-store";
import { activeDramaGuide } from "../guide-state";

/** 制作台续用作品的短剧会话，入口仍由全局悬浮按钮控制。 */
export function useStudioAgent(projectId: string, summary: DramaSummary | undefined, unavailable: boolean) {
    useEffect(() => {
        if (unavailable || summary?.project.id !== projectId || summary.production.hasDraftForm || activeDramaGuide(summary.production.guideStep)) return;
        const context = { projectId, guideConversationId: summary.production.guideConversationId };
        useGlobalAgentStore.getState().setDrama(context);
        return () => {
            if (useGlobalAgentStore.getState().drama === context) useGlobalAgentStore.getState().setDrama(null);
        };
    }, [projectId, unavailable, summary?.project.id, summary?.production.hasDraftForm, summary?.production.guideStep, summary?.production.guideConversationId]);
}
