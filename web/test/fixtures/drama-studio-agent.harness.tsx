import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { DramaSummary } from "@/services/api/drama";

const dom = new Window({ url: "http://localhost/" });
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useStudioAgent } = await import("@/pages/projects/studio/use-studio-agent");
const { useGlobalAgentStore } = await import("@/stores/use-global-agent-store");
afterAll(() => dom.happyDOM.abort());

function summary(id: string, guideConversationId = `${id}-conversation`): DramaSummary {
    return { project: { id }, production: { guideStep: "completed", guideConversationId } } as DramaSummary;
}
function BoundStudio(props: { projectId: string; summary?: DramaSummary; unavailable?: boolean }) {
    useStudioAgent(props.projectId, props.summary, Boolean(props.unavailable));
    return null;
}
async function fixture() {
    useGlobalAgentStore.getState().reset();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    return {
        async render(projectId: string, current?: DramaSummary, unavailable = false) {
            await act(async () => root.render(<BoundStudio projectId={projectId} summary={current} unavailable={unavailable} />));
        },
        async dispose() {
            await act(async () => root.unmount());
            host.remove();
            useGlobalAgentStore.getState().reset();
        },
    };
}

test("已完成引导的制作台沿用原会话，保持悬浮入口和用户开合状态", async () => {
    const ui = await fixture();
    try {
        await ui.render("first", summary("first"));
        const current = useGlobalAgentStore.getState();
        expect(current.drama).toEqual({ projectId: "first", guideConversationId: "first-conversation" });
        expect(current.drama?.host).toBeUndefined();
        expect(current.open).toBe(false);
        current.openAgent();
        await ui.render("first", summary("first"));
        expect(useGlobalAgentStore.getState().open).toBe(true);
        expect(useGlobalAgentStore.getState().drama).toBe(current.drama);
    } finally {
        await ui.dispose();
    }
    expect(useGlobalAgentStore.getState().drama).toBeNull();
});

test("切换作品不接受旧摘要，草稿、引导中和读取错误不发布制作台上下文", async () => {
    const ui = await fixture();
    try {
        await ui.render("first", summary("first"));
        await ui.render("second", summary("first"));
        expect(useGlobalAgentStore.getState().drama).toBeNull();
        const current = summary("second");
        await ui.render("second", current, true);
        expect(useGlobalAgentStore.getState().drama).toBeNull();
        await ui.render("second", { ...current, production: { ...current.production, hasDraftForm: true } });
        expect(useGlobalAgentStore.getState().drama).toBeNull();
        await ui.render("second", { ...current, production: { ...current.production, guideStep: "story" } });
        expect(useGlobalAgentStore.getState().drama).toBeNull();
        await ui.render("second", current);
        expect(useGlobalAgentStore.getState().drama).toEqual({ projectId: "second", guideConversationId: "second-conversation" });
    } finally {
        await ui.dispose();
    }
});

test("清理只移除本次发布的上下文，不覆盖另一个页面的新绑定", async () => {
    const ui = await fixture();
    try {
        await ui.render("first", summary("first"));
        const newer = { projectId: "first", guideConversationId: "new-conversation", host: document.createElement("div") };
        useGlobalAgentStore.getState().setDrama(newer);
        await ui.render("first", undefined);
        expect(useGlobalAgentStore.getState().drama).toBe(newer);
    } finally {
        await ui.dispose();
    }
});
