import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { ComponentProps, ReactNode } from "react";
import type { StyleProfileSnapshot } from "../../src/lib/canvas/style-profile";
import type { GenerationTask } from "../../src/services/api/task-center";

const browser = new Window({ url: "http://localhost/settings?section=styles" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getActiveUserScope, setActiveUserScope } = await import("../../src/lib/user-scope");

type DraftOptions = {
    idea: string;
    profile: StyleProfileSnapshot;
    signal: AbortSignal;
    onTaskUpdate: (task: GenerationTask) => void;
};
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((accept, fail) => {
        resolve = accept;
        reject = fail;
    });
    return { promise, resolve, reject };
}

let userId = "user-a";
const config = { textModel: "text-model" };
const requests: Array<{ options: DraftOptions; pending: ReturnType<typeof deferred<StyleProfileSnapshot>> }> = [];
const generate = mock((options: DraftOptions) => {
    const pending = deferred<StyleProfileSnapshot>();
    requests.push({ options, pending });
    // 故意不跟随 Abort 自动拒绝，验证组件能挡住关闭后晚到的回执与结果。
    return pending.promise;
});
const cancel = mock(async (id: string) => ({ id, status: "cancelled" }));
const warning = mock(() => {});
const appContext = { message: { warning } };
const closed = mock(() => {});
const filled = mock((_profile: StyleProfileSnapshot) => {});

mock.module("antd", () => ({
    App: { useApp: () => appContext },
    Button: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => (
        <button type="button" disabled={disabled} onClick={onClick}>
            {children}
        </button>
    ),
    Input: { TextArea: ({ autoSize: _autoSize, showCount: _showCount, ...props }: ComponentProps<"textarea"> & { autoSize?: unknown; showCount?: boolean }) => <textarea {...props} /> },
}));
mock.module("../../src/components/ui/product/app-modal", () => ({
    AppModal: ({ children, onCancel }: { children: ReactNode; onCancel: () => void }) => (
        <section role="dialog">
            <button type="button" aria-label="关闭弹窗" onClick={onCancel} />
            {children}
        </section>
    ),
}));
mock.module("../../src/components/model-picker", () => ({ ModelPicker: () => <span>已选择文本模型</span> }));
mock.module("../../src/stores/use-config-store", () => ({
    useEffectiveConfig: () => config,
    useConfigStore: (selector: (state: { isAiConfigReady: () => boolean }) => unknown) => selector({ isAiConfigReady: () => true }),
    configuredModelMatchesCapability: () => true,
}));
mock.module("../../src/stores/use-user-store", () => ({ useUserStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: userId } }) }));
mock.module("../../src/services/style-profile-drafting", () => ({ generateStyleProfileDraft: generate }));
mock.module("../../src/lib/canvas/style-profile-drafting", () => ({ STYLE_DRAFT_IDEA_LIMIT: 4000 }));
mock.module("../../src/services/api/task-center", () => ({ cancelGenerationTask: cancel }));

const { StyleProfileDraftModal } = await import("../../src/components/canvas/style-profile-draft-modal");
const profile: StyleProfileSnapshot = {
    schemaVersion: 1,
    presetId: "draft-style",
    title: "未命名风格",
    description: "",
    tags: [],
    prompt: "",
    coverUrl: "/api/resources/cover/file",
    assets: [],
    source: "user",
    revision: 1,
};
const generated: StyleProfileSnapshot = { ...profile, title: "暗彩水墨", description: "细腻工笔与低饱和暗彩", prompt: "细腻线条，青绿与赭红配色", tags: ["水墨"] };
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Harness() {
    const [open, setOpen] = useState(true);
    return open ? (
        <StyleProfileDraftModal
            profile={profile}
            onFill={filled}
            onClose={() => {
                closed();
                setOpen(false);
            }}
        />
    ) : null;
}

