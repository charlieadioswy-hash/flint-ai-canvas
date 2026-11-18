import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("无 Agent 分镜逐集安全启动，视频预览保留失败恢复和真实生成回调", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-workflow-production.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toMatch(/\b31 pass\b/);
    expect(output).toContain("0 fail");
}, 25_000);
