import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/screen-creation" });
const globals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    HTMLTextAreaElement: dom.HTMLTextAreaElement,
    Element: dom.Element,
    Node: dom.Node,
    Event: dom.Event,
    MouseEvent: dom.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const { act, useEffect, useMemo, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, Outlet, RouterProvider } = await import("react-router");
const { useUserStore } = await import("../../src/stores/use-user-store");
const initialUserState = useUserStore.getInitialState();
const restoreEntry = mock(async () => ({}));
const onNavigate = mock(() => {});
let mounts = 0;
let unmounts = 0;
const emptyProjects: never[] = [];
const query = { isError: false, isFetching: false, hasNextPage: false };
const t = (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key;
const noop = () => {};

// 被测范围保留真实 SidebarNav、ScreenCreationEntry 与 Router；替换媒体工作区和账号周边依赖。
mock.module("antd", () => ({ Popover: ({ children }: { children: React.ReactNode }) => children }));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t, i18n: { language: "zh" } }) }));
mock.module("motion/react", () => ({ LayoutGroup: ({ children }: { children: React.ReactNode }) => children, motion: { span: ({ className }: { className: string }) => <span className={className} /> }, useReducedMotion: () => true }));
mock.module("../../src/hooks/use-workspace-logout", () => ({ useWorkspaceLogout: () => ({ handleLogout: noop }) }));
mock.module("../../src/lib/workspace-route-modules", () => ({ preloadWorkspaceRoute: noop }));
mock.module("../../src/services/site-traffic", () => ({ trackSiteTrafficAction: noop }));
mock.module("../../src/components/layout/workspace-sidebar-history", () => ({ WorkspaceSidebarHistory: () => null }));
mock.module("../../src/components/layout/workspace-account-card", () => ({ WorkspaceAccountCard: () => null }));
mock.module("../../src/components/layout/workspace-sidebar-checkin", () => ({ WorkspaceSidebarCheckin: () => null }));
mock.module("../../src/components/layout/workspace-sidebar-storage-meter", () => ({ WorkspaceSidebarStorageMeter: () => null }));
mock.module("../../src/components/brand/brand-logo", () => ({ BrandLogoFrame: () => null }));
mock.module("../../src/components/layout/user-avatar", () => ({ UserAvatar: () => null }));
mock.module("../../src/components/layout/user-group-badge", () => ({ UserGroupAvatarRing: ({ children }: { children: React.ReactNode }) => children, UserGroupBadge: () => null }));
mock.module("../../src/components/auth/auth-login-link", () => ({ AuthLoginLink: () => null }));
mock.module("../../src/stores/use-appearance-store", () => ({ useAppearanceStore: (selector: (state: unknown) => unknown) => selector({ appearance: { logoConfigured: false, brandName: "影策" } }) }));
mock.module("../../src/components/layout/workspace-page", () => ({ WorkspacePage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, PageHeader: () => null }));
mock.module("../../src/components/layout/workspace-state", () => ({ WorkspaceLoadingState: () => <p>正在恢复</p>, WorkspaceErrorState: () => <p>恢复失败</p> }));
mock.module("../../src/pages/screen-creation/screen-creation-session", () => ({ loadScreenCreationEntry: restoreEntry }));
mock.module("../../src/pages/screen-creation/use-screen-creation-scenes", () => ({
    useScreenCreationScenes: () => {
        const userId = useUserStore((state) => state.user?.id);
        return useMemo(() => ({ ready: true, userId, userHydrated: true, canvasHydrated: true, activeScope: userId || "guest", projects: emptyProjects, remoteScenes: emptyProjects, query }), [userId]);
    },
}));
mock.module("../../src/pages/screen-creation/use-screen-creation", () => ({
    useScreenCreation: () => {
        const [prompt, setPrompt] = useState("");
        useEffect(() => {
            mounts++;
            return () => {
                unmounts++;
            };
        }, []);
        return { prompt, setPrompt };
    },
}));
mock.module("../../src/pages/screen-creation/screen-creation-workspace", () => ({
    ScreenCreationWorkspace: ({ prompt, setPrompt }: { prompt: string; setPrompt: (value: string) => void }) => <textarea aria-label="创作描述" value={prompt} onChange={(event) => setPrompt(event.target.value)} />,
}));

const { WorkspaceSidebarNav } = await import("../../src/components/layout/workspace-sidebar-nav");
const { default: ScreenCreationPage } = await import("../../src/pages/screen-creation");
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let router: ReturnType<typeof createMemoryRouter>;

