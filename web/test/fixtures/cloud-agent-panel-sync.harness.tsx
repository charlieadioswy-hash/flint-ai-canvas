import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { AgentEvent, AgentRun } from "@/services/api/agent";
import type { CloudAgentConversation, CloudAgentPendingSubmission } from "@/services/cloud-agent-conversations";
import type { AgentOutbox } from "@/lib/canvas/agent-outbox";
import type { AgentPrefillRequest } from "@/stores/use-global-agent-store";

const dom = new Window({ url: "http://localhost/" });
for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    localStorage: dom.localStorage,
    HTMLElement: dom.HTMLElement,
    SVGElement: dom.SVGElement,
    Element: dom.Element,
    Node: dom.Node,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    ShadowRoot: dom.ShadowRoot,
    MutationObserver: dom.MutationObserver,
    ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
}))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const agent = await import("@/services/api/agent");
const history = await import("@/services/cloud-agent-conversations");
const awaitImportHistory = await import("@/services/cloud-agent-history");
const skillsApi = await import("@/services/api/skills");
const { setActiveUserScope } = await import("@/lib/user-scope");
const { useUserStore } = await import("@/stores/use-user-store");
const { useGlobalAgentStore } = await import("@/stores/use-global-agent-store");
const { createModelChannel, defaultConfig, normalizeConfigSnapshot, useConfigStore } = await import("@/stores/use-config-store");
const { ApiError } = await import("@/services/api/request");

let local: CloudAgentConversation[] = [];
let remote: CloudAgentConversation[] = [];
let activeId = "";
let pending: CloudAgentPendingSubmission | null = null;
let refreshOverride: (() => Promise<CloudAgentConversation[]>) | undefined;
let loadOverride: ((id: string) => Promise<CloudAgentConversation>) | undefined;
const conversationLoads: Array<{ id: string; scope: string }> = [];
const subscriptions: Array<{ id: string; after: number; event: (event: AgentEvent) => void; connection: (status: string) => void; closed: boolean }> = [];
const sent: string[] = [];
const sendInputs: Array<Record<string, any>> = [];
const createInputs: Array<Record<string, any>> = [];
let sendFailure: Error | undefined;
let capabilitiesOverride: (() => Promise<unknown>) | undefined;
let sendOverride: (() => Promise<{ run: AgentRun }>) | undefined;
let createOverride: ((input: any) => Promise<{ run: AgentRun }>) | undefined;
const outboxes = new Map<string, AgentOutbox>();
let outboxLoadOverride: ((id: string) => Promise<AgentOutbox | null>) | undefined;
let startupSaveOverride: (() => Promise<void>) | undefined;
const refreshRequests: Array<{ observedConversationIds?: string[]; canvasId?: string }> = [];
let generated = 0;
let composer: Record<string, any>;
let header: Record<string, any>;
let conversationUI: Record<string, any>;
let historyUI: Record<string, any>;
let controls: Record<string, any>;
let outboxUI: Record<string, any>;
let questionUI: Record<string, any> | undefined;
const silent = () => {};
mock.module("file-saver", () => ({ saveAs: silent }));
const MotionBox = ({ children, className, style }: any) => (
    <div className={className} style={style}>
        {children}
    </div>
);
mock.module("motion/react", () => ({ AnimatePresence: ({ children }: any) => children, motion: { aside: MotionBox, div: MotionBox }, useReducedMotion: () => true }));
mock.module("antd", () => ({
    App: { useApp: () => ({ message: { info: silent, error: silent, warning: silent, success: silent } }) },
    Dropdown: ({ children }: any) => children,
    Button: ({ children, loading: _loading, icon, size: _size, ...props }: any) => (
        <button {...props}>
            {icon}
            {children}
        </button>
    ),
}));
mock.module("@/services/api/agent", () => ({
    ...agent,
    getAgentProfile: async () => ({ revision: "profile", hash: "hash", layers: [] }),
    getAgentCapabilities: async () => (capabilitiesOverride ? capabilitiesOverride() : { permissionModes: ["request_approval"], skills: true }),
    subscribeAgentEvents: (id: string, event: (event: AgentEvent) => void, options: any) => {
        const subscription = { id, after: options.after, event, connection: options.onConnectionChange, closed: false };
        subscriptions.push(subscription);
        options.onConnectionChange("connected");
        return () => {
            subscription.closed = true;
        };
    },
    sendAgentMessage: async (id: string, input: any) => {
        sent.push(id);
        sendInputs.push(input);
        if (sendFailure) throw sendFailure;
        if (sendOverride) return sendOverride();
        return { run: { ...makeRun("submitted-child"), parentId: id, userPrompt: input.prompt, idempotencyKey: input.idempotencyKey } };
    },
    createAgentRun: async (input: any) => {
        generated++;
        createInputs.push(input);
        if (createOverride) return createOverride(input);
        throw new Error("不应新建独立轮次");
    },
    decideAgentApproval: async () => {
        generated++;
        throw new Error("测试禁止审批");
    },
}));
mock.module("@/services/cloud-agent-conversations", () => ({
    ...history,
    loadCloudAgentConversations: async (scope: string) => (scope === "sync-user" ? { version: 1, activeId, conversations: local } : { version: 1, activeId: null, conversations: [] }),
    saveCloudAgentConversations: async (id: string, conversations: CloudAgentConversation[], scope: string) => {
        if (scope !== "sync-user") return;
        if (startupSaveOverride && conversations.some((item) => item.localDramaStartupRequested)) await startupSaveOverride();
        activeId = id;
        local = conversations;
    },
    loadCloudAgentPendingSubmission: async (_id: string, scope: string) => (scope === "sync-user" ? pending : null),
    saveCloudAgentPendingSubmission: async (_id: string, value: CloudAgentPendingSubmission, scope: string) => {
        if (scope !== "sync-user") throw new Error("不能向其他账号保存原请求");
        pending = value;
    },
    clearCloudAgentPendingSubmission: async (_id: string, scope: string) => {
        if (scope !== "sync-user") throw new Error("不能清除其他账号原请求");
        pending = null;
    },
}));
mock.module("@/services/cloud-agent-history", () => ({
    ...awaitImportHistory,
    refreshCloudAgentConversations: async (options: any) => {
        refreshRequests.push(options);
        if (options.scope !== "sync-user") return [];
        return refreshOverride ? refreshOverride() : remote;
    },
    loadCloudAgentConversation: async (id: string, options: { scope: string }) => {
        conversationLoads.push({ id, scope: options.scope });
        if (options.scope !== "sync-user") throw new ApiError("对话不存在", { status: 404 });
        return loadOverride ? loadOverride(id) : remote.find((item) => item.serverConversationId === id)!;
    },
}));
mock.module("@/services/api/skills", () => ({
    ...skillsApi,
    listSkillPresets: async () => ({ presets: [] }),
    listSkills: async () => ({ skills: [] }),
    listAddedSkills: async () => ({ skills: [] }),
    listSkillLibraryCategories: async () => ({ categories: [] }),
    addSkill: async () => {
        throw new Error("不应安装技能");
    },
}));
mock.module("@/services/user-data-sync", () => ({ prepareCanvasForCloudAction: async () => {}, applyAgentCanvasPatches: async () => {}, refreshCanvasAfterAgent: async () => {} }));
mock.module("@/components/skills/skill-curation-browser", () => ({ useSkillCuration: () => ({ curation: null }), curationQuery: () => ({}) }));
mock.module("@/components/canvas/canvas-cloud-agent-chat-ui", () => ({
    AGENT_SCENE_DEFS: [],
    parseCloudAgentFormAnswer: () => undefined,
    AgentChatComposer: (props: any) => {
        composer = props;
        return (
            <>
                {props.left}
                {props.tray}
                <textarea aria-label="草稿" value={props.prompt} readOnly />
            </>
        );
    },
    AgentPlanBar: () => null,
    AgentQuestionBar: (props: any) => {
        questionUI = props;
        const draftKey = `2:${props.question.options[1]?.label}`;
        return <input data-testid="question-option-draft" value={props.replyOptionDrafts?.values[draftKey] || ""} onChange={(event) => props.replyOptionDrafts?.onChange(draftKey, event.target.value)} />;
    },
    AgentSceneCapsules: () => null,
}));
mock.module("@/components/canvas/canvas-cloud-agent-panel-parts", () => ({
    AgentLauncher: (props: any) =>
        props.hidden ? null : (
            <button aria-label="打开 Agent" onClick={props.onOpen}>
                打开 Agent
            </button>
        ),
    AgentContextRing: () => null,
    ComposerControls: (props: any) => {
        controls = props;
        return null;
    },
    AgentHeader: (props: any) => {
        header = props;
        return <div>{props.statusLabel}</div>;
    },
    AgentConversation: (props: any) => {
        conversationUI = props;
        return (
            <div data-testid="conversation">
                {props.messages.map((item: any) => (
                    <div key={item.id}>{item.text}</div>
                ))}
            </div>
        );
    },
    AgentHistory: (props: any) => {
        historyUI = props;
        return <div>历史</div>;
    },
}));
mock.module("@/components/canvas/canvas-agent-skill-library-modal", () => ({ CanvasAgentSkillLibraryModal: () => null }));
mock.module("@/components/skills/skill-recommendations-modal", () => ({ SkillRecommendationsModal: () => null }));
mock.module("@/components/canvas/canvas-cloud-agent-settings", () => ({ CanvasCloudAgentSettings: () => null, agentPermissionLabel: (mode: string) => mode }));
mock.module("@/components/canvas/canvas-cloud-agent-composer", () => ({ AgentContextChip: () => null }));
mock.module("@/services/cloud-agent-outbox", () => ({
    loadCloudAgentOutbox: async (id: string) => (outboxLoadOverride ? outboxLoadOverride(id) : outboxes.get(id) || null),
    saveCloudAgentOutbox: async (id: string, value: AgentOutbox) => {
        outboxes.set(id, structuredClone(value));
    },
    clearCloudAgentOutbox: async (id: string) => outboxes.delete(id),
}));
mock.module("@/components/canvas/canvas-cloud-agent-outbox", () => ({
    AgentOutboxTray: (props: any) => {
        outboxUI = props;
        return <div data-testid="outbox">{props.outbox.items.map((item: any) => item.text).join("\n")}</div>;
    },
}));
mock.module("@/components/canvas/canvas-cloud-agent-connectors", () => ({ AgentConnectorsBar: () => null }));
mock.module("@/components/canvas/use-agent-panel-layout", () => ({ useAgentPanelLayout: () => ({ style: {}, pointerHandlers: {}, reset: silent, onResizeKeyDown: silent }) }));

