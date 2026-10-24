import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import * as assetFormat from "../src/pages/assets/asset-library-format";
import * as gridDensity from "../src/pages/assets/asset-grid-density";
import * as assetCategory from "../src/lib/asset-category";
import type { Asset } from "../src/stores/use-asset-store";

// Execute the real page and its count helpers; replace only the hooks, query,
// store and UI boundaries. VM isolation avoids changing other tests' modules.
const build = await Bun.build({
    entrypoints: [new URL("../src/pages/assets/index.tsx", import.meta.url).pathname],
    target: "node",
    format: "cjs",
    external: ["*"],
});
if (!build.success) throw new Error(build.logs.map(String).join("\n"));
const source = await build.outputs[0].text();

type Element = { type: string; props: Record<string, any> };
type PageData = { assets: Asset[]; total: number; kindCounts: Record<string, number>; categoryCounts: Record<string, number>; folderCounts: Record<string, number> };

function assets(count: number, patch: Partial<Asset> = {}): Asset[] {
    return Array.from(
        { length: count },
        (_, index) =>
            ({
                id: `asset-${index}`,
                kind: "text",
                category: "material",
                title: `Asset ${index}`,
                coverUrl: "",
                tags: [],
                createdAt: "",
                updatedAt: "",
                status: "confirmed",
                data: { content: `Content ${index}` },
                ...patch,
            }) as Asset,
    );
}

function pageData(items: Asset[], total = items.length, patch: Partial<PageData> = {}): PageData {
    return { assets: items, total, kindCounts: { text: total }, categoryCounts: { material: total }, folderCounts: { "": total }, ...patch };
}

function descendants(value: any): Element[] {
    if (Array.isArray(value)) return value.flatMap(descendants);
    if (!value || typeof value !== "object" || !value.props) return [];
    return [value, ...descendants(value.props.children)];
}

function text(value: any): string {
    if (Array.isArray(value)) return value.map(text).join("");
    if (value && typeof value === "object") return text(value.props?.children);
    return value === null || value === undefined || typeof value === "boolean" ? "" : String(value);
}

