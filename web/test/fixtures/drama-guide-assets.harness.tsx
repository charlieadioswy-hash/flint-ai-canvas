import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { DramaCast } from "@/services/api/drama";
import type { ButtonHTMLAttributes, ReactNode } from "react";

const browser = new Window({ url: "http://localhost/projects/project/guide" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    SVGElement: browser.SVGElement,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

type TestButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & { icon?: ReactNode; loading?: boolean; size?: string; type?: string };
const empty = () => null;
mock.module("antd", () => ({
    Button: ({ children, icon, loading: _loading, size: _size, type: _type, ...props }: TestButtonProps) => (
        <button {...props}>
            {icon}
            {children}
        </button>
    ),
    Input: empty,
    InputNumber: empty,
    Select: empty,
}));
mock.module("@/components/cached-resource-image", () => ({ CachedResourceImage: ({ storageKey, alt }: { storageKey: string; alt: string }) => <img data-resource={storageKey} alt={alt} /> }));
mock.module("@/components/ui/base/tooltip/tooltip", () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));
// 卡片专项只验证目标与交互分派；实际报价与一次提交由媒体控制器专项覆盖。
mock.module("@/pages/projects/studio/drama-media-action-context", () => ({
    useDramaMediaContext: () => null,
    QuotedMediaButton: ({ label, onClick, disabled, "aria-label": ariaLabel }: { label: string; onClick?: () => void; disabled?: boolean; "aria-label"?: string }) => (
        <button disabled={disabled} onClick={onClick} aria-label={ariaLabel}>
            {label}
        </button>
    ),
}));
mock.module("@/pages/projects/asset-scheme", () => ({ AssetSchemePicker: empty }));
mock.module("@/components/ui/product/app-modal", () => ({ AppModal: empty }));
mock.module("@/pages/projects/drama-model-picker", () => ({ DramaModelPicker: empty, useDramaModelCatalog: empty }));
mock.module("@/pages/projects/step-settings", () => ({ DramaAssetImageModels: empty, DramaTextSteps: empty, VideoResolutionField: empty }));
mock.module("@/pages/projects/storyboard-rules", () => ({ EpisodeDurationInput: empty, StoryboardRules: empty }));
mock.module("@/pages/projects/style-picker", () => ({ DramaStylePicker: empty }));
mock.module("@/pages/projects/studio/segment-parts", () => ({ secondsLabel: () => "", segmentState: () => ({ tone: "idle", label: "" }), SegmentStatus: empty }));
mock.module("@/pages/projects/studio/segment-dialog", () => ({ ShotEditor: empty }));
mock.module("@/pages/projects/studio/use-studio", () => ({ dramaKeys: {} }));
const { GuideAssets } = await import("@/pages/projects/guide-panels");

afterAll(() => {
    browser.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function asset(id: string, name: string, patch: Partial<DramaCast> = {}): DramaCast {
    return {
        id,
        projectId: "project",
        kind: "character",
        name,
        aliasesJson: "[]",
        role: "主角",
        description: `${name}的人物定义`,
        appearance: `${name}的基础外观`,
        voiceInstructions: "低沉",
        importance: 1,
        imageStatus: "",
        imageVersion: 0,
        locked: false,
        position: 0,
        ...patch,
    };
}

function look(id: string, character: DramaCast, lookName: string, patch: Partial<DramaCast> = {}): DramaCast {
    return asset(id, character.name, { parentId: character.id, lookName, role: "", description: "", appearance: `${lookName}的服装`, voiceInstructions: "", ...patch });
}

type FixtureOptions = { busy?: boolean; loading?: boolean; compact?: boolean; shortcuts?: boolean; selectedIds?: Set<string>; selectable?: boolean; sharedLookIds?: Set<string> };

async function fixture(cast: DramaCast[], options: FixtureOptions = {}) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const generated: DramaCast[] = [];
    const edited: DramaCast[] = [];
    const deleted: DramaCast[] = [];
    const savedToLibrary: DramaCast[] = [];
    const selections: Array<[string, boolean]> = [];
    const render = async (next = cast, nextOptions = options) => {
        await act(async () =>
            root.render(
                <GuideAssets
                    cast={next}
                    busy={Boolean(nextOptions.busy)}
                    loading={Boolean(nextOptions.loading)}
                    compact={nextOptions.compact}
                    onEdit={(item) => edited.push(item)}
                    onGenerate={(item) => generated.push(item)}
                    onDelete={nextOptions.shortcuts ? (item) => deleted.push(item) : undefined}
                    onSaveToLibrary={nextOptions.shortcuts ? (item) => savedToLibrary.push(item) : undefined}
                    selectedIds={nextOptions.selectedIds}
                    sharedLookIds={nextOptions.sharedLookIds}
                    onSelect={nextOptions.selectable ? (item, checked) => selections.push([item.id, checked]) : undefined}
                />,
            ),
        );
    };
    const dispose = async () => {
        await act(async () => root.unmount());
        host.remove();
    };
    try {
        await render();
        return { host, generated, edited, deleted, savedToLibrary, selections, render, dispose };
    } catch (cause) {
        await dispose();
        throw cause;
    }
}

function namedButton(host: HTMLElement, name: string) {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === name);
    expect(button, `未找到按钮：${name}`).toBeDefined();
    return button!;
}

test("截图中的两位主角与多套服装归到父角色，造型不再平铺成同名角色", async () => {
    const wen = asset("wen", "秦子文");
    const wu = asset("wu", "秦子武");
    const cast = [wen, look("wen-suit", wen, "商务西装"), wu, look("wu-sports", wu, "篮球运动服"), look("wu-home", wu, "居家卫衣"), look("wu-fight", wu, "战斗装"), asset("forest", "森林", { kind: "scene" }), asset("axe", "消防斧", { kind: "prop" })];
    cast.forEach(Object.freeze);
    Object.freeze(cast);
    const original = JSON.stringify(cast);
    const ui = await fixture(cast);
    try {
        const cards = [...ui.host.querySelectorAll<HTMLElement>("article.drama-guide-cast")];
        expect(cards).toHaveLength(4);
        expect(cards.map((card) => card.querySelector("h3")!.textContent)).toEqual(["秦子文", "秦子武", "森林", "消防斧"]);
        expect(ui.host.querySelector(".drama-chip")!.textContent).toBe("4 项资产 · 4 套造型");
        expect(cards[0].querySelector("summary")!.textContent).toBe("其他造型（1）");
        expect(cards[1].querySelector("summary")!.textContent).toBe("其他造型（3）");
        expect(cards[0].querySelector("h4")!.textContent).toBe("商务西装");
        expect([...cards[1].querySelectorAll("h4")].map((heading) => heading.textContent)).toEqual(["篮球运动服", "居家卫衣", "战斗装"]);
        expect(cards[0].textContent).not.toContain("篮球运动服");
        expect(cards[1].textContent).not.toContain("商务西装");
        expect(cards[2].querySelector("details")).toBeNull();
        expect(cards[3].querySelector("details")).toBeNull();
        expect(ui.generated).toEqual([]);
        expect(ui.edited).toEqual([]);
        expect(JSON.stringify(cast)).toBe(original);
    } finally {
        await ui.dispose();
    }
});

test("按parentId归属造型，不按同名文本误合并独立的基础资产", async () => {
    const first = asset("first", "同名角色", { description: "第一位角色" });
    const second = asset("second", "同名角色", { description: "第二位角色" });
    const ui = await fixture([first, second, look("first-look", first, "第一套"), look("second-look", second, "第二套"), asset("scene", "同名角色", { kind: "scene", description: "同名场景" })]);
    try {
        const cards = [...ui.host.querySelectorAll<HTMLElement>("article.drama-guide-cast")];
        expect(cards).toHaveLength(3);
        expect(cards[0].textContent).toContain("第一位角色");
        expect(cards[0].querySelector("h4")!.textContent).toBe("第一套");
        expect(cards[1].textContent).toContain("第二位角色");
        expect(cards[1].querySelector("h4")!.textContent).toBe("第二套");
        expect(cards[2].textContent).toContain("同名场景");
        expect(cards[2].querySelector("details")).toBeNull();
        expect(ui.host.querySelector(".drama-chip")!.textContent).toBe("3 项资产 · 2 套造型");
    } finally {
        await ui.dispose();
    }
});

test("展开造型只查看，生成回调仍携带真实造型ID且不提供普通角色编辑入口", async () => {
    const hero = asset("hero", "秦子文");
    const suit = look("suit", hero, "商务西装");
    const home = look("home", hero, "居家服", { imageResourceId: "home-image" });
    const ui = await fixture([hero, suit, home], { sharedLookIds: new Set([home.id]) });
    try {
        const details = ui.host.querySelector<HTMLDetailsElement>("details.drama-guide-cast-looks")!;
        expect(details.open).toBe(false);
        await act(async () => {
            details.open = true;
            details.dispatchEvent(new browser.Event("toggle"));
        });
        expect(ui.generated).toEqual([]);
        const rows = [...details.querySelectorAll<HTMLElement>("article.drama-guide-look")];
        expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["秦子文 · 商务西装", "秦子文 · 居家服"]);
        expect(rows[0].textContent).not.toContain("作品共享 · 本集未引用");
        expect(rows[1].textContent).toContain("作品共享 · 本集未引用");
        expect(rows.every((row) => ![...row.querySelectorAll("button")].some((button) => button.getAttribute("aria-label")?.includes("编辑")))).toBe(true);
        expect(rows[1].querySelector("img")!.getAttribute("data-resource")).toBe("resource:home-image");
        await act(async () => namedButton(ui.host, "秦子文 · 商务西装：生成图片").click());
        await act(async () => namedButton(ui.host, "秦子文 · 居家服：重新生成图片").click());
        await act(async () => namedButton(ui.host, "秦子文：生成图片").click());
        expect(ui.generated).toEqual([suit, home, hero]);
        expect(ui.generated.map((item) => item.id)).toEqual(["suit", "home", "hero"]);
        expect(ui.edited).toEqual([]);
        await act(async () => namedButton(ui.host, "编辑秦子文").click());
        expect(ui.edited).toEqual([hero]);
    } finally {
        await ui.dispose();
    }
});

