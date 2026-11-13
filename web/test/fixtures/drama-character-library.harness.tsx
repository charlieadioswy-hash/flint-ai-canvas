import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaCast, DramaSummary } from "@/services/api/drama";
import type { ProjectCharacterDetail } from "@/services/api/projects";
import type { LocalUser } from "@/stores/use-user-store";

const browser = new Window({ url: "http://localhost/projects/project-a/guide" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    Element: browser.Element,
    Node: browser.Node,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    InputEvent: browser.InputEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { environmentManager } = await import("@tanstack/query-core");
environmentManager.setIsServer(() => false);

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}
const user = (id = "user-a"): LocalUser => ({ id, username: id, displayName: id, role: "user", status: "active" });
const store = create<{ user: LocalUser | null }>(() => ({ user: user() }));
const notices: string[] = [];
const confirms: Array<{ title: string; onOk: () => void | Promise<unknown> }> = [];
const writes: Array<{ kind: string; projectId: string; castId?: string; input: Record<string, unknown>; pending: Deferred<any> }> = [];
const libraryReads: Array<Record<string, unknown>> = [];
let libraryError = false;
let libraryPending: Deferred<any> | undefined;
const card = (): ProjectCharacterDetail =>
    ({
        asset: { id: "library-hero", title: "库中秦子文", primaryVersionId: "version-7" },
        character: {
            versionId: "version-7",
            version: 7,
            definition: { sourceDefinition: "年龄：26岁\n性格：冷静谨慎\n背景：照顾弟弟。", appearance: "库中外观", age: "26岁", vendorSpecific: { symbol: "钥匙" } },
            representations: [
                { id: "repr-front", resourceId: "image-front", mediaType: "image", role: "front" },
                { id: "repr-sheet", resourceId: "image-sheet", mediaType: "image", role: "turnaround_sheet" },
            ],
            voice: { profile: { id: "voice-7", name: "冷静青年", status: "active", sampleResourceId: "audio-7" }, instructions: "低沉冷静" },
            visualStatus: "ready",
            voiceStatus: "ready",
        },
    }) as ProjectCharacterDetail;

mock.module("antd", () => ({
    App: {
        useApp: () => ({
            message: { success: (text: string) => notices.push(text), error: (text: string) => notices.push(text) },
            modal: {
                confirm: (value: { title: string; onOk: () => void | Promise<unknown> }) => {
                    confirms.push(value);
                },
            },
        }),
    },
    Button: ({ children, icon, loading: _loading, type: _type, size: _size, htmlType = "button", ...props }: Record<string, any>) => createElement("button", { ...props, type: htmlType }, icon, children),
    Input: Object.assign((props: Record<string, unknown>) => createElement("input", props), { TextArea: (props: Record<string, unknown>) => createElement("textarea", props) }),
}));
mock.module("@/components/ui/product/app-modal/app-modal", () => ({ AppModal: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? createElement("div", { role: "dialog" }, children) : null) }));
mock.module("@/stores/use-user-store", () => ({ useUserStore: store }));
mock.module("@/pages/projects/drama-shared", () => ({ useResourceMediaUrl: (id?: string) => (id ? `/resources/${id}` : "") }));
mock.module("@/services/api/projects", () => ({
    listCharacters: async (options: Record<string, unknown>) => {
        libraryReads.push(options);
        if (libraryPending) return libraryPending.promise;
        if (libraryError) throw new Error("角色库不可用");
        return { characters: [card()], page: 1, pageSize: 12, total: 25, hasMore: true };
    },
}));
function write(kind: string, projectId: string, input: Record<string, unknown>, castId?: string) {
    const pending = deferred<any>();
    writes.push({ kind, projectId, input: structuredClone(input), castId, pending });
    return pending.promise;
}
mock.module("@/services/api/drama-character-library", () => ({
    importDramaCharacterLibrary: (projectId: string, input: Record<string, unknown>) => write("import", projectId, input),
    saveDramaCharacterLibrary: (projectId: string, castId: string, input: Record<string, unknown>) => write("save", projectId, input, castId),
    updateDramaCharacterDefinition: (projectId: string, castId: string, input: Record<string, unknown>) => write("definition", projectId, input, castId),
    getDramaCharacterUsage: async () => ({
        hasStory: true,
        appearances: [{ episodeId: "ep-1", episodeNumber: 1, episodeTitle: "第一集", shotId: "shot-1", position: 2, segmentIndex: 0 }],
        imageReferences: [{ episodeId: "ep-1", episodeNumber: 1, segmentId: "seg-1", segmentIndex: 0 }],
        audioReferences: [{ episodeId: "ep-2", episodeNumber: 2, segmentId: "seg-2", segmentIndex: 1 }],
    }),
}));
const { WorkflowCharacterLibrary } = await import("@/pages/projects/workflow-character-library");

