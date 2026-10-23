export type BrowserStorageLockNamespace = "generation-effect" | "canvas-storage";
export type BrowserStorageLockGuard = { signal: AbortSignal; assertHeld(): void };
export type BrowserStorageLockedOperation<T> = (guard?: BrowserStorageLockGuard) => Promise<T>;

const DATABASE_NAME = "yingce:browser-storage-locks";
const STORE_NAME = "mutex";

function unavailable(cause?: unknown) {
    return new Error("当前浏览器无法建立跨页面存储互斥，请检查 IndexedDB 是否可用", { cause });
}

function openLockDatabase(namespace: BrowserStorageLockNamespace): Promise<IDBDatabase> {
    if (!globalThis.indexedDB) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
        let rejected = false;
        const request = indexedDB.open(`${DATABASE_NAME}:${namespace}`, 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(STORE_NAME);
        };
        request.onerror = () => reject(unavailable(request.error));
        request.onblocked = () => {
            rejected = true;
            reject(unavailable(new Error("锁数据库升级被其他页面阻止")));
        };
        request.onsuccess = () => {
            if (rejected) request.result.close();
            else resolve(request.result);
        };
    });
}

/**
 * IDB readwrite transactions serialize across realms without a stealable lease.
 * Each namespace has a separate database: effect records and nested canvas commits
 * must never hold transactions on the same store. Different keys in one namespace
 * are conservatively serialized. Separate databases also avoid an open request
 * waiting for a different namespace's active transaction. The protected data stays in localforage's
 * separate database, so its requests cannot wait behind this transaction.
 */
async function withIndexedDbLock<T>(namespace: BrowserStorageLockNamespace, key: string, operation: BrowserStorageLockedOperation<T>): Promise<T> {
    const database = await openLockDatabase(namespace);
    try {
        return await new Promise<T>((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, "readwrite");
            const store = transaction.objectStore(STORE_NAME);
            let started = false;
            let finished = false;
            let failed = false;
            let failure: unknown;
            let result: T;
            const controller = new AbortController();
            let held = true;
            const guard: BrowserStorageLockGuard = {
                signal: controller.signal,
                assertHeld() {
                    if (!held || controller.signal.aborted) throw unavailable(transaction.error);
                },
            };
            transaction.onabort = () => {
                held = false;
                controller.abort(unavailable(transaction.error));
                reject(unavailable(transaction.error));
            };
            transaction.oncomplete = () => {
                held = false;
                if (!finished) reject(unavailable(new Error("存储锁在操作完成前释放")));
                else if (failed) reject(failure);
                else resolve(result);
            };

            const keepAlive = () => {
                // Queue from the request event, while the transaction is active;
                // timers or awaiting an unrelated promise would release the lock.
                const request = store.get(key);
                request.onsuccess = () => {
                    if (!started) {
                        started = true;
                        void Promise.resolve().then(() => operation(guard)).then(
                            (value) => { result = value; finished = true; },
                            (error) => { failed = true; failure = error; finished = true; },
                        );
                    }
                    if (!finished) keepAlive();
                };
            };
            keepAlive();
        });
    } finally {
        database.close();
    }
}

export function withBrowserStorageLock<T>(namespace: BrowserStorageLockNamespace, key: string, operation: BrowserStorageLockedOperation<T>): Promise<T> {
    const locks = globalThis.navigator?.locks;
    if (locks) return locks.request(key, () => operation());
    return withIndexedDbLock(namespace, key, operation);
}
