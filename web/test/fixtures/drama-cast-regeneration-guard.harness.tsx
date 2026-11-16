import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, type ReactNode } from "react";
import { create } from "zustand";
import type { DramaWorkflowAffectedSegment, DramaWorkflowImpact } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/projects/project-a" });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const userStore = create(() => ({ user: { id: "user-a" } }));
type ConfirmOptions = { title: ReactNode; content: ReactNode; onOk: () => unknown; onCancel: () => unknown };
type Confirmation = { options: ConfirmOptions; markup: string; destroyed: number };
type ReadCall = { projectId: string; castId: string; userId: string };
const confirmations: Confirmation[] = [];
const errors: string[] = [];
const reads: ReadCall[] = [];
let readImpact: (projectId: string, castId: string) => Promise<DramaWorkflowImpact> = async (_projectId, castId) => impact({ castId });
const services = {
    message: {
        error: (error: unknown) => errors.push(String(error)),
        info: () => undefined,
        warning: () => undefined,
        success: () => undefined,
    },
    modal: {
        confirm: (options: ConfirmOptions) => {
            const confirmation = {
                options,
                markup: renderToStaticMarkup(
                    <>
                        {options.title}
                        {options.content}
                    </>,
                ),
                destroyed: 0,
            };
            confirmations.push(confirmation);
            return { destroy: () => confirmation.destroyed++ };
        },
    },
};
mock.module("@/stores/use-user-store", () => ({ useUserStore: userStore }));
mock.module("antd", () => ({
    App: { useApp: () => services },
    Button: ({ children, type: _type, size: _size, ...props }: Record<string, unknown>) => createElement("button", props, children as ReactNode),
}));
mock.module("@/services/api/drama", () => ({
    getDramaCastImpact: (projectId: string, castId: string) => {
        reads.push({ projectId, castId, userId: userStore.getState().user.id });
        return readImpact(projectId, castId);
    },
    getDramaSettingsImpact: async () => {
        throw new Error("重生成资产不得读取风格影响");
    },
}));
const { useCastRegenerationGuard } = await import("@/pages/projects/studio/use-cast-regeneration-guard");
type Guard = ReturnType<typeof useCastRegenerationGuard>;
type Request = Parameters<Guard["request"]>[0];
type Execute = Request["execute"];

