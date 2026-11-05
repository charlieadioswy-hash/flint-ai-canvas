import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://localhost/projects/project/guide" });
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    SVGElement: browser.SVGElement,
    ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
}))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { act, Profiler, StrictMode, useCallback, useState } = await import("react");
const { createPortal } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { AgentConversation } = await import("@/components/canvas/canvas-cloud-agent-panel-parts");
const { canvasThemes } = await import("@/lib/canvas-theme");
const silent = () => {};

afterAll(() => browser.happyDOM.abort());

test("操作位于消息滚动区，稳定重渲染不反复设置 host，切换会话和项目后使用新 host", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const hosts: Array<HTMLDivElement | null> = [];
    const root = createRoot(container);
    let commits = 0;
    let applied = 0;
    function Harness({ scope, guideMode }: { scope: string; guideMode: boolean }) {
        const [host, setHost] = useState<HTMLDivElement | null>(null);
        const onActionsHost = useCallback((element: HTMLDivElement | null) => {
            hosts.push(element);
            setHost(element);
        }, []);
        return (
            <>
                <AgentConversation
                    key={scope}
                    guideMode={guideMode}
                    onActionsHost={onActionsHost}
                    theme={canvasThemes.light}
                    messages={[{ id: "assistant", role: "assistant", text: "请确认创作配置" }]}
                    references={[]}
                    busy={false}
                    approval={null}
                    approvalSubmitting={false}
                    nodeCount={null}
                    installedSkillCount={null}
                    onChooseSkill={silent}
                    onOpenSkillRecommendations={silent}
                    onDraftPrompt={silent}
                    onApprovalReasonChange={silent}
                    onApprove={silent}
                    onReject={silent}
                />
                {host
                    ? createPortal(
                          <button type="button" onClick={() => applied++}>
                              应用建议并继续
                          </button>,
                          host,
                      )
                    : null}
            </>
        );
    }
    const render = async (scope: string, guideMode = true) => {
        commits = 0;
        await act(async () => {
            root.render(
                <StrictMode>
                    <Profiler
                        id="chat-actions"
                        onRender={() => {
                            if (++commits > 12) throw new Error("聊天操作挂载点持续重复更新");
                        }}
                    >
                        <Harness scope={scope} guideMode={guideMode} />
                    </Profiler>
                </StrictMode>,
            );
        });
    };
    try {
        await render("drama:project-a:conversation-a");
        const first = container.querySelector<HTMLDivElement>("[data-drama-agent-actions]")!;
        expect(first).toBeTruthy();
        expect(first.parentElement?.classList.contains("agent-conversation-messages")).toBe(true);
        expect(container.querySelector("[data-agent-conversation]")?.contains(first)).toBe(true);
        expect(first.textContent).toContain("应用建议并继续");
        await act(async () => first.querySelector("button")!.click());
        expect(applied).toBe(1);
        const notifications = hosts.length;
        await render("drama:project-a:conversation-a");
        expect(hosts).toHaveLength(notifications);
        expect(container.querySelector("[data-drama-agent-actions]")).toBe(first);
        for (const scope of ["drama:project-a:conversation-b", "drama:project-b:conversation-b"]) {
            const previous = container.querySelector<HTMLDivElement>("[data-drama-agent-actions]")!;
            const start = hosts.length;
            await render(scope);
            const current = container.querySelector<HTMLDivElement>("[data-drama-agent-actions]")!;
            expect(current).not.toBe(previous);
            expect(previous.isConnected).toBe(false);
            expect(hosts.slice(start)).toContain(null);
            expect(current.textContent).toContain("应用建议并继续");
            expect(container.querySelectorAll("[data-drama-agent-actions]")).toHaveLength(1);
        }
        await render("canvas:conversation-b", false);
        expect(container.querySelector("[data-drama-agent-actions]")).toBeNull();
        expect(hosts.at(-1)).toBeNull();
        expect(container.textContent).not.toContain("应用建议并继续");
        await render("drama:project-b:conversation-c");
        expect(hosts.at(-1)).not.toBeNull();
    } finally {
        await act(async () => root.unmount());
        expect(hosts.at(-1)).toBeNull();
        container.remove();
    }
});
