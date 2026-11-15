import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";

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
let account = "user-a";
let composer: Record<string, any>;
const navigation: Array<{ path: string; state: unknown }> = [];
const creations: string[] = [];
const user = create(() => ({ user: { id: "user-a" }, runtimeLimits: { resourceUploadMB: 50 } }));
const canvas = create(() => ({
    hydrated: true,
    createDraftProject: (title: string) => {
        creations.push(title);
        return "entry-canvas";
    },
}));
const userScope = await import("@/lib/user-scope");
mock.module("@/lib/user-scope", () => ({ ...userScope, getActiveUserScope: () => account }));
mock.module("@/stores/use-user-store", () => ({ useUserStore: user }));
mock.module("@/stores/canvas/use-canvas-store", () => ({ useCanvasStore: canvas, canvasDraftNavigationState: (id: string) => ({ canvasDraft: { id } }) }));
mock.module("@/stores/canvas/use-canvas-theme-store", () => ({ useActiveTheme: () => "light" }));
mock.module("@/hooks/use-auth-entry", () => ({ useAuthEntry: () => ({ openAuth: () => {} }) }));
mock.module("@/services/user-data-sync", () => ({ hasRemoteUserDataSyncSession: () => true }));
mock.module("@/services/api/skills", () => ({ listAddedSkills: async () => ({ skills: [{ skillId: "director", skillName: "导演技能", description: "镜头编排", isAdded: true }] }) }));
mock.module("react-router", () => ({ useNavigate: () => (path: string, options: { state: unknown }) => navigation.push({ path, state: options.state }) }));
mock.module("antd", () => ({
    App: { useApp: () => ({ message: { warning: () => {} } }) },
    Button: ({ children, ...props }: { children?: ReactNode }) => createElement("button", props, children),
}));
mock.module("@/components/ui/product/app-modal", () => ({ AppModal: ({ open, children, footer }: { open: boolean; children?: ReactNode; footer?: ReactNode }) => (open ? createElement("div", { role: "dialog" }, children, footer) : null) }));
mock.module("@/components/canvas/canvas-cloud-agent-composer", () => ({
    AgentChatComposer: (props: Record<string, any>) => {
        composer = props;
        return createElement(
            "div",
            null,
            createElement("textarea", { "aria-label": "Agent 输入", value: props.prompt, readOnly: true }),
            props.left,
            createElement("button", { disabled: props.disabled, onClick: () => props.onSubmit({ alternate: false }), "aria-label": props.submitActionLabel }, "继续创作"),
        );
    },
}));
const { WorkflowCanvasEntry } = await import("@/pages/projects/workflow-canvas-entry");
const { takeCanvasAgentEntry } = await import("@/services/canvas-agent-entry");
const settle = async () => {
    for (let i = 0; i < 3; i++) await Bun.sleep(10);
};
async function mount(options: { onBeforeCreate?: () => Promise<boolean> } = {}) {
    account = "user-a";
    user.setState({ user: { id: "user-a" } });
    creations.length = 0;
    navigation.length = 0;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let props = { ...options, disabled: false, hidden: false };
    const update = async (patch: Partial<typeof props>) => {
        props = { ...props, ...patch };
        await act(async () => {
            root.render(createElement(WorkflowCanvasEntry, props));
            await settle();
        });
    };
    await update({});
    return {
        host,
        update,
        close: async () => {
            await act(async () => root.unmount());
            host.remove();
        },
    };
}
async function call(callback: () => void) {
    await act(async () => {
        callback();
        await settle();
    });
}
afterAll(() => browser.happyDOM.abort());

test("切换标签保留输入、技能和原始参考图，创建只交接草稿不生成", async () => {
    const view = await mount();
    const file = new File(["reference-image"], "参考.png", { type: "image/png" });
    try {
        await call(() => composer.onPromptChange("请根据参考图制作一段故事"));
        await call(() => composer.onAddFiles([file]));
        await call(() => view.host.querySelector<HTMLButtonElement>('[aria-label="选择创作技能"]')!.click());
        await call(() => view.host.querySelector<HTMLInputElement>('.drama-canvas-entry-skill-picker input[type="checkbox"]')!.click());
        expect(composer.prompt).toContain("@[skill:director]");
        const before = composer.prompt;
        await view.update({ hidden: true });
        await view.update({ hidden: false });
        expect(composer.prompt).toBe(before);
        expect(composer.attachments).toHaveLength(1);
        await call(() => composer.onSubmit({ alternate: false }));
        expect(creations).toEqual(["创作画布"]);
        expect(navigation).toEqual([{ path: "/canvas/entry-canvas?agent=1", state: { canvasDraft: { id: "entry-canvas" } } }]);
        const handoff = takeCanvasAgentEntry("entry-canvas")!;
        expect(handoff.text).toBe(before);
        expect(handoff.skillIds).toEqual(["director"]);
        expect(handoff.files[0]!.file).toBe(file);
        expect(takeCanvasAgentEntry("entry-canvas")).toBeNull();
    } finally {
        await view.close();
    }
});

test("确认取消保留草稿，确认期间重复点击只创建一次且父disabled不会阻断确认结果", async () => {
    let resolve!: (value: boolean) => void;
    let confirms = 0;
    const view = await mount({
        onBeforeCreate: () => {
            confirms++;
            return new Promise<boolean>((done) => {
                resolve = done;
            });
        },
    });
    try {
        await call(() => composer.onPromptChange("保留的创意"));
        await call(() => {
            composer.onSubmit({ alternate: false });
            composer.onSubmit({ alternate: false });
        });
        expect(confirms).toBe(1);
        expect(creations).toHaveLength(0);
        await call(() => resolve(false));
        expect(composer.prompt).toBe("保留的创意");
        await call(() => composer.onSubmit({ alternate: false }));
        await view.update({ disabled: true });
        await call(() => resolve(true));
        expect(creations).toHaveLength(1);
        expect(navigation).toHaveLength(1);
        takeCanvasAgentEntry("entry-canvas");
    } finally {
        await view.close();
    }
});

test("等待确认切换账号后不会替新账号创建画布，能力捷径只补草稿", async () => {
    let resolve!: (value: boolean) => void;
    const view = await mount({
        onBeforeCreate: () =>
            new Promise<boolean>((done) => {
                resolve = done;
            }),
    });
    try {
        await call(() => view.host.querySelector<HTMLButtonElement>(".drama-canvas-entry-capabilities button")!.click());
        expect(composer.prompt).toContain("视频");
        expect(creations).toHaveLength(0);
        await call(() => composer.onSubmit({ alternate: false }));
        await call(() => {
            account = "user-b";
            user.setState({ user: { id: "user-b" } });
        });
        await call(() => resolve(true));
        expect(creations).toHaveLength(0);
        expect(navigation).toHaveLength(0);
        expect(composer.prompt).toBe("");
    } finally {
        await view.close();
    }
});