const { CanvasCloudAgentPanel } = await import("@/components/canvas/canvas-cloud-agent-panel");
function makeRun(id: string, status: AgentRun["status"] = "completed"): AgentRun {
    return { id, conversationId: "shared-session", canvasId: "shared-canvas", status, userPrompt: `用户-${id}`, permissionMode: "request_approval", createdAt: "2026-10-23T01:00:00Z", updatedAt: `2026-10-23T01:00:0${id.length}Z`, revision: 1 };
}
function chat(id: string, latest: AgentRun | null): CloudAgentConversation {
    return {
        id,
        serverConversationId: latest?.conversationId,
        run: latest,
        lastEventSeq: 4,
        runs: latest ? [latest] : [],
        title: id,
        messages: latest
            ? [
                  { id: `user-${latest.id}`, role: "user", text: latest.userPrompt! },
                  { id: `assistant-${latest.id}`, role: "assistant", text: `结果-${latest.id}` },
              ]
            : [],
        permissionMode: "request_approval",
        createdAt: "2026-10-23T01:00:00Z",
        updatedAt: "2026-10-23T01:00:00Z",
    };
}
const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 10));
};
const focus = async () => {
    await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await settle();
    });
};
// 面板合并写入本机对话缓存；断言缓存前先触发与页面隐藏相同的立即写入（缓存 mock 同步落盘）。
const persist = async () => {
    await act(async () => {
        window.dispatchEvent(new Event("pagehide"));
    });
};
type MountOptions = {
    startupRequest?: AgentPrefillRequest;
    prefillRequest?: AgentPrefillRequest;
    localConversations?: CloudAgentConversation[];
    initialOutbox?: AgentOutbox;
    outboxLoad?: (id: string) => Promise<AgentOutbox | null>;
    startupSave?: () => Promise<void>;
    createRun?: (input: any) => Promise<{ run: AgentRun }>;
    loadConversation?: (id: string) => Promise<CloudAgentConversation>;
    onConversationBound?: (id: string) => void;
    guideConversationId?: string | null;
    offline?: boolean;
    strictMode?: boolean;
    floatingDrama?: boolean;
    initiallyOpen?: boolean;
};
async function mount(initial: CloudAgentConversation, cloud: CloudAgentConversation[], initialPending: CloudAgentPendingSubmission | null = null, guideProjectId?: string, options: MountOptions = {}) {
    local = options.localConversations || [initial];
    activeId = initial.id;
    remote = cloud;
    pending = initialPending;
    refreshOverride = undefined;
    loadOverride = options.loadConversation;
    conversationLoads.length = 0;
    sent.length = 0;
    sendInputs.length = 0;
    createInputs.length = 0;
    sendFailure = undefined;
    capabilitiesOverride = guideProjectId ? async () => ({ permissionModes: ["read_only", "request_approval"], skills: true }) : undefined;
    sendOverride = undefined;
    createOverride =
        options.createRun ||
        (options.startupRequest ? async (input) => ({ run: { ...makeRun(`guide-startup-${generated}`, "running"), canvasId: undefined, dramaProjectId: input.dramaProjectId, permissionMode: "read_only", userPrompt: input.prompt } }) : undefined);
    outboxes.clear();
    if (options.initialOutbox) outboxes.set(initial.id, options.initialOutbox);
    outboxLoadOverride = options.outboxLoad;
    startupSaveOverride = options.startupSave;
    outboxUI = undefined!;
    questionUI = undefined;
    Object.defineProperty(navigator, "onLine", { configurable: true, value: !options.offline });
    generated = 0;
    subscriptions.length = 0;
    refreshRequests.length = 0;
    setActiveUserScope("sync-user");
    useUserStore.setState({ hydrated: true, user: { id: "sync-user", username: "test", displayName: "test", role: "user", status: "active" } });
    configureModels(false);
    const host = document.createElement("div");
    document.body.append(host);
    useGlobalAgentStore.setState({
        open: options.initiallyOpen ?? true,
        canvas: guideProjectId ? null : { canvasId: "shared-canvas", nodeCount: 2, selectedNodeIds: [], references: [] },
        drama: guideProjectId
            ? {
                  projectId: guideProjectId,
                  guideConversationId: options.guideConversationId === undefined ? initial.serverConversationId : options.guideConversationId || undefined,
                  host: options.floatingDrama ? undefined : host,
                  startupRequest: options.startupRequest,
                  prefillRequest: options.prefillRequest,
                  onConversationBound: options.onConversationBound,
              }
            : null,
    });
    const root = createRoot(host);
    await act(async () => {
        root.render(
            options.strictMode ? (
                <React.StrictMode>
                    <CanvasCloudAgentPanel />
                </React.StrictMode>
            ) : (
                <CanvasCloudAgentPanel />
            ),
        );
        await settle();
    });
    return {
        host,
        root,
        close: async () => {
            await act(async () => root.unmount());
            host.remove();
        },
    };
}
afterAll(() => dom.happyDOM.abort());
function configureModels(ambiguous: boolean) {
    const entry = (id: string, model: string, price: number) =>
        createModelChannel({ id, scope: "system", models: [model], modelCosts: [{ model, channelModelId: `${id}-${model}`, capability: "text", billingMode: "fixed_request", unitPriceMicrocredits: price }] });
    const channels = [entry("paid-channel", "paid-model", 10_000_000), entry("local-test", "local-agent-test", 0), ...(ambiguous ? [entry("another-test", "local-agent-test", 0)] : [])];
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels, textModel: "paid-channel::paid-model", model: "paid-channel::paid-model" } }).config;
    useConfigStore.setState({ config });
}

test("手机空缓存接续同画布桌面会话，审批被另一端处理后自动收敛且不重复提交", async () => {
    const waiting = makeRun("desktop", "waiting_approval");
    waiting.approval = { approvalId: "approval-one", call: { id: "call", function: { name: "generate_media", arguments: "{}" } } };
    const mounted = await mount(chat("new-phone", null), [chat("server", waiting)]);
    try {
        expect(conversationUI.messages.map((item: any) => item.text)).toContain("结果-desktop");
        expect(conversationUI.approval.approvalId).toBe("approval-one");
        expect(subscriptions.at(-1)).toMatchObject({ id: "desktop", after: 4 });
        await act(async () => {
            conversationUI.onApprovalReasonChange("手机保留的理由");
        });
        await focus();
        expect(conversationUI.approval.reason).toBe("手机保留的理由");
        const observation = subscriptions.at(-1)!;
        await act(async () => {
            observation.event({ eventId: "decision", runId: "desktop", seq: 5, type: "approval_decided", payload: { approvalId: "approval-one", decision: "approve" }, createdAt: waiting.updatedAt });
            observation.event({ eventId: "status", runId: "desktop", seq: 6, type: "run_status", payload: { status: "running", revision: 2 }, createdAt: waiting.updatedAt });
        });
        expect(conversationUI.approval).toBeNull();
        await persist();
        expect(local.find((item) => item.id === "server")?.lastEventSeq).toBe(6);
        expect(generated).toBe(0);
    } finally {
        await mounted.close();
    }
});