function harness(initialAssets: Asset[], initialRemote: PageData | undefined, archivedTotal?: number) {
    let localAssets = initialAssets;
    let remote = initialRemote;
    const cells: any[] = [];
    let cursor = 0;
    const requests: Record<string, unknown>[] = [];
    let emptyTrashCalls = 0;
    let queryOptions: any;
    const hooks = {
        useState(initial: any) {
            const index = cursor++;
            if (!(index in cells)) cells[index] = typeof initial === "function" ? initial() : initial;
            return [
                cells[index],
                (next: any) => {
                    cells[index] = typeof next === "function" ? next(cells[index]) : next;
                },
            ];
        },
        useRef(initial: any) {
            const index = cursor++;
            return (cells[index] ||= { current: initial });
        },
        useMemo(factory: () => any) {
            return factory();
        },
        useEffect() {},
    };
    const jsx = (type: string, props: Record<string, any>) => ({ type, props });
    const ui = new Proxy({}, { get: (_, name) => String(name) });
    const noop = () => {};
    const store = () => ({ assets: localAssets, addAsset: noop, updateAsset: noop });
    const form = { getFieldValue: noop, setFieldsValue: noop, setFieldValue: noop };
    const modules: Record<string, any> = {
        react: { ...hooks, createElement: (type: string, props: any, ...children: any[]) => jsx(type, { ...props, children }), Fragment: "Fragment" },
        "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
        "react/jsx-dev-runtime": { jsxDEV: jsx, Fragment: "Fragment" },
        "@tanstack/react-query": {
            keepPreviousData: (value: unknown) => value,
            useQueryClient: () => ({ invalidateQueries: noop }),
            useQuery: (options: { queryKey: unknown[]; queryFn: (context: { signal: AbortSignal }) => unknown }) => {
                if (options.queryKey[0] === "asset-folders") return { data: { folders: [{ id: "folder-a", name: "场景" }] } };
                if (options.queryKey[2] === "archived-total") {
                    options.queryFn({ signal: new AbortController().signal });
                    return { data: archivedTotal === undefined ? undefined : { total: archivedTotal } };
                }
                queryOptions = options;
                options.queryFn({ signal: new AbortController().signal });
                return { data: remote, isSuccess: remote !== undefined, isFetching: false };
            },
        },
        antd: {
            ...Object.fromEntries(["Popconfirm", "Button", "Dropdown", "Modal", "Space", "Tag", "Progress"].map((name) => [name, name])),
            App: { useApp: () => ({ message: { success: noop, error: noop } }) },
            Form: Object.assign(() => {}, { useForm: () => [form], useWatch: noop, Item: "Form.Item" }),
            Input: { Search: "Input.Search", TextArea: "Input.TextArea" },
            Typography: { Text: "Typography.Text" },
        },
        "react-router": { useNavigate: () => noop },
        "@/hooks/use-copy-text": { useCopyText: () => noop },
        "@/hooks/use-debounced-value": { useDebouncedValue: (value: unknown) => value },
        "@/lib/utils": { cn: (...values: unknown[]) => values.filter(Boolean).join(" ") },
        "@/lib/asset-category": assetCategory,
        "@/stores/use-asset-store": { useAssetStore: Object.assign((selector: (value: ReturnType<typeof store>) => unknown) => selector(store()), { getState: store }) },
        "@/stores/use-user-store": { useUserStore: (selector: (value: unknown) => unknown) => selector({ user: { id: "user" }, runtimeLimits: { recycleBinRetentionDays: 30 } }) },
        "@/services/user-data-sync": {
            emptyAssetTrashWithRemoteSync: async () => {
                emptyTrashCalls++;
                return archivedTotal ?? 0;
            },
            loadAssetLibraryPage: (options: Record<string, unknown>) => {
                requests.push(options);
                return Promise.resolve(remote);
            },
        },
        "./asset-library-format": assetFormat,
        "./asset-grid-density": gridDensity,
    };
    const module = { exports: {} as { default: () => Element } };
    runInNewContext(source, { module, exports: module.exports, require: (name: string) => modules[name] || ui, console, AbortController, window: { localStorage: { getItem: () => null, setItem: noop } } });
    let tree: Element;
    const render = () => {
        cursor = 0;
        tree = module.exports.default();
        return tree;
    };
    render();
    function find(predicate: (element: Element) => boolean, within: Element = tree) {
        const result = descendants(within).find(predicate);
        if (!result) throw new Error("Expected page element was not rendered");
        return result;
    }
    function folderButton(label: string) {
        const section = find((element) => element.type === "section" && String(element.props.className).includes("assets-folder-filter"));
        return find((element) => element.type === "button" && descendants(element.props.children).some((child) => String(child.props.className).includes("assets-filter-item-label") && text(child) === label), section);
    }
    return {
        requests,
        get emptyTrashCalls() { return emptyTrashCalls; },
        trashCount() {
            const button = find((element) => element.type === "button" && descendants(element).some((child) => child.type === "span" && text(child) === "回收站"));
            return Number(text(find((element) => element.props.className === "assets-filter-count", button)));
        },
        canEmptyTrash() {
            return descendants(find((element) => element.type === "PageHeader").props.actions).some((element) => element.type === "Popconfirm" && element.props.title === "确定清空回收站吗？");
        },
        emptyState() {
            const { title, description } = find((element) => element.type === "WorkspaceState").props;
            return { title, description };
        },
        search(keyword: string) {
            find((element) => element.props.placeholder === "搜索标题、内容、标签或来源").props.onChange({ target: { value: keyword } });
            render();
        },
        async emptyTrash() {
            const actions = find((element) => element.type === "PageHeader").props.actions;
            await find((element) => element.type === "Popconfirm" && element.props.title === "确定清空回收站吗？", actions).props.onConfirm();
            render();
        },
        placeholder(previous: PageData, userId: string, viewMode: string) {
            return queryOptions.placeholderData(previous, { queryKey: ["asset-library", userId, 1, 40, viewMode] });
        },
        setCache(value: Asset[]) {
            localAssets = value;
            render();
        },
        setRemote(value: PageData | undefined) {
            remote = value;
            render();
        },
        folderCount(label: string) {
            return Number(text(find((element) => element.props.className === "assets-filter-count", folderButton(label))));
        },
        filterCounts(title: string): Map<string, number> {
            return find((element) => element.type === "AssetFilterGroup" && element.props.title === title).props.counts;
        },
        nextPage() {
            find((element) => element.type === "PaginationBar").props.onChange(2, 40);
            render();
        },
        clickFolder(label: string) {
            folderButton(label).props.onClick();
            render();
        },
        openTrash() {
            find((element) => element.type === "button" && descendants(element).some((child) => child.type === "span" && text(child) === "回收站")).props.onClick();
            render();
        },
    };
}