test("全局保存与每套图片任务分别禁用，失败或过期造型可对准原ID重试", async () => {
    const hero = asset("hero", "秦子武", { imageStatus: "running" });
    const queued = look("queued", hero, "排队造型", { imageStatus: "queued" });
    const failed = look("failed", hero, "失败造型", { imageStatus: "failed" });
    const stale = look("stale", hero, "过期造型", { imageStatus: "stale", imageResourceId: "old-image" });
    const cast = [hero, queued, failed, stale];
    const ui = await fixture(cast);
    try {
        expect(namedButton(ui.host, "秦子武：生成图片").disabled).toBe(true);
        expect(namedButton(ui.host, "秦子武 · 排队造型：生成图片").disabled).toBe(true);
        expect(namedButton(ui.host, "秦子武 · 失败造型：生成图片").disabled).toBe(false);
        expect(namedButton(ui.host, "秦子武 · 过期造型：重新生成图片").disabled).toBe(false);
        expect(ui.host.querySelector('[aria-label="秦子武 · 失败造型"]')!.textContent).toContain("参考图生成失败，可重试");
        expect(ui.host.querySelector('[aria-label="秦子武 · 过期造型"]')!.textContent).toContain("设定已调整，参考图已过期");
        await act(async () => namedButton(ui.host, "秦子武 · 排队造型：生成图片").click());
        expect(ui.generated).toEqual([]);
        await act(async () => namedButton(ui.host, "秦子武 · 失败造型：生成图片").click());
        expect(ui.generated.map((item) => item.id)).toEqual(["failed"]);
        await ui.render(cast, { busy: true });
        expect([...ui.host.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled)).toBe(true);
        await act(async () => namedButton(ui.host, "秦子武 · 过期造型：重新生成图片").click());
        expect(ui.generated.map((item) => item.id)).toEqual(["failed"]);
    } finally {
        await ui.dispose();
    }
});

