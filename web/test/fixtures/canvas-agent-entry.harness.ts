import { beforeEach, expect, mock, spyOn, test } from "bun:test";

let scope = "scope-a";
let user: { id: string; authorization?: string } | null = { id: "user-a" };
mock.module("@/lib/user-scope", () => ({ getActiveUserScope: () => scope }));
mock.module("@/stores/use-user-store", () => ({ useUserStore: { getState: () => ({ user }) } }));

const { queueCanvasAgentEntry, takeCanvasAgentEntry } = await import("@/services/canvas-agent-entry");

beforeEach(() => {
    scope = "scope-a";
    user = { id: "user-a" };
});

function draft(text = "雨夜的街道，镜头缓慢推进") {
    return { text, skillIds: ["skill-storyboard"], files: [{ id: "reference-1", file: new File(["reference image"], "reference.png", { type: "image/png" }) }] };
}

test("同账号同画布一次取走草稿，保留交接身份与File引用并快照数组", () => {
    const input = draft();
    const file = input.files[0].file;
    queueCanvasAgentEntry("canvas-once", input);
    input.text = "排队后修改的原输入";
    input.skillIds.push("skill-later");
    input.files.push({ id: "reference-later", file: new File(["later"], "later.png") });

    const handoff = takeCanvasAgentEntry("canvas-once");
    expect(handoff).toMatchObject({ canvasId: "canvas-once", scope: "scope-a", userId: "user-a", text: "雨夜的街道，镜头缓慢推进", skillIds: ["skill-storyboard"] });
    expect(handoff?.files).toHaveLength(1);
    expect(handoff?.files[0].file).toBe(file);
    expect(takeCanvasAgentEntry("canvas-once")).toBeNull();
});

test("错误画布不能取走其他画布草稿，多个画布各自交接", () => {
    queueCanvasAgentEntry("canvas-first", draft("第一个画布"));
    queueCanvasAgentEntry("canvas-second", draft("第二个画布"));
    expect(takeCanvasAgentEntry("canvas-missing")).toBeNull();
    expect(takeCanvasAgentEntry("canvas-second")?.text).toBe("第二个画布");
    expect(takeCanvasAgentEntry("canvas-first")?.text).toBe("第一个画布");
    expect(takeCanvasAgentEntry("canvas-second")).toBeNull();
});

test("账号变化即使scope未同步也拒绝交接，原账号不能再次恢复被拒草稿", () => {
    queueCanvasAgentEntry("canvas-user-boundary", draft());
    user = { id: "user-b" };
    expect(takeCanvasAgentEntry("canvas-user-boundary")).toBeNull();
    user = { id: "user-a" };
    expect(takeCanvasAgentEntry("canvas-user-boundary")).toBeNull();
});

test("scope变化即使账号未同步也拒绝交接，恢复scope不能复用旧草稿", () => {
    queueCanvasAgentEntry("canvas-scope-boundary", draft());
    scope = "scope-b";
    expect(takeCanvasAgentEntry("canvas-scope-boundary")).toBeNull();
    scope = "scope-a";
    expect(takeCanvasAgentEntry("canvas-scope-boundary")).toBeNull();
});

test("未登录或缺少画布ID不能排队，注销后不能取走旧草稿", () => {
    expect(() => queueCanvasAgentEntry("", draft())).toThrow("请登录后创建画布");
    queueCanvasAgentEntry("canvas-logout", draft());
    user = null;
    expect(() => queueCanvasAgentEntry("canvas-anonymous", draft())).toThrow("请登录后创建画布");
    expect(takeCanvasAgentEntry("canvas-logout")).toBeNull();
    user = { id: "user-a" };
    expect(takeCanvasAgentEntry("canvas-anonymous")).toBeNull();
    expect(takeCanvasAgentEntry("canvas-logout")).toBeNull();
});

test("交接仅在十分钟有效期内可取，达到或超过过期时间即丢弃", () => {
    let now = 100_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
        queueCanvasAgentEntry("canvas-before-expiry", draft());
        queueCanvasAgentEntry("canvas-at-expiry", draft());
        queueCanvasAgentEntry("canvas-after-expiry", draft());
        now += 10 * 60_000 - 1;
        expect(takeCanvasAgentEntry("canvas-before-expiry")).not.toBeNull();
        now += 1;
        expect(takeCanvasAgentEntry("canvas-at-expiry")).toBeNull();
        now += 1;
        expect(takeCanvasAgentEntry("canvas-after-expiry")).toBeNull();
        now = 100_000;
        expect(takeCanvasAgentEntry("canvas-at-expiry")).toBeNull();
        expect(takeCanvasAgentEntry("canvas-after-expiry")).toBeNull();
    } finally {
        clock.mockRestore();
    }
});

test("交接只保存在内存，不写storage或history，也不携带额外凭据字段", () => {
    const storage = { getItem: mock(() => null), setItem: mock(() => undefined), removeItem: mock(() => undefined) };
    const history = { pushState: mock(() => undefined), replaceState: mock(() => undefined) };
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({ localStorage: storage, sessionStorage: storage, history, window: { localStorage: storage, sessionStorage: storage, history } })) {
        originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    try {
        user = { id: "user-a", authorization: "test-only-session-credential" };
        const input = { ...draft(), apiKey: "test-only-api-key", authorization: "test-only-authorization" };
        queueCanvasAgentEntry("canvas-memory-only", input);
        const handoff = takeCanvasAgentEntry("canvas-memory-only");
        expect(Object.keys(handoff || {}).sort()).toEqual(["canvasId", "files", "scope", "skillIds", "text", "userId"]);
        expect(JSON.stringify(handoff)).not.toContain("test-only");
        expect(storage.getItem).not.toHaveBeenCalled();
        expect(storage.setItem).not.toHaveBeenCalled();
        expect(storage.removeItem).not.toHaveBeenCalled();
        expect(history.pushState).not.toHaveBeenCalled();
        expect(history.replaceState).not.toHaveBeenCalled();
    } finally {
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
});
