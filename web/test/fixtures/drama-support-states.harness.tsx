import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { DramaJob, DramaJobDetail, DramaSummary, DramaTake } from "../../src/services/api/drama";

const dom = new Window({ url: "http://localhost/projects/drama", settings: { disableJavaScriptEvaluation: true, disableCSSFileLoading: true } });
const globals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    Element: dom.Element,
    Node: dom.Node,
    Event: dom.Event,
    MouseEvent: dom.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
mock.module("antd", () => ({
    App: { useApp: () => ({ message: {} }) },
    Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => <button onClick={onClick}>{children}</button>,
    InputNumber: () => null,
}));
mock.module("@/components/ui/base/tooltip/ant-tooltip", () => ({
    AntTooltip: ({ children }: { children: React.ReactNode }) => children,
}));
mock.module("@/components/ui/product/app-modal", () => ({
    AppModal: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div role="dialog">{children}</div> : null),
}));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider, focusManager } = await import("@tanstack/react-query");
const { dramaKeys } = await import("../../src/lib/drama/drama-query-keys");
const api = await import("../../src/services/api/drama");
const { QueueBar } = await import("../../src/pages/projects/studio/queue-bar");
const { DramaTakeList } = await import("../../src/pages/projects/studio/take-list");
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
const summary = { inbox: [], jobCounts: {}, production: { budgetMicrocredits: 0, heldMicrocredits: 0, spentMicrocredits: 0 } } as unknown as DramaSummary;

beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } } });
    focusManager.setFocused(true);
});
afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    mock.restore();
});
afterAll(async () => {
    focusManager.setFocused(undefined);
    await dom.happyDOM.abort();
    for (const [key, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});
async function render(children: React.ReactNode) {
    await act(async () => root.render(<QueryClientProvider client={client}>{children}</QueryClientProvider>));
}
async function flush() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}
async function openQueue() {
    await act(async () => {
        host.querySelector<HTMLButtonElement>(".drama-queue-toggle")!.click();
    });
    await flush();
}
const text = () => host.textContent || "";

test("队列首次读取失败不误报无任务，也不新增重读按钮", async () => {
    spyOn(api, "listDramaJobs").mockRejectedValue(new Error("offline"));
    await render(<QueueBar projectId="project" summary={summary} onJump={() => {}} />);
    await openQueue();
    expect(text()).toContain("队列暂时读取失败，将自动更新");
    expect(text()).not.toContain("还没有调度记录");
    expect([...host.querySelectorAll("button")].some((button) => /重读|重新读取/.test(button.textContent || ""))).toBe(false);
});

test("队列后台读取失败保留旧记录，现有自动更新可恢复", async () => {
    const job = { id: "job", kind: "cast_image", status: "succeeded", label: "已有任务", createdAt: "2026-11-15T00:00:00Z" } as DramaJob;
    let failed = false;
    const request = spyOn(api, "listDramaJobs").mockImplementation(async () => {
        if (failed) throw new Error("offline");
        return { jobs: [job] };
    });
    await render(<QueueBar projectId="project" summary={summary} onJump={() => {}} />);
    await openQueue();
    expect(text()).toContain("已有任务");
    failed = true;
    await act(async () => {
        await client.refetchQueries({ queryKey: dramaKeys.jobs("project") });
    });
    await flush();
    expect(text()).toContain("已有任务");
    expect(text()).toContain("可能不是最新状态");
    failed = false;
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 3100));
    });
    expect(request.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(text()).toContain("已有任务");
    expect(text()).not.toContain("暂时读取失败");
}, 10000);

