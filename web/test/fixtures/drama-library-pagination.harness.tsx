import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, useEffect, type ReactNode } from "react";
import type { DramaListItem, DramaListPage, DramaStatus } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/projects" });
let containerWidth = 1200;
const observers = new Set<TestResizeObserver>();
class TestResizeObserver {
    elements = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) {
        observers.add(this);
    }
    observe(element: Element) {
        this.elements.add(element);
    }
    unobserve(element: Element) {
        this.elements.delete(element);
    }
    disconnect() {
        this.elements.clear();
        observers.delete(this);
    }
    notify() {
        const entries = [...this.elements].map((target) => ({ target, contentRect: new browser.DOMRect(0, 0, containerWidth, 800) }) as unknown as ResizeObserverEntry);
        this.callback(entries, this as unknown as ResizeObserver);
    }
}
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    Element: browser.Element,
    Node: browser.Node,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    ResizeObserver: TestResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
}))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

Object.defineProperty(browser.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => containerWidth });
browser.HTMLElement.prototype.getBoundingClientRect = () => new browser.DOMRect(0, 0, containerWidth, 800);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { environmentManager } = await import("@tanstack/query-core");
environmentManager.setIsServer(() => false);

type ListRequest = { page: number; pageSize: number; q?: string; status?: DramaStatus };
let library: DramaListItem[] = [];
const reads: ListRequest[] = [];
const deletes: string[] = [];
const confirms: Array<{ onOk: () => Promise<unknown> }> = [];
let entryMounts = 0;
let entryUnmounts = 0;
const noop = () => undefined;
function Box({ children, className }: { children?: ReactNode; className?: string }) {
    return <div className={className}>{children}</div>;
}

mock.module("antd", () => ({
    App: { useApp: () => ({ message: { success: noop, error: noop }, modal: { confirm: (value: { onOk: () => Promise<unknown> }) => confirms.push(value) } }) },
    Input: ({ prefix: _prefix, allowClear: _allowClear, ...props }: Record<string, unknown>) => createElement("input", props),
    Dropdown: ({ children, menu }: { children: ReactNode; menu: { items: Array<{ key?: string; label?: ReactNode; onClick?: () => void }> } }) => (
        <div>
            {children}
            {menu.items.map((item, index) =>
                item.onClick ? (
                    <button key={item.key || index} onClick={item.onClick}>
                        {item.label}
                    </button>
                ) : (
                    <span key={item.key || index}>{item.label}</span>
                ),
            )}
        </div>
    ),
}));
mock.module("@/components/layout/collection-toolbar", () => ({ CollectionToolbar: Box }));
mock.module("@/components/layout/workspace-page", () => ({
    WorkspacePage: Box,
    PageHeader: ({ title, meta, actions }: { title: string; meta?: ReactNode; actions?: ReactNode }) => (
        <header>
            <h1>{title}</h1>
            {meta}
            {actions}
        </header>
    ),
    PaginationBar: ({ current, pageSize, total, alwaysShow, onChange }: { current: number; pageSize: number; total: number; alwaysShow?: boolean; onChange: (page: number, pageSize: number) => void }) => (
        <nav aria-label="作品分页" data-page={current} data-page-size={pageSize} data-total={total} data-always-show={String(Boolean(alwaysShow))}>
            <button aria-label="上一页" disabled={current <= 1} onClick={() => onChange(current - 1, pageSize)}>
                上一页
            </button>
            <button aria-label="下一页" disabled={current * pageSize >= total} onClick={() => onChange(current + 1, pageSize)}>
                下一页
            </button>
        </nav>
    ),
}));
mock.module("@/components/layout/workspace-state", () => ({
    WorkspaceLoadingState: () => <p>正在读取作品</p>,
    WorkspaceErrorState: () => <p>读取失败</p>,
    WorkspaceNoResultsState: () => <p>没有匹配作品</p>,
}));
mock.module("@/components/ui/product/relative-time", () => ({ RelativeTime: () => null }));
mock.module("@/pages/projects/workflow-entry", () => ({
    DramaWorkflowEntry: () => {
        useEffect(() => {
            entryMounts++;
            return () => {
                entryUnmounts++;
            };
        }, []);
        return <div aria-label="创作入口">创作入口</div>;
    },
}));
mock.module("@/pages/projects/drama-shared", () => ({
    STATUS_LABEL: { draft: "未开始", running: "制作中", paused: "已暂停", completed: "已完成" },
    formatCredits: String,
    MediaThumb: () => null,
}));
mock.module("@/services/api/drama", () => ({
    listDramas: async (params: ListRequest): Promise<DramaListPage> => {
        reads.push({ ...params });
        const matching = library.filter((item) => (!params.q || item.project.name.includes(params.q)) && (!params.status || item.status === params.status));
        const statusCounts: DramaListPage["statusCounts"] = { all: library.length };
        for (const item of library) statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;
        return { items: matching.slice((params.page - 1) * params.pageSize, params.page * params.pageSize), total: matching.length, page: params.page, pageSize: params.pageSize, hasMore: params.page * params.pageSize < matching.length, statusCounts };
    },
    deleteDrama: async (id: string) => {
        deletes.push(id);
        library = library.filter((item) => item.project.id !== id);
    },
}));
const { default: DramaList } = await import("@/pages/projects/index");

