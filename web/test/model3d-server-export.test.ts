import { afterEach, expect, spyOn, test } from "bun:test";

import { http } from "@/services/api/request";
import { createModel3DExport, type Model3DExportTask } from "@/services/api/model3d-exports";
import { convertModel3DOnServer, downloadModel3D } from "@/services/model3d-download";
import { useUserStore } from "@/stores/use-user-store";
import { uploadTimeoutMs } from "@/services/api/resources";

const originalUser = useUserStore.getState().user;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalFetch = globalThis.fetch;
const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
    spies.splice(0).forEach((spy) => spy.mockRestore());
    useUserStore.setState({ user: originalUser });
    globalThis.fetch = originalFetch;
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
});

const source = { storageKey: "resource:model-source", url: "/model.obj", fileName: "robot.obj", format: "obj" as const };
const result = { resourceId: "converted", url: "/converted.abc", storageKey: "resource:converted", fileName: "robot.abc", format: "abc" as const, mimeType: "application/octet-stream", bytes: 1024 };
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

test("native FBX downloads without capabilities, conversion, or model reads", async () => {
    const get = spyOn(http, "get").mockRejectedValue(new Error("unexpected API"));
    const post = spyOn(http, "post").mockRejectedValue(new Error("unexpected conversion"));
    spies.push(get, post);
    let clicks = 0;
    Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: {
            createElement: () => ({
                style: {},
                href: "",
                download: "",
                click() {
                    clicks++;
                },
                remove() {},
            }),
            body: { appendChild() {} },
        },
    });
    globalThis.fetch = (async () => {
        throw new Error("unexpected model read");
    }) as typeof fetch;
    await downloadModel3D({ url: "https://cdn.invalid/native.fbx", fileName: "native.fbx", format: "fbx" }, "fbx");
    expect(clicks).toBe(1);
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
});

test("owned model export references the resource, polls, and preserves ABC settings", async () => {
    let polls = 0;
    const get = spyOn(http, "get").mockImplementation(async (url) => {
        if (url.endsWith("capabilities")) return { available: true, formats: ["fbx", "abc"] } as never;
        polls++;
        return { id: "export", status: "succeeded", stage: "完成", progress: 100, result } as never;
    });
    const post = spyOn(http, "post").mockResolvedValue({ id: "export", status: "queued", stage: "等待转换", progress: 0 } as never);
    spies.push(get, post);
    const progress: string[] = [];
    expect(await convertModel3DOnServer(source, "abc", { animation: "walk", fps: 24, onProgress: (task) => progress.push(task.status) })).toEqual(result);
    expect(polls).toBe(1);
    const request = post.mock.calls[0][1] as Record<string, unknown>;
    expect(request).toMatchObject({ resourceId: "model-source", sourceFormat: "obj", format: "abc", animation: "walk", fps: 24 });
    expect(request.requestId).toMatch(/^[\da-f-]{36}$/);
    expect(request).not.toBeInstanceOf(FormData);
    expect(progress).toEqual(["queued", "succeeded"]);
});

test("local models upload only during export with multipart fields and no forced Content-Type", async () => {
    const get = spyOn(http, "get").mockResolvedValue({ available: true, formats: ["fbx", "abc"] } as never);
    const post = spyOn(http, "post").mockResolvedValue({ id: "export", status: "succeeded", stage: "完成", progress: 100, result: { ...result, format: "fbx" } } as never);
    spies.push(get, post);
    let reads = 0;
    globalThis.fetch = (async () => {
        reads++;
        return new Response("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3");
    }) as typeof fetch;
    expect(reads).toBe(0);
    await convertModel3DOnServer({ url: "blob:local", format: "obj", fileName: "local.obj" }, "fbx");
    expect(reads).toBe(1);
    const form = post.mock.calls[0][1] as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("sourceFormat")).toBe("obj");
    expect(form.get("format")).toBe("fbx");
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(form.has("resourceId")).toBe(false);
    expect(post.mock.calls[0][2]?.headers).toBeUndefined();
});

test("unavailable converter never uploads or creates a task", async () => {
    const get = spyOn(http, "get").mockResolvedValue({ available: false, formats: [] } as never);
    const post = spyOn(http, "post").mockRejectedValue(new Error("unexpected submit"));
    spies.push(get, post);
    await expect(convertModel3DOnServer(source, "fbx")).rejects.toThrow("暂不可用");
    expect(post).not.toHaveBeenCalled();
});

test("abort before POST response fences the request and never downloads the late result", async () => {
    const submitted = deferred<void>();
    const pending = deferred<Model3DExportTask>();
    const get = spyOn(http, "get").mockResolvedValue({ available: true, formats: ["abc"] } as never);
    const post = spyOn(http, "post").mockImplementation(async () => {
        submitted.resolve();
        return (await pending.promise) as never;
    });
    const cancel = spyOn(http, "delete").mockResolvedValue({ id: "export", status: "cancelled" } as never);
    spies.push(get, post, cancel);
    const controller = new AbortController();
    const outcome = convertModel3DOnServer(source, "abc", { signal: controller.signal }).catch((error: unknown) => error);
    await submitted.promise;
    controller.abort();
    const request = post.mock.calls[0][1] as { requestId: string };
    expect(cancel.mock.calls[0][0]).toBe(`/model3d/exports/by-request/${request.requestId}`);
    pending.resolve({ id: "late", status: "succeeded", stage: "完成", progress: 100, result });
    expect(await outcome).toMatchObject({ name: "AbortError" });
});

test.each(["abort", "switch account"])("%s cancels a known running export by task ID", async (reason) => {
    const submitted = deferred<void>();
    const get = spyOn(http, "get").mockResolvedValue({ available: true, formats: ["abc"] } as never);
    const post = spyOn(http, "post").mockResolvedValue({ id: "running-export", status: "running", stage: "转换中", progress: 20 } as never);
    const cancel = spyOn(http, "delete").mockResolvedValue({ id: "running-export", status: "cancelled" } as never);
    spies.push(get, post, cancel);
    const controller = new AbortController();
    const outcome = convertModel3DOnServer(source, "abc", { signal: controller.signal, onProgress: () => submitted.resolve() }).catch((error: unknown) => error);
    await submitted.promise;
    if (reason === "abort") controller.abort();
    else useUserStore.setState({ user: { id: "other", username: "other", displayName: "Other", role: "user", status: "active" } });
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(cancel.mock.calls[0][0]).toBe("/model3d/exports/running-export");
});

test("multipart API preserves the caller request ID", async () => {
    const post = spyOn(http, "post").mockResolvedValue({ id: "export" } as never);
    spies.push(post);
    const file = new Blob([new Uint8Array(1024 * 1024)]);
    await createModel3DExport({ requestId: "same-attempt", sourceFormat: "glb", fileName: "source.glb", format: "abc", fps: 30 }, file);
    expect((post.mock.calls[0][1] as FormData).get("requestId")).toBe("same-attempt");
    expect(post.mock.calls[0][2]?.timeout).toBe(uploadTimeoutMs(file.size));
});
