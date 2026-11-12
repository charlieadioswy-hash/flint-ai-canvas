import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { DramaAgentProposal } from "@/services/api/agent";
import type { DramaCast, DramaSummary } from "@/services/api/drama";
import type { AgentDramaContext } from "@/stores/use-global-agent-store";
import type { CloudAgentChatMessage } from "@/components/canvas/canvas-cloud-agent-chat-ui";

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

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { environmentManager } = await import("@tanstack/query-core");
environmentManager.setIsServer(() => false);
const antd = { ...(await import("antd")) };

let summary: DramaSummary;
let cast: DramaCast[];
let dramaContext: AgentDramaContext | null = null;
let renderChoices: (() => void) | null = null;
let creates: Array<{ projectId: string; input: Record<string, unknown> }> = [];
let deletes: Array<{ projectId: string; castId: string; expectedRevision: number }> = [];
let confirmations: Array<{ onOk: () => unknown; onCancel?: () => unknown; title?: string }> = [];
let invalidations: unknown[][] = [];
let errors: string[] = [];
const silent = () => {};
const forbidden = async () => {
    throw new Error("此资产建议不应触发其他写入");
};
const agentStore = {
    get drama() {
        return dramaContext;
    },
    setDrama(value: AgentDramaContext | null) {
        dramaContext = value;
        renderChoices?.();
    },
};
mock.module("@/stores/use-global-agent-store", () => ({ useGlobalAgentStore: { getState: () => agentStore } }));
mock.module("antd", () => ({
    ...antd,
    App: {
        useApp: () => ({
            message: { info: silent, warning: silent, success: silent, error: (value: string) => errors.push(value) },
            modal: { confirm: (options: (typeof confirmations)[number]) => confirmations.push(options) },
        }),
    },
    Button: ({ children, icon, loading: _loading, type: _type, size: _size, danger: _danger, ...props }: any) => (
        <button {...props}>
            {icon}
            {children}
        </button>
    ),
    Input: (props: any) => <input {...props} />,
}));
mock.module("react-router", () => ({
    useParams: () => ({ projectId: "project" }),
    useNavigate: () => silent,
    useMatch: () => null,
    Link: ({ children }: any) => children,
    Navigate: () => null,
}));
mock.module("@/components/layout/workspace-page", () => ({ WorkspacePage: ({ children }: any) => <div>{children}</div> }));
mock.module("@/components/layout/workspace-state", () => ({ WorkspaceErrorState: () => <div>读取失败</div>, WorkspaceLoadingState: () => <div>读取中</div>, WorkspaceState: () => null }));
mock.module("@/components/ui/product/app-modal", () => ({ AppModal: () => null }));
mock.module("@/services/drama-canvas", () => ({ encodeDramaCanvasFocus: () => "", openDramaCanvasPath: async () => "" }));
mock.module("@/pages/projects/drama-shared", () => ({ CAST_KIND_LABEL: { character: "角色", scene: "场景", prop: "道具" }, SourceFormatPicker: () => null }));
mock.module("@/pages/projects/drama-model-picker", () => ({ useDramaModelCatalog: () => ({ data: undefined }) }));
mock.module("@/pages/projects/guide-panels", () => ({
    GuideConfiguration: () => null,
    GuideStory: () => null,
    GuideTextField: () => null,
    GuideAssets: ({ cast: items }: { cast: DramaCast[] }) => <output aria-label="当前资产">{items.map((item) => item.name).join("、")}</output>,
}));
mock.module("@/services/api/drama", () => ({
    getDrama: async () => structuredClone(summary),
    listDramaCast: async () => ({ cast: structuredClone(cast) }),
    getDramaEpisode: async () => ({}),
    createDramaCast: async (projectId: string, input: Record<string, unknown>) => {
        creates.push({ projectId, input });
        cast.push({ id: "new-scene", ...input } as DramaCast);
        summary = { ...summary, production: { ...summary.production, revision: summary.production.revision + 1 } };
        return { cast: structuredClone(cast.at(-1)) };
    },
    deleteDramaCast: async (projectId: string, castId: string, expectedRevision: number) => {
        deletes.push({ projectId, castId, expectedRevision });
        cast = cast.filter((item) => item.id !== castId);
        summary = { ...summary, production: { ...summary.production, revision: summary.production.revision + 1 } };
        return {};
    },
    confirmDramaGuide: forbidden,
    regenerateDramaCast: forbidden,
    rescriptDramaEpisode: forbidden,
    retryFailedDrama: forbidden,
    saveDramaGuideSource: forbidden,
    updateDramaCast: forbidden,
    updateDramaSegment: forbidden,
    updateDramaSettings: forbidden,
    updateDramaShot: forbidden,
    writeDramaSegmentPrompts: forbidden,
}));