test("旧轮次结束后仍发现手机新轮次，电脑下一条消息使用最新 child 续接", async () => {
    const first = chat("desktop-local", makeRun("first"));
    const mounted = await mount(first, [chat("server", makeRun("first"))]);
    try {
        expect(refreshRequests.some((item) => item.canvasId === "shared-canvas" && item.observedConversationIds?.includes("shared-session"))).toBe(true);
        remote = [chat("server", { ...makeRun("second"), parentId: "first" })];
        await focus();
        expect(conversationUI.messages.map((item: any) => item.text)).toContain("结果-second");
        expect(subscriptions.find((item) => item.id === "first")?.closed).toBe(true);
        expect(subscriptions.at(-1)?.id).toBe("second");
        await act(async () => {
            subscriptions.find((item) => item.id === "first")!.event({ eventId: "late-old-event", runId: "first", seq: 5, type: "assistant_delta", payload: { messageId: "old-output", text: "不应出现在新轮次" }, createdAt: first.updatedAt });
        });
        expect(conversationUI.messages.map((item: any) => item.text)).not.toContain("不应出现在新轮次");
        await act(async () => {
            composer.onPromptChange("电脑接着这一轮继续");
        });
        await act(async () => {
            composer.onSubmit();
            await settle();
        });
        expect(sent).toEqual(["second"]);
        expect(generated).toBe(0);
        expect(pending).toBeNull();
    } finally {
        await mounted.close();
    }
});

test("云端发现不能替换未提交草稿，明确新建后不会重新接回旧会话", async () => {
    const initial = { ...chat("phone-draft", null), draft: "尚未发送的草稿" };
    const mounted = await mount(initial, [chat("server", makeRun("desktop"))]);
    try {
        expect(composer.prompt).toBe("尚未发送的草稿");
        expect(conversationUI.messages).toHaveLength(0);
        await act(async () => {
            header.onNew();
            await settle();
        });
        expect(composer.prompt).toBe("");
        await persist();
        expect(local.some((item) => item.id === "phone-draft" && item.draft === "尚未发送的草稿")).toBe(true);
        await focus();
        expect(conversationUI.messages).toHaveLength(0);
        await persist();
        expect(local.find((item) => item.id === activeId)?.localNewCanvasId).toBe("shared-canvas");
        expect(generated).toBe(0);
    } finally {
        await mounted.close();
    }
});

test("旧账号云端请求迟到时不得写入已切换账号的面板", async () => {
    const mounted = await mount(chat("safe-local", null), []);
    try {
        let release: ((value: CloudAgentConversation[]) => void) | undefined;
        refreshOverride = () =>
            new Promise((resolve) => {
                release = resolve;
            });
        await act(async () => {
            window.dispatchEvent(new Event("focus"));
            await settle();
        });
        expect(release).toBeDefined();
        await act(async () => {
            setActiveUserScope("other-user");
            useUserStore.setState({ user: { id: "other-user", username: "other", displayName: "other", role: "user", status: "active" } });
            release!([chat("old-account-secret", makeRun("secret"))]);
            await settle();
        });
        expect(conversationUI.messages.map((item: any) => item.text)).not.toContain("结果-secret");
        await persist();
        expect(local.some((item) => item.serverConversationId === "shared-session")).toBe(false);
    } finally {
        await mounted.close();
    }
});

test("手选同画布较早历史后不被其他会话抢走，但仍能跟随所选会话的新轮次", async () => {
    const earlier = chat("earlier", makeRun("earlier"));
    const newer = chat("newer", { ...makeRun("newer"), conversationId: "different-session" });
    const mounted = await mount(earlier, [earlier, newer]);
    try {
        await act(async () => {
            header.onHistory();
            await new Promise((resolve) => setTimeout(resolve, 350));
        });
        expect(historyUI).toBeDefined();
        await act(async () => {
            historyUI.onOpen(earlier);
            await new Promise((resolve) => setTimeout(resolve, 350));
        });
        await focus();
        expect(conversationUI.messages.map((item: any) => item.text)).toContain("结果-earlier");
        await persist();
        expect(local.find((item) => item.id === activeId)?.localSelectedCanvasId).toBe("shared-canvas");
        remote = [{ ...earlier, run: { ...makeRun("earlier-child"), parentId: "earlier" }, messages: [{ id: "new-result", role: "assistant", text: "所选会话的新轮次" }] }, newer];
        await focus();
        expect(conversationUI.messages.map((item: any) => item.text)).toContain("所选会话的新轮次");
    } finally {
        await mounted.close();
    }
});

test("未知提交的原请求与幂等身份保留，不能因发现云端同文本会话而被换掉", async () => {
    const original = { key: "original-key", fingerprint: "frozen-body", request: { canvasId: "shared-canvas", prompt: "生成森林", idempotencyKey: "original-key" } };
    const other = chat("other", { ...makeRun("other"), userPrompt: "生成森林", idempotencyKey: "another-key" });
    const mounted = await mount(chat("uncertain", null), [other], original);
    try {
        await focus();
        expect(pending).toEqual(original);
        expect(composer.prompt).toBe("生成森林");
        expect(conversationUI.messages).toHaveLength(0);
        await persist();
        expect(activeId).toBe("uncertain");
        expect(generated).toBe(0);
    } finally {
        await mounted.close();
    }
});

test("手机后台断线后在前台恢复同一事件订阅，focus与visibility不会发送或审批", async () => {
    const waiting = makeRun("background", "waiting_approval");
    waiting.approval = { approvalId: "remain-pending", call: { id: "call", function: { name: "generate_media", arguments: "{}" } } };
    const mounted = await mount(chat("mobile", waiting), [chat("server", waiting)]);
    try {
        const first = subscriptions.at(-1)!;
        await act(async () => {
            first.connection("disconnected");
        });
        const count = subscriptions.length;
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
            window.dispatchEvent(new Event("focus"));
            await settle();
        });
        expect(subscriptions).toHaveLength(count);
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
            window.dispatchEvent(new Event("focus"));
            await settle();
        });
        expect(subscriptions).toHaveLength(count + 1);
        expect(first.closed).toBe(true);
        expect(subscriptions.at(-1)).toMatchObject({ id: "background", after: 4 });
        await act(async () => {
            subscriptions.at(-1)!.connection("disconnected");
        });
        await focus();
        expect(subscriptions).toHaveLength(count + 2);
        expect(conversationUI.approval.approvalId).toBe("remain-pending");
        expect(sent).toHaveLength(0);
        expect(generated).toBe(0);
    } finally {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        await mounted.close();
    }
});

test("第二端恢复裸模型key为唯一完整option，续发保持原零积分渠道", async () => {
    const cloud = { ...chat("server", { ...makeRun("mock-turn"), model: "local-agent-test" }), model: "local-agent-test" };
    const mounted = await mount(chat("new-device", null), [cloud]);
    try {
        expect(controls.selectedModel).toBe("local-test::local-agent-test");
        await act(async () => {
            composer.onPromptChange("接着免费测试模型继续");
        });
        await act(async () => {
            composer.onSubmit();
            await settle();
        });
        expect(sendInputs).toHaveLength(1);
        expect(sendInputs[0]).toMatchObject({ model: "local-agent-test", channelId: "local-test", channelModelKey: "local-agent-test" });
        expect(generated).toBe(0);
    } finally {
        await mounted.close();
    }
});

test("同名多渠道不能自动换到默认收费模型，手动选择后才允许继续", async () => {
    const mounted = await mount(chat("new-device", null), []);
    try {
        await act(async () => {
            configureModels(true);
        });
        remote = [{ ...chat("server", { ...makeRun("ambiguous"), model: "local-agent-test" }), model: "local-agent-test" }];
        await focus();
        expect(controls.selectedModel).toBe("");
        expect(composer.submitDisabled).toBe(true);
        await persist();
        expect(local.find((item) => item.id === activeId)?.model).toBe("local-agent-test");
        await act(async () => {
            composer.onPromptChange("等待确认渠道的草稿");
            composer.onSubmit();
            await settle();
        });
        expect(sendInputs).toHaveLength(0);
        await act(async () => {
            controls.onModelChange("another-test::local-agent-test");
        });
        expect(controls.selectedModel).toBe("another-test::local-agent-test");
        expect(composer.submitDisabled).toBe(false);
        await act(async () => {
            composer.onSubmit();
            await settle();
        });
        expect(sendInputs[0]).toMatchObject({ channelId: "another-test", channelModelKey: "local-agent-test" });
    } finally {
        await mounted.close();
    }
});

