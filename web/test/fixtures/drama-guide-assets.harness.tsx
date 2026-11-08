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
mock.module("@/pages/projects/asset-scheme", () => ({ AssetSchemePicker: empty }));
mock.module("@/components/ui/product/app-modal", () => ({ AppModal: empty }));
mock.module("@/pages/projects/drama-model-picker", () => ({ DramaModelPicker: empty, useDramaModelCatalog: empty }));
mock.module("@/pages/projects/step-settings", () => ({ DramaAssetImageModels: empty, DramaTextSteps: empty, VideoResolutionField: empty }));
mock.module("@/pages/projects/storyboard-rules", () => ({ EpisodeDurationInput: empty, StoryboardRules: empty }));
mock.module("@/pages/projects/style-picker", () => ({ DramaStylePicker: empty }));
mock.module("@/pages/projects/studio/segment-parts", () => ({ secondsLabel: () => "", SegmentStatus: empty }));
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

async function fixture(cast: DramaCast[], options: { busy?: boolean; loading?: boolean } = {}) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const generated: DramaCast[] = [];
    const edited: DramaCast[] = [];
    const render = async (next = cast, nextOptions = options) => {
        await act(async () => root.render(<GuideAssets cast={next} busy={Boolean(nextOptions.busy)} loading={Boolean(nextOptions.loading)} onEdit={(item) => edited.push(item)} onGenerate={(item) => generated.push(item)} />));
    };
    const dispose = async () => {
        await act(async () => root.unmount());
        host.remove();
    };
    try {
        await render();
        return { host, generated, edited, render, dispose };
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
    const ui = await fixture([hero, suit, home]);
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
        expect(rows.every((row) => ![...row.querySelectorAll("button")].some((button) => button.getAttribute("aria-label")?.includes("编辑")))).toBe(true);
        expect(rows[1].querySelector("img")!.getAttribute("data-resource")).toBe("resource:home-image");
        await act(async () => namedButton(ui.host, "秦子文 · 商务西装：生成参考图").click());
        await act(async () => namedButton(ui.host, "秦子文 · 居家服：重新生成图片").click());
        await act(async () => namedButton(ui.host, "秦子文：生成参考图").click());
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
        expect(namedButton(ui.host, "秦子武：生成参考图").disabled).toBe(true);
        expect(namedButton(ui.host, "秦子武 · 排队造型：生成参考图").disabled).toBe(true);
        expect(namedButton(ui.host, "秦子武 · 失败造型：生成参考图").disabled).toBe(false);
        expect(namedButton(ui.host, "秦子武 · 过期造型：重新生成图片").disabled).toBe(false);
        expect(ui.host.querySelector('[aria-label="秦子武 · 失败造型"]')!.textContent).toContain("参考图生成失败，可重试");
        expect(ui.host.querySelector('[aria-label="秦子武 · 过期造型"]')!.textContent).toContain("设定已调整，参考图已过期");
        await act(async () => namedButton(ui.host, "秦子武 · 排队造型：生成参考图").click());
        expect(ui.generated).toEqual([]);
        await act(async () => namedButton(ui.host, "秦子武 · 失败造型：生成参考图").click());
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