const { dramaKeys } = await import("@/pages/projects/studio/use-studio");
const { default: DramaGuidePage } = await import("@/pages/projects/guide");
const { AgentConversation } = await import("@/components/canvas/canvas-cloud-agent-panel-parts");
const { canvasThemes } = await import("@/lib/canvas-theme");
const settle = async () => {
    for (let i = 0; i < 6; i++) await Bun.sleep(10);
};
afterAll(() => browser.happyDOM.abort());

function proposal(kind: "cast_create" | "cast_delete", overrides: Partial<DramaAgentProposal> = {}): DramaAgentProposal {
    return {
        kind,
        baseRevision: 7,
        changes: kind === "cast_create" ? { kind: "scene", name: "雨夜旧车站", description: "列车停运后的老站台", appearance: "冷色雨幕", aliases: ["旧车站"] } : { reason: "正文没有出现此道具" },
        targetId: kind === "cast_delete" ? "unused-prop" : undefined,
        runId: "run",
        toolCallId: kind,
        ...overrides,
    };
}

async function withGuide(
    check: (ui: {
        container: HTMLElement;
        chatHost: HTMLDivElement;
        client: InstanceType<typeof QueryClient>;
        receive: (value: DramaAgentProposal) => Promise<void>;
        click: (label: string) => Promise<void>;
        sendMessage: (text: string) => Promise<void>;
    }) => Promise<void>,
) {
    summary = {
        project: { id: "project", name: "资产建议测试" },
        production: { guideStep: "assets", revision: 7, status: "draft", stage: "bible", settings: {}, chapterCount: 1 },
        episodes: [],
        jobCounts: {},
        inbox: [],
        castCount: 1,
        guide: { step: "assets", canConfirm: false },
    } as DramaSummary;
    cast = [{ id: "unused-prop", kind: "prop", name: "多余的怀表", description: "待删除道具", imageStatus: "", locked: false } as DramaCast];
    creates = [];
    deletes = [];
    confirmations = [];
    invalidations = [];
    errors = [];
    dramaContext = null;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    client.setQueryData(dramaKeys.summary("project"), structuredClone(summary));
    client.setQueryData(dramaKeys.cast("project"), { cast: structuredClone(cast) });
    const invalidate = client.invalidateQueries.bind(client);
    client.invalidateQueries = ((filters: any, options: any) => {
        invalidations.push(filters.queryKey);
        return invalidate(filters, options);
    }) as typeof client.invalidateQueries;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let choicesRoot: ReturnType<typeof createRoot> | undefined;
    try {
        await act(async () => {
            root.render(
                <QueryClientProvider client={client}>
                    <DramaGuidePage />
                </QueryClientProvider>,
            );
            await settle();
        });
        await act(settle);
        expect(dramaContext?.onProposal).toBeFunction();
        expect(dramaContext?.onActionsHost).toBeFunction();
        const chatHost = document.createElement("div");
        chatHost.setAttribute("aria-label", "创作对话操作");
        const choicesHost = document.createElement("div");
        const actionsHost = document.createElement("div");
        chatHost.append(choicesHost, actionsHost);
        container.querySelector(".drama-guide-agent-host")!.append(chatHost);
        choicesRoot = createRoot(choicesHost);
        let messages: CloudAgentChatMessage[] = [{ id: "proposal-reply", runId: "run", role: "assistant", text: "请审阅以下资产建议。" }];
        renderChoices = () => {
            const choices = dramaContext?.proposalChoices;
            choicesRoot?.render(
                <AgentConversation
                    guideMode
                    theme={canvasThemes.light}
                    messages={messages}
                    references={[]}
                    busy={false}
                    approval={null}
                    approvalSubmitting={false}
                    onApprovalReasonChange={silent}
                    onApprove={silent}
                    onReject={silent}
                    proposalChoices={choices}
                />,
            );
        };
        await act(async () => {
            dramaContext!.onActionsHost!(actionsHost);
            renderChoices?.();
            await settle();
        });
        invalidations = [];
        await check({
            container,
            chatHost,
            client,
            receive: async (value) => {
                await act(async () => {
                    dramaContext!.onProposal!(value);
                    await settle();
                });
            },
            click: async (label) => {
                const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);
                expect(button, `未找到按钮：${label}`).toBeDefined();
                await act(async () => {
                    button!.click();
                    await settle();
                });
            },
            sendMessage: async (text) => {
                await act(async () => {
                    messages = [...messages, { id: `user-${messages.length}`, role: "user", text }];
                    renderChoices?.();
                    await settle();
                });
            },
        });
    } finally {
        renderChoices = null;
        await act(async () => root.unmount());
        choicesRoot?.unmount();
        client.clear();
        container.remove();
    }
}