test("无资产保持加载与空态，单个基础角色不显示空造型区或虚增计数", async () => {
    const ui = await fixture([], { loading: true });
    try {
        expect(ui.host.textContent).toContain("正在提取资产文字设定");
        expect(ui.host.querySelector(".drama-chip")!.textContent).toBe("0 项资产");
        expect(ui.host.querySelectorAll("article")).toHaveLength(0);
        await ui.render([], { loading: false });
        expect(ui.host.textContent).toContain("尚未生成资产文字");
        const hero = asset("hero", "秦子文");
        await ui.render([hero], { loading: false });
        expect(ui.host.querySelectorAll("article.drama-guide-cast")).toHaveLength(1);
        expect(ui.host.querySelector("details")).toBeNull();
        expect(ui.host.querySelector(".drama-chip")!.textContent).toBe("1 项资产");
        expect(ui.generated).toEqual([]);
        expect(ui.edited).toEqual([]);
    } finally {
        await ui.dispose();
    }
});

test("角色与造型复选分别回传真实ID，受控选择不触发编辑或生图且不隐式联选", async () => {
    const hero = asset("hero", "秦子文");
    const suit = look("suit", hero, "商务西装");
    const selected = new Set(["suit"]);
    const ui = await fixture([hero, suit], { selectable: true, selectedIds: selected });
    const checkbox = (label: string) => ui.host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    try {
        expect(checkbox("选择秦子文").checked).toBe(false);
        expect(checkbox("选择秦子文 · 商务西装").checked).toBe(true);
        expect(ui.host.querySelector("article.drama-guide-cast")?.getAttribute("data-selected")).toBeNull();
        await act(async () => checkbox("选择秦子文").click());
        expect(ui.selections).toEqual([["hero", true]]);
        expect([...selected]).toEqual(["suit"]);
        await ui.render([hero, suit], { selectable: true, selectedIds: new Set(["hero", "suit"]) });
        expect(checkbox("选择秦子文").checked).toBe(true);
        expect(ui.host.querySelector("article.drama-guide-cast")?.getAttribute("data-selected")).toBe("true");
        await act(async () => checkbox("选择秦子文 · 商务西装").click());
        expect(ui.selections).toEqual([
            ["hero", true],
            ["suit", false],
        ]);
        expect(ui.generated).toEqual([]);
        expect(ui.edited).toEqual([]);
    } finally {
        await ui.dispose();
    }
});

