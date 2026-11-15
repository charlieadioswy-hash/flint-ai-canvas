import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, useState, type ReactNode } from "react";

import type { DramaAssetMode, DramaAssetSchemeCatalog, DramaAssetSettings } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/projects" });
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    Event: browser.Event,
    InputEvent: browser.InputEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { environmentManager } = await import("@tanstack/query-core");
environmentManager.setIsServer(() => false);

const modes: Array<[Exclude<DramaAssetMode, "custom">, string, string]> = [
    ["none", "不使用", "16:9"],
    ["closeup_turnaround", "单特写+三视图", "16:9"],
    ["closeup_front_no_face", "单特写+正面无面部", "16:9"],
    ["closeup_turnaround_no_head", "单特写+三视图无头部", "16:9"],
    ["closeup_fullbody", "单特写+全身", "16:9"],
    ["dual_closeup_front_back_no_head", "双特写+正背面无头部", "9:16"],
    ["triple_closeup_front_no_face", "面部三特写+正面无面部", "16:9"],
    ["turnaround_triple_closeup", "三视图+脸部三特写", "16:9"],
    ["turnaround_five_angle_halfbody", "三视图+五角度半身照", "16:9"],
    ["headshot_fullbody", "大头照+全身照", "16:9"],
];
const catalog: DramaAssetSchemeCatalog = {
    schemes: modes.map(([mode, name, ratio]) => ({ mode, name, ratio, description: `${name}的单张构图说明`, frameHint: `${name}版式，只沿用角色外貌`, characterPrompt: `${mode}，{{角色名称}}：{{角色设定}}。{{项目画风}}。{{画面规则}}` })),
    sceneSchemes: [],
    scenePrompt: "场景：{{场景名称}}，{{场景设定}}。{{项目画风}}。{{画面规则}}",
    characterVariables: [],
    sceneVariables: [],
};
let activeCatalog = catalog;
const confirmations: Array<{ onOk: () => void }> = [];
mock.module("@/services/api/drama", () => ({ getDramaAssetSchemes: async () => activeCatalog }));
mock.module("@/services/api/skills", () => ({ listAddedSkills: async () => ({ skills: [] }), listSkillFiles: async () => ({ files: [] }), getSkillFile: async () => ({ file: { content: "" } }) }));
mock.module("antd", () => ({
    App: { useApp: () => ({ modal: { confirm: (options: { onOk: () => void }) => confirmations.push(options) }, message: { info: () => {}, warning: () => {} } }) },
    Button: ({ children, icon, type: _type, size: _size, ...props }: { children?: ReactNode; icon?: ReactNode; type?: string; size?: string } & Record<string, unknown>) => createElement("button", { type: "button", ...props }, icon, children),
    Input: Object.assign(({ ...props }: Record<string, unknown>) => createElement("input", props), { TextArea: ({ autoSize: _autoSize, showCount: _showCount, status: _status, ...props }: Record<string, unknown>) => createElement("textarea", props) }),
}));
mock.module("@/components/ui/product/app-modal", () => ({ AppModal: ({ open, children }: { open?: boolean; children?: ReactNode }) => (open ? createElement("section", { role: "dialog" }, children) : null) }));

