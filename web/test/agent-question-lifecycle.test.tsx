import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("Agent 提问生命周期及自定义输入交互", () => {
    // React DOM 的输入事件检测必须在本夹具的 DOM 建立后初始化，避免其他测试文件的浏览器全局状态干扰。
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/agent-question-lifecycle.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("10 pass");
    expect(output).toContain("0 fail");
}, 25_000);

test("Agent 选择题的最后一项可滚动到达，默认操作固定在滚动区外", () => {
    const script = `
        import assert from "node:assert/strict";
        import { Window } from "happy-dom";
        const dom = new Window({ url: "http://localhost/" });
        for (const key of ["document", "navigator", "HTMLElement", "Element", "Node", "SVGElement"]) {
            Object.defineProperty(globalThis, key, { configurable: true, value: dom[key] });
        }
        globalThis.window = dom;
        globalThis.getComputedStyle = dom.getComputedStyle.bind(dom);
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        const { act, createElement } = await import("react");
        const { createRoot } = await import("react-dom/client");
        const { AgentQuestionBar } = await import("./src/components/canvas/canvas-cloud-agent-chat-ui");
        const { canvasThemes } = await import("./src/lib/canvas-theme");
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        const answers = [];
        try {
            const options = Array.from({ length: 6 }, (_, index) => ({ label: "方向 " + (index + 1) }));
            await act(async () => root.render(createElement(AgentQuestionBar, {
                question: { kind: "choice", question: "选择方向", options },
                theme: canvasThemes.dark,
                onAnswer: (answer) => answers.push(answer),
            })));
            const scroll = host.querySelector('[role="region"][aria-label="确认选项"]');
            const footer = host.querySelector(".agent-question-default");
            assert.ok(scroll && footer && !scroll.contains(footer));
            Object.defineProperties(scroll, { clientHeight: { value: 90 }, scrollHeight: { value: 340 } });
            await act(async () => scroll.dispatchEvent(new dom.Event("scroll")));
            assert.equal(host.querySelector('[aria-label="向下查看更多选项"]')?.disabled, false);
            await act(async () => scroll.querySelectorAll(".agent-reply-option")[5].click());
            assert.deepEqual(answers, ["方向 6"]);
        } finally {
            await act(async () => root.unmount());
            dom.happyDOM.abort();
        }
    `;
    const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: resolve(import.meta.dir, ".."), timeout: 5000 });
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
});