test("队列按状态请求独立结果，切换筛选不会复用其他记录", async () => {
    const job = (status: DramaJob["status"], label: string) => ({ id: status, kind: "cast_image", status, label, createdAt: "2026-11-15T00:00:00Z" }) as DramaJob;
    const request = spyOn(api, "listDramaJobs").mockImplementation(async (_projectId, _limit, _signal, filter) => ({
        jobs: [filter?.status === "active" ? job("running", "较早的进行中任务") : filter?.status === "failed" ? job("failed", "单独读取的失败任务") : job("succeeded", "最近完成的任务")],
    }));
    await render(<QueueBar projectId="project" summary={summary} onJump={() => {}} />);
    await openQueue();
    expect(text()).toContain("最近完成的任务");
    const select = async (label: string) => {
        await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === label)?.click());
        await flush();
    };
    await select("进行中");
    expect(request.mock.calls.at(-1)?.[3]).toEqual({ status: "active" });
    expect(text()).toContain("较早的进行中任务");
    expect(text()).not.toContain("最近完成的任务");
    await select("失败");
    expect(request.mock.calls.at(-1)?.[3]).toEqual({ status: "failed" });
    expect(text()).toContain("单独读取的失败任务");
    expect(text()).not.toContain("较早的进行中任务");
    await select("全部");
    expect(text()).toContain("最近完成的任务");
});

test("故事板图片显示在制作队列且可查看生成失败原因", async () => {
    const job: DramaJob = {
        id: "shot-media:task",
        taskId: "task",
        kind: "storyboard_image",
        status: "failed",
        label: "第 1 集 · 2×2",
        error: "图片生成超时",
        episodeId: "episode",
        attempt: 0,
        costMicrocredits: 0,
        createdAt: "2026-11-15T00:00:00Z",
        updatedAt: "2026-11-15T00:00:01Z",
    };
    const detail: DramaJobDetail = { job, target: job.label, attempts: [{ taskId: job.taskId, status: job.status, error: job.error, costMicrocredits: 0, at: job.createdAt }] };
    spyOn(api, "listDramaJobs").mockResolvedValue({ jobs: [job] });
    const request = spyOn(api, "getDramaJob").mockResolvedValue(detail);
    await render(<QueueBar projectId="project" summary={summary} onJump={() => {}} />);
    await openQueue();
    const row = host.querySelector<HTMLButtonElement>('[role="listitem"]')!;
    expect(row.textContent).toContain("故事板图片");
    expect(row.textContent).toContain(job.error!);
    await act(async () => row.click());
    await flush();
    expect(request.mock.calls[0]?.slice(0, 2)).toEqual(["project", job.id]);
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(job.error!);
    expect(dialog.textContent).not.toContain("定位到镜头");
});

test("版本区加载与成功空记录分别显示，外层有标题时不重复", async () => {
    let resolve!: (value: { takes: DramaTake[] }) => void;
    spyOn(api, "listDramaTakes").mockImplementation(
        () =>
            new Promise((accept) => {
                resolve = accept;
            }),
    );
    await render(
        <section>
            <h3>版本记录</h3>
            <DramaTakeList projectId="project" ownerId="cast" kind="cast" showHeading={false} />
        </section>,
    );
    expect(text()).toContain("正在读取版本…");
    await act(async () => resolve({ takes: [] }));
    await flush();
    expect(text()).toContain("暂无版本记录");
    expect(text()).not.toContain("正在读取版本");
    expect((text().match(/版本记录/g) || []).length).toBe(2);
    expect(host.querySelectorAll(".drama-takes-head").length).toBe(0);
});

test("版本区失败保持错误含义，切换对象后读取当前对象", async () => {
    const request = spyOn(api, "listDramaTakes").mockRejectedValue(new Error("offline"));
    await render(<DramaTakeList projectId="project" ownerId="first" kind="video" />);
    await flush();
    expect(text()).toContain("版本记录读取失败");
    expect(text()).not.toContain("暂无版本记录");
    request.mockResolvedValue({ takes: [{ id: "take", ownerId: "second", kind: "video", version: 2, resourceId: "resource", prompt: "", source: "pipeline", current: true, createdAt: "2026-11-15T00:00:00Z" }] });
    await render(<DramaTakeList projectId="project" ownerId="second" kind="video" />);
    await flush();
    expect(request.mock.calls.at(-1)?.[1]).toBe("second");
    expect(text()).toContain("V2");
    expect(text()).toContain("当前");
    expect(text()).not.toContain("版本记录读取失败");
});
