import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("短剧聊天选项进入消息且操作挂载点随上下文清理", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/agent-drama-actions-host.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("5 pass");
    expect(output).toContain("0 fail");
}, 25_000);