const { AssetSchemePicker, defaultAssetSettings } = await import("@/pages/projects/asset-scheme");
const settle = async () => {
    for (let index = 0; index < 3; index += 1) await Bun.sleep(10);
};
async function mount(initial = defaultAssetSettings(catalog)!, selectedCatalog = catalog) {
    activeCatalog = selectedCatalog;
    confirmations.length = 0;
    const changes: DramaAssetSettings[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    let value = initial;
    function Editor() {
        const [draft, setDraft] = useState(initial);
        return createElement(AssetSchemePicker, {
            value: draft,
            sample: { characterName: "林晚", characterAppearance: "黑发，深色外套", style: "电影感" },
            onChange: (next) => {
                changes.push(next);
                value = next;
                setDraft(next);
            },
        });
    }
    await act(async () => {
        root.render(createElement(QueryClientProvider, { client }, createElement(Editor)));
        await settle();
    });
    await act(async () => settle());
    return {
        container,
        changes,
        value: () => value,
        close: async () => {
            await act(async () => root.unmount());
            container.remove();
            client.clear();
        },
    };
}
async function call(callback: () => void) {
    await act(async () => {
        callback();
        await settle();
    });
}
function choose(container: HTMLElement, mode: DramaAssetMode) {
    const preview = container.querySelector(`[data-template="${mode}"]`);
    expect(preview, `未找到模板 ${mode}`).not.toBeNull();
    return call(() => preview!.closest<HTMLButtonElement>("button")!.click());
}
afterAll(() => browser.happyDOM.abort());

test("默认明确选择单特写加三视图，不受不使用选项排第一影响，空目录无伪默认", () => {
    expect(defaultAssetSettings(catalog)?.mode).toBe("closeup_turnaround");
    expect(defaultAssetSettings(catalog)?.characterRatio).toBe("16:9");
    expect(defaultAssetSettings({ ...catalog, schemes: [] })).toBeUndefined();
    expect(defaultAssetSettings()).toBeUndefined();
});

test("10种模板展示各自构图，裁头身体与完整头身及大头照保持区别", async () => {
    const view = await mount();
    try {
        const options = view.container.querySelectorAll('[aria-label="角色参考图方案"] [role="radio"]');
        expect(options).toHaveLength(10);
        const composition: Array<[DramaAssetMode, number, number, number, number]> = [
            ["none", 0, 0, 0, 0],
            ["closeup_turnaround", 1, 3, 0, 0],
            ["closeup_front_no_face", 1, 0, 1, 0],
            ["closeup_turnaround_no_head", 1, 0, 3, 0],
            ["closeup_fullbody", 1, 1, 0, 0],
            ["dual_closeup_front_back_no_head", 2, 0, 2, 0],
            ["triple_closeup_front_no_face", 4, 0, 1, 0],
            ["turnaround_triple_closeup", 3, 3, 0, 0],
            ["turnaround_five_angle_halfbody", 0, 3, 0, 0],
            ["headshot_fullbody", 0, 0, 1, 1],
        ];
        for (const [mode, closeup, full, headless, headshot] of composition) {
            const preview = view.container.querySelector(`[data-template="${mode}"]`)!;
            expect(preview.getAttribute("aria-hidden")).toBe("true");
            for (const [crop, count] of Object.entries({ closeup, full, headless, headshot })) expect(preview.querySelectorAll(`[data-crop="${crop}"]`)).toHaveLength(count);
            expect(preview.querySelectorAll('[data-crop="headless"] .is-skin')).toHaveLength(0);
        }
        const angles = view.container.querySelector('[data-template="turnaround_five_angle_halfbody"]')!;
        expect(Array.from(angles.querySelectorAll('[data-crop="halfbody"]'), (figure) => figure.getAttribute("data-view"))).toEqual(["front", "side", "left-three-quarter", "three-quarter", "back"]);
        const faces = view.container.querySelector('[data-template="turnaround_triple_closeup"]')!;
        expect(faces.querySelector('[data-view="left-three-quarter"] g[transform="translate(80 0) scale(-1 1)"]')).not.toBeNull();
        expect(faces.querySelector('[data-crop="closeup"][data-view="three-quarter"]')).not.toBeNull();
        expect(view.container.textContent).toContain("多个视角合在同一张图中");
        expect(view.container.textContent).not.toContain("声纹");
    } finally {
        await view.close();
    }
});

test("选择模板传递对应全文与画幅，竖板9比16，其余16比9且不改变场景提示词", async () => {
    const initial = { ...defaultAssetSettings(catalog)!, scenePrompt: "保留场景约束", resolution: "2k" };
    const view = await mount(initial);
    try {
        for (const scheme of catalog.schemes) {
            await choose(view.container, scheme.mode);
            expect(view.value()).toMatchObject({ mode: scheme.mode, characterPrompt: scheme.characterPrompt, characterRatio: scheme.ratio, scenePrompt: initial.scenePrompt, resolution: "2k" });
            const selected = view.container.querySelector('[aria-label="角色参考图方案"] [aria-checked="true"]');
            expect(selected?.textContent).toContain(scheme.name);
            expect(selected?.textContent).toContain(`${scheme.ratio} · 单张参考图`);
            expect(view.container.querySelector<HTMLTextAreaElement>('[aria-label="角色参考图提示词"]')?.value).toBe(scheme.characterPrompt);
            expect(view.container.querySelector(".drama-assets-preview")?.textContent).toContain("林晚");
        }
        expect(confirmations).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("已修改的提示词切模板先确认，确认前保留草稿，自定义入口保留全文与画幅", async () => {
    const initial = { ...defaultAssetSettings(catalog)!, characterPrompt: "人工修改的角色约束", sourceSkillId: "old-skill", sourceSkillName: "旧约束" };
    const view = await mount(initial);
    try {
        await choose(view.container, "closeup_fullbody");
        expect(view.changes).toHaveLength(0);
        expect(view.value()).toEqual(initial);
        expect(confirmations).toHaveLength(1);
        await call(() => confirmations[0].onOk());
        expect(view.value().mode).toBe("closeup_fullbody");
        expect(view.value().sourceSkillId).toBeUndefined();
        const before = view.value();
        const custom = Array.from(view.container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "自定义提示词")!;
        await call(() => custom.click());
        expect(view.value()).toEqual({ ...before, mode: "custom" });
        expect(custom.getAttribute("aria-pressed")).toBe("true");
        expect(view.container.querySelector('[aria-label="角色参考图画幅"] [aria-checked="true"]')?.textContent).toBe(before.characterRatio);
        expect(view.container.querySelectorAll('[aria-label="角色参考图方案"] [role="radio"]')).toHaveLength(10);
    } finally {
        await view.close();
    }
});

test("目录为空时自定义草稿仍可预览，不读取不存在的首个模板", async () => {
    const initial: DramaAssetSettings = { mode: "custom", characterPrompt: "{{角色名称}}保留自定义约束", scenePrompt: "场景约束", characterRatio: "16:9" };
    const view = await mount(initial, { ...catalog, schemes: [] });
    try {
        expect(view.container.querySelectorAll('[aria-label="角色参考图方案"] [role="radio"]')).toHaveLength(0);
        expect(view.container.querySelector(".drama-assets-preview")?.textContent).toContain("林晚保留自定义约束");
        expect(view.value()).toEqual(initial);
    } finally {
        await view.close();
    }
});
