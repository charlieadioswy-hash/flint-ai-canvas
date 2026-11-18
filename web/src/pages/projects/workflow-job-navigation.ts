import { useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { App } from "antd";
import { useLocation, useNavigate, useParams } from "react-router";

import { dramaKeys } from "@/lib/drama/drama-query-keys";
import { getDramaEpisode, type DramaCast, type DramaJob, type DramaShot } from "@/services/api/drama";

import { parseList } from "./drama-shared";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";

export function keepWorkflowQuery(search: URLSearchParams, step: "story" | "preview") {
    const next = new URLSearchParams(search);
    next.set("step", step);
    next.set("mode", "simple");
    next.delete("view");
    next.delete("tab");
    next.delete("cast");
    return next;
}

export function workflowPath(projectId: string, episodeId: string | undefined, search: URLSearchParams, step: "story" | "preview") {
    const selectedStep = search.get("step");
    const next = keepWorkflowQuery(search, selectedStep === "preview" || selectedStep === "story" ? selectedStep : step);
    const path = `/projects/${encodeURIComponent(projectId)}${episodeId ? `/e/${encodeURIComponent(episodeId)}` : ""}`;
    return `${path}?${next}`;
}

type CastState = { byId: ReadonlyMap<string, DramaCast>; isError: boolean; isPending: boolean };

export function useWorkflowShotVideoGate(castQuery: CastState) {
    const { message } = App.useApp();
    return (shot: DramaShot) => {
        const characters = parseList(shot.castIdsJson);
        const looks = parseList(shot.lookCastIdsJson);
        const props = parseList(shot.propIdsJson);
        if (!characters.length && !looks.length && !props.length && !shot.sceneCastId) return true;
        if (castQuery.isError) {
            message.warning("暂时无法检查本镜头的资产图片，请刷新后重试。");
            return false;
        }
        if (castQuery.isPending) {
            message.info("正在读取本镜头的资产，请稍后重试。");
            return false;
        }
        const lookByCharacter = new Map<string, string>();
        for (const id of looks) {
            const parentId = castQuery.byId.get(id)?.parentId;
            if (parentId && !lookByCharacter.has(parentId)) lookByCharacter.set(parentId, id);
        }
        const ids = new Set([...characters.map((id) => lookByCharacter.get(id) ?? id), ...props, ...looks.filter((id) => !castQuery.byId.has(id)), shot.sceneCastId]);
        const missing: string[] = [];
        let unavailable = 0;
        for (const id of ids) {
            if (!id) continue;
            const cast = castQuery.byId.get(id);
            if (!cast) unavailable++;
            else if (!cast.imageResourceId) missing.push(cast.lookName ? `${cast.name}（${cast.lookName}）` : cast.name);
        }
        if (!missing.length && !unavailable) return true;
        const reasons = [missing.length ? `请先生成这些资产的图片：${missing.join("、")}` : "", unavailable ? `${unavailable} 项关联资产未找到，请检查本镜头的资产关联` : ""].filter(Boolean);
        message.warning(reasons.join("；"));
        return false;
    };
}

export function workflowJobShotMedia(kind: DramaJob["kind"]) {
    return kind === "shot_video" ? "video" : kind === "shot_image" ? "image" : kind === "shot_audio" ? "audio" : undefined;
}

export function useWorkflowJobNavigation(projectId: string, canOpenVideo: (shot: DramaShot) => boolean) {
    const { episodeId: routeEpisodeId } = useParams();
    const navigate = useNavigate();
    const location = useLocation();
    const queryClient = useQueryClient();
    const operation = useDramaOperationScope(projectId);
    const { message } = App.useApp();
    const jumpRequest = useRef(0);
    const latest = useRef({ location, canOpenVideo });
    latest.current = { location, canOpenVideo };
    return async (job: DramaJob) => {
        const episodeId = job.episodeId;
        if (!episodeId) return;
        const request = ++jumpRequest.current;
        const ticket = operation.capture();
        const current = () => operation.isCurrent(ticket) && request === jumpRequest.current && latest.current.location.key === location.key;
        const next = new URLSearchParams(location.search);
        for (const key of ["manage", "scope", "segment", "shot", "editor", "media", "status"]) next.delete(key);
        next.set("step", "story");
        if (!routeEpisodeId) next.set("episode", episodeId);
        else next.delete("episode");
        const shotMedia = workflowJobShotMedia(job.kind);
        const targetId = job.shotId;
        if (targetId && (shotMedia || job.kind === "segment_video" || job.kind === "segment_prompt")) {
            try {
                const detail = await queryClient.fetchQuery({ queryKey: dramaKeys.episode(projectId, episodeId), queryFn: ({ signal }) => getDramaEpisode(projectId, episodeId, signal), staleTime: 0 });
                if (!current()) return;
                if (shotMedia) {
                    const shot = detail.shots.find((item) => item.id === targetId);
                    if (shot && (shotMedia !== "video" || latest.current.canOpenVideo(shot))) {
                        next.set("segment", String(shot.segmentIndex));
                        next.set("editor", "media");
                        next.set("shot", shot.id);
                        next.set("media", shotMedia);
                    } else if (!shot) message.info("任务对应的镜头已变更，已打开本集分镜");
                } else {
                    const segment = detail.segments.find((item) => item.id === targetId);
                    if (segment) next.set("segment", String(segment.index));
                    else message.info("任务对应的剧情段已变更，已打开本集分镜");
                }
            } catch (error) {
                if (current()) message.error(error instanceof Error ? error.message : "读取目标分镜失败，请重试");
                return;
            }
        }
        if (current()) navigate(workflowPath(projectId, routeEpisodeId ? episodeId : undefined, next, "story"));
    };
}
