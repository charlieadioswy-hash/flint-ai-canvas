import { afterEach, beforeEach, expect, test } from "bun:test";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { AxiosError, type InternalAxiosRequestConfig } from "axios";

import { buildIrregularScreenTemplate } from "../src/lib/canvas/irregular-screen-domain";
import { canvasContentHash } from "../src/lib/canvas/canvas-content";
import { loadScreenCreationEntry } from "../src/pages/screen-creation/screen-creation-session";
import { screenCreationScenesQueryOptions } from "../src/pages/screen-creation/use-screen-creation-scenes";
import { apiClient, ApiError } from "../src/services/api/request";
import type { CanvasLibrarySummary } from "../src/services/api/user-data";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";

const originalAdapter = apiClient.defaults.adapter;
const clients: QueryClient[] = [];
const subscriptions: Array<() => void> = [];

beforeEach(() => {
    apiClient.defaults.adapter = async () => {
        throw new Error("Unexpected HTTP request in scene test");
    };
});

afterEach(() => {
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    for (const client of clients.splice(0)) client.clear();
    apiClient.defaults.adapter = originalAdapter;
});

function scene(id: string, updatedAt = "2026-10-01T00:00:00Z"): CanvasProject {
    const template = buildIrregularScreenTemplate({
        controlImage: { storageKey: "resource:original", width: 1024, height: 1024 },
        outputMask: { storageKey: "resource:mask", width: 1024, height: 1024 },
        prompt: "水下世界",
        size: "1024x1024",
        modelSelection: { kind: "channel", channelId: "screen-channel", modelKey: "screen" },
        controlParameters: { preprocessor: "canny", model: "control-model", strength: 0.9, start: 0, end: 0.9, pixelPerfect: true, controlMode: "balanced", resizeMode: "stretch", canny: { resolution: 1024, lowThreshold: 100, highThreshold: 200 } },
    });
    return {
        id,
        revision: 1,
        title: id,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt,
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "dots",
        showImageInfo: true,
        viewport: { x: 0, y: 0, k: 1 },
        previsScenes: [],
        ...template,
    };
}

function summaries(projects: readonly CanvasProject[]): CanvasLibrarySummary[] {
    return projects.map(({ id, title, revision, createdAt, updatedAt, nodes }) => ({ id, title, revision, createdAt, updatedAt, nodeCount: nodes.length, previewNodes: [] }));
}

function response(config: InternalAxiosRequestConfig, data: unknown, status = 200, reason?: string, code = status === 200 ? 0 : status) {
    const result = { config, status, statusText: "", headers: {}, data: { code, data, msg: status === 200 ? "ok" : "读取失败", ...(reason ? { reason } : {}) } };
    if (status >= 400) throw new AxiosError("HTTP read failed", AxiosError.ERR_BAD_RESPONSE, config, undefined, result);
    return result;
}

function queryClient() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    clients.push(client);
    return client;
}

function observeScenes(userId: string, client = queryClient()) {
    const observer = new InfiniteQueryObserver(client, { ...screenCreationScenesQueryOptions(userId), enabled: false });
    subscriptions.push(observer.subscribe(() => undefined));
    return observer;
}

function entryOptions(projects: CanvasProject[], remoteScenes = summaries(projects)) {
    return { projects, remoteScenes, userId: "account-a", activeScope: "account-a", userHydrated: true, canvasHydrated: true, newScene: false };
}

test("scene pagination exposes entries after the first 40 and stops at the final page", async () => {
    const projects = summaries(Array.from({ length: 45 }, (_, index) => scene(`scene-${index + 1}`)));
    const pages: number[] = [];
    apiClient.defaults.adapter = async (config) => {
        expect(config.url).toBe("/canvas-projects");
        expect(config.params).toMatchObject({ pageSize: 40, sort: "updated", sceneKind: "irregular-screen" });
        const page = Number(config.params.page);
        pages.push(page);
        return response(config, { projects: projects.slice((page - 1) * 40, page * 40), page, pageSize: 40, total: projects.length, hasMore: page * 40 < projects.length });
    };
    const observer = observeScenes("account-a");
    const first = await observer.refetch();
    expect(first.data?.pages.flatMap((page) => page.projects)).toHaveLength(40);
    expect(first.hasNextPage).toBe(true);

    const second = await observer.fetchNextPage();
    expect(second.data?.pages.flatMap((page) => page.projects).map((project) => project.id)).toEqual(projects.map((project) => project.id));
    expect(second.data?.pageParams).toEqual([1, 2]);
    expect(second.hasNextPage).toBe(false);
    await observer.fetchNextPage();
    expect(pages).toEqual([1, 2]);
});

