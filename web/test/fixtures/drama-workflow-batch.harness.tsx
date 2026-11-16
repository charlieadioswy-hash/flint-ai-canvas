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
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
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
        targetLabels: { "segment-a": "第 1 集 · 第 2 段", "segment-b": "第 3 集 · 第 1 段" },
        actions: ["segment_prompt", "segment_assets", "segment_video"],
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
    return {
        host,
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
    if (!found) throw new Error(`没有按钮 ${text}`);
    return found;
}
async function click(element: HTMLElement) {
    await act(async () => {
        element.click();
        await settle();
    });
}
async function resolveCheck(index = checks.length - 1, patch: Partial<DramaStudioBatchView> = {}) {
    await act(async () => {
        checks[index].pending.resolve(response(checks[index], [], patch));
        await settle();
    });
}
afterAll(() => browser.happyDOM.abort());

test("只预检所选真实 ID，展示总价与逐项状态，明确确认才单次执行", async () => {
    const view = await mount();
    try {
        expect(checks).toHaveLength(0);
        await click(button(view.host, "批量生成视频"));
        expect(checks[0].input).toEqual({ action: "segment_video", targetIds: ["segment-a", "segment-b"], baseRevision: 1 });
        await resolveCheck();
        expect(view.host.textContent).toContain("预计合计 2 积分");
        expect(view.host.textContent).toContain("第 3 集 · 第 1 段");
        expect(executions).toHaveLength(0);
        await click(button(view.host, "确认提交本批次"));
        expect(executions).toHaveLength(1);
        expect(executions[0].input).toEqual({ action: "segment_video", targetIds: ["segment-a", "segment-b"], baseRevision: 1, confirmationToken: "confirmed-token" });
        await act(async () => {
            executions[0].pending.resolve(response(executions[0], ["queued", "queued"]));
            await settle();
        });
        expect(view.host.textContent).toContain("已加入队列 2 项");
        expect(refreshes).toBe(1);
    } finally {
        await view.close();
    }
});

test("同步重复点击只提交一个批次，执行中不能关闭弹窗", async () => {
    const view = await mount();
    try {
        await click(button(view.host, "批量撰写提示词"));
        await resolveCheck();
        const confirm = button(view.host, "确认提交本批次");
        await act(async () => {
            confirm.click();
            confirm.click();
            await settle();
        });
        expect(executions).toHaveLength(1);
        expect(button(view.host, "取消").disabled).toBe(true);
    } finally {
        await view.close();
    }
});

test("部分可提交时展示阻塞项与可执行部分总价，执行仍只提交一个完整批次", async () => {
    const view = await mount();
    try {
        await click(button(view.host, "批量生成视频"));
        await act(async () => {
            checks[0].pending.resolve(response(checks[0], ["ready", "blocked"]));
            await settle();
        });
        expect(view.host.textContent).toContain("预计合计 1 积分");
        expect(view.host.querySelectorAll('[data-status="blocked"]')).toHaveLength(1);
        await click(button(view.host, "确认提交本批次"));
        expect(executions).toHaveLength(1);
        expect(executions[0].input.targetIds).toEqual(["segment-a", "segment-b"]);
        await act(async () => {
            executions[0].pending.resolve(response(executions[0], ["queued", "blocked"]));
            await settle();
        });
        expect(view.host.textContent).toContain("已加入队列 1 项");
        expect(view.host.querySelectorAll('[data-status="blocked"]')).toHaveLength(1);
    } finally {
        await view.close();
    }
});

