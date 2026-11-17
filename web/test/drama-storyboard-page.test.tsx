import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("按段组织镜头、参考生视频设置和真实任务入口", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-storyboard-page.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("19 pass");
    expect(output).toContain("0 fail");
}, 25_000);