afterAll(async () => {
    await browser.happyDOM.abort();
    for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((accept, fail) => {
        resolve = accept;
        reject = fail;
    });
    return { promise, resolve, reject };
}
function segment(overrides: Partial<DramaWorkflowAffectedSegment> = {}): DramaWorkflowAffectedSegment {
    return { id: "segment-2", episodeId: "episode-2", episodeNumber: 2, episodeTitle: "相遇", segmentIndex: 1, revision: 3, videoStatus: "ready", hasVideo: true, ...overrides };
}
function impact(overrides: Partial<DramaWorkflowImpact> = {}): DramaWorkflowImpact {
    return { kind: "cast", castId: "cast-1", revision: 4, segments: 0, episodes: 0, affectedSegments: 0, assetIds: ["cast-1"], directSegments: [], continuitySegments: [], message: "按已保存引用统计影响。", ...overrides };
}
function reset() {
    reads.length = confirmations.length = errors.length = 0;
    browser.localStorage.setItem("yingce:active-user-scope", "user-a");
    userStore.setState({ user: { id: "user-a" } });
    readImpact = async (_projectId, castId) => impact({ castId });
}
async function settle() {
    await Promise.resolve();
    await Bun.sleep(1);
}
async function flush(operation: () => unknown = () => undefined) {
    await act(async () => {
        operation();
        await settle();
    });
}
function confirmText(index = confirmations.length - 1) {
    const host = browser.document.createElement("div");
    host.innerHTML = confirmations[index].markup;
    return host.textContent || "";
}
async function mount(execute: Execute = async () => undefined) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let guard!: Guard;
    let projectId = "project-a";
    let closed = false;
    let executions = 0;
    const tickets: Array<() => boolean> = [];
    function Probe({ id }: { id: string }) {
        guard = useCastRegenerationGuard(id);
        return (
            <button aria-busy={guard.busy} disabled={guard.busy} onClick={() => void request()}>
                重新生成
            </button>
        );
    }
    function request(overrides: Partial<Request> = {}) {
        return guard.request({
            castId: "cast-1",
            name: "林夏",
            restyleSegments: false,
            execute: async (isCurrent) => {
                executions++;
                tickets.push(isCurrent);
                return execute(isCurrent);
            },
            ...overrides,
        });
    }
    async function render(id = projectId) {
        projectId = id;
        await act(async () => {
            root.render(<Probe id={projectId} />);
            await settle();
        });
    }
    await render();
    return {
        host,
        tickets,
        get busy() {
            return guard.busy;
        },
        get executions() {
            return executions;
        },
        get cancelBeforeExecution() {
            return guard.cancelBeforeExecution;
        },
        request,
        render,
        start: async (overrides: Partial<Request> = {}) =>
            flush(() => {
                void request(overrides);
            }),
        close: async () => {
            if (closed) return;
            closed = true;
            await flush(() => root.unmount());
            host.remove();
        },
    };
}
async function switchAccount() {
    await flush(() => {
        browser.localStorage.setItem("yingce:active-user-scope", "user-b");
        userStore.setState({ user: { id: "user-b" } });
    });
}
async function switchStorageScope(scope = "user-b") {
    await flush(() => {
        browser.localStorage.setItem("yingce:active-user-scope", scope);
        browser.dispatchEvent(new browser.StorageEvent("storage", { key: "yingce:active-user-scope", newValue: scope }));
    });
}

test("挂载不查询；点击时读取，零生成视频立即执行且无确认", async () => {
    reset();
    const view = await mount();
    try {
        expect(reads).toHaveLength(0);
        expect(view.busy).toBe(false);
        await flush(() => view.host.querySelector<HTMLButtonElement>("button")!.click());
        expect(reads).toEqual([{ projectId: "project-a", castId: "cast-1", userId: "user-a" }]);
        expect(confirmations).toHaveLength(0);
        expect(view.executions).toBe(1);
        expect(view.busy).toBe(false);
        expect(errors).toHaveLength(0);
    } finally {
        await view.close();
    }
});

test("queued和running空槽不属于已生成视频，不弹确认", async () => {
    reset();
    readImpact = async () => impact({ directSegments: [segment({ hasVideo: false, videoStatus: "queued" })], continuitySegments: [segment({ id: "running", hasVideo: false, videoStatus: "running" })] });
    const view = await mount();
    try {
        await view.start();
        expect(confirmations).toHaveLength(0);
        expect(view.executions).toBe(1);
        expect(view.busy).toBe(false);
    } finally {
        await view.close();
    }
});

test("直接引用视频列具体集段，确认后才执行且执行期间保持busy", async () => {
    reset();
    readImpact = async () => impact({ directSegments: [segment()] });
    const pending = deferred<unknown>();
    const view = await mount(() => pending.promise);
    try {
        await view.start({ restyleSegments: true });
        expect(confirmations).toHaveLength(1);
        expect(confirmText()).toContain("第 2 集 · 第 2 段 · 相遇");
        expect(confirmText()).toContain("直接引用");
        expect(view.executions).toBe(0);
        expect(view.busy).toBe(true);
        await flush(() => confirmations[0].options.onOk());
        expect(view.executions).toBe(1);
        expect(view.tickets[0]()).toBe(true);
        expect(view.busy).toBe(true);
        await flush(() => pending.resolve(undefined));
        expect(view.busy).toBe(false);
    } finally {
        pending.resolve(undefined);
        await view.close();
    }
});

