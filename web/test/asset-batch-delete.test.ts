import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { QueryObserver } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import localforage from "localforage";

import { apiClient } from "@/services/api/request";
import { deleteAssetsWithRemoteSync, emptyAssetTrashWithRemoteSync, initializeRemoteUserDataSession, loadAssetLibraryPage, loadAssetsForUse, resetRemoteUserDataSync, saveRemoteUserDataNow } from "@/services/user-data-sync";
import { flushAssetStorePersistence, useAssetStore, type Asset } from "@/stores/use-asset-store";
import { appQueryClient } from "@/lib/query-client";

const originalAdapter = apiClient.defaults.adapter;
let originalWindow: PropertyDescriptor | undefined;
const originalGet = localforage.getItem;
const originalSet = localforage.setItem;
const originalRemove = localforage.removeItem;
async function within<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("删除或刷新链路未结束")), 1000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
const asset = (id: string): Asset =>
    ({
        id,
        kind: "text",
        title: id,
        coverUrl: "",
        tags: [],
        createdAt: "2026-09-21T00:00:00.000Z",
        updatedAt: "2026-09-21T00:00:00.000Z",
        data: { content: "测试素材" },
    }) as Asset;

beforeEach(async () => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const storage = new Map<string, string>();
    const indexed = new Map<string, unknown>();
    localforage.getItem = (async (key: string) => indexed.get(key) ?? null) as typeof localforage.getItem;
    localforage.setItem = (async (key: string, value: unknown) => {
        indexed.set(key, value);
        return value;
    }) as typeof localforage.setItem;
    localforage.removeItem = async (key: string) => {
        indexed.delete(key);
    };
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            setTimeout: globalThis.setTimeout,
            clearTimeout: globalThis.clearTimeout,
            localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
        },
    });
    useAssetStore.setState({ assets: [] });
    await flushAssetStorePersistence();
    await initializeRemoteUserDataSession("batch-test-user");
});

afterEach(async () => {
    try {
        await appQueryClient.cancelQueries();
        appQueryClient.clear();
        apiClient.defaults.adapter = originalAdapter;
        resetRemoteUserDataSync();
        useAssetStore.setState({ assets: [] });
        await flushAssetStorePersistence();
    } finally {
        localforage.getItem = originalGet;
        localforage.setItem = originalSet;
        localforage.removeItem = originalRemove;
        if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
        else delete (globalThis as { window?: unknown }).window;
    }
});

