import { afterEach, beforeEach, expect, test } from "bun:test";
import localforage from "localforage";

import { apiClient } from "@/services/api/request";
import { getRemoteUserDataSyncSessionSnapshot, initializeRemoteUserDataSession, resetRemoteUserDataSync, subscribeRemoteUserDataSyncSession, syncRemoteUserData } from "@/services/user-data-sync";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { flushAssetStorePersistence, useAssetStore } from "@/stores/use-asset-store";

const originalWindow = globalThis.window;
const originalAdapter = apiClient.defaults.adapter;
const originalGet = localforage.getItem;
const originalSet = localforage.setItem;
const originalRemove = localforage.removeItem;
const originalProjects = useCanvasStore.getState().projects;
const originalAssets = useAssetStore.getState().assets;
const scope = "remote-session-test";

beforeEach(async () => {
    resetRemoteUserDataSync();
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            setTimeout: () => 1,
            clearTimeout: () => undefined,
            localStorage: { getItem: () => scope, setItem: () => undefined },
        },
    });
    localforage.getItem = (async () => null) as typeof localforage.getItem;
    localforage.setItem = (async (_key: string, value: unknown) => value) as typeof localforage.setItem;
    localforage.removeItem = async () => undefined;
    useCanvasStore.setState({ projects: [] });
    useAssetStore.setState({ assets: [] });
    await initializeRemoteUserDataSession(scope);
});

afterEach(async () => {
    resetRemoteUserDataSync();
    useCanvasStore.setState({ projects: originalProjects });
    useAssetStore.setState({ assets: originalAssets });
    await Promise.all([flushCanvasStorePersistence(), flushAssetStorePersistence()]);
    apiClient.defaults.adapter = originalAdapter;
    localforage.getItem = originalGet;
    localforage.setItem = originalSet;
    localforage.removeItem = originalRemove;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

test("remote session observers wait for readiness and reset across accounts", async () => {
    const snapshots: ReturnType<typeof getRemoteUserDataSyncSessionSnapshot>[] = [];
    const unsubscribe = subscribeRemoteUserDataSyncSession(() => snapshots.push(getRemoteUserDataSyncSessionSnapshot()));
    try {
        const ready = getRemoteUserDataSyncSessionSnapshot();
        expect(ready).toEqual({ userId: scope, phase: "ready" });
        expect(getRemoteUserDataSyncSessionSnapshot()).toBe(ready);
        resetRemoteUserDataSync();
        await initializeRemoteUserDataSession("second-account");
        expect(snapshots).toEqual([
            { userId: "", phase: "inactive" },
            { userId: "second-account", phase: "ready" },
        ]);
        expect(ready).toEqual({ userId: scope, phase: "ready" });
        unsubscribe();
        resetRemoteUserDataSync();
        expect(snapshots).toHaveLength(2);
    } finally {
        unsubscribe();
    }
});

test("remote session observers distinguish snapshot failure from readiness", async () => {
    const snapshots: ReturnType<typeof getRemoteUserDataSyncSessionSnapshot>[] = [];
    const unsubscribe = subscribeRemoteUserDataSyncSession(() => snapshots.push(getRemoteUserDataSyncSessionSnapshot()));
    apiClient.defaults.adapter = async () => {
        throw new Error("snapshot unavailable");
    };
    try {
        await expect(syncRemoteUserData(scope)).rejects.toThrow("snapshot unavailable");
        expect(snapshots).toEqual([
            { userId: scope, phase: "hydrating" },
            { userId: scope, phase: "failed" },
        ]);
        expect(getRemoteUserDataSyncSessionSnapshot()).toBe(snapshots[1]!);
    } finally {
        unsubscribe();
    }
});