test("更换选择范围丢弃旧预检的迟到结果，新范围必须重新预检", async () => {
    const view = await mount();
    try {
        await click(button(view.host, "批量生成视频"));
        await view.rerender({ targetIds: ["segment-c"] });
        await resolveCheck(0);
        expect(view.host.querySelector('[role="dialog"]')).toBeNull();
        await click(button(view.host, "批量生成视频"));
        expect(checks[1].input.targetIds).toEqual(["segment-c"]);
        expect(executions).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("revision 改变保留旧预检并标记过期，重新预检才能提交", async () => {
    const view = await mount();
    try {
        await click(button(view.host, "批量生成视频"));
        await resolveCheck();
        await view.rerender({ revision: 2 });
        expect(view.host.textContent).toContain("预检已过期");
        expect(button(view.host, "确认提交本批次").disabled).toBe(true);
        await click(button(view.host, "重新预检"));
        expect(checks[1].input.baseRevision).toBe(2);
        await resolveCheck();
        expect(button(view.host, "确认提交本批次").disabled).toBe(false);
    } finally {
        await view.close();
    }
});

test("409 details.batch 展示逐项冲突，原确认不能再次执行", async () => {
    const view = await mount();
    try {
        await click(button(view.host, "批量生成视频"));
        await resolveCheck();
        await click(button(view.host, "确认提交本批次"));
        await act(async () => {
            executions[0].pending.reject(new ApiError("内容或报价已改变", { status: 409, reason: "conflict", details: { batch: response(executions[0], ["conflict", "blocked"]) } }));
            await settle();
        });
        expect(view.host.querySelectorAll('[data-status="conflict"]')).toHaveLength(1);
        expect(view.host.querySelectorAll('[data-status="blocked"]')).toHaveLength(1);
        expect(button(view.host, "确认提交本批次").disabled).toBe(true);
        expect(executions).toHaveLength(1);
    } finally {
        await view.close();
    }
});

test("模糊网络回执只能先核对状态，不能直接重复执行", async () => {
    const view = await mount();
    try {
        await click(button(view.host, "批量生成视频"));
        await resolveCheck();
        await click(button(view.host, "确认提交本批次"));
        await act(async () => {
            executions[0].pending.reject(new Error("网络断开"));
            await settle();
        });
        expect(view.host.textContent).toContain("提交结果尚未确认");
        expect([...view.host.querySelectorAll("button")].some((element) => element.textContent === "确认提交本批次")).toBe(false);
        await click(button(view.host, "核对最新状态"));
        expect(checks).toHaveLength(2);
        await act(async () => {
            checks[1].pending.resolve(response(checks[1], ["already_queued", "skipped_ready"]));
            await settle();
        });
        expect(button(view.host, "确认提交本批次").disabled).toBe(true);
        expect(executions).toHaveLength(1);
    } finally {
        await view.close();
    }
});

test("成功入队后刷新失败仍保留成功回执，无重复执行按钮", async () => {
    const view = await mount();
    try {
        refreshFailure = true;
        await click(button(view.host, "批量生成缺失资产"));
        await resolveCheck();
        await click(button(view.host, "确认提交本批次"));
        await act(async () => {
            executions[0].pending.resolve(response(executions[0], ["queued", "queued"], { dispatchPending: true }));
            await settle();
        });
        expect(view.host.textContent).toContain("已加入队列 2 项");
        expect(view.host.textContent).toContain("批次结果已保留，刷新队列失败");
        expect(view.host.textContent).toContain("无需重复提交");
        expect([...view.host.querySelectorAll("button")].some((element) => element.textContent === "确认提交本批次")).toBe(false);
        expect(executions).toHaveLength(1);
    } finally {
        await view.close();
    }
});

test("视频缺资产与未报价时不自动补图或付费", async () => {
    const view = await mount();
    try {
        await click(button(view.host, "批量生成视频"));
        await act(async () => {
            checks[0].pending.resolve(response(checks[0], ["blocked", "blocked"], { items: response(checks[0], ["blocked", "blocked"]).items.map((item) => ({ ...item, missingCasts: [{ id: "cast-a", name: "秦子文" }] })) }));
            await settle();
        });
        expect(view.host.textContent).toContain("缺少参考图：秦子文");
        expect(button(view.host, "确认提交本批次").disabled).toBe(true);
        expect(checks).toHaveLength(1);
        expect(executions).toHaveLength(0);
        await click(button(view.host, "重新预检"));
        await resolveCheck(1, { priced: false });
        expect(button(view.host, "确认提交本批次").disabled).toBe(true);
        expect(view.host.textContent).toContain("费用尚未确认");
    } finally {
        await view.close();
    }
});

test("账号切换后旧执行回执不刷新或污染新账号界面", async () => {
    const view = await mount();
    try {
        await click(button(view.host, "批量生成视频"));
        await resolveCheck();
        await click(button(view.host, "确认提交本批次"));
        await act(async () => {
            userStore.setState({ user: { id: "user-b" } });
            await settle();
        });
        await act(async () => {
            executions[0].pending.resolve(response(executions[0], ["queued", "queued"]));
            await settle();
        });
        expect(view.host.querySelector('[role="dialog"]')).toBeNull();
        expect(refreshes).toBe(0);
    } finally {
        await view.close();
    }
});

test("项目或动作范围变化隔离旧预检，不能把资产请求变成视频", async () => {
    const view = await mount({ actions: ["cast_image"] });
    try {
        await click(button(view.host, "批量生成参考图"));
        await view.rerender({ actions: ["segment_video"] });
        await resolveCheck();
        expect(view.host.querySelector('[role="dialog"]')).toBeNull();
        await view.rerender({ projectId: "project-b" });
        await click(button(view.host, "批量生成视频"));
        expect(checks[1]).toMatchObject({ projectId: "project-b", input: { action: "segment_video" } });
        expect(executions).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("本集批量参考图的预检与执行都保留所选集，不扩大为作品默认", async () => {
    const view = await mount({ actions: ["cast_image"], targetIds: ["shared-cast"], episodeId: "episode-a" });
    try {
        await click(button(view.host, "批量生成参考图"));
        expect(checks[0].input).toEqual({ action: "cast_image", targetIds: ["shared-cast"], episodeId: "episode-a", baseRevision: 1 });
        await resolveCheck();
        await click(button(view.host, "确认提交本批次"));
        expect(executions[0].input).toEqual({ action: "cast_image", targetIds: ["shared-cast"], episodeId: "episode-a", baseRevision: 1, confirmationToken: "confirmed-token" });
    } finally {
        await view.close();
    }
});

test("同主体批量切集丢弃旧集报价与迟到预检，重新确认只提交新集", async () => {
    const view = await mount({ actions: ["cast_image"], targetIds: ["shared-cast"], episodeId: "episode-a" });
    try {
        await click(button(view.host, "批量生成参考图"));
        await resolveCheck();
        await view.rerender({ episodeId: "episode-b" });
        expect(view.host.querySelector('[role="dialog"]')).toBeNull();
        expect(executions).toHaveLength(0);
        await click(button(view.host, "批量生成参考图"));
        expect(checks[1].input.episodeId).toBe("episode-b");
        await view.rerender({ episodeId: "episode-c" });
        await resolveCheck(1);
        expect(view.host.querySelector('[role="dialog"]')).toBeNull();
        await click(button(view.host, "批量生成参考图"));
        expect(checks[2].input.episodeId).toBe("episode-c");
        await resolveCheck(2);
        await click(button(view.host, "确认提交本批次"));
        expect(executions).toHaveLength(1);
        expect(executions[0].input.episodeId).toBe("episode-c");
        expect(executions[0].input.targetIds).toEqual(["shared-cast"]);
    } finally {
        await view.close();
    }
});

test("空范围、重复 ID 与超过 200 项均不产生扩大范围的请求", async () => {
    const view = await mount({ targetIds: [] });
    try {
        expect(button(view.host, "批量生成视频").disabled).toBe(true);
        await view.rerender({ targetIds: Array.from({ length: 201 }, (_, index) => `segment-${index}`) });
        expect(button(view.host, "批量生成视频").disabled).toBe(true);
        await view.rerender({ targetIds: ["segment-a", "segment-a"] });
        await click(button(view.host, "批量生成视频"));
        expect(checks[0].input.targetIds).toEqual(["segment-a"]);
        expect(executions).toHaveLength(0);
    } finally {
        await view.close();
    }
});
