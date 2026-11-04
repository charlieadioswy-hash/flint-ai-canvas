import { expect, test } from "bun:test";

import { apiClient } from "@/services/api/request";
import { downloadBrowserMedia } from "@/services/browser-download";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

test("cancelling while a resource URL is pending never creates or clicks a download anchor", async () => {
    const originalRequest = apiClient.request;
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const started = deferred<void>();
    const response = deferred<Awaited<ReturnType<typeof apiClient.request>>>();
    let creates = 0;
    let appends = 0;
    let clicks = 0;
    apiClient.request = (async (input: { url?: string }) => {
        expect(input.url).toBe("/resources/access");
        started.resolve();
        return response.promise;
    }) as typeof apiClient.request;
    Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: {
            createElement() {
                creates++;
                return {
                    style: {},
                    click() {
                        clicks++;
                    },
                    remove() {},
                };
            },
            body: {
                appendChild() {
                    appends++;
                },
            },
        },
    });
    try {
        const controller = new AbortController();
        const download = downloadBrowserMedia({ storageKey: "resource:cancelled-browser-download", fileName: "model.glb" }, controller.signal);
        const outcome = download.catch((error: unknown) => error);
        await started.promise;
        controller.abort();
        response.resolve({
            status: 200,
            headers: {},
            config: { headers: {} },
            data: {
                code: 0,
                msg: "ok",
                data: {
                    items: [
                        {
                            access: {
                                resourceId: "cancelled-browser-download",
                                url: "https://cdn.invalid/model.glb",
                                purpose: "download",
                                delivery: "cdn",
                                requestedVariant: "original",
                                actualVariant: "original",
                                issuedAt: new Date().toISOString(),
                                expiresAt: new Date(0).toISOString(),
                                refreshAt: new Date(0).toISOString(),
                                revision: "test",
                            },
                        },
                    ],
                },
            },
        } as Awaited<ReturnType<typeof apiClient.request>>);
        expect(await outcome).toMatchObject({ name: "AbortError" });
        expect(creates).toBe(0);
        expect(appends).toBe(0);
        expect(clicks).toBe(0);
    } finally {
        apiClient.request = originalRequest;
        if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
        else Reflect.deleteProperty(globalThis, "document");
    }
});

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