test("a failed next page preserves earlier scenes and retries the same page", async () => {
    const projects = summaries(Array.from({ length: 41 }, (_, index) => scene(`scene-${index + 1}`)));
    const pages: number[] = [];
    let failNextPage = true;
    apiClient.defaults.adapter = async (config) => {
        const page = Number(config.params.page);
        pages.push(page);
        if (page === 2 && failNextPage) {
            failNextPage = false;
            return response(config, null, 503, "unavailable");
        }
        return response(config, { projects: projects.slice((page - 1) * 40, page * 40), page, pageSize: 40, total: projects.length, hasMore: page === 1 });
    };
    const observer = observeScenes("account-a");
    const first = await observer.refetch();
    const failed = await observer.fetchNextPage();
    expect(failed.isFetchNextPageError).toBe(true);
    expect(failed.error).toMatchObject({ status: 503, reason: "unavailable" });
    expect(failed.data).toEqual(first.data);
    expect(failed.hasNextPage).toBe(true);

    const retried = await observer.fetchNextPage();
    expect(retried.isFetchNextPageError).toBe(false);
    expect(retried.data?.pages.flatMap((page) => page.projects)).toHaveLength(41);
    expect(retried.data?.pageParams).toEqual([1, 2]);
    expect(retried.hasNextPage).toBe(false);
    expect(pages).toEqual([1, 2, 2]);
});

test("scene query pages are isolated by account in the same query client", async () => {
    const client = queryClient();
    let activeAccount = "account-a";
    apiClient.defaults.adapter = async (config) => response(config, { projects: summaries([scene(`${activeAccount}-scene`)]), page: 1, pageSize: 40, total: 1, hasMore: false });
    const accountA = observeScenes("account-a", client);
    await accountA.refetch();
    activeAccount = "account-b";
    const accountB = observeScenes("account-b", client);
    expect(accountB.getCurrentResult().data).toBeUndefined();
    await accountB.refetch();

    expect(screenCreationScenesQueryOptions("account-a").queryKey).not.toEqual(screenCreationScenesQueryOptions("account-b").queryKey);
    expect(accountA.getCurrentResult().data?.pages[0].projects[0].id).toBe("account-a-scene");
    expect(accountB.getCurrentResult().data?.pages[0].projects[0].id).toBe("account-b-scene");
    const reopenedA = observeScenes("account-a", client);
    expect(reopenedA.getCurrentResult().data?.pages[0].projects[0].id).toBe("account-a-scene");
});

test("repeated automatic entry skips a deleted cached scene and preserves its local content", async () => {
    const deleted = scene("deleted", "2026-10-03T00:00:00Z");
    const available = scene("available", "2026-10-02T00:00:00Z");
    const projects = [deleted, available];
    const original = structuredClone(projects);
    const requests: string[] = [];
    apiClient.defaults.adapter = async (config) => {
        const id = config.url!.split("/").at(-1)!;
        requests.push(id);
        return id === deleted.id ? response(config, null, 404, "not_found") : response(config, { project: available });
    };

    for (let attempt = 0; attempt < 2; attempt++) {
        await expect(loadScreenCreationEntry(entryOptions(projects, summaries([available])), new AbortController().signal)).resolves.toEqual({ canvasId: available.id });
    }
    expect(requests).toEqual(["deleted", "available", "deleted", "available"]);
    expect(projects).toEqual(original);
    expect(projects[0]).toBe(deleted);
});

test("entry returns an empty scene when every cached and remote candidate is gone", async () => {
    const projects = [scene("cached", "2026-10-02T00:00:00Z")];
    const original = structuredClone(projects);
    const requests: string[] = [];
    apiClient.defaults.adapter = async (config) => {
        requests.push(config.url!);
        return response(config, null, 404, "not_found");
    };
    const remoteScenes = summaries([scene("remote", "2026-10-03T00:00:00Z")]);
    await expect(loadScreenCreationEntry(entryOptions(projects, remoteScenes), new AbortController().signal)).resolves.toEqual({});
    expect(requests).toEqual(["/canvas-projects/remote", "/canvas-projects/cached"]);
    expect(projects).toEqual(original);
});

