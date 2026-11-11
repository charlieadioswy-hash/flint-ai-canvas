export function isAdvancedDramaStudio(search: URLSearchParams) {
    const mode = search.get("mode");
    if (mode === "simple") return false;
    if (mode === "advanced") return true;
    return ["cast", "inbox", "settings"].includes(search.get("view") || "") || ["script", "final"].includes(search.get("tab") || "");
}

/** 两种制作视图共用集、段及镜头定位；复杂面板参数不能把简易视图再次切回详细视图。 */
export function dramaStudioPath(projectId: string, episodeId: string | undefined, search: URLSearchParams, mode: "simple" | "advanced") {
    const next = new URLSearchParams(search);
    next.set("mode", mode);
    if (mode === "simple") {
        next.delete("view");
        next.delete("tab");
        next.delete("cast");
    }
    const path = `/projects/${encodeURIComponent(projectId)}${episodeId ? `/e/${encodeURIComponent(episodeId)}` : ""}`;
    return `${path}?${next}`;
}
