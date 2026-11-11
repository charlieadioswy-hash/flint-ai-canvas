import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://localhost/projects/project" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { projectSidebarScope, useProjectSidebarIdle } = await import("@/components/layout/use-project-sidebar-idle");

let now = 0;
let timerId = 0;
const timers = new Map<number, { at: number; run: () => void }>();
browser.setTimeout = ((run: () => void, delay: number) => {
    const id = ++timerId;
    timers.set(id, { at: now + delay, run });
    return id;
}) as typeof browser.setTimeout;
browser.clearTimeout = ((id: number) => timers.delete(id)) as typeof browser.clearTimeout;

const mediaListeners = new Set<() => void>();
const media = {
    get matches() {
        return browser.innerWidth >= 1024;
    },
    addEventListener: (_event: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => mediaListeners.delete(listener),
};
browser.matchMedia = (() => media) as unknown as typeof browser.matchMedia;

async function advance(ms: number) {
    await act(() => {
        const end = now + ms;
        while (true) {
            const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            now = next[1].at;
            timers.delete(next[0]);
            next[1].run();
        }
        now = end;
    });
}

function Probe({ pathname }: { pathname: string }) {
    const { collapsed, enabled, interactionProps } = useProjectSidebarIdle(pathname);
    return (
        <>
            <aside {...interactionProps} data-collapsed={collapsed} data-enabled={enabled}>
                <button type="button">短剧制作</button>
                <input aria-label="菜单搜索" />
            </aside>
            <button type="button" data-outside>
                内容区
            </button>
        </>
    );
}

async function fixture(pathname = "/projects/project", width = 1440) {
    browser.innerWidth = width;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(() => root.render(<Probe pathname={pathname} />));
    const rail = host.querySelector("aside")!;
    return {
        host,
        rail,
        collapsed: () => rail.dataset.collapsed === "true",
        enabled: () => rail.dataset.enabled === "true",
        update: async (path: string) => await act(() => root.render(<Probe pathname={path} />)),
        resize: async (nextWidth: number) =>
            await act(() => {
                browser.innerWidth = nextWidth;
                mediaListeners.forEach((listener) => listener());
            }),
        close: async () => {
            await act(() => root.unmount());
            host.remove();
        },
    };
}

afterAll(() => {
    browser.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

test("只有具体短剧、引导和集制作路由启用", () => {
    for (const path of ["/projects/p", "/projects/p/", "/projects/p/guide", "/projects/p/e/ep"]) expect(projectSidebarScope(path)).toBe("p");
    for (const path of ["/", "/projects", "/projects/new", "/projects/new/guide", "/assets", "/projects/p/other"]) expect(projectSidebarScope(path)).toBeNull();
});

test("初始图文展开，满10秒才收起", async () => {
    const view = await fixture();
    try {
        expect(view.enabled()).toBe(true);
        expect(view.collapsed()).toBe(false);
        await advance(9_999);
        expect(view.collapsed()).toBe(false);
        await advance(1);
        expect(view.collapsed()).toBe(true);
    } finally {
        await view.close();
    }
});

test("悬停展开并保持，移出后重新等待10秒", async () => {
    const view = await fixture();
    try {
        await advance(10_000);
        await act(() => view.rail.dispatchEvent(new browser.MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })));
        expect(view.collapsed()).toBe(false);
        await advance(30_000);
        expect(view.collapsed()).toBe(false);
        await act(() => view.rail.dispatchEvent(new browser.MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
        await advance(9_999);
        expect(view.collapsed()).toBe(false);
        await advance(1);
        expect(view.collapsed()).toBe(true);
    } finally {
        await view.close();
    }
});

test("点击重置闲置时间，鼠标点击留下焦点不会永久阻止收起", async () => {
    const view = await fixture();
    try {
        const button = view.rail.querySelector("button")!;
        await advance(5_000);
        await act(() => {
            button.dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true }));
            button.focus();
            button.click();
        });
        await advance(9_999);
        expect(view.collapsed()).toBe(false);
        await advance(1);
        expect(view.collapsed()).toBe(true);
    } finally {
        await view.close();
    }
});

test("键盘焦点在菜单内保持展开，离开后开始计时", async () => {
    const view = await fixture();
    try {
        await advance(10_000);
        await act(() => view.rail.querySelector("button")!.focus());
        expect(view.collapsed()).toBe(false);
        await advance(30_000);
        expect(view.collapsed()).toBe(false);
        await act(() => view.rail.querySelector("input")!.focus());
        await advance(30_000);
        expect(view.collapsed()).toBe(false);
        await act(() => view.host.querySelector<HTMLButtonElement>("[data-outside]")!.focus());
        await advance(10_000);
        expect(view.collapsed()).toBe(true);
    } finally {
        await view.close();
    }
});

test("离开项目清理计时器，进入另一个项目恢复展开", async () => {
    const view = await fixture();
    try {
        await advance(10_000);
        await view.update("/projects/project/guide");
        expect(view.collapsed()).toBe(true);
        await view.update("/projects");
        expect(view.enabled()).toBe(false);
        expect(view.collapsed()).toBe(false);
        expect(timers.size).toBe(0);
        await view.update("/projects/another");
        expect(view.collapsed()).toBe(false);
        expect(timers.size).toBe(1);
    } finally {
        await view.close();
        expect(timers.size).toBe(0);
    }
});

test("移动端保持完整菜单，跨断点时重新按桌面计时", async () => {
    const view = await fixture("/projects/project", 390);
    try {
        await advance(30_000);
        expect(view.collapsed()).toBe(false);
        expect(timers.size).toBe(0);
        await view.resize(1440);
        await advance(10_000);
        expect(view.collapsed()).toBe(true);
        await view.resize(390);
        expect(view.collapsed()).toBe(false);
        expect(timers.size).toBe(0);
    } finally {
        await view.close();
    }
});
