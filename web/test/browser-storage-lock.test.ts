import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { withBrowserStorageLock } from "../src/lib/browser-storage-lock";

test("IDB fallback serializes pending callbacks, releases failures, and separates nested namespaces", async () => {
    const originalIndexedDB = globalThis.indexedDB;
    const originalNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    try {
        let active = 0;
        let peak = 0;
        let count = 0;
        await Promise.all(Array.from({ length: 8 }, () => withBrowserStorageLock("generation-effect", "same", async () => {
            peak = Math.max(peak, ++active);
            const before = count;
            await new Promise((resolve) => setTimeout(resolve, 2));
            count = before + 1;
            active--;
        })));
        expect(peak).toBe(1);
        expect(count).toBe(8);
        await expect(withBrowserStorageLock("generation-effect", "same", async () => { throw new Error("callback failed"); })).rejects.toThrow("callback failed");
        expect(await withBrowserStorageLock("generation-effect", "same", () => withBrowserStorageLock("canvas-storage", "same", async () => 42))).toBe(42);
        Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
        let entered = false;
        await expect(withBrowserStorageLock("canvas-storage", "same", async () => { entered = true; })).rejects.toThrow("IndexedDB");
        expect(entered).toBe(false);
        Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open() { throw new Error("storage denied"); } } });
        await expect(withBrowserStorageLock("canvas-storage", "same", async () => { entered = true; })).rejects.toThrow("storage denied");
        expect(entered).toBe(false);
        let nativeCalls = 0;
        Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: async (_key: string, operation: () => Promise<unknown>) => { nativeCalls++; return operation(); } } } });
        expect(await withBrowserStorageLock("canvas-storage", "native", async () => "native")).toBe("native");
        expect(nativeCalls).toBe(1);
    } finally {
        if (originalIndexedDB === undefined) delete (globalThis as { indexedDB?: unknown }).indexedDB;
        else Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: originalIndexedDB });
        Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
    }
});
