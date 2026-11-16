import { useQuery } from "@tanstack/react-query";

import { getActiveUserScope } from "@/lib/user-scope";
import { executeDramaStudioBatch, preflightDramaStudioBatch, type DramaCast, type DramaStudioActionRequest, type DramaStudioBatchView } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";
import { sameGenerationCost } from "../workflow-generation";

type CastDraft = NonNullable<DramaStudioActionRequest["castDraft"]>;
type CastQuote = DramaStudioBatchView;
export class CastImageNotSubmittedError extends Error {}

export function useCastImageQuote({
    projectId,
    episodeId,
    cast,
    revision,
    draft,
    failedLooks = [],
    enabled = true,
}: {
    projectId: string;
    episodeId?: string;
    cast: DramaCast;
    revision?: number;
    draft?: CastDraft;
    failedLooks?: DramaCast[];
    enabled?: boolean;
}) {
    const userId = useUserStore((state) => state.user?.id);
    const targets = [...new Set([cast.id, ...failedLooks.filter((look) => look.parentId === cast.id && look.imageStatus === "failed").map((look) => look.id)])].sort();
    const read = async (withDraft: boolean, restyleSegments = false): Promise<CastQuote> => {
        const view = await preflightDramaStudioBatch(projectId, {
            action: "cast_image",
            targetIds: targets,
            regenerate: true,
            ...(restyleSegments ? { restyleSegments: true } : {}),
            ...(episodeId ? { episodeId } : {}),
            ...(withDraft && draft ? { castDrafts: { [cast.id]: draft } } : {}),
        });
        if (view.action !== "cast_image" || JSON.stringify([...view.targetIds].sort()) !== JSON.stringify(targets) || view.items.some((item) => episodeId && item.episodeId && item.episodeId !== episodeId))
            throw new Error("图片生成对象已变化，请重新读取");
        const blocked = view.items.find((item) => item.status !== "ready");
        return { ...view, ready: view.ready && !blocked, reason: view.reason || blocked?.reason };
    };
    const query = useQuery({
        queryKey: ["drama-cast-generation-quote", getActiveUserScope(), userId, projectId, episodeId || "", cast.id, cast.revision, revision, JSON.stringify(draft), JSON.stringify(failedLooks.map((look) => [look.id, look.revision, look.imageStatus]))],
        queryFn: () => read(true),
        enabled,
        retry: false,
        staleTime: 15_000,
    });
    const recheck = async (accepted: CastQuote, restyleSegments = false) => {
        const fresh = await read(false, restyleSegments);
        if (
            !fresh.ready ||
            !accepted.scopeHash ||
            fresh.scopeHash !== accepted.scopeHash ||
            !sameGenerationCost(accepted, fresh) ||
            JSON.stringify(accepted.items.map((view) => [view.targetId, view.amountMicrocredits])) !== JSON.stringify(fresh.items.map((view) => [view.targetId, view.amountMicrocredits]))
        ) {
            void query.refetch();
            throw new Error(fresh.reason || "图片费用或生成范围已更新，请查看按钮上的最新积分后生成");
        }
        return fresh;
    };
    const execute = async (accepted: CastQuote, restyleSegments = false, isCurrent: () => boolean = () => true): Promise<{ affectedSegments?: number } | undefined> => {
        let prepared: CastQuote;
        try {
            prepared = await recheck(accepted, restyleSegments);
        } catch (error) {
            throw new CastImageNotSubmittedError(error instanceof Error ? error.message : "图片费用读取失败");
        }
        if (!isCurrent()) return;
        const result = await executeDramaStudioBatch(projectId, {
            action: "cast_image",
            targetIds: targets,
            regenerate: true,
            ...(restyleSegments ? { restyleSegments: true } : {}),
            baseRevision: prepared.baseRevision,
            confirmationToken: prepared.confirmationToken,
            ...(episodeId ? { episodeId } : {}),
        });
        if (result.action !== "cast_image" || JSON.stringify([...result.targetIds].sort()) !== JSON.stringify(targets) || result.counts.queued !== targets.length) throw new Error(result.reason || "生成提交结果尚未确认，请先核对任务状态");
        return {};
    };
    return { ...query, recheck, execute, disabled: !enabled || query.isFetching || !query.data?.ready || !query.data.priced || !query.data.scopeHash || query.isError };
}