test("仅尾帧续接已有视频也确认，取消不执行任何写入", async () => {
    reset();
    readImpact = async () => impact({ continuitySegments: [segment({ episodeNumber: 3, segmentIndex: 4 })] });
    const view = await mount();
    try {
        await view.start();
        expect(confirmText()).toContain("第 3 集 · 第 5 段 · 相遇");
        expect(confirmText()).toContain("尾帧续接");
        await flush(() => confirmations[0].options.onCancel());
        expect(view.executions).toBe(0);
        expect(view.busy).toBe(false);
    } finally {
        await view.close();
    }
});

test("直接与续接按ID去重且过滤没有视频的项", async () => {
    reset();
    const direct = segment();
    readImpact = async () =>
        impact({
            directSegments: [direct, segment({ id: "queued", episodeNumber: 99, hasVideo: false, videoStatus: "queued" })],
            continuitySegments: [direct, segment({ id: "tail", segmentIndex: 2 }), segment({ id: "empty", episodeNumber: 98, hasVideo: false })],
        });
    const view = await mount();
    try {
        await view.start();
        const text = confirmText();
        expect(text).toContain("已有 2 段视频");
        expect(text.match(/第 2 集 · 第 2 段/g)).toHaveLength(1);
        expect(text.match(/第 2 集 · 第 3 段/g)).toHaveLength(1);
        expect(text).not.toContain("第 99 集");
        expect(text).not.toContain("第 98 集");
        await flush(() => confirmations[0].options.onCancel());
        expect(view.executions).toBe(0);
    } finally {
        await view.close();
    }
});

test("解锁自定义图即使零视频仍确认，取消不写、确认才执行", async () => {
    reset();
    const view = await mount();
    try {
        await view.start({ unlock: true });
        expect(confirmText()).toContain("解锁");
        expect(view.executions).toBe(0);
        await flush(() => confirmations[0].options.onCancel());
        expect(view.executions).toBe(0);
        expect(view.busy).toBe(false);
        await view.start({ unlock: true });
        await flush(() => confirmations[1].options.onOk());
        expect(reads).toHaveLength(2);
        expect(view.executions).toBe(1);
        expect(view.busy).toBe(false);
    } finally {
        await view.close();
    }
});

test("影响读取失败显示错误且允许重新点击重试", async () => {
    reset();
    readImpact = async () => {
        throw new Error("影响读取断开");
    };
    const view = await mount();
    try {
        await view.start();
        expect(errors).toEqual(["影响读取断开"]);
        expect(view.executions).toBe(0);
        expect(confirmations).toHaveLength(0);
        expect(view.busy).toBe(false);
        readImpact = async () => impact();
        await view.start();
        expect(reads).toHaveLength(2);
        expect(view.executions).toBe(1);
        expect(view.busy).toBe(false);
    } finally {
        await view.close();
    }
});

test("kind、castId或影响数组不匹配时拒绝继续并释放锁", async () => {
    reset();
    const malformed = [impact({ kind: "style" }), impact({ castId: "other-cast" }), { ...impact(), directSegments: undefined }, { ...impact(), continuitySegments: {} }, null];
    const view = await mount();
    try {
        for (const value of malformed) {
            readImpact = async () => value as DramaWorkflowImpact;
            await view.start();
            expect(view.executions).toBe(0);
            expect(confirmations).toHaveLength(0);
            expect(view.busy).toBe(false);
        }
        expect(errors).toHaveLength(malformed.length);
        readImpact = async () => impact();
        await view.start();
        expect(view.executions).toBe(1);
    } finally {
        await view.close();
    }
});

