import { expect, test } from "bun:test";

import { apiClient } from "@/services/api/request";
import { downloadBrowserMedia } from "@/services/browser-download";

test("an already cancelled download rejects before resolving a URL or creating an anchor", async () => {
    const originalRequest = apiClient.request;
    let requests = 0;
    apiClient.request = (async () => {
        requests++;
        throw new Error("An aborted download must not request a resource URL");
    }) as typeof apiClient.request;
    const controller = new AbortController();
    // Bun 1.3.9 may lose the default abort reason during GC; keep an explicit reason alive.
    const reason = new DOMException("Download cancelled", "AbortError");
    controller.abort(reason);
    try {
        Bun.gc(true);
        await expect(downloadBrowserMedia({ storageKey: "resource:must-not-be-requested", fileName: "model.glb" }, controller.signal)).rejects.toBe(reason);
        expect(requests).toBe(0);
    } finally {
        apiClient.request = originalRequest;
    }
});