test("a never-uploaded revision zero draft resumes without a remote read or mutation", async () => {
    const draft = { ...scene("local-draft"), revision: 0 };
    const projects = [draft];
    const original = structuredClone(projects);
    let requests = 0;
    apiClient.defaults.adapter = async () => {
        requests++;
        throw new Error("Unuploaded drafts must not be requested remotely");
    };
    await expect(loadScreenCreationEntry(entryOptions(projects, []), new AbortController().signal)).resolves.toEqual({ canvasId: draft.id });
    expect(requests).toBe(0);
    expect(projects).toEqual(original);
});

test("an offline edit outside the loaded remote page resumes without replacing local content", async () => {
    const cloud = scene("offline-edited", "2026-10-01T00:00:00Z");
    const local = { ...cloud, title: "尚未上传的本地修改", updatedAt: "2026-10-04T00:00:00Z", remoteContentHash: await canvasContentHash(cloud) };
    const projects = [local];
    const original = structuredClone(projects);
    const controller = new AbortController();
    const requests: string[] = [];
    apiClient.defaults.adapter = async (config) => {
        requests.push(config.url!);
        expect(config.signal).toBe(controller.signal);
        return response(config, { project: cloud });
    };
    expect(await canvasContentHash(local)).not.toBe(local.remoteContentHash);
    await expect(loadScreenCreationEntry(entryOptions(projects, summaries([scene("listed", "2026-10-03T00:00:00Z")])), controller.signal)).resolves.toEqual({ canvasId: local.id });
    expect(requests).toEqual(["/canvas-projects/offline-edited"]);
    expect(projects).toEqual(original);
    expect(projects[0]).toBe(local);
});

for (const failure of [
    { name: "network error", status: undefined, code: undefined, reason: undefined },
    { name: "permission error", status: 403, code: 403, reason: "forbidden" },
    { name: "storage error", status: 500, code: 500, reason: "internal" },
    { name: "unstructured 404", status: 404, code: 404, reason: undefined },
    { name: "different 404 reason", status: 404, code: 404, reason: "route_missing" },
    { name: "different 404 business code", status: 404, code: 400, reason: "not_found" },
    { name: "404 business code with HTTP 200", status: 200, code: 404, reason: "not_found" },
]) {
    test(`entry surfaces ${failure.name} instead of silently skipping the candidate`, async () => {
        const projects = [scene("first", "2026-10-03T00:00:00Z"), scene("second", "2026-10-02T00:00:00Z")];
        const requests: string[] = [];
        apiClient.defaults.adapter = async (config) => {
            requests.push(config.url!);
            if (failure.status === undefined) throw new AxiosError("offline", AxiosError.ERR_NETWORK, config);
            return response(config, null, failure.status, failure.reason, failure.code);
        };
        const pending = loadScreenCreationEntry(entryOptions(projects), new AbortController().signal);
        await expect(pending).rejects.toBeInstanceOf(ApiError);
        await expect(pending).rejects.toMatchObject({ status: failure.status, code: failure.code, reason: failure.reason });
        expect(requests).toEqual(["/canvas-projects/first"]);
    });
}

test("an already aborted entry does not request any scene", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(loadScreenCreationEntry(entryOptions([scene("first")]), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});

test("aborting an in-flight missing candidate stops the next scene request", async () => {
    const controller = new AbortController();
    const requests: string[] = [];
    let started!: () => void;
    let release!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const holdResponse = new Promise<void>((resolve) => { release = resolve; });
    apiClient.defaults.adapter = async (config) => {
        expect(config.signal).toBe(controller.signal);
        requests.push(config.url!);
        started();
        await holdResponse;
        return response(config, null, 404, "not_found");
    };
    const projects = [scene("first", "2026-10-03T00:00:00Z"), scene("second", "2026-10-02T00:00:00Z")];
    const pending = loadScreenCreationEntry(entryOptions(projects), controller.signal);
    await requestStarted;
    controller.abort();
    release();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toEqual(["/canvas-projects/first"]);
});
