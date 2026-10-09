import { getActiveUserScope } from "@/lib/user-scope";

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
