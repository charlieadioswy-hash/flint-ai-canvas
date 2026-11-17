import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaStudioBatchRequest, DramaStudioBatchStatus, DramaStudioBatchView } from "@/services/api/drama";
import type { WorkflowBatchProps } from "@/pages/projects/workflow-batch";

const browser = new Window({ url: "http://localhost/projects/project-a" });
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
type Call = { projectId: string; input: DramaStudioBatchRequest; pending: Deferred<DramaStudioBatchView> };
const checks: Call[] = [];
const executions: Call[] = [];
let refreshes = 0;
let refreshFailure = false;
mock.module("antd", () => ({ Button: ({ children, loading: _loading, type: _type, size: _size, ...props }: Record<string, unknown>) => createElement("button", props, children as ReactNode) }));
mock.module("@/components/ui/product/app-modal", () => ({
    AppModal: ({ open, title, children, footer }: { open: boolean; title: string; children?: ReactNode; footer?: ReactNode }) =>
        open ? (
            <section role="dialog" aria-label={title}>
                {children}
                {footer}
            </section>
        ) : null,
}));
mock.module("@/stores/use-user-store", () => ({ useUserStore: userStore }));
const userScope = await import("@/lib/user-scope");
mock.module("@/lib/user-scope", () => ({ ...userScope, getActiveUserScope: () => userStore.getState().user.id }));
const api = await import("@/services/api/drama");
mock.module("@/services/api/drama", () => ({
    ...api,
    preflightDramaStudioBatch: (projectId: string, input: DramaStudioBatchRequest) => {
        const pending = deferred<DramaStudioBatchView>();
        checks.push({ projectId, input: structuredClone(input), pending });
        return pending.promise;
    },
    executeDramaStudioBatch: (projectId: string, input: DramaStudioBatchRequest) => {
        const pending = deferred<DramaStudioBatchView>();
        executions.push({ projectId, input: structuredClone(input), pending });
        return pending.promise;
    },
}));
const { ApiError } = await import("@/services/api/request");
const { WorkflowBatch } = await import("@/pages/projects/workflow-batch");
function response(call: Call, statuses: DramaStudioBatchStatus[] = [], patch: Partial<DramaStudioBatchView> = {}): DramaStudioBatchView {
    const counts: DramaStudioBatchView["counts"] = { ready: 0, queued: 0, already_queued: 0, skipped_ready: 0, blocked: 0, conflict: 0, failed: 0 };
    const items = call.input.targetIds.map((targetId, index) => {
        const status = statuses[index] || "ready";
        counts[status]++;
        return { targetId, targetKind: "segment" as const, targetRevision: 1, segmentIndex: index, status, amountMicrocredits: 1_000_000, priced: true, reason: status === "blocked" ? "缺少角色参考图" : "" };
    });
    return {
        action: call.input.action,
        targetIds: call.input.targetIds,
        baseRevision: call.input.baseRevision || 1,
        confirmationToken: "confirmed-token",
        ready: counts.ready > 0,
        amountMicrocredits: (counts.ready + counts.queued) * 1_000_000,
        priced: true,
        counts,
        items,
        ...patch,
    };
}
const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function mount(overrides: Partial<WorkflowBatchProps> = {}) {
    checks.length = 0;
    executions.length = 0;
    refreshes = 0;
    refreshFailure = false;
    userStore.setState({ user: { id: "user-a" } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let props: WorkflowBatchProps = {
        projectId: "project-a",
        revision: 1,
        targetIds: ["segment-b", "segment-a"],
        actions: ["segment_video"],
        onChanged: async () => {
            refreshes++;
            if (refreshFailure) throw new Error("队列暂时不可用");
        },
        ...overrides,
    };
    await act(async () => {
        root.render(<WorkflowBatch {...props} />);
        await settle();
    });
    const waitQuotes = () =>
        act(async () => {
            await settle(210);
        });
    return {
        host,
        waitQuotes,
        rerender: async (patch: Partial<WorkflowBatchProps>) => {
            props = { ...props, ...patch };
            await act(async () => {
                root.render(<WorkflowBatch {...props} />);
                await settle();
            });
        },
        close: async () => {
            await act(async () => root.unmount());
            host.remove();
        },
    };
}
function button(host: HTMLElement, text: string) {
    const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === text);
    if (!found) throw new Error(`没有按钮 ${text}；${host.textContent}`);
    return found;
}
async function click(element: HTMLElement) {
    await act(async () => {
        element.click();
        await settle();
    });
}
async function quote(view: Awaited<ReturnType<typeof mount>>, patch: Partial<DramaStudioBatchView> = {}, statuses: DramaStudioBatchStatus[] = []) {
    await view.waitQuotes();
    const call = checks.at(-1)!;
    await act(async () => {
        call.pending.resolve(response(call, statuses, patch));
        await settle();
    });
    return call;
}
afterAll(() => browser.happyDOM.abort());

test("自动报价只读，展示积分后一次点击提交真实范围，无确认窗口", async () => {
    const v = await mount();
    try {
        const call = await quote(v);
        expect(call.input).toEqual({ action: "segment_video", targetIds: ["segment-a", "segment-b"], baseRevision: 1 });
        expect(executions).toHaveLength(0);
        expect(v.host.querySelector('[role="dialog"]')).toBeNull();
        await click(button(v.host, "批量生成视频 - 2积分"));
        expect(executions).toHaveLength(1);
        expect(executions[0].input).toEqual({ ...call.input, confirmationToken: "confirmed-token" });
        await act(async () => {
            executions[0].pending.resolve(response(executions[0], ["queued", "queued"]));
            await settle();
        });
        expect(v.host.textContent).toContain("已加入队列 2 项");
        expect(refreshes).toBe(1);
    } finally {
        await v.close();
    }
});
test("同帧重复点击只提交一个批次", async () => {
    const v = await mount();
    try {
        await quote(v);
        const b = button(v.host, "批量生成视频 - 2积分");
        await act(async () => {
            b.click();
            b.click();
            await settle();
        });
        expect(executions).toHaveLength(1);
    } finally {
        await v.close();
    }
});
test("部分可执行明确显示实际生成范围和对应积分，仍单请求提交", async () => {
    const v = await mount();
    try {
        await quote(v, {}, ["ready", "blocked"]);
        await click(button(v.host, "批量生成视频（1/2段） - 1积分"));
        expect(executions).toHaveLength(1);
        expect(executions[0].input.targetIds).toEqual(["segment-a", "segment-b"]);
    } finally {
        await v.close();
    }
});
test("增减所选段后重新读取合计费用，不沿用单段价格或按数量倍乘", async () => {
    const v = await mount({ targetIds: ["segment-a"] });
    try {
        await quote(v, { amountMicrocredits: 100_000_000 });
        expect(button(v.host, "批量生成视频 - 100积分").disabled).toBe(false);
        await v.rerender({ targetIds: ["segment-d", "segment-b", "segment-a", "segment-c", "segment-a"] });
        expect(button(v.host, "批量生成视频 - 计价中").disabled).toBe(true);
        const all = await quote(v, { amountMicrocredits: 575_000_000 });
        expect(all.input.targetIds).toEqual(["segment-a", "segment-b", "segment-c", "segment-d"]);
        expect(button(v.host, "批量生成视频 - 575积分").disabled).toBe(false);
        await v.rerender({ targetIds: ["segment-d", "segment-b", "segment-c"] });
        expect(button(v.host, "批量生成视频 - 计价中").disabled).toBe(true);
        const remaining = await quote(v, { amountMicrocredits: 475_000_000 });
        await click(button(v.host, "批量生成视频 - 475积分"));
        expect(executions).toHaveLength(1);
        expect(executions[0].input).toEqual({ ...remaining.input, confirmationToken: "confirmed-token" });
    } finally {
        await v.close();
    }
});
test("切换选择范围隔离迟到旧报价", async () => {
    const v = await mount();
    try {
        await v.waitQuotes();
        const old = checks[0];
        await v.rerender({ targetIds: ["segment-c"] });
        await act(async () => {
            old.pending.resolve(response(old));
            await settle();
        });
        expect(button(v.host, "批量生成视频 - 计价中").disabled).toBe(true);
        const fresh = await quote(v);
        expect(fresh.input.targetIds).toEqual(["segment-c"]);
        await click(button(v.host, "批量生成视频 - 1积分"));
        expect(executions[0].input.targetIds).toEqual(["segment-c"]);
    } finally {
        await v.close();
    }
});
test("revision变化先禁用旧价，新报价才可执行", async () => {
    const v = await mount();
    try {
        await quote(v);
        await v.rerender({ revision: 2 });
        expect(button(v.host, "批量生成视频 - 计价中").disabled).toBe(true);
        await quote(v, { baseRevision: 2, amountMicrocredits: 3_000_000 });
        await click(button(v.host, "批量生成视频 - 3积分"));
        expect(executions[0].input.baseRevision).toBe(2);
    } finally {
        await v.close();
    }
});
test("服务端变价冲突不自动提交新价，仅提供重新计价", async () => {
    const v = await mount();
    try {
        await quote(v);
        await click(button(v.host, "批量生成视频 - 2积分"));
        await act(async () => {
            executions[0].pending.reject(new ApiError("内容或报价已改变", { status: 409, details: { batch: response(executions[0], ["conflict", "blocked"]) } }));
            await settle();
        });
        expect(v.host.textContent).toContain("内容或报价已改变");
        expect(v.host.textContent).not.toContain("确认提交本批次");
        await click(button(v.host, "重新计价"));
        await quote(v, { amountMicrocredits: 4_000_000 });
        expect(button(v.host, "批量生成视频 - 4积分").disabled).toBe(false);
        expect(executions).toHaveLength(1);
    } finally {
        await v.close();
    }
});
test("未知回执关闭或切换选择后仍锁定，核对到任务后才解除", async () => {
    const v = await mount();
    try {
        await quote(v);
        await click(button(v.host, "批量生成视频 - 2积分"));
        await act(async () => {
            executions[0].pending.reject(new Error("断网"));
            await settle();
        });
        expect(v.host.textContent).toContain("提交结果尚未确认");
        await click(button(v.host, "取消"));
        await v.rerender({ targetIds: ["segment-c"] });
        await quote(v);
        expect(button(v.host, "批量生成视频 - 1积分").disabled).toBe(true);
        await click(button(v.host, "查看待核对批次"));
        await click(button(v.host, "核对最新状态"));
        const call = checks.at(-1)!;
        expect(call.input.targetIds).toEqual(["segment-a", "segment-b"]);
        await act(async () => {
            call.pending.resolve(response(call, ["already_queued", "skipped_ready"]));
            await settle();
        });
        expect(v.host.textContent).toContain("已核对到任务或生成结果");
        expect(executions).toHaveLength(1);
    } finally {
        await v.close();
    }
});
test("刷新失败保留成功回执且不重复生成", async () => {
    const v = await mount();
    try {
        refreshFailure = true;
        await quote(v);
        await click(button(v.host, "批量生成视频 - 2积分"));
        await act(async () => {
            executions[0].pending.resolve(response(executions[0], ["queued", "queued"], { dispatchPending: true }));
            await settle();
        });
        expect(v.host.textContent).toContain("已加入队列 2 项");
        expect(executions).toHaveLength(1);
    } finally {
        await v.close();
    }
});
test("依赖阻塞与无法报价均禁用，不自动补图", async () => {
    const v = await mount();
    try {
        await quote(v, { ready: false, reason: "缺少参考图" }, ["blocked", "blocked"]);
        expect(button(v.host, "批量生成视频 - 0积分").disabled).toBe(true);
        expect(v.host.textContent).toContain("缺少参考图");
        await v.rerender({ revision: 2 });
        await quote(v, { priced: false });
        expect(button(v.host, "批量生成视频 - 暂无报价").disabled).toBe(true);
        expect(executions).toHaveLength(0);
    } finally {
        await v.close();
    }
});
test("账号切换隔离旧执行回执", async () => {
    const v = await mount();
    try {
        await quote(v);
        await click(button(v.host, "批量生成视频 - 2积分"));
        await act(async () => {
            userStore.setState({ user: { id: "user-b" } });
            await settle();
            executions[0].pending.resolve(response(executions[0], ["queued", "queued"]));
            await settle();
        });
        expect(refreshes).toBe(0);
        expect(v.host.querySelector('[role="dialog"]')).toBeNull();
    } finally {
        await v.close();
    }
});
test("切换项目或动作不会复用旧报价", async () => {
    const v = await mount({ actions: ["cast_image"] });
    try {
        await v.waitQuotes();
        const old = checks[0];
        await v.rerender({ projectId: "project-b", actions: ["segment_video"] });
        await act(async () => {
            old.pending.resolve(response(old));
            await settle();
        });
        const fresh = await quote(v);
        expect(fresh.projectId).toBe("project-b");
        expect(fresh.input.action).toBe("segment_video");
        expect(executions).toHaveLength(0);
    } finally {
        await v.close();
    }
});
test("参考图报价执行保留分集、重做与影响范围", async () => {
    const v = await mount({ actions: ["cast_image"], targetIds: ["cast-a"], episodeId: "episode-a", regenerate: true, restyleSegments: true });
    try {
        const call = await quote(v);
        expect(call.input).toMatchObject({ episodeId: "episode-a", regenerate: true, restyleSegments: true });
        await click(button(v.host, "批量生成图片 - 1积分"));
        expect(executions[0].input).toMatchObject({ episodeId: "episode-a", regenerate: true, restyleSegments: true });
    } finally {
        await v.close();
    }
});
test("重做图片提交超时后，旧图不能解锁，新版本可核对完成", async () => {
    const v = await mount({ actions: ["cast_image"], targetIds: ["cast-a"], regenerate: true });
    try {
        await v.waitQuotes();
        const first = checks.at(-1)!;
        const baseline = response(first);
        await act(async () => {
            first.pending.resolve({ ...baseline, items: baseline.items.map((item) => ({ ...item, resultVersion: 2, resultResourceId: "old-image" })) });
            await settle();
        });
        await click(button(v.host, "批量生成图片 - 1积分"));
        await act(async () => {
            executions[0].pending.reject(new Error("断网"));
            await settle();
        });
        await click(button(v.host, "核对最新状态"));
        const old = checks.at(-1)!;
        await act(async () => {
            const view = response(old);
            old.pending.resolve({ ...view, items: view.items.map((item) => ({ ...item, resultVersion: 2, resultResourceId: "old-image" })) });
            await settle();
        });
        expect(v.host.textContent).toContain("尚未核对到全部任务");
        await click(button(v.host, "核对最新状态"));
        const done = checks.at(-1)!;
        await act(async () => {
            const view = response(done);
            done.pending.resolve({ ...view, items: view.items.map((item) => ({ ...item, resultVersion: 3, resultResourceId: "new-image" })) });
            await settle();
        });
        expect(v.host.textContent).toContain("已核对到任务或生成结果");
        expect(executions).toHaveLength(1);
    } finally {
        await v.close();
    }
});
test("临时视频模型同时进入报价与提交", async () => {
    const model = { modelId: "model-a", provider: "test", label: "视频" };
    const v = await mount({ videoModel: model });
    try {
        const call = await quote(v);
        expect(call.input.videoModel).toEqual(model);
        await click(button(v.host, "批量生成视频 - 2积分"));
        expect(executions[0].input.videoModel).toEqual(model);
    } finally {
        await v.close();
    }
});
test("无选择不报价，文字批量仍保留原确认交互", async () => {
    const v = await mount({ targetIds: [], actions: ["segment_video", "segment_prompt"] });
    try {
        await v.waitQuotes();
        expect(checks).toHaveLength(0);
        await v.rerender({ targetIds: ["segment-a"], actions: ["segment_prompt"] });
        await click(button(v.host, "批量撰写提示词"));
        const call = checks.at(-1)!;
        await act(async () => {
            call.pending.resolve(response(call));
            await settle();
        });
        expect(button(v.host, "确认提交本批次").disabled).toBe(false);
        expect(executions).toHaveLength(0);
    } finally {
        await v.close();
    }
});
