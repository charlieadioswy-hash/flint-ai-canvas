import localforage from "localforage";
import { withBrowserStorageLock } from "../../src/lib/browser-storage-lock";
import { localForageStorageForScope } from "../../src/lib/localforage-storage";
import { scopedStorageKey } from "../../src/lib/user-scope";

const scope = "browser-storage-lock-check";
const storage = () => localForageStorageForScope(scope);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export { withBrowserStorageLock, sleep };
export const ready = localforage.ready();
export const consumer = async () => {
    const originalGet = IDBObjectStore.prototype.get;
    const timings: { namespace: string; heldMs: number }[] = [];
    const observed = new WeakSet<IDBTransaction>();
    IDBObjectStore.prototype.get = function(...args: Parameters<IDBObjectStore["get"]>) {
        const request = originalGet.apply(this, args);
        if (this.name === "mutex" && !observed.has(this.transaction)) {
            observed.add(this.transaction);
            let acquired = 0;
            request.addEventListener("success", () => { acquired = performance.now(); }, { once: true });
            const namespace = this.transaction.db.name;
            this.transaction.addEventListener("complete", () => timings.push({ namespace, heldMs: performance.now() - acquired }));
        }
        return request;
    };
    try { return { ...await (await import("./http-generation-browser-fixture")).runHTTPGenerationConsumer(), timings }; }
    finally { IDBObjectStore.prototype.get = originalGet; }
};
export async function cpuSample(mode: "get" | "getKey" | "batch32") {
    const originalGet = IDBObjectStore.prototype.get;
    const originalGetKey = IDBObjectStore.prototype.getKey;
    let requestCount = 0;
    IDBObjectStore.prototype.get = function(key: IDBValidKey | IDBKeyRange) {
        if (this.name !== "mutex") return originalGet.call(this, key);
        if (mode === "get") { requestCount++; return originalGet.call(this, key); }
        let request!: IDBRequest;
        for (let index = 0; index < (mode === "batch32" ? 32 : 1); index++) {
            requestCount++;
            request = originalGetKey.call(this, key);
        }
        return request;
    };
    try { await withBrowserStorageLock("canvas-storage", "cpu-sample", async () => sleep(2000)); return requestCount; }
    finally { IDBObjectStore.prototype.get = originalGet; }
}
export const read = (key: string) => storage().getItem(key);
export const write = (key: string, value: string) => withBrowserStorageLock("canvas-storage", key, (guard) => localForageStorageForScope(scope, guard).setItem(key, value) as Promise<void>);
export const compete = (key: string, value: string) => withBrowserStorageLock("canvas-storage", key, async (guard) => {
    const guarded = localForageStorageForScope(scope, guard);
    const before = await guarded.getItem(key);
    await guarded.setItem(key, value);
    return { before, after: value };
});

type AbortCase = {
    key: string;
    kind: string;
    phase: string;
    events: string[];
    dataTransactions: number;
    dataAborted: boolean;
    mutex?: IDBTransaction;
    resume(): void;
    settled: Promise<string>;
    callbackSettled: Promise<string>;
};
let active: AbortCase | undefined;
export const status = () => active && ({ phase: active.phase, events: active.events, dataTransactions: active.dataTransactions, dataAborted: active.dataAborted });
export const abortMutex = () => { active!.events.push("mutex-aborted"); active!.mutex!.abort(); };
export const resume = () => active!.resume();
export const settled = () => active!.settled;
export const callbackSettled = () => active!.callbackSettled;

export function beginAbortCase(key: string, kind: "suspended" | "delayed-ready" | "started-write") {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let finishCallback!: (value: string) => void;
    const callbackSettled = new Promise<string>((resolve) => { finishCallback = resolve; });
    const transaction = IDBDatabase.prototype.transaction;
    const originalReady = localforage.ready;
    const originalPut = IDBObjectStore.prototype.put;
    const current: AbortCase = active = { key, kind, phase: "queued", events: [], dataTransactions: 0, dataAborted: false, resume, settled: Promise.resolve("pending"), callbackSettled };
    IDBDatabase.prototype.transaction = function(...args: Parameters<IDBDatabase["transaction"]>) {
        const result = transaction.apply(this, args);
        if (this.name === "yingce:browser-storage-locks:canvas-storage") current.mutex = result;
        if (this.name === "yingce") {
            current.dataTransactions++;
            result.addEventListener("abort", () => { current.dataAborted = true; current.events.push("data-aborted"); });
        }
        return result;
    } as IDBDatabase["transaction"];
    if (kind === "delayed-ready") localforage.ready = (() => {
        current.phase = "delayed-ready";
        return gate.then(() => originalReady.call(localforage));
    }) as typeof localforage.ready;
    if (kind === "started-write") IDBObjectStore.prototype.put = function(...args: Parameters<IDBObjectStore["put"]>) {
        const result = originalPut.apply(this, args);
        if (this.name === "app_state" && args[1] === scopedStorageKey(key, scope)) {
            current.phase = "data-started";
            current.events.push("data-started");
            const keepAlive = () => {
                const request = this.get(args[1]!);
                request.onsuccess = () => keepAlive();
            };
            keepAlive();
        }
        return result;
    };
    current.settled = withBrowserStorageLock("canvas-storage", key, async (guard) => {
        current.phase = "entered";
        try {
            if (kind === "suspended") await gate;
            await localForageStorageForScope(scope, guard).setItem(key, "stale");
            finishCallback("resolved");
        } catch (error) {
            finishCallback("rejected");
            throw error;
        } finally {
            IDBDatabase.prototype.transaction = transaction;
            IDBObjectStore.prototype.put = originalPut;
            localforage.ready = originalReady;
        }
    }).then(() => "resolved", () => "rejected");
}

// Same production data store, but a deliberately slow read/modify/write callback.
export const state = async (value?: { count: number; active: boolean }) => {
    if (value) { await storage().setItem("counter", JSON.stringify(value)); return value; }
    const valueString = await storage().getItem("counter");
    return valueString ? JSON.parse(valueString) : undefined;
};
export const increment = (count: number) => Promise.all(Array.from({ length: count }, () => withBrowserStorageLock("generation-effect", "same-key", async () => {
    const before = await state() || { count: 0, active: false };
    if (before.active) throw new Error("overlapping callbacks");
    await state({ ...before, active: true });
    await sleep(15);
    await state({ count: before.count + 1, active: false });
})));