test("账号变化后迟到影响不能确认或执行，新账号可以重新操作", async () => {
    reset();
    const pending = deferred<DramaWorkflowImpact>();
    readImpact = () => pending.promise;
    const view = await mount();
    try {
        await view.start();
        expect(view.busy).toBe(true);
        await switchAccount();
        expect(view.busy).toBe(false);
        await flush(() => pending.resolve(impact({ directSegments: [segment()] })));
        expect(confirmations).toHaveLength(0);
        expect(view.executions).toBe(0);
        expect(errors).toHaveLength(0);
        readImpact = async () => impact();
        await view.start();
        expect(reads[1].userId).toBe("user-b");
        expect(view.executions).toBe(1);
    } finally {
        pending.resolve(impact());
        await view.close();
    }
});

test("仅storage作用域切换释放旧读取，迟到读取不释放新操作的锁", async () => {
    reset();
    const oldRead = deferred<DramaWorkflowImpact>();
    const newRead = deferred<DramaWorkflowImpact>();
    readImpact = () => oldRead.promise;
    const view = await mount();
    try {
        await view.start();
        expect(view.busy).toBe(true);
        await switchStorageScope();
        expect(userStore.getState().user.id).toBe("user-a");
        expect(view.busy).toBe(false);
        readImpact = () => newRead.promise;
        await view.start();
        expect(view.busy).toBe(true);
        await flush(() => oldRead.resolve(impact({ directSegments: [segment()] })));
        expect(view.busy).toBe(true);
        expect(confirmations).toHaveLength(0);
        expect(view.executions).toBe(0);
        await flush(() => newRead.resolve(impact()));
        expect(view.executions).toBe(1);
        expect(view.busy).toBe(false);
        expect(errors).toHaveLength(0);
    } finally {
        oldRead.resolve(impact());
        newRead.resolve(impact());
        await view.close();
    }
});

test("仅storage作用域切换销毁旧确认，无关storage事件不打断确认", async () => {
    reset();
    readImpact = async () => impact({ directSegments: [segment()] });
    const view = await mount();
    try {
        await view.start();
        const oldConfirm = confirmations[0];
        await flush(() => browser.dispatchEvent(new browser.StorageEvent("storage", { key: "other-key", newValue: "changed" })));
        expect(oldConfirm.destroyed).toBe(0);
        expect(view.busy).toBe(true);
        await switchStorageScope();
        expect(oldConfirm.destroyed).toBe(1);
        expect(view.busy).toBe(false);
        await view.start();
        const newConfirm = confirmations[1];
        await flush(() => oldConfirm.options.onOk());
        expect(view.executions).toBe(0);
        expect(view.busy).toBe(true);
        expect(newConfirm.destroyed).toBe(0);
        await flush(() => newConfirm.options.onOk());
        expect(view.executions).toBe(1);
        expect(view.busy).toBe(false);
    } finally {
        await view.close();
    }
});

test("空闲时仅storage作用域切换后，下次请求采用新票据", async () => {
    reset();
    const pendingExecute = deferred<unknown>();
    const view = await mount(() => pendingExecute.promise);
    try {
        await switchStorageScope();
        expect(view.busy).toBe(false);
        await view.start();
        expect(view.executions).toBe(1);
        expect(view.tickets[0]()).toBe(true);
        expect(view.busy).toBe(true);
        await flush(() => pendingExecute.resolve(undefined));
        expect(view.busy).toBe(false);
        expect(errors).toHaveLength(0);
    } finally {
        pendingExecute.resolve(undefined);
        await view.close();
    }
});

test("切作品后旧读取不能释放新作品的锁或启动旧操作", async () => {
    reset();
    const oldRead = deferred<DramaWorkflowImpact>();
    const newRead = deferred<DramaWorkflowImpact>();
    readImpact = (projectId) => (projectId === "project-a" ? oldRead.promise : newRead.promise);
    const view = await mount();
    try {
        await view.start();
        await view.render("project-b");
        expect(view.busy).toBe(false);
        await view.start();
        expect(view.busy).toBe(true);
        await flush(() => oldRead.resolve(impact({ directSegments: [segment()] })));
        expect(view.busy).toBe(true);
        expect(confirmations).toHaveLength(0);
        expect(view.executions).toBe(0);
        await flush(() => newRead.resolve(impact()));
        expect(reads.map(({ projectId }) => projectId)).toEqual(["project-a", "project-b"]);
        expect(view.executions).toBe(1);
        expect(view.busy).toBe(false);
    } finally {
        oldRead.resolve(impact());
        newRead.resolve(impact());
        await view.close();
    }
});