describe("素材批量删除", () => {
    test("未建立登录同步会话时清空不发远端请求，也不删除本地缓存", async () => {
        resetRemoteUserDataSync();
        const archived = { ...asset("local-only"), status: "archived" as const };
        useAssetStore.setState({ assets: [archived] });
        let requests = 0;
        apiClient.defaults.adapter = async () => {
            requests++;
            throw new Error("不应发出请求");
        };
        await expect(emptyAssetTrashWithRemoteSync()).rejects.toThrow("云端同步会话尚未建立");
        expect(requests).toBe(0);
        expect(useAssetStore.getState().assets).toEqual([archived]);
    });

    test("清空先收集未筛选的全部归档页，再分批删除，保留服务端活跃但本地过期归档的素材", async () => {
        const archived = Array.from({ length: 1201 }, (_, i) => ({ ...asset(`archived-${i}`), status: "archived" as const }));
        const active = { ...asset("active"), status: "confirmed" as const };
        useAssetStore.setState({ assets: [archived[0], { ...active, status: "archived" }] });
        await initializeRemoteUserDataSession("batch-test-user");
        const pages: number[] = [];
        const batches: string[][] = [];
        apiClient.defaults.adapter = async (config) => {
            let data: unknown;
            if (config.method === "get") {
                const page = config.params.page;
                expect(config.params).toEqual({ page, pageSize: 120, status: "archived" });
                pages.push(page);
                const start = (page - 1) * 120;
                data = { assets: archived.slice(start, start + 120), total: archived.length, hasMore: start + 120 < archived.length };
            } else {
                expect(pages).toHaveLength(11);
                expect(config.url).toBe("/assets/batch-delete");
                expect(config.params).toEqual({ status: "archived" });
                const ids: string[] = JSON.parse(config.data);
                batches.push(ids);
                data = { ids };
            }
            return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data, msg: "ok" } };
        };
        expect(await emptyAssetTrashWithRemoteSync()).toBe(1201);
        expect(pages).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
        expect(batches.map((ids) => ids.length)).toEqual([1000, 201]);
        expect(batches.flat()).toEqual(archived.map((item) => item.id));
        expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual(["active"]);
    });

    test("列举后的还原冲突不会删除本地素材或报告清空成功", async () => {
        const archived = { ...asset("restored"), status: "archived" as const };
        useAssetStore.setState({ assets: [archived] });
        await initializeRemoteUserDataSession("batch-test-user");
        apiClient.defaults.adapter = async (config) => {
            if (config.method === "get") return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { assets: [archived], hasMore: false }, msg: "ok" } };
            return { config, headers: {}, status: 409, statusText: "Conflict", data: { code: 409, data: null, msg: "素材已还原" } };
        };
        await expect(emptyAssetTrashWithRemoteSync()).rejects.toThrow("素材已还原");
        expect(useAssetStore.getState().assets).toEqual([archived]);
    });

    test("任一归档页读取失败时不开始删除", async () => {
        const archived = { ...asset("keep"), status: "archived" as const };
        useAssetStore.setState({ assets: [archived] });
        await initializeRemoteUserDataSession("batch-test-user");
        const methods: string[] = [];
        apiClient.defaults.adapter = async (config) => {
            methods.push(config.method!);
            if (config.params.page === 2) throw new Error("第二页读取失败");
            return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { assets: [archived], hasMore: true }, msg: "ok" } };
        };
        await expect(emptyAssetTrashWithRemoteSync()).rejects.toThrow("第二页读取失败");
        expect(methods).toEqual(["get", "get"]);
        expect(useAssetStore.getState().assets).toEqual([archived]);
    });

    test("后续删除批次失败时只移除已确认成功的本地项，整次清空仍报告失败", async () => {
        const archived = Array.from({ length: 1001 }, (_, i) => ({ ...asset(`archived-${i}`), status: "archived" as const }));
        useAssetStore.setState({ assets: [archived[0], archived[1000], asset("keep")] });
        await initializeRemoteUserDataSession("batch-test-user");
        const batches: number[] = [];
        apiClient.defaults.adapter = async (config) => {
            if (config.method === "get") {
                const start = (config.params.page - 1) * 120;
                return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { assets: archived.slice(start, start + 120), hasMore: start + 120 < archived.length }, msg: "ok" } };
            }
            const ids: string[] = JSON.parse(config.data);
            batches.push(ids.length);
            return batches.length === 1
                ? { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { ids }, msg: "ok" } }
                : { config, headers: {}, status: 409, statusText: "Conflict", data: { code: 409, data: null, msg: "素材已还原" } };
        };
        await expect(emptyAssetTrashWithRemoteSync()).rejects.toThrow("素材已还原");
        expect(batches).toEqual([1000, 1]);
        expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual(["archived-1000", "keep"]);
    });

    test("归档列举期间切换账号不继续删除，也不动新账号缓存", async () => {
        const methods: string[] = [];
        apiClient.defaults.adapter = async (config) => {
            methods.push(config.method!);
            resetRemoteUserDataSync();
            useAssetStore.setState({ assets: [asset("new-account")] });
            return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { assets: [{ ...asset("old-account"), status: "archived" }], hasMore: false }, msg: "ok" } };
        };
        await expect(emptyAssetTrashWithRemoteSync()).rejects.toThrow("账号已切换");
        expect(methods).toEqual(["get"]);
        expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual(["new-account"]);
    });

    test("清空前先同步本机待保存的还原，不把它列入归档删除集合", async () => {
        const archived = { ...asset("restoring"), status: "archived" as const };
        useAssetStore.setState({ assets: [archived] });
        await initializeRemoteUserDataSession("batch-test-user");
        useAssetStore.getState().updateAsset(archived.id, { status: "confirmed" });
        const methods: string[] = [];
        apiClient.defaults.adapter = async (config) => {
            methods.push(config.method!);
            if (config.url === "/assets/restoring") return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { asset: archived }, msg: "ok" } };
            if (config.method === "put") {
                const body = JSON.parse(config.data);
                expect(body.asset.status).toBe("confirmed");
                return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { asset: body.asset }, msg: "ok" } };
            }
            expect(methods).toEqual(["get", "put", "get"]);
            return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { assets: [], hasMore: false }, msg: "ok" } };
        };
        expect(await emptyAssetTrashWithRemoteSync()).toBe(0);
        expect(useAssetStore.getState().assets[0].status).toBe("confirmed");
    });

    test("100 个素材只发一个 POST 数组请求，成功后只更新一次本地素材集合", async () => {
        const ids = Array.from({ length: 100 }, (_, i) => `asset-${i}`);
        useAssetStore.setState({ assets: [...ids.map(asset), asset("keep")] });
        const requests: unknown[] = [];
        apiClient.defaults.adapter = async (config) => {
            requests.push({ method: config.method, url: config.url, body: JSON.parse(config.data) });
            expect(useAssetStore.getState().assets).toHaveLength(101);
            return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { ids }, msg: "ok" } };
        };
        let updates = 0;
        const stop = useAssetStore.subscribe((state, previous) => {
            if (state.assets !== previous.assets) updates++;
        });
        try {
            await deleteAssetsWithRemoteSync(ids);
            expect(requests).toEqual([{ method: "post", url: "/assets/batch-delete", body: ids }]);
            expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual(["keep"]);
            expect(updates).toBe(1);
        } finally {
            stop();
        }
    });

    test.each([false, true])("真实分页查询刷新不阻塞删除完成（刷新失败：%s）", async (failRefresh) => {
        const initialPage = {
            assets: [asset("first"), asset("keep")],
            total: 2,
            page: 1,
            pageSize: 20,
            kindCounts: {},
            categoryCounts: {},
            folderCounts: {},
            hasMore: false,
        };
        useAssetStore.setState({ assets: initialPage.assets });
        let releaseRefresh!: () => void;
        const refreshGate = new Promise<void>((resolve) => {
            releaseRefresh = resolve;
        });
        const requests: string[] = [];
        apiClient.defaults.adapter = async (config) => {
            requests.push(`${config.method} ${config.url}`);
            if (config.method === "post") {
                return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { ids: ["first"] }, msg: "ok" } };
            }
            await refreshGate;
            if (failRefresh) throw new Error("列表暂时不可用");
            return {
                config,
                headers: {},
                status: 200,
                statusText: "OK",
                data: {
                    code: 0,
                    data: { ...initialPage, assets: [asset("keep")], total: 1 },
                    msg: "ok",
                },
            };
        };
        const warning = spyOn(console, "warn").mockImplementation(() => {});
        const observers = ["asset-library", "asset-picker"].map(
            (key) =>
                new QueryObserver(appQueryClient, {
                    queryKey: [key, "delete-regression"],
                    queryFn: () => loadAssetLibraryPage({ page: 1, pageSize: 20 }),
                    initialData: initialPage,
                }),
        );
        const stops: (() => void)[] = [];
        const refreshed = observers.map(
            (observer) =>
                new Promise<void>((resolve) => {
                    stops.push(
                        observer.subscribe((result) => {
                            if (result.fetchStatus === "idle" && (result.isError || result.data?.total === 1)) resolve();
                        }),
                    );
                }),
        );
        try {
            // GET 尚未返回，删除必须已返回，调用方才能关闭 Modal / Popconfirm。
            await within(deleteAssetsWithRemoteSync(["first"]));
            expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual(["keep"]);
            expect(requests).toEqual(["post /assets/batch-delete", "get /assets", "get /assets"]);
            for (const observer of observers) expect(observer.getCurrentResult().fetchStatus).toBe("fetching");

            releaseRefresh();
            // 真实 loadAssetLibraryPage 要再次进入同步队列；不能与删除互相等待。
            await within(Promise.all(refreshed));
            for (const observer of observers) {
                const result = observer.getCurrentResult();
                if (failRefresh) expect(result.error?.message).toBe("列表暂时不可用");
                else expect(result.data?.assets.map((item) => item.id)).toEqual(["keep"]);
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (failRefresh) expect(warning).toHaveBeenCalledWith("素材删除后列表刷新失败", expect.any(Error));
            expect(requests.filter((request) => request.startsWith("post"))).toHaveLength(1);
        } finally {
            releaseRefresh();
            await appQueryClient.cancelQueries();
            stops.forEach((stop) => stop());
            observers.forEach((observer) => observer.destroy());
            warning.mockRestore();
        }
    });

    test("业务失败不会先删本地素材或回退到逐条请求", async () => {
        useAssetStore.setState({ assets: [asset("first"), asset("second")] });
        let requests = 0;
        apiClient.defaults.adapter = async (config) => {
            requests++;
            return { config, headers: {}, status: 200, statusText: "OK", data: { code: 400, data: null, msg: "拒绝删除", reason: "invalid_argument" } };
        };
        await expect(deleteAssetsWithRemoteSync(["first", "second"])).rejects.toThrow("拒绝删除");
        expect(requests).toBe(1);
        expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual(["first", "second"]);
    });

    test("跨页选中 ID 不依赖首屏本地缓存，全部提交到同一批量删除请求", async () => {
        useAssetStore.setState({ assets: [asset("page-1"), asset("keep")] });
        const ids = ["page-1", "page-2-a", "page-2-b"];
        const bodies: string[][] = [];
        apiClient.defaults.adapter = async (config) => {
            bodies.push(JSON.parse(config.data));
            return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { ids }, msg: "ok" } };
        };
        await deleteAssetsWithRemoteSync(ids);
        expect(bodies).toEqual([ids]);
        expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual(["keep"]);
    });

    test("分页未缓存素材补齐详情后，移入回收站同步全部选中项", async () => {
        const ids = ["page-1", "page-2-a", "page-2-b"];
        const remoteAssets = ids.map(asset);
        const writes: Asset[] = [];
        apiClient.defaults.adapter = async (config) => {
            const body = JSON.parse(config.data);
            if (config.url === "/assets/batch") {
                expect(body.ids).toEqual(ids);
                return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { assets: remoteAssets }, msg: "ok" } };
            }
            expect(config.method).toBe("put");
            writes.push(body.asset);
            return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { asset: body.asset }, msg: "ok" } };
        };
        await loadAssetsForUse(ids);
        for (const id of ids) useAssetStore.getState().updateAsset(id, { status: "archived" });
        await flushAssetStorePersistence();
        await saveRemoteUserDataNow();
        expect(writes.map((item) => item.id)).toEqual(ids);
        expect(writes.every((item) => item.status === "archived")).toBe(true);
    });

    test("服务端绑定图片后强制刷新已验证素材，保留本地标签编辑", async () => {
        const initial = { ...asset("scene"), category: "environment" as const, primaryVersionId: "v1" };
        let remote: Asset = initial;
        apiClient.defaults.adapter = async (config) => ({ config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { assets: [remote] }, msg: "ok" } });
        await loadAssetsForUse(["scene"]);
        useAssetStore.getState().updateAsset("scene", { tags: ["本地标签"] });
        remote = { ...initial, kind: "image", primaryVersionId: "v2", data: { dataUrl: "/api/resources/image/file", storageKey: "resource:image", width: 800, height: 600, bytes: 100, mimeType: "image/png" } };
        await loadAssetsForUse(["scene"], { refresh: true });
        expect(useAssetStore.getState().assets[0]).toMatchObject({ kind: "image", primaryVersionId: "v2", tags: ["本地标签"], data: { storageKey: "resource:image" } });
    });

    test("删除响应返回前切换账号，不删除新账号本地素材", async () => {
        useAssetStore.setState({ assets: [asset("same-id")] });
        apiClient.defaults.adapter = async (config) => {
            resetRemoteUserDataSync();
            useAssetStore.setState({ assets: [asset("same-id")] });
            return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { ids: ["same-id"] }, msg: "ok" } };
        };
        await expect(deleteAssetsWithRemoteSync(["same-id"])).rejects.toThrow("账号已切换");
        expect(useAssetStore.getState().assets).toHaveLength(1);
    });

    test("空 ID 不发请求，重复 ID 合并到一个请求", async () => {
        const bodies: string[][] = [];
        apiClient.defaults.adapter = async (config) => {
            const ids = JSON.parse(config.data);
            bodies.push(ids);
            return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { ids }, msg: "ok" } };
        };
        await expect(deleteAssetsWithRemoteSync(["good", " "])).rejects.toThrow("素材 ID 不能为空");
        expect(bodies).toHaveLength(0);
        await deleteAssetsWithRemoteSync([" first ", "first", "second"]);
        expect(bodies).toEqual([["first", "second"]]);
    });

    test("素材页和选择器的跨页批量入口使用数组同步方法", () => {
        const page = readFileSync(new URL("../src/pages/assets/index.tsx", import.meta.url), "utf8");
        const picker = readFileSync(new URL("../src/components/assets/asset-library-picker-modal.tsx", import.meta.url), "utf8");
        expect(page).toContain("const ids = [...selectedIds]");
        expect(page).toContain("deleteAssetsWithRemoteSync(ids)");
        expect(page).not.toContain("validAssets.filter((asset) => selectedIds.includes(asset.id))");
        expect(page).not.toContain("current.filter((id) => existingIds.has(id))");
        expect(page).toContain("count={selectedIds.length}");
        expect(picker).toContain("deleteAssetsWithRemoteSync(archivedSelectedIds)");
        expect(picker).toContain("deleteAssetsWithRemoteSync(toDelete.map");
    });
});