afterAll(() => browser.happyDOM.abort());
const settle = () => new Promise((resolve) => setTimeout(resolve, 12));
async function flush() {
    await act(settle);
    await act(settle);
}
function seed(count: number, width = 1200) {
    containerWidth = width;
    reads.length = deletes.length = confirms.length = 0;
    entryMounts = entryUnmounts = 0;
    library = Array.from(
        { length: count },
        (_, i) =>
            ({
                project: { id: `work-${i + 1}`, name: `作品${i + 1}`, updatedAt: "2026-11-17" },
                guideStep: "completed",
                status: i < 10 ? "completed" : "paused",
                stage: "done",
                pauseReason: "",
                episodeCount: 3,
                doneCount: 1,
                aspectRatio: "9:16",
                spentMicrocredits: 0,
                heldMicrocredits: 0,
                updatedAt: "2026-11-17",
            }) as DramaListItem,
    );
}
async function mount() {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    await act(async () => {
        root.render(
            <QueryClientProvider client={client}>
                <MemoryRouter>
                    <DramaList />
                </MemoryRouter>
            </QueryClientProvider>,
        );
        await settle();
    });
    await flush();
    return {
        host,
        close: async () => {
            await act(async () => root.unmount());
            client.clear();
            host.remove();
        },
    };
}
function pagination(host: HTMLElement) {
    const element = host.querySelector<HTMLElement>('nav[aria-label="作品分页"]');
    expect(element).not.toBeNull();
    return element!;
}
function cards(host: HTMLElement) {
    return [...host.querySelectorAll("article h3")].map((node) => node.textContent);
}
async function click(node: HTMLElement) {
    await act(async () => {
        node.click();
        await settle();
    });
    await flush();
}
async function nextPage(host: HTMLElement) {
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')!);
}
async function resize(width: number) {
    containerWidth = width;
    await act(async () => {
        for (const observer of observers) observer.notify();
        await settle();
    });
    await flush();
}

test("宽屏首页每页十五部，翻页保留创作入口", async () => {
    seed(20, 1600);
    const view = await mount();
    try {
        expect(view.host.querySelector("h1")?.textContent).toBe("我的作品");
        expect(pagination(view.host).dataset.pageSize).toBe("15");
        expect(cards(view.host)).toEqual(Array.from({ length: 15 }, (_, i) => `作品${i + 1}`));
        await nextPage(view.host);
        expect(pagination(view.host).dataset.page).toBe("2");
        expect(cards(view.host)).toEqual(["作品16", "作品17", "作品18", "作品19", "作品20"]);
        expect(reads.at(-1)).toMatchObject({ page: 2, pageSize: 15 });
        expect(entryMounts).toBe(1);
        expect(entryUnmounts).toBe(0);
    } finally {
        await view.close();
    }
});