test("账号或作品切换销毁旧确认，迟到onOk不能执行或影响新确认", async () => {
    for (const scope of ["account", "project"]) {
        reset();
        readImpact = async () => impact({ directSegments: [segment()] });
        const view = await mount();
        try {
            await view.start();
            const oldConfirm = confirmations[0];
            if (scope === "account") await switchAccount();
            else await view.render("project-b");
            expect(oldConfirm.destroyed).toBe(1);
            expect(view.busy).toBe(false);
            await view.start();
            const newConfirm = confirmations[1];
            await flush(() => oldConfirm.options.onOk());
            expect(view.executions).toBe(0);
            expect(view.busy).toBe(true);
            expect(newConfirm.destroyed).toBe(0);
            await flush(() => newConfirm.options.onOk());
            expect(view.executions).toBe(1);
            expect(view.busy).toBe(false);
        } finally {
            await view.close();
        }
    }
});

test("同帧双点及读取、确认、执行各阶段重复点击都只启动一次", async () => {
    reset();
    const pendingRead = deferred<DramaWorkflowImpact>();
    const pendingExecute = deferred<unknown>();
    readImpact = () => pendingRead.promise;
    const view = await mount(() => pendingExecute.promise);
    try {
        await flush(() => {
            void view.request();
            void view.request();
        });
        expect(reads).toHaveLength(1);
        expect(view.busy).toBe(true);
        await view.start();
        expect(reads).toHaveLength(1);
        await flush(() => pendingRead.resolve(impact({ directSegments: [segment()] })));
        await view.start();
        expect(confirmations).toHaveLength(1);
        expect(view.executions).toBe(0);
        expect(reads).toHaveLength(1);
        await flush(() => confirmations[0].options.onOk());
        await view.start();
        expect(view.executions).toBe(1);
        expect(view.busy).toBe(true);
        expect(reads).toHaveLength(1);
        await flush(() => pendingExecute.resolve(undefined));
        expect(view.busy).toBe(false);
        readImpact = async () => impact();
        await view.start();
        expect(reads).toHaveLength(2);
        expect(view.executions).toBe(2);
    } finally {
        pendingRead.resolve(impact());
        pendingExecute.resolve(undefined);
        await view.close();
    }
});

test("表单重挂取消未完成的影响读取，旧读取不能启动隐藏草稿的操作", async () => {
    reset();
    const pendingRead = deferred<DramaWorkflowImpact>();
    readImpact = () => pendingRead.promise;
    const view = await mount();
    try {
        await view.start();
        expect(view.busy).toBe(true);
        await flush(view.cancelBeforeExecution);
        expect(view.busy).toBe(false);
        await flush(() => pendingRead.resolve(impact({ directSegments: [segment()] })));
        expect(confirmations).toHaveLength(0);
        expect(view.executions).toBe(0);
        expect(errors).toHaveLength(0);
        readImpact = async () => impact();
        await view.start();
        expect(view.executions).toBe(1);
        expect(view.busy).toBe(false);
    } finally {
        pendingRead.resolve(impact());
        await view.close();
    }
});