afterAll(() => {
    browser.happyDOM.abort();
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function castOf(extra: Partial<DramaCast> = {}): DramaCast {
    return {
        id: "hero",
        projectId: "project-a",
        revision: 4,
        kind: "character",
        name: "剧本秦子文",
        aliasesJson: "[]",
        role: "哥哥",
        description: "当前剧本的原文说明",
        appearance: "当前外观",
        voiceInstructions: "当前声线",
        importance: 1,
        imageStatus: "ready",
        imageResourceId: "current-image",
        imageVersion: 1,
        locked: true,
        position: 0,
        definitionJson: JSON.stringify({ sourceDefinition: "原文人物定义\n完整保留", age: "未知", customObject: { preserve: true } }),
        ...extra,
    };
}
function summaryOf(revision = 12, projectId = "project-a") {
    return { project: { id: projectId }, production: { revision } } as DramaSummary;
}
function reset() {
    notices.length = 0;
    confirms.length = 0;
    writes.length = 0;
    libraryReads.length = 0;
    libraryPending = undefined;
    libraryError = false;
    store.setState({ user: user() });
    browser.localStorage.setItem("yingce:active-user-scope", "user-a");
}
async function settle() {
    for (let i = 0; i < 4; i++) await Bun.sleep(5);
}
async function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const changed: string[] = [];
    const states: Array<{ dirty: boolean; busy: boolean }> = [];
    let current = { summary: summaryOf(), cast: [castOf(), castOf({ id: "look", parentId: "hero", name: "造型" }), castOf({ id: "scene", kind: "scene", name: "旧宅" }), castOf({ id: "foreign", projectId: "project-b", name: "其他作品" })], busy: false };
    const update = async (patch: Partial<typeof current> = {}) => {
        current = { ...current, ...patch };
        await act(async () => {
            root.render(createElement(QueryClientProvider, { client }, createElement(WorkflowCharacterLibrary, { ...current, onChanged: () => changed.push(current.summary.project.id), onDirtyChange: (dirty, busy) => states.push({ dirty, busy }) })));
            await settle();
        });
        await act(settle);
    };
    await update();
    let disposed = false;
    const dispose = async () => {
        if (disposed) return;
        disposed = true;
        await act(async () => root.unmount());
        client.clear();
        container.remove();
    };
    return { container, changed, states, update, dispose };
}
const button = (container: HTMLElement, text: string) => {
    const item = [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === text);
    if (!item) throw new Error(`missing button ${text}: ${container.textContent}`);
    return item as HTMLButtonElement;
};
const control = <T extends HTMLElement>(container: HTMLElement, label: string) => {
    const item = container.querySelector(`[aria-label="${label}"]`);
    if (!item) throw new Error(`missing control ${label}`);
    return item as T;
};
async function click(node: HTMLElement) {
    await act(async () => {
        node.click();
        await settle();
    });
    await act(settle);
}
async function select(container: HTMLElement, label: string, value: string) {
    const item = control<HTMLSelectElement>(container, label);
    await act(async () => {
        item.value = value;
        item.dispatchEvent(new browser.Event("change", { bubbles: true }));
        await settle();
    });
}
async function edit(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const descriptor = Object.getOwnPropertyDescriptor(node.tagName === "TEXTAREA" ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype, "value");
    await act(async () => {
        descriptor?.set?.call(node, value);
        node.dispatchEvent(new browser.Event("input", { bubbles: true }));
        await settle();
    });
}
async function chooseLibrary(container: HTMLElement) {
    await click(button(container, "从角色库导入"));
    const item = [...container.querySelectorAll("button")].find((node) => node.querySelector("strong")?.textContent === "库中秦子文");
    if (!item) throw new Error("missing library card");
    await click(item as HTMLElement);
}
async function prepareWrite(fixture: Awaited<ReturnType<typeof mount>>, kind: "import" | "save" | "definition") {
    const { container } = fixture;
    if (kind !== "import") await select(container, "选择要查看的人物", "hero");
    if (kind === "import") {
        await chooseLibrary(container);
        await click(button(container, "确认导入"));
    }
    if (kind === "save") {
        await click(button(container, "另存到角色库"));
        await click(button(container, "另存新角色"));
    }
    if (kind === "definition") {
        await click(button(container, "人物信息与出镜"));
        await edit(control<HTMLTextAreaElement>(container, "年龄"), "27岁");
        await click(button(container, "保存人物信息"));
    }
}

test("只列本作品基础角色，导入可不带图片，使用用户选中的库版本", async () => {
    reset();
    const fixture = await mount();
    try {
        expect(control<HTMLSelectElement>(fixture.container, "选择要查看的人物").options.length).toBe(2);
        await chooseLibrary(fixture.container);
        expect(fixture.container.textContent).toContain("年龄：26岁");
        expect(fixture.states.some((state) => state.dirty)).toBe(true);
        await click(button(fixture.container, "确认导入"));
        expect(writes).toHaveLength(1);
        expect(writes[0].input).toEqual({ expectedRevision: 12, libraryAssetId: "library-hero", libraryVersionId: "version-7", replaceText: false, includeVoice: false });
        await click(button(fixture.container, "确认导入"));
        expect(writes).toHaveLength(1);
        await act(async () => {
            writes[0].pending.resolve({ cast: castOf() });
            await settle();
        });
        expect(fixture.changed).toEqual(["project-a"]);
        expect(fixture.container.querySelector('[role="dialog"]')).toBeNull();
    } finally {
        await fixture.dispose();
    }
});

test("导入已有角色默认保留文字，只采用显式选择的形象与声音", async () => {
    reset();
    const fixture = await mount();
    try {
        await select(fixture.container, "选择要查看的人物", "hero");
        await chooseLibrary(fixture.container);
        const sheet = [...fixture.container.querySelectorAll("label")].find((node) => node.textContent?.trim() === "三视图");
        await click(sheet!.querySelector("input")!);
        const voice = [...fixture.container.querySelectorAll("input")].find((node) => node.type === "checkbox" && node.parentElement?.textContent?.includes("采用声音"));
        await click(voice!);
        await click(button(fixture.container, "确认导入"));
        expect(writes[0].input).toEqual({ expectedRevision: 12, libraryAssetId: "library-hero", libraryVersionId: "version-7", targetCastId: "hero", expectedCastRevision: 4, replaceText: false, representationId: "repr-sheet", includeVoice: true });
        expect(writes[0].input).not.toHaveProperty("description");
    } finally {
        await fixture.dispose();
    }
});

test("只有勾选替换并确认，才会替换文字", async () => {
    reset();
    const fixture = await mount();
    try {
        await select(fixture.container, "选择要查看的人物", "hero");
        await chooseLibrary(fixture.container);
        const replace = [...fixture.container.querySelectorAll("input")].find((node) => node.type === "checkbox" && node.parentElement?.textContent?.includes("替换当前"));
        await click(replace!);
        await click(button(fixture.container, "确认导入"));
        expect(writes).toHaveLength(0);
        expect(confirms).toHaveLength(1);
        await act(async () => {
            void confirms[0].onOk();
            await settle();
        });
        expect(writes[0].input.replaceText).toBe(true);
    } finally {
        await fixture.dispose();
    }
});

test("制作或人物版本变化时保留选择并停止提交", async () => {
    for (const version of ["project", "cast"]) {
        reset();
        const fixture = await mount();
        try {
            await select(fixture.container, "选择要查看的人物", "hero");
            await chooseLibrary(fixture.container);
            await fixture.update(version === "project" ? { summary: summaryOf(13) } : { cast: [castOf({ revision: 5 })] });
            expect(fixture.container.textContent).toContain("当前选择和修改已保留");
            expect(fixture.container.textContent).toContain("库中秦子文");
            expect(button(fixture.container, "确认导入").disabled).toBe(true);
            expect(writes).toHaveLength(0);
        } finally {
            await fixture.dispose();
        }
    }
});

test("人物信息只提交修改字段，完整原文与未知定义保持只读", async () => {
    reset();
    const fixture = await mount();
    try {
        await select(fixture.container, "选择要查看的人物", "hero");
        await click(button(fixture.container, "人物信息与出镜"));
        expect(fixture.container.textContent).toContain("原文人物定义\n完整保留");
        expect(fixture.container.textContent).toContain('"preserve": true');
        expect(fixture.container.textContent).toContain("实际出镜 1 镜");
        expect(fixture.container.textContent).toContain("（不计入出镜）");
        await edit(control<HTMLTextAreaElement>(fixture.container, "年龄"), "27岁");
        await click(button(fixture.container, "保存人物信息"));
        expect(writes[0].kind).toBe("definition");
        expect(writes[0].input).toEqual({ expectedRevision: 12, expectedCastRevision: 4, fields: { age: "27岁" } });
        expect(writes[0].input).not.toHaveProperty("definitionJson");
    } finally {
        await fixture.dispose();
    }
});

test("损坏的定义不会被空白表单覆盖", async () => {
    reset();
    const fixture = await mount();
    try {
        await fixture.update({ cast: [castOf({ definitionJson: "[]" })] });
        await select(fixture.container, "选择要查看的人物", "hero");
        await click(button(fixture.container, "人物信息与出镜"));
        expect(fixture.container.textContent).toContain("人物定义格式异常");
        expect(button(fixture.container, "保存人物信息").disabled).toBe(true);
        expect(writes).toHaveLength(0);
    } finally {
        await fixture.dispose();
    }
});

test("另存只创建新角色卡，提交真实源角色版本", async () => {
    reset();
    const fixture = await mount();
    try {
        await select(fixture.container, "选择要查看的人物", "hero");
        await click(button(fixture.container, "另存到角色库"));
        await edit(control<HTMLInputElement>(fixture.container, "角色库名称"), "秦子文·本剧");
        await click(button(fixture.container, "另存新角色"));
        expect(writes).toHaveLength(1);
        expect(writes[0].kind).toBe("save");
        expect(writes[0].castId).toBe("hero");
        expect(writes[0].input).toEqual({ expectedRevision: 12, expectedCastRevision: 4, name: "秦子文·本剧" });
        await act(async () => {
            writes[0].pending.resolve(card());
            await settle();
        });
        expect(fixture.changed).toEqual(["project-a"]);
    } finally {
        await fixture.dispose();
    }
});

test("读取支持搜索和分页，服务端失败能重试", async () => {
    reset();
    libraryError = true;
    const fixture = await mount();
    try {
        await click(button(fixture.container, "从角色库导入"));
        expect(fixture.container.textContent).toContain("角色库读取失败");
        libraryError = false;
        await click(button(fixture.container, "刷新角色库"));
        expect(fixture.container.textContent).toContain("库中秦子文");
        await edit(control<HTMLInputElement>(fixture.container, "搜索个人角色"), "秦子文");
        await click(button(fixture.container, "搜索"));
        expect(libraryReads.at(-1)).toEqual({ page: 1, pageSize: 12, query: "秦子文" });
        await click(button(fixture.container, "下一页"));
        expect(libraryReads.at(-1)?.page).toBe(2);
    } finally {
        await fixture.dispose();
    }
});

test("未保存编辑关闭前需要确认", async () => {
    reset();
    const fixture = await mount();
    try {
        await select(fixture.container, "选择要查看的人物", "hero");
        await click(button(fixture.container, "人物信息与出镜"));
        await edit(control<HTMLTextAreaElement>(fixture.container, "年龄"), "30岁");
        await click(button(fixture.container, "关闭"));
        expect(confirms).toHaveLength(1);
        expect(fixture.container.querySelector('[role="dialog"]')).not.toBeNull();
        await act(async () => {
            await confirms[0].onOk();
            await settle();
        });
        expect(fixture.container.querySelector('[role="dialog"]')).toBeNull();
        expect(writes).toHaveLength(0);
    } finally {
        await fixture.dispose();
    }
});

test("账号scope变化后晚到的角色库读取不展示旧数据", async () => {
    reset();
    libraryPending = deferred();
    const fixture = await mount();
    try {
        await click(button(fixture.container, "从角色库导入"));
        expect(fixture.container.textContent).toContain("正在读取个人角色库");
        browser.localStorage.setItem("yingce:active-user-scope", "user-b");
        await act(async () => {
            libraryPending!.resolve({ characters: [card()], total: 1 });
            await settle();
        });
        expect(fixture.container.textContent).not.toContain("库中秦子文");
        expect(fixture.container.textContent).toContain("登录状态已变化");
        expect(writes).toHaveLength(0);
    } finally {
        await fixture.dispose();
    }
});

for (const kind of ["import", "save", "definition"] as const) {
    test(`${kind} 的晚到回执隔离账号、同账号scope、作品与卸载`, async () => {
        for (const lifecycle of ["account", "scope", "project", "unmount"]) {
            reset();
            const fixture = await mount();
            try {
                await prepareWrite(fixture, kind);
                expect(writes).toHaveLength(1);
                if (lifecycle === "account")
                    await act(async () => {
                        browser.localStorage.setItem("yingce:active-user-scope", "user-b");
                        store.setState({ user: user("user-b") });
                        await settle();
                    });
                if (lifecycle === "scope") {
                    browser.localStorage.setItem("yingce:active-user-scope", "user-a-other-scope");
                    await fixture.update();
                }
                if (lifecycle === "project") await fixture.update({ summary: summaryOf(12, "project-b"), cast: [] });
                if (lifecycle === "unmount") await fixture.dispose();
                await act(async () => {
                    writes[0].pending.resolve(kind === "save" ? card() : { cast: castOf() });
                    await settle();
                });
                expect(fixture.changed, `${kind}:${lifecycle}`).toEqual([]);
                expect(notices, `${kind}:${lifecycle}`).toEqual([]);
            } finally {
                await fixture.dispose();
            }
        }
    });
}
