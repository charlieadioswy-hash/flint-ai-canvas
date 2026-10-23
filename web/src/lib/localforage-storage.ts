import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

import { isUserScopedPersistenceSuppressed, scopedStorageKey } from "@/lib/user-scope";
import type { BrowserStorageLockGuard } from "@/lib/browser-storage-lock";

localforage.config({
    name: "yingce",
    storeName: "app_state",
});

// localforage 需要 localStorage / indexedDB 等浏览器存储驱动；测试进程等环境可能只有 window 而无存储 API，
// 此时直接跳过读写，避免 localforage 内部回退并输出 "No available storage method found"。
function browserStorageAvailable(): boolean {
    if (typeof window === "undefined") return false;
    return typeof window.localStorage !== "undefined" || typeof window.indexedDB !== "undefined";
}

/** Start the actual data transaction synchronously after checking the mutex.
 * Calling localforage.setItem after a check is insufficient: its internal ready()
 * may resume and create the transaction after the mutex was lost. Transactions
 * already started here precede competing readers of the same app_state store.
 */
async function guardedStorageRequest<T>(key: string, guard: BrowserStorageLockGuard, mode: IDBTransactionMode, requestFor: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    guard.assertHeld();
    await localforage.ready();
    guard.assertHeld();
    if (localforage.driver() !== localforage.INDEXEDDB) throw new Error("跨页面存储互斥需要 IndexedDB 数据存储");
    const { name, storeName } = localforage.config();
    if (!name || !storeName) throw new Error("IndexedDB 数据存储配置无效");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => request.transaction?.abort();
        request.onsuccess = () => resolve(request.result);
    });
    try {
        guard.assertHeld();
        return await new Promise<T>((resolve, reject) => {
            // No await between the guard and transaction/request creation.
            guard.assertHeld();
            const transaction = database.transaction(storeName, mode);
            const request = requestFor(transaction.objectStore(storeName));
            const abort = () => { try { transaction.abort(); } catch { /* Already committed/aborted. */ } };
            guard.signal.addEventListener("abort", abort, { once: true });
            const release = () => guard.signal.removeEventListener("abort", abort);
            transaction.onabort = () => { release(); reject(transaction.error || new Error(`IndexedDB 存储事务中断：${key}`)); };
            transaction.oncomplete = () => {
                release();
                try { guard.assertHeld(); resolve(request.result); } catch (error) { reject(error); }
            };
        });
    } finally {
        database.close();
    }
}

export function localForageStorageForScope(scope?: string, guard?: BrowserStorageLockGuard): StateStorage {
    const keyFor = (name: string) => scopedStorageKey(name, scope);
    return {
        getItem: async (name) => {
            if (guard) return (await guardedStorageRequest(keyFor(name), guard, "readonly", (store) => store.get(keyFor(name)))) || null;
            if (!browserStorageAvailable()) return null;
            return (await localforage.getItem<string>(keyFor(name))) || null;
        },
        setItem: async (name, value) => {
            if (guard) {
                guard.assertHeld();
                if (!isUserScopedPersistenceSuppressed()) await guardedStorageRequest(keyFor(name), guard, "readwrite", (store) => store.put(value, keyFor(name)));
                return;
            }
            if (!browserStorageAvailable()) return;
            if (isUserScopedPersistenceSuppressed()) return;
            await localforage.setItem(keyFor(name), value);
        },
        removeItem: async (name) => {
            if (guard) {
                guard.assertHeld();
                if (!isUserScopedPersistenceSuppressed()) await guardedStorageRequest(keyFor(name), guard, "readwrite", (store) => store.delete(keyFor(name)));
                return;
            }
            if (!browserStorageAvailable()) return;
            if (isUserScopedPersistenceSuppressed()) return;
            await localforage.removeItem(keyFor(name));
        },
    };
}

export const localForageStorage: StateStorage = localForageStorageForScope();
