import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("风格 AI 填写处理成功、重试和取消竞争，隔离模型与账号状态", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/style-profile-draft-modal.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("6 pass");
    expect(output).toContain("0 fail");
}, 25_000);
