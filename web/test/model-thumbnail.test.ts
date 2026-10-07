import { describe, expect, test } from "bun:test";

import { modelThumbnailFormat, modelThumbnailKey, type ModelThumbnailSource } from "../src/lib/model-thumbnail";
import { createModelThumbnailService } from "../src/services/model-thumbnail";

const source: ModelThumbnailSource = { storageKey: "resource:robot", url: "/api/resources/robot/file", fileName: "robot.glb", mimeType: "model/gltf-binary" };
const image = new Blob(["thumbnail"], { type: "image/webp" });

function cacheFixture() {
    const entries = new Map<string, { blob: Blob; savedAt: number }>();
    return {
        entries,
        getItem: async (key: string) => entries.get(key) || null,
        setItem: async (key: string, value: { blob: Blob; savedAt: number }) => {
            entries.set(key, value);
        },
        iterate: async (visit: (value: { blob: Blob; savedAt: number }, key: string) => void) => {
            entries.forEach(visit);
        },
        removeItem: async (key: string) => {
            entries.delete(key);
        },
    };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("model thumbnails", () => {
    test("detects supported models and isolates cache keys without persisting source URLs", () => {
        expect(modelThumbnailFormat(source)).toBe("glb");
        expect(modelThumbnailFormat({ ...source, fileName: "model.FBX", mimeType: "application/octet-stream" })).toBe("fbx");
        expect(modelThumbnailFormat({ ...source, fileName: "model", mimeType: "model/gltf+json" })).toBe("gltf");
        expect(modelThumbnailFormat({ ...source, fileName: "model.obj", mimeType: "application/octet-stream" })).toBeNull();
        expect(modelThumbnailKey(source, "a")).not.toBe(modelThumbnailKey(source, "b"));
        expect(modelThumbnailKey(source, "a")).not.toBe(modelThumbnailKey({ ...source, storageKey: "resource:other" }, "a"));
        expect(modelThumbnailKey(source, "a")).toBe(modelThumbnailKey({ ...source, url: "https://storage.example/model?signature=new" }, "a"));
        expect(modelThumbnailKey({ ...source, storageKey: undefined }, "a")).toMatch(/^[a-f0-9]{64}$/);
    });

    test("concurrent requests share the cached image instead of rendering the same model twice", async () => {
        const cache = cacheFixture();
        let renders = 0;
        const get = createModelThumbnailService({
            cache,
            getScope: () => "a",
            render: async () => {
                renders++;
                return image;
            },
        });
        const signal = new AbortController().signal;
        const [first, second] = await Promise.all([get(source, signal), get(source, signal)]);
        expect(first).toBe(image);
        expect(second).toBe(image);
        expect(renders).toBe(1);
        const reopened = createModelThumbnailService({
            cache,
            getScope: () => "a",
            render: async () => {
                throw new Error("cached thumbnails must not render again");
            },
        });
        expect(await reopened(source, signal)).toBe(image);
    });

    test("renders one model at a time and skips cancelled cards without blocking later cards", async () => {
        const started = deferred();
        const release = deferred();
        const rendered: string[] = [];
        const get = createModelThumbnailService({
            cache: cacheFixture(),
            getScope: () => "a",
            render: async (value) => {
                rendered.push(value.storageKey!);
                if (rendered.length === 1) {
                    started.resolve();
                    await release.promise;
                }
                return image;
            },
        });
        const first = get(source, new AbortController().signal);
        await started.promise;
        const cancelled = new AbortController();
        const second = get({ ...source, storageKey: "resource:cancelled" }, cancelled.signal);
        const rejected = second.catch((error: unknown) => error);
        const third = get({ ...source, storageKey: "resource:third" }, new AbortController().signal);
        cancelled.abort();
        expect(rendered).toEqual(["resource:robot"]);
        release.resolve();
        await first;
        expect(await rejected).toMatchObject({ name: "AbortError" });
        await third;
        expect(rendered).toEqual(["resource:robot", "resource:third"]);
    });

    test("a renderer failure releases the queue for the next model", async () => {
        let count = 0;
        const get = createModelThumbnailService({
            cache: cacheFixture(),
            getScope: () => "a",
            render: async () => {
                if (count++ === 0) throw new Error("invalid model");
                return image;
            },
        });
        await expect(get(source, new AbortController().signal)).rejects.toThrow("invalid model");
        expect(await get({ ...source, storageKey: "resource:valid" }, new AbortController().signal)).toBe(image);
    });

    test("account switching discards an in-flight thumbnail and never seeds the new account cache", async () => {
        const started = deferred();
        const release = deferred();
        const cache = cacheFixture();
        let scope = "a";
        const get = createModelThumbnailService({
            cache,
            getScope: () => scope,
            render: async () => {
                started.resolve();
                await release.promise;
                return image;
            },
        });
        const pending = get(source, new AbortController().signal);
        const rejected = pending.catch((error: unknown) => error);
        await started.promise;
        scope = "b";
        release.resolve();
        expect(await rejected).toMatchObject({ name: "AbortError" });
        expect(cache.entries.size).toBe(0);
        expect(await get(source, new AbortController().signal)).toBe(image);
        expect(cache.entries.has(modelThumbnailKey(source, "b"))).toBe(true);
        expect(cache.entries.has(modelThumbnailKey(source, "a"))).toBe(false);
        await expect(get({ ...source, storageKey: "model:a:private" }, new AbortController().signal)).rejects.toThrow("其他账号");
    });

    test("bounds the disposable thumbnail cache", async () => {
        const cache = cacheFixture();
        for (let index = 0; index < 130; index++) cache.entries.set(`old-${index}`, { blob: image, savedAt: index });
        const get = createModelThumbnailService({ cache, getScope: () => "a", render: async () => image });
        await get(source, new AbortController().signal);
        expect(cache.entries.size).toBe(128);
        expect(cache.entries.has("old-0")).toBe(false);
        expect(cache.entries.has(modelThumbnailKey(source, "a"))).toBe(true);
    });
});