beforeEach(async () => {
    userId = "user-a";
    setActiveUserScope(userId);
    requests.length = 0;
    generate.mockClear();
    cancel.mockClear();
    warning.mockClear();
    closed.mockClear();
    filled.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Harness />));
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
});
afterAll(() => {
    browser.happyDOM.abort();
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function action(text: string) {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text);
    if (!button) throw new Error(`找不到按钮：${text}`);
    return button;
}
async function enterIdea(idea = "东方志怪，暗彩水墨和工笔线条") {
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="风格描述"]')!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, idea);
        textarea.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
}
async function start(count = 1) {
    await enterIdea();
    await act(async () => {
        for (let i = 0; i < count; i++) action("生成并填入").click();
    });
    expect(requests).toHaveLength(1);
    return requests[0];
}
function task(overrides: Partial<GenerationTask> = {}): GenerationTask {
    return { id: "task-a", type: "canvas_text", status: "queued", prompt: "风格填写", model: "text-model", attempts: 0, createdAt: "", updatedAt: "", ...overrides };
}

test("生成完成才回填完整草稿，由父级决定后续保存", async () => {
    const original = structuredClone(profile);
    const request = await start();
    expect(filled).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(request.options.idea).toBe("东方志怪，暗彩水墨和工笔线条");
    expect(request.options.profile).toBe(profile);
    expect(profile).toEqual(original);
    await act(async () => request.pending.resolve(generated));
    expect(filled).toHaveBeenCalledTimes(1);
    expect(filled).toHaveBeenCalledWith(generated);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(profile).toEqual(original);
    expect(cancel).not.toHaveBeenCalled();
});

test("错误保留用户描述与原草稿，允许修改前重试", async () => {
    const request = await start();
    await act(async () => request.pending.reject(new Error("模型输出格式不完整")));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("模型输出格式不完整");
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(request.options.idea);
    expect(filled).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    await act(async () => action("生成并填入").click());
    expect(requests).toHaveLength(2);
    await act(async () => requests[1].pending.resolve(generated));
    expect(filled).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("同一轮连续点击只提交一次模型任务", async () => {
    const request = await start(2);
    expect(generate).toHaveBeenCalledTimes(1);
    await act(async () => request.pending.resolve(generated));
    expect(filled).toHaveBeenCalledTimes(1);
});

test("关闭后晚到的排队回执会取消一次，结果不回填", async () => {
    const request = await start();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="关闭弹窗"]')!.click());
    expect(request.options.signal.aborted).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => {
        request.options.onTaskUpdate(task());
        request.options.onTaskUpdate(task());
        request.pending.resolve(generated);
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("task-a");
    expect(filled).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
});

test("第三方已接收任务时停止填写，不发送不被允许的取消请求", async () => {
    const request = await start();
    await act(async () => request.options.onTaskUpdate(task({ status: "running", providerRequestId: "upstream-id", stage: "供应商生成中" })));
    await act(async () => action("停止填写").click());
    expect(request.options.signal.aborted).toBe(true);
    await act(async () => request.pending.resolve(generated));
    expect(cancel).not.toHaveBeenCalled();
    expect(filled).not.toHaveBeenCalled();
});

test("切换账号隔离旧任务和描述，新账号可以继续填写", async () => {
    const request = await start();
    await act(async () => {
        userId = "user-b";
        setActiveUserScope(userId);
        root.render(<Harness />);
    });
    expect(getActiveUserScope()).toBe("user-b");
    expect(request.options.signal.aborted).toBe(true);
    const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe("");
    await enterIdea("霓虹科幻，强烈的冷暖对比");
    await act(async () => action("生成并填入").click());
    expect(requests).toHaveLength(2);
    const next = requests[1];
    expect(next.options.idea).toBe("霓虹科幻，强烈的冷暖对比");
    await act(async () => {
        request.options.onTaskUpdate(task());
        request.pending.resolve(generated);
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(filled).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(textarea.disabled).toBe(true);
    expect(next.options.signal.aborted).toBe(false);
    const nextResult = { ...generated, title: "霓虹科幻" };
    await act(async () => next.pending.resolve(nextResult));
    expect(filled).toHaveBeenCalledTimes(1);
    expect(filled).toHaveBeenCalledWith(nextResult);
    expect(closed).toHaveBeenCalledTimes(1);
});
