import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaCast, DramaSummary } from "@/services/api/drama";
import type { DramaCastAssistanceRequest, DramaCastAssistanceResult } from "@/services/api/drama-cast-assistance";

const browser = new Window({ url: "http://localhost/projects/project-a/workflow" });
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
}))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const userStore = create(() => ({ user: { id: "user-a" } }));
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
    let resolve!: Deferred<T>["resolve"];
    let reject!: Deferred<T>["reject"];
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
const storage = new Map<string, string>();
const checks: DramaCastAssistanceRequest[] = [];
const executions: { request: DramaCastAssistanceRequest; deferred: Deferred<{ id: string; status: string }> }[] = [];
const adoptions: { expectedRevision: number; castRevision: number; takeId: string; text?: string }[] = [];
let results: DramaCastAssistanceResult[] = [];
let changed = 0;
const Input = { TextArea: ({ onChange, ...props }: Record<string, unknown>) => createElement("textarea", { ...props, onInput: onChange }) };
mock.module("antd", () => ({
    Button: ({ children, loading: _loading, type: _type, size: _size, icon: _icon, ...props }: Record<string, unknown>) => createElement("button", props, children as ReactNode),
    Input,
    Select: ({ options, onChange, ...props }: { options: { value: string; label: string }[]; onChange: (value: string) => void }) =>
        createElement(
            "select",
            { ...props, onChange: (event: { target: { value: string } }) => onChange(event.target.value) },
            createElement("option", { value: "" }, "选择音色"),
            options.map((option) => createElement("option", { key: option.value, value: option.value }, option.label)),
        ),
}));
mock.module("@/components/ui/product/app-modal", () => ({
    AppModal: ({ title, children, onCancel }: { title: string; children: ReactNode; onCancel: () => void }) => (
        <section role="dialog" aria-label={title}>
            <button onClick={onCancel}>关闭辅助</button>
            {children}
        </section>
    ),
}));
mock.module("@/components/assets/asset-library-picker-modal", () => ({
    AssetLibraryPickerModal: ({ open, onConfirm }: { open: boolean; onConfirm: (ids: string[], items: unknown[]) => void }) =>
        open ? <button onClick={() => onConfirm(["image"], [{ asset: { kind: "image", data: { storageKey: "resource:chosen-image" } } }])}>选择真实图片</button> : null,
}));
mock.module("@/components/model-picker", () => ({ ModelPicker: () => <span>平台音频模型</span> }));
mock.module("@/pages/projects/drama-model-picker", () => ({ DramaModelPicker: () => <span>平台文字模型</span> }));
mock.module("@/pages/projects/drama-shared", () => ({ MediaThumb: ({ resourceId, alt }: { resourceId: string; alt: string }) => <img data-resource={resourceId} alt={alt} /> }));
mock.module("@/pages/projects/studio/cast-voice", () => ({ CastVoicePreview: ({ resourceId }: { resourceId: string }) => <button data-resource={resourceId}>试听真实样本</button> }));
mock.module("@/stores/use-config-store", () => ({ useEffectiveConfig: () => ({ audioModel: "audio-system" }) }));
mock.module("@/lib/drama/model-choice", () => ({ dramaChoiceToModel: () => "audio-system", modelToDramaChoice: () => ({ channelId: "system", modelKey: "audio-system" }) }));
mock.module("@/lib/audio-generation", () => ({ audioVoiceOptionsForConfig: () => [{ value: "alloy", label: "Alloy" }] }));
mock.module("@/stores/use-user-store", () => ({ useUserStore: userStore }));
const scope = await import("@/lib/user-scope");
mock.module("@/lib/user-scope", () => ({ ...scope, getActiveUserScope: () => userStore.getState().user.id }));
mock.module("@/lib/localforage-storage", () => ({
    localForageStorageForScope: (id: string) => ({
        getItem: async (key: string) => storage.get(`${id}:${key}`) || null,
        setItem: async (key: string, value: string) => {
            storage.set(`${id}:${key}`, value);
        },
        removeItem: async (key: string) => {
            storage.delete(`${id}:${key}`);
        },
    }),
}));
mock.module("@/services/api/drama-cast-assistance", () => ({
    getDramaCastAssistance: async () => structuredClone(results),
    preflightDramaCastAssistance: async (_projectId: string, _castId: string, input: DramaCastAssistanceRequest) => {
        checks.push(structuredClone(input));
        return { ready: true, priced: true, estimated: false, amountMicrocredits: 100, confirmationToken: "confirmed-quote" };
    },
    executeDramaCastAssistance: (_projectId: string, _castId: string, input: DramaCastAssistanceRequest) => {
        const item = { request: structuredClone(input), deferred: deferred<{ id: string; status: string }>() };
        executions.push(item);
        return item.deferred.promise;
    },
    adoptDramaCastAssistance: async (_projectId: string, _castId: string, input: { expectedRevision: number; castRevision: number; takeId: string; text?: string }) => {
        adoptions.push(input);
        return {};
    },
}));
const { WorkflowCastAssistance } = await import("@/pages/projects/workflow-cast-assistance");
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const result = (value: Partial<DramaCastAssistanceResult> = {}): DramaCastAssistanceResult => ({
    id: "take-real",
    taskId: "task-real",
    purpose: "fill_description",
    version: 1,
    status: "succeeded",
    progress: 100,
    text: "26岁，其他外观未明确。",
    sourceRevision: 2,
    stale: false,
    createdAt: "2026-11-13T00:00:00Z",
    ...value,
});
async function mount(options: { preserve?: boolean; history?: DramaCastAssistanceResult[]; purpose?: "fill_description" | "image_prompt" | "voice_sample" } = {}) {
    if (!options.preserve) storage.clear();
    checks.length = executions.length = adoptions.length = 0;
    changed = 0;
    results = options.history || [];
    userStore.setState({ user: { id: "user-a" } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const summary = { project: { id: "project-a" }, production: { revision: 3, settings: { models: { text: { channelId: "system", modelKey: "text" } } } } } as DramaSummary;
    const cast = { id: "cast-a", projectId: "project-a", kind: "character", name: "秦子文", revision: 2 } as DramaCast;
    await act(async () => {
        root.render(
            <QueryClientProvider client={client}>
                <WorkflowCastAssistance summary={summary} cast={cast} onChanged={() => changed++} />
            </QueryClientProvider>,
        );
        await settle();
    });
    await click(host, { fill_description: "AI 补写外观", image_prompt: "图片反推提示词", voice_sample: "生成音色试听" }[options.purpose || "fill_description"]);
    await act(settle);
    return {
        host,
        close: async () => {
            await act(async () => root.unmount());
            client.clear();
            host.remove();
        },
    };
}
function button(host: HTMLElement, text: string) {
    const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text);
    if (!found) throw new Error(`未找到按钮 ${text}: ${host.textContent}`);
    return found;
}
async function click(host: HTMLElement, text: string) {
    await act(async () => {
        button(host, text).click();
        await settle();
    });
}
async function input(host: HTMLElement, label: string, value: string) {
    const element = host.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
    await act(async () => {
        element.value = value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        await settle();
    });
}

test("报价后须明确确认，任务不自动应用", async () => {
    const ui = await mount();
    await click(ui.host, "预检并报价");
    expect(executions).toHaveLength(0);
    expect(checks[0].expectedRevision).toBe(3);
    expect(checks[0].castRevision).toBe(2);
    await click(ui.host, "确认生成");
    expect(executions).toHaveLength(1);
    expect(executions[0].request.confirmationToken).toBe("confirmed-quote");
    await act(async () => {
        executions[0].deferred.resolve({ id: "task", status: "queued" });
        await settle();
    });
    expect(adoptions).toHaveLength(0);
    expect(storage.size).toBe(0);
    expect(ui.host.textContent).toContain("任务已提交");
    await ui.close();
});

test("不确定提交重开后复用原标识确认", async () => {
    const first = await mount();
    await click(first.host, "预检并报价");
    await click(first.host, "确认生成");
    const original = executions[0].request;
    await act(async () => {
        executions[0].deferred.reject(new Error("网络超时"));
        await settle();
    });
    expect(storage.size).toBe(1);
    await first.close();
    const second = await mount({ preserve: true });
    expect(button(second.host, "预检并报价").disabled).toBe(true);
    await click(second.host, "确认提交结果");
    expect(executions[0].request).toEqual(original);
    expect(checks).toHaveLength(0);
    await act(async () => {
        executions[0].deferred.resolve({ id: "same-task", status: "queued" });
        await settle();
    });
    expect(storage.size).toBe(0);
    await second.close();
});

test("采用用户审阅文字时传双版本和真实结果 ID", async () => {
    const ui = await mount({ history: [result()] });
    await input(ui.host, "版本 1 草稿", "26岁；其他外观未明确。");
    await click(ui.host, "采用为外观描述");
    expect(adoptions).toEqual([{ expectedRevision: 3, castRevision: 2, takeId: "take-real", text: "26岁；其他外观未明确。" }]);
    expect(changed).toBe(1);
    await ui.close();
});

test("资产变更后的历史结果不能覆盖当前设定", async () => {
    const ui = await mount({ history: [result({ sourceRevision: 1, stale: true })] });
    expect(ui.host.textContent).toContain("此结果仅保留在历史中");
    expect(button(ui.host, "采用为外观描述").disabled).toBe(true);
    expect(adoptions).toHaveLength(0);
    await ui.close();
});

test("图片反推发送资产库真实图片引用", async () => {
    const ui = await mount({ purpose: "image_prompt" });
    await click(ui.host, "从资产库选择图片");
    await click(ui.host, "选择真实图片");
    await click(ui.host, "预检并报价");
    expect(checks[0].sourceResourceId).toBe("chosen-image");
    expect(checks[0].purpose).toBe("image_prompt");
    expect(executions).toHaveLength(0);
    await ui.close();
});

test("切换账号后迟到回执不能刷新新会话", async () => {
    const ui = await mount();
    await click(ui.host, "预检并报价");
    await click(ui.host, "确认生成");
    await act(async () => {
        userStore.setState({ user: { id: "user-b" } });
        await settle();
    });
    await act(async () => {
        executions[0].deferred.resolve({ id: "old-task", status: "queued" });
        await settle();
    });
    expect(changed).toBe(0);
    expect(ui.host.textContent).not.toContain("任务已提交");
    expect(adoptions).toHaveLength(0);
    await ui.close();
});

test("声音历史可试听且仅显式采用时绑定", async () => {
    const ui = await mount({ purpose: "voice_sample", history: [result({ purpose: "voice_sample", text: undefined, resourceId: "real-audio" })] });
    expect(button(ui.host, "试听真实样本").dataset.resource).toBe("real-audio");
    expect(adoptions).toHaveLength(0);
    await click(ui.host, "采用为角色声音");
    expect(adoptions).toEqual([{ expectedRevision: 3, castRevision: 2, takeId: "take-real" }]);
    expect(changed).toBe(1);
    await ui.close();
});

afterAll(() => browser.close());
