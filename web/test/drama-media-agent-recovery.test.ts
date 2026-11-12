import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("媒体失败恢复通过真实会话选择范围验证，不恢复旧执行确认", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-media-agent-recovery.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 25_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("7 pass");
    expect(output).toContain("0 fail");
}, 30_000);
