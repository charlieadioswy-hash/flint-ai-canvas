import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("无 Agent 分集分镜和视频预览保留失败集、真实生成回调和未完成状态", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-workflow-production.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toMatch(/\b[1-9]\d* pass\b/);
    expect(output).toContain("0 fail");
}, 25_000);
