import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("短剧媒体建议按确认范围执行，引用与切换不提交任务", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-media-agent.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 25_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("12 pass");
    expect(output).toContain("0 fail");
}, 30_000);