test("表单重挂销毁执行前确认，取消回调稳定且旧确认不能影响新操作", async () => {
    reset();
    readImpact = async () => impact({ directSegments: [segment()] });
    const view = await mount();
    try {
        const cancelBeforeExecution = view.cancelBeforeExecution;
        await view.render();
        expect(view.cancelBeforeExecution).toBe(cancelBeforeExecution);
        await view.start();
        const oldConfirm = confirmations[0];
        await flush(cancelBeforeExecution);
        expect(oldConfirm.destroyed).toBe(1);
        expect(view.busy).toBe(false);
        await view.start();
        const newConfirm = confirmations[1];
        await flush(() => oldConfirm.options.onOk());
        expect(view.executions).toBe(0);
        expect(view.busy).toBe(true);
        expect(newConfirm.destroyed).toBe(0);
        await flush(() => newConfirm.options.onOk());
        expect(view.executions).toBe(1);
        expect(view.busy).toBe(false);
    } finally {
        await view.close();
    }
});

test("表单重挂不取消已进入执行阶段的保存与生成", async () => {
    reset();
    const pendingExecute = deferred<unknown>();
    const view = await mount(() => pendingExecute.promise);
    try {
        await view.start();
        expect(view.executions).toBe(1);
        expect(view.busy).toBe(true);
        expect(view.tickets[0]()).toBe(true);
        await flush(view.cancelBeforeExecution);
        expect(view.busy).toBe(true);
        expect(view.tickets[0]()).toBe(true);
        await view.start();
        expect(view.executions).toBe(1);
        expect(reads).toHaveLength(1);
        await flush(() => pendingExecute.resolve(undefined));
        expect(view.busy).toBe(false);
    } finally {
        pendingExecute.resolve(undefined);
        await view.close();
    }
});

test("卸载和切换会话使执行票据失效，旧回执不释放新操作的锁", async () => {
    for (const stage of ["read", "confirm", "execute"]) {
        reset();
        const pendingRead = deferred<DramaWorkflowImpact>();
        const pendingExecute = deferred<unknown>();
        if (stage === "read") readImpact = () => pendingRead.promise;
        else readImpact = async () => impact({ directSegments: stage === "confirm" ? [segment()] : [] });
        const view = await mount(() => pendingExecute.promise);
        try {
            await view.start();
            if (stage === "execute") {
                expect(view.executions).toBe(1);
                expect(view.tickets[0]()).toBe(true);
            }
            await view.close();
            if (stage === "read") {
                await flush(() => pendingRead.resolve(impact({ directSegments: [segment()] })));
                expect(confirmations).toHaveLength(0);
                expect(view.executions).toBe(0);
            } else if (stage === "confirm") {
                expect(confirmations[0].destroyed).toBe(1);
                await flush(() => confirmations[0].options.onOk());
                expect(view.executions).toBe(0);
            } else {
                expect(view.tickets[0]()).toBe(false);
                await flush(() => pendingExecute.resolve(undefined));
                expect(view.executions).toBe(1);
            }
            expect(errors).toHaveLength(0);
        } finally {
            pendingRead.resolve(impact());
            pendingExecute.resolve(undefined);
            await view.close();
        }
    }
    for (const scope of ["account", "project"]) {
        reset();
        const oldExecute = deferred<unknown>();
        const newExecute = deferred<unknown>();
        let execution = 0;
        const view = await mount(() => (execution++ === 0 ? oldExecute.promise : newExecute.promise));
        try {
            await view.start();
            expect(view.tickets[0]()).toBe(true);
            if (scope === "account") await switchAccount();
            else await view.render("project-b");
            expect(view.tickets[0]()).toBe(false);
            expect(view.busy).toBe(false);
            await view.start();
            expect(view.executions).toBe(2);
            expect(view.tickets[1]()).toBe(true);
            expect(view.busy).toBe(true);
            await flush(() => oldExecute.resolve(undefined));
            expect(view.busy).toBe(true);
            expect(view.tickets[1]()).toBe(true);
            await flush(() => newExecute.resolve(undefined));
            expect(view.busy).toBe(false);
            expect(errors).toHaveLength(0);
        } finally {
            oldExecute.resolve(undefined);
            newExecute.resolve(undefined);
            await view.close();
        }
    }
});