test("另一端已推进parent的明确拒绝只同步上下文，保留草稿而不自动重发", async () => {
    const first = chat("local", makeRun("first"));
    const mounted = await mount(first, [first]);
    try {
        await act(async () => {
            composer.onPromptChange("确认新上下文后再发送这条");
        });
        remote = [chat("server", { ...makeRun("other-device-child"), parentId: "first" })];
        sendFailure = new ApiError("会话已在另一端推进", { status: 409, reason: "agent_conversation_stale_parent" });
        await act(async () => {
            composer.onSubmit();
            await settle();
        });
        expect(sent).toEqual(["first"]);
        expect(pending).toBeNull();
        expect(composer.prompt).toBe("确认新上下文后再发送这条");
        expect(conversationUI.messages.some((item: any) => item.text === "结果-other-device-child")).toBe(true);
        expect(conversationUI.messages.some((item: any) => item.role === "user" && item.text === "确认新上下文后再发送这条")).toBe(false);
        expect(generated).toBe(0);
    } finally {
        await mounted.close();
    }
});

function guideChat(id: string, runId: string, projectId = "guide-project"): CloudAgentConversation {
    return { ...chat(id, { ...makeRun(runId), canvasId: undefined, dramaProjectId: projectId, permissionMode: "read_only" }), permissionMode: "read_only" };
}

