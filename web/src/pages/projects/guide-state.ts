import type { DramaGuideStep } from "@/services/api/drama";

export function activeDramaGuide(step?: DramaGuideStep | "") {
    return Boolean(step && step !== "completed");
}

export function dramaProjectPath(projectId: string, step?: DramaGuideStep | "", episodeCount = 0) {
    const path = `/projects/${encodeURIComponent(projectId)}`;
    if (episodeCount > 0 && step !== "configuring") return `${path}?manage=episodes`;
    return activeDramaGuide(step) ? `${path}/guide` : path;
}
