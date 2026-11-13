import type { DramaGuideStep } from "@/services/api/drama";

export function activeDramaGuide(step?: DramaGuideStep | "") {
    return Boolean(step && step !== "completed");
}

export function dramaProjectPath(projectId: string, step?: DramaGuideStep | "") {
    const path = `/projects/${encodeURIComponent(projectId)}`;
    return activeDramaGuide(step) ? `${path}/guide` : path;
}