test("忙碌时角色及造型复选都禁用，普通审阅模式不显示选择控件", async () => {
    const hero = asset("hero", "秦子文");
    const cast = [hero, look("suit", hero, "商务西装")];
    const ui = await fixture(cast, { selectable: true, busy: true, selectedIds: new Set(["hero"]) });
    try {
        const checkboxes = [...ui.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
        expect(checkboxes).toHaveLength(2);
        expect(checkboxes.every((item) => item.disabled)).toBe(true);
        await act(async () => checkboxes.forEach((item) => item.click()));
        expect(ui.selections).toEqual([]);
        await ui.render(cast, {});
        expect(ui.host.querySelector('input[type="checkbox"]')).toBeNull();
        expect(ui.host.querySelector("article.drama-guide-cast")?.getAttribute("data-selected")).toBeNull();
    } finally {
        await ui.dispose();
    }
});

test("紧凑卡片保留描述、真实编辑生成和造型选择，省略重复详情与普通状态但保留异常及忙碌保护", async () => {
    const hero = asset("hero", "秦子文", { imageResourceId: "hero-image", imageStatus: "completed" });
    const suit = look("suit", hero, "商务西装");
    const scene = asset("scene", "森林", { kind: "scene" });
    const failed = asset("failed", "失败角色", { imageStatus: "failed" });
    const generating = asset("generating", "生成中角色", { imageStatus: "running" });
    const stale = asset("stale", "过期角色", { imageStatus: "stale" });
    const cast = [hero, suit, scene, failed, generating, stale];
    const options: FixtureOptions = { compact: true, selectable: true, selectedIds: new Set([hero.id]) };
    const ui = await fixture(cast, options);
    try {
        const cards = [...ui.host.querySelectorAll<HTMLElement>("article.drama-guide-cast")];
        expect(cards).toHaveLength(5);
        expect(cards.every((card) => card.classList.contains("is-compact"))).toBe(true);
        for (const [index, item] of [hero, scene, failed, generating, stale].entries()) {
            const body = cards[index].querySelector<HTMLElement>(".drama-guide-cast-body")!;
            expect(body.querySelector("p")?.textContent).toBe(item.description);
            expect(body.querySelector("p")?.title).toBe(item.description);
            expect(body.textContent).not.toContain(item.appearance);
            expect(body.textContent).not.toContain(item.voiceInstructions);
            expect(body.querySelector(".drama-guide-cast-detail")).toBeNull();
            expect(body.classList.contains("thin-scrollbar")).toBe(false);
        }
        expect(cards[0].querySelector("img")?.getAttribute("data-resource")).toBe("resource:hero-image");
        expect(cards[0].querySelector(":scope > footer [role='status']")).toBeNull();
        expect(cards[1].querySelector(":scope > footer [role='status']")).toBeNull();
        expect(cards[2].querySelector(":scope > footer [role='status']")?.textContent).toBe("参考图生成失败，可重试");
        expect(cards[3].querySelector(":scope > footer [role='status']")?.textContent).toBe("参考图正在生成");
        expect(cards[4].querySelector(":scope > footer [role='status']")?.textContent).toBe("设定已调整，参考图已过期");
        await act(async () => namedButton(ui.host, "编辑秦子文").click());
        expect(ui.edited[0]).toBe(hero);
        await act(async () => namedButton(ui.host, "秦子文：重新生成图片").click());
        expect(ui.generated[0]).toBe(hero);
        await act(async () => namedButton(ui.host, "森林：生成图片").click());
        expect(ui.generated[1]).toBe(scene);
        const details = cards[0].querySelector<HTMLDetailsElement>("details.drama-guide-cast-looks")!;
        expect(details.open).toBe(false);
        await act(async () => {
            details.open = true;
            details.dispatchEvent(new browser.Event("toggle"));
        });
        const lookSelection = details.querySelector<HTMLInputElement>('input[aria-label="选择秦子文 · 商务西装"]')!;
        expect(lookSelection.disabled).toBe(false);
        await act(async () => lookSelection.click());
        expect(ui.selections).toEqual([[suit.id, true]]);
        await act(async () => namedButton(ui.host, "秦子文 · 商务西装：生成图片").click());
        expect(ui.generated[2]).toBe(suit);
        const runningButton = namedButton(ui.host, "生成中角色：生成图片");
        expect(runningButton.disabled).toBe(true);
        await act(async () => runningButton.click());
        expect(ui.generated).toHaveLength(3);
        await ui.render(cast, { ...options, busy: true });
        expect([...ui.host.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled)).toBe(true);
        expect([...ui.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every((input) => input.disabled)).toBe(true);
        await act(async () => namedButton(ui.host, "失败角色：生成图片").click());
        expect(ui.generated).toHaveLength(3);
    } finally {
        await ui.dispose();
    }
});

test("紧凑卡顶工具栏独立于图片，三类资产快捷操作按真实对象分派且底部不重复生成", async () => {
    const hero = asset("hero", "林夏", { imageResourceId: "hero-image" });
    const scene = asset("scene", "旧宅", { kind: "scene" });
    const prop = asset("prop", "铜钥匙", { kind: "prop", imageStatus: "failed" });
    const cast = [hero, scene, prop];
    const ui = await fixture(cast, { compact: true, shortcuts: true, selectable: true });
    try {
        const cards = [...ui.host.querySelectorAll<HTMLElement>("article.drama-guide-cast")];
        for (const [index, item] of cast.entries()) {
            const card = cards[index];
            const toolbar = card.querySelector<HTMLElement>(".drama-guide-asset-toolbar")!;
            const header = card.querySelector("header")!;
            const media = card.querySelector(".drama-guide-asset-thumb")!;
            expect(card.firstElementChild).toBe(toolbar);
            expect(toolbar.getAttribute("aria-label")).toBe(`${item.name}的快捷操作`);
            expect(toolbar.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
            expect(media.contains(toolbar)).toBe(false);
            expect(toolbar.contains(card.querySelector('input[type="checkbox"]'))).toBe(true);
            expect(toolbar.querySelectorAll("button")).toHaveLength(item.kind === "character" ? 3 : 2);
            expect(card.querySelectorAll(":scope > footer button")).toHaveLength(0);
            const generationLabel = `${item.name}：${item.imageResourceId ? "重新生成图片" : "生成图片"}`;
            expect(card.querySelectorAll(`button[aria-label="${generationLabel}"]`)).toHaveLength(1);
            await act(async () => namedButton(toolbar, `删除${item.name}`).click());
            await act(async () => namedButton(toolbar, generationLabel).click());
            expect(ui.deleted[index]).toBe(item);
            expect(ui.generated[index]).toBe(item);
        }
        expect(cards[0].querySelector(":scope > footer")).toBeNull();
        expect(cards[1].querySelector(":scope > footer")).toBeNull();
        expect(cards[2].querySelector(":scope > footer [role='status']")?.textContent).toBe("参考图生成失败，可重试");
        await act(async () => namedButton(cards[0], "将林夏加入角色库").click());
        expect(ui.savedToLibrary).toEqual([hero]);
        expect(ui.savedToLibrary[0]).toBe(hero);
        expect(ui.host.querySelector('button[aria-label="将旧宅加入角色库"]')).toBeNull();
        expect(ui.host.querySelector('button[aria-label="将铜钥匙加入角色库"]')).toBeNull();
        expect(ui.edited).toEqual([]);
        expect(ui.selections).toEqual([]);
    } finally {
        await ui.dispose();
    }
});

test("未提供可选回调不显示删除或存库图标，在途图片和全局忙碌阻止快捷操作", async () => {
    const hero = asset("hero", "林夏");
    const queued = asset("queued", "排队角色", { imageStatus: "queued" });
    const ui = await fixture([hero, queued], { compact: true, selectable: true });
    try {
        expect(ui.host.querySelector('button[aria-label="删除林夏"]')).toBeNull();
        expect(ui.host.querySelector('button[aria-label="将林夏加入角色库"]')).toBeNull();
        expect(namedButton(ui.host, "林夏：生成图片").disabled).toBe(false);
        await ui.render([hero, queued], { compact: true, shortcuts: true, selectable: true });
        for (const label of ["删除排队角色", "排队角色：生成图片", "将排队角色加入角色库"]) {
            const action = namedButton(ui.host, label);
            expect(action.disabled).toBe(true);
            await act(async () => action.click());
        }
        expect(ui.generated).toEqual([]);
        expect(ui.deleted).toEqual([]);
        expect(ui.savedToLibrary).toEqual([]);
        await ui.render([hero, queued], { compact: true, shortcuts: true, selectable: true, busy: true });
        for (const action of ui.host.querySelectorAll<HTMLButtonElement>("button")) expect(action.disabled).toBe(true);
        for (const input of ui.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) expect(input.disabled).toBe(true);
        await act(async () => {
            namedButton(ui.host, "删除林夏").click();
            namedButton(ui.host, "林夏：生成图片").click();
            namedButton(ui.host, "将林夏加入角色库").click();
        });
        expect(ui.generated).toEqual([]);
        expect(ui.deleted).toEqual([]);
        expect(ui.savedToLibrary).toEqual([]);
    } finally {
        await ui.dispose();
    }
});

test("两种布局的三类资产即使位于共享折叠区，标题、描述、图片和空白也直接编辑且不重复触发", async () => {
    const cast = [asset("hero", "林夏", { imageResourceId: "hero-image" }), asset("room", "旧宅", { kind: "scene", imageResourceId: "room-image" }), asset("key", "铜钥匙", { kind: "prop", imageResourceId: "key-image" })];
    for (const compact of [true, false]) {
        const ui = await fixture(cast, { compact });
        const shared = document.createElement("details");
        shared.open = true;
        const summary = document.createElement("summary");
        summary.textContent = "作品共享 · 本集未引用";
        shared.append(summary, ui.host);
        document.body.append(shared);
        try {
            const cards = [...ui.host.querySelectorAll<HTMLElement>("article.drama-guide-cast")];
            for (const [index, item] of cast.entries()) {
                const card = cards[index];
                const title = namedButton(card, `编辑${item.name}`);
                expect(title.textContent).toBe(item.name);
                expect(card.querySelectorAll(`button[aria-label="编辑${item.name}"]`)).toHaveLength(1);
                expect(card.querySelector("h3 button")).toBe(title);
                await act(async () => title.click());
                expect(ui.edited).toHaveLength(index * 4 + 1);
                await act(async () => card.querySelector<HTMLElement>(".drama-guide-cast-body p")!.click());
                await act(async () => card.querySelector<HTMLImageElement>("img")!.click());
                await act(async () => card.click());
                expect(ui.edited.slice(index * 4)).toEqual([item, item, item, item]);
                expect(ui.edited.at(-1)).toBe(item);
            }
            expect(ui.generated).toEqual([]);
            expect(ui.selections).toEqual([]);
        } finally {
            await ui.dispose();
            shared.remove();
        }
    }
});

test("卡片内选择、快捷按钮和造型展开只执行自身动作，不误开编辑", async () => {
    const hero = asset("hero", "林夏");
    const rain = look("rain", hero, "雨夜");
    const ui = await fixture([hero, rain], { compact: true, shortcuts: true, selectable: true });
    try {
        const card = ui.host.querySelector<HTMLElement>("article.drama-guide-cast")!;
        const checkbox = card.querySelector<HTMLInputElement>('input[aria-label="选择林夏"]')!;
        await act(async () => checkbox.click());
        await act(async () => namedButton(card, "删除林夏").click());
        await act(async () => namedButton(card, "林夏：生成图片").click());
        await act(async () => namedButton(card, "将林夏加入角色库").click());
        await act(async () => card.querySelector<HTMLElement>(".drama-guide-asset-toolbar")!.click());
        const details = card.querySelector<HTMLDetailsElement>("details")!;
        await act(async () => details.querySelector<HTMLElement>("summary")!.click());
        await act(async () => details.querySelector<HTMLElement>("h4")!.click());
        await act(async () => details.querySelector<HTMLInputElement>('input[aria-label="选择林夏 · 雨夜"]')!.click());
        await act(async () => namedButton(details, "林夏 · 雨夜：生成图片").click());
        expect(ui.selections).toEqual([
            [hero.id, true],
            [rain.id, true],
        ]);
        expect(ui.generated).toEqual([hero, rain]);
        expect(ui.deleted).toEqual([hero]);
        expect(ui.savedToLibrary).toEqual([hero]);
        expect(ui.edited).toEqual([]);
    } finally {
        await ui.dispose();
    }
});

test("两种布局忙碌时卡片和标题均不能编辑，恢复后名称和卡片都可直接编辑", async () => {
    const hero = asset("hero", "林夏");
    for (const compact of [true, false]) {
        const ui = await fixture([hero], { compact, busy: true });
        try {
            const title = namedButton(ui.host, "编辑林夏");
            expect(title.disabled).toBe(true);
            await act(async () => title.click());
            await act(async () => ui.host.querySelector<HTMLElement>("article.drama-guide-cast")!.click());
            expect(ui.edited).toEqual([]);
            await ui.render([hero], { compact });
            expect(namedButton(ui.host, "编辑林夏").disabled).toBe(false);
            await act(async () => namedButton(ui.host, "编辑林夏").click());
            await act(async () => ui.host.querySelector<HTMLElement>("article.drama-guide-cast")!.click());
            expect(ui.edited).toEqual([hero, hero]);
        } finally {
            await ui.dispose();
        }
    }
});