beforeEach(() => {
    useUserStore.setState({ ...initialUserState, user: { id: "user-a", username: "a", displayName: "甲", role: "user", status: "active" } });
    restoreEntry.mockClear();
    onNavigate.mockClear();
    mounts = 0;
    unmounts = 0;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount());
    router.dispose();
    host.remove();
});
afterAll(() => {
    useUserStore.setState(initialUserState);
    dom.happyDOM.abort();
    for (const [key, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

async function render(path: string) {
    router = createMemoryRouter(
        [
            {
                element: (
                    <>
                        <WorkspaceSidebarNav collapsed={false} onNavigate={onNavigate} onOpenSearch={noop} onExpand={noop} onCollapse={noop} />
                        <Outlet />
                    </>
                ),
                children: [
                    { path: "/screen-creation/:canvasId?", element: <ScreenCreationPage /> },
                    { path: "*", element: <p>其他工作区</p> },
                ],
            },
        ],
        { initialEntries: [path] },
    );
    await act(async () => root.render(<RouterProvider router={router} />));
}
const input = () => host.querySelector<HTMLTextAreaElement>('[aria-label="创作描述"]')!;
async function enterPrompt(value: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value);
        input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input().value).toBe(value);
}
async function clickNav(id: string, options: MouseEventInit = {}) {
    const link = host.querySelector<HTMLAnchorElement>(`a[data-nav-id="${id}"]`)!;
    expect(link).not.toBeNull();
    let prevented = false;
    const observe = (event: Event) => {
        prevented = event.defaultPrevented;
        // 浏览器新页默认动作由浏览器处理；这里仅阻止 Happy DOM 真正访问目标 URL。
        event.preventDefault();
    };
    document.addEventListener("click", observe, { once: true });
    await act(async () => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...options })));
    return prevented;
}

test.each(["/screen-creation?panel=advanced#preview", "/screen-creation?new=1&panel=advanced#preview", "/screen-creation/scene-a?panel=advanced#preview"])("重复鼠标与键盘点击当前入口保留 URL、输入和会话：%s", async (path) => {
    await render(path);
    await enterPrompt("尚未保存的创作描述");
    const originalInput = input();
    const location = router.state.location;
    const restores = restoreEntry.mock.calls.length;
    expect(await clickNav("screen-creation", { detail: 1 })).toBe(true);
    // 键盘激活链接会产生 detail=0、button=0 的 click。
    expect(await clickNav("screen-creation", { detail: 0 })).toBe(true);
    expect(router.state.location).toEqual(location);
    expect(input()).toBe(originalInput);
    expect(input().value).toBe("尚未保存的创作描述");
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    expect(restoreEntry.mock.calls.length).toBe(restores);
    expect(onNavigate).toHaveBeenCalledTimes(2);
});

test("同场景的 query、hash 与历史 key 变化不重挂创作表单", async () => {
    await render("/screen-creation/scene-a?panel=first#original");
    await enterPrompt("保留编辑");
    const key = router.state.location.key;
    await act(async () => {
        await router.navigate("/screen-creation/scene-a?panel=first#original");
    });
    expect(router.state.location.key).not.toBe(key);
    expect(input().value).toBe("保留编辑");
    await act(async () => {
        await router.navigate("/screen-creation/scene-a?panel=second#result");
    });
    expect(router.state.location.key).not.toBe(key);
    expect(input().value).toBe("保留编辑");
    await act(async () => {
        await router.navigate(-1);
    });
    expect(input().value).toBe("保留编辑");
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    expect(restoreEntry).not.toHaveBeenCalled();
});

test("其他导航和未激活的异形屏入口仍正常跳转", async () => {
    await render("/canvas?from=screen#preview");
    const key = router.state.location.key;
    await clickNav("canvas");
    expect(router.state.location.pathname).toBe("/canvas");
    expect(router.state.location.search).toBe("");
    expect(router.state.location.hash).toBe("");
    expect(router.state.location.key).not.toBe(key);
    await clickNav("screen-creation");
    expect(router.state.location.pathname).toBe("/screen-creation");
    expect(input()).not.toBeNull();
    expect(restoreEntry).toHaveBeenCalledTimes(1);
    await clickNav("canvas");
    expect(router.state.location.pathname).toBe("/canvas");
    expect(unmounts).toBe(1);
});

test.each([{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])("当前入口保留浏览器修改键和其他鼠标按键手势：%j", async (gesture) => {
    await render("/screen-creation/scene-a?panel=advanced#preview");
    const location = router.state.location;
    expect(await clickNav("screen-creation", gesture)).toBe(false);
    expect(router.state.location).toEqual(location);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(mounts).toBe(1);
});

test("明确切换场景或账号会重建创作会话", async () => {
    await render("/screen-creation/scene-a");
    await enterPrompt("场景甲的输入");
    await act(async () => {
        await router.navigate("/screen-creation/scene-b");
    });
    expect(input().value).toBe("");
    expect(mounts).toBe(2);
    await enterPrompt("账号甲的输入");
    await act(async () => useUserStore.setState({ user: { ...useUserStore.getState().user!, id: "user-b" } }));
    expect(input().value).toBe("");
    expect(mounts).toBe(3);
    expect(unmounts).toBe(2);
});

test("明确切换新建标记会重建会话，同一新建页的其他 URL 变化保留输入", async () => {
    await render("/screen-creation?new=1");
    await enterPrompt("新的场景输入");
    await act(async () => {
        await router.navigate("/screen-creation?new=1&panel=advanced#preview");
    });
    expect(input().value).toBe("新的场景输入");
    expect(mounts).toBe(1);
    await act(async () => {
        await router.navigate("/screen-creation");
    });
    expect(input().value).toBe("");
    expect(mounts).toBe(2);
    await enterPrompt("入口草稿");
    await act(async () => {
        await router.navigate("/screen-creation?new=1");
    });
    expect(input().value).toBe("");
    expect(mounts).toBe(3);
    expect(unmounts).toBe(2);
    expect(restoreEntry).toHaveBeenCalledTimes(3);
});
