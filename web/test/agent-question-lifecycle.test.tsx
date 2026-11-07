import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("Agent 提问生命周期及短剧自定义输入交互", () => {
    // React DOM 的输入事件检测必须在本夹具的 DOM 建立后初始化，避免其他测试文件的浏览器全局状态干扰。
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/agent-question-lifecycle.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("0 fail");
}, 25_000);