test("folder total stays at the remote total across pages and local cache updates", () => {
    const remoteAssets = assets(80);
    const h = harness(remoteAssets.slice(0, 40), pageData(remoteAssets.slice(0, 40), 80));
    const firstPageCount = h.folderCount("全部");
    h.nextPage();
    h.setCache(remoteAssets);
    h.setRemote(pageData(remoteAssets.slice(40), 80));
    expect([firstPageCount, h.folderCount("全部")]).toEqual([80, 80]);
    expect(h.requests.at(-1)?.page).toBe(2);
});

test("uncached remote archived assets determine the trash badge and clear action even with an empty filtered page", async () => {
    const h = harness([], pageData([], 0), 121);
    expect(h.trashCount()).toBe(121);
    h.openTrash();
    h.clickFolder("场景");
    expect(h.folderCount("场景")).toBe(0);
    expect(h.trashCount()).toBe(121);
    expect(h.canEmptyTrash()).toBe(true);
    expect(h.emptyState()).toEqual({ title: "没有匹配的素材", description: "调整关键词或左侧分类后再试。" });
    await h.emptyTrash();
    expect(h.emptyTrashCalls).toBe(1);
    expect(h.requests.some((request) => request.status === "archived" && request.pageSize === 1 && request.folderId === undefined && request.query === undefined)).toBe(true);
});

test("a trash search with no matches explains the filtered result while retaining its total and clear action", () => {
    const h = harness([], pageData([], 0), 1);
    h.openTrash();
    h.search("QA-no-match-20261024");
    expect(h.emptyState()).toEqual({ title: "没有匹配的素材", description: "调整关键词或左侧分类后再试。" });
    expect(h.trashCount()).toBe(1);
    expect(h.canEmptyTrash()).toBe(true);
});

test("an empty remote trash does not show stale cached archived counts or a clear action", () => {
    const h = harness(assets(2, { status: "archived" }), pageData([], 0), 0);
    expect(h.trashCount()).toBe(0);
    h.openTrash();
    expect(h.canEmptyTrash()).toBe(false);
});

test("an unfiltered empty trash keeps its empty-bin message", () => {
    const h = harness([], pageData([], 0), 0);
    h.openTrash();
    expect(h.emptyState().title).toBe("回收站是空的");
});

test("a missing remote folder facet is zero even if deleted assets remain in the local cache", () => {
    const h = harness(assets(2, { folderId: "folder-a" }), pageData([], 0, { folderCounts: {}, kindCounts: {}, categoryCounts: {} }));
    h.clickFolder("场景");
    expect(h.folderCount("场景")).toBe(0);
});

test("a missing remote uncategorized facet does not fall back to stale cached assets", () => {
    const h = harness(assets(2), pageData([], 0, { folderCounts: {}, kindCounts: {}, categoryCounts: {} }));
    expect(h.folderCount("未分类")).toBe(0);
});

test("empty remote pages retain remote kind and category facets while the list uses cached cards", () => {
    const h = harness(assets(40), pageData([], 80));
    expect(h.filterCounts("素材类型").get("all")).toBe(80);
    expect(h.filterCounts("业务分类").get("all")).toBe(80);
});

test("trash folder totals use archived assets when remote data is unavailable", () => {
    const archived = assets(2, { status: "archived", folderId: "folder-a" }).map((asset) => ({ ...asset, id: `archived-${asset.id}` }));
    const h = harness([...assets(40), ...archived], undefined);
    h.openTrash();
    expect(h.requests.at(-1)?.status).toBe("archived");
    expect(h.folderCount("全部")).toBe(2);
    expect(h.folderCount("场景")).toBe(2);
    expect(h.folderCount("未分类")).toBe(0);
});

test("local active counts remain available before a remote response", () => {
    const categorized = assets(2, { folderId: "folder-a" }).map((asset) => ({ ...asset, id: `folder-${asset.id}` }));
    const h = harness([...assets(3), ...categorized], undefined);
    expect(h.folderCount("全部")).toBe(5);
    expect(h.folderCount("场景")).toBe(2);
    expect(h.folderCount("未分类")).toBe(3);
    expect(h.filterCounts("素材类型").get("all")).toBe(5);
});

test("previous pages are retained only for the same user and active or archived scope", () => {
    const data = pageData(assets(2));
    const h = harness(assets(2), data);
    expect(h.placeholder(data, "user", "library")).toBe(data);
    expect(h.placeholder(data, "another-user", "library")).toBeUndefined();
    h.openTrash();
    expect(h.placeholder(data, "user", "library")).toBeUndefined();
    expect(h.placeholder(data, "user", "trash")).toBe(data);
});