test("制作台悬浮入口接续短剧原会话，可收起重开且保持只读文字边界", async () => {
    const existing = guideChat("guide-local", "studio-parent");
    const mounted = await mount(existing, [existing], null, "guide-project", { floatingDrama: true, initiallyOpen: false });
    try {
        expect(mounted.host.querySelector(".canvas-agent-panel")).toBeNull();
        expect(createInputs).toHaveLength(0);
        const launcher = mounted.host.querySelector<HTMLButtonElement>('[aria-label="打开 Agent"]')!;
        expect(launcher).toBeTruthy();
        await act(async () => {
            launcher.click();
            await settle();
        });
        expect(mounted.host.querySelector(".canvas-agent-panel")?.className).toContain("fixed");
        expect(mounted.host.textContent).toContain("短剧创作助手");
        expect(conversationUI.messages.some((item: any) => item.text === "结果-studio-parent")).toBe(true);
        expect(controls.guideMode).toBe(true);
        expect(controls.showReadOnlyPermission).toBe(true);
        expect(controls.onModelChange).toBeFunction();
        expect(controls.onReasoningModeChange).toBeFunction();
        await act(async () => mounted.host.querySelector<HTMLButtonElement>('[aria-label="收起短剧 Agent"]')!.click());
        expect(mounted.host.querySelector(".canvas-agent-panel")).toBeNull();
        await act(async () => {
            mounted.host.querySelector<HTMLButtonElement>('[aria-label="打开 Agent"]')!.click();
            await settle();
        });
        expect(conversationUI.messages.some((item: any) => item.text === "结果-studio-parent")).toBe(true);
        sendOverride = async () => ({ run: { ...existing.run!, id: "studio-child", parentId: existing.run!.id } });
        await act(async () => composer.onPromptChange("接着核对第九集的人物与分镜"));
        await act(async () => {
            composer.onSubmit();
            await settle();
        });
        expect(sent).toEqual(["studio-parent"]);
        expect(sendInputs[0]).toMatchObject({ prompt: "接着核对第九集的人物与分镜", dramaProjectId: "guide-project", permissionMode: "read_only", budget: { maxGenerationTasks: 0, maxVideoSeconds: 0 } });
        expect(createInputs).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

const guideStartup: AgentPrefillRequest = { id: 1, text: "请读取当前短剧，按预设流程起草正文并推荐配置，等待我确认后再提取资产。", displayText: "请根据创作想法开始引导", autoSubmit: true };
function emptyGuide(projectId = "guide-project"): CloudAgentConversation {
    return { ...chat(`drama-guide-${projectId}`, null), localNewCanvasId: `drama:${projectId}`, permissionMode: "read_only", model: "local-test::local-agent-test" };
}
function queuedGuideMessage(): AgentOutbox {
    return {
        version: 1,
        items: [
            {
                id: "queued-guide-request",
                text: "之前排队的正文",
                canvasId: "",
                focusNodeIds: [],
                focusNodeOmittedCount: 0,
                status: "queued",
                createdAt: "2026-10-23T01:00:00Z",
                settings: { model: "local-test::local-agent-test", permissionMode: "read_only", reasoningMode: "off", skillIds: [], contextScope: ["drama"], maxCredits: "200", maxGenerationTasks: "0", maxVideoSeconds: "0" },
            },
        ],
    };
}

test("空白短剧首次进入无需手点推荐，StrictMode及上下文重注册不重复启动", async () => {
    const mounted = await mount(emptyGuide(), [], null, "guide-project", { startupRequest: guideStartup, strictMode: true });
    try {
        expect(createInputs).toHaveLength(1);
        expect(createInputs[0]).toMatchObject({
            prompt: guideStartup.text,
            dramaProjectId: "guide-project",
            permissionMode: "read_only",
            contextScope: ["drama"],
            model: "local-agent-test",
            channelId: "local-test",
            budget: { maxGenerationTasks: 0, maxVideoSeconds: 0 },
        });
        expect(conversationUI.messages.some((item: any) => item.role === "user" && item.text === guideStartup.displayText)).toBe(true);
        await persist();
        expect(local.find((item) => item.id === activeId)?.localDramaStartupRequested).toBe(true);
        await act(async () => {
            const context = useGlobalAgentStore.getState().drama!;
            useGlobalAgentStore.setState({ drama: { ...context, startupRequest: { ...guideStartup } } });
            await settle();
        });
        await focus();
        expect(createInputs).toHaveLength(1);
        expect(sent).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("已有完成或运行中的引导只恢复对话，不自动发起新轮", async () => {
    for (const status of ["completed", "running"] as const) {
        const existing = guideChat("guide-local", `existing-${status}`);
        existing.run!.status = status;
        const mounted = await mount(existing, [existing], null, "guide-project", { startupRequest: guideStartup });
        try {
            expect(conversationUI.messages.some((item: any) => item.text === `结果-existing-${status}`)).toBe(true);
            expect(createInputs).toHaveLength(0);
            expect(sent).toHaveLength(0);
        } finally {
            await mounted.close();
        }
    }
});

test("首次准备时尊重已保存草稿和结果未知的原请求，不追加自动消息", async () => {
    const original: CloudAgentPendingSubmission = {
        key: "startup-pending-original",
        fingerprint: "startup-frozen",
        messageId: "user-startup-pending-original",
        request: { prompt: "结果未知的首次请求", canvasId: "", dramaProjectId: "guide-project", permissionMode: "read_only", idempotencyKey: "startup-pending-original" },
    };
    for (const [initial, waiting] of [
        [{ ...emptyGuide(), draft: "保留用户正在写的内容" }, null],
        [emptyGuide(), original],
    ] as const) {
        const mounted = await mount(initial, [], waiting, "guide-project", { startupRequest: guideStartup });
        try {
            expect(composer.prompt).toBe(waiting ? original.request!.prompt : initial.draft);
            expect(createInputs).toHaveLength(0);
            expect(sent).toHaveLength(0);
            expect(pending).toBe(waiting);
            if (!waiting) {
                await act(async () => {
                    composer.onPromptChange("");
                    await settle();
                });
                expect(createInputs).toHaveLength(0);
            }
        } finally {
            await mounted.close();
        }
    }
});

test("等队列恢复完成再判定首次启动，已有排队消息不被自动推荐挤入", async () => {
    let resolveOutbox!: (value: AgentOutbox | null) => void;
    const restored = new Promise<AgentOutbox | null>((resolve) => (resolveOutbox = resolve));
    const initial = emptyGuide();
    const mounted = await mount(initial, [], null, "guide-project", { startupRequest: guideStartup, outboxLoad: (id) => (id === initial.id ? restored : Promise.resolve(null)) });
    try {
        expect(createInputs).toHaveLength(0);
        await act(async () => {
            resolveOutbox(queuedGuideMessage());
            await settle();
        });
        expect(outboxUI.outbox.items.map((item: any) => item.text)).toEqual(["之前排队的正文"]);
        expect(createInputs).toHaveLength(0);
        expect(sent).toHaveLength(0);
        await act(async () => {
            outboxUI.onRemove(outboxUI.outbox.items[0]);
            await settle();
        });
        expect(createInputs).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("恢复队列失败时不能把未知内容当作空白并自动发起推荐", async () => {
    const mounted = await mount(emptyGuide(), [], null, "guide-project", {
        startupRequest: guideStartup,
        outboxLoad: async () => {
            throw new Error("本机队列读取失败");
        },
    });
    try {
        expect(createInputs).toHaveLength(0);
        expect(sent).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("首次启动标记写入期间离开配置阶段，迟到完成不能再启动旧流程", async () => {
    let finishSave!: () => void;
    const saving = new Promise<void>((resolve) => (finishSave = resolve));
    const mounted = await mount(emptyGuide(), [], null, "guide-project", { startupRequest: guideStartup, startupSave: () => saving });
    try {
        expect(createInputs).toHaveLength(0);
        await act(async () => {
            useGlobalAgentStore.setState({ drama: { ...useGlobalAgentStore.getState().drama!, startupRequest: null } });
            finishSave();
            await settle();
        });
        expect(createInputs).toHaveLength(0);
        expect(outboxes.get(activeId)?.items || []).toHaveLength(0);
    } finally {
        finishSave();
        await mounted.close();
    }
});

test("首次自动消息被移除后，阶段变化及重挂载仍不重新自动开始", async () => {
    let saved!: CloudAgentConversation;
    const mounted = await mount(emptyGuide(), [], null, "guide-project", { startupRequest: guideStartup, offline: true });
    try {
        expect(outboxUI.outbox.items).toHaveLength(1);
        expect(outboxUI.outbox.items[0].text).toBe(guideStartup.text);
        await act(async () => {
            outboxUI.onRemove(outboxUI.outbox.items[0]);
            await settle();
        });
        expect(outboxes.get(activeId)?.items || []).toHaveLength(0);
        await act(async () => {
            useGlobalAgentStore.setState({ drama: { ...useGlobalAgentStore.getState().drama!, startupRequest: { ...guideStartup, text: "请检查下一阶段的角色与场景" } } });
            await settle();
        });
        expect(outboxes.get(activeId)?.items || []).toHaveLength(0);
        await persist();
        saved = structuredClone(local.find((item) => item.id === activeId)!);
        expect(saved.localDramaStartupRequested).toBe(true);
        expect(createInputs).toHaveLength(0);
    } finally {
        await mounted.close();
    }
    const reloaded = await mount(saved, [], null, "guide-project", { startupRequest: guideStartup });
    try {
        expect(createInputs).toHaveLength(0);
        expect(sent).toHaveLength(0);
        expect(outboxes.get(activeId)?.items || []).toHaveLength(0);
    } finally {
        await reloaded.close();
    }
});

test("取消首次自动消息后新建全局对话，空引导记录在刷新后仍保留启动标记", async () => {
    const mounted = await mount(emptyGuide(), [], null, "guide-project", { startupRequest: guideStartup, offline: true });
    let saved!: CloudAgentConversation[];
    let savedActive!: CloudAgentConversation;
    try {
        expect(outboxUI.outbox.items).toHaveLength(1);
        await act(async () => {
            outboxUI.onRemove(outboxUI.outbox.items[0]);
            await settle();
            useGlobalAgentStore.setState({ drama: null });
            await settle();
        });
        await act(async () => {
            header.onNew();
            await settle();
        });
        await persist();
        saved = structuredClone(local);
        savedActive = saved.find((item) => item.id === activeId)!;
        expect(saved.find((item) => item.id === emptyGuide().id)).toMatchObject({ localDramaStartupRequested: true, messages: [], run: null });
        expect(createInputs).toHaveLength(0);
    } finally {
        await mounted.close();
    }
    const reloaded = await mount(savedActive, [], null, "guide-project", { startupRequest: guideStartup, localConversations: saved });
    try {
        await focus();
        expect(createInputs).toHaveLength(0);
        expect(sent).toHaveLength(0);
        expect(outboxes.get(activeId)?.items || []).toHaveLength(0);
    } finally {
        await reloaded.close();
    }
});

function startupConflict(projectId = "guide-project") {
    return new ApiError("幂等键已用于不同请求", {
        status: 409,
        reason: "agent_idempotency_conflict",
        details: { runId: "other-device-startup", conversationId: "shared-session", dramaProjectId: projectId, canvasId: "" },
    });
}

test("不同模型争用首次启动身份时恢复已存在的会话，不重排首轮且允许用户继续", async () => {
    const existing = guideChat("other-device", "other-device-startup");
    const bound: string[] = [];
    let resolveLoad!: (value: CloudAgentConversation) => void;
    const mounted = await mount(emptyGuide(), [existing], null, "guide-project", {
        startupRequest: guideStartup,
        createRun: async () => {
            throw startupConflict();
        },
        loadConversation: () => new Promise((resolve) => (resolveLoad = resolve)),
        onConversationBound: (id) => bound.push(id),
    });
    try {
        expect(createInputs).toHaveLength(1);
        expect(createInputs[0].idempotencyKey).toBe("drama-start-guide-project");
        expect(conversationLoads).toEqual([{ id: "shared-session", scope: "sync-user" }]);
        expect(pending).toBeNull();
        await act(async () => {
            composer.onPromptChange("加载期间继续写的新草稿");
            resolveLoad(existing);
            await settle();
        });
        expect(composer.prompt).toBe("加载期间继续写的新草稿");
        expect(bound).toContain("shared-session");
        expect(conversationUI.messages.some((item: any) => item.text === "结果-other-device-startup")).toBe(true);
        expect(conversationUI.messages.some((item: any) => item.role === "user" && item.text === guideStartup.displayText)).toBe(false);
        expect(outboxes.get(activeId)?.items || []).toHaveLength(0);
        await focus();
        expect(createInputs).toHaveLength(1);
        await act(async () => composer.onPromptChange("把视频语言改为中文"));
        await act(async () => {
            composer.onSubmit();
            await settle();
        });
        expect(sent).toEqual(["other-device-startup"]);
        expect(sendInputs[0]).toMatchObject({ prompt: "把视频语言改为中文", dramaProjectId: "guide-project", permissionMode: "read_only" });
        expect(createInputs).toHaveLength(1);
    } finally {
        resolveLoad?.(existing);
        await mounted.close();
    }
});

test("首轮冲突后的会话读取失败可重新同步，刷新仍恢复原会话且不重建任务", async () => {
    const existing = guideChat("other-device", "other-device-startup");
    let saved!: CloudAgentConversation;
    const mounted = await mount(emptyGuide(), [existing], null, "guide-project", {
        startupRequest: guideStartup,
        createRun: async () => {
            throw startupConflict();
        },
        loadConversation: async () => {
            throw new Error("暂时不能读取已有对话");
        },
    });
    try {
        expect(createInputs).toHaveLength(1);
        expect(conversationLoads).toHaveLength(1);
        expect(pending).toBeNull();
        expect(outboxes.get(activeId)?.items || []).toHaveLength(0);
        await persist();
        saved = structuredClone(local.find((item) => item.id === activeId)!);
        expect(saved).toMatchObject({ serverConversationId: "shared-session", localDramaStartupRequested: true });
        const retry = Array.from(mounted.host.querySelectorAll("button")).find((button) => button.textContent?.includes("重新同步"));
        expect(retry).toBeDefined();
        loadOverride = async () => existing;
        await act(async () => {
            retry!.click();
            await settle();
        });
        expect(conversationLoads).toHaveLength(2);
        expect(conversationUI.messages.some((item: any) => item.text === "结果-other-device-startup")).toBe(true);
        expect(createInputs).toHaveLength(1);
    } finally {
        await mounted.close();
    }
    const reloaded = await mount(saved, [existing], null, "guide-project", { startupRequest: guideStartup, guideConversationId: null });
    try {
        expect(conversationLoads).toEqual([{ id: "shared-session", scope: "sync-user" }]);
        expect(conversationUI.messages.some((item: any) => item.text === "结果-other-device-startup")).toBe(true);
        expect(createInputs).toHaveLength(0);
        expect(sent).toHaveLength(0);
        expect(pending).toBeNull();
    } finally {
        await reloaded.close();
    }
});

test("首轮冲突恢复期间切换项目或账号，迟到的原会话不会覆盖新上下文", async () => {
    for (const switchTarget of ["project", "account"] as const) {
        const existing = guideChat("other-device", "other-device-startup");
        const next = guideChat("next-guide", "next-guide-run", "next-project");
        next.serverConversationId = "next-session";
        next.run!.conversationId = "next-session";
        let resolveLoad!: (value: CloudAgentConversation) => void;
        const bound: string[] = [];
        const mounted = await mount(emptyGuide(), [existing, next], null, "guide-project", {
            startupRequest: guideStartup,
            createRun: async () => {
                throw startupConflict();
            },
            loadConversation: (id) => (id === "next-session" ? Promise.resolve(next) : new Promise((resolve) => (resolveLoad = resolve))),
            onConversationBound: (id) => bound.push(id),
        });
        try {
            expect(conversationLoads).toEqual([{ id: "shared-session", scope: "sync-user" }]);
            expect(pending).toBeNull();
            await act(async () => {
                if (switchTarget === "project") {
                    useGlobalAgentStore.setState({ drama: { projectId: "next-project", guideConversationId: "next-session", host: mounted.host } });
                } else {
                    setActiveUserScope("other-user");
                    useUserStore.setState({ user: { id: "other-user", username: "other", displayName: "other", role: "user", status: "active" } });
                }
                await settle();
            });
            await act(async () => {
                composer.onPromptChange("新上下文中的草稿");
                resolveLoad(existing);
                await settle();
            });
            expect(conversationUI.messages.some((item: any) => item.text === "结果-other-device-startup")).toBe(false);
            if (switchTarget === "project") expect(conversationUI.messages.some((item: any) => item.text === "结果-next-guide-run")).toBe(true);
            expect(composer.prompt).toBe("新上下文中的草稿");
            expect(bound).not.toContain("shared-session");
            expect(createInputs).toHaveLength(1);
            expect(sent).toHaveLength(0);
        } finally {
            resolveLoad?.(existing);
            await mounted.close();
        }
    }
});

test("首轮冲突返回不匹配的恢复信息或会话时拒绝绑定，不重新发起任务", async () => {
    for (const mismatch of ["details-project", "loaded-project", "loaded-empty"] as const) {
        const existing = mismatch === "loaded-empty" ? { ...emptyGuide(), serverConversationId: "shared-session" } : guideChat("wrong-project", "other-device-startup", "different-project");
        const bound: string[] = [];
        const mounted = await mount(emptyGuide(), [], null, "guide-project", {
            startupRequest: guideStartup,
            createRun: async () => {
                throw startupConflict(mismatch === "details-project" ? "different-project" : "guide-project");
            },
            loadConversation: async () => existing,
            onConversationBound: (id) => bound.push(id),
        });
        try {
            expect(createInputs).toHaveLength(1);
            expect(conversationLoads).toHaveLength(mismatch === "details-project" ? 0 : 1);
            expect(bound).toHaveLength(0);
            expect(conversationUI.messages.some((item: any) => item.text === "结果-other-device-startup")).toBe(false);
            expect(sent).toHaveLength(0);
            if (mismatch !== "details-project") expect(pending).toBeNull();
            await focus();
            expect(createInputs).toHaveLength(1);
        } finally {
            await mounted.close();
        }
    }
});

test("缺少明确原因的首次409保留未知请求，重试仍使用原请求与幂等键", async () => {
    const mounted = await mount(emptyGuide(), [], null, "guide-project", {
        startupRequest: guideStartup,
        createRun: async () => {
            throw new ApiError("提交结果暂时不能确认", { status: 409 });
        },
    });
    try {
        expect(createInputs).toHaveLength(1);
        expect(pending?.key).toBe("drama-start-guide-project");
        const original = structuredClone(pending!);
        await focus();
        expect(createInputs).toHaveLength(1);
        expect(conversationLoads).toHaveLength(0);
        await act(async () => composer.onPromptChange(original.displayText || original.request!.prompt));
        await act(async () => {
            composer.onSubmit();
            await settle();
        });
        expect(createInputs).toHaveLength(2);
        expect(createInputs[1]).toEqual(original.request);
        expect(pending?.key).toBe(original.key);
        expect(sent).toHaveLength(0);
        expect(conversationLoads).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("刷新后的未知首轮原样重试被明确拒绝时，也能解除待确认并恢复已有会话", async () => {
    const existing = guideChat("other-device", "other-device-startup");
    const original: CloudAgentPendingSubmission = {
        key: "drama-start-guide-project",
        fingerprint: "startup-frozen",
        messageId: "user-drama-start-guide-project",
        displayText: guideStartup.displayText,
        request: { prompt: guideStartup.text, idempotencyKey: "drama-start-guide-project", dramaProjectId: "guide-project", permissionMode: "read_only" },
    };
    const mounted = await mount({ ...emptyGuide(), localDramaStartupRequested: true }, [existing], original, "guide-project", {
        startupRequest: guideStartup,
        createRun: async () => {
            throw startupConflict();
        },
    });
    try {
        expect(createInputs).toHaveLength(0);
        expect(pending?.key).toBe(original.key);
        await act(async () => {
            composer.onSubmit();
            await settle();
        });
        expect(createInputs).toHaveLength(1);
        expect(createInputs[0]).toEqual(original.request);
        expect(pending).toBeNull();
        expect(conversationLoads).toEqual([{ id: "shared-session", scope: "sync-user" }]);
        expect(conversationUI.messages.some((item: any) => item.text === "结果-other-device-startup")).toBe(true);
        expect(outboxes.get(activeId)?.items || []).toHaveLength(0);
        expect(sent).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("新作品可首次自动开始，返回旧作品不再自动推荐", async () => {
    const mounted = await mount(emptyGuide("first-guide"), [], null, "first-guide", { startupRequest: guideStartup });
    try {
        expect(createInputs.map((input) => input.dramaProjectId)).toEqual(["first-guide"]);
        await act(async () => {
            useGlobalAgentStore.setState({ drama: { projectId: "second-guide", host: mounted.host, startupRequest: { ...guideStartup } } });
            await settle();
        });
        expect(createInputs.map((input) => input.dramaProjectId)).toEqual(["first-guide", "second-guide"]);
        await act(async () => {
            useGlobalAgentStore.setState({ drama: { projectId: "first-guide", host: mounted.host, startupRequest: { ...guideStartup } } });
            await settle();
        });
        expect(createInputs.map((input) => input.dramaProjectId)).toEqual(["first-guide", "second-guide"]);
        expect(sent).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("已启动引导仍可显式请求再次推荐，自动启动标记不吞掉手动预填", async () => {
    const existing = guideChat("guide-local", "manual-parent");
    const mounted = await mount(existing, [existing], null, "guide-project", { startupRequest: guideStartup });
    try {
        await act(async () => {
            useGlobalAgentStore.setState({ drama: { ...useGlobalAgentStore.getState().drama!, prefillRequest: { id: 2, text: "请根据新要求重新推荐方案", autoSubmit: true } } });
            await settle();
        });
        expect(sent).toEqual(["manual-parent"]);
        expect(sendInputs[0]).toMatchObject({ prompt: "请根据新要求重新推荐方案", dramaProjectId: "guide-project", permissionMode: "read_only" });
        expect(createInputs).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

const savedGuideFeedback: AgentPrefillRequest = { id: 20, text: "配置已保存，请检查剩余事项并继续引导。", displayText: "配置已保存，继续引导", autoSubmit: true, requireIdle: true };

test("保存反馈在空闲时自动续接一次，StrictMode和上下文重注册不重复", async () => {
    const existing = guideChat("guide-local", "feedback-parent");
    const mounted = await mount(existing, [existing], null, "guide-project", { prefillRequest: savedGuideFeedback, strictMode: true });
    try {
        expect(sent).toEqual(["feedback-parent"]);
        expect(sendInputs[0]).toMatchObject({ prompt: savedGuideFeedback.text, dramaProjectId: "guide-project", permissionMode: "read_only" });
        expect(composer.prompt).toBe("");
        await act(async () => {
            useGlobalAgentStore.setState({ drama: { ...useGlobalAgentStore.getState().drama!, prefillRequest: { ...savedGuideFeedback } } });
            await settle();
        });
        await focus();
        expect(sent).toHaveLength(1);
        expect(createInputs).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("保存反馈保留未发送草稿，清空草稿后再自动续接", async () => {
    const existing = { ...guideChat("guide-local", "draft-feedback-parent"), draft: "我正在补充的要求" };
    const mounted = await mount(existing, [existing], null, "guide-project", { prefillRequest: savedGuideFeedback });
    try {
        expect(sent).toHaveLength(0);
        expect(outboxes.get(activeId)?.items || []).toHaveLength(0);
        expect(composer.prompt).toBe(existing.draft);
        await act(async () => {
            composer.onPromptChange("");
            await settle();
        });
        expect(sent).toEqual(["draft-feedback-parent"]);
        expect(sendInputs[0].prompt).toBe(savedGuideFeedback.text);
    } finally {
        await mounted.close();
    }
});

test("保存反馈不能回答已有问题，用户明确回答后才继续", async () => {
    const existing = guideChat("guide-local", "question-feedback-parent");
    existing.messages.push({ id: "pending-question", role: "assistant", text: "", question: { questionId: "direction", question: "选择创作方向", options: [{ label: "悬疑" }, { label: "喜剧" }] } });
    const mounted = await mount(existing, [existing], null, "guide-project", { prefillRequest: savedGuideFeedback });
    try {
        expect(sent).toHaveLength(0);
        expect(composer.prompt).toBe("");
        expect(outboxes.get(activeId)?.items || []).toHaveLength(0);
        expect(questionUI?.inlineFreeform).toBe(true);
        sendOverride = async () => ({ run: { ...makeRun("submitted-child"), canvasId: undefined, dramaProjectId: "guide-project", permissionMode: "read_only" } });
        await act(async () => {
            questionUI!.onAnswer("悬疑");
            await settle();
        });
        expect(sendInputs.map((input) => input.prompt)).toEqual(["悬疑", savedGuideFeedback.text]);
        expect(sent).toEqual(["question-feedback-parent", "submitted-child"]);
        expect(composer.prompt).toBe("");
    } finally {
        await mounted.close();
    }
});

test.each([400, 422])("ask_user输入回答被HTTP%s明确拒绝后，问题重挂仍保留同一草稿", async (status) => {
    const existing = guideChat("guide-local", `question-rejected-${status}`);
    const question = { questionId: "custom-direction", question: "选择创作方向", options: [{ label: "悬疑" }, { label: "其他（请直接描述）" }] };
    existing.messages.push({ id: "pending-question", role: "assistant", text: "", question });
    const mounted = await mount(existing, [existing], null, "guide-project");
    let rejectSend: ((reason: Error) => void) | undefined;
    try {
        const draftKey = `2:${question.options[1].label}`;
        await act(async () => questionUI!.replyOptionDrafts.onChange(draftKey, "按原设定保留兄弟关系，补充森林背景"));
        expect(mounted.host.querySelector<HTMLInputElement>('[data-testid="question-option-draft"]')!.value).toBe("按原设定保留兄弟关系，补充森林背景");
        sendOverride = () =>
            new Promise((_resolve, reject) => {
                rejectSend = reject;
            });
        await act(async () => {
            questionUI!.onAnswer("按原设定保留兄弟关系，补充森林背景");
            await settle();
        });
        expect(rejectSend).toBeDefined();
        expect(mounted.host.querySelector('[data-testid="question-option-draft"]')).toBeNull();
        await act(async () => {
            rejectSend!(new ApiError("回答未被受理", { status }));
            await settle();
        });
        expect(mounted.host.querySelector<HTMLInputElement>('[data-testid="question-option-draft"]')!.value).toBe("按原设定保留兄弟关系，补充森林背景");
        expect(sendInputs[0].prompt).toBe("按原设定保留兄弟关系，补充森林背景");
        expect(pending).toBeNull();
        expect(composer.prompt).toBe("");
        expect(sent).toHaveLength(1);
        expect(createInputs).toHaveLength(0);
    } finally {
        rejectSend?.(new ApiError("测试清理", { status }));
        await mounted.close();
    }
});

test("保存反馈等待现有轮次结束，不提前进入发送队列", async () => {
    const existing = guideChat("guide-local", "running-feedback-parent");
    existing.run!.status = "running";
    const mounted = await mount(existing, [existing], null, "guide-project", { prefillRequest: savedGuideFeedback });
    try {
        expect(sent).toHaveLength(0);
        expect(outboxes.get(activeId)?.items || []).toHaveLength(0);
        await act(async () => {
            subscriptions.at(-1)!.event({ eventId: "feedback-completed", runId: existing.run!.id, seq: 5, type: "run_status", payload: { status: "completed", revision: 2 }, createdAt: existing.updatedAt });
            await settle();
        });
        expect(sent).toEqual(["running-feedback-parent"]);
        expect(sendInputs[0].prompt).toBe(savedGuideFeedback.text);
    } finally {
        await mounted.close();
    }
});

test("保存反馈不能越过结果未知请求，即使手动清空输入框也不发送", async () => {
    const existing = guideChat("guide-local", "pending-feedback-parent");
    const original: CloudAgentPendingSubmission = { key: "feedback-original", fingerprint: "frozen", parentRunId: existing.run!.id, request: { prompt: "原结果未知请求", dramaProjectId: "guide-project", idempotencyKey: "feedback-original" } };
    const mounted = await mount(existing, [existing], original, "guide-project", { prefillRequest: savedGuideFeedback });
    try {
        await act(async () => {
            composer.onPromptChange("");
            await settle();
        });
        expect(pending).toBe(original);
        expect(sent).toHaveLength(0);
        expect(outboxes.get(activeId)?.items || []).toHaveLength(0);
        expect(composer.prompt).toBe("");
    } finally {
        await mounted.close();
    }
});

test("保存反馈等待队列恢复，已有满队列时不回填输入框，移空后才发送", async () => {
    const existing = guideChat("guide-local", "outbox-feedback-parent");
    let resolveOutbox!: (value: AgentOutbox | null) => void;
    const restored = new Promise<AgentOutbox | null>((resolve) => (resolveOutbox = resolve));
    const mounted = await mount(existing, [existing], null, "guide-project", { prefillRequest: savedGuideFeedback, outboxLoad: (id) => (id === existing.id ? restored : Promise.resolve(null)) });
    try {
        expect(sent).toHaveLength(0);
        const item = queuedGuideMessage().items[0];
        await act(async () => {
            resolveOutbox({ version: 1, items: Array.from({ length: 5 }, (_, index) => ({ ...item, id: `existing-${index}` })) });
            await settle();
        });
        expect(sent).toHaveLength(0);
        expect(outboxUI.outbox.items).toHaveLength(5);
        expect(composer.prompt).toBe("");
        await act(async () => {
            for (const entry of outboxUI.outbox.items) outboxUI.onRemove(entry);
            await settle();
        });
        expect(sent).toEqual(["outbox-feedback-parent"]);
        expect(sendInputs[0].prompt).toBe(savedGuideFeedback.text);
    } finally {
        await mounted.close();
    }
});

test("等待中的保存反馈不泄漏到新项目或新账号", async () => {
    const existing = { ...guideChat("guide-local", "old-feedback-parent"), draft: "旧项目草稿" };
    const mounted = await mount(existing, [existing], null, "guide-project", { prefillRequest: savedGuideFeedback });
    try {
        const next = emptyGuide("next-project");
        await act(async () => {
            useGlobalAgentStore.setState({ drama: { projectId: "next-project", host: mounted.host } });
            await settle();
        });
        expect(sent).toHaveLength(0);
        expect(createInputs).toHaveLength(0);
        expect(composer.prompt).not.toContain(savedGuideFeedback.text);
        await act(async () => {
            setActiveUserScope("other-user");
            useUserStore.setState({ user: { id: "other-user", username: "other", displayName: "other", role: "user", status: "active" } });
            await settle();
        });
        expect(sent).toHaveLength(0);
        expect(createInputs).toHaveLength(0);
        expect(outboxes.get(next.id)?.items || []).toHaveLength(0);
    } finally {
        await mounted.close();
    }
});

test("引导会话冲突重新加载最新轮次，保留本机身份与加载期间的新草稿，明确发送才续接", async () => {
    const first = guideChat("guide-local", "guide-first");
    const mounted = await mount(first, [first], null, "guide-project");
    try {
        expect(conversationLoads).toEqual([{ id: "shared-session", scope: "sync-user" }]);
        await act(async () => composer.onPromptChange("保留这条引导草稿"));
        const latest = guideChat("guide-server", "guide-other-device-child");
        latest.run!.parentId = "guide-first";
        let resolveLoad!: (conversation: CloudAgentConversation) => void;
        loadOverride = () => new Promise((resolve) => (resolveLoad = resolve));
        sendFailure = new ApiError("会话已在另一端推进", { status: 409, reason: "agent_conversation_stale_parent" });
        await act(async () => {
            composer.onSubmit();
            await settle();
        });
        expect(sent).toEqual(["guide-first"]);
        expect(conversationLoads).toHaveLength(2);
        expect(pending).toBeNull();
        expect(composer.prompt).toBe("保留这条引导草稿");
        await act(async () => {
            composer.onPromptChange("加载期间继续编辑的草稿");
            resolveLoad(latest);
            await settle();
        });
        expect(conversationUI.messages.some((item: any) => item.text === "结果-guide-other-device-child")).toBe(true);
        expect(composer.prompt).toBe("加载期间继续编辑的草稿");
        expect(sent).toHaveLength(1);
        await persist();
        expect(activeId).toBe("guide-local");
        sendFailure = undefined;
        sendOverride = async () => ({ run: { ...latest.run!, id: "guide-next", parentId: latest.run!.id } });
        await act(async () => {
            composer.onSubmit();
            await settle();
        });
        expect(sent).toEqual(["guide-first", "guide-other-device-child"]);
        expect(sendInputs[1]).toMatchObject({ prompt: "加载期间继续编辑的草稿", dramaProjectId: "guide-project", permissionMode: "read_only", budget: { maxGenerationTasks: 0, maxVideoSeconds: 0 } });
        expect(sendInputs[1].idempotencyKey).not.toBe(sendInputs[0].idempotencyKey);
        expect(generated).toBe(0);
    } finally {
        await mounted.close();
    }
});

test("引导未知提交原样重试后收到明确冲突，释放原身份并同步，保留正文等待确认", async () => {
    const first = guideChat("guide-local", "guide-pending-parent");
    const original: CloudAgentPendingSubmission = {
        key: "guide-original-key",
        fingerprint: "frozen",
        parentRunId: first.run!.id,
        messageId: "user-guide-original-key",
        request: { prompt: "引导待确认请求", idempotencyKey: "guide-original-key", dramaProjectId: "guide-project", permissionMode: "read_only" },
    };
    const mounted = await mount(first, [first], original, "guide-project");
    try {
        expect(composer.prompt).toBe(original.request!.prompt);
        expect(pending?.key).toBe(original.key);
        remote = [guideChat("guide-server", "guide-pending-new-parent")];
        sendFailure = new ApiError("原请求未受理，会话已经更新", { status: 409, reason: "agent_conversation_stale_parent" });
        await act(async () => {
            composer.onSubmit();
            await settle();
        });
        expect(sendInputs).toHaveLength(1);
        expect(sendInputs[0]).toEqual(original.request);
        expect(pending).toBeNull();
        expect(composer.prompt).toBe(original.request!.prompt);
        expect(conversationUI.messages.some((item: any) => item.text === "结果-guide-pending-new-parent")).toBe(true);
        expect(generated).toBe(0);
    } finally {
        await mounted.close();
    }
});

test("引导冲突恢复时切换项目，迟到的旧会话不能写入新项目", async () => {
    const first = guideChat("guide-local", "guide-first");
    const mounted = await mount(first, [first], null, "guide-project");
    try {
        let resolveLoad!: (conversation: CloudAgentConversation) => void;
        const next = guideChat("next-guide", "next-guide-run", "next-project");
        next.serverConversationId = "next-session";
        next.run!.conversationId = "next-session";
        loadOverride = (id) => (id === "next-session" ? Promise.resolve(next) : new Promise((resolve) => (resolveLoad = resolve)));
        await act(async () => composer.onPromptChange("旧项目的草稿"));
        sendFailure = new ApiError("会话已经更新", { status: 409, reason: "agent_conversation_stale_parent" });
        await act(async () => {
            composer.onSubmit();
            await settle();
        });
        expect(conversationLoads).toHaveLength(2);
        await act(async () => {
            useGlobalAgentStore.setState({ drama: { projectId: "next-project", guideConversationId: "next-session", host: mounted.host } });
            await settle();
        });
        await act(async () => {
            composer.onPromptChange("新项目草稿");
            resolveLoad(guideChat("old-cloud", "late-old-guide"));
            await settle();
        });
        expect(conversationUI.messages.some((item: any) => item.text === "结果-next-guide-run")).toBe(true);
        expect(conversationUI.messages.some((item: any) => item.text === "结果-late-old-guide")).toBe(false);
        expect(composer.prompt).toBe("新项目草稿");
        expect(sent).toEqual(["guide-first"]);
    } finally {
        await mounted.close();
    }
});

test("同轮历史已追赶到新水位后，延迟的旧 SSE delta 不会再次追加正文", async () => {
    const current = chat("local", makeRun("streaming", "running"));
    const mounted = await mount(current, [current]);
    try {
        const observation = subscriptions.at(-1)!;
        remote = [{ ...current, run: { ...current.run!, revision: 2 }, lastEventSeq: 6, messages: [{ id: "live-answer", role: "assistant", text: "完整回答" }] }];
        await focus();
        expect(conversationUI.messages.find((item: any) => item.id === "live-answer")?.text).toBe("完整回答");
        expect(subscriptions.at(-1)).toBe(observation);
        await act(async () => {
            observation.event({ eventId: "delayed-five", runId: "streaming", seq: 5, type: "assistant_delta", payload: { messageId: "live-answer", text: "重复片段" }, createdAt: current.updatedAt });
        });
        expect(conversationUI.messages.find((item: any) => item.id === "live-answer")?.text).toBe("完整回答");
        await act(async () => {
            observation.event({ eventId: "new-seven", runId: "streaming", seq: 7, type: "assistant_delta", payload: { messageId: "live-answer", text: "新内容" }, createdAt: current.updatedAt });
        });
        expect(conversationUI.messages.find((item: any) => item.id === "live-answer")?.text).toBe("完整回答新内容");
        await persist();
        expect(local.find((item) => item.id === activeId)?.lastEventSeq).toBe(7);
        expect(generated).toBe(0);
    } finally {
        await mounted.close();
    }
});

test("等待能力校验时切换账号，旧账号的请求不得以新账号身份提交", async () => {
    const initial = chat("original", makeRun("first"));
    const mounted = await mount(initial, [initial]);
    let release: ((value: unknown) => void) | undefined;
    try {
        capabilitiesOverride = () =>
            new Promise((resolve) => {
                release = resolve;
            });
        await act(async () => {
            composer.onPromptChange("属于原账号的输入");
        });
        await act(async () => {
            composer.onSubmit();
            await settle();
        });
        expect(release).toBeDefined();
        await act(async () => {
            setActiveUserScope("other-user");
            useUserStore.setState({ user: { id: "other-user", username: "other", displayName: "other", role: "user", status: "active" } });
            release!({ permissionModes: ["request_approval"], skills: true });
            await settle();
        });
        expect(sent).toHaveLength(0);
        expect(pending).toBeNull();
        expect(composer.prompt).toBe("");
        expect(generated).toBe(0);
    } finally {
        release?.({ permissionModes: ["request_approval"], skills: true });
        await mounted.close();
    }
});

test("旧账号 POST 的迟到响应不覆盖新账号面板，清理也只使用原账号范围", async () => {
    const initial = chat("original", makeRun("first"));
    const mounted = await mount(initial, [initial]);
    let release: ((value: { run: AgentRun }) => void) | undefined;
    try {
        sendOverride = () =>
            new Promise((resolve) => {
                release = resolve;
            });
        await act(async () => {
            composer.onPromptChange("原账号已提交的输入");
        });
        await act(async () => {
            composer.onSubmit();
            await settle();
        });
        expect(sent).toEqual(["first"]);
        expect(release).toBeDefined();
        await act(async () => {
            setActiveUserScope("other-user");
            useUserStore.setState({ user: { id: "other-user", username: "other", displayName: "other", role: "user", status: "active" } });
            await settle();
            release!({ run: { ...makeRun("original-late-child"), parentId: "first" } });
            await settle();
        });
        expect(subscriptions.some((item) => item.id === "original-late-child")).toBe(false);
        expect(conversationUI.messages).toHaveLength(0);
        expect(composer.prompt).toBe("");
        expect(pending).toBeNull();
        expect(generated).toBe(0);
    } finally {
        release?.({ run: makeRun("original-late-child") });
        await mounted.close();
    }
});

test("原样重试未知 POST 后得到明确 stale_parent 可解除旧身份，仍保留草稿且不自动重发", async () => {
    const initial = chat("original", makeRun("first"));
    const original: CloudAgentPendingSubmission = {
        key: "uncertain-original-key",
        fingerprint: "frozen",
        parentRunId: "first",
        messageId: "user-uncertain-original-key",
        request: { canvasId: "shared-canvas", prompt: "原请求内容", idempotencyKey: "uncertain-original-key" },
    };
    const mounted = await mount(initial, [initial], original);
    try {
        remote = [chat("server", { ...makeRun("other-device-child"), parentId: "first" })];
        sendFailure = new ApiError("已确认该 key 未受理，另一端已推进", { status: 409, reason: "agent_conversation_stale_parent" });
        await act(async () => {
            composer.onSubmit();
            await settle();
        });
        expect(sent).toEqual(["first"]);
        expect(sendInputs[0]).toEqual(original.request);
        expect(pending).toBeNull();
        expect(composer.prompt).toBe("原请求内容");
        expect(conversationUI.messages.some((item: any) => item.text === "结果-other-device-child")).toBe(true);
        expect(generated).toBe(0);
    } finally {
        await mounted.close();
    }
});

test("手动重新打开当前云端历史时同步水位，旧 SSE 缓冲不会重复正文", async () => {
    const current = chat("local", makeRun("same-current"));
    const mounted = await mount(current, [current]);
    try {
        const observation = subscriptions.at(-1)!;
        await act(async () => {
            header.onHistory();
            await new Promise((resolve) => setTimeout(resolve, 350));
        });
        remote = [{ ...current, run: { ...current.run!, revision: 2 }, lastEventSeq: 6, messages: [{ id: "manual-history-answer", role: "assistant", text: "手动恢复的完整回复" }] }];
        await act(async () => {
            historyUI.onOpen(current);
            await new Promise((resolve) => setTimeout(resolve, 350));
        });
        expect(conversationUI.messages.find((item: any) => item.id === "manual-history-answer")?.text).toBe("手动恢复的完整回复");
        await act(async () => {
            observation.event({ eventId: "history-delayed-five", runId: "same-current", seq: 5, type: "assistant_delta", payload: { messageId: "manual-history-answer", text: "重复内容" }, createdAt: current.updatedAt });
        });
        expect(conversationUI.messages.find((item: any) => item.id === "manual-history-answer")?.text).toBe("手动恢复的完整回复");
        await persist();
        expect(local.find((item) => item.id === activeId)?.lastEventSeq).toBe(6);
        expect(generated).toBe(0);
    } finally {
        await mounted.close();
    }
});