test("随容器宽度显示一至五列，换列保留当前页和每页十五部且不重新请求", async () => {
    seed(30, 500);
    const view = await mount();
    try {
        expect(pagination(view.host).dataset.pageSize).toBe("15");
        expect(cards(view.host)).toHaveLength(15);
        expect(view.host.querySelector<HTMLElement>(".drama-library-grid")?.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
        await nextPage(view.host);
        const secondPage = Array.from({ length: 15 }, (_, i) => `作品${i + 16}`);
        expect(cards(view.host)).toEqual(secondPage);
        const requestCount = reads.length;
        for (const [width, columns] of [
            [700, 3],
            [900, 4],
            [1200, 5],
            [300, 1],
        ]) {
            await resize(width);
            expect(view.host.querySelector<HTMLElement>(".drama-library-grid")?.style.gridTemplateColumns).toBe(`repeat(${columns}, minmax(0, 1fr))`);
            expect(pagination(view.host).dataset.page).toBe("2");
            expect(pagination(view.host).dataset.pageSize).toBe("15");
            expect(cards(view.host)).toEqual(secondPage);
            expect(reads).toHaveLength(requestCount);
        }
        expect(reads.at(-1)).toMatchObject({ page: 2, pageSize: 15 });
    } finally {
        await view.close();
    }
});

test("在后续页搜索全部作品并重置到第一页", async () => {
    seed(20, 500);
    const view = await mount();
    try {
        await nextPage(view.host);
        const input = view.host.querySelector<HTMLInputElement>('input[aria-label="搜索作品名"]')!;
        const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")?.set;
        await act(async () => {
            setter?.call(input, "作品20");
            input.dispatchEvent(new browser.Event("input", { bubbles: true }));
            await settle();
        });
        await flush();
        expect(reads.at(-1)).toMatchObject({ page: 1, pageSize: 15, q: "作品20" });
        expect(pagination(view.host).dataset.page).toBe("1");
        expect(cards(view.host)).toEqual(["作品20"]);
        expect(entryMounts).toBe(1);
        expect(entryUnmounts).toBe(0);
    } finally {
        await view.close();
    }
});

test("从后续页切换状态时读取该状态的第一页", async () => {
    seed(20, 500);
    const view = await mount();
    try {
        await nextPage(view.host);
        const paused = [...view.host.querySelectorAll<HTMLButtonElement>('button[role="radio"]')].find((node) => node.textContent?.includes("已暂停"));
        expect(paused).toBeDefined();
        await click(paused!);
        expect(reads.at(-1)).toMatchObject({ page: 1, pageSize: 15, status: "paused" });
        expect(pagination(view.host).dataset.page).toBe("1");
        expect(cards(view.host)).toEqual(Array.from({ length: 10 }, (_, i) => `作品${i + 11}`));
    } finally {
        await view.close();
    }
});

test("删除末页最后一部后返回有效页，一页作品也保留分页入口", async () => {
    seed(16, 500);
    const view = await mount();
    try {
        await nextPage(view.host);
        expect(cards(view.host)).toEqual(["作品16"]);
        const remove = [...view.host.querySelectorAll<HTMLButtonElement>("article button")].find((node) => node.textContent === "删除作品");
        await click(remove!);
        expect(confirms).toHaveLength(1);
        await act(async () => {
            await confirms[0].onOk();
            await settle();
        });
        await flush();
        expect(deletes).toEqual(["work-16"]);
        expect(cards(view.host)).toEqual(Array.from({ length: 15 }, (_, i) => `作品${i + 1}`));
        const nav = pagination(view.host);
        expect(nav.dataset.page).toBe("1");
        expect(nav.dataset.total).toBe("15");
        expect(nav.dataset.alwaysShow).toBe("true");
        expect(view.host.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')?.disabled).toBe(true);
    } finally {
        await view.close();
    }
});