test("聊天内新增资产建议点击后携带 CAS 版本创建并刷新真实查询", async () => {
    await withGuide(async ({ container, chatHost, receive, click }) => {
        await receive(proposal("cast_create"));
        expect(creates).toEqual([]);
        expect(deletes).toEqual([]);
        expect(chatHost.textContent).toContain("雨夜旧车站");
        expect(chatHost.querySelectorAll(".drama-guide-proposal")).toHaveLength(1);
        expect(container.querySelector('[aria-label="创作产物"] .drama-guide-proposal')).toBeNull();
        expect(container.querySelector("output")?.textContent).not.toContain("雨夜旧车站");
        await click("新增此资产");
        expect(creates).toEqual([{ projectId: "project", input: { kind: "scene", name: "雨夜旧车站", description: "列车停运后的老站台", appearance: "冷色雨幕", aliases: ["旧车站"], expectedRevision: 7 } }]);
        expect(container.querySelector("output")?.textContent).toContain("雨夜旧车站");
        expect(invalidations).toContainEqual(dramaKeys.summary("project"));
        expect(invalidations).toContainEqual(dramaKeys.cast("project"));
        expect(container.querySelector(".drama-guide-proposal")).toBeNull();
        expect(errors).toEqual([]);
    });
});

test("删除建议必须二次确认，取消不写入，确认后才删除并刷新资产", async () => {
    await withGuide(async ({ container, receive, click }) => {
        await receive(proposal("cast_delete"));
        await receive(proposal("cast_create"));
        expect(deletes).toEqual([]);
        await click("删除此资产");
        expect(confirmations).toHaveLength(1);
        expect(deletes).toEqual([]);
        await act(async () => {
            confirmations[0].onCancel?.();
            await settle();
        });
        expect(deletes).toEqual([]);
        expect(container.querySelector("output")?.textContent).toContain("多余的怀表");
        expect([...container.querySelectorAll<HTMLButtonElement>(".drama-guide-proposal-choose")].every((button) => !button.disabled)).toBe(true);
        await click("删除此资产");
        expect(confirmations).toHaveLength(2);
        expect(deletes).toEqual([]);
        await act(async () => {
            await confirmations[1].onOk();
            await settle();
        });
        expect(deletes).toEqual([{ projectId: "project", castId: "unused-prop", expectedRevision: 7 }]);
        expect(container.querySelector("output")?.textContent).not.toContain("多余的怀表");
        expect(invalidations).toContainEqual(dramaKeys.summary("project"));
        expect(invalidations).toContainEqual(dramaKeys.cast("project"));
        expect(errors).toEqual([]);
    });
});

test("删除弹窗打开后收到新消息，旧确认不能删除资产", async () => {
    await withGuide(async ({ container, receive, click, sendMessage }) => {
        await receive(proposal("cast_delete"));
        await click("删除此资产");
        expect(confirmations).toHaveLength(1);
        await sendMessage("先保留这个道具，我想讨论其他内容。");
        expect(container.querySelector<HTMLButtonElement>(".drama-guide-proposal-choose")?.disabled).toBe(true);
        await act(async () => {
            await confirmations[0].onOk();
            await settle();
        });
        expect(deletes).toEqual([]);
        expect(container.querySelector("output")?.textContent).toContain("多余的怀表");
    });
});

test("删除弹窗打开后选择忽略建议，旧确认不能删除资产", async () => {
    await withGuide(async ({ container, chatHost, receive, click }) => {
        await receive(proposal("cast_delete"));
        await click("删除此资产");
        expect(confirmations).toHaveLength(1);
        const dismiss = chatHost.querySelector<HTMLButtonElement>('[aria-label="忽略删除资产"]')!;
        await act(async () => {
            dismiss.click();
            await settle();
        });
        await act(async () => {
            await confirmations[0].onOk();
            await settle();
        });
        expect(deletes).toEqual([]);
        expect(container.querySelector("output")?.textContent).toContain("多余的怀表");
    });
});

test("过期新增与删除建议禁用，不创建、不删除也不打开确认框", async () => {
    await withGuide(async ({ container, receive, click }) => {
        await receive(proposal("cast_create", { baseRevision: 6 }));
        await receive(proposal("cast_delete", { baseRevision: 6 }));
        for (const label of ["新增此资产", "删除此资产"]) {
            const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);
            expect(button?.disabled).toBe(true);
            await click(label);
        }
        expect(creates).toEqual([]);
        expect(deletes).toEqual([]);
        expect(confirmations).toEqual([]);
        expect(container.textContent).toContain("此建议已过期");
    });
});

test("删除确认框打开后版本变化，确认仍须拒绝过期写入", async () => {
    await withGuide(async ({ client, receive, click }) => {
        await receive(proposal("cast_delete"));
        await click("删除此资产");
        expect(confirmations).toHaveLength(1);
        await act(async () => {
            summary = { ...summary, production: { ...summary.production, revision: 8 } };
            await client.invalidateQueries({ queryKey: dramaKeys.summary("project"), exact: true });
            await settle();
        });
        await act(async () => {
            await confirmations[0].onOk();
            await settle();
        });
        expect(deletes).toEqual([]);
        expect(errors.join(" ")).toMatch(/过期|更新/);
    });
});
