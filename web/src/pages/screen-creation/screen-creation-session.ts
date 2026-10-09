import { getActiveUserScope } from "@/lib/user-scope";
import { isIrregularScreenScene } from "@/lib/canvas/irregular-screen-domain";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { getRemoteCanvasProject } from "@/services/api/user-data";
import { ApiError } from "@/services/api/request";

type ScreenCreationSummary = Pick<CanvasProject, "id" | "title" | "updatedAt">;

export function screenCreationScenes(projects: readonly Pick<CanvasProject, "id" | "title" | "updatedAt" | "creationScene">[], remoteScenes: readonly ScreenCreationSummary[] = []) {
    const scenes = new Map<string, ScreenCreationSummary>();
    for (const scene of [...remoteScenes, ...projects.filter((project) => isIrregularScreenScene(project.creationScene))]) {
        if (!scene.id.trim()) continue;
        const previous = scenes.get(scene.id);
        if (!previous || (Date.parse(scene.updatedAt) || 0) >= (Date.parse(previous.updatedAt) || 0)) scenes.set(scene.id, scene);
    }
    return [...scenes.values()].sort((left, right) => {
        const updated = (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0);
        return updated || left.id.localeCompare(right.id);
    });
}

export function resolveScreenCreationEntry(options: {
    projects: readonly Pick<CanvasProject, "id" | "title" | "updatedAt" | "creationScene">[];
    remoteScenes?: readonly ScreenCreationSummary[];
    userId?: string;
    activeScope: string;
    userHydrated: boolean;
    canvasHydrated: boolean;
    newScene: boolean;
}): { canvasId?: string } | null {
    if (!options.userHydrated || !options.canvasHydrated || options.activeScope !== (options.userId || "guest")) return null;
    if (options.newScene) return {};
    if (options.userId && !options.remoteScenes) return null;
    const scenes = screenCreationScenes(options.projects, options.remoteScenes);
    return scenes[0] ? { canvasId: scenes[0].id } : {};
}

export async function loadScreenCreationEntry(options: Omit<Parameters<typeof resolveScreenCreationEntry>[0], "projects"> & { projects: readonly CanvasProject[] }, signal: AbortSignal) {
    const entry = resolveScreenCreationEntry(options);
    if (!entry?.canvasId || !options.userId) return entry;
    // A paged list cannot prove a cached scene was deleted. Check only the
    // candidate being resumed, without removing cached content or offline edits.
    for (const scene of screenCreationScenes(options.projects, options.remoteScenes)) {
        signal.throwIfAborted();
        const local = options.projects.find((project) => project.id === scene.id);
        if (local?.revision === 0) return { canvasId: scene.id };
        try {
            await getRemoteCanvasProject(scene.id, local, signal);
            signal.throwIfAborted();
            return { canvasId: scene.id };
        } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof ApiError && error.status === 404 && error.code === 404 && error.reason === "not_found")) throw error;
        }
    }
    return {};
}

// A form session owns its pending callbacks and local image URLs until its route,
// account or draft changes. Each operation captures this object before awaiting.
export function createScreenCreationSession(readScope = getActiveUserScope, revokeUrl = (url: string) => URL.revokeObjectURL(url)) {
    const scope = readScope();
    const controller = new AbortController();
    const urls = new Set<string>();
    const isActive = () => !controller.signal.aborted && readScope() === scope;
    const assertActive = () => {
        if (!isActive()) throw new DOMException("Aborted", "AbortError");
    };
    const releaseUrl = (url: string) => {
        if (!url.startsWith("blob:")) return;
        urls.delete(url);
        revokeUrl(url);
    };
    return {
        signal: controller.signal,
        isActive,
        assertActive,
        ownUrl(url: string) {
            if (!isActive()) {
                releaseUrl(url);
                assertActive();
            }
            if (url.startsWith("blob:")) urls.add(url);
            return url;
        },
        releaseUrl,
        dispose() {
            controller.abort();
            for (const url of urls) revokeUrl(url);
            urls.clear();
        },
    };
}

export type ScreenCreationSession = ReturnType<typeof createScreenCreationSession>;
