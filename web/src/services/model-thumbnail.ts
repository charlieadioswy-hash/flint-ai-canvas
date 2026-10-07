import localforage from "localforage";

import { getActiveUserScope } from "@/lib/user-scope";
import { modelThumbnailKey, renderModelThumbnail, type ModelThumbnailSource } from "@/lib/model-thumbnail";

type CachedThumbnail = { blob: Blob; savedAt: number };
type ThumbnailStore = {
    getItem(key: string): Promise<CachedThumbnail | null>;
    setItem(key: string, value: CachedThumbnail): Promise<unknown>;
    iterate(visitor: (value: CachedThumbnail, key: string) => void): Promise<unknown>;
    removeItem(key: string): Promise<unknown>;
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "model_thumbnails" });

export function createModelThumbnailService({ cache, render, getScope }: { cache: ThumbnailStore; render: typeof renderModelThumbnail; getScope: () => string }) {
    let queue: Promise<unknown> = Promise.resolve();
    let cacheWarningShown = false;
    const warnCache = () => {
        if (cacheWarningShown) return;
        cacheWarningShown = true;
        console.warn("模型缩略图缓存不可用，当前预览仍可显示，下次访问时重新生成");
    };
    const read = (key: string) =>
        cache.getItem(key).catch(() => {
            warnCache();
            return null;
        });
    return async (source: ModelThumbnailSource, signal: AbortSignal): Promise<Blob> => {
        const scope = getScope();
        const assertCurrent = () => {
            signal.throwIfAborted();
            if (getScope() !== scope) throw new DOMException("账号已切换", "AbortError");
        };
        assertCurrent();
        if (source.storageKey && !source.storageKey.startsWith("resource:") && source.storageKey.split(":")[1] !== scope) throw new Error("模型属于其他账号的本地缓存");
        const key = modelThumbnailKey(source, scope);
        const cached = await read(key);
        assertCurrent();
        if (cached?.blob instanceof Blob) return cached.blob;
        // Serialize cold renders: a grid must never retain one WebGL context per card.
        const task = queue.then(async () => {
            assertCurrent();
            const existing = await read(key);
            assertCurrent();
            if (existing?.blob instanceof Blob) return existing.blob;
            const blob = await render(source, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
            assertCurrent();
            try {
                if (blob.size <= 512 * 1024) {
                    await cache.setItem(key, { blob, savedAt: Date.now() });
                    const entries: Array<{ key: string; savedAt: number }> = [];
                    await cache.iterate((value, key) => {
                        entries.push({ key, savedAt: value.savedAt });
                    });
                    for (const entry of entries.sort((a, b) => b.savedAt - a.savedAt).slice(128)) await cache.removeItem(entry.key);
                }
            } catch {
                // This is a disposable display cache, never the asset's canonical cover or model file.
                warnCache();
            }
            assertCurrent();
            return blob;
        });
        queue = task.catch(() => undefined);
        return task;
    };
}

export const getModelThumbnail = createModelThumbnailService({ cache: store, render: renderModelThumbnail, getScope: getActiveUserScope });
