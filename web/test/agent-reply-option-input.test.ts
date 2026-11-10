import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("Agent 输入型回复选项与 ask_user 原位填写交互", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/agent-reply-option-input.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("8 pass");
    expect(output).toContain("0 fail");
}, 25000);
